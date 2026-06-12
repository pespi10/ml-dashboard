// src/app/api/sync/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  getSession,
  buildSessionCookieValue,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
import { supabaseAdmin } from "@/lib/supabase";

// ── Types ─────────────────────────────────────────────────────────────

interface RawOrderItem {
  item?: { id?: string; title?: string; category_id?: string; seller_sku?: string };
  sale_fee?: number;
  quantity?: number;
  unit_price?: number;
}

interface RawOrder {
  id: number;
  date_created: string;
  status: string;
  total_amount?: number;
  marketplace_fee?: number | null;
  pack_id?: number | null;
  order_items?: RawOrderItem[];
  shipping?: {
    id?: number;
    logistic_type?: string | null;
    mode?: string | null;
  } | null;
}

interface MLPerception {
  society?: string;
  tax_type?: string;
  amount?: number;
  taxable_amount?: number;
  aliquot?: number;
  description?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

function isFlexLogistic(lt: string | null | undefined): boolean {
  return lt === "self_service" || lt === "xd_drop_off";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function prevMonthKey(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function mlGet<T>(path: string, token: string): Promise<T | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.mercadolibre.com${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 429) { await sleep(2000); continue; }
      if (!res.ok) return null;
      return res.json() as Promise<T>;
    } catch (e) {
      lastErr = e;
      await sleep(500);
    }
  }
  console.error("[sync] mlGet failed after 3 attempts:", lastErr);
  return null;
}

