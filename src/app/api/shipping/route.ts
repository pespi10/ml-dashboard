// src/app/api/shipping/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
import { isLogisticaPropia, LOGISTICA_PROPIA_COSTO_POR_PEDIDO } from "@/lib/shipping-config";

const ML_BASE = "https://api.mercadolibre.com";

interface MLShipment {
  id: number;
  receiver_address?: {
    zip_code?: string;
  };
}

interface MLShipmentCosts {
  senders?: Array<{
    cost?: number;
    save?: number;
    gross_amount?: number;
    discounts?: Array<{ promoted_amount?: number }>;
    [key: string]: unknown;
  }>;
  receiver?: {
    cost?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OrderWithShipping {
  id: number;
  shipping?: { id?: number } | null;
}

async function mlGet<T>(path: string, accessToken: string): Promise<T | null> {
  try {
    const res = await fetch(`${ML_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // Fetch 200 most recent orders (4 pages × 50)
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

  // Extract and deduplicate shipping IDs
  const uniqueIds = Array.from(new Set(
    orders
      .map((o) => o.shipping?.id)
      .filter((id): id is number => typeof id === "number" && id > 0)
  ));

  // Batch-fetch shipment + costs in parallel per shipment, 20 at a time
  const BATCH_SIZE = 20;
  const DELAY_MS = 200;

  interface ShipResult {
    id: number;
    zip: string | null;
    senderCost: number;   // what the seller pays (senders[0].cost)
    receiverCost: number; // what the buyer pays (receiver.cost)
  }

  const results: ShipResult[] = [];

  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (shipId): Promise<ShipResult> => {
        const [shipment, costs] = await Promise.all([
          mlGet<MLShipment>(`/shipments/${shipId}`, accessToken),
          mlGet<MLShipmentCosts>(`/shipments/${shipId}/costs`, accessToken),
        ]);
        return {
          id: shipId,
          zip: shipment?.receiver_address?.zip_code ?? null,
          senderCost: costs?.senders?.[0]?.cost ?? 0,
          receiverCost: costs?.receiver?.cost ?? 0,
        };
      })
    );
    results.push(...batchResults);
    if (i + BATCH_SIZE < uniqueIds.length) await sleep(DELAY_MS);
  }

  // Classify: logística propia vs ML Envíos
  let propiaCount = 0;
  const mlResults: ShipResult[] = [];

  for (const r of results) {
    if (isLogisticaPropia(r.zip)) {
      propiaCount++;
    } else {
      mlResults.push(r);
    }
  }

  const mlCount = mlResults.length;
  const total = results.length;

  // ML Envíos breakdown by who pays
  const sellerPaidCount  = mlResults.filter(r => r.senderCost > 0).length;
  const buyerPaidCount   = mlResults.filter(r => r.receiverCost > 0 && r.senderCost === 0).length;
  const sharedCount      = mlResults.filter(r => r.senderCost > 0 && r.receiverCost > 0).length;

  const sellerCosts = mlResults.filter(r => r.senderCost > 0).map(r => r.senderCost);
  const avgSellerCost = sellerCosts.length > 0
    ? Math.round(sellerCosts.reduce((s, c) => s + c, 0) / sellerCosts.length)
    : 0;

  const pct = (n: number) => total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
  const pctOfMl = (n: number) => mlCount > 0 ? Math.round((n / mlCount) * 1000) / 10 : 0;

  const propiaRatio = pct(propiaCount);
  const mlRatio = pct(mlCount);

  return NextResponse.json({
    totalOrders: orders.length,
    analyzedShipments: total,
    avgMLShippingCost: avgSellerCost,
    avgSellerCost,
    pctSellerPays: pctOfMl(sellerPaidCount),
    pctBuyerPays: pctOfMl(buyerPaidCount),
    pctShared: pctOfMl(sharedCount),
    totalAnalyzed: total,
    logisticaPropia: {
      count: propiaCount,
      pct: propiaRatio,
      avgCost: LOGISTICA_PROPIA_COSTO_POR_PEDIDO,
    },
    mercadoEnvios: {
      count: mlCount,
      pct: mlRatio,
      avgCost: avgSellerCost,
      sellerPaidCount,
      buyerPaidCount,
      sharedCount,
    },
    splitRatio: {
      propia: propiaRatio,
      ml: mlRatio,
    },
  });
}
