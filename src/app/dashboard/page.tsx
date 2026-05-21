// src/app/dashboard/page.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import type {
  DashboardOverview,
  DashboardSalesStats,
  DashboardStockStats,
  ProfitabilityItem,
} from "@/lib/ml-api";
import { formatARS, pctChange } from "@/lib/ml-api";
import RevenueChart from "@/components/charts/RevenueChart";

const COSTO_FLEX = 7_000;

type ShippingData = {
  avgSellerCost: number;
  splitRatio: { ml: number; propia: number };
  pctSellerPays: number;
};

type TaxData = {
  ventasRate: number;
  enviosRate: number;
};

type CostRow = { ml_id: string; costo: number };

function LiveDot() {
  return (
    <span style={{
      width: "7px", height: "7px",
      background: "var(--green)",
      borderRadius: "50%",
      display: "inline-block",
      marginRight: "8px",
      animation: "pulse-dot 2s infinite",
    }} />
  );
}

function Skeleton({ h = 120 }: { h?: number }) {
  return <div className="skeleton" style={{ height: h, borderRadius: "12px" }} />;
}

function Row({
  label,
  value,
  note,
  muted,
  bold,
  color,
}: {
  label: string;
  value: string;
  note?: string;
  muted?: boolean;
  bold?: boolean;
  color?: string;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" }}>
      <span style={{ fontSize: "12px", color: muted ? "var(--text-dim)" : "var(--text-muted)" }}>
        {label}
      </span>
      <span style={{
        fontFamily: "var(--font-mono)",
        fontSize: bold ? "14px" : "12px",
        fontWeight: bold ? 700 : 400,
        color: color ?? "var(--text)",
        display: "flex", alignItems: "center", gap: "5px",
      }}>
        {value}
        {note && (
          <span style={{
            fontSize: "9px",
            background: "rgba(255,200,0,0.12)",
            color: "var(--yellow)",
            border: "1px solid rgba(255,200,0,0.25)",
            padding: "1px 5px",
            borderRadius: "4px",
            fontFamily: "var(--font-sans)",
          }}>{note}</span>
        )}
      </span>
    </div>
  );
}

interface ChannelMetrics {
  label: string;
  badge: string;
  badgeColor: string;
  orders: number;
  revenue: number;
  shipping: number;
  shippingNote?: string;
  commissions: number;
  iibb: number;
  costoProductos: number;
}

