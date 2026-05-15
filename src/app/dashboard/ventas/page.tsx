// src/app/dashboard/ventas/page.tsx
"use client";

import { useEffect, useState } from "react";
import { formatARS } from "@/lib/ml-api";

interface Order {
  id: number;
  date_created: string;
  status: string;
  total_amount: number;
  currency_id: string;
  order_items: {
    item: { id: string; title: string };
    quantity: number;
    unit_price: number;
  }[];
  buyer: { id: number; nickname: string };
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  paid: { label: "Pagado", color: "var(--green)" },
  pending: { label: "Pendiente", color: "var(--yellow)" },
  cancelled: { label: "Cancelado", color: "var(--red)" },
  shipped: { label: "Enviado", color: "var(--blue)" },
  delivered: { label: "Entregado", color: "var(--green)" },
};

export default function VentasPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/sales")
      .then((r) => r.json())
      .then(setOrders)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const totalGMV = orders.reduce((s, o) => s + o.total_amount, 0);

  return (
    <div>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "flex-end", marginBottom: "28px", flexWrap: "wrap", gap: "12px",
      }}>
        <div>
          <h1 style={{
            fontFamily: "var(--font-display)", fontSize: "clamp(22px, 4vw, 28px)",
            fontWeight: "800", letterSpacing: "-0.02em", marginBottom: "4px",
          }}>Ventas</h1>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            Últimos 30 días · {orders.length} órdenes
          </p>
        </div>
        <div style={{
          background: "var(--yellow-dim)",
          border: "1px solid rgba(255,230,0,0.2)",
          borderRadius: "var(--radius)",
          padding: "10px 20px",
          textAlign: "right",
        }}>
          <p style={{ fontSize: "10px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: "2px" }}>
            GMV TOTAL
          </p>
          <p style={{
            fontFamily: "var(--font-display)", fontSize: "22px",
            fontWeight: "800", color: "var(--yellow)",
          }}>{formatARS(totalGMV)}</p>
        </div>
      </div>

      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div className="sales-header" style={{
          display: "grid",
          gridTemplateColumns: "80px 1fr 140px 100px 100px",
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
          <span>ID</span>
          <span>Producto</span>
          <span>Comprador</span>
          <span>Total</span>
          <span>Estado</span>
        </div>

        {loading && (
          <div style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "12px" }}>
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton" style={{ height: "56px", borderRadius: "8px" }} />
            ))}
          </div>
        )}

        {!loading && orders.length === 0 && (
          <div style={{ padding: "48px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
            Sin órdenes en los últimos 30 días
          </div>
        )}

        {!loading && orders.map((order, i) => {
          const st = STATUS_LABEL[order.status] || { label: order.status, color: "var(--text-dim)" };
          const firstItem = order.order_items[0];

          return (
            <div
              key={order.id}
              style={{
                display: "grid",
                gridTemplateColumns: "80px 1fr 140px 100px 100px",
                gap: "16px",
                padding: "14px 20px",
                borderBottom: i < orders.length - 1 ? "1px solid var(--border)" : "none",
                alignItems: "center",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{
                fontSize: "11px", fontFamily: "var(--font-mono)",
                color: "var(--text-dim)",
              }}>#{order.id.toString().slice(-6)}</span>

              <div>
                <p style={{
                  fontSize: "13px", color: "var(--text)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {firstItem?.item.title || "—"}
                </p>
                {order.order_items.length > 1 && (
                  <p style={{ fontSize: "11px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                    +{order.order_items.length - 1} más
                  </p>
                )}
                <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                  {new Date(order.date_created).toLocaleDateString("es-AR")}
                </p>
              </div>

              <span style={{
                fontSize: "12px", fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {order.buyer.nickname}
              </span>

              <span style={{
                fontSize: "13px", fontFamily: "var(--font-mono)",
                fontWeight: "600", color: "var(--text)",
              }}>
                {formatARS(order.total_amount)}
              </span>

              <span style={{
                fontSize: "11px", fontFamily: "var(--font-display)",
                fontWeight: "600", color: st.color,
                display: "flex", alignItems: "center", gap: "5px",
              }}>
                <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: st.color, flexShrink: 0 }} />
                {st.label}
              </span>
            </div>
          );
        })}
      </div>

      <style>{`
        @media (max-width: 640px) {
          .sales-header { display: none !important; }
          div[style*="gridTemplateColumns: 80px"] {
            grid-template-columns: 1fr auto !important;
          }
        }
      `}</style>
    </div>
  );
}
