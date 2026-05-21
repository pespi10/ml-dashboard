const ML_BASE = "https://api.mercadolibre.com";

export const SHIPPING_COST_PER_ORDER = 0;
// Costo fijo de envío por pedido — actualizar cuando se tenga el dato real

export interface MLTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // timestamp ms
  user_id: number;
}

// ── Token management ─────────────────────────────────────────────────

export async function refreshAccessToken(tokens: MLTokens): Promise<MLTokens> {
  const res = await fetch(`${ML_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ML_CLIENT_ID!,
      client_secret: process.env.ML_CLIENT_SECRET!,
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) throw new Error("Failed to refresh ML token");
  const data = await res.json();

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    user_id: tokens.user_id,
  };
}

export function isTokenExpired(tokens: MLTokens): boolean {
  return Date.now() >= tokens.expires_at - 60_000; // 1 min buffer
}

// ── Authenticated fetch ───────────────────────────────────────────────

async function mlFetch<T>(
  path: string,
  tokens: MLTokens,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${ML_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `ML API error: ${res.status}`);
  }

  return res.json();
}

// ── Types ─────────────────────────────────────────────────────────────

export interface MLItem {
  id: string;
  title: string;
  price: number;
  original_price: number | null;
  currency_id: string;
  available_quantity: number;
  sold_quantity: number;
  thumbnail: string;
  permalink: string;
  status: "active" | "paused" | "closed" | "under_review";
  category_id: string;
  condition: "new" | "used";
  listing_type_id: string;
  health?: number;
}

export interface MLOrder {
  id: number;
  date_created: string;
  date_closed: string;
  status: string;
  total_amount: number;
  paid_amount: number;
  currency_id: string;
  order_items: {
    item: { id: string; title: string; category_id: string; seller_sku?: string | null };
    quantity: number;
    unit_price: number;
    sale_fee: number;
    gross_price: number;
    manufacturing_fee?: number;
  }[];
  buyer: { id: number; nickname: string };
  taxes?: unknown;
  fee_details?: unknown;
  shipping?: { id?: number; status?: string } | null;
}

export interface MLVisit {
  date_from: string;
  date_to: string;
  total: number;
  visits: { date: string; total: number }[];
}

export interface ProfitabilityItem {
  itemId: string;
  title: string;
  categoryId: string;
  categoryName: string;
  unitsSold: number;
  grossRevenue: number;
  totalSaleFees: number;
  shippingCost: number;
  netRevenue: number;
  margin: number;
}

export interface ProfitabilityCategory {
  categoryId: string;
  categoryName: string;
  unitsSold: number;
  grossRevenue: number;
  totalSaleFees: number;
  shippingCost: number;
  netRevenue: number;
  margin: number;
}

export interface DashboardStats {
  gmv: number;
  gmvPrev: number;
  orders: number;
  ordersPrev: number;
  activeItems: number;
  pausedItems: number;
  avgTicket: number;
  topItems: { id: string; title: string; sold: number; revenue: number }[];
  revenueByDay: { date: string; revenue: number; orders: number }[];
  stockAlerts: MLItem[];
  profitabilityByItem: ProfitabilityItem[];
  profitabilityByCategory: ProfitabilityCategory[];
  eanToMlaMap: Record<string, string>;
}

export interface DashboardOverview {
  ordersTotal: number;
  ordersPrevTotal: number;
  activeItems: number;
  pausedItems: number;
}

export interface DashboardSalesStats {
  gmv: number;
  orders: number;
  avgTicket: number;
  topItems: { id: string; title: string; sold: number; revenue: number }[];
  revenueByDay: { date: string; revenue: number; orders: number }[];
  page: number;
  limit: number;
}

export interface DashboardStockStats {
  stockAlerts: MLItem[];
  total: number;
  page: number;
  limit: number;
}

// ── API calls ─────────────────────────────────────────────────────────

export async function getMyItems(tokens: MLTokens): Promise<MLItem[]> {
  const userId = tokens.user_id;
  const items: MLItem[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const data = await mlFetch<{ results: string[]; paging: { total: number } }>(
      `/users/${userId}/items/search?limit=${limit}&offset=${offset}`,
      tokens
    );

    if (!data.results.length) break;

    const chunks = chunkArray(data.results, 20);
    for (const chunk of chunks) {
      const details = await mlFetch<MLItem[]>(
        `/items?ids=${chunk.join(",")}`,
        tokens
      );
      const bodyItems = (details as unknown as { code: number; body: MLItem }[])
        .filter((r) => r.code === 200)
        .map((r) => r.body);
      items.push(...bodyItems);
    }

    offset += limit;
    if (offset >= data.paging.total) break;
  }

  return items;
}

export async function getAllItemsByStatus(
  tokens: MLTokens,
  status: MLItem["status"],
  maxItems = Infinity
): Promise<{ results: MLItem[]; total: number }> {
  const userId = tokens.user_id;
  const items: MLItem[] = [];
  let offset = 0;
  const pageSize = 50;
  let total = 0;

  while (items.length < maxItems) {
    const data = await mlFetch<{ results: string[]; paging: { total: number } }>(
      `/users/${userId}/items/search?status=${status}&limit=${pageSize}&offset=${offset}`,
      tokens
    );
    total = data.paging.total;
    if (!data.results.length) break;

    const idsToFetch = data.results.slice(0, maxItems - items.length);
    const detailPages = await Promise.all(
      chunkArray(idsToFetch, 20).map((chunk) =>
        mlFetch<MLItem[]>(`/items?ids=${chunk.join(",")}`, tokens)
      )
    );
    const batch = detailPages
      .flatMap((d) => d as unknown as { code: number; body: MLItem }[])
      .filter((r) => r.code === 200)
      .map((r) => r.body);
    items.push(...batch);

    offset += pageSize;
    if (offset >= total || data.results.length < pageSize) break;
  }

  return { results: items, total };
}

export async function getMyItemsPage(
  tokens: MLTokens,
  page: number,
  limit: number,
  status?: MLItem["status"]
): Promise<{ results: MLItem[]; total: number; page: number; limit: number }> {
  const userId = tokens.user_id;
  const offset = (page - 1) * limit;
  const statusParam = status ? `&status=${status}` : "";
  const data = await mlFetch<{ results: string[]; paging: { total: number } }>(
    `/users/${userId}/items/search?limit=${limit}&offset=${offset}${statusParam}`,
    tokens
  );

  if (!data.results.length) {
    return { results: [], total: data.paging.total, page, limit };
  }

  const detailPages = await Promise.all(
    chunkArray(data.results, 20).map((chunk) =>
      mlFetch<MLItem[]>(`/items?ids=${chunk.join(",")}`, tokens)
    )
  );
  const results = detailPages
    .flatMap((details) => details as unknown as { code: number; body: MLItem }[])
    .filter((r) => r.code === 200)
    .map((r) => r.body);

  return { results, total: data.paging.total, page, limit };
}

export async function getOrders(
  tokens: MLTokens,
  days = 30
): Promise<MLOrder[]> {
  const userId = tokens.user_id;
  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const orders: MLOrder[] = [];
  let offset = 0;
  const limit = 50;
  let loggedFirst = false;

  while (true) {
    const data = await mlFetch<{
      results: MLOrder[];
      paging: { total: number };
    }>(
      `/orders/search?seller=${userId}&order.date_created.from=${from}&limit=${limit}&offset=${offset}&sort=date_desc`,
      tokens
    );

    if (!loggedFirst && data.results.length > 0) {
      console.log("[getOrders] first order full payload:", JSON.stringify(data.results[0], null, 2));
      loggedFirst = true;
    }

    orders.push(...data.results);
    offset += limit;
    if (offset >= data.paging.total || data.results.length < limit) break;
  }

  return orders;
}

export async function getOrdersPage(
  tokens: MLTokens,
  page: number,
  limit: number,
  days = 30
): Promise<{ results: MLOrder[]; total: number; page: number; limit: number }> {
  const userId = tokens.user_id;
  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const offset = (page - 1) * limit;
  const data = await mlFetch<{ results: MLOrder[]; paging: { total: number } }>(
    `/orders/search?seller=${userId}&order.date_created.from=${from}&limit=${limit}&offset=${offset}&sort=date_desc`,
    tokens
  );
  if (page === 1 && data.results.length > 0) {
    console.log("[getOrdersPage] first order full payload:", JSON.stringify(data.results[0], null, 2));
  }
  return { results: data.results, total: data.paging.total, page, limit };
}

async function getOrdersTotal(tokens: MLTokens, days: number): Promise<number> {
  const userId = tokens.user_id;
  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const data = await mlFetch<{ results: MLOrder[]; paging: { total: number } }>(
    `/orders/search?seller=${userId}&order.date_created.from=${from}&limit=1&offset=0&sort=date_desc`,
    tokens
  );
  return data.paging.total;
}

async function getItemsTotalByStatus(
  tokens: MLTokens,
  status: MLItem["status"]
): Promise<number> {
  const userId = tokens.user_id;
  const data = await mlFetch<{ results: string[]; paging: { total: number } }>(
    `/users/${userId}/items/search?status=${status}&limit=1&offset=0`,
    tokens
  );
  return data.paging.total;
}

export async function getItemVisits(
  tokens: MLTokens,
  itemId: string,
  days = 30
): Promise<MLVisit> {
  const from = new Date(Date.now() - days * 86400_000)
    .toISOString()
    .split("T")[0];
  const to = new Date().toISOString().split("T")[0];

  return mlFetch<MLVisit>(
    `/visits/items?ids=${itemId}&date_from=${from}&date_to=${to}`,
    tokens
  );
}

// ── Profitability ─────────────────────────────────────────────────────

export function getProfitabilityByItem(orders: MLOrder[]): ProfitabilityItem[] {
  const map: Record<string, Omit<ProfitabilityItem, "margin"> & { orderIds: Set<number> }> = {};

  for (const order of orders) {
    for (const oi of order.order_items) {
      const id = oi.item.id;
      if (!map[id]) {
        map[id] = {
          itemId: id,
          title: oi.item.title,
          categoryId: oi.item.category_id,
          categoryName: oi.item.category_id,
          unitsSold: 0,
          grossRevenue: 0,
          totalSaleFees: 0,
          shippingCost: 0,
          netRevenue: 0,
          orderIds: new Set(),
        };
      }
      map[id].unitsSold += oi.quantity;
      map[id].grossRevenue += oi.unit_price * oi.quantity;
      map[id].totalSaleFees += oi.sale_fee ?? 0;
      map[id].orderIds.add(order.id);
    }
  }

  // totalSaleFees comes from real sale_fee on each order_item — no estimated percentage
  return Object.values(map).map(({ orderIds: _, ...item }) => {
    const netRevenue = item.grossRevenue - item.totalSaleFees;
    const margin = item.grossRevenue > 0 ? (netRevenue / item.grossRevenue) * 100 : 0;
    return { ...item, categoryName: item.categoryId, shippingCost: 0, netRevenue, margin };
  });
}

export function getProfitabilityByCategory(orders: MLOrder[]): ProfitabilityCategory[] {
  const items = getProfitabilityByItem(orders);
  const map: Record<string, Omit<ProfitabilityCategory, "margin">> = {};

  for (const item of items) {
    const cat = item.categoryId;
    if (!map[cat]) {
      map[cat] = {
        categoryId: cat,
        categoryName: cat,
        unitsSold: 0,
        grossRevenue: 0,
        totalSaleFees: 0,
        shippingCost: 0,
        netRevenue: 0,
      };
    }
    map[cat].unitsSold += item.unitsSold;
    map[cat].grossRevenue += item.grossRevenue;
    map[cat].totalSaleFees += item.totalSaleFees;
    map[cat].shippingCost += item.shippingCost;
    map[cat].netRevenue += item.netRevenue;
  }

  return Object.values(map).map((cat) => ({
    ...cat,
    margin: cat.grossRevenue > 0 ? (cat.netRevenue / cat.grossRevenue) * 100 : 0,
  }));
}

// ── Category name resolution ──────────────────────────────────────────

async function getCategoryName(categoryId: string, tokens: MLTokens): Promise<string> {
  try {
    const data = await mlFetch<{ name: string }>(`/categories/${categoryId}`, tokens);
    return data.name;
  } catch {
    return categoryId;
  }
}

// ── Full profitability (all orders in window) ─────────────────────────

export async function getProfitabilityStats(
  tokens: MLTokens,
  days = 30
): Promise<{ profitabilityByItem: ProfitabilityItem[] }> {
  const orders = await getOrders(tokens, days);
  const profByItem = getProfitabilityByItem(orders);

  const catIds = Array.from(new Set(profByItem.map((i) => i.categoryId)));
  const resolvedNames = await Promise.all(
    catIds.map((id) => getCategoryName(id, tokens))
  );
  const catNameMap = Object.fromEntries(catIds.map((id, i) => [id, resolvedNames[i]]));

  return {
    profitabilityByItem: profByItem.map((i) => ({
      ...i,
      categoryName: catNameMap[i.categoryId] ?? i.categoryId,
    })),
  };
}

// ── Dashboard stats ───────────────────────────────────────────────────

export async function getDashboardOverview(tokens: MLTokens, days = 30): Promise<DashboardOverview> {
  const [ordersTotal, ordersDblTotal, activeItems, pausedItems] = await Promise.all([
    getOrdersTotal(tokens, days),
    getOrdersTotal(tokens, days * 2),
    getItemsTotalByStatus(tokens, "active"),
    getItemsTotalByStatus(tokens, "paused"),
  ]);

  return {
    ordersTotal,
    ordersPrevTotal: Math.max(0, ordersDblTotal - ordersTotal),
    activeItems,
    pausedItems,
  };
}

export async function getDashboardSalesStats(
  tokens: MLTokens,
  page = 1,
  limit = 50
): Promise<DashboardSalesStats> {
  const { results: orders, total: ordersTotal } = await getOrdersPage(tokens, page, limit, 30);
  const gmv = orders.reduce((s, o) => s + o.total_amount, 0);
  const avgTicket = orders.length > 0 ? gmv / orders.length : 0;

  const byDay: Record<string, { revenue: number; orders: number }> = {};
  orders.forEach((o) => {
    const day = o.date_created.split("T")[0];
    if (!byDay[day]) byDay[day] = { revenue: 0, orders: 0 };
    byDay[day].revenue += o.total_amount;
    byDay[day].orders += 1;
  });
  const revenueByDay = Object.entries(byDay)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const itemRevenue: Record<string, { title: string; sold: number; revenue: number }> = {};
  orders.forEach((o) => {
    o.order_items.forEach((oi) => {
      const id = oi.item.id;
      if (!itemRevenue[id])
        itemRevenue[id] = { title: oi.item.title, sold: 0, revenue: 0 };
      itemRevenue[id].sold += oi.quantity;
      itemRevenue[id].revenue += oi.unit_price * oi.quantity;
    });
  });
  const topItems = Object.entries(itemRevenue)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return {
    gmv,
    orders: ordersTotal,
    avgTicket,
    topItems,
    revenueByDay,
    page,
    limit,
  };
}

export async function getDashboardStockStats(
  tokens: MLTokens,
  page = 1,
  limit = 50
): Promise<DashboardStockStats> {
  const itemsPage = await getMyItemsPage(tokens, page, limit, "active");
  const stockAlerts = itemsPage.results
    .filter((i) => i.available_quantity <= 3)
    .sort((a, b) => a.available_quantity - b.available_quantity)
    .slice(0, 10);

  return {
    stockAlerts,
    total: itemsPage.total,
    page,
    limit,
  };
}

export async function getDashboardStats(
  tokens: MLTokens,
  page = 1,
  limit = 50
): Promise<DashboardStats> {
  const [overview, stockStats, { results: orders, total: ordersTotal }] = await Promise.all([
    getDashboardOverview(tokens),
    getDashboardStockStats(tokens, 1, limit),
    getOrdersPage(tokens, page, limit, 30),
  ]);

  const gmv = orders.reduce((s, o) => s + o.total_amount, 0);
  const avgTicket = orders.length > 0 ? gmv / orders.length : 0;

  const byDay: Record<string, { revenue: number; orders: number }> = {};
  orders.forEach((o) => {
    const day = o.date_created.split("T")[0];
    if (!byDay[day]) byDay[day] = { revenue: 0, orders: 0 };
    byDay[day].revenue += o.total_amount;
    byDay[day].orders += 1;
  });
  const revenueByDay = Object.entries(byDay)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const itemRevenue: Record<string, { title: string; sold: number; revenue: number }> = {};
  orders.forEach((o) => {
    o.order_items.forEach((oi) => {
      const id = oi.item.id;
      if (!itemRevenue[id])
        itemRevenue[id] = { title: oi.item.title, sold: 0, revenue: 0 };
      itemRevenue[id].sold += oi.quantity;
      itemRevenue[id].revenue += oi.unit_price * oi.quantity;
    });
  });
  const topItems = Object.entries(itemRevenue)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const eanToMlaMap: Record<string, string> = {};
  orders.forEach((order) => {
    order.order_items.forEach((oi) => {
      if (oi.item.seller_sku && oi.item.id) {
        eanToMlaMap[oi.item.seller_sku] = oi.item.id;
      }
    });
  });

  const profByItem = getProfitabilityByItem(orders);
  const profByCategory = getProfitabilityByCategory(orders);

  const catIdSet: Record<string, true> = {};
  profByItem.forEach((i) => { catIdSet[i.categoryId] = true; });
  const uniqueCatIds = Object.keys(catIdSet);
  const resolvedNames = await Promise.all(
    uniqueCatIds.map((id) => getCategoryName(id, tokens))
  );
  const catNameMap: Record<string, string> = Object.fromEntries(
    uniqueCatIds.map((id, idx) => [id, resolvedNames[idx]])
  );

  return {
    gmv,
    gmvPrev: 0,
    orders: ordersTotal,
    ordersPrev: overview.ordersPrevTotal,
    activeItems: overview.activeItems,
    pausedItems: overview.pausedItems,
    avgTicket,
    topItems,
    revenueByDay,
    stockAlerts: stockStats.stockAlerts,
    profitabilityByItem: profByItem.map((i) => ({
      ...i,
      categoryName: catNameMap[i.categoryId] ?? i.categoryId,
    })),
    profitabilityByCategory: profByCategory.map((c) => ({
      ...c,
      categoryName: catNameMap[c.categoryId] ?? c.categoryId,
    })),
    eanToMlaMap,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

export function formatARS(amount: number): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function pctChange(current: number, prev: number): number {
  if (!prev) return 0;
  return ((current - prev) / prev) * 100;
}
