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
    state?: { name?: string };
    city?: { name?: string };
  };
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

  // Extract shipping IDs from orders that have them
  const shippingIds = orders
    .map((o) => o.shipping?.id)
    .filter((id): id is number => typeof id === "number" && id > 0);

  // Deduplicate
  const uniqueIds = Array.from(new Set(shippingIds));

  // Fetch shipment details in batches of 20 with 200ms delay
  const BATCH_SIZE = 20;
  const DELAY_MS = 200;
  const zipResults: { id: number; zip: string | null }[] = [];

  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (shipId) => {
        const shipment = await mlGet<MLShipment>(`/shipments/${shipId}`, accessToken);
        return { id: shipId, zip: shipment?.receiver_address?.zip_code ?? null };
      })
    );
    zipResults.push(...batchResults);
    if (i + BATCH_SIZE < uniqueIds.length) {
      await sleep(DELAY_MS);
    }
  }

  // Classify each shipment
  let propiaCount = 0;
  let mlCount = 0;

  for (const { zip } of zipResults) {
    if (isLogisticaPropia(zip)) {
      propiaCount++;
    } else {
      mlCount++;
    }
  }

  const total = propiaCount + mlCount;
  const propiaRatio = total > 0 ? (propiaCount / total) * 100 : 0;
  const mlRatio = total > 0 ? (mlCount / total) * 100 : 0;

  return NextResponse.json({
    totalOrders: orders.length,
    analyzedShipments: total,
    logisticaPropia: {
      count: propiaCount,
      totalCost: propiaCount * LOGISTICA_PROPIA_COSTO_POR_PEDIDO,
      avgCost: LOGISTICA_PROPIA_COSTO_POR_PEDIDO,
    },
    mercadoEnvios: {
      count: mlCount,
    },
    splitRatio: {
      propia: Math.round(propiaRatio * 10) / 10,
      ml: Math.round(mlRatio * 10) / 10,
    },
  });
}
