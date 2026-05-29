// src/app/api/billing/taxes/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
import { supabaseAdmin } from "@/lib/supabase";

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

function calcRate(
  perceptions: MLPerception[],
  allSummary: MLPerception[]
): { total: number; taxable: number; rate: number } {
  const total = perceptions.reduce(
    (s, p) => s + (typeof p.amount === "number" ? p.amount : 0),
    0
  );
  let taxable = perceptions.reduce(
    (m, p) => Math.max(m, typeof p.taxable_amount === "number" ? p.taxable_amount : 0),
    0
  );
  // Fallback: if group has no taxable_amount, use max across entire summary
  if (taxable <= 0) {
    taxable = allSummary.reduce(
      (m, p) => Math.max(m, typeof p.taxable_amount === "number" ? p.taxable_amount : 0),
      0
    );
  }
  // Last resort: sum of all taxable_amounts
  if (taxable <= 0) {
    taxable = allSummary.reduce(
      (s, p) => s + (typeof p.taxable_amount === "number" ? p.taxable_amount : 0),
      0
    );
  }
  const rate = taxable > 0 ? (total / taxable) * 100 : 0;
  return { total, taxable, rate };
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

  // ── Try DB first ────────────────────────────────────────────────────────
  let period = monthKey(1);
  const { data: dbPerceptions } = await supabaseAdmin
    .from("billing_perceptions")
    .select("society, tax_type, amount, taxable_amount, aliquot")
    .eq("period", period);

  if (dbPerceptions && dbPerceptions.length > 0) {
    const summary = dbPerceptions as MLPerception[];
    const ventasPerceptions = summary.filter((p) => p.society === "ML");
    const enviosPerceptions = summary.filter((p) => p.society === "MCA");
    const { total: ventasTotal, taxable: ventasTaxable, rate: ventasRate } = calcRate(ventasPerceptions, summary);
    const { total: enviosTotal, taxable: enviosTaxable, rate: enviosRate } = calcRate(enviosPerceptions, summary);
    return NextResponse.json({
      period, ventasRate, enviosRate, combinedRate: ventasRate + enviosRate,
      iibbVentas: { total: ventasTotal, taxable: ventasTaxable, rate: ventasRate, count: ventasPerceptions.length },
      iibbEnvios: { total: enviosTotal, taxable: enviosTaxable, rate: enviosRate, count: enviosPerceptions.length },
      source: "db",
    });
  }

  // ── Fall back to ML API ─────────────────────────────────────────────────
  // Always use previous month; fall back to 2 months ago if empty
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

  console.log("[billing/taxes] ML perceptions summary count:", summary.length);
  console.log("[billing/taxes] ventasPerceptions:", JSON.stringify(ventasPerceptions.map(p => ({
    type: p.tax_type, amount: p.amount, taxable: p.taxable_amount, aliquot: p.aliquot
  }))));

  const { total: ventasTotal, taxable: ventasTaxable, rate: ventasRate } = calcRate(ventasPerceptions, summary);
  const { total: enviosTotal, taxable: enviosTaxable, rate: enviosRate } = calcRate(enviosPerceptions, summary);
  const combinedRate = ventasRate + enviosRate;

  console.log("[billing/taxes] ventasTotal:", ventasTotal);
  console.log("[billing/taxes] ventasTaxable (max):", ventasTaxable);
  console.log("[billing/taxes] ventasRate:", ventasRate);
  console.log(
    "[billing/taxes] enviosTotal:", enviosTotal,
    "enviosTaxable:", enviosTaxable,
    "enviosRate:", enviosRate,
    "combinedRate:", combinedRate
  );

  return NextResponse.json({
    period,
    ventasRate,
    enviosRate,
    combinedRate,
    iibbVentas: { total: ventasTotal, taxable: ventasTaxable, rate: ventasRate, count: ventasPerceptions.length },
    iibbEnvios: { total: enviosTotal, taxable: enviosTaxable, rate: enviosRate, count: enviosPerceptions.length },
  });
}
