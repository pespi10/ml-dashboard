// src/app/api/sales/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getOrders, isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
import { buildSessionCookieValue, SESSION_COOKIE_OPTIONS } from "@/lib/session";

export async function GET() {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let activeTokens = tokens;
  let refreshed = false;
  if (isTokenExpired(tokens)) {
    try {
      activeTokens = await refreshAccessToken(tokens);
      refreshed = true;
    } catch {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
  }

  try {
    const orders = await getOrders(activeTokens, 30);
    const response = NextResponse.json(orders);
    if (refreshed) {
      response.cookies.set({ ...SESSION_COOKIE_OPTIONS, value: buildSessionCookieValue(activeTokens) });
    }
    return response;
  } catch (err) {
    console.error("Sales API error:", err);
    return NextResponse.json({ error: "ML API error" }, { status: 502 });
  }
}
