// src/app/dashboard/page.tsx
"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type {
  DashboardSalesStats,
  DashboardStockStats,
  ProfitabilityItem,
} from "@/lib/ml-api";
import { formatARS } from "@/lib/ml-api";

// Extended overview — DB path adds real per-channel data
interface OverviewData {
  ordersTotal: number;
  ordersPrevTotal: number;
  activeItems: number;
  pausedItems: number;
  source?: "db" | "ml";
  // Present when source === "db"
  flexCount?: number;
  colectaCount?: number;
  flexRevenue?: number;
  colectaRevenue?: number;
  colectaShippingCost?: number;
  totalRevenue?: number;
  totalSaleFees?: number;
  flexSaleFees?: number;
  colectaSaleFees?: number;
}
import RevenueChart from "@/components/charts/RevenueChart";
import DateRangePicker, { defaultDateRange } from "@/components/ui/DateRangePicker";

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

// ── Sync modal ───────────────────────────────────────────────────────────

interface SyncLog {
  id: number;
  synced_at: string;
  date_from: string;
  date_to: string;
  orders_count: number;
  shipments_count: number;
  duration_ms: number;
  status: string;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000);
  if (h >= 24) return `hace ${Math.floor(h / 24)}d`;
  if (h > 0) return `hace ${h}h`;
  if (m > 0) return `hace ${m}min`;
  return "hace un momento";
}

function SyncModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const defaults = defaultDateRange();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [step, setStep] = useState("");
  const [result, setResult] = useState<{ orders_synced: number; shipments_synced: number; duration_ms: number } | null>(null);
  const [errMsg, setErrMsg] = useState("");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clear = () => timers.current.forEach(clearTimeout);

  const run = async () => {
    setPhase("running");
    setStep("Sincronizando órdenes…");
    timers.current.push(setTimeout(() => setStep("Sincronizando envíos…"), 8_000));
    timers.current.push(setTimeout(() => setStep("Procesando percepciones IIBB…"), 25_000));
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date_from: from, date_to: to }),
      });
      clear();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResult(data);
      setPhase("done");
      onDone();
    } catch (e) {
      clear();
      setErrMsg(e instanceof Error ? e.message : "Error desconocido");
      setPhase("error");
    }
  };

  const today = new Date().toISOString().split("T")[0];
  const inputStyle: React.CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "5px 10px",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    colorScheme: "dark",
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: "16px",
      }}
    >
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        padding: "28px",
        width: "100%", maxWidth: "420px",
      }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
          <span style={{ fontFamily: "var(--font-display)", fontSize: "16px", fontWeight: "700" }}>
            Sincronizar datos
          </span>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: "var(--text-muted)",
            fontSize: "18px", cursor: "pointer", lineHeight: 1,
          }}>×</button>
        </div>

        {/* Date pickers */}
        <div style={{ marginBottom: "20px" }}>
          <p style={{ fontSize: "11px", color: "var(--text-dim)", marginBottom: "8px", fontFamily: "var(--font-mono)" }}>
            PERÍODO A SINCRONIZAR
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input type="date" value={from} max={to || today} onChange={(e) => e.target.value && setFrom(e.target.value)} style={inputStyle} />
            <span style={{ fontSize: "11px", color: "var(--text-dim)" }}>→</span>
            <input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} style={inputStyle} />
          </div>
        </div>

        {/* Status */}
        {phase === "running" && (
          <div style={{
            padding: "12px 16px", marginBottom: "16px",
            background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)",
            fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--yellow)",
            display: "flex", alignItems: "center", gap: "8px",
          }}>
            <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
            {step}
          </div>
        )}

        {phase === "done" && result && (
          <div style={{
            padding: "12px 16px", marginBottom: "16px",
            background: "rgba(0,255,136,0.06)", border: "1px solid rgba(0,255,136,0.2)", borderRadius: "var(--radius)",
            fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--green)",
          }}>
            ✓ {result.orders_synced.toLocaleString("es-AR")} órdenes · {result.shipments_synced.toLocaleString("es-AR")} envíos
            <span style={{ color: "var(--text-dim)", marginLeft: "8px" }}>
              ({Math.round(result.duration_ms / 1000)}s)
            </span>
          </div>
        )}

        {phase === "error" && (
          <div style={{
            padding: "12px 16px", marginBottom: "16px",
            background: "rgba(255,68,88,0.08)", border: "1px solid rgba(255,68,88,0.25)", borderRadius: "var(--radius)",
            fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--red)",
          }}>
            ✗ {errMsg}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{
            background: "transparent", border: "1px solid var(--border)",
            borderRadius: "var(--radius)", padding: "8px 16px",
            color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "12px", cursor: "pointer",
          }}>Cerrar</button>
          {phase !== "done" && (
            <button
              onClick={run}
              disabled={phase === "running"}
              style={{
                background: phase === "running" ? "var(--border)" : "var(--yellow)",
                color: phase === "running" ? "var(--text-dim)" : "#000",
                border: "none", borderRadius: "var(--radius)",
                padding: "8px 20px",
                fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "12px",
                cursor: phase === "running" ? "not-allowed" : "pointer",
              }}
            >
              {phase === "running" ? "Sincronizando…" : "Sincronizar"}
            </button>
          )}
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default function DashboardPage() {
  const [dateFrom, setDateFrom] = useState(() => defaultDateRange().from);
  const [dateTo, setDateTo] = useState(() => defaultDateRange().to);
  const [overview, setOverview] = useState<OverviewData | null>(null);
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
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [lastSync, setLastSync] = useState<SyncLog | null>(null);

  const fetchPeriodData = useCallback(async (from: string, to: string) => {
    setOverviewLoading(true);
    setProfLoading(true);
    setChartLoading(true);
    setError(null);
    const q = `date_from=${from}&date_to=${to}`;
    try {
      const [ovRes, profRes, chartRes] = await Promise.all([
        fetch(`/api/dashboard?overview=1&${q}`),
        fetch(`/api/dashboard?section=profitability&${q}`),
        fetch(`/api/dashboard?section=sales&page=1&limit=50&${q}`),
      ]);
      if ([ovRes, profRes, chartRes].some((r) => r.status === 401)) {
        window.location.href = "/login";
        return;
      }
      if (!ovRes.ok) throw new Error("Error al cargar datos");
      const ov: OverviewData = await ovRes.json();
      setOverview(ov);
      setLastUpdate(new Date());
      if (profRes.ok) {
        const prof: { profitabilityByItem: ProfitabilityItem[] } = await profRes.json();
        setProfItems(prof.profitabilityByItem);
      }
      if (chartRes.ok) setSalesStats(await chartRes.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setOverviewLoading(false);
      setProfLoading(false);
      setChartLoading(false);
    }
  }, []);

  const fetchStaticData = useCallback(async (from: string, to: string) => {
    setShippingLoading(true);
    setTaxLoading(true);
    setCostsLoading(true);
    setStockLoading(true);
    await Promise.all([
      fetch(`/api/shipping?date_from=${from}&date_to=${to}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setShipping(d); setShippingLoading(false); }),
      fetch("/api/billing/taxes")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setTaxes(d); setTaxLoading(false); }),
      fetch("/api/costs")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setCostsData(d); setCostsLoading(false); }),
      fetch("/api/dashboard?section=stock&page=1&limit=50")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setStockStats(d); setStockLoading(false); }),
    ]);
  }, []);

  useEffect(() => { fetchStaticData(dateFrom, dateTo); }, [fetchStaticData, dateFrom, dateTo]);
  useEffect(() => { fetchPeriodData(dateFrom, dateTo); }, [dateFrom, dateTo, fetchPeriodData]);
  useEffect(() => {
    fetch("/api/sync/status")
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setLastSync(d); })
      .catch(() => {});
  }, []);

  const refresh = () => {
    fetchPeriodData(dateFrom, dateTo);
    fetchStaticData(dateFrom, dateTo);
  };

  const channelLoading = overviewLoading || profLoading || shippingLoading || taxLoading || costsLoading;

  const metrics = (() => {
    if (!overview || !profItems || !taxes || !costsData) return null;
    const hasDB = overview.source === "db" && overview.flexRevenue !== undefined;
    if (!hasDB && !shipping) return null;
    const sh = shipping as ShippingData; // non-null when !hasDB (guarded above)

    // ── Product costs (still per-item from profitability data) ────────────
    const costsMap: Record<string, number> = {};
    for (const c of costsData) costsMap[c.ml_id] = c.costo;

    const itemsWithSales = profItems.filter((i) => i.unitsSold > 0);
    const totalWithSales = itemsWithSales.length;
    const withCosto = itemsWithSales.filter((i) => costsMap[i.itemId] !== undefined).length;
    const costoTotalProductos = itemsWithSales.reduce(
      (s, i) => s + (costsMap[i.itemId] ?? 0) * i.unitsSold, 0
    );

    // ── Channel split: use real DB values when available ──────────────────
    const gmv      = hasDB ? (overview.totalRevenue   ?? 0) : profItems.reduce((s, i) => s + i.grossRevenue,   0);
    const commTotal = hasDB ? (overview.totalSaleFees  ?? 0) : profItems.reduce((s, i) => s + i.totalSaleFees, 0);
    const orders   = overview.ordersTotal;

    const ordersFlex = hasDB ? (overview.flexCount    ?? 0) : Math.round(orders * (sh.splitRatio.propia / 100));
    const ordersML   = hasDB ? (overview.colectaCount ?? 0) : Math.round(orders * (sh.splitRatio.ml    / 100));
    const revFlex    = hasDB ? (overview.flexRevenue    ?? 0) : gmv * (sh.splitRatio.propia / 100);
    const revML      = hasDB ? (overview.colectaRevenue ?? 0) : gmv * (sh.splitRatio.ml    / 100);
    const commFlex   = hasDB ? (overview.flexSaleFees    ?? 0) : commTotal * (ordersFlex / Math.max(orders, 1));
    const commML     = hasDB ? (overview.colectaSaleFees ?? 0) : commTotal * (ordersML   / Math.max(orders, 1));

    // Shipping costs
    const shipFlex = ordersFlex * COSTO_FLEX;
    const shipML   = hasDB
      ? (overview.colectaShippingCost ?? 0)
      : ordersML * sh.avgSellerCost * (sh.pctSellerPays / 100);

    if (!hasDB) {
      console.log('[overview] fallback ratio | pedidosML:', ordersML, 'pctSellerPays:', sh.pctSellerPays, 'avgSellerCost:', sh.avgSellerCost, 'costoEnvioML:', shipML);
    }

    // IIBB — applied on channel revenue
    const iibbFlex = revFlex * (taxes.ventasRate / 100);
    const iibbML   = revML   * ((taxes.ventasRate + taxes.enviosRate) / 100);

    // Product costs — split proportionally to revenue
    const costoProductosFlex = gmv > 0 ? costoTotalProductos * (revFlex / gmv) : 0;
    const costoProductosML   = gmv > 0 ? costoTotalProductos * (revML   / gmv) : 0;

    const totalShip  = shipFlex + shipML;
    const totalIibb  = iibbFlex + iibbML;
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

  const profitTotal = metrics?.totals.profitTotal ?? 0;
  const profitTotalColor = profitTotal >= 0 ? "var(--green)" : "var(--red)";

  return (
    <>
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
          {lastSync && (
            <p style={{ fontSize: "11px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: "2px" }}>
              Última sync: {timeAgo(lastSync.synced_at)} · {lastSync.orders_count.toLocaleString("es-AR")} órdenes
            </p>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <DateRangePicker
            dateFrom={dateFrom}
            dateTo={dateTo}
            onChange={(from, to) => { setDateFrom(from); setDateTo(to); }}
          />
          <button
            onClick={refresh}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "5px 12px",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >↻</button>
          <button
            onClick={() => setSyncModalOpen(true)}
            style={{
              background: "var(--yellow)",
              color: "#000",
              border: "none",
              borderRadius: "var(--radius)",
              padding: "5px 14px",
              fontFamily: "var(--font-display)",
              fontWeight: "700",
              fontSize: "12px",
              cursor: "pointer",
            }}
          >↻ Sincronizar</button>
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
                Totales
              </span>
              <span style={{
                fontFamily: "var(--font-mono)",
                fontSize: "11px",
                color: "var(--text-dim)",
              }}>
                {dateFrom} → {dateTo}
              </span>
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

    {syncModalOpen && (
      <SyncModal
        onClose={() => setSyncModalOpen(false)}
        onDone={() => {
          fetch("/api/sync/status")
            .then((r) => r.ok ? r.json() : null)
            .then((d) => { if (d) setLastSync(d); })
            .catch(() => {});
          fetchPeriodData(dateFrom, dateTo);
          fetchStaticData(dateFrom, dateTo);
        }}
      />
    )}
    </>
  );
}
