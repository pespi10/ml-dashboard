// src/app/api/costs/sync/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { upsertProductCosts } from "@/lib/db";

interface EanItem {
  ean: string;
  codigo: string;
  nombre: string;
  costo: number;
  precio_lista: number;
}

export type MatchMethod = "gtin" | "sku" | "not_found";

export interface SyncResult extends EanItem {
  ml_id: string | null;
  titulo_ml: string | null;
  found: boolean;
  match_method: MatchMethod;
}

interface MLAttribute {
  id: string;
  value_name?: string;
}

interface MLItemDetail {
  id: string;
  title: string;
  attributes: MLAttribute[];
  seller_sku?: string;
}

interface ItemMaps {
  gtinMap: Map<string, { id: string; title: string }>;
  skuMap: Map<string, { id: string; title: string }>;
  sellerSkuMap: Map<string, { id: string; title: string }>;
}

const ML_BASE = "https://api.mercadolibre.com";
const ITEM_BATCH = 20;
const ID_PAGE = 100;

const STATUSES = ["active", "paused", "closed", "under_review"] as const;

async function mlGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${ML_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ML ${res.status} – ${path}`);
  return res.json() as Promise<T>;
}

async function fetchAllIdsByStatus(
  userId: number,
  accessToken: string,
  status: string
): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  while (true) {
    const search = await mlGet<{ results: string[]; paging: { total: number } }>(
      `/users/${userId}/items/search?status=${status}&limit=${ID_PAGE}&offset=${offset}`,
      accessToken
    );
    const page = search.results ?? [];
    ids.push(...page);
    offset += page.length;
    if (page.length === 0 || offset >= (search.paging?.total ?? 0)) break;
  }
  return ids;
}

// Builds gtinMap, skuMap, and sellerSkuMap in one pass
async function buildItemMaps(userId: number, accessToken: string): Promise<ItemMaps> {
  const idsByStatus = await Promise.all(
    STATUSES.map((s) => fetchAllIdsByStatus(userId, accessToken, s))
  );
  const allIds = Array.from(new Set(idsByStatus.flat()));

  const gtinMap = new Map<string, { id: string; title: string }>();
  const skuMap = new Map<string, { id: string; title: string }>();
  const sellerSkuMap = new Map<string, { id: string; title: string }>();

  const BARCODE_ATTRS = ["GTIN", "EAN", "UPC", "ISBN"];

  for (let i = 0; i < allIds.length; i += ITEM_BATCH) {
    const chunk = allIds.slice(i, i + ITEM_BATCH);
    const details = await mlGet<{ code: number; body: MLItemDetail }[]>(
      `/items?ids=${chunk.join(",")}&attributes=id,title,attributes,seller_sku`,
      accessToken
    );
    for (const entry of details) {
      if (entry.code !== 200) continue;
      const item = entry.body;
      const ref = { id: item.id, title: item.title };

      // All barcode-type attributes → gtinMap
      for (const attrId of BARCODE_ATTRS) {
        const val = item.attributes?.find((a) => a.id === attrId)?.value_name;
        if (val) gtinMap.set(val.replace(/\D/g, ""), ref);
      }

      // SELLER_SKU attribute → skuMap
      const skuAttr = item.attributes?.find((a) => a.id === "SELLER_SKU")?.value_name;
      if (skuAttr) skuMap.set(skuAttr.trim(), ref);

      // PART_NUMBER attribute → skuMap
      const partNum = item.attributes?.find((a) => a.id === "PART_NUMBER")?.value_name;
      if (partNum) skuMap.set(partNum.trim(), ref);

      // item.seller_sku (top-level field) → sellerSkuMap + skuMap
      if (item.seller_sku) {
        const s = item.seller_sku.trim();
        sellerSkuMap.set(s, ref);
        skuMap.set(s, ref);
      }
    }
  }

  console.log("[buildItemMaps] gtinMap size:", gtinMap.size);
  console.log("[buildItemMaps] skuMap size:", skuMap.size);
  console.log("[buildItemMaps] sellerSkuMap size:", sellerSkuMap.size);
  console.log("[buildItemMaps] sample seller_sku:", Array.from(sellerSkuMap.entries()).slice(0, 3));

  return { gtinMap, skuMap, sellerSkuMap };
}

export async function POST(request: NextRequest) {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { items?: EanItem[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const items = body.items ?? [];
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items array required" }, { status: 400 });
  }

  let gtinMap: Map<string, { id: string; title: string }>;
  let skuMap: Map<string, { id: string; title: string }>;
  let sellerSkuMap: Map<string, { id: string; title: string }>;
  try {
    ({ gtinMap, skuMap, sellerSkuMap } = await buildItemMaps(tokens.user_id, tokens.access_token));
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch vendor items", detail: String(err) },
      { status: 502 }
    );
  }

  const results: SyncResult[] = [];
  let matched_by_gtin = 0;
  let matched_by_sku = 0;
  let not_found = 0;

  for (const item of items) {
    const ean = item.ean.replace(/\D/g, "");
    const byGtin = gtinMap.get(ean);
    if (byGtin) {
      matched_by_gtin++;
      results.push({ ...item, ml_id: byGtin.id, titulo_ml: byGtin.title, found: true, match_method: "gtin" });
      continue;
    }

    const bySku = skuMap.get(item.codigo.trim());
    if (bySku) {
      matched_by_sku++;
      results.push({ ...item, ml_id: bySku.id, titulo_ml: bySku.title, found: true, match_method: "sku" });
      continue;
    }

    not_found++;
    results.push({ ...item, ml_id: null, titulo_ml: null, found: false, match_method: "not_found" });
  }

  // Persist matched results to Supabase (non-fatal if it fails)
  const toUpsert = results
    .filter((r) => r.found && r.ml_id)
    .map((r) => ({
      ml_id: r.ml_id!,
      ean: r.ean,
      codigo: r.codigo,
      nombre: r.nombre,
      titulo_ml: r.titulo_ml,
      costo: r.costo,
      precio_lista: r.precio_lista,
      match_method: r.match_method,
    }));
  if (toUpsert.length > 0) {
    try { await upsertProductCosts(toUpsert); } catch { /* non-fatal */ }
  }

  return NextResponse.json({
    matched_by_gtin,
    matched_by_sku,
    matched: matched_by_gtin + matched_by_sku,
    not_found,
    results,
    vendor_items_indexed: { gtin: gtinMap.size, sku: skuMap.size },
  });
}
