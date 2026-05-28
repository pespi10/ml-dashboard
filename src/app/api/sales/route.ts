// src/app/api/sales/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getOrdersPage, isTokenExpired, refreshAccessToken, type OrdersOptions } from "@/lib/ml-api";
import { buildSessionCookieValue, SESSION_COOKIE_OPTIONS } from "@/lib/session";

export async function GET(request: NextRequest) {
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

  const { searchParams } = request.nextUrl;
  const parsedPage = Number.parseInt(searchParams.get("page") || "1", 10);
  const parsedLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
  const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(50, Math.max(1, parsedLimit))
    : 50;

  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");
  const ordersOptions: number | OrdersOptions =
    dateFrom && dateTo ? { date_from: dateFrom, date_to: dateTo } : 30;

  try {
    const data = await getOrdersPage(activeTokens, page, limit, ordersOptions);
    const response = NextResponse.json(data);
    if (refreshed) {
      response.cookies.set({ ...SESSION_COOKIE_OPTIONS, value: buildSessionCookieValue(activeTokens) });
    }
    return response;
  } catch (err) {
    console.error("Sales API error:", err);
    return NextResponse.json({ error: "ML API error" }, { status: 502 });
  }
}
