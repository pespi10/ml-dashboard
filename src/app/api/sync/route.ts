// src/app/api/sync/route.ts
// Vercel extended timeout — sync can take several minutes for large periods
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
import { supabaseAdmin } from "@/lib/supabase";
import { isLogisticaPropia } from "@/lib/shipping-config";
import { buildSessionCookieValue, SESSION_COOKIE_OPTIONS } from "@/lib/session";

const ML_BASE = "https://api.mercadolibre.com";

async function mlGet<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(`${ML_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0],
    to: now.toISOString().split("T")[0],
  };
}

function prevMonthKey(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - 1, 1)
    .toISOString()
    .slice(0, 7) + "-01";
}

interface RawOrderItem {
  item: { id: string; title: string; category_id: string; seller_sku?: string | null };
  quantity: number;
  unit_price: number;
  sale_fee: number;
}

interface RawOrder {
  id: number;
  date_created: string;
  status: string;
  total_amount: number;
  pack_id?: number | null;
  order_items: RawOrderItem[];
  shipping?: { id?: number } | null;
}

interface MLPerception {
  description?: string;
  aliquot?: number;
  amount?: number;
  taxable_amount?: number;
  tax_type?: string;
  society?: string;
}

export async function POST(request: NextRequest) {
  const t0 = Date.now();
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let activeTokens = tokens;
  if (isTokenExpired(tokens)) {
    try {
      activeTokens = await refreshAccessToken(tokens);
    } catch {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
  }
  const accessToken = activeTokens.access_token;

  const body = await request.json().catch(() => ({})) as { date_from?: string; date_to?: string };
  const defaults = defaultRange();
  const dateFromStr = body.date_from ?? defaults.from;
  const dateToStr = body.date_to ?? defaults.to;
  const dateFrom = `${dateFromStr}T00:00:00.000Z`;
  const dateTo = `${dateToStr}T23:59:59.999Z`;

  // ── 1. Fetch all orders (paginated, deduplicated) ──────────────────────
  const allOrders: RawOrder[] = [];
  const seenIds = new Set<number>();
  let offset = 0;

  while (true) {
    const page = await mlGet<{ results: RawOrder[]; paging: { total: number } }>(
      `/orders/search?seller=${tokens.user_id}&order.date_created.from=${dateFrom}&order.date_created.to=${dateTo}&limit=50&offset=${offset}&sort=date_desc`,
      accessToken
    );
    if (!page || !page.results.length) break;

    for (const o of page.results) {
      if (!seenIds.has(o.id)) {
        seenIds.add(o.id);
        allOrders.push(o);
      }
    }

    offset += 50;
    if (offset >= page.paging.total || page.results.length < 50) break;
  }

  // ── 2. Upsert orders in batches of 100 ────────────────────────────────
  const orderRows = allOrders.map((o) => {
    const item0 = o.order_items?.[0];
    return {
      id: o.id,
      date_created: o.date_created,
      status: o.status,
      total_amount: o.total_amount ?? 0,
      sale_fee: item0?.sale_fee ?? 0,
      item_id: item0?.item?.id ?? null,
      item_title: item0?.item?.title ?? null,
      category_id: item0?.item?.category_id ?? null,
      seller_sku: item0?.item?.seller_sku ?? null,
      quantity: item0?.quantity ?? 1,
      unit_price: item0?.unit_price ?? 0,
      pack_id: o.pack_id ?? null,
      shipment_id: o.shipping?.id ?? null,
    };
  });

  let ordersUpsertError: string | null = null;
  for (let i = 0; i < orderRows.length; i += 100) {
    const { error } = await supabaseAdmin
      .from("orders")
      .upsert(orderRows.slice(i, i + 100), { onConflict: "id" });
    if (error) {
      console.error("[sync] orders upsert error:", error);
      ordersUpsertError = error.message;
    }
  }

  // ── 3. Fetch shipment costs in batches of 20 ──────────────────────────
  const shipmentMap = new Map<number, number>(); // shipId → orderId
  for (const o of orderRows) {
    if (o.shipment_id && o.shipment_id > 0 && !shipmentMap.has(o.shipment_id)) {
      shipmentMap.set(o.shipment_id, o.id);
    }
  }

  const shipIds = Array.from(shipmentMap.keys());
  const shipmentRows: { id: number; order_id: number; seller_cost: number; is_flex: boolean }[] = [];

  for (let i = 0; i < shipIds.length; i += 20) {
    const batch = shipIds.slice(i, i + 20);
    const results = await Promise.all(
      batch.map(async (shipId) => {
        const [shipment, costs] = await Promise.all([
          mlGet<{ id: number; receiver_address?: { zip_code?: string } }>(
            `/shipments/${shipId}`,
            accessToken
          ),
          mlGet<{ senders?: Array<{ cost?: number }> }>(
            `/shipments/${shipId}/costs`,
            accessToken
          ),
        ]);
        return {
          id: shipId,
          order_id: shipmentMap.get(shipId)!,
          seller_cost: costs?.senders?.[0]?.cost ?? 0,
          is_flex: isLogisticaPropia(shipment?.receiver_address?.zip_code ?? null),
        };
      })
    );
    shipmentRows.push(...results);
    if (i + 20 < shipIds.length) await sleep(200);
  }

  if (shipmentRows.length > 0) {
    const { error } = await supabaseAdmin
      .from("shipments")
      .upsert(shipmentRows, { onConflict: "id" });
    if (error) console.error("[sync] shipments upsert error:", error);
  }

  // ── 4. Fetch IIBB perceptions for previous month ──────────────────────
  const period = prevMonthKey();
  let perceptionsCount = 0;

  const percRaw = await mlGet<{
    summary?: MLPerception[];
    perceptions?: MLPerception[] | { summary?: MLPerception[] };
  }>(`/billing/integration/periods/key/${period}/perceptions/summary?group=ML`, accessToken);

  let perceptions: MLPerception[] = [];
  if (percRaw) {
    if (Array.isArray(percRaw.summary)) {
      perceptions = percRaw.summary;
    } else if (Array.isArray(percRaw.perceptions)) {
      perceptions = percRaw.perceptions as MLPerception[];
    } else if (percRaw.perceptions && typeof percRaw.perceptions === "object") {
      const nested = (percRaw.perceptions as { summary?: MLPerception[] }).summary;
      if (Array.isArray(nested)) perceptions = nested;
    }
  }

  if (perceptions.length > 0) {
    const percRows = perceptions.map((p) => ({
      period,
      society: p.society ?? "",
      tax_type: p.tax_type ?? "",
      amount: p.amount ?? 0,
      taxable_amount: p.taxable_amount ?? 0,
      aliquot: p.aliquot ?? 0,
      description: p.description ?? "",
    }));
    const { error } = await supabaseAdmin
      .from("billing_perceptions")
      .upsert(percRows, { onConflict: "period,society,tax_type" });
    if (!error) perceptionsCount = percRows.length;
    else console.error("[sync] perceptions upsert error:", error);
  }

  // ── 5. Write sync log ─────────────────────────────────────────────────
  const durationMs = Date.now() - t0;
  await supabaseAdmin.from("sync_log").insert({
    date_from: dateFromStr,
    date_to: dateToStr,
    orders_count: allOrders.length,
    shipments_count: shipmentRows.length,
    perceptions_count: perceptionsCount,
    duration_ms: durationMs,
    status: ordersUpsertError ? "partial" : "ok",
    error: ordersUpsertError,
  });

  const response = NextResponse.json({
    orders_synced: allOrders.length,
    shipments_synced: shipmentRows.length,
    perceptions_synced: perceptionsCount,
    duration_ms: durationMs,
  });

  if (activeTokens !== tokens) {
    response.cookies.set({
      ...SESSION_COOKIE_OPTIONS,
      value: buildSessionCookieValue(activeTokens),
    });
  }

  return response;
}
