// src/app/dashboard/productos/page.tsx
"use client";

import { useEffect, useState } from "react";
import type { MLItem } from "@/lib/ml-api";
import { formatARS } from "@/lib/ml-api";

const STATUS_LABEL: Record<string, string> = {
  active: "Activa",
  paused: "Pausada",
  closed: "Cerrada",
  under_review: "En revisión",
};

const STATUS_COLOR: Record<string, string> = {
  active: "var(--green)",
  paused: "var(--yellow)",
  closed: "var(--text-dim)",
  under_review: "var(--blue)",
};

export default function ProductosPage() {
  const [items, setItems] = useState<MLItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "active" | "paused" | "closed">("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/products")
      .then((r) => r.json())
      .then(setItems)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filtered = items.filter((i) => {
    const matchStatus = filter === "all" || i.status === filter;
    const matchSearch = !search || i.title.toLowerCase().includes(search.toLowerCase());
    return matchStatus && matchSearch;
  });

  const counts = {
    all: items.length,
    active: items.filter((i) => i.status === "active").length,
    paused: items.filter((i) => i.status === "paused").length,
    closed: items.filter((i) => i.status === "closed").length,
  };

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: "28px" }}>
        <h1 style={{
          fontFamily: "var(--font-display)", fontSize: "clamp(22px, 4vw, 28px)",
          fontWeight: "800", letterSpacing: "-0.02em", marginBottom: "4px",
        }}>Productos</h1>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {items.length} publicaciones totales
        </p>
      </div>

      {/* Filters */}
      <div style={{
        display: "flex", gap: "8px", flexWrap: "wrap",
        marginBottom: "20px", alignItems: "center",
      }}>
        {(["all", "active", "paused", "closed"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} style={{
            background: filter === f ? "var(--yellow-dim)" : "var(--surface)",
            border: `1px solid ${filter === f ? "rgba(255,230,0,0.25)" : "var(--border)"}`,
            color: filter === f ? "var(--yellow)" : "var(--text-muted)",
            borderRadius: "20px",
            padding: "6px 14px",
            fontSize: "12px",
            fontFamily: "var(--font-display)",
            fontWeight: "600",
            cursor: "pointer",
          }}>
            {f === "all" ? "Todas" : STATUS_LABEL[f]} · {counts[f]}
          </button>
        ))}

        <input
          type="text"
          placeholder="Buscar publicación..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            marginLeft: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "8px 14px",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            outline: "none",
            width: "220px",
          }}
        />
      </div>

      {/* Table */}
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}>
        {/* Table header — hidden on mobile */}
        <div className="table-header" style={{
          display: "grid",
          gridTemplateColumns: "1fr 100px 80px 80px 100px",
          gap: "16px",
          padding: "12px 20px",
          borderBottom: "1px solid var(--border)",
          fontSize: "10px",
          fontWeight: "600",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
        }}>
          <span>Publicación</span>
          <span>Precio</span>
          <span>Stock</span>
          <span>Vendidos</span>
          <span>Estado</span>
        </div>

        {loading && (
          <div style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "12px" }}>
            {[...Array(5)].map((_, i) => (
              <div key={i} className="skeleton" style={{ height: "52px", borderRadius: "8px" }} />
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div style={{ padding: "48px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
            Sin resultados
          </div>
        )}

        {!loading && filtered.map((item, i) => (
          <a
            key={item.id}
            href={item.permalink}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 100px 80px 80px 100px",
              gap: "16px",
              padding: "14px 20px",
              borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none",
              textDecoration: "none",
              alignItems: "center",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <div style={{ minWidth: 0 }}>
              <p style={{
                fontSize: "13px", color: "var(--text)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                marginBottom: "2px",
              }}>{item.title}</p>
              <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                {item.id}
              </p>
            </div>
            <span style={{ fontSize: "13px", fontFamily: "var(--font-mono)", color: "var(--text)" }}>
              {formatARS(item.price)}
            </span>
            <span style={{
              fontSize: "14px",
              fontFamily: "var(--font-mono)",
              fontWeight: "700",
              color: item.available_quantity === 0
                ? "var(--red)"
                : item.available_quantity <= 3
                ? "var(--yellow)"
                : "var(--text)",
            }}>
              {item.available_quantity}
            </span>
            <span style={{ fontSize: "13px", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
              {item.sold_quantity}
            </span>
            <span style={{
              fontSize: "11px",
              fontWeight: "600",
              fontFamily: "var(--font-display)",
              color: STATUS_COLOR[item.status] || "var(--text-dim)",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}>
              <span style={{
                width: "6px", height: "6px", borderRadius: "50%",
                background: STATUS_COLOR[item.status] || "var(--text-dim)",
                flexShrink: 0,
              }} />
              {STATUS_LABEL[item.status] || item.status}
            </span>
          </a>
        ))}
      </div>

      <style>{`
        @media (max-width: 640px) {
          .table-header { display: none !important; }
          a[href] { grid-template-columns: 1fr auto !important; }
        }
      `}</style>
    </div>
  );
}
