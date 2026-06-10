import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
import { supabaseAdmin } from "@/lib/supabase";
import { buildSessionCookieValue, SESSION_COOKIE_OPTIONS } from "@/lib/session";

function isFlexLogistic(lt: string | null | undefined): boolean {
  return lt === "self_service" || lt === "xd_drop_off";
}

export async function GET(request: NextRequest) {
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let activeTokens = tokens;
  let refreshed = false;
  if (isTokenExpired(tokens)) {
    try { activeTokens = await refreshAccessToken(tokens); refreshed = true; }
    catch { return NextResponse.json({ error: "Token expired" }, { status: 401 }); }
  }

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("date_from") ?? new Date(Date.now() - 30 * 86400_000).toISOString().split("T")[0];
  const dateTo   = searchParams.get("date_to")   ?? new Date().toISOString().split("T")[0];

  // Single paginated query — all orders for the period
  const PAGE = 1000;
  const allRows: {
    id: number;
    total_amount: number;
    sale_fee: number;
    logistic_type: string | null;
    item_id: string | null;
    quantity: number;
  }[] = [];

  let offset = 0;
  let totalCount: number | null = null;

  while (true) {
    const q = supabaseAdmin
      .from("orders")
      .select("id, total_amount, sale_fee, logistic_type, item_id, quantity", offset === 0 ? { count: "exact" } : {})
      .gte("date_created", `${dateFrom}T00:00:00.000Z`)
      .lte("date_created", `${dateTo}T23:59:59.999Z`)
      .range(offset, offset + PAGE - 1);

    const { data, error, count } = await q;
    if (error || !data) break;
    if (offset === 0) {
      totalCount = count ?? null;
      if (!totalCount || totalCount === 0) break;
    }
    allRows.push(...(data as typeof allRows));
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  // Compute all metrics from the single dataset
  const flexRows    = allRows.filter(r => isFlexLogistic(r.logistic_type));
  const colectaRows = allRows.filter(r => !isFlexLogistic(r.logistic_type));

  const totalRevenue    = allRows.reduce((s, r) => s + (r.total_amount ?? 0), 0);
  const totalSaleFees   = allRows.reduce((s, r) => s + (r.sale_fee ?? 0), 0);
  const flexRevenue     = flexRows.reduce((s, r) => s + (r.total_amount ?? 0), 0);
  const colectaRevenue  = colectaRows.reduce((s, r) => s + (r.total_amount ?? 0), 0);
  const flexSaleFees    = flexRows.reduce((s, r) => s + (r.sale_fee ?? 0), 0);
  const colectaSaleFees = colectaRows.reduce((s, r) => s + (r.sale_fee ?? 0), 0);

  // Profitability by item — computed from same dataset
  const itemMap: Record<string, { itemId: string; unitsSold: number; grossRevenue: number; totalSaleFees: number }> = {};
  for (const r of allRows) {
    if (!r.item_id) continue;
    if (!itemMap[r.item_id]) itemMap[r.item_id] = { itemId: r.item_id, unitsSold: 0, grossRevenue: 0, totalSaleFees: 0 };
    itemMap[r.item_id].unitsSold     += r.quantity ?? 1;
    itemMap[r.item_id].grossRevenue  += r.total_amount ?? 0;
    itemMap[r.item_id].totalSaleFees += r.sale_fee ?? 0;
  }
  const profitabilityByItem = Object.values(itemMap).sort((a, b) => b.grossRevenue - a.grossRevenue);

  const response = NextResponse.json({
    // Overview fields
    ordersTotal: allRows.length,
    flexCount: flexRows.length,
    colectaCount: colectaRows.length,
    flexRevenue,
    colectaRevenue,
    colectaShippingCost: 0,
    totalRevenue,
    totalSaleFees,
    flexSaleFees,
    colectaSaleFees,
    source: "db",
    // Profitability fields
    profitabilityByItem,
    // Meta
    dateFrom,
    dateTo,
  });

  if (refreshed) {
    response.cookies.set({ ...SESSION_COOKIE_OPTIONS, value: buildSessionCookieValue(activeTokens) });
  }
  return response;
}
