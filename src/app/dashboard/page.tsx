// src/app/dashboard/page.tsx
"use client";

import { useEffect, useState } from "react";
import type { DashboardStats } from "@/lib/ml-api";
import { formatARS, pctChange } from "@/lib/ml-api";
import StatCard from "@/components/ui/StatCard";
import RevenueChart from "@/components/charts/RevenueChart";

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

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchStats = async () => {
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        throw new Error("Error al cargar datos");
      }
      const data = await res.json();
      setStats(data);
      setLastUpdate(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    // Auto-refresh cada 5 minutos
    const interval = setInterval(fetchStats, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div>
        <div style={{ marginBottom: "32px" }}>
          <div className="skeleton" style={{ width: "200px", height: "28px", marginBottom: "8px" }} />
          <div className="skeleton" style={{ width: "140px", height: "16px" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "16px", marginBottom: "24px" }}>
          {[...Array(4)].map((_, i) => (
            <div key={i} className="skeleton" style={{ height: "110px", borderRadius: "12px" }} />
          ))}
        </div>
        <div className="skeleton" style={{ height: "280px", borderRadius: "12px" }} />
      </div>
    );
  }

  if (error) {
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
          onClick={fetchStats}
          style={{
            background: "var(--yellow)", color: "#000",
            border: "none", borderRadius: "var(--radius)",
            padding: "10px 20px",
            fontFamily: "var(--font-display)", fontWeight: "600", fontSize: "13px",
            cursor: "pointer",
          }}
        >
          Reintentar
        </button>
      </div>
    );
  }

  if (!stats) return null;

  const gmvChange = pctChange(stats.gmv, stats.gmvPrev);
  const ordersChange = pctChange(stats.orders, stats.ordersPrev);

  return (
    <div>
      {/* Header */}
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginBottom: "32px",
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
            {lastUpdate ? `Actualizado ${lastUpdate.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}` : "—"}
          </p>
        </div>
        <button
          onClick={fetchStats}
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "8px 16px",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            cursor: "pointer",
          }}
        >
          ↻ Actualizar
        </button>
      </div>

      {/* Stat cards */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: "16px",
        marginBottom: "24px",
      }}>
        <StatCard
          label="GMV 30d"
          value={formatARS(stats.gmv)}
          change={gmvChange}
          subvalue="vs mes anterior"
          accent="yellow"
          delay={0}
        />
        <StatCard
          label="Órdenes 30d"
          value={stats.orders.toString()}
          change={ordersChange}
          subvalue="vs mes anterior"
          accent="green"
          delay={60}
        />
        <StatCard
          label="Ticket promedio"
          value={formatARS(stats.avgTicket)}
          accent="blue"
          delay={120}
        />
        <StatCard
          label="Publicaciones activas"
          value={stats.activeItems.toString()}
          subvalue={`${stats.pausedItems} pausadas`}
          accent="yellow"
          delay={180}
        />
      </div>

      {/* Charts row */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr",
        gap: "16px",
        marginBottom: "24px",
      }}>
        <RevenueChart data={stats.revenueByDay} />
      </div>

      {/* Bottom row: top items + stock alerts */}
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
        }}>
          <h3 style={{
            fontFamily: "var(--font-display)",
            fontSize: "15px", fontWeight: "700",
            marginBottom: "20px",
          }}>Top productos</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {stats.topItems.length === 0 && (
              <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>Sin datos</p>
            )}
            {stats.topItems.map((item, i) => (
              <div key={item.id} style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
              }}>
                <span style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "11px",
                  color: "var(--text-dim)",
                  width: "16px",
                  flexShrink: 0,
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
                  fontSize: "13px",
                  fontFamily: "var(--font-mono)",
                  color: "var(--yellow)",
                  flexShrink: 0,
                }}>{formatARS(item.revenue)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Stock alerts */}
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "24px",
        }}>
          <h3 style={{
            fontFamily: "var(--font-display)",
            fontSize: "15px", fontWeight: "700",
            marginBottom: "20px",
            display: "flex", alignItems: "center", gap: "8px",
          }}>
            {stats.stockAlerts.length > 0 && (
              <span style={{
                background: "var(--red)",
                color: "#fff",
                fontSize: "10px",
                fontWeight: "700",
                padding: "2px 7px",
                borderRadius: "10px",
                fontFamily: "var(--font-mono)",
              }}>{stats.stockAlerts.length}</span>
            )}
            Alertas de stock
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {stats.stockAlerts.length === 0 && (
              <p style={{ fontSize: "13px", color: "var(--green)" }}>✓ Sin alertas</p>
            )}
            {stats.stockAlerts.map((item) => (
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
                  fontFamily: "var(--font-mono)",
                  fontSize: "16px",
                  fontWeight: "800",
                  color: item.available_quantity === 0 ? "var(--red)" : "var(--yellow)",
                  width: "28px",
                  textAlign: "center",
                  flexShrink: 0,
                }}>{item.available_quantity}</span>
                <p style={{
                  fontSize: "12px",
                  color: "var(--text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}>{item.title}</p>
                <span style={{ fontSize: "10px", color: "var(--text-dim)" }}>↗</span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
