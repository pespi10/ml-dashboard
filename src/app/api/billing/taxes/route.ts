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
  const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
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
  perceptions?: MLPerception[];
  [key: string]: unknown;
}

interface PerceptionDetail {
  description: string;
  aliquot: number;
  amount: number;
  taxable_amount: number;
  tax_type: string;
}

function classifyPerception(p: MLPerception): "ventas" | "envios" | "other" {
  const taxType = (p.tax_type ?? "").toUpperCase();
  const society = (p.society ?? "").toUpperCase();

  // IIBB sobre ventas
  if (["IB", "CGMV", "CIBT"].some((t) => taxType.includes(t))) return "ventas";

  // IIBB sobre envíos (MCA society)
  if (society === "MCA" && ["ME", "CBTU", "IBSA"].some((t) => taxType.includes(t))) return "envios";

  return "other";
}

function calcGroup(items: PerceptionDetail[]) {
  const total = items.reduce((s, p) => s + p.amount, 0);
  const maxBase = items.reduce((m, p) => Math.max(m, p.taxable_amount), 0);
  const effectiveRate = maxBase > 0 ? (total / maxBase) * 100 : 0;
  return { total, effectiveRate, detail: items };
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

  // Try previous month first; if empty, fall back to 2 months ago
  let period = monthKey(1);
  let raw = await mlGet<MLPerceptionsResponse>(
    `/billing/integration/periods/key/${period}/perceptions/summary?group=ML`,
    accessToken
  );

  // If first attempt errored or returned no perceptions, try one month further back
  const firstPerceptions = !("_error" in raw) && Array.isArray((raw as MLPerceptionsResponse).perceptions)
    ? (raw as MLPerceptionsResponse).perceptions as MLPerception[]
    : [];

  if ("_error" in raw || firstPerceptions.length === 0) {
    const fallbackPeriod = monthKey(2);
    const fallbackRaw = await mlGet<MLPerceptionsResponse>(
      `/billing/integration/periods/key/${fallbackPeriod}/perceptions/summary?group=ML`,
      accessToken
    );
    if (!("_error" in fallbackRaw)) {
      const fallbackPerceptions = Array.isArray((fallbackRaw as MLPerceptionsResponse).perceptions)
        ? (fallbackRaw as MLPerceptionsResponse).perceptions as MLPerception[]
        : [];
      if (fallbackPerceptions.length > 0) {
        period = fallbackPeriod;
        raw = fallbackRaw;
      }
    }
  }

  if ("_error" in raw) {
    return NextResponse.json({ error: (raw as { _error: string })._error }, { status: 502 });
  }

  const perceptionsRaw: MLPerception[] = Array.isArray((raw as MLPerceptionsResponse).perceptions)
    ? ((raw as MLPerceptionsResponse).perceptions as MLPerception[])
    : [];

  const ventas: PerceptionDetail[] = [];
  const envios: PerceptionDetail[] = [];

  for (const p of perceptionsRaw) {
    const clean: PerceptionDetail = {
      description: typeof p.description === "string" ? p.description : "",
      aliquot: typeof p.aliquot === "number" ? p.aliquot : 0,
      amount: typeof p.amount === "number" ? p.amount : 0,
      taxable_amount: typeof p.taxable_amount === "number" ? p.taxable_amount : 0,
      tax_type: typeof p.tax_type === "string" ? p.tax_type : "",
    };
    const group = classifyPerception(p);
    if (group === "ventas") ventas.push(clean);
    else if (group === "envios") envios.push(clean);
    else ventas.push(clean); // fallback: treat unknown as ventas
  }

  const iibbVentas = calcGroup(ventas);
  const iibbEnvios = calcGroup(envios);
  const combinedRate = iibbVentas.effectiveRate + iibbEnvios.effectiveRate;

  return NextResponse.json({
    period,
    iibbVentas,
    iibbEnvios,
    combinedRate,
  });
}
