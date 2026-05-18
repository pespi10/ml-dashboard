// src/app/api/costs/sync/route.ts
import { NextRequest, NextResponse } from "next/server";

interface EanItem {
  ean: string;
  codigo: string;
  nombre: string;
  costo_sin_iva: number;
  costo_con_iva: number;
  precio_lista: number;
}

export interface SyncResult extends EanItem {
  ml_id: string | null;
  titulo_ml: string | null;
  found: boolean;
}

interface MLSearchResult {
  id: string;
  title: string;
}

const ML_BASE = "https://api.mercadolibre.com";
const DELAY_MS = 200;

async function searchByEan(ean: string): Promise<MLSearchResult | null> {
  try {
    const res = await fetch(
      `${ML_BASE}/sites/MLA/search?q=${encodeURIComponent(ean)}&limit=1`,
      { headers: { "Content-Type": "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.results?.length > 0) {
      return { id: data.results[0].id, title: data.results[0].title };
    }
    return null;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest) {
  let body: { items?: EanItem[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const items = body.items ?? [];
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items array required" }, { status: 400 });
  }

  // Limit batch size to prevent timeouts
  const batch = items.slice(0, 10);
  const results: SyncResult[] = [];
  let matched = 0;
  let notFound = 0;

  for (let i = 0; i < batch.length; i++) {
    if (i > 0) await sleep(DELAY_MS);
    const item = batch[i];
    const found = await searchByEan(item.ean);
    if (found) {
      matched++;
      results.push({ ...item, ml_id: found.id, titulo_ml: found.title, found: true });
    } else {
      notFound++;
      results.push({ ...item, ml_id: null, titulo_ml: null, found: false });
    }
  }

  return NextResponse.json({ matched, notFound, results });
}
