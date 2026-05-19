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

  // 1. Build seller_sku → { ml_id, title } from last 1000 orders (desc)
  const orderMap = new Map<string, { id: string; title: string }>();
  let offset = 0;
  let pages = 0;

  // Try with sort first; fall back to plain URL + date filter if 4xx
  const DATE_FROM = "2025-01-01T00:00:00.000-00:00";
  const buildUrl = (useSort: boolean) =>
    useSort
      ? `/orders/search?seller=${tokens.user_id}&limit=${ORDER_LIMIT}&offset=${offset}&sort=date_desc&order=date_created.desc`
      : `/orders/search?seller=${tokens.user_id}&limit=${ORDER_LIMIT}&offset=${offset}&order.date_created.from=${encodeURIComponent(DATE_FROM)}`;

  let useSort = true;

  while (pages < MAX_PAGES) {
    const url = buildUrl(useSort);
    console.log("[sync/orders] fetching:", url);
    let search: OrdersSearchResult;
    try {
      search = await mlGet<OrdersSearchResult>(url, tokens.access_token);
    } catch (err) {
      const errStr = String(err);
      // If sort params cause a 400, retry once without them
      if (useSort && errStr.includes("400")) {
        console.warn("[sync/orders] sort URL returned 400, retrying without sort");
        useSort = false;
        continue;
      }
      console.error("[sync/orders] fetch failed on page", pages, "url:", url, "error:", errStr);
      return NextResponse.json(
        { error: "Failed to fetch orders", detail: errStr, page: pages, url },
        { status: 502 }
      );
    }
    const orders = search.results ?? [];
    console.log("[sync/orders] page", pages, "orders fetched:", orders.length, "total:", search.paging?.total);
    if (orders.length > 0) {
      console.log("[sync/orders] sample order seller_sku:", orders[0]?.order_items?.[0]?.item?.seller_sku);
    }
    for (const order of orders) {
      for (const oi of order.order_items ?? []) {
        const { id, seller_sku, title } = oi.item;
        if (seller_sku) {
          orderMap.set(seller_sku.trim(), { id, title });
        }
      }
    }
    offset += orders.length;
    pages++;
    if (orders.length === 0 || offset >= (search.paging?.total ?? 0)) break;
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