function ChannelCard({ metrics, loading }: { metrics: ChannelMetrics | null; loading: boolean }) {
  if (loading || !metrics) return <Skeleton h={290} />;

  const profit = metrics.revenue - metrics.shipping - metrics.commissions - metrics.iibb - metrics.costoProductos;
  const margin = metrics.revenue > 0 ? (profit / metrics.revenue) * 100 : 0;
  const profColor = profit >= 0 ? "var(--green)" : "var(--red)";

  return (
    <div style={{
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)",
      padding: "24px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
        <span style={{
          background: metrics.badgeColor,
          color: "#000",
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          fontWeight: "700",
          padding: "3px 10px",
          borderRadius: "20px",
          letterSpacing: "0.04em",
        }}>{metrics.badge}</span>
        <span style={{ fontFamily: "var(--font-display)", fontSize: "14px", fontWeight: "700" }}>
          {metrics.label}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <Row label="Pedidos" value={metrics.orders.toLocaleString("es-AR")} />
        <Row label="Facturación" value={formatARS(metrics.revenue)} />
        <Row label="Costo envío" value={formatARS(metrics.shipping)} note={metrics.shippingNote} muted />
        <Row label="Costo productos" value={`−${formatARS(metrics.costoProductos)}`} muted />
        <Row label="Comisiones ML" value={`−${formatARS(metrics.commissions)}`} muted />
        <Row label="IIBB estimado" value={`−${formatARS(metrics.iibb)}`} muted />
        <div style={{ height: "1px", background: "var(--border)", margin: "4px 0" }} />
        <Row label="Ganancia estimada" value={formatARS(profit)} bold color={profColor} />
        <Row label="Margen" value={`${margin.toFixed(1)}%`} color={profColor} />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [profItems, setProfItems] = useState<ProfitabilityItem[] | null>(null);
  const [shipping, setShipping] = useState<ShippingData | null>(null);
  const [taxes, setTaxes] = useState<TaxData | null>(null);
  const [salesStats, setSalesStats] = useState<DashboardSalesStats | null>(null);
  const [stockStats, setStockStats] = useState<DashboardStockStats | null>(null);
  const [costsData, setCostsData] = useState<CostRow[] | null>(null);

  const [overviewLoading, setOverviewLoading] = useState(true);
  const [profLoading, setProfLoading] = useState(true);
  const [shippingLoading, setShippingLoading] = useState(true);
  const [taxLoading, setTaxLoading] = useState(true);
  const [costsLoading, setCostsLoading] = useState(true);
  const [chartLoading, setChartLoading] = useState(true);
  const [stockLoading, setStockLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchPeriodData = useCallback(async (d: number) => {
    setOverviewLoading(true);
    setProfLoading(true);
    setError(null);
    try {
      const [ovRes, profRes] = await Promise.all([
        fetch(`/api/dashboard?overview=1&days=${d}`),
        fetch(`/api/dashboard?section=profitability&days=${d}`),
      ]);
      if (ovRes.status === 401 || profRes.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!ovRes.ok) throw new Error("Error al cargar datos");
      const ov: DashboardOverview = await ovRes.json();
      setOverview(ov);
      setLastUpdate(new Date());
      if (profRes.ok) {
        const prof: { profitabilityByItem: ProfitabilityItem[] } = await profRes.json();
        setProfItems(prof.profitabilityByItem);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setOverviewLoading(false);
      setProfLoading(false);
    }
  }, []);

  const fetchStaticData = useCallback(async () => {
    setShippingLoading(true);
    setTaxLoading(true);
    setCostsLoading(true);
    setChartLoading(true);
    setStockLoading(true);
    await Promise.all([
      fetch("/api/shipping")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setShipping(d); setShippingLoading(false); }),
      fetch("/api/billing/taxes")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setTaxes(d); setTaxLoading(false); }),
      fetch("/api/costs")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setCostsData(d); setCostsLoading(false); }),
      fetch("/api/dashboard?section=sales&page=1&limit=50")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setSalesStats(d); setChartLoading(false); }),
      fetch("/api/dashboard?section=stock&page=1&limit=50")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setStockStats(d); setStockLoading(false); }),
    ]);
  }, []);

  useEffect(() => { fetchStaticData(); }, [fetchStaticData]);
  useEffect(() => { fetchPeriodData(days); }, [days, fetchPeriodData]);

  const refresh = () => {
    fetchPeriodData(days);
    fetchStaticData();
  };

  const channelLoading = overviewLoading || profLoading || shippingLoading || taxLoading || costsLoading;

  const metrics = (() => {
    if (!overview || !profItems || !shipping || !taxes || !costsData) return null;

    const costsMap: Record<string, number> = {};
    for (const c of costsData) costsMap[c.ml_id] = c.costo;

    const itemsWithSales = profItems.filter((i) => i.unitsSold > 0);
    const totalWithSales = itemsWithSales.length;
    const withCosto = itemsWithSales.filter((i) => costsMap[i.itemId] !== undefined).length;
    const costoTotalProductos = itemsWithSales.reduce(
      (s, i) => s + (costsMap[i.itemId] ?? 0) * i.unitsSold, 0
    );

    const gmv = profItems.reduce((s, i) => s + i.grossRevenue, 0);
    const commTotal = profItems.reduce((s, i) => s + i.totalSaleFees, 0);
    const orders = overview.ordersTotal;

    const sf = shipping.splitRatio.propia / 100;
    const sm = shipping.splitRatio.ml / 100;

    const ordersFlex = Math.round(orders * sf);
    const revFlex = gmv * sf;
    const shipFlex = ordersFlex * COSTO_FLEX;
    const commFlex = commTotal * sf;
    const iibbFlex = revFlex * (taxes.ventasRate / 100);
    const costoProductosFlex = costoTotalProductos * sf;

    const ordersML = Math.round(orders * sm);
    const revML = gmv * sm;
    const shipML = ordersML * shipping.avgSellerCost * (shipping.pctSellerPays / 100);
    const commML = commTotal * sm;
    const iibbML = revML * ((taxes.ventasRate + taxes.enviosRate) / 100);
    const costoProductosML = costoTotalProductos * sm;

    const totalShip = shipFlex + shipML;
    const totalIibb = iibbFlex + iibbML;
    const profitTotal = gmv - totalShip - commTotal - totalIibb - costoTotalProductos;
    const marginTotal = gmv > 0 ? (profitTotal / gmv) * 100 : 0;

    return {
      flex: {
        label: "Logística Propia",
        badge: "FLEX",
        badgeColor: "var(--green)",
        orders: ordersFlex,
        revenue: revFlex,
        shipping: shipFlex,
        shippingNote: "⚠ estimado",
        commissions: commFlex,
        iibb: iibbFlex,
        costoProductos: costoProductosFlex,
      } as ChannelMetrics,
      ml: {
        label: "Mercado Envíos",
        badge: "ML",
        badgeColor: "var(--yellow)",
        orders: ordersML,
        revenue: revML,
        shipping: shipML,
        commissions: commML,
        iibb: iibbML,
        costoProductos: costoProductosML,
      } as ChannelMetrics,
      totals: { gmv, commTotal, totalShip, totalIibb, costoTotalProductos, withCosto, totalWithSales, profitTotal, marginTotal, orders },
    };
  })();

  if (overviewLoading && !overview) {
    return (
      <div>
        <div style={{ marginBottom: "32px" }}>
          <div className="skeleton" style={{ width: "200px", height: "28px", marginBottom: "8px" }} />
          <div className="skeleton" style={{ width: "160px", height: "16px" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "16px" }}>
          <Skeleton h={290} />
          <Skeleton h={290} />
        </div>
        <Skeleton h={160} />
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div style={{
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        minHeight: "50vh", gap: "16px", textAlign: "center",
      }}>
        <span style={{ fontSize: "32px" }}>⚠</span>
        <p style={{ fontFamily: "var(--font-display)", fontSize: "18px", fontWeight: "700" }}>Error al cargar</p>
        <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>{error}</p>
        <button
          onClick={refresh}
          style={{
            background: "var(--yellow)", color: "#000",
            border: "none", borderRadius: "var(--radius)",
            padding: "10px 20px",
            fontFamily: "var(--font-display)", fontWeight: "600", fontSize: "13px",
            cursor: "pointer",
          }}
        >Reintentar</button>
      </div>
    );
  }

  const ordersChange = overview ? pctChange(overview.ordersTotal, overview.ordersPrevTotal) : null;
  const profitTotal = metrics?.totals.profitTotal ?? 0;
  const profitTotalColor = profitTotal >= 0 ? "var(--green)" : "var(--red)";

  return (
    <div>
      {/* Header */}
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginBottom: "28px",
        flexWrap: "wrap",
        gap: "12px",
      }}>
        <div>
          <h1 style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(22px, 4vw, 28px)",
            fontWeight: "800",
            letterSpacing: "-0.02em",
            marginBottom: "4px",
          }}>Overview</h1>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            <LiveDot />
            {lastUpdate
              ? `Actualizado ${lastUpdate.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`
              : "—"}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {/* Period selector */}
          <div style={{
            display: "flex",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
          }}>
            {([7, 15, 30] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                style={{
                  padding: "6px 14px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "12px",
                  fontWeight: days === d ? 700 : 400,
                  border: "none",
                  borderRight: d !== 30 ? "1px solid var(--border)" : "none",
                  background: days === d ? "var(--yellow)" : "transparent",
                  color: days === d ? "#000" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >{d}d</button>
            ))}
          </div>
          <button
            onClick={refresh}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "6px 14px",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >↻</button>
        </div>
      </div>

      {/* Channel cards */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: "16px",
        marginBottom: "16px",
      }}>
        <ChannelCard metrics={metrics?.flex ?? null} loading={channelLoading} />
        <ChannelCard metrics={metrics?.ml ?? null} loading={channelLoading} />
      </div>

      {/* Totals card */}
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        padding: "24px",
        marginBottom: "24px",
      }}>
        {channelLoading || !metrics ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "12px" }}>
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton" style={{ height: "52px", borderRadius: "8px" }} />
            ))}
          </div>
        ) : (
          <>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: "20px", flexWrap: "wrap", gap: "8px",
            }}>
              <span style={{ fontFamily: "var(--font-display)", fontSize: "14px", fontWeight: "700" }}>
                Totales — últimos {days} días
              </span>
              {ordersChange !== null && (
                <span style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  color: ordersChange >= 0 ? "var(--green)" : "var(--red)",
                  background: ordersChange >= 0 ? "rgba(0,255,136,0.08)" : "rgba(255,68,88,0.08)",
                  padding: "2px 8px",
                  borderRadius: "20px",
                }}>
                  {ordersChange >= 0 ? "+" : ""}{ordersChange.toFixed(1)}% vs período ant.
                </span>
              )}
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              gap: "16px",
            }}>
              {[
                { label: "Pedidos", value: metrics.totals.orders.toLocaleString("es-AR") },
                { label: "GMV", value: formatARS(metrics.totals.gmv) },
                { label: "Costo envíos", value: `−${formatARS(metrics.totals.totalShip)}` },
                { label: "Comisiones", value: `−${formatARS(metrics.totals.commTotal)}` },
                { label: "IIBB estimado", value: `−${formatARS(metrics.totals.totalIibb)}` },
                {
                  label: "Costo productos",
                  value: `−${formatARS(metrics.totals.costoTotalProductos)}`,
                  sub: `Basado en ${metrics.totals.withCosto} de ${metrics.totals.totalWithSales} productos con costo cargado`,
                },
                {
                  label: "Ganancia estimada",
                  value: formatARS(metrics.totals.profitTotal),
                  color: profitTotalColor,
                  sub: `${metrics.totals.marginTotal.toFixed(1)}% margen`,
                },
              ].map((item) => (
                <div key={item.label} style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  padding: "12px 14px",
                }}>
                  <p style={{ fontSize: "11px", color: "var(--text-dim)", marginBottom: "4px" }}>{item.label}</p>
                  <p style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "15px",
                    fontWeight: "700",
                    color: item.color ?? "var(--text)",
                  }}>{item.value}</p>
                  {item.sub && (
                    <p style={{
                      fontSize: "10px",
                      fontFamily: item.color ? "var(--font-mono)" : "var(--font-sans)",
                      color: item.color ?? "var(--text-dim)",
                      marginTop: "2px",
                      lineHeight: "1.4",
                    }}>{item.sub}</p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Revenue chart — lazy */}
      <div style={{ marginBottom: "24px" }}>
        {chartLoading ? (
          <Skeleton h={280} />
        ) : salesStats ? (
          <RevenueChart data={salesStats.revenueByDay} />
        ) : null}
      </div>

      {/* Top productos + Alertas de stock */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
        gap: "16px",
      }}>
        {/* Top items */}
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "24px",
          minHeight: "180px",
        }}>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: "15px", fontWeight: "700", marginBottom: "20px" }}>
            Top productos
          </h3>
          {chartLoading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {[...Array(4)].map((_, i) => (
                <div key={i} className="skeleton" style={{ height: "36px", borderRadius: "6px" }} />
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {!salesStats || salesStats.topItems.length === 0 ? (
                <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>Sin datos</p>
              ) : salesStats.topItems.map((item, i) => (
                <div key={item.id} style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: "11px",
                    color: "var(--text-dim)", width: "16px", flexShrink: 0,
                  }}>0{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{
                      fontSize: "13px", fontWeight: "500",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>{item.title}</p>
                    <p style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                      {item.sold} unid.
                    </p>
                  </div>
                  <span style={{
                    fontSize: "13px", fontFamily: "var(--font-mono)",
                    color: "var(--yellow)", flexShrink: 0,
                  }}>{formatARS(item.revenue)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Stock alerts */}
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "24px",
          minHeight: "180px",
        }}>
          <h3 style={{
            fontFamily: "var(--font-display)",
            fontSize: "15px", fontWeight: "700",
            marginBottom: "20px",
            display: "flex", alignItems: "center", gap: "8px",
          }}>
            {stockStats && stockStats.stockAlerts.length > 0 && (
              <span style={{
                background: "var(--red)", color: "#fff",
                fontSize: "10px", fontWeight: "700",
                padding: "2px 7px", borderRadius: "10px",
                fontFamily: "var(--font-mono)",
              }}>{stockStats.stockAlerts.length}</span>
            )}
            Alertas de stock
          </h3>
          {stockLoading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {[...Array(3)].map((_, i) => (
                <div key={i} className="skeleton" style={{ height: "44px", borderRadius: "6px" }} />
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {!stockStats || stockStats.stockAlerts.length === 0 ? (
                <p style={{ fontSize: "13px", color: "var(--green)" }}>✓ Sin alertas</p>
              ) : stockStats.stockAlerts.map((item) => (
                <a
                  key={item.id}
                  href={item.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "flex", alignItems: "center", gap: "12px",
                    padding: "10px 12px",
                    background: item.available_quantity === 0 ? "var(--red-dim)" : "var(--yellow-dim)",
                    border: `1px solid ${item.available_quantity === 0 ? "rgba(255,68,88,0.2)" : "rgba(255,230,0,0.15)"}`,
                    borderRadius: "var(--radius)",
                    textDecoration: "none",
                  }}
                >
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: "16px", fontWeight: "800",
                    color: item.available_quantity === 0 ? "var(--red)" : "var(--yellow)",
                    width: "28px", textAlign: "center", flexShrink: 0,
                  }}>{item.available_quantity}</span>
                  <p style={{
                    fontSize: "12px", color: "var(--text)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
                  }}>{item.title}</p>
                  <span style={{ fontSize: "10px", color: "var(--text-dim)" }}>↗</span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
