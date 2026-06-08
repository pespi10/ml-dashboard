// src/app/api/shipping/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
import { LOGISTICA_PROPIA_COSTO_POR_PEDIDO } from "@/lib/shipping-config";
import { supabaseAdmin } from "@/lib/supabase";

const ML_BASE = "https://api.mercadolibre.com";

// self_service / xd_drop_off = logística propia (FLEX)
function isFlexLogistic(logisticType: string | null | undefined): boolean {
  return logisticType === "self_service" || logisticType === "xd_drop_off";
}

async function mlGet<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(`${ML_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch { return null; }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function buildShippingResponse(
  results: { senderCost: number; receiverCost: number; isFlex: boolean }[],
  orderRevenues: number[]
) {
  const flexCount = results.filter((r) => r.isFlex).length;
  const mlResults = results.filter((r) => !r.isFlex);
  const mlCount   = mlResults.length;
  const total     = results.length;

  const sellerPaidCount = mlResults.filter((r) => r.senderCost > 0).length;
  const buyerPaidCount  = mlResults.filter((r) => r.receiverCost > 0 && r.senderCost === 0).length;
  const sharedCount     = mlResults.filter((r) => r.senderCost > 0 && r.receiverCost > 0).length;

  const sellerCosts = mlResults.filter((r) => r.senderCost > 0).map((r) => r.senderCost);
  const avgSellerCost = sellerCosts.length > 0
    ? Math.round(sellerCosts.reduce((s, c) => s + c, 0) / sellerCosts.length) : 0;

  const avgOrderRevenue = orderRevenues.length > 0
    ? Math.round(orderRevenues.reduce((s, v) => s + v, 0) / orderRevenues.length) : 0;

  const mlShippingRate    = avgOrderRevenue > 0 ? Math.round((avgSellerCost / avgOrderRevenue) * 10000) / 100 : 0;
  const propiaShippingRate = avgOrderRevenue > 0 ? Math.round((LOGISTICA_PROPIA_COSTO_POR_PEDIDO / avgOrderRevenue) * 10000) / 100 : 0;

  const pct    = (n: number) => total   > 0 ? Math.round((n / total)   * 1000) / 10 : 0;
  const pctMl  = (n: number) => mlCount > 0 ? Math.round((n / mlCount) * 1000) / 10 : 0;

  return {
    totalOrders: total, analyzedShipments: total,
    avgMLShippingCost: avgSellerCost, avgSellerCost, avgOrderRevenue,
    mlShippingRate, propiaShippingRate,
    pctSellerPays: pctMl(sellerPaidCount),
    pctBuyerPays:  pctMl(buyerPaidCount),
    pctShared:     pctMl(sharedCount),
    totalAnalyzed: total,
    logisticaPropia: { count: flexCount, pct: pct(flexCount), avgCost: LOGISTICA_PROPIA_COSTO_POR_PEDIDO },
    mercadoEnvios:   { count: mlCount,   pct: pct(mlCount),   avgCost: avgSellerCost, sellerPaidCount, buyerPaidCount, sharedCount },
    splitRatio: { propia: pct(flexCount), ml: pct(mlCount) },
  };
}

export async function GET() {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let accessToken = tokens.access_token;
  if (isTokenExpired(tokens)) {
    try { const r = await refreshAccessToken(tokens); accessToken = r.access_token; }
    catch { return NextResponse.json({ error: "Token expired" }, { status: 401 }); }
  }

  // ── Try DB: use logistic_type from orders + seller_cost from shipments ─
  const { data: ordersWithLogistic, count } = await supabaseAdmin
    .from("orders")
    .select("id, logistic_type, total_amount", { count: "exact" })
    .not("shipment_id", "is", null);

  if (count && count > 0 && ordersWithLogistic) {
    const { data: shipCosts } = await supabaseAdmin
      .from("shipments")
      .select("order_id, seller_cost");

    // Log logistic_type breakdown from DB
    const ltBreakdown: Record<string, number> = {};
    for (const o of (ordersWithLogistic as { logistic_type: string | null }[])) {
      const lt = o.logistic_type ?? "null";
      ltBreakdown[lt] = (ltBreakdown[lt] ?? 0) + 1;
    }
    console.log('[shipping] DB logistic_type breakdown:', ltBreakdown);

    const costByOrderId = new Map<number, number>();
    for (const s of (shipCosts ?? [])) costByOrderId.set(s.order_id as number, s.seller_cost as number ?? 0);

    const results = (ordersWithLogistic as { id: number; logistic_type: string | null; total_amount: number }[])
      .map((o) => ({
        isFlex: isFlexLogistic(o.logistic_type),
        senderCost: costByOrderId.get(o.id) ?? 0,
        receiverCost: 0,
      }));

    const revenues = (ordersWithLogistic as { total_amount: number }[])
      .map((o) => o.total_amount ?? 0).filter((v) => v > 0);

    return NextResponse.json({ ...buildShippingResponse(results, revenues), source: "db" });
  }

  // ── Fall back to ML API (uses logistic_type from shipment, not zip_code) ─
  interface OrderWithShipping { id: number; total_amount?: number; shipping?: { id?: number } | null }
  const orders: OrderWithShipping[] = [];
  for (let offset = 0; offset < 200; offset += 50) {
    const page = await mlGet<{ results: OrderWithShipping[]; paging: { total: number } }>(
      `/orders/search?seller=${tokens.user_id}&limit=50&offset=${offset}&sort=date_desc`,
      accessToken
    );
    if (!page || !page.results.length) break;
    orders.push(...page.results);
    if (orders.length >= page.paging.total) break;
  }

  const uniqueIds = Array.from(new Set(
    orders.map((o) => o.shipping?.id).filter((id): id is number => typeof id === "number" && id > 0)
  ));

  const mlResults: { isFlex: boolean; senderCost: number; receiverCost: number }[] = [];
  for (let i = 0; i < uniqueIds.length; i += 20) {
    const batch = uniqueIds.slice(i, i + 20);
    const batchResults = await Promise.all(
      batch.map(async (shipId) => {
        const [shipment, costs] = await Promise.all([
          mlGet<{ id: number; logistic_type?: string | null }>(`/shipments/${shipId}`, accessToken),
          mlGet<{ senders?: Array<{ cost?: number }>; receiver?: { cost?: number } }>(`/shipments/${shipId}/costs`, accessToken),
        ]);
        return {
          isFlex: isFlexLogistic(shipment?.logistic_type),
          senderCost: costs?.senders?.[0]?.cost ?? 0,
          receiverCost: costs?.receiver?.cost ?? 0,
        };
      })
    );
    mlResults.push(...batchResults);
    if (i + 20 < uniqueIds.length) await sleep(200);
  }

  const revenues = orders.map((o) => o.total_amount ?? 0).filter((v) => v > 0);
  return NextResponse.json({ ...buildShippingResponse(mlResults, revenues), source: "ml" });
}
