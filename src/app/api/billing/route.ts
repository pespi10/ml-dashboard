// src/app/api/billing/route.ts
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

  const periodKey = new Date().toISOString().slice(0, 7) + "-01";

  try {
    const [perceptions, summary] = await Promise.all([
      mlGet<unknown>(
        `/billing/integration/periods/key/${periodKey}/perceptions/summary?group=ML`,
        accessToken
      ),
      mlGet<unknown>(
        `/billing/integration/periods/key/${periodKey}/summary/details?group=ML`,
        accessToken
      ),
    ]);

    return NextResponse.json({
      periodKey,
      perceptions,
      summary,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
