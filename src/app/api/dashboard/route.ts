// src/app/api/dashboard/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSession, buildSessionCookieValue, SESSION_COOKIE_OPTIONS } from "@/lib/session";
import { isTokenExpired, refreshAccessToken } from "@/lib/ml-api";
import { supabaseAdmin } from "@/lib/supabase";

// ── Types ─────────────────────────────────────────────────────────────

interface DBOrder {
  id: number;
  date_created: string;
  total_amount: number;
  sale_fee: number;
  logistic_type: string | null;
  item_id: string | null;
  item_title: string | null;
  quantity: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

function isFlex(logistic_type: string | null): boolean {
  return logistic_type === "self_service" || logistic_type === "xd_drop_off";
}

// Fetch ALL orders for a period with deterministic ORDER BY id pagination
async function fetchOrders(dateFrom: string, dateTo: string): Promise<DBOrder[] | null> {
  const PAGE = 1000;
  const all: DBOrder[] = [];
  let offset = 0;
  let expectedCount: number | null = null;

  while (true) {
    const { data, error, count } = await supabaseAdmin
      .from("orders")
      .select(
        "id, date_created, total_amount, sale_fee, logistic_type, item_id, item_title, quantity",
        offset === 0 ? { count: "exact" } : {}
      )
      .gte("date_created", `${dateFrom}T00:00:00.000Z`)
      .lte("date_created", `${dateTo}T23:59:59.999Z`)
      .order("id")                          // ← deterministic order, fixes fluctuation
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.error("[dashboard] Supabase error:", error.message);
      return null;
    }

    if (offset === 0) {
      expectedCount = count ?? 0;
      if (!expectedCount) return null;      // no data for this period
      console.log(`[dashboard] fetching ${expectedCount} orders in pages of ${PAGE}`);
    }

    if (!data || data.length === 0) break;
    all.push(...(data as DBOrder[]));
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  console.log(`[dashboard] fetched ${all.length} / expected ${expectedCount}`);
  return all.length > 0 ? all : null;
}

// ── GET handler ───────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  // Auth
  const tokens = getSession();
  if (!tokens) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let activeTokens = tokens;
  let refreshed = false;
  if (isTokenExpired(tokens)) {
    try {
      activeTokens = await refreshAccessToken(tokens);
      refreshed = true;
    } catch {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
  }

  // Params
  const { searchParams } = new URL(request.url);
  const today = new Date().toISOString().split("T")[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString().split("T")[0];
  const dateFrom = searchParams.get("date_from") ?? thirtyDaysAgo;
  const dateTo   = searchParams.get("date_to")   ?? today;

  // Fetch
  const orders = await fetchOrders(dateFrom, dateTo);

  if (!orders) {
    return NextResponse.json({
      source: "empty",
      message: "No hay datos para este período. Ejecutá el sync primero.",
      dateFrom,
      dateTo,
      ordersTotal: 0,
      flexCount: 0,
      colectaCount: 0,
      totalRevenue: 0,
      flexRevenue: 0,
      colectaRevenue: 0,
      totalSaleFees: 0,
      flexSaleFees: 0,
      colectaSaleFees: 0,
      colectaShippingCost: 0,
      profitabilityByItem: [],
      revenueByDay: [],
    });
  }

  // ── Compute all metrics from the single dataset ───────────────────

  const flexOrders    = orders.filter(o => isFlex(o.logistic_type));
  const colectaOrders = orders.filter(o => !isFlex(o.logistic_type));

  const totalRevenue    = orders.reduce((s, o) => s + (o.total_amount ?? 0), 0);
  const flexRevenue     = flexOrders.reduce((s, o) => s + (o.total_amount ?? 0), 0);
  const colectaRevenue  = colectaOrders.reduce((s, o) => s + (o.total_amount ?? 0), 0);

  const totalSaleFees   = orders.reduce((s, o) => s + (o.sale_fee ?? 0), 0);
  const flexSaleFees    = flexOrders.reduce((s, o) => s + (o.sale_fee ?? 0), 0);
  const colectaSaleFees = colectaOrders.reduce((s, o) => s + (o.sale_fee ?? 0), 0);

  // Revenue by day (for chart)
  const byDay: Record<string, { revenue: number; orders: number }> = {};
  for (const o of orders) {
    const day = o.date_created.slice(0, 10);
    if (!byDay[day]) byDay[day] = { revenue: 0, orders: 0 };
    byDay[day].revenue += o.total_amount ?? 0;
    byDay[day].orders  += 1;
  }
  const revenueByDay = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));

  // Profitability by item
  const itemMap: Record<string, {
    itemId: string;
    itemTitle: string;
    unitsSold: number;
    grossRevenue: number;
    totalSaleFees: number;
  }> = {};

  for (const o of orders) {
    if (!o.item_id) continue;
    if (!itemMap[o.item_id]) {
      itemMap[o.item_id] = {
        itemId: o.item_id,
        itemTitle: o.item_title ?? o.item_id,
        unitsSold: 0,
        grossRevenue: 0,
        totalSaleFees: 0,
      };
    }
    itemMap[o.item_id].unitsSold    += o.quantity ?? 1;
    itemMap[o.item_id].grossRevenue += o.total_amount ?? 0;
    itemMap[o.item_id].totalSaleFees += o.sale_fee ?? 0;
  }

  const profitabilityByItem = Object.values(itemMap)
    .sort((a, b) => b.grossRevenue - a.grossRevenue)
    .map(i => ({
      ...i,
      netRevenue: i.grossRevenue - i.totalSaleFees,
      margin: i.grossRevenue > 0
        ? ((i.grossRevenue - i.totalSaleFees) / i.grossRevenue) * 100
        : 0,
    }));

  // Build response
  const payload = {
    source: "db" as const,
    dateFrom,
    dateTo,
    // Orders
    ordersTotal:        orders.length,
    flexCount:          flexOrders.length,
    colectaCount:       colectaOrders.length,
    // Revenue
    totalRevenue,
    flexRevenue,
    colectaRevenue,
    // Fees
    totalSaleFees,
    flexSaleFees,
    colectaSaleFees,
    // Shipping cost — colecta seller_cost is 0 until enriched via separate process
    // Frontend uses COSTO_FLEX (7000/order) for flex and this for colecta
    colectaShippingCost: 0,
    // Detail data
    profitabilityByItem,
    revenueByDay,
  };

  const response = NextResponse.json(payload);
  if (refreshed) {
    response.cookies.set({
      ...SESSION_COOKIE_OPTIONS,
      value: buildSessionCookieValue(activeTokens),
    });
  }
  return response;
}
