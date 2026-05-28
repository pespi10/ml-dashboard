// src/app/api/dashboard/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  getDashboardStats,
  getDashboardOverview,
  getDashboardSalesStats,
  getDashboardStockStats,
  getProfitabilityStats,
  isTokenExpired,
  refreshAccessToken,
  type OrdersOptions,
} from "@/lib/ml-api";
import { buildSessionCookieValue, SESSION_COOKIE_OPTIONS } from "@/lib/session";

export async function GET(request: NextRequest) {
  const tokens = getSession();

  if (!tokens) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
  const isOverview = searchParams.get("overview") === "1";
  const section = searchParams.get("section");
  const parsedPage = Number.parseInt(searchParams.get("page") || "1", 10);
  const parsedLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
  const parsedDays = Number.parseInt(searchParams.get("days") || "30", 10);
  const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(50, Math.max(1, parsedLimit))
    : 50;
  const days = Number.isFinite(parsedDays) ? Math.max(7, Math.min(90, parsedDays)) : 30;

  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");
  const ordersOptions: number | OrdersOptions =
    dateFrom && dateTo ? { date_from: dateFrom, date_to: dateTo } : days;

  try {
    let data;
    if (isOverview) {
      data = await getDashboardOverview(activeTokens, ordersOptions);
    } else if (section === "sales") {
      data = await getDashboardSalesStats(activeTokens, page, limit, ordersOptions);
    } else if (section === "stock") {
      data = await getDashboardStockStats(activeTokens, page, limit);
    } else if (section === "profitability") {
      data = await getProfitabilityStats(activeTokens, ordersOptions);
    } else {
      data = await getDashboardStats(activeTokens, page, limit);
    }

    const response = NextResponse.json(data);

    if (refreshed) {
      response.cookies.set({
        ...SESSION_COOKIE_OPTIONS,
        value: buildSessionCookieValue(activeTokens),
      });
    }

    return response;
  } catch (err) {
    console.error("Dashboard API error:", err);
    return NextResponse.json({ error: "ML API error" }, { status: 502 });
  }
}
