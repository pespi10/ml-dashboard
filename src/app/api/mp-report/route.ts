// src/app/api/mp-report/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";

const ML_BASE = "https://api.mercadolibre.com";

async function mlGet(path: string, accessToken: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${ML_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = await res.text().catch(() => null);
  }
  return { ok: res.ok, status: res.status, data };
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

  const [list, search] = await Promise.all([
    mlGet("/v1/account/settlement-report/list", accessToken),
    mlGet(
      "/v1/account/settlement-report/search?begin_date=2026-04-01T00:00:00Z&end_date=2026-04-30T23:59:59Z",
      accessToken
    ),
  ]);

  return NextResponse.json({ list, search });
}
