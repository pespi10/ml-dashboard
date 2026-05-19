// src/app/dashboard/rentabilidad/page.tsx
"use client";

import { useState, useEffect, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import { formatARS } from "@/lib/ml-api";
import { LOGISTICA_PROPIA_COSTO_POR_PEDIDO } from "@/lib/shipping-config";

// ── Types ──────────────────────────────────────────────────────────────

interface ProfitItem {
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

interface DashboardData {
  profitabilityByItem: ProfitItem[];
}

interface SyncedCostEntry {
  costo: number;
  precio_lista: number;
}

interface PerceptionDetail {
  description: string;
  aliquot: number;
  amount: number;
  taxable_amount: number;
  tax_type: string;
}

interface IIBBGroup {
  total: number;
  effectiveRate: number;
  detail: PerceptionDetail[];
}

interface TaxData {
  period: string;
  iibbVentas: IIBBGroup;
  iibbEnvios: IIBBGroup;
  combinedRate: number;
}

interface ShippingData {
  totalOrders: number;
  analyzedShipments: number;
  logisticaPropia: { count: number; totalCost: number; avgCost: number };
  mercadoEnvios: { count: number };
  splitRatio: { propia: number; ml: number };
}

interface EnrichedItem extends ProfitItem {
  unitCost: number | null;
  totalCost: number | null;
  realNetProfit: number | null;
  realMargin: number | null;
  precioLista: number | null;
  avgMlPrice: number | null;
}

interface CategoryRow {
  categoryId: string;
  categoryName: string;
  grossRevenue: number;
  totalSaleFees: number;
  unitsSold: number;
  skuCount: number;
  skusWithCost: number;
  netProfit: number | null;
  margin: number | null;
}

type SortCol =
  | "title"
  | "categoryName"
  | "unitsSold"
  | "grossRevenue"
  | "totalSaleFees"
  | "totalCost"
  | "realNetProfit"
  | "realMargin"
  | "precioLista"
  | "avgMlPrice"
  | "unitSaleFee"
  | "unitCost"
  | "unitProfit";

// ── Calculator types ───────────────────────────────────────────────────

interface ProductCalc {
  title: string;
  costPrice: number;
  salePrice: number;
  mlFeePercent: number;
  shippingCost: number;
  otherCosts: number;
  quantity: number;
}

const ML_FEE_TYPES = [
  { label: "Clásica", value: 13 },
  { label: "Premium", value: 17 },
  { label: "Oro / Platinum", value: 13 },
  { label: "Personalizado", value: 0 },
];

function calcROI(p: ProductCalc) {
  const mlFee = (p.salePrice * p.mlFeePercent) / 100;
  const revenue = p.salePrice - mlFee - p.shippingCost - p.otherCosts;
  const profit = revenue - p.costPrice;
  const margin = p.salePrice > 0 ? (profit / p.salePrice) * 100 : 0;
  const roi = p.costPrice > 0 ? (profit / p.costPrice) * 100 : 0;
  const totalProfit = profit * p.quantity;
  return { mlFee, revenue, profit, margin, roi, totalProfit };
}

// ── Helper components ──────────────────────────────────────────────────

function MarginText({ margin }: { margin: number | null }) {
  if (margin === null) {
    return <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "12px" }}>—</span>;
  }
  const color = margin > 20 ? "var(--green)" : margin >= 10 ? "var(--yellow)" : "var(--red)";
  return (
    <span style={{ color, fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: "600" }}>
      {margin.toFixed(1)}%
    </span>
  );
}

