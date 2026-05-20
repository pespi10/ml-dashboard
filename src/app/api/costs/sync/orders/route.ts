// src/app/api/costs/sync/orders/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { upsertProductCosts } from "@/lib/db";

const ML_BASE = "https://api.mercadolibre.com";
const ORDER_LIMIT = 100;
const MAX_PAGES = 10;

interface OrderItem {
  item: { id: string; seller_sku?: string | null; title: string };
}

interface OrdersSearchResult {
  results: Array<{ order_items: OrderItem[] }>;
  paging: { total: number };
}

async function mlGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${ML_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ML ${res.status} – ${path}`);
  return res.json() as Promise<T>;
}

export async function POST() {
  const tokens = getSession();
  console.log("[sync/orders] tokens:", tokens ? `OK user=${tokens.user_id}` : "NULL");
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 1. Diagnostic fetch — raw request with minimal params
  const diagUrl = `https://api.mercadolibre.com/orders/search?seller=${tokens.user_id}&limit=100&offset=0`;
  console.log("[sync/orders] URL:", diagUrl);
  const diagRes = await fetch(diagUrl, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    cache: "no-store",
  });
  const diagText = await diagRes.text();
  console.log("[sync/orders] status:", diagRes.status);
  console.log("[sync/orders] response:", diagText.slice(0, 500));

  if (!diagRes.ok) {
    return NextResponse.json(
      { error: `ML ${diagRes.status}`, detail: diagText.slice(0, 500), url: diagUrl },
      { status: 502 }
    );
  }

  // 2. Build seller_sku → { ml_id, title } from last 1000 orders
  const orderMap = new Map<string, { id: string; title: string }>();
  let offset = 0;
  let pages = 0;

  // Parse the first page we already fetched
  let firstPage: OrdersSearchResult;
  try {
    firstPage = JSON.parse(diagText) as OrdersSearchResult;
  } catch {
    return NextResponse.json({ error: "Failed to parse orders response", detail: diagText.slice(0, 200) }, { status: 502 });
  }

  const processPage = (search: OrdersSearchResult) => {
    for (const order of search.results ?? []) {
      for (const oi of order.order_items ?? []) {
        const { id, seller_sku, title } = oi.item;
        if (seller_sku) orderMap.set(seller_sku.trim(), { id, title });
      }
    }
  };

  processPage(firstPage);
  offset += firstPage.results?.length ?? 0;
  pages++;
  console.log("[sync/orders] page 0 orders fetched:", firstPage.results?.length ?? 0, "total:", firstPage.paging?.total);
  if ((firstPage.results?.length ?? 0) > 0) {
    console.log("[sync/orders] sample seller_sku:", firstPage.results[0]?.order_items?.[0]?.item?.seller_sku);
  }

  while (pages < MAX_PAGES && offset < (firstPage.paging?.total ?? 0)) {
    const url = `https://api.mercadolibre.com/orders/search?seller=${tokens.user_id}&limit=${ORDER_LIMIT}&offset=${offset}`;
    console.log("[sync/orders] fetching page", pages, "url:", url);
    let search: OrdersSearchResult;
    try {
      search = await mlGet<OrdersSearchResult>(
        `/orders/search?seller=${tokens.user_id}&limit=${ORDER_LIMIT}&offset=${offset}`,
        tokens.access_token
      );
    } catch (err) {
      console.error("[sync/orders] fetch failed page", pages, String(err));
      break;
    }
    processPage(search);
    const fetched = search.results?.length ?? 0;
    console.log("[sync/orders] page", pages, "orders fetched:", fetched);
    offset += fetched;
    pages++;
    if (fetched === 0) break;
  }

  console.log("[sync/orders] orderMap size:", orderMap.size, "orders scanned:", offset);
  if (orderMap.size > 0) {
    console.log("[sync/orders] sample orderMap entries:", Array.from(orderMap.entries()).slice(0, 3));
  }

  // 2. Read existing costs from Supabase
  const { data: costs, error } = await supabaseAdmin
    .from("product_costs")
    .select("ml_id, ean, codigo, nombre, titulo_ml, costo, precio_lista");

  if (error) {
    console.error("[sync/orders] Supabase error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const dbCosts = costs ?? [];
  console.log("[sync/orders] costs in DB:", dbCosts.length);
  if (dbCosts.length > 0) {
    console.log("[sync/orders] sample cost ean:", dbCosts[0]?.ean, "ml_id:", dbCosts[0]?.ml_id);
  }

  // 3. Cross-reference costs with order map
  type UpsertRow = {
    ml_id: string;
    ean: string | null;
    codigo: string | null;
    nombre: string | null;
    titulo_ml: string | null;
    costo: number;
    precio_lista: number | null;
    match_method: string;
  };

  const toUpsert: UpsertRow[] = [];
  const toDelete: string[] = [];
  let confirmed = 0;
  let newMatches = 0;

  for (const cost of dbCosts) {
    const eanClean = cost.ean?.replace(/\D/g, "") ?? "";
    const match =
      (eanClean ? orderMap.get(eanClean) : null) ??
      (cost.codigo ? orderMap.get(cost.codigo.trim()) : null);

    if (!match) continue;

    if (match.id === cost.ml_id) {
      confirmed++;
      if (match.title !== cost.titulo_ml) {
        toUpsert.push({
          ml_id: cost.ml_id,
          ean: cost.ean ?? null,
          codigo: cost.codigo ?? null,
          nombre: cost.nombre ?? null,
          titulo_ml: match.title,
          costo: cost.costo,
          precio_lista: cost.precio_lista ?? null,
          match_method: "order_sku",
        });
      }
    } else {
      toDelete.push(cost.ml_id);
      toUpsert.push({
        ml_id: match.id,
        ean: cost.ean ?? null,
        codigo: cost.codigo ?? null,
        nombre: cost.nombre ?? null,
        titulo_ml: match.title,
        costo: cost.costo,
        precio_lista: cost.precio_lista ?? null,
        match_method: "order_sku",
      });
      newMatches++;
    }
  }

  console.log("[sync/orders] confirmed:", confirmed, "newMatches:", newMatches, "toDelete:", toDelete.length);

  if (toDelete.length > 0) {
    await supabaseAdmin.from("product_costs").delete().in("ml_id", toDelete);
  }
  if (toUpsert.length > 0) {
    try { await upsertProductCosts(toUpsert); } catch { /* non-fatal */ }
  }

  return NextResponse.json({
    orders_scanned: offset,
    order_skus_found: orderMap.size,
    confirmed,
    newMatches,
  });
}
