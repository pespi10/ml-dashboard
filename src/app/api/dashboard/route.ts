// src/app/api/dashboard/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getDashboardStats, isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
import { buildSessionCookieValue, SESSION_COOKIE_OPTIONS } from "@/lib/session";

export async function GET() {
  const tokens = getSession();

  if (!tokens) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Refresh si está por vencer
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
    const stats = await getDashboardStats(activeTokens);
    const response = NextResponse.json(stats);

    // Si refrescamos, actualizamos la cookie
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
