// src/app/api/products/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getAllItemsByStatus, isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
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
    const [activeData, pausedData, closedData] = await Promise.all([
      getAllItemsByStatus(activeTokens, "active"),
      getAllItemsByStatus(activeTokens, "paused"),
      getAllItemsByStatus(activeTokens, "closed", 50),
    ]);

    const response = NextResponse.json({
      active: activeData.results,
      paused: pausedData.results,
      closed: closedData.results,
      closedTotal: closedData.total,
    });

    if (refreshed) {
      response.cookies.set({
        ...SESSION_COOKIE_OPTIONS,
        value: buildSessionCookieValue(activeTokens),
      });
    }
    return response;
  } catch (err) {
    console.error("Products API error:", err);
    return NextResponse.json({ error: "ML API error" }, { status: 502 });
  }
}
