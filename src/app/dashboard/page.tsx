// src/app/dashboard/page.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { formatARS } from "@/lib/ml-api";
import RevenueChart from "@/components/charts/RevenueChart";
import DateRangePicker, { defaultDateRange } from "@/components/ui/DateRangePicker";

// ── Constants ─────────────────────────────────────────────────────────

const COSTO_FLEX_POR_PEDIDO = 7_000; // $ por pedido Flex (logística propia)
const IIBB_VENTAS_RATE      = 3.5;   // % sobre revenue ventas
const IIBB_ENVIOS_RATE      = 1.5;   // % sobre revenue colecta (envíos)

// ── Types ─────────────────────────────────────────────────────────────

interface DashboardData {
  source: "db" | "empty";
  message?: string;
  dateFrom: string;
  dateTo: string;
  ordersTotal: number;
  flexCount: number;
  colectaCount: number;
  totalRevenue: number;
  flexRevenue: number;
  colectaRevenue: number;
  totalSaleFees: number;
  flexSaleFees: number;
  colectaSaleFees: number;
  colectaShippingCost: number;
  profitabilityByItem: ProfItem[];
  revenueByDay: { date: string; revenue: number; orders: number }[];
}

interface ProfItem {
  itemId: string;
  itemTitle: string;
  unitsSold: number;
  grossRevenue: number;
  totalSaleFees: number;
  netRevenue: number;
  margin: number;
}

interface CostRow {
  ml_id: string;
  costo: number;
}

interface SyncStatus {
  synced_at: string;
  orders_count: number;
  status: string;
}

// ── Small components ──────────────────────────────────────────────────

function LiveDot() {
  return (
    <span style={{
      display: "inline-block", width: 6, height: 6,
      borderRadius: "50%", background: "var(--green)",
      marginRight: 6, verticalAlign: "middle",
    }} />
  );
}

function Skeleton({ h }: { h: number }) {
  return <div className="skeleton" style={{ height: h, borderRadius: 8 }} />;
}

function StatCard({
  label, value, sub, color,
}: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div style={{
      background: "var(--bg)", border: "1px solid var(--border)",
      borderRadius: 8, padding: "12px 14px",
    }}>
      <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>{label}</p>
      <p style={{
        fontSize: 15, fontWeight: 700,
        fontFamily: "var(--font-mono)",
        color: color ?? "var(--text)",
      }}>{value}</p>
      {sub && (
        <p style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{sub}</p>
      )}
    </div>
  );
}

function ChannelCard({
  title, badge, badgeColor, loading, data,
}: {
  title: string;
  badge: string;
  badgeColor: string;
  loading: boolean;
  data: {
    orders: number;
    revenue: number;
    shipping: number;
    shippingNote?: string;
    commissions: number;
    iibb: number;
    costoProductos: number;
    profit: number;
    margin: number;
  } | null;
}) {
  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)", padding: 24,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
        <span style={{
          background: badgeColor, color: "#000",
          fontFamily: "var(--font-display)", fontWeight: 800,
          fontSize: 11, padding: "2px 8px", borderRadius: 4,
        }}>{badge}</span>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15 }}>
          {title}
        </span>
      </div>

      {loading || !data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[...Array(6)].map((_, i) => <Skeleton key={i} h={20} />)}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            { label: "Pedidos",       value: data.orders.toLocaleString("es-AR") },
            { label: "Facturación",   value: formatARS(data.revenue) },
            {
              label: "Costo envío",
              value: formatARS(data.shipping),
              note: data.shippingNote,
            },
            { label: "Costo productos", value: data.costoProductos > 0 ? `−${formatARS(data.costoProductos)}` : "−" },
            { label: "Comisiones ML",   value: `−${formatARS(data.commissions)}` },
            { label: "IIBB estimado",   value: `−${formatARS(data.iibb)}` },
          ].map(row => (
            <div key={row.label} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              fontSize: 13,
            }}>
              <span style={{ color: "var(--text-muted)" }}>{row.label}</span>
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {row.value}
                {row.note && (
                  <span style={{
                    marginLeft: 6, fontSize: 10,
                    background: "var(--yellow)", color: "#000",
                    borderRadius: 3, padding: "1px 5px",
                  }}>{row.note}</span>
                )}
              </span>
            </div>
          ))}

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Ganancia estimada</span>
              <span style={{
                fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 15,
                color: data.profit >= 0 ? "var(--green)" : "var(--red)",
              }}>{formatARS(data.profit)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Margen</span>
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 12,
                color: data.profit >= 0 ? "var(--green)" : "var(--red)",
              }}>{data.margin.toFixed(1)}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

// ── Main component ────────────────────────────────────────────────────