// ── Main handler ──────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const t0 = Date.now();
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let activeTokens = tokens;
  if (isTokenExpired(tokens)) {
    try { activeTokens = await refreshAccessToken(tokens); }
    catch { return NextResponse.json({ error: "Token expired" }, { status: 401 }); }
  }

  const accessToken = activeTokens.access_token;
  const sellerId    = activeTokens.user_id;

  // Date range
  let body: { date_from?: string; date_to?: string } = {};
  try { body = await request.json(); } catch { /* use defaults */ }

  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const dateFromStr = body.date_from ?? monday.toISOString().split("T")[0];
  const dateToStr   = body.date_to   ?? sunday.toISOString().split("T")[0];

  const dateFilter = `order.date_created.from=${dateFromStr}T00:00:00.000Z&order.date_created.to=${dateToStr}T23:59:59.999Z`;

  // ── 1. Fetch all orders from ML (paginated, 50 per page) ─────────────
  const allOrders: RawOrder[] = [];
  const seenIds = new Set<number>();
  let offset = 0;
  let mlTotal = 0;
  let rawCount = 0;
  let pageNum = 0;

  while (true) {
    pageNum++;
    const page = await mlGet<{ results: RawOrder[]; paging: { total: number } }>(
      `/orders/search?seller=${sellerId}&${dateFilter}&sort=date_asc&offset=${offset}&limit=50`,
      accessToken
    );

    if (!page?.results) {
      console.error("[sync] ML API returned null on page", pageNum);
      break;
    }

    if (pageNum === 1) mlTotal = page.paging.total;

    const pageOrders = page.results;
    rawCount += pageOrders.length;
    for (const o of pageOrders) {
      if (!seenIds.has(o.id)) { seenIds.add(o.id); allOrders.push(o); }
    }

    console.log(`[sync] page ${pageNum} offset ${offset} fetched: ${pageOrders.length} | total so far: ${allOrders.length} / ${mlTotal}`);

    if (pageOrders.length < 50) break;
    offset += 50;
    if (offset >= mlTotal) break;
    await sleep(100);
  }

  console.log('[sync] orders before dedup:', rawCount, 'after dedup:', allOrders.length, '| ML reported total:', mlTotal);

  // ── 2. Read logistic_type from order.shipping object ─────────────────
  // Note: some orders have null logistic_type here — they will be enriched
  // later via /api/sync/enrich without being overwritten by re-syncs.

  const breakdown: Record<string, number> = {
    self_service: 0, xd_drop_off: 0, cross_docking: 0,
    fulfillment: 0, drop_off: 0, other: 0, null: 0,
  };

  const orderRows = allOrders.map((o) => {
    const item0    = o.order_items?.[0];
    const lt       = o.shipping?.logistic_type ?? null;
    const ltKey    = lt === null ? "null" : (lt in breakdown ? lt : "other");
    breakdown[ltKey]++;

    return {
      id:            o.id,
      date_created:  o.date_created,
      status:        o.status,
      total_amount:  o.total_amount ?? 0,
      sale_fee:      o.marketplace_fee ?? item0?.sale_fee ?? 0,
      item_id:       item0?.item?.id ?? null,
      item_title:    item0?.item?.title ?? null,
      category_id:   item0?.item?.category_id ?? null,
      seller_sku:    item0?.item?.seller_sku ?? null,
      quantity:      item0?.quantity ?? 1,
      unit_price:    item0?.unit_price ?? 0,
      pack_id:       o.pack_id ?? null,
      shipment_id:   o.shipping?.id ?? null,
      // These two may be null — handled via COALESCE in upsert below
      logistic_type: lt,
      shipment_mode: o.shipping?.mode ?? null,
    };
  });

  const flexCount    = breakdown.self_service + breakdown.xd_drop_off;
  const colectaCount = breakdown.cross_docking + breakdown.fulfillment + breakdown.drop_off;
  const unknownCount = breakdown.null + breakdown.other;
  console.log('[sync] logistic_type from order objects:', { ...breakdown, flex_count: flexCount, colecta_count: colectaCount });

  // ── 3. Upsert orders — COALESCE preserves existing logistic_type ──────
  //
  // KEY FIX: We use raw SQL via rpc so that on conflict we can write:
  //   logistic_type = COALESCE(EXCLUDED.logistic_type, orders.logistic_type)
  //
  // This means: if the incoming value is null, keep whatever is already in the DB.
  // This prevents re-syncs from destroying logistic_type values set by /api/sync/enrich.

  let ordersUpsertError: string | null = null;
  let savedCount = 0;
  const BATCH = 100;

  for (let i = 0; i < orderRows.length; i += BATCH) {
    const batch = orderRows.slice(i, i + BATCH);

    // Build VALUES string for raw SQL
    const values = batch.map((r) => `(
      ${r.id},
      '${r.date_created.replace(/'/g, "''")}',
      '${(r.status ?? "").replace(/'/g, "''")}',
      ${r.total_amount},
      ${r.sale_fee},
      ${r.item_id    ? `'${r.item_id.replace(/'/g, "''")}'`    : "NULL"},
      ${r.item_title ? `'${r.item_title.replace(/'/g, "''")}'` : "NULL"},
      ${r.category_id ? `'${r.category_id.replace(/'/g, "''")}'` : "NULL"},
      ${r.seller_sku  ? `'${r.seller_sku.replace(/'/g, "''")}'`  : "NULL"},
      ${r.quantity},
      ${r.unit_price},
      ${r.pack_id    ?? "NULL"},
      ${r.shipment_id ?? "NULL"},
      ${r.logistic_type ? `'${r.logistic_type}'` : "NULL"},
      ${r.shipment_mode ? `'${r.shipment_mode}'` : "NULL"}
    )`).join(",\n");

    const sql = `
      INSERT INTO orders (
        id, date_created, status, total_amount, sale_fee,
        item_id, item_title, category_id, seller_sku,
        quantity, unit_price, pack_id, shipment_id,
        logistic_type, shipment_mode
      ) VALUES ${values}
      ON CONFLICT (id) DO UPDATE SET
        date_created  = EXCLUDED.date_created,
        status        = EXCLUDED.status,
        total_amount  = EXCLUDED.total_amount,
        sale_fee      = EXCLUDED.sale_fee,
        item_id       = EXCLUDED.item_id,
        item_title    = EXCLUDED.item_title,
        category_id   = EXCLUDED.category_id,
        seller_sku    = EXCLUDED.seller_sku,
        quantity      = EXCLUDED.quantity,
        unit_price    = EXCLUDED.unit_price,
        pack_id       = EXCLUDED.pack_id,
        shipment_id   = EXCLUDED.shipment_id,
        logistic_type = COALESCE(EXCLUDED.logistic_type, orders.logistic_type),
        shipment_mode = COALESCE(EXCLUDED.shipment_mode, orders.shipment_mode);
    `;

    const { error } = await supabaseAdmin.rpc("exec_sql", { sql_query: sql });

    if (error) {
      // exec_sql RPC may not exist — fallback to regular upsert for this batch
      // but split: rows WITH logistic_type use normal upsert, rows WITHOUT skip logistic_type update
      console.warn("[sync] exec_sql RPC not available, using split upsert fallback:", error.message);

      const withLT  = batch.filter(r => r.logistic_type !== null);
      const withoutLT = batch.filter(r => r.logistic_type === null);

      // Rows with logistic_type: full upsert
      if (withLT.length > 0) {
        const { error: e1 } = await supabaseAdmin
          .from("orders")
          .upsert(withLT, { onConflict: "id" });
        if (e1) { console.error("[sync] upsert error (with LT):", e1); ordersUpsertError = e1.message; }
      }

      // Rows without logistic_type: upsert only non-LT fields, then update LT only if still null
      if (withoutLT.length > 0) {
        const rowsNoLT = withoutLT.map(({ logistic_type, shipment_mode, ...rest }) => rest);
        const { error: e2 } = await supabaseAdmin
          .from("orders")
          .upsert(rowsNoLT, { onConflict: "id" });
        if (e2) { console.error("[sync] upsert error (without LT):", e2); ordersUpsertError = e2.message; }
      }
    }

    savedCount += batch.length;
  }

  console.log('[sync] FINAL total orders saved:', savedCount, '| expected from ML:', mlTotal);

  // ── 4. Upsert shipments table ─────────────────────────────────────────
  const shipmentRows = allOrders
    .filter(o => o.shipping?.id && o.shipping.id > 0)
    .map(o => ({
      id:          o.shipping!.id!,
      order_id:    o.id,
      seller_cost: 0,
      is_flex:     isFlexLogistic(o.shipping?.logistic_type),
    }));

  if (shipmentRows.length > 0) {
    const { error } = await supabaseAdmin
      .from("shipments")
      .upsert(shipmentRows, { onConflict: "id" });
    if (error) console.error("[sync] shipments upsert error:", error);
  }

  // ── 5. Fetch IIBB perceptions ─────────────────────────────────────────
  const period = prevMonthKey();
  let perceptionsCount = 0;

  const percRaw = await mlGet<{
    summary?: MLPerception[];
    perceptions?: MLPerception[] | { summary?: MLPerception[] };
  }>(`/billing/integration/periods/key/${period}/perceptions/summary?group=ML`, accessToken);

  let perceptions: MLPerception[] = [];
  if (percRaw) {
    if (Array.isArray(percRaw.summary)) perceptions = percRaw.summary;
    else if (Array.isArray(percRaw.perceptions)) perceptions = percRaw.perceptions as MLPerception[];
    else if (percRaw.perceptions && typeof percRaw.perceptions === "object") {
      const nested = (percRaw.perceptions as { summary?: MLPerception[] }).summary;
      if (Array.isArray(nested)) perceptions = nested;
    }
  }

  if (perceptions.length > 0) {
    const percRows = perceptions.map((p) => ({
      period,
      society:       p.society      ?? "",
      tax_type:      p.tax_type     ?? "",
      amount:        p.amount       ?? 0,
      taxable_amount: p.taxable_amount ?? 0,
      aliquot:       p.aliquot      ?? 0,
      description:   p.description  ?? "",
    }));
    const { error } = await supabaseAdmin
      .from("billing_perceptions")
      .upsert(percRows, { onConflict: "period,society,tax_type" });
    if (!error) perceptionsCount = percRows.length;
    else console.error("[sync] perceptions upsert error:", error);
  }

  // ── 6. Write sync log ─────────────────────────────────────────────────
  const durationMs = Date.now() - t0;
  await supabaseAdmin.from("sync_log").insert({
    date_from:         dateFromStr,
    date_to:           dateToStr,
    orders_count:      allOrders.length,
    shipments_count:   shipmentRows.length,
    perceptions_count: perceptionsCount,
    flex_count:        flexCount,
    colecta_count:     colectaCount,
    unknown_count:     unknownCount,
    duration_ms:       durationMs,
    status:            ordersUpsertError ? "partial" : "ok",
    error:             ordersUpsertError,
  });

  const response = NextResponse.json({
    orders_synced:      allOrders.length,
    shipments_synced:   shipmentRows.length,
    perceptions_synced: perceptionsCount,
    flex_count:         flexCount,
    colecta_count:      colectaCount,
    unknown_count:      unknownCount,
    duration_ms:        durationMs,
  });

  if (activeTokens !== tokens) {
    response.cookies.set({
      ...SESSION_COOKIE_OPTIONS,
      value: buildSessionCookieValue(activeTokens),
    });
  }
  return response;
}
