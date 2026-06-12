import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
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
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export async function POST(request: NextRequest) {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let activeTokens = tokens;
  if (isTokenExpired(tokens)) {
    try { activeTokens = await refreshAccessToken(tokens); }
    catch { return NextResponse.json({ error: "Token expired" }, { status: 401 }); }
  }

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("date_from") ?? "2026-04-01";
  const dateTo   = searchParams.get("date_to")   ?? "2026-04-30";

  // Get all orders with null logistic_type but with shipment_id
  const { data: nullOrders, error } = await supabaseAdmin
    .from("orders")
    .select("id, shipment_id")
    .gte("date_created", `${dateFrom}T00:00:00.000Z`)
    .lte("date_created", `${dateTo}T23:59:59.999Z`)
    .is("logistic_type", null)
    .not("shipment_id", "is", null);

  if (error || !nullOrders) {
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (nullOrders.length === 0) {
    return NextResponse.json({ enriched: 0, message: "No null orders found" });
  }

  console.log(`[enrich] Found ${nullOrders.length} orders with null logistic_type`);

  // Fetch shipments in batches of 20 with 200ms delay
  let enriched = 0;
  const BATCH = 20;

  for (let i = 0; i < nullOrders.length; i += BATCH) {
    const batch = nullOrders.slice(i, i + BATCH);

    const results = await Promise.all(
      batch.map(async (o) => {
        const ship = await mlGet<{ logistic_type?: string; mode?: string }>(
          `/shipments/${o.shipment_id}`,
          activeTokens.access_token
        );
        return {
          id: o.id,
          logistic_type: ship?.logistic_type ?? null,
          shipment_mode: ship?.mode ?? null,
        };
      })
    );

    // Update in Supabase
    for (const r of results) {
      // Only update if we got a real value AND only for orders that still have null
      if (!r.logistic_type || r.logistic_type.trim() === "") continue;
      const { error: updateError } = await supabaseAdmin
        .from("orders")
        .update({ logistic_type: r.logistic_type, shipment_mode: r.shipment_mode })
        .eq("id", r.id)
        .is("logistic_type", null);  // ← only update if still null, never overwrite existing
      if (!updateError) enriched++;
    }

    if (i + BATCH < nullOrders.length) {
      await new Promise(res => setTimeout(res, 200));
    }
  }

  console.log(`[enrich] Updated ${enriched} / ${nullOrders.length} orders`);
  return NextResponse.json({
    total_null: nullOrders.length,
    enriched,
    skipped: nullOrders.length - enriched,
  });
}

// Silence unused warning — function is exported for potential future use
export { isFlexLogistic };
