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

// ML API returns either perceptions[] or { summary: perceptions[] }
interface MLPerceptionsResponse {
  perceptions?: MLPerception[] | { summary?: MLPerception[]; [key: string]: unknown };
  [key: string]: unknown;
}

interface PerceptionDetail {
  description: string;
  aliquot: number;
  amount: number;
  taxable_amount: number;
  tax_type: string;
}

function extractSummary(raw: MLPerceptionsResponse): MLPerception[] {
  const p = raw.perceptions;
  if (!p) return [];
  if (Array.isArray(p)) return p;
  const nested = (p as { summary?: MLPerception[] }).summary;
  return Array.isArray(nested) ? nested : [];
}

function classifyPerception(p: MLPerception): "ventas" | "envios" {
  const taxType = (p.tax_type ?? "").toUpperCase();
  const society = (p.society ?? "").toUpperCase();
  if (society === "MCA" && ["ME", "CBTU", "IBSA"].some((t) => taxType.includes(t))) return "envios";
  return "ventas";
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

  let perceptionsList = !("_error" in raw)
    ? extractSummary(raw as MLPerceptionsResponse)
    : [];

  if ("_error" in raw || perceptionsList.length === 0) {
    const fallbackPeriod = monthKey(2);
    console.log("[billing/taxes] first period empty/error, trying fallback:", fallbackPeriod);
    const fallbackRaw = await mlGet<MLPerceptionsResponse>(
      `/billing/integration/periods/key/${fallbackPeriod}/perceptions/summary?group=ML`,
      accessToken
    );
    if (!("_error" in fallbackRaw)) {
      const fallbackList = extractSummary(fallbackRaw as MLPerceptionsResponse);
      if (fallbackList.length > 0) {
        period = fallbackPeriod;
        raw = fallbackRaw;
        perceptionsList = fallbackList;
      }
    }
  }

  console.log("[billing/taxes] using period:", period, "| perceptions count:", perceptionsList.length);

  if ("_error" in raw && perceptionsList.length === 0) {
    return NextResponse.json({ error: (raw as { _error: string })._error }, { status: 502 });
  }

  // Effective rate: total_amount / max_taxable_amount (as user specified)
  const totalAmount = perceptionsList.reduce(
    (s, p) => s + (typeof p.amount === "number" ? p.amount : 0),
    0
  );
  const maxTaxable =
    perceptionsList.length > 0
      ? Math.max(...perceptionsList.map((p) => (typeof p.taxable_amount === "number" ? p.taxable_amount : 0)))
      : 0;
  const effectiveRate = maxTaxable > 0 ? (totalAmount / maxTaxable) * 100 : 0;

  console.log(
    "[billing/taxes] totalAmount:", totalAmount,
    "maxTaxable:", maxTaxable,
    "effectiveRate:", effectiveRate
  );

  // Per-group breakdown for drawer detail
  const ventas: PerceptionDetail[] = [];
  const envios: PerceptionDetail[] = [];

  for (const p of perceptionsList) {
    const clean: PerceptionDetail = {
      description: typeof p.description === "string" ? p.description : "",
      aliquot: typeof p.aliquot === "number" ? p.aliquot : 0,
      amount: typeof p.amount === "number" ? p.amount : 0,
      taxable_amount: typeof p.taxable_amount === "number" ? p.taxable_amount : 0,
      tax_type: typeof p.tax_type === "string" ? p.tax_type : "",
    };
    if (classifyPerception(p) === "envios") envios.push(clean);
    else ventas.push(clean);
  }

  return NextResponse.json({
    period,
    effectiveRate,
    combinedRate: effectiveRate,
    iibbVentas: { total: ventas.reduce((s, p) => s + p.amount, 0), effectiveRate: 0, detail: ventas },
    iibbEnvios: { total: envios.reduce((s, p) => s + p.amount, 0), effectiveRate: 0, detail: envios },
  });
}
