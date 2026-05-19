// src/app/api/billing/taxes/route.ts
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

function monthKey(monthsBack: number): string {
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  return prevMonth.toISOString().slice(0, 7) + "-01";
}

interface MLPerception {
  description?: string;
  aliquot?: number;
  amount?: number;
  taxable_amount?: number;
  tax_type?: string;
  society?: string;
  [key: string]: unknown;
}

interface MLPerceptionsResponse {
  summary?: MLPerception[];                                                              // actual top-level shape
  perceptions?: MLPerception[] | { summary?: MLPerception[]; [key: string]: unknown };  // fallback shapes
  [key: string]: unknown;
}

function extractSummary(raw: MLPerceptionsResponse): MLPerception[] {
  // The real endpoint returns { summary: [...] } at the top level
  if (Array.isArray(raw.summary)) return raw.summary;
  // Fallback: nested under perceptions
  const p = raw.perceptions;
  if (!p) return [];
  if (Array.isArray(p)) return p;
  const nested = (p as { summary?: MLPerception[] }).summary;
  return Array.isArray(nested) ? nested : [];
}

function calcRate(perceptions: MLPerception[]): { total: number; rate: number } {
  const total = perceptions.reduce(
    (s, p) => s + (typeof p.amount === "number" ? p.amount : 0),
    0
  );
  const maxTaxable = perceptions.reduce(
    (m, p) => Math.max(m, typeof p.taxable_amount === "number" ? p.taxable_amount : 0),
    0
  );
  const rate = maxTaxable > 0 ? (total / maxTaxable) * 100 : 0;
  return { total, rate };
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

  // Always use previous month; fall back to 2 months ago if empty
  let period = monthKey(1);
  console.log("[billing/taxes] trying period:", period);

  let raw = await mlGet<MLPerceptionsResponse>(
    `/billing/integration/periods/key/${period}/perceptions/summary?group=ML`,
    accessToken
  );

  console.log("[billing/taxes] raw response keys:", "_error" in raw ? "ERROR" : Object.keys(raw as object));
  console.log("[billing/taxes] raw response:", JSON.stringify(raw).slice(0, 500));

  let summary = !("_error" in raw) ? extractSummary(raw as MLPerceptionsResponse) : [];
  console.log("[billing/taxes] extracted summary length:", summary.length, "| first item:", JSON.stringify(summary[0] ?? null));

  if ("_error" in raw || summary.length === 0) {
    const fallbackPeriod = monthKey(2);
    console.log("[billing/taxes] first period empty/error, trying fallback:", fallbackPeriod);
    const fallbackRaw = await mlGet<MLPerceptionsResponse>(
      `/billing/integration/periods/key/${fallbackPeriod}/perceptions/summary?group=ML`,
      accessToken
    );
    console.log("[billing/taxes] fallback raw:", JSON.stringify(fallbackRaw).slice(0, 500));
    if (!("_error" in fallbackRaw)) {
      const fallbackList = extractSummary(fallbackRaw as MLPerceptionsResponse);
      console.log("[billing/taxes] fallback summary length:", fallbackList.length);
      if (fallbackList.length > 0) {
        period = fallbackPeriod;
        raw = fallbackRaw;
        summary = fallbackList;
      }
    }
  }

  console.log("[billing/taxes] using period:", period, "| perceptions count:", summary.length);

  if (summary.length === 0) {
    return NextResponse.json({
      error: "perceptions.summary empty for both periods",
      triedPeriods: [monthKey(1), monthKey(2)],
      rawSample: JSON.stringify(raw).slice(0, 300),
    }, { status: 422 });
  }

  if ("_error" in raw) {
    return NextResponse.json({ error: (raw as { _error: string })._error }, { status: 502 });
  }

  // Split by society: ML = ventas, MCA = envíos
  const ventasPerceptions = summary.filter((p) => p.society === "ML");
  const enviosPerceptions = summary.filter((p) => p.society === "MCA");

  const { total: ventasTotal, rate: ventasRate } = calcRate(ventasPerceptions);
  const { total: enviosTotal, rate: enviosRate } = calcRate(enviosPerceptions);
  const combinedRate = ventasRate + enviosRate;

  console.log(
    "[billing/taxes] ventasRate:", ventasRate,
    "enviosRate:", enviosRate,
    "combinedRate:", combinedRate
  );

  return NextResponse.json({
    period,
    ventasRate,
    enviosRate,
    combinedRate,
    iibbVentas: { total: ventasTotal, rate: ventasRate, count: ventasPerceptions.length },
    iibbEnvios: { total: enviosTotal, rate: enviosRate, count: enviosPerceptions.length },
  });
}
