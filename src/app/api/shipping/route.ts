// src/app/api/shipping/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
import { isLogisticaPropia, LOGISTICA_PROPIA_COSTO_POR_PEDIDO } from "@/lib/shipping-config";
import { supabaseAdmin } from "@/lib/supabase";

const ML_BASE = "https://api.mercadolibre.com";

interface MLShipment {
  id: number;
  receiver_address?: { zip_code?: string };
}
interface MLShipmentCosts {
  senders?: Array<{ cost?: number }>;
  receiver?: { cost?: number };
  [key: string]: unknown;
}
interface OrderWithShipping {
  id: number;
  total_amount?: number;
  shipping?: { id?: number } | null;
}

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

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function buildShippingResponse(
  results: { senderCost: number; receiverCost: number; isFlex: boolean }[],
  orderRevenues: number[]
) {
  const flexCount = results.filter((r) => r.isFlex).length;
  const mlResults = results.filter((r) => !r.isFlex);
  const mlCount = mlResults.length;
  const total = results.length;

  const sellerPaidCount = mlResults.filter((r) => r.senderCost > 0).length;
  const buyerPaidCount = mlResults.filter((r) => r.receiverCost > 0 && r.senderCost === 0).length;
  const sharedCount = mlResults.filter((r) => r.senderCost > 0 && r.receiverCost > 0).length;

  const sellerCosts = mlResults.filter((r) => r.senderCost > 0).map((r) => r.senderCost);
  const avgSellerCost = sellerCosts.length > 0
    ? Math.round(sellerCosts.reduce((s, c) => s + c, 0) / sellerCosts.length) : 0;

  const avgOrderRevenue = orderRevenues.length > 0
    ? Math.round(orderRevenues.reduce((s, v) => s + v, 0) / orderRevenues.length) : 0;
  const mlShippingRate = avgOrderRevenue > 0
    ? Math.round((avgSellerCost / avgOrderRevenue) * 10000) / 100 : 0;
  const propiaShippingRate = avgOrderRevenue > 0
    ? Math.round((LOGISTICA_PROPIA_COSTO_POR_PEDIDO / avgOrderRevenue) * 10000) / 100 : 0;

  const pct = (n: number) => total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
  const pctOfMl = (n: number) => mlCount > 0 ? Math.round((n / mlCount) * 1000) / 10 : 0;

  return {
    totalOrders: total,
    analyzedShipments: total,
    avgMLShippingCost: avgSellerCost,
    avgSellerCost,
    avgOrderRevenue,
    mlShippingRate,
    propiaShippingRate,
    pctSellerPays: pctOfMl(sellerPaidCount),
    pctBuyerPays: pctOfMl(buyerPaidCount),
    pctShared: pctOfMl(sharedCount),
    totalAnalyzed: total,
    logisticaPropia: { count: flexCount, pct: pct(flexCount), avgCost: LOGISTICA_PROPIA_COSTO_POR_PEDIDO },
    mercadoEnvios: { count: mlCount, pct: pct(mlCount), avgCost: avgSellerCost, sellerPaidCount, buyerPaidCount, sharedCount },
    splitRatio: { propia: pct(flexCount), ml: pct(mlCount) },
  };
}

export async function GET() {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let accessToken = tokens.access_token;
  if (isTokenExpired(tokens)) {
    try {
      const refreshed = await refreshAccessToken(tokens);
      accessToken = refreshed.access_token;
    } catch {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
  }

  // ── Try DB first ───────────────────────────────────────────────────────
  const { data: dbShipments, count: shipCount } = await supabaseAdmin
    .from("shipments")
    .select("seller_cost, is_flex", { count: "exact" });

  const { data: dbOrders } = await supabaseAdmin
    .from("orders")
    .select("total_amount");

  if (shipCount && shipCount > 0 && dbShipments) {
    const results = (dbShipments as { seller_cost: number; is_flex: boolean }[]).map((s) => ({
      senderCost: s.seller_cost ?? 0,
      receiverCost: 0,
      isFlex: s.is_flex ?? false,
    }));
    const revenues = (dbOrders ?? []).map((o: { total_amount: number }) => o.total_amount ?? 0).filter((v) => v > 0);
    return NextResponse.json({ ...buildShippingResponse(results, revenues), source: "db" });
  }

  // ── Fall back to ML API ────────────────────────────────────────────────
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

  const mlResults: { id: number; isFlex: boolean; senderCost: number; receiverCost: number }[] = [];
  for (let i = 0; i < uniqueIds.length; i += 20) {
    const batch = uniqueIds.slice(i, i + 20);
    const batchResults = await Promise.all(
      batch.map(async (shipId) => {
        const [shipment, costs] = await Promise.all([
          mlGet<MLShipment>(`/shipments/${shipId}`, accessToken),
          mlGet<MLShipmentCosts>(`/shipments/${shipId}/costs`, accessToken),
        ]);
        return {
          id: shipId,
          isFlex: isLogisticaPropia(shipment?.receiver_address?.zip_code ?? null),
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
