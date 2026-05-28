// src/app/dashboard/ventas/page.tsx
"use client";

import { useEffect, useState } from "react";
import { formatARS } from "@/lib/ml-api";
import DateRangePicker, { defaultDateRange } from "@/components/ui/DateRangePicker";

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

const COLS = "64px minmax(160px, 1.6fr) minmax(92px, 0.9fr) minmax(78px, 0.7fr) minmax(74px, 0.7fr) minmax(82px, 0.7fr) minmax(80px, 0.7fr)";

const ACTIVE_STATUSES = new Set(["paid", "pending", "shipped", "delivered"]);

export default function VentasPage() {
  const [dateFrom, setDateFrom] = useState(() => defaultDateRange().from);
  const [dateTo, setDateTo] = useState(() => defaultDateRange().to);
  const [orders, setOrders] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [costs, setCosts] = useState<Record<string, number>>({});
  const [view, setView] = useState<"active" | "all">("active");

  useEffect(() => {
    try {
      const stored = localStorage.getItem("ml_costs");
      if (stored) setCosts(JSON.parse(stored));
    } catch {
      setCosts({});
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setOrders([]);
    setPage(1);
    fetch(`/api/sales?page=1&limit=50&date_from=${dateFrom}&date_to=${dateTo}`)
      .then((r) => r.json())
      .then((data) => {
        setOrders(data.results ?? []);
        setTotal(data.total ?? 0);
        setPage(data.page ?? 1);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo]);

  const loadMore = () => {
    if (loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    fetch(`/api/sales?page=${nextPage}&limit=50&date_from=${dateFrom}&date_to=${dateTo}`)
      .then((r) => r.json())
      .then((data) => {
        setOrders((prev) => [...prev, ...(data.results ?? [])]);
        setTotal(data.total ?? total);
        setPage(data.page ?? nextPage);
      })
      .catch(console.error)
      .finally(() => setLoadingMore(false));
  };

  const hasMore = orders.length < total;
  const displayedOrders = view === "active"
    ? orders.filter((o) => ACTIVE_STATUSES.has(o.status))
    : orders;

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "flex-end", marginBottom: "24px", flexWrap: "wrap", gap: "12px",
      }}>
        <div>
          <h1 style={{
            fontFamily: "var(--font-display)", fontSize: "clamp(22px, 4vw, 28px)",
            fontWeight: "800", letterSpacing: "-0.02em", marginBottom: "4px",
          }}>Ventas</h1>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {dateFrom} → {dateTo} ·{" "}
            {loading ? "—" : `${orders.length} de ${total} órdenes`}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <DateRangePicker
            dateFrom={dateFrom}
            dateTo={dateTo}
            onChange={(from, to) => { setDateFrom(from); setDateTo(to); }}
          />
        </div>

        {/* Tab toggle */}
        <div style={{
          display: "flex",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "3px",
          gap: "2px",
        }}>
          {(["active", "all"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                background: view === v ? "var(--surface-2)" : "transparent",
                border: view === v ? "1px solid var(--border)" : "1px solid transparent",
                borderRadius: "calc(var(--radius) - 2px)",
                padding: "6px 16px",
                color: view === v ? "var(--text)" : "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                cursor: "pointer",
                fontWeight: view === v ? "600" : "400",
                transition: "all 0.1s",
              }}
            >
              {v === "active" ? "Activas / Pausadas" : "Todas"}
            </button>
          ))}
        </div>
      </div>

      {/* Warning banner for "Todas" */}
      {view === "all" && !loading && (
        <div style={{
          marginBottom: "16px",
          padding: "10px 16px",
          background: "var(--yellow-dim)",
          border: "1px solid rgba(255,230,0,0.2)",
          borderRadius: "var(--radius)",
          fontSize: "12px",
          color: "var(--yellow)",
          fontFamily: "var(--font-mono)",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}>
          <span>⚠</span>
          <span>Incluye órdenes canceladas. Los totales pueden no reflejar ingresos reales.</span>
        </div>
      )}

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

        {!loading && displayedOrders.length === 0 && (
          <div style={{ padding: "48px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
            {view === "active" ? "Sin órdenes activas en los últimos 30 días" : "Sin órdenes en los últimos 30 días"}
          </div>
        )}

        {!loading && displayedOrders.map((order, i) => {
          const st = STATUS_LABEL[order.status] || { label: order.status, color: "var(--text-dim)" };
          const firstItem = order.order_items[0];
          const unitPrice = firstItem?.unit_price ?? 0;
          const saleFee = order.order_items.reduce((s, oi) => s + (oi.sale_fee ?? 0), 0);
          const grossItems = order.order_items.reduce(
            (s, oi) => s + oi.unit_price * oi.quantity,
            0
          );
          const itemsWithCost = order.order_items.filter((oi) => costs[oi.item.id] != null);
          const costTotal = itemsWithCost.reduce(
            (s, oi) => s + costs[oi.item.id] * oi.quantity,
            0
          );
          const profit = itemsWithCost.length > 0 ? grossItems - saleFee - costTotal : null;
          const partialCost = profit != null && itemsWithCost.length < order.order_items.length;

          return (
            <div
              key={order.id}
              className="sales-row"
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: "12px",
                padding: "14px 20px",
                borderBottom: i < displayedOrders.length - 1 ? "1px solid var(--border)" : "none",
                alignItems: "center",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span className="sales-id" style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--text-dim)" }}>
                #{order.id.toString().slice(-6)}
              </span>

              <div className="sales-product">
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

              <span className="sales-buyer" style={{
                fontSize: "12px", fontFamily: "var(--font-mono)", color: "var(--text-muted)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {order.buyer.nickname}
              </span>

              <span className="sales-money" style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "var(--text)", textAlign: "right" }}>
                {formatARS(unitPrice)}
              </span>

              <span className="sales-money" style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: "var(--red)", textAlign: "right" }}>
                {saleFee > 0 ? formatARS(saleFee) : "—"}
              </span>

              <span className="sales-money" style={{
                fontSize: "12px", fontFamily: "var(--font-mono)", textAlign: "right",
                fontWeight: profit != null ? "600" : "400",
                color: profit == null
                  ? "var(--text-dim)"
                  : profit >= 0
                    ? "var(--green)"
                    : "var(--red)",
              }}>
                {profit == null ? "—" : `${partialCost ? "~" : ""}${formatARS(profit)}`}
              </span>

              <span className="sales-status" style={{
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
        .sales-row > * { min-width: 0; }
        @media (max-width: 768px) {
          .sales-header { display: none !important; }
          .sales-row {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
            gap: 12px 14px !important;
            padding: 16px !important;
            align-items: start !important;
          }
          .sales-product {
            grid-column: 1 / -1;
            order: 1;
          }
          .sales-id {
            order: 2;
          }
          .sales-status {
            justify-content: flex-end;
            order: 3;
          }
          .sales-buyer {
            grid-column: 1 / -1;
            order: 4;
          }
          .sales-money {
            text-align: left !important;
            order: 5;
          }
        }
      `}</style>
    </div>
  );
}
