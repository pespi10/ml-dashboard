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
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // 1. Build seller_sku → { ml_id, title } from last 1000 orders (desc)
  const orderMap = new Map<string, { id: string; title: string }>();
  let offset = 0;
  let pages = 0;

  while (pages < MAX_PAGES) {
    let search: OrdersSearchResult;
    try {
      search = await mlGet<OrdersSearchResult>(
        `/orders/search?seller=${tokens.user_id}&limit=${ORDER_LIMIT}&offset=${offset}&sort=date_desc`,
        tokens.access_token
      );
    } catch {
      break;
    }
    const orders = search.results ?? [];
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

  // 2. Read existing costs from Supabase
  const { data: costs, error } = await supabaseAdmin
    .from("product_costs")
    .select("ml_id, ean, codigo, nombre, titulo_ml, costo, precio_lista");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
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

  for (const cost of costs ?? []) {
    const eanClean = cost.ean?.replace(/\D/g, "") ?? "";
    const match =
      (eanClean ? orderMap.get(eanClean) : null) ??
      (cost.codigo ? orderMap.get(cost.codigo.trim()) : null);

    if (!match) continue;

    if (match.id === cost.ml_id) {
      confirmed++;
      // Update titulo_ml if it changed
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
      // Order gives a different (more reliable) ml_id — replace
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
