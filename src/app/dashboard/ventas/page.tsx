// src/app/dashboard/ventas/page.tsx
"use client";

import { useEffect, useState } from "react";
import { formatARS } from "@/lib/ml-api";

interface OrderItem {
  item: { id: string; title: string };
  quantity: number;
  unit_price: number;
  sale_fee: number;
}

interface Order {
  id: number;
  date_created: string;
  status: string;
  total_amount: number;
  currency_id: string;
  order_items: OrderItem[];
  buyer: { id: number; nickname: string };
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  paid: { label: "Pagado", color: "var(--green)" },
  pending: { label: "Pendiente", color: "var(--yellow)" },
  cancelled: { label: "Cancelado", color: "var(--red)" },
  shipped: { label: "Enviado", color: "var(--blue)" },
  delivered: { label: "Entregado", color: "var(--green)" },
};

const COLS = "72px 1fr 130px 90px 80px 90px 90px";

export default function VentasPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [costs, setCosts] = useState<Record<string, number>>({});

  useEffect(() => {
    const stored = localStorage.getItem("ml_costs");
    if (stored) setCosts(JSON.parse(stored));
  }, []);

  useEffect(() => {
    fetch("/api/sales?page=1&limit=50")
      .then((r) => r.json())
      .then((data) => {
        setOrders(data.results ?? []);
        setTotal(data.total ?? 0);
        setPage(1);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const loadMore = () => {
    const nextPage = page + 1;
    setLoadingMore(true);
    fetch(`/api/sales?page=${nextPage}&limit=50`)
      .then((r) => r.json())
      .then((data) => {
        setOrders((prev) => [...prev, ...(data.results ?? [])]);
        setPage(nextPage);
      })
      .catch(console.error)
      .finally(() => setLoadingMore(false));
  };

  const totalGMV = orders.reduce((s, o) => s + o.total_amount, 0);
  const hasMore = orders.length < total;

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
            Últimos 30 días ·{" "}
            {loading ? "—" : `Mostrando ${orders.length} de ${total} órdenes`}
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
            GMV CARGADO
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
          gridTemplateColumns: COLS,
          gap: "12px",
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
          <span style={{ textAlign: "right" }}>Precio</span>
          <span style={{ textAlign: "right" }}>Comisión</span>
          <span style={{ textAlign: "right" }}>Ganancia</span>
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
          const unitPrice = firstItem?.unit_price ?? 0;
          const saleFee = order.order_items.reduce((s, oi) => s + (oi.sale_fee ?? 0), 0);
          const itemId = firstItem?.item.id ?? "";
          const cost = costs[itemId];
          const profit = cost != null ? unitPrice - saleFee - cost * (firstItem?.quantity ?? 1) : null;

          return (
            <div
              key={order.id}
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: "12px",
                padding: "14px 20px",
                borderBottom: i < orders.length - 1 ? "1px solid var(--border)" : "none",
                alignItems: "center",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
                #{order.id.toString().slice(-6)}
              </span>

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
                fontSize: "12px", fontFamily: "var(--font-mono)", color: "var(--text-muted)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {order.buyer.nickname}
              </span>

              <span style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "var(--text)", textAlign: "right" }}>
                {formatARS(unitPrice)}
              </span>

              <span style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "var(--red)", textAlign: "right" }}>
                {saleFee > 0 ? formatARS(saleFee) : "—"}
              </span>

              <span style={{
                fontSize: "12px", fontFamily: "var(--font-mono)", textAlign: "right",
                fontWeight: profit != null ? "600" : "400",
                color: profit == null
                  ? "var(--text-dim)"
                  : profit >= 0
                    ? "var(--green)"
                    : "var(--red)",
              }}>
                {profit == null ? "—" : formatARS(profit)}
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

        {!loading && hasMore && (
          <div style={{
            padding: "20px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "16px",
          }}>
            <span style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {orders.length} de {total} órdenes cargadas
            </span>
            <button
              onClick={loadMore}
              disabled={loadingMore}
              style={{
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "8px 20px",
                color: loadingMore ? "var(--text-dim)" : "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                cursor: loadingMore ? "not-allowed" : "pointer",
              }}
            >
              {loadingMore ? "Cargando..." : "Cargar más"}
            </button>
          </div>
        )}
      </div>

      <style>{`
        @media (max-width: 768px) {
          .sales-header { display: none !important; }
        }
      `}</style>
    </div>
  );
}