export default function DashboardPage() {
  const [dateFrom, setDateFrom] = useState(() => defaultDateRange().from);
  const [dateTo,   setDateTo]   = useState(() => defaultDateRange().to);

  const [data,      setData]      = useState<DashboardData | null>(null);
  const [costs,     setCosts]     = useState<CostRow[]>([]);
  const [lastSync,  setLastSync]  = useState<SyncStatus | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  // ── Sync modal state ────────────────────────────────────────────────
  const [syncOpen,   setSyncOpen]  = useState(false);
  const [syncFrom,   setSyncFrom]  = useState(dateFrom);
  const [syncTo,     setSyncTo]    = useState(dateTo);
  const [syncPhase,  setSyncPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [syncResult, setSyncResult] = useState<{ orders_synced: number } | null>(null);

  // ── Fetch dashboard data ────────────────────────────────────────────
  const fetchData = useCallback(async (from: string, to: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard?date_from=${from}&date_to=${to}`);
      if (res.status === 401) { window.location.href = "/login"; return; }
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const json: DashboardData = await res.json();
      setData(json);
      setLastUpdate(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Fetch costs (static, once) ──────────────────────────────────────
  const fetchCosts = useCallback(async () => {
    try {
      const res = await fetch("/api/costs");
      if (res.ok) setCosts(await res.json());
    } catch { /* costs are optional */ }
  }, []);

  // ── Fetch sync status (static, once) ───────────────────────────────
  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/status");
      if (res.ok) setLastSync(await res.json());
    } catch { /* optional */ }
  }, []);

  useEffect(() => { fetchData(dateFrom, dateTo); }, [dateFrom, dateTo, fetchData]);
  useEffect(() => { fetchCosts(); fetchSyncStatus(); }, [fetchCosts, fetchSyncStatus]);

  // ── Compute channel metrics from API data ───────────────────────────
  // All values come directly from the server — no recalculation of split here.
  // The only client-side computations are: IIBB, costo productos, and profit.
  const metrics = (() => {
    if (!data || data.source === "empty") return null;

    // Costs map
    const costsMap: Record<string, number> = {};
    for (const c of costs) costsMap[c.ml_id] = c.costo;

    // Product cost total — from profitability items × cost per unit
    const itemsWithSales = data.profitabilityByItem.filter(i => i.unitsSold > 0);
    const withCosto      = itemsWithSales.filter(i => costsMap[i.itemId] !== undefined).length;
    const costoTotal     = itemsWithSales.reduce(
      (s, i) => s + (costsMap[i.itemId] ?? 0) * i.unitsSold, 0
    );

    const gmv = data.totalRevenue;

    // Shipping
    const shipFlex    = data.flexCount    * COSTO_FLEX_POR_PEDIDO;
    const shipColecta = data.colectaShippingCost; // from DB (0 until enriched)

    // IIBB
    const iibbFlex    = data.flexRevenue    * (IIBB_VENTAS_RATE / 100);
    const iibbColecta = data.colectaRevenue * ((IIBB_VENTAS_RATE + IIBB_ENVIOS_RATE) / 100);

    // Product cost split — proportional to revenue
    const costoFlex    = gmv > 0 ? costoTotal * (data.flexRevenue    / gmv) : 0;
    const costoColecta = gmv > 0 ? costoTotal * (data.colectaRevenue / gmv) : 0;

    // Profit per channel
    const profitFlex = data.flexRevenue
      - shipFlex - data.flexSaleFees - iibbFlex - costoFlex;
    const profitColecta = data.colectaRevenue
      - shipColecta - data.colectaSaleFees - iibbColecta - costoColecta;

    const totalShip   = shipFlex + shipColecta;
    const totalIibb   = iibbFlex + iibbColecta;
    const profitTotal = gmv - totalShip - data.totalSaleFees - totalIibb - costoTotal;
    const marginTotal = gmv > 0 ? (profitTotal / gmv) * 100 : 0;

    return {
      flex: {
        orders:          data.flexCount,
        revenue:         data.flexRevenue,
        shipping:        shipFlex,
        shippingNote:    "estimado",
        commissions:     data.flexSaleFees,
        iibb:            iibbFlex,
        costoProductos:  costoFlex,
        profit:          profitFlex,
        margin:          data.flexRevenue > 0 ? (profitFlex / data.flexRevenue) * 100 : 0,
      },
      colecta: {
        orders:          data.colectaCount,
        revenue:         data.colectaRevenue,
        shipping:        shipColecta,
        commissions:     data.colectaSaleFees,
        iibb:            iibbColecta,
        costoProductos:  costoColecta,
        profit:          profitColecta,
        margin:          data.colectaRevenue > 0 ? (profitColecta / data.colectaRevenue) * 100 : 0,
      },
      totals: {
        orders:          data.ordersTotal,
        gmv,
        totalShip,
        totalSaleFees:   data.totalSaleFees,
        totalIibb,
        costoTotal,
        withCosto,
        totalItems:      itemsWithSales.length,
        profitTotal,
        marginTotal,
      },
    };
  })();

  // ── Sync handler ────────────────────────────────────────────────────
  async function runSync() {
    setSyncPhase("running");
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date_from: syncFrom, date_to: syncTo }),
      });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      const result = await res.json();
      setSyncResult(result);
      setSyncPhase("done");
      fetchData(dateFrom, dateTo);
      fetchSyncStatus();
    } catch (e) {
      console.error(e);
      setSyncPhase("error");
    }
  }

  // ── Render ───────────────────────────────────────────────────────────

  if (error && !data) {
    return (
      <div style={{
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        minHeight: "50vh", gap: 16, textAlign: "center",
      }}>
        <span style={{ fontSize: 32 }}>⚠</span>
        <p style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700 }}>
          Error al cargar
        </p>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>{error}</p>
        <button onClick={() => fetchData(dateFrom, dateTo)} style={{
          background: "var(--yellow)", color: "#000", border: "none",
          borderRadius: "var(--radius)", padding: "10px 20px",
          fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 13, cursor: "pointer",
        }}>Reintentar</button>
      </div>
    );
  }

  return (
    <>
      {/* ── Sync Modal ── */}
      {syncOpen && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
          zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)", padding: 28, width: 380, maxWidth: "90vw",
          }}>
            <h2 style={{
              fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 800, marginBottom: 20,
            }}>Sincronizar órdenes</h2>

            {syncPhase === "idle" && (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
                  <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Desde
                    <input
                      type="date" value={syncFrom}
                      onChange={e => setSyncFrom(e.target.value)}
                      style={{
                        display: "block", width: "100%", marginTop: 4,
                        background: "var(--bg)", border: "1px solid var(--border)",
                        borderRadius: 6, padding: "6px 10px", color: "var(--text)",
                        fontFamily: "var(--font-mono)", fontSize: 13,
                      }}
                    />
                  </label>
                  <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Hasta
                    <input
                      type="date" value={syncTo}
                      onChange={e => setSyncTo(e.target.value)}
                      style={{
                        display: "block", width: "100%", marginTop: 4,
                        background: "var(--bg)", border: "1px solid var(--border)",
                        borderRadius: 6, padding: "6px 10px", color: "var(--text)",
                        fontFamily: "var(--font-mono)", fontSize: 13,
                      }}
                    />
                  </label>
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => setSyncOpen(false)} style={{
                    background: "transparent", border: "1px solid var(--border)",
                    borderRadius: "var(--radius)", padding: "8px 16px",
                    color: "var(--text-muted)", fontSize: 13, cursor: "pointer",
                  }}>Cancelar</button>
                  <button onClick={runSync} style={{
                    background: "var(--yellow)", color: "#000", border: "none",
                    borderRadius: "var(--radius)", padding: "8px 18px",
                    fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, cursor: "pointer",
                  }}>Sincronizar</button>
                </div>
              </>
            )}

            {syncPhase === "running" && (
              <p style={{ fontSize: 13, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                Sincronizando…
              </p>
            )}

            {syncPhase === "done" && (
              <>
                <p style={{ fontSize: 13, color: "var(--green)", fontFamily: "var(--font-mono)", marginBottom: 16 }}>
                  ✓ {syncResult?.orders_synced?.toLocaleString("es-AR")} órdenes sincronizadas
                </p>
                <button onClick={() => { setSyncOpen(false); setSyncPhase("idle"); }} style={{
                  background: "var(--yellow)", color: "#000", border: "none",
                  borderRadius: "var(--radius)", padding: "8px 18px",
                  fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, cursor: "pointer",
                }}>Cerrar</button>
              </>
            )}

            {syncPhase === "error" && (
              <>
                <p style={{ fontSize: 13, color: "var(--red)", marginBottom: 16 }}>
                  Error al sincronizar. Revisá los logs de Vercel.
                </p>
                <button onClick={() => setSyncPhase("idle")} style={{
                  background: "transparent", border: "1px solid var(--border)",
                  borderRadius: "var(--radius)", padding: "8px 16px",
                  color: "var(--text-muted)", fontSize: 13, cursor: "pointer",
                }}>Reintentar</button>
              </>
            )}
          </div>
        </div>
      )}

      <div>
        {/* ── Header ── */}
        <div style={{
          display: "flex", justifyContent: "space-between",
          alignItems: "flex-start", marginBottom: 28,
          flexWrap: "wrap", gap: 12,
        }}>
          <div>
            <h1 style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(22px, 4vw, 28px)",
              fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4,
            }}>Overview</h1>
            <p style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              <LiveDot />
              {lastUpdate
                ? `Actualizado ${lastUpdate.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`
                : "—"}
            </p>
            {lastSync && (
              <p style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                Última sync: {timeAgo(lastSync.synced_at)} · {lastSync.orders_count.toLocaleString("es-AR")} órdenes
              </p>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <DateRangePicker
              dateFrom={dateFrom}
              dateTo={dateTo}
              onChange={(from, to) => { setDateFrom(from); setDateTo(to); }}
            />
            <button
              onClick={() => fetchData(dateFrom, dateTo)}
              style={{
                background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: "var(--radius)", padding: "5px 12px",
                color: "var(--text-muted)", fontFamily: "var(--font-mono)",
                fontSize: 12, cursor: "pointer",
              }}
            >↻</button>
            <button
              onClick={() => { setSyncFrom(dateFrom); setSyncTo(dateTo); setSyncOpen(true); }}
              style={{
                background: "var(--yellow)", color: "#000", border: "none",
                borderRadius: "var(--radius)", padding: "5px 14px",
                fontFamily: "var(--font-display)", fontWeight: 700,
                fontSize: 12, cursor: "pointer",
              }}
            >↻ Sincronizar</button>
          </div>
        </div>

        {/* ── No data banner ── */}
        {!loading && data?.source === "empty" && (
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)", padding: 24,
            textAlign: "center", marginBottom: 24,
          }}>
            <p style={{ fontSize: 14, color: "var(--text-muted)", marginBottom: 12 }}>
              No hay datos para este período.
            </p>
            <button
              onClick={() => { setSyncFrom(dateFrom); setSyncTo(dateTo); setSyncOpen(true); }}
              style={{
                background: "var(--yellow)", color: "#000", border: "none",
                borderRadius: "var(--radius)", padding: "8px 18px",
                fontFamily: "var(--font-display)", fontWeight: 700,
                fontSize: 13, cursor: "pointer",
              }}
            >Sincronizar este período</button>
          </div>
        )}

        {/* ── Channel cards ── */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16, marginBottom: 16,
        }}>
          <ChannelCard
            title="Logística Propia"
            badge="FLEX"
            badgeColor="var(--green)"
            loading={loading}
            data={metrics?.flex ?? null}
          />
          <ChannelCard
            title="Mercado Envíos"
            badge="ML"
            badgeColor="var(--yellow)"
            loading={loading}
            data={metrics?.colecta ?? null}
          />
        </div>

        {/* ── Totals ── */}
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)", padding: 24, marginBottom: 24,
        }}>
          {loading || !metrics ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
              {[...Array(6)].map((_, i) => <Skeleton key={i} h={52} />)}
            </div>
          ) : (
            <>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                marginBottom: 20, flexWrap: "wrap", gap: 8,
              }}>
                <span style={{ fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 700 }}>
                  Totales
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
                  {dateFrom} → {dateTo}
                </span>
              </div>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
                gap: 16,
              }}>
                <StatCard label="Pedidos"        value={metrics.totals.orders.toLocaleString("es-AR")} />
                <StatCard label="GMV"            value={formatARS(metrics.totals.gmv)} />
                <StatCard label="Costo envíos"   value={`−${formatARS(metrics.totals.totalShip)}`} />
                <StatCard label="Comisiones"     value={`−${formatARS(metrics.totals.totalSaleFees)}`} />
                <StatCard label="IIBB estimado"  value={`−${formatARS(metrics.totals.totalIibb)}`} />
                <StatCard
                  label="Costo productos"
                  value={metrics.totals.costoTotal > 0 ? `−${formatARS(metrics.totals.costoTotal)}` : "Sin costos"}
                  sub={`${metrics.totals.withCosto} de ${metrics.totals.totalItems} productos con costo`}
                />
                <StatCard
                  label="Ganancia estimada"
                  value={formatARS(metrics.totals.profitTotal)}
                  sub={`${metrics.totals.marginTotal.toFixed(1)}% margen`}
                  color={metrics.totals.profitTotal >= 0 ? "var(--green)" : "var(--red)"}
                />
              </div>
            </>
          )}
        </div>

        {/* ── Revenue chart ── */}
        {!loading && data && data.revenueByDay.length > 0 && (
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)", padding: 24,
          }}>
            <p style={{
              fontFamily: "var(--font-display)", fontSize: 14,
              fontWeight: 700, marginBottom: 16,
            }}>Revenue diario</p>
            <RevenueChart data={data.revenueByDay} />
          </div>
        )}
      </div>
    </>
  );
}
