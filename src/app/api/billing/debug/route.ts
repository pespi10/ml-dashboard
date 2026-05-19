// src/app/api/billing/debug/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";

const ML_BASE = "https://api.mercadolibre.com";

async function mlGet<T>(path: string, accessToken: string): Promise<T | { _error: string }> {
  const res = await fetch(`${ML_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { _error: `ML ${res.status} — ${body}` };
  }
  return res.json() as Promise<T>;
}

function prevMonthKey(currentKey: string): string {
  const [year, month] = currentKey.split("-").map(Number);
  const d = new Date(year, month - 2, 1); // month-2 because Date months are 0-indexed
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
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

  const currentKey = new Date().toISOString().slice(0, 7) + "-01";
  const previousKey = prevMonthKey(currentKey);

  const [
    currentPerceptions,
    currentSummary,
    previousPerceptions,
    previousSummary,
  ] = await Promise.all([
    mlGet<unknown>(
      `/billing/integration/periods/key/${currentKey}/perceptions/summary?group=ML`,
      accessToken
    ),
    mlGet<unknown>(
      `/billing/integration/periods/key/${currentKey}/summary/details?group=ML&document_type=BILL`,
      accessToken
    ),
    mlGet<unknown>(
      `/billing/integration/periods/key/${previousKey}/perceptions/summary?group=ML`,
      accessToken
    ),
    mlGet<unknown>(
      `/billing/integration/periods/key/${previousKey}/summary/details?group=ML&document_type=BILL`,
      accessToken
    ),
  ]);

  return NextResponse.json({
    current: {
      periodKey: currentKey,
      perceptions: currentPerceptions,
      summary: currentSummary,
    },
    previous: {
      periodKey: previousKey,
      perceptions: previousPerceptions,
      summary: previousSummary,
    },
  });
}
