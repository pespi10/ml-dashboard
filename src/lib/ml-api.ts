// src/lib/ml-api.ts
// Mercado Libre API client — todas las llamadas pasan por acá

const ML_BASE = "https://api.mercadolibre.com";

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
  currency_id: string;
  order_items: {
    item: { id: string; title: string; category_id: string };
    quantity: number;
    unit_price: number;
  }[];
  buyer: { id: number; nickname: string };
}

export interface MLVisit {
  date_from: string;
  date_to: string;
  total: number;
  visits: { date: string; total: number }[];
}

export interface DashboardStats {
  gmv: number;          // Gross Merchandise Value (período)
  gmvPrev: number;
  orders: number;
  ordersPrev: number;
  activeItems: number;
  pausedItems: number;
  avgTicket: number;
  topItems: { id: string; title: string; sold: number; revenue: number }[];
  revenueByDay: { date: string; revenue: number; orders: number }[];
  stockAlerts: MLItem[];
}

// ── API calls ─────────────────────────────────────────────────────────

/** Listado de publicaciones del vendedor */
export async function getMyItems(tokens: MLTokens): Promise<MLItem[]> {
  const userId = tokens.user_id;
  // Paginamos hasta 200 items
  const items: MLItem[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const data = await mlFetch<{ results: string[]; paging: { total: number } }>(
      `/users/${userId}/items/search?limit=${limit}&offset=${offset}`,
      tokens
    );

    if (!data.results.length) break;

    // Traemos detalles en batch de hasta 20
    const chunks = chunkArray(data.results, 20);
    for (const chunk of chunks) {
      const details = await mlFetch<MLItem[]>(
        `/items?ids=${chunk.join(",")}`,
        tokens
      );
      // La API devuelve { code, body } por item
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

/** Órdenes del período (últimos N días) */
export async function getOrders(
  tokens: MLTokens,
  days = 30
): Promise<MLOrder[]> {
  const userId = tokens.user_id;
  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const orders: MLOrder[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const data = await mlFetch<{
      results: MLOrder[];
      paging: { total: number };
    }>(
      `/orders/search?seller=${userId}&order.date_created.from=${from}&limit=${limit}&offset=${offset}&sort=date_desc`,
      tokens
    );

    orders.push(...data.results);
    offset += limit;
    if (offset >= data.paging.total || data.results.length < limit) break;
  }

  return orders;
}

/** Visitas de un item */
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

/** Stats consolidadas para el dashboard */
export async function getDashboardStats(
  tokens: MLTokens
): Promise<DashboardStats> {
  const [items, orders, ordersPrev] = await Promise.all([
    getMyItems(tokens),
    getOrders(tokens, 30),
    getOrders(tokens, 60),
  ]);

  const prevOrders = ordersPrev.filter((o) => {
    const d = new Date(o.date_created);
    const cutoff = new Date(Date.now() - 30 * 86400_000);
    return d < cutoff;
  });

  const gmv = orders.reduce((s, o) => s + o.total_amount, 0);
  const gmvPrev = prevOrders.reduce((s, o) => s + o.total_amount, 0);

  // Revenue por día (últimos 30)
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

  // Top items por revenue
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

  // Alertas de stock bajo
  const stockAlerts = items
    .filter((i) => i.status === "active" && i.available_quantity <= 3)
    .sort((a, b) => a.available_quantity - b.available_quantity)
    .slice(0, 10);

  return {
    gmv,
    gmvPrev,
    orders: orders.length,
    ordersPrev: prevOrders.length,
    activeItems: items.filter((i) => i.status === "active").length,
    pausedItems: items.filter((i) => i.status === "paused").length,
    avgTicket: orders.length ? gmv / orders.length : 0,
    topItems,
    revenueByDay,
    stockAlerts,
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