function SortHeader({
  label, col, sortCol, sortDir, onSort, align = "left",
}: {
  label: string; col: SortCol; sortCol: SortCol;
  sortDir: "asc" | "desc"; onSort: (c: SortCol) => void; align?: "left" | "right";
}) {
  const active = sortCol === col;
  return (
    <th
      onClick={() => onSort(col)}
      style={{
        padding: "6px 8px", textAlign: align,
        fontSize: "10px", fontWeight: "600", letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: active ? "var(--yellow)" : "var(--text-muted)",
        fontFamily: "var(--font-mono)", borderBottom: "1px solid var(--border)",
        cursor: "pointer", userSelect: "none", whiteSpace: "nowrap",
      }}
    >
      {label}{active ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
    </th>
  );
}

function marginColor(m: number | null): string {
  if (m === null) return "#444";
  if (m > 20) return "#00d4a0";
  if (m >= 10) return "#ffe600";
  return "#ff4458";
}

// ── Page ───────────────────────────────────────────────────────────────

export default function RentabilidadPage() {
  // ── Data state ─────────────────────────────────────────
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [mlCosts, setMlCosts] = useState<Record<string, number>>({});
  const [mlSyncedCosts, setMlSyncedCosts] = useState<Record<string, SyncedCostEntry>>({});
  const [taxData, setTaxData] = useState<TaxData | null>(null);
  const [shippingData, setShippingData] = useState<ShippingData | null>(null);
  const [shippingCostPerOrder, setShippingCostPerOrder] = useState(LOGISTICA_PROPIA_COSTO_POR_PEDIDO);
  const [shippingCostConfirmed, setShippingCostConfirmed] = useState(false);

  // ── Detail drawer state ────────────────────────────────
  const [selectedItem, setSelectedItem] = useState<EnrichedItem | null>(null);

  // ── Table view toggle ──────────────────────────────────
  const [tableView, setTableView] = useState<"unit" | "totals">("unit");

  // ── Sort state ─────────────────────────────────────────
  const [sortCol, setSortCol] = useState<SortCol>("unitProfit");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // ── Calculator state ───────────────────────────────────
  const [form, setForm] = useState<ProductCalc>({
    title: "", costPrice: 0, salePrice: 0,
    mlFeePercent: 13, shippingCost: 0, otherCosts: 0, quantity: 1,
  });

  // ── Fetch ──────────────────────────────────────────────
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("ml_costs") || "{}");
      setMlCosts(stored);
      const synced = JSON.parse(localStorage.getItem("ml_costs_ean") || "{}");
      setMlSyncedCosts(synced);
      const shippingConfig = JSON.parse(localStorage.getItem("shipping_config") || "null");
      if (shippingConfig?.costoPorPedido) {
        setShippingCostPerOrder(shippingConfig.costoPorPedido);
        setShippingCostConfirmed(true);
      }
    } catch { /* empty localStorage is fine */ }

    // Non-blocking shipping fetch — fills in after main data loads
    fetch("/api/shipping")
      .then((r) => r.ok ? r.json() as Promise<ShippingData> : null)
      .then((d) => { if (d && !("error" in (d as object))) setShippingData(d); })
      .catch(() => {});

    const profitFetch = fetch("/api/dashboard?section=profitability")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<DashboardData>; });

    const taxFetch = fetch("/api/billing/taxes")
      .then((r) => r.ok ? r.json() as Promise<TaxData> : null)
      .catch(() => null);

    Promise.all([profitFetch, taxFetch])
      .then(([profitData, taxes]) => {
        setData(profitData);
        if (taxes && !("error" in (taxes as object))) setTaxData(taxes);
        setLoading(false);
      })
      .catch((e: Error) => { setFetchError(e.message); setLoading(false); });
  }, []);

  // ── Enriched items ─────────────────────────────────────
  const enrichedItems = useMemo<EnrichedItem[]>(() => {
    if (!data) return [];
    return (data.profitabilityByItem ?? []).map((item) => {
      const synced = mlSyncedCosts[item.itemId];
      const unitCost = synced?.costo ?? mlCosts[item.itemId] ?? null;
      const totalCost = unitCost !== null ? unitCost * item.unitsSold : null;
      const realNetProfit =
        totalCost !== null ? item.grossRevenue - item.totalSaleFees - totalCost : null;
      const realMargin =
        realNetProfit !== null && item.grossRevenue > 0
          ? (realNetProfit / item.grossRevenue) * 100
          : null;
      const precioLista = synced?.precio_lista ?? null;
      const avgMlPrice = item.unitsSold > 0 ? item.grossRevenue / item.unitsSold : null;
      return { ...item, unitCost, totalCost, realNetProfit, realMargin, precioLista, avgMlPrice };
    });
  }, [data, mlCosts, mlSyncedCosts]);

  // ── Sorted items ───────────────────────────────────────
  const sortedItems = useMemo(() => {
    const dir = sortDir === "desc" ? -1 : 1;
    return [...enrichedItems].sort((a, b) => {
      switch (sortCol) {
        case "title":         return dir * a.title.localeCompare(b.title);
        case "categoryName":  return dir * a.categoryName.localeCompare(b.categoryName);
        case "unitsSold":     return dir * (a.unitsSold - b.unitsSold);
        case "grossRevenue":  return dir * (a.grossRevenue - b.grossRevenue);
        case "totalSaleFees": return dir * (a.totalSaleFees - b.totalSaleFees);
        case "totalCost":
          if (a.totalCost === null && b.totalCost === null) return 0;
          if (a.totalCost === null) return 1; if (b.totalCost === null) return -1;
          return dir * (a.totalCost - b.totalCost);
        case "realNetProfit":
          if (a.realNetProfit === null && b.realNetProfit === null) return 0;
          if (a.realNetProfit === null) return 1; if (b.realNetProfit === null) return -1;
          return dir * (a.realNetProfit - b.realNetProfit);
        case "realMargin":
          if (a.realMargin === null && b.realMargin === null) return 0;
          if (a.realMargin === null) return 1; if (b.realMargin === null) return -1;
          return dir * (a.realMargin - b.realMargin);
        case "precioLista":
          if (a.precioLista === null && b.precioLista === null) return 0;
          if (a.precioLista === null) return 1; if (b.precioLista === null) return -1;
          return dir * (a.precioLista - b.precioLista);
        case "avgMlPrice":
          if (a.avgMlPrice === null && b.avgMlPrice === null) return 0;
          if (a.avgMlPrice === null) return 1; if (b.avgMlPrice === null) return -1;
          return dir * (a.avgMlPrice - b.avgMlPrice);
        case "unitSaleFee": {
          const av = a.unitsSold > 0 ? a.totalSaleFees / a.unitsSold : 0;
          const bv = b.unitsSold > 0 ? b.totalSaleFees / b.unitsSold : 0;
          return dir * (av - bv);
        }
        case "unitCost":
          if (a.unitCost === null && b.unitCost === null) return 0;
          if (a.unitCost === null) return 1; if (b.unitCost === null) return -1;
          return dir * (a.unitCost - b.unitCost);
        case "unitProfit": {
          const av = a.realNetProfit !== null && a.unitsSold > 0 ? a.realNetProfit / a.unitsSold : null;
          const bv = b.realNetProfit !== null && b.unitsSold > 0 ? b.realNetProfit / b.unitsSold : null;
          if (av === null && bv === null) return 0;
          if (av === null) return 1; if (bv === null) return -1;
          return dir * (av - bv);
        }
        default: return 0;
      }
    });
  }, [enrichedItems, sortCol, sortDir]);

  // ── Category data ──────────────────────────────────────
  const categoryData = useMemo<CategoryRow[]>(() => {
    const map: Record<string, {
      categoryId: string; categoryName: string;
      grossRevenue: number; totalSaleFees: number;
      unitsSold: number; skuCount: number; skusWithCost: number; partialCost: number;
    }> = {};

    for (const item of enrichedItems) {
      if (!map[item.categoryId]) {
        map[item.categoryId] = {
          categoryId: item.categoryId, categoryName: item.categoryName,
          grossRevenue: 0, totalSaleFees: 0,
          unitsSold: 0, skuCount: 0, skusWithCost: 0, partialCost: 0,
        };
      }
      const cat = map[item.categoryId];
      cat.grossRevenue += item.grossRevenue;
      cat.totalSaleFees += item.totalSaleFees;
      cat.unitsSold += item.unitsSold;
      cat.skuCount++;
      if (item.totalCost !== null) { cat.partialCost += item.totalCost; cat.skusWithCost++; }
    }

    return Object.values(map)
      .map(({ partialCost, ...cat }) => {
        const allHaveCosts = cat.skusWithCost === cat.skuCount && cat.skuCount > 0;
        const netProfit = allHaveCosts ? cat.grossRevenue - cat.totalSaleFees - partialCost : null;
        const margin = netProfit !== null && cat.grossRevenue > 0
          ? (netProfit / cat.grossRevenue) * 100 : null;
        return { ...cat, netProfit, margin };
      })
      .sort((a, b) => b.grossRevenue - a.grossRevenue);
  }, [enrichedItems]);

  // ── Chart data ─────────────────────────────────────────
  const chartData = categoryData.map((cat) => ({
    name: cat.categoryName,
    margin: cat.margin ?? (cat.grossRevenue > 0
      ? ((cat.grossRevenue - cat.totalSaleFees) / cat.grossRevenue) * 100 : 0),
    hasRealMargin: cat.margin !== null,
  }));

  // ── Sort handler ───────────────────────────────────────
  const handleSort = (col: SortCol) => {
    if (col === sortCol) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortCol(col); setSortDir("desc"); }
  };

  // ── Shared styles ──────────────────────────────────────
  const cardStyle: React.CSSProperties = {
    background: "var(--surface)", border: "1px solid var(--border)",
    borderRadius: "var(--radius-lg)", padding: "24px",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: "11px", fontWeight: "600", letterSpacing: "0.06em",
    textTransform: "uppercase", color: "var(--text-muted)",
    marginBottom: "6px", display: "block", fontFamily: "var(--font-mono)",
  };

  const inputStyle: React.CSSProperties = {
    background: "var(--surface-2)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", padding: "10px 14px",
    color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: "14px",
    outline: "none", width: "100%",
  };

  const set = (field: keyof ProductCalc, value: string | number) =>
    setForm((f) => ({ ...f, [field]: value }));

  const result = calcROI(form);
  const isProfitable = result.profit > 0;
  const withCostCount = enrichedItems.filter((i) => i.unitCost !== null).length;

  const taxMonthName = useMemo(() => {
    if (!taxData) return "";
    const d = new Date(taxData.period + "T12:00:00");
    return d.toLocaleString("es-AR", { month: "long" });
  }, [taxData]);

  const SkeletonRows = ({ colSpan }: { colSpan: number }) => (
    <>
      {[1, 2, 3, 4, 5].map((i) => (
        <tr key={i}>
          <td colSpan={colSpan} style={{ padding: "4px 0" }}>
            <div className="skeleton" style={{ height: "32px", borderRadius: "var(--radius)" }} />
          </td>
        </tr>
      ))}
    </>
  );

  // shared td style for data cells
  const tdMono: React.CSSProperties = {
    padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: "12px",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>

      {/* ── Header ─────────────────────────────────────── */}
      <div>
        <h1 style={{
          fontFamily: "var(--font-display)", fontSize: "clamp(22px, 4vw, 28px)",
          fontWeight: "800", letterSpacing: "-0.02em", marginBottom: "4px",
        }}>
          Rentabilidad
        </h1>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          Análisis de márgenes reales con costos de productos
        </p>
      </div>

      {/* ── SECCIÓN 1: Rentabilidad por producto ─────── */}
      <div style={cardStyle}>
        <div style={{ marginBottom: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "4px" }}>
            <p style={{
              fontFamily: "var(--font-display)", fontSize: "16px",
              fontWeight: "700", letterSpacing: "-0.01em",
            }}>
              Rentabilidad por producto
            </p>
            {taxData && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: "4px",
                background: "rgba(255,230,0,0.08)", border: "1px solid rgba(255,230,0,0.2)",
                borderRadius: "20px", padding: "3px 10px",
                fontFamily: "var(--font-mono)", fontSize: "11px",
              }}>
                <span style={{ color: "var(--yellow)", fontWeight: "600" }}>IIBB efectivo {taxMonthName}:</span>
                <span style={{ color: "var(--text)" }}>{taxData.combinedRate.toFixed(2)}%</span>
              </span>
            )}
            {!shippingCostConfirmed && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: "4px",
                background: "rgba(255,140,0,0.08)", border: "1px solid rgba(255,140,0,0.25)",
                borderRadius: "20px", padding: "3px 10px",
                fontFamily: "var(--font-mono)", fontSize: "11px",
                color: "#ff8c00",
              }}>
                ⚠ Costo de logística propia pendiente confirmar
              </span>
            )}
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {loading
              ? "Cargando datos de ventas…"
              : enrichedItems.length === 0
              ? "Sin datos de ventas disponibles"
              : `${enrichedItems.length} productos vendidos · ${withCostCount} con costo cargado · Hacé click para ver detalle`}
          </p>
        </div>

        {fetchError && (
          <div style={{
            padding: "14px 16px", background: "var(--red-dim)",
            border: "1px solid rgba(255,68,88,0.25)", borderRadius: "var(--radius)",
            color: "var(--red)", fontSize: "13px", fontFamily: "var(--font-mono)",
          }}>
            Error al cargar datos: {fetchError}
          </div>
        )}

        {!fetchError && (
          <div>
            {/* View toggle */}
            <div style={{ display: "flex", gap: "4px", marginBottom: "16px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "3px", width: "fit-content" }}>
              {(["unit", "totals"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => {
                    setTableView(v);
                    setSortCol(v === "unit" ? "unitProfit" : "realNetProfit");
                    setSortDir("desc");
                  }}
                  style={{
                    background: tableView === v ? "var(--yellow)" : "transparent",
                    border: "none", borderRadius: "calc(var(--radius) - 2px)",
                    padding: "5px 16px", cursor: "pointer",
                    color: tableView === v ? "#000" : "var(--text-muted)",
                    fontFamily: "var(--font-display)", fontWeight: "600", fontSize: "12px",
                    transition: "all 0.15s",
                  }}
                >
                  {v === "unit" ? "Por unidad" : "Totales"}
                </button>
              ))}
            </div>

            <div className="rent-table-wrap">
              <table className="rent-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  {tableView === "unit" ? (
                    <tr>
                      <SortHeader label="Producto"      col="title"        sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Categoría"     col="categoryName" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortHeader label="P. ML"         col="avgMlPrice"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Comisión u."   col="unitSaleFee"  sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Costo u."      col="unitCost"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Ganancia u."   col="unitProfit"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Margen"        col="realMargin"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                    </tr>
                  ) : (
                    <tr>
                      <SortHeader label="Producto"      col="title"         sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Categoría"     col="categoryName"  sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Uds."          col="unitsSold"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Revenue"       col="grossRevenue"  sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Comisión"      col="totalSaleFees" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Costo total"   col="totalCost"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Ganancia"      col="realNetProfit" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Margen"        col="realMargin"    sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                    </tr>
                  )}
                </thead>
                <tbody>
                  {loading ? (
                    <SkeletonRows colSpan={tableView === "unit" ? 7 : 8} />
                  ) : tableView === "unit" ? (
                    sortedItems.map((item) => {
                      const unitSaleFee = item.unitsSold > 0 ? item.totalSaleFees / item.unitsSold : 0;
                      const unitProfit = item.realNetProfit !== null && item.unitsSold > 0
                        ? item.realNetProfit / item.unitsSold : null;
                      const commUnitPct = item.avgMlPrice && item.avgMlPrice > 0
                        ? (unitSaleFee / item.avgMlPrice) * 100 : 0;

                      return (
                        <tr
                          key={item.itemId}
                          onClick={() => setSelectedItem(item)}
                          style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s", cursor: "pointer" }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <td style={{ ...tdMono, maxWidth: "200px" }}>
                            <p style={{ fontFamily: "var(--font-display)", fontSize: "12px", fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {item.title}
                            </p>
                            <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-dim)", marginTop: "1px" }}>
                              {item.itemId}
                            </p>
                          </td>
                          <td style={{ ...tdMono, maxWidth: "120px", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {item.categoryName}
                          </td>
                          <td style={{ ...tdMono, textAlign: "right" }}>
                            {item.avgMlPrice !== null ? formatARS(item.avgMlPrice) : <span style={{ color: "var(--text-dim)" }}>—</span>}
                          </td>
                          <td style={{ ...tdMono, textAlign: "right" }}>
                            <span style={{ color: "var(--red)" }}>-{formatARS(unitSaleFee)}</span>
                            <span style={{ display: "block", fontSize: "10px", color: "var(--text-dim)" }}>{commUnitPct.toFixed(1)}%</span>
                          </td>
                          <td style={{ ...tdMono, textAlign: "right", color: item.unitCost !== null ? "var(--text)" : "var(--text-dim)" }}>
                            {item.unitCost !== null ? `-${formatARS(item.unitCost)}` : "—"}
                          </td>
                          <td style={{ ...tdMono, textAlign: "right", fontWeight: "600", color: unitProfit === null ? "var(--text-dim)" : unitProfit >= 0 ? "var(--green)" : "var(--red)" }}>
                            {unitProfit !== null ? formatARS(unitProfit) : "—"}
                          </td>
                          <td style={{ ...tdMono, textAlign: "right" }}>
                            <MarginText margin={item.realMargin} />
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    sortedItems.map((item) => {
                      const commPct = item.grossRevenue > 0 ? (item.totalSaleFees / item.grossRevenue) * 100 : 0;

                      return (
                        <tr
                          key={item.itemId}
                          onClick={() => setSelectedItem(item)}
                          style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s", cursor: "pointer" }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <td style={{ ...tdMono, maxWidth: "200px" }}>
                            <p style={{ fontFamily: "var(--font-display)", fontSize: "12px", fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {item.title}
                            </p>
                            <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-dim)", marginTop: "1px" }}>
                              {item.itemId}
                            </p>
                          </td>
                          <td style={{ ...tdMono, maxWidth: "120px", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {item.categoryName}
                          </td>
                          <td style={{ ...tdMono, textAlign: "right", color: "var(--text-muted)" }}>
                            {item.unitsSold}
                          </td>
                          <td style={{ ...tdMono, textAlign: "right" }}>
                            {formatARS(item.grossRevenue)}
                          </td>
                          <td style={{ ...tdMono, textAlign: "right" }}>
                            <span style={{ color: "var(--red)" }}>-{formatARS(item.totalSaleFees)}</span>
                            <span style={{ display: "block", fontSize: "10px", color: "var(--text-dim)" }}>{commPct.toFixed(1)}%</span>
                          </td>
                          <td style={{ ...tdMono, textAlign: "right", color: item.totalCost !== null ? "var(--text)" : "var(--text-dim)" }}>
                            {item.totalCost !== null ? `-${formatARS(item.totalCost)}` : "—"}
                          </td>
                          <td style={{ ...tdMono, textAlign: "right", fontWeight: "600", color: item.realNetProfit === null ? "var(--text-dim)" : item.realNetProfit >= 0 ? "var(--green)" : "var(--red)" }}>
                            {item.realNetProfit !== null ? formatARS(item.realNetProfit) : "—"}
                          </td>
                          <td style={{ ...tdMono, textAlign: "right" }}>
                            <MarginText margin={item.realMargin} />
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>

              {!loading && sortedItems.length === 0 && !fetchError && (
                <p style={{ textAlign: "center", padding: "32px", color: "var(--text-muted)", fontSize: "13px", fontFamily: "var(--font-mono)" }}>
                  Sin ventas en los últimos 30 días
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── SECCIÓN 2: Rentabilidad por categoría ────── */}
      <div style={cardStyle}>
        <div style={{ marginBottom: "20px" }}>
          <p style={{
            fontFamily: "var(--font-display)", fontSize: "16px",
            fontWeight: "700", letterSpacing: "-0.01em", marginBottom: "4px",
          }}>
            Rentabilidad por categoría
          </p>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            Revenue y márgenes agrupados por categoría de Mercado Libre
          </p>
        </div>

        {loading && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: "12px", marginBottom: "24px" }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="skeleton" style={{ height: "120px", borderRadius: "var(--radius-lg)" }} />
            ))}
          </div>
        )}

        {!loading && categoryData.length > 0 && (
          <>
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
              gap: "12px", marginBottom: "24px",
            }}>
              {categoryData.map((cat) => (
                <div key={cat.categoryId} style={{
                  background: "var(--surface-2)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius-lg)", padding: "16px",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
                    <p style={{
                      fontFamily: "var(--font-display)", fontSize: "12px", fontWeight: "700",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      flex: 1, marginRight: "8px",
                    }}>
                      {cat.categoryName}
                    </p>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                      {cat.skuCount} SKU{cat.skuCount !== 1 ? "s" : ""}
                    </span>
                  </div>

                  <p style={{ fontFamily: "var(--font-display)", fontSize: "18px", fontWeight: "800", marginBottom: "2px" }}>
                    {formatARS(cat.grossRevenue)}
                  </p>
                  <p style={{ fontSize: "10px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: "8px" }}>
                    revenue bruto · {cat.unitsSold} u.
                  </p>

                  <MarginText margin={cat.margin} />

                  {cat.margin === null && cat.skusWithCost < cat.skuCount && (
                    <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: "6px" }}>
                      {cat.skusWithCost}/{cat.skuCount} con costo
                    </p>
                  )}
                </div>
              ))}
            </div>

            {chartData.length > 0 && (
              <div style={{ background: "var(--surface-2)", borderRadius: "var(--radius-lg)", padding: "20px 20px 16px" }}>
                <p style={{ ...labelStyle, marginBottom: "16px" }}>
                  Margen por categoría (%)
                  <span style={{ color: "var(--text-dim)", fontWeight: "400", marginLeft: "8px" }}>
                    · gris = sin costos cargados
                  </span>
                </p>
                <ResponsiveContainer width="100%" height={Math.max(categoryData.length * 52, 100)}>
                  <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 8 }}>
                    <XAxis
                      type="number" domain={[0, "auto"]}
                      tick={{ fontFamily: "var(--font-mono)", fontSize: 11, fill: "#666" }}
                      axisLine={false} tickLine={false} unit="%"
                    />
                    <YAxis
                      type="category" dataKey="name" width={110}
                      tick={{ fontFamily: "var(--font-mono)", fontSize: 10, fill: "#666" }}
                      axisLine={false} tickLine={false}
                      tickFormatter={(v: string) => v.length > 14 ? v.slice(0, 13) + "…" : v}
                    />
                    <Tooltip
                      formatter={(value: number, _: string, props: { payload?: { hasRealMargin?: boolean } }) => [
                        `${value.toFixed(1)}%${props.payload?.hasRealMargin === false ? " (sin costo)" : ""}`,
                        "Margen",
                      ]}
                      contentStyle={{
                        background: "var(--surface)", border: "1px solid var(--border)",
                        borderRadius: "6px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text)",
                      }}
                      cursor={{ fill: "rgba(255,255,255,0.03)" }}
                    />
                    <Bar dataKey="margin" radius={[0, 4, 4, 0]} maxBarSize={22}>
                      {chartData.map((entry, i) => (
                        <Cell key={i} fill={marginColor(entry.hasRealMargin ? entry.margin : null)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}

        {!loading && categoryData.length === 0 && !fetchError && (
          <p style={{ color: "var(--text-muted)", fontSize: "13px", fontFamily: "var(--font-mono)", textAlign: "center", padding: "32px" }}>
            Sin datos de categorías disponibles
          </p>
        )}
      </div>

      {/* ── SECCIÓN 3: Calculadora ────────────────────── */}
      <div style={cardStyle}>
        <div style={{ marginBottom: "24px" }}>
          <p style={{ fontFamily: "var(--font-display)", fontSize: "16px", fontWeight: "700", letterSpacing: "-0.01em", marginBottom: "4px" }}>
            Calculadora
          </p>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            Calculá margen y ROI antes de publicar
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px", alignItems: "start" }} className="rent-grid">
          {/* Form */}
          <div style={{
            background: "var(--surface-2)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)", padding: "24px",
            display: "flex", flexDirection: "column", gap: "20px",
          }}>
            <div>
              <label style={labelStyle}>Nombre del producto</label>
              <input type="text" value={form.title} onChange={(e) => set("title", e.target.value)}
                placeholder="ej: Auriculares Bluetooth JBL" style={inputStyle} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div>
                <label style={labelStyle}>Costo ($)</label>
                <input type="number" value={form.costPrice || ""} onChange={(e) => set("costPrice", parseFloat(e.target.value) || 0)} placeholder="0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Precio de venta ($)</label>
                <input type="number" value={form.salePrice || ""} onChange={(e) => set("salePrice", parseFloat(e.target.value) || 0)} placeholder="0" style={inputStyle} />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Tipo de publicación</label>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {ML_FEE_TYPES.map((t) => (
                  <button
                    key={t.label}
                    onClick={() => set("mlFeePercent", t.value === 0 ? form.mlFeePercent : t.value)}
                    style={{
                      background: form.mlFeePercent === t.value && t.value !== 0 ? "var(--yellow-dim)" : "var(--surface)",
                      border: `1px solid ${form.mlFeePercent === t.value && t.value !== 0 ? "rgba(255,230,0,0.25)" : "var(--border)"}`,
                      color: form.mlFeePercent === t.value && t.value !== 0 ? "var(--yellow)" : "var(--text-muted)",
                      borderRadius: "20px", padding: "5px 12px", fontSize: "12px",
                      fontFamily: "var(--font-display)", fontWeight: "600", cursor: "pointer",
                    }}
                  >
                    {t.label} {t.value > 0 ? `(${t.value}%)` : ""}
                  </button>
                ))}
              </div>
              <div style={{ marginTop: "10px" }}>
                <label style={labelStyle}>Comisión ML (%)</label>
                <input type="number" value={form.mlFeePercent} onChange={(e) => set("mlFeePercent", parseFloat(e.target.value) || 0)} style={{ ...inputStyle, width: "120px" }} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div>
                <label style={labelStyle}>Envío ($)</label>
                <input type="number" value={form.shippingCost || ""} onChange={(e) => set("shippingCost", parseFloat(e.target.value) || 0)} placeholder="0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Otros costos ($)</label>
                <input type="number" value={form.otherCosts || ""} onChange={(e) => set("otherCosts", parseFloat(e.target.value) || 0)} placeholder="Empaque, etc." style={inputStyle} />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Cantidad a vender</label>
              <input type="number" value={form.quantity} onChange={(e) => set("quantity", parseInt(e.target.value) || 1)} min={1} style={{ ...inputStyle, width: "120px" }} />
            </div>
          </div>

          {/* Results */}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{
              background: isProfitable ? "var(--green-dim)" : "var(--red-dim)",
              border: `1px solid ${isProfitable ? "rgba(0,212,160,0.25)" : "rgba(255,68,88,0.25)"}`,
              borderRadius: "var(--radius-lg)", padding: "28px", textAlign: "center",
            }}>
              <p style={{
                fontSize: "11px", fontWeight: "600", letterSpacing: "0.1em", textTransform: "uppercase",
                color: isProfitable ? "var(--green)" : "var(--red)", fontFamily: "var(--font-mono)", marginBottom: "12px",
              }}>
                {isProfitable ? "✓ Rentable" : "✗ No rentable"}
              </p>
              <p style={{
                fontFamily: "var(--font-display)", fontSize: "56px", fontWeight: "800",
                letterSpacing: "-0.03em", color: isProfitable ? "var(--green)" : "var(--red)", lineHeight: 1, marginBottom: "8px",
              }}>
                {result.roi.toFixed(1)}%
              </p>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>ROI por unidad</p>
            </div>

            <div style={{
              background: "var(--surface-2)", border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)", padding: "24px", display: "flex", flexDirection: "column", gap: "14px",
            }}>
              {[
                { label: "Precio de venta", value: form.salePrice, color: "var(--text)" },
                { label: `Comisión ML (${form.mlFeePercent}%)`, value: -result.mlFee, color: "var(--red)" },
                { label: "Envío", value: -form.shippingCost, color: "var(--red)" },
                { label: "Otros costos", value: -form.otherCosts, color: "var(--red)" },
                { label: "Costo del producto", value: -form.costPrice, color: "var(--red)" },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "13px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{label}</span>
                  <span style={{ fontSize: "14px", fontFamily: "var(--font-mono)", fontWeight: "500", color }}>
                    {value < 0 ? "-" : ""}{formatARS(Math.abs(value))}
                  </span>
                </div>
              ))}

              <div style={{ borderTop: "1px solid var(--border)", paddingTop: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: "var(--font-display)", fontSize: "15px", fontWeight: "700" }}>Ganancia neta</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "18px", fontWeight: "700", color: isProfitable ? "var(--green)" : "var(--red)" }}>
                  {formatARS(result.profit)}
                </span>
              </div>

              <div style={{ background: "var(--surface)", borderRadius: "var(--radius)", padding: "14px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div>
                  <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: "4px" }}>MARGEN</p>
                  <p style={{ fontFamily: "var(--font-display)", fontSize: "20px", fontWeight: "800", color: isProfitable ? "var(--yellow)" : "var(--red)" }}>
                    {result.margin.toFixed(1)}%
                  </p>
                </div>
                <div>
                  <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: "4px" }}>GANANCIA TOTAL ({form.quantity} u.)</p>
                  <p style={{ fontFamily: "var(--font-display)", fontSize: "20px", fontWeight: "800", color: isProfitable ? "var(--green)" : "var(--red)" }}>
                    {formatARS(result.totalProfit)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Detail drawer ─────────────────────────────── */}
      {selectedItem && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setSelectedItem(null)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
              zIndex: 100, backdropFilter: "blur(2px)",
            }}
          />

          {/* Panel */}
          <div style={{
            position: "fixed", top: 0, right: 0, bottom: 0,
            width: "min(420px, 100vw)",
            background: "var(--surface)", borderLeft: "1px solid var(--border)",
            zIndex: 101, overflowY: "auto",
            display: "flex", flexDirection: "column",
          }}>
            {/* Header */}
            <div style={{
              padding: "24px 24px 20px", borderBottom: "1px solid var(--border)",
              display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontFamily: "var(--font-display)", fontSize: "15px", fontWeight: "700", marginBottom: "4px" }}>
                  {selectedItem.title}
                </p>
                <p style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--yellow)" }}>
                  {selectedItem.itemId}
                </p>
              </div>
              <button
                onClick={() => setSelectedItem(null)}
                style={{
                  background: "var(--surface-2)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius)", padding: "6px 10px", color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)", fontSize: "13px", cursor: "pointer", flexShrink: 0,
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "24px", flex: 1 }}>
              {/* P&L Breakdown */}
              <div>
                <p style={{ ...labelStyle, marginBottom: "14px" }}>Desglose P&L</p>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {[
                    { label: "Revenue bruto", value: selectedItem.grossRevenue, color: "var(--text)", sign: "" },
                    {
                      label: `Comisión ML (${selectedItem.grossRevenue > 0 ? ((selectedItem.totalSaleFees / selectedItem.grossRevenue) * 100).toFixed(1) : "0"}%)`,
                      value: selectedItem.totalSaleFees, color: "var(--red)", sign: "-",
                    },
                    ...(selectedItem.totalCost !== null
                      ? [{ label: `Costo total (${selectedItem.unitsSold} u.)`, value: selectedItem.totalCost, color: "var(--red)", sign: "-" }]
                      : []),
                  ].map(({ label, value, color, sign }) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: "13px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{label}</span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "13px", fontWeight: "500", color }}>
                        {sign}{formatARS(value)}
                      </span>
                    </div>
                  ))}

                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: "10px", display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "13px", fontFamily: "var(--font-display)", fontWeight: "700" }}>Ganancia antes de imp.</span>
                    <span style={{
                      fontFamily: "var(--font-mono)", fontSize: "14px", fontWeight: "700",
                      color: selectedItem.realNetProfit === null ? "var(--text-dim)"
                        : selectedItem.realNetProfit >= 0 ? "var(--green)" : "var(--red)",
                    }}>
                      {selectedItem.realNetProfit !== null ? formatARS(selectedItem.realNetProfit) : "—"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Taxes section */}
              <div style={{
                padding: "16px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
              }}>
                <p style={{ ...labelStyle, marginBottom: "12px" }}>
                  Percepciones IIBB estimadas
                  {taxData && (
                    <span style={{ color: "var(--text-dim)", fontWeight: "400", marginLeft: "6px", textTransform: "none" }}>
                      (base {taxMonthName})
                    </span>
                  )}
                </p>
                {taxData ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {/* IIBB ventas */}
                    {taxData.iibbVentas.detail.length > 0 && (
                      <div>
                        <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                          Sobre ventas
                        </p>
                        {taxData.iibbVentas.detail.map((p, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: "4px" }}>
                            <span style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", flex: 1, marginRight: "8px" }}>
                              {p.description || p.tax_type}
                            </span>
                            <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--red)", whiteSpace: "nowrap" }}>
                              -{formatARS(selectedItem.grossRevenue * (p.aliquot / 100))} ({p.aliquot.toFixed(2)}%)
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* IIBB envíos */}
                    {taxData.iibbEnvios.detail.length > 0 && (
                      <div style={{ marginTop: "4px" }}>
                        <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                          Sobre envíos
                        </p>
                        {taxData.iibbEnvios.detail.map((p, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: "4px" }}>
                            <span style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", flex: 1, marginRight: "8px" }}>
                              {p.description || p.tax_type}
                            </span>
                            <span style={{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--red)", whiteSpace: "nowrap" }}>
                              -{formatARS(selectedItem.grossRevenue * (p.aliquot / 100))} ({p.aliquot.toFixed(2)}%)
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Total */}
                    <div style={{ borderTop: "1px solid var(--border)", paddingTop: "8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: "12px", fontFamily: "var(--font-display)", fontWeight: "600" }}>Total percepciones</span>
                      <span style={{ fontSize: "12px", fontFamily: "var(--font-mono)", fontWeight: "600", color: "var(--red)" }}>
                        -{formatARS(selectedItem.grossRevenue * taxData.combinedRate / 100)}
                        <span style={{ fontWeight: "400", color: "var(--text-dim)", marginLeft: "4px" }}>({taxData.combinedRate.toFixed(2)}%)</span>
                      </span>
                    </div>

                    <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: "2px", lineHeight: "1.5" }}>
                      Estimación basada en alícuotas de {taxMonthName}. IVA se liquida por separado.
                    </p>
                  </div>
                ) : (
                  <p style={{ fontSize: "12px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", lineHeight: "1.6" }}>
                    Los impuestos (IVA, IBB) son liquidados por ML en el estado de cuenta mensual y no están disponibles por orden individual.
                  </p>
                )}
              </div>

              {/* Shipping estimate */}
              {shippingData && (
                <div style={{
                  padding: "16px", background: "var(--surface-2)",
                  border: "1px solid var(--border)", borderRadius: "var(--radius)",
                }}>
                  <p style={{ ...labelStyle, marginBottom: "12px" }}>
                    Envío estimado
                    {!shippingCostConfirmed && (
                      <span style={{ color: "#ff8c00", fontWeight: "400", marginLeft: "6px", textTransform: "none" }}>
                        ⚠ costo pendiente confirmar
                      </span>
                    )}
                  </p>
                  {(() => {
                    const propiaUnits = Math.round(selectedItem.unitsSold * (shippingData.splitRatio.propia / 100));
                    const mlUnits = selectedItem.unitsSold - propiaUnits;
                    const propiaShippingCost = propiaUnits * shippingCostPerOrder;
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                            Logística propia ({shippingData.splitRatio.propia.toFixed(0)}% · {propiaUnits} u.)
                          </span>
                          <span style={{ fontSize: "12px", fontFamily: "var(--font-mono)", color: propiaShippingCost > 0 ? "var(--red)" : "var(--text-dim)" }}>
                            {propiaShippingCost > 0 ? `-${formatARS(propiaShippingCost)}` : "—"}
                          </span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                            Mercado Envíos ({shippingData.splitRatio.ml.toFixed(0)}% · {mlUnits} u.)
                          </span>
                          <span style={{ fontSize: "11px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                            ver billing
                          </span>
                        </div>
                        <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: "2px", lineHeight: "1.5" }}>
                          Split basado en {shippingData.analyzedShipments} envíos recientes. Costo logística propia: {formatARS(shippingCostPerOrder)}/pedido.
                        </p>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Unit info */}
              {selectedItem.unitCost !== null && (
                <div style={{
                  background: "var(--surface-2)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius)", padding: "14px",
                  display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px",
                }}>
                  <div>
                    <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: "4px" }}>COSTO UNITARIO</p>
                    <p style={{ fontFamily: "var(--font-mono)", fontSize: "15px", fontWeight: "700", color: "var(--text)" }}>
                      {formatARS(selectedItem.unitCost)}
                    </p>
                  </div>
                  {selectedItem.avgMlPrice !== null && (
                    <div>
                      <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: "4px" }}>P. ML PROM.</p>
                      <p style={{ fontFamily: "var(--font-mono)", fontSize: "15px", fontWeight: "700", color: "var(--text)" }}>
                        {formatARS(selectedItem.avgMlPrice)}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <style>{`
        .rent-table-wrap { overflow-x: visible; }
        .rent-table td { min-width: 0; }
        @media (max-width: 1024px) {
          .rent-table-wrap { overflow-x: auto; }
        }
        @media (max-width: 768px) {
          .rent-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
