// src/app/api/shipping/debug/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";

const ML_BASE = "https://api.mercadolibre.com";

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

  // 1. Fetch most recent order
  const ordersRes = await fetch(
    `${ML_BASE}/orders/search?seller=${tokens.user_id}&limit=1&sort=date_desc`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" }
  );
  if (!ordersRes.ok) {
    return NextResponse.json(
      { error: `orders/search failed: ${ordersRes.status}`, body: await ordersRes.text().catch(() => "") },
      { status: 502 }
    );
  }
  const ordersData = await ordersRes.json();
  const order = ordersData?.results?.[0];
  if (!order) {
    return NextResponse.json({ error: "No orders found", ordersData });
  }

  const shippingId = order?.shipping?.id;
  if (!shippingId) {
    return NextResponse.json({ error: "Most recent order has no shipping_id", order });
  }

  // 2. GET /marketplace/shipments/{id} with x-format-new: true
  const marketplaceRes = await fetch(
    `${ML_BASE}/marketplace/shipments/${shippingId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "x-format-new": "true",
      },
      cache: "no-store",
    }
  );
  const marketplaceStatus = marketplaceRes.status;
  const marketplaceBody = await marketplaceRes.text().catch(() => "");
  let marketplaceJson: unknown = null;
  try { marketplaceJson = JSON.parse(marketplaceBody); } catch { marketplaceJson = marketplaceBody; }

  // 3. GET /shipments/{id}/costs
  const costsRes = await fetch(
    `${ML_BASE}/shipments/${shippingId}/costs`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" }
  );
  const costsStatus = costsRes.status;
  const costsBody = await costsRes.text().catch(() => "");
  let costsJson: unknown = null;
  try { costsJson = JSON.parse(costsBody); } catch { costsJson = costsBody; }

  // 4. Also fetch plain /shipments/{id} for comparison
  const shipmentRes = await fetch(
    `${ML_BASE}/shipments/${shippingId}`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" }
  );
  const shipmentStatus = shipmentRes.status;
  const shipmentBody = await shipmentRes.text().catch(() => "");
  let shipmentJson: unknown = null;
  try { shipmentJson = JSON.parse(shipmentBody); } catch { shipmentJson = shipmentBody; }

  return NextResponse.json({
    order_id: order.id,
    shipping_id: shippingId,
    marketplace_shipment: { status: marketplaceStatus, data: marketplaceJson },
    shipment_costs: { status: costsStatus, data: costsJson },
    shipment_plain: { status: shipmentStatus, data: shipmentJson },
  });
}
