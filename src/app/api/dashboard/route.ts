// src/app/api/dashboard/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import {
  getDashboardStats,
  getDashboardOverview,
  getDashboardSalesStats,
  getDashboardStockStats,
  getProfitabilityStats,
  isTokenExpired,
  refreshAccessToken,
  type OrdersOptions,
  type ProfitabilityItem,
} from "@/lib/ml-api";
import { buildSessionCookieValue, SESSION_COOKIE_OPTIONS } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

// ── Helpers ───────────────────────────────────────────────────────────────

function isFlexLogistic(lt: string | null | undefined): boolean {
  return lt === "self_service" || lt === "xd_drop_off";
}

interface DBOrderRow {
  id: number;
  item_id: string | null;
  item_title: string | null;
  category_id: string | null;
  quantity: number;
  unit_price: number;
  sale_fee: number;
  date_created: string;
  total_amount: number;
  logistic_type: string | null;
}

// Full paginated fetch — loops in chunks of 1,000 until all rows are retrieved
async function fetchAllOrdersFromDB(fromStr: string, toStr: string): Promise<DBOrderRow[] | null> {
  const PAGE = 1000;
  const all: DBOrderRow[] = [];
  let offset = 0;
  let totalCount: number | null = null;

  while (true) {
    const q = supabaseAdmin
      .from("orders")
      .select(
        "id, item_id, item_title, category_id, quantity, unit_price, sale_fee, date_created, total_amount, logistic_type",
        offset === 0 ? { count: "exact" } : {}
      )
      .gte("date_created", `${fromStr}T00:00:00.000Z`)
      .lte("date_created", `${toStr}T23:59:59.999Z`)
      .range(offset, offset + PAGE - 1);

    const { data, error, count } = await q;

    if (error) {
      console.error("[dashboard] DB query error:", error.message);
      return null;
    }
    if (!data || data.length === 0) break;

    all.push(...(data as DBOrderRow[]));

    if (offset === 0) {
      totalCount = count ?? null;
      if (!totalCount || totalCount === 0) return null; // no DB data → ML fallback
      console.log("[dashboard] orders from DB:", totalCount, "| fetching in pages of", PAGE);
    }

    if (data.length < PAGE) break;
    offset += PAGE;
  }

  if (all.length === 0) return null;

  // Debug logs
  const gmvSum = all.reduce((s, r) => s + (r.total_amount ?? 0), 0);
  console.log("[dashboard] fetched from DB:", all.length, "/ expected:", totalCount);
  console.log("[dashboard] sum total_amount:", gmvSum);
  console.log("[dashboard] sample order:", JSON.stringify(all[0] ?? null));

  const ltBreakdown: Record<string, number> = {};
  for (const r of all) {
    const lt = r.logistic_type ?? "null";
    ltBreakdown[lt] = (ltBreakdown[lt] ?? 0) + 1;
  }
  const flexCount    = (ltBreakdown["self_service"] ?? 0) + (ltBreakdown["xd_drop_off"] ?? 0);
  const colectaCount = all.length - flexCount;
  console.log("[dashboard] flex orders:", flexCount);
  console.log("[dashboard] colecta orders:", colectaCount);
  console.log("[dashboard] logistic_type breakdown:", ltBreakdown);

  return all;
}

function profitabilityFromDB(rows: DBOrderRow[]): ProfitabilityItem[] {
  const map: Record<string, {
    title: string; categoryId: string;
    unitsSold: number; grossRevenue: number; totalSaleFees: number;
  }> = {};
  for (const r of rows) {
    const id = r.item_id ?? "unknown";
    if (!map[id]) map[id] = {
      title: r.item_title ?? id,
      categoryId: r.category_id ?? "",
      unitsSold: 0, grossRevenue: 0, totalSaleFees: 0,
    };
    map[id].unitsSold += r.quantity ?? 1;
    map[id].grossRevenue += r.total_amount ?? 0;
    map[id].totalSaleFees += r.sale_fee ?? 0;
  }
  return Object.entries(map).map(([itemId, v]) => ({
    itemId,
    title: v.title,
    categoryId: v.categoryId,
    categoryName: v.categoryId,
    unitsSold: v.unitsSold,
    grossRevenue: v.grossRevenue,
    totalSaleFees: v.totalSaleFees,
    shippingCost: 0,
    netRevenue: v.grossRevenue - v.totalSaleFees,
    margin: v.grossRevenue > 0
      ? ((v.grossRevenue - v.totalSaleFees) / v.grossRevenue) * 100 : 0,
  }));
}

