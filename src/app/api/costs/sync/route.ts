// src/app/api/costs/sync/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

interface EanItem {
  ean: string;
  codigo: string;
  nombre: string;
  costo: number;
  precio_lista: number;
}

export interface SyncResult extends EanItem {
  ml_id: string | null;
  titulo_ml: string | null;
  found: boolean;
}

interface MLAttribute {
  id: string;
  value_name?: string;
}

interface MLItemDetail {
  id: string;
  title: string;
  attributes: MLAttribute[];
}

const ML_BASE = "https://api.mercadolibre.com";
const ITEM_BATCH = 20;
const ID_PAGE = 100;

async function mlGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${ML_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ML ${res.status} – ${path}`);
  return res.json() as Promise<T>;
}

const STATUSES = ["active", "paused", "closed", "under_review"] as const;

// Fetches all IDs for one status (all pages)
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

// Fetches all vendor item IDs across all statuses, then builds { ean → { id, title } }
async function buildGtinMap(
  userId: number,
  accessToken: string
): Promise<Map<string, { id: string; title: string }>> {
  // Fetch all statuses in parallel, then deduplicate
  const idsByStatus = await Promise.all(
    STATUSES.map((s) => fetchAllIdsByStatus(userId, accessToken, s))
  );
  const allIds = Array.from(new Set(idsByStatus.flat()));

  const map = new Map<string, { id: string; title: string }>();

  // Fetch GTIN attributes in batches of 20
  for (let i = 0; i < allIds.length; i += ITEM_BATCH) {
    const chunk = allIds.slice(i, i + ITEM_BATCH);
    const details = await mlGet<{ code: number; body: MLItemDetail }[]>(
      `/items?ids=${chunk.join(",")}&attributes=id,title,attributes`,
      accessToken
    );
    for (const entry of details) {
      if (entry.code !== 200) continue;
      const item = entry.body;
      const gtin = item.attributes?.find((a) => a.id === "GTIN")?.value_name;
      if (gtin) {
        map.set(gtin.replace(/\D/g, ""), { id: item.id, title: item.title });
      }
    }
  }

  return map;
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
  try {
    gtinMap = await buildGtinMap(tokens.user_id, tokens.access_token);
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to fetch vendor items", detail: String(err) },
      { status: 502 }
    );
  }

  const results: SyncResult[] = [];
  let matched = 0;
  let notFound = 0;

  for (const item of items) {
    const ean = item.ean.replace(/\D/g, "");
    const mlItem = gtinMap.get(ean);
    if (mlItem) {
      matched++;
      results.push({ ...item, ml_id: mlItem.id, titulo_ml: mlItem.title, found: true });
    } else {
      notFound++;
      results.push({ ...item, ml_id: null, titulo_ml: null, found: false });
    }
  }

  return NextResponse.json({
    matched,
    notFound,
    results,
    vendor_items_indexed: gtinMap.size,
  });
}
