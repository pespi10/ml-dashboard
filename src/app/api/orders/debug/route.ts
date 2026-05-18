// src/app/api/orders/debug/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";

const ML_BASE = "https://api.mercadolibre.com";

async function mlGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${ML_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ML ${res.status} ${path} — ${body}`);
  }
  return res.json() as Promise<T>;
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

  try {
    // Get the most recent order ID
    const search = await mlGet<{ results: { id: number }[]; paging: { total: number } }>(
      `/orders/search?seller=${tokens.user_id}&limit=1&sort=date_desc`,
      accessToken
    );

    if (!search.results.length) {
      return NextResponse.json({ error: "No orders found", total: search.paging.total });
    }

    const orderId = search.results[0].id;

    const order = await mlGet<unknown>(`/orders/${orderId}`, accessToken);

    return NextResponse.json({
      orderId,
      totalOrders: search.paging.total,
      order,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
