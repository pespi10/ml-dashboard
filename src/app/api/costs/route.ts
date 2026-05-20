// src/app/api/costs/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { upsertProductCosts, deleteProductCost } from "@/lib/db";
import { supabaseAdmin } from "@/lib/supabase";
import { getOrders } from "@/lib/ml-api";

interface CostRow {
  ml_id?: string;
  mla_id?: string;
  ean?: string | null;
  codigo?: string | null;
  nombre?: string | null;
  titulo_ml?: string | null;
  costo: number;
  precio_lista?: number | null;
  match_method?: string | null;
}

interface EanRow {
  ean: string;
  codigo: string;
  nombre: string;
  costo: number;
  precio_lista: number;
}

export async function GET() {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabaseAdmin
    .from("product_costs")
    .select("*")
    .order("titulo_ml", { ascending: true, nullsFirst: false });

  if (error) {
    console.error("GET /api/costs error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data ?? []);
}

export async function POST(request: NextRequest) {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rows = Array.isArray(body) ? body : [body];
  if (rows.length === 0) return NextResponse.json({ ok: true, upserted: 0 });

  // EAN batch: items with ean/codigo but no ml_id → run automatic matching
  const isEanBatch = rows.length > 0 && !(rows[0] as CostRow).ml_id && !(rows[0] as CostRow).mla_id;
  if (isEanBatch) {
    return handleEanBatch(tokens, rows as EanRow[]);
  }

  // Direct upsert: items already have ml_id
  const valid = (rows as CostRow[]).filter((r) => r.ml_id || r.mla_id);
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
    return NextResponse.json({ error: e?.message ?? String(e), code: e?.code }, { status: 500 });
  }

  return NextResponse.json({ ok: true, upserted: toUpsert.length });
}

async function handleEanBatch(
  tokens: NonNullable<ReturnType<typeof getSession>>,
  items: EanRow[]
): Promise<NextResponse> {
  // Build ean/codigo → ml_id map from last 30 days of orders
  const eanToMlaMap: Record<string, string> = {};
  const eanToTitle: Record<string, string> = {};
  try {
    const orders = await getOrders(tokens, 30);
    for (const order of orders) {
      for (const oi of order.order_items) {
        if (oi.item.seller_sku && oi.item.id) {
          const key = oi.item.seller_sku.trim();
          eanToMlaMap[key] = oi.item.id;
          eanToTitle[key] = oi.item.title;
        }
      }
    }
    console.log("[api/costs EAN batch] eanToMlaMap size:", Object.keys(eanToMlaMap).length);
  } catch (e) {
    console.error("[api/costs EAN batch] orders fetch failed:", e);
  }

  // Read existing ml_ids to distinguish nuevos vs actualizados
  const { data: existing } = await supabaseAdmin
    .from("product_costs")
    .select("ml_id");
  const existingIds = new Set((existing ?? []).map((r) => r.ml_id as string));

  // Match each item
  const toUpsert: Parameters<typeof upsertProductCosts>[0] = [];
  let nuevos = 0;
  let actualizados = 0;
  let sinMatch = 0;

  for (const item of items) {
    const eanKey = item.ean?.trim() ?? "";
    const codigoKey = item.codigo?.trim() ?? "";
    const mlId = eanToMlaMap[eanKey] ?? eanToMlaMap[codigoKey] ?? null;

    if (!mlId) {
      sinMatch++;
      continue;
    }

    if (existingIds.has(mlId)) actualizados++;
    else nuevos++;

    const titleKey = eanToMlaMap[eanKey] ? eanKey : codigoKey;
    toUpsert.push({
      ml_id: mlId,
      ean: item.ean ?? null,
      codigo: item.codigo ?? null,
      nombre: item.nombre ?? null,
      titulo_ml: eanToTitle[titleKey] ?? null,
      costo: item.costo,
      precio_lista: item.precio_lista ?? 0,
      match_method: "order_sku",
    });
  }

  console.log("[api/costs EAN batch] nuevos:", nuevos, "actualizados:", actualizados, "sinMatch:", sinMatch);

  if (toUpsert.length > 0) {
    try {
      await upsertProductCosts(toUpsert);
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any;
      console.error("[api/costs EAN batch] upsert error:", e);
      return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
    }
  }

  return NextResponse.json({ nuevos, actualizados, sinMatch });
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
