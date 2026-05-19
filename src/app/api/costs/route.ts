// src/app/api/costs/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { upsertProductCosts, deleteProductCost } from "@/lib/db";
import { supabaseAdmin } from "@/lib/supabase";

interface CostRow {
  ml_id?: string;
  mla_id?: string; // accepted for backward compat, normalized to ml_id
  ean?: string | null;
  codigo?: string | null;
  nombre?: string | null;
  titulo_ml?: string | null;
  costo: number;
  precio_lista?: number | null;
  match_method?: string | null;
}

export async function GET() {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from("product_costs")
    .select("*")
    .order("ml_id");

  if (error) {
    console.error("GET /api/costs error:", error);
    return NextResponse.json({ error: error.message, details: error }, { status: 500 });
  }
  return NextResponse.json(data ?? []);
}

export async function POST(request: NextRequest) {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: CostRow | CostRow[];
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rows = Array.isArray(body) ? body : [body];
  if (rows.length === 0) return NextResponse.json({ ok: true, upserted: 0 });

  const valid = rows.filter((r) => r.ml_id || r.mla_id);
  if (valid.length === 0) return NextResponse.json({ error: "ml_id required" }, { status: 400 });

  const toUpsert = valid.map((r) => ({
    ml_id: r.ml_id ?? r.mla_id!,
    ean: r.ean ?? null,
    codigo: r.codigo ?? null,
    nombre: r.nombre ?? null,
    titulo_ml: r.titulo_ml ?? null,
    costo: r.costo ?? 0,
    precio_lista: r.precio_lista ?? 0,
    match_method: r.match_method ?? null,
  }));

  try {
    await upsertProductCosts(toUpsert);
  } catch (err: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    console.error("POST /api/costs error:", e);
    return NextResponse.json(
      {
        error: e?.message ?? String(e),
        code: e?.code,
        details: e?.details,
        hint: e?.hint,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, upserted: toUpsert.length });
}

export async function DELETE(request: NextRequest) {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const mlId = searchParams.get("ml_id");
  if (!mlId) return NextResponse.json({ error: "ml_id required" }, { status: 400 });

  try {
    await deleteProductCost(mlId);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