function salesStatsFromDB(rows: DBOrderRow[], page: number, limit: number) {
  const gmv = rows.reduce((s, r) => s + (r.total_amount ?? 0), 0);
  const avgTicket = rows.length > 0 ? gmv / rows.length : 0;

  const byDay: Record<string, { revenue: number; orders: number }> = {};
  for (const r of rows) {
    const day = r.date_created.split("T")[0];
    if (!byDay[day]) byDay[day] = { revenue: 0, orders: 0 };
    byDay[day].revenue += r.total_amount ?? 0;
    byDay[day].orders += 1;
  }
  const revenueByDay = Object.entries(byDay)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const itemRev: Record<string, { title: string; sold: number; revenue: number }> = {};
  for (const r of rows) {
    const id = r.item_id ?? "unknown";
    if (!itemRev[id]) itemRev[id] = { title: r.item_title ?? id, sold: 0, revenue: 0 };
    itemRev[id].sold += r.quantity ?? 1;
    itemRev[id].revenue += r.total_amount ?? 0;
  }
  const topItems = Object.entries(itemRev)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return { gmv, orders: rows.length, avgTicket, topItems, revenueByDay, page, limit };
}

// ── Route ─────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
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

  const { searchParams } = request.nextUrl;
  const isOverview = searchParams.get("overview") === "1";
  const section = searchParams.get("section");
  const parsedPage = Number.parseInt(searchParams.get("page") || "1", 10);
  const parsedLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
  const parsedDays = Number.parseInt(searchParams.get("days") || "30", 10);
  const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
  const limit = Number.isFinite(parsedLimit) ? Math.min(50, Math.max(1, parsedLimit)) : 50;
  const days = Number.isFinite(parsedDays) ? Math.max(7, Math.min(90, parsedDays)) : 30;

  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");
  const ordersOptions: number | OrdersOptions =
    dateFrom && dateTo ? { date_from: dateFrom, date_to: dateTo } : days;

  const fromStr = dateFrom ?? new Date(Date.now() - days * 86400_000).toISOString().split("T")[0];
  const toStr   = dateTo   ?? new Date().toISOString().split("T")[0];

  try {
    let data;

    if (isOverview) {
      // ── Try DB: real per-order split by logistic_type ──────────────────
      const rows = await fetchAllOrdersFromDB(fromStr, toStr);

      if (rows) {
        const flexRows    = rows.filter(r => isFlexLogistic(r.logistic_type));
        const colectaRows = rows.filter(r => !isFlexLogistic(r.logistic_type));

        const totalRevenue    = rows.reduce((s, r) => s + (r.total_amount ?? 0), 0);
        const totalSaleFees   = rows.reduce((s, r) => s + (r.sale_fee ?? 0), 0);
        const flexRevenue     = flexRows.reduce((s, r) => s + (r.total_amount ?? 0), 0);
        const colectaRevenue  = colectaRows.reduce((s, r) => s + (r.total_amount ?? 0), 0);
        const flexSaleFees    = flexRows.reduce((s, r) => s + (r.sale_fee ?? 0), 0);
        const colectaSaleFees = colectaRows.reduce((s, r) => s + (r.sale_fee ?? 0), 0);

        // Sum seller_cost for colecta shipments (chunked to stay under Supabase IN limit)
        const colectaIds = colectaRows.map(r => r.id);
        let colectaShippingCost = 0;
        for (let i = 0; i < colectaIds.length; i += 1000) {
          const { data: ships } = await supabaseAdmin
            .from("shipments")
            .select("seller_cost")
            .in("order_id", colectaIds.slice(i, i + 1000));
          for (const s of (ships ?? [])) colectaShippingCost += (s.seller_cost as number) ?? 0;
        }

        console.log("[dashboard/overview] flex:", flexRows.length, "rev:", flexRevenue, "colecta:", colectaRows.length, "rev:", colectaRevenue, "shippingCost:", colectaShippingCost);

        data = {
          ordersTotal: rows.length,
          ordersPrevTotal: 0,
          activeItems: 0,
          pausedItems: 0,
          flexCount: flexRows.length,
          colectaCount: colectaRows.length,
          flexRevenue,
          colectaRevenue,
          colectaShippingCost,
          totalRevenue,
          totalSaleFees,
          flexSaleFees,
          colectaSaleFees,
          source: "db",
        };
      } else {
        // ML fallback
        data = await getDashboardOverview(activeTokens, ordersOptions);
      }

    } else if (section === "profitability") {
      const rows = await fetchAllOrdersFromDB(fromStr, toStr);
      data = rows
        ? { profitabilityByItem: profitabilityFromDB(rows) }
        : await getProfitabilityStats(activeTokens, ordersOptions);

    } else if (section === "sales") {
      const rows = await fetchAllOrdersFromDB(fromStr, toStr);
      data = rows
        ? salesStatsFromDB(rows, page, limit)
        : await getDashboardSalesStats(activeTokens, page, limit, ordersOptions);

    } else if (section === "stock") {
      data = await getDashboardStockStats(activeTokens, page, limit);

    } else {
      data = await getDashboardStats(activeTokens, page, limit);
    }

    const response = NextResponse.json(data);
    if (refreshed) {
      response.cookies.set({ ...SESSION_COOKIE_OPTIONS, value: buildSessionCookieValue(activeTokens) });
    }
    return response;

  } catch (err) {
    console.error("Dashboard API error:", err);
    return NextResponse.json({ error: "ML API error" }, { status: 502 });
  }
}
