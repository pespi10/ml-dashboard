// src/app/api/sync/enrich/route.ts
//
// Enriches orders that have shipment_id but logistic_type IS NULL.
// Fetches /shipments/{id} from ML and updates ONLY orders that still have null.
// Never overwrites an existing logistic_type value.

import { NextRequest, NextResponse } from "next/server";
import { getSession, buildSessionCookieValue, SESSION_COOKIE_OPTIONS } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
import { supabaseAdmin } from "@/lib/supabase";

function isFlexLogistic(lt: string | null): boolean {
  return lt === "self_service" || lt === "xd_drop_off";
}

async function mlGet<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(`https://api.mercadolibre.com${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(`[enrich] mlGet ${path} → ${res.status}`);
      return null;
    }
    return res.json() as Promise<T>;
  } catch (e) {
    console.error(`[enrich] mlGet ${path} threw:`, e);
    return null;
  }
}

// ML shipment response shape (relevant fields only)
interface MLShipment {
  id?: number;
  logistic_type?: string | null;
  type?: string | null;              // sometimes used instead of logistic_type
  mode?: string | null;
  substatus?: string | null;
  // nested: shipping_option can also carry logistic info
  shipping_option?: {
    name?: string;
    speed?: { handling?: number; shipping?: number };
    estimated_delivery_time?: Record<string, unknown>;
  } | null;
}

export async function POST(request: NextRequest) {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let activeTokens = tokens;
  let refreshed = false;
  if (isTokenExpired(tokens)) {
    try { activeTokens = await refreshAccessToken(tokens); refreshed = true; }
    catch { return NextResponse.json({ error: "Token expired" }, { status: 401 }); }
  }

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("date_from") ?? "2026-04-01";
  const dateTo   = searchParams.get("date_to")   ?? "2026-04-30";

  // ── 1. Get all orders with null logistic_type ─────────────────────────
  const { data: nullOrders, error: fetchError } = await supabaseAdmin
    .from("orders")
    .select("id, shipment_id")
    .gte("date_created", `${dateFrom}T00:00:00.000Z`)
    .lte("date_created", `${dateTo}T23:59:59.999Z`)
    .is("logistic_type", null)
    .not("shipment_id", "is", null);

  if (fetchError) {
    console.error("[enrich] DB fetch error:", fetchError);
    return NextResponse.json({ error: "DB error", detail: fetchError.message }, { status: 500 });
  }

  if (!nullOrders || nullOrders.length === 0) {
    return NextResponse.json({ enriched: 0, skipped: 0, total_null: 0, message: "Nothing to enrich" });
  }

  console.log(`[enrich] ${nullOrders.length} orders with null logistic_type — fetching shipments`);

  // ── 2. Sample first shipment to log the actual ML response shape ──────
  const sampleShip = await mlGet<MLShipment>(
    `/shipments/${nullOrders[0].shipment_id}`,
    activeTokens.access_token
  );
  console.log("[enrich] SAMPLE shipment response:", JSON.stringify(sampleShip));

  // ── 3. Fetch shipments in batches of 20 ───────────────────────────────
  const BATCH = 20;
  let enriched = 0;
  let skipped  = 0;
  const logisticBreakdown: Record<string, number> = {};

  for (let i = 0; i < nullOrders.length; i += BATCH) {
    const batch = nullOrders.slice(i, i + BATCH);

    const results = await Promise.all(
      batch.map(async (o) => {
        const ship = await mlGet<MLShipment>(
          `/shipments/${o.shipment_id}`,
          activeTokens.access_token
        );

        if (!ship) return { id: o.id, logistic_type: null, shipment_mode: null };

        // ML sometimes returns logistic_type directly, sometimes as type
        const lt = ship.logistic_type ?? ship.type ?? null;
        const mode = ship.mode ?? null;

        return { id: o.id, logistic_type: lt, shipment_mode: mode };
      })
    );

    // Update ONLY rows where we got a real value AND logistic_type IS STILL NULL in DB
    for (const r of results) {
      if (!r.logistic_type || r.logistic_type.trim() === "") {
        skipped++;
        logisticBreakdown["null"] = (logisticBreakdown["null"] ?? 0) + 1;
        continue;
      }

      logisticBreakdown[r.logistic_type] = (logisticBreakdown[r.logistic_type] ?? 0) + 1;

      const { error: updateError, data: updated } = await supabaseAdmin
        .from("orders")
        .update({
          logistic_type: r.logistic_type,
          shipment_mode: r.shipment_mode,
        })
        .eq("id", r.id)
        .is("logistic_type", null)  // ← SAFETY: only update if still null
        .select("id");

      if (updateError) {
        console.error(`[enrich] update error for order ${r.id}:`, updateError);
        skipped++;
      } else if (!updated || updated.length === 0) {
        // Row was already enriched by another process — safe, just count as skipped
        skipped++;
      } else {
        enriched++;
      }
    }

    if (i + BATCH < nullOrders.length) {
      await new Promise(res => setTimeout(res, 200));
    }

    // Log progress every 100 orders
    if ((i + BATCH) % 100 === 0 || i + BATCH >= nullOrders.length) {
      console.log(`[enrich] progress: ${Math.min(i + BATCH, nullOrders.length)} / ${nullOrders.length} | enriched: ${enriched} | skipped: ${skipped}`);
    }
  }

  const flexCount    = (logisticBreakdown["self_service"] ?? 0) + (logisticBreakdown["xd_drop_off"] ?? 0);
  const colectaCount = (logisticBreakdown["cross_docking"] ?? 0) + (logisticBreakdown["fulfillment"] ?? 0) + (logisticBreakdown["drop_off"] ?? 0);

  console.log("[enrich] DONE. breakdown:", logisticBreakdown);
  console.log(`[enrich] flex enriched: ${flexCount} | colecta enriched: ${colectaCount}`);

  const response = NextResponse.json({
    total_null:  nullOrders.length,
    enriched,
    skipped,
    flex_enriched:    flexCount,
    colecta_enriched: colectaCount,
    breakdown:        logisticBreakdown,
    sample_shipment:  sampleShip, // ← incluido para debug — quitar después
  });

  if (refreshed) {
    response.cookies.set({
      ...SESSION_COOKIE_OPTIONS,
      value: buildSessionCookieValue(activeTokens),
    });
  }

  return response;
}

export { isFlexLogistic };
