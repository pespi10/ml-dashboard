// src/app/api/costs/sync/orders/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";
import { upsertProductCosts } from "@/lib/db";

const ML_BASE = "https://api.mercadolibre.com";
const ORDER_LIMIT = 50;
const MAX_PAGES = 20; // 50 × 20 = 1000 orders max

interface OrderItem {
  item: { id: string; title: string; seller_sku?: string | null };
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
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ML ${res.status} – ${path} – ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function POST() {
  const tokens = getSession();
  console.log("[sync/orders] tokens:", tokens ? `OK user=${tokens.user_id}` : "NULL");
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 1. Build ean/sku → ml_id map from last 1000 orders
  //    Uses the same URL format as getOrders in ml-api.ts (confirmed working)
  const eanToMlaMap: Record<string, string> = {};
  const from = new Date(Date.now() - 365 * 86400_000).toISOString();
  let offset = 0;
  let pages = 0;
  let ordersScanned = 0;

  while (pages < MAX_PAGES) {
    const url = `/orders/search?seller=${tokens.user_id}&order.date_created.from=${from}&limit=${ORDER_LIMIT}&offset=${offset}&sort=date_desc`;
    console.log("[sync/orders] fetching page", pages, "url:", ML_BASE + url);
    let search: OrdersSearchResult;
    try {
      search = await mlGet<OrdersSearchResult>(url, tokens.access_token);
    } catch (err) {
      console.error("[sync/orders] fetch failed:", String(err));
      return NextResponse.json(
        { error: "Failed to fetch orders", detail: String(err), page: pages },
        { status: 502 }
      );
    }

    const orders = search.results ?? [];
    console.log("[sync/orders] page", pages, "fetched:", orders.length, "paging.total:", search.paging?.total);
    if (pages === 0 && orders.length > 0) {
      console.log("[sync/orders] sample seller_sku:", orders[0]?.order_items?.[0]?.item?.seller_sku);
    }

    for (const order of orders) {
      for (const oi of order.order_items ?? []) {
        if (oi.item.seller_sku && oi.item.id) {
          eanToMlaMap[oi.item.seller_sku.trim()] = oi.item.id;
        }
      }
    }

    ordersScanned += orders.length;
    offset += orders.length;
    pages++;
    if (orders.length === 0 || offset >= (search.paging?.total ?? 0)) break;
  }

  const skusFound = Object.keys(eanToMlaMap).length;
  console.log("[sync/orders] orders scanned:", ordersScanned, "unique SKUs:", skusFound);
  if (skusFound > 0) {
    const sample = Object.entries(eanToMlaMap).slice(0, 3);
    console.log("[sync/orders] sample eanToMlaMap:", sample);
  }

  // 2. Read all costs from Supabase
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
    console.log("[sync/orders] sample cost — ean:", dbCosts[0]?.ean, "codigo:", dbCosts[0]?.codigo, "ml_id:", dbCosts[0]?.ml_id);
  }

  // 3. Cross-reference: for each cost, check if ean or codigo appears in eanToMlaMap
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
  let newMatches = 0;
  let alreadyMatched = 0;

  for (const cost of dbCosts) {
    const eanClean = cost.ean?.trim() ?? "";
    const codigoClean = cost.codigo?.trim() ?? "";

    // Look up ean first, then codigo as fallback
    const matchedMlaId = eanToMlaMap[eanClean] ?? eanToMlaMap[codigoClean] ?? null;
    if (!matchedMlaId) continue;

    if (matchedMlaId === cost.ml_id) {
      // Order history confirms the existing match
      alreadyMatched++;
    } else {
      // Order history gives a different ml_id — replace (delete old PK, insert new)
      toDelete.push(cost.ml_id);
      toUpsert.push({
        ml_id: matchedMlaId,
        ean: cost.ean ?? null,
        codigo: cost.codigo ?? null,
        nombre: cost.nombre ?? null,
        titulo_ml: null,
        costo: cost.costo,
        precio_lista: cost.precio_lista ?? null,
        match_method: "order_sku",
      });
      newMatches++;
    }
  }

  console.log("[sync/orders] alreadyMatched:", alreadyMatched, "newMatches:", newMatches, "toDelete:", toDelete.length);

  if (toDelete.length > 0) {
    const { error: delErr } = await supabaseAdmin
      .from("product_costs")
      .delete()
      .in("ml_id", toDelete);
    if (delErr) console.error("[sync/orders] delete error:", delErr);
  }
  if (toUpsert.length > 0) {
    try { await upsertProductCosts(toUpsert); } catch (e) { console.error("[sync/orders] upsert error:", e); }
  }

  return NextResponse.json({
    orders_scanned: ordersScanned,
    skus_found: skusFound,
    new_matches: newMatches,
    already_matched: alreadyMatched,
  });
}
