// src/app/api/costs/route.ts
// TODO: Replace module-level store with a database.
// Module-level state is per-process; it resets on cold starts (Vercel serverless).
// The client also maintains a localStorage copy for resilience across sessions.
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

interface CostEntry {
  ml_id: string;
  costo_sin_iva: number;
  costo_con_iva: number;
  precio_lista: number;
}

const costsStore: Record<string, CostEntry> = {};

export async function GET() {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(Object.values(costsStore));
}

export async function POST(request: NextRequest) {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Partial<CostEntry>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { ml_id, costo_sin_iva = 0, costo_con_iva = 0, precio_lista = 0 } = body;
  if (!ml_id) return NextResponse.json({ error: "ml_id required" }, { status: 400 });

  costsStore[ml_id] = { ml_id, costo_sin_iva, costo_con_iva, precio_lista };
  return NextResponse.json({ ok: true });
}
