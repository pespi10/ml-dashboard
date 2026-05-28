// src/app/dashboard/rentabilidad/page.tsx
"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import { formatARS } from "@/lib/ml-api";
import type { MLItem } from "@/lib/ml-api";
import DateRangePicker, { defaultDateRange } from "@/components/ui/DateRangePicker";

// ── Commission rates ───────────────────────────────────────────────────
const ML_COMMISSION: Record<string, number> = {
  gold_special: 0.125,
  gold_pro: 0.09,
  gold_premium: 0.16,
  silver: 0.08,
  bronze: 0.06,
  free: 0,
};

const STATUS_COLOR: Record<string, string> = {
  active: "var(--green)",
  paused: "var(--yellow)",
  closed: "var(--text-dim)",
  under_review: "#60a5fa",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Activa",
  paused: "Pausada",
  closed: "Cerrada",
  under_review: "En revisión",
};

// ── Types ──────────────────────────────────────────────────────────────

interface ProfitItem {
  itemId: string;
  title: string;
  categoryId: string;
  categoryName: string;
  unitsSold: number;
  grossRevenue: number;
  totalSaleFees: number;
}

interface DashboardData {
  profitabilityByItem: ProfitItem[];
}

interface TaxData {
  period: string;
  ventasRate: number;
  enviosRate: number;
  combinedRate: number;
  iibbVentas: { total: number; taxable: number; rate: number; count: number };
  iibbEnvios: { total: number; taxable: number; rate: number; count: number };
}

interface ShippingData {
  avgSellerCost: number;
  avgOrderRevenue: number;
  mlShippingRate: number;
  propiaShippingRate: number;
  pctSellerPays: number;
  totalAnalyzed: number;
  splitRatio: { propia: number; ml: number };
}

interface EnrichedItem {
  // From MLItem
  id: string;
  title: string;
  price: number;
  listing_type_id: string;
  available_quantity: number;
  sold_quantity: number;
  status: string;
  permalink: string;
  // Category (from profit data, blank if no sales)
  categoryId: string;
  categoryName: string;
  // Sales data (0 if no sales in period)
  unitsSold: number;
  grossRevenue: number;
  totalSaleFees: number;
  // Cost from DB
  unitCost: number | null;
  precioLista: number | null;
  // Per-unit calculations (based on item.price)
  commRate: number;
  commAmt: number;
  shippingRate: number;   // weighted %
  shippingAmt: number;    // $ based on current price
  iibbRate: number;       // % (e.g. 4.0)
  iibbAmt: number;        // $ based on current price
  // Profit
  unitProfit: number | null;
  unitMargin: number | null;
  totalProfit: number | null; // unitProfit × unitsSold, null if no cost or no sales
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
  | "price"
  | "commAmt"
  | "shippingAmt"
  | "iibbAmt"
  | "unitCost"
  | "unitProfit"
  | "unitMargin"
  | "unitsSold"
  | "grossRevenue"
  | "totalProfit";

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
  const [dateFrom, setDateFrom] = useState(() => defaultDateRange().from);
  const [dateTo, setDateTo] = useState(() => defaultDateRange().to);
  const [activeItems, setActiveItems] = useState<MLItem[]>([]);
  const [profitMap, setProfitMap] = useState<Record<string, ProfitItem>>({});
  const [costs, setCosts] = useState<Record<string, { costo: number; precioLista: number | null }>>({});
  const [taxData, setTaxData] = useState<TaxData | null>(null);
  const [shippingData, setShippingData] = useState<ShippingData | null>(null);
  const [staticLoaded, setStaticLoaded] = useState(false);
  const [profLoading, setProfLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── UI state ───────────────────────────────────────────
  const [selectedItem, setSelectedItem] = useState<EnrichedItem | null>(null);
  const [tableView, setTableView] = useState<"unit" | "totals">("unit");
  const [sortCol, setSortCol] = useState<SortCol>("unitProfit");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // ── Calculator state ───────────────────────────────────
  const [form, setForm] = useState<ProductCalc>({
    title: "", costPrice: 0, salePrice: 0,
    mlFeePercent: 13, shippingCost: 0, otherCosts: 0, quantity: 1,
  });

  // ── Static fetch (once) ────────────────────────────────
  useEffect(() => {
    fetch("/api/shipping")
      .then(r => r.ok ? r.json() as Promise<ShippingData> : null)
      .then(d => { if (d && !("error" in (d as object))) setShippingData(d); })
      .catch(() => {});

    Promise.all([
      fetch("/api/products").then(r => r.json()).then(d => (d.active as MLItem[]) ?? []),
      fetch("/api/billing/taxes").then(r => r.ok ? r.json() as Promise<TaxData> : null).catch(() => null),
      fetch("/api/costs").then(r => r.ok ? r.json() : []).catch(() => []) as
        Promise<Array<{ ml_id: string; costo: number; precio_lista?: number | null }>>,
    ]).then(([items, taxes, dbCosts]) => {
      setActiveItems(items);
      const cm: Record<string, { costo: number; precioLista: number | null }> = {};
      for (const c of dbCosts) cm[c.ml_id] = { costo: c.costo, precioLista: c.precio_lista ?? null };
      setCosts(cm);
      if (taxes && !("error" in (taxes as object))) setTaxData(taxes);
      setStaticLoaded(true);
    }).catch((e: Error) => { setFetchError(e.message); setLoading(false); });
  }, []);

  // ── Period fetch (reruns on date change) ───────────────
  const fetchProfit = useCallback(async (from: string, to: string) => {
    setProfLoading(true);
    try {
      const r = await fetch(`/api/dashboard?section=profitability&date_from=${from}&date_to=${to}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: DashboardData = await r.json();
      const pm: Record<string, ProfitItem> = {};
      for (const pi of data.profitabilityByItem ?? []) pm[pi.itemId] = pi;
      setProfitMap(pm);
    } catch (e: unknown) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setProfLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfit(dateFrom, dateTo); }, [dateFrom, dateTo, fetchProfit]);

  useEffect(() => {
    if (staticLoaded && !profLoading) setLoading(false);
  }, [staticLoaded, profLoading]);

  // ── Global weighted shipping rate ──────────────────────
  const shippingRate = useMemo(() => {
    if (!shippingData) return 0;
    return (shippingData.splitRatio.ml / 100) * (shippingData.mlShippingRate ?? 0)
      + (shippingData.splitRatio.propia / 100) * (shippingData.propiaShippingRate ?? 0);
  }, [shippingData]);

  // ── Enriched items (all active, cross-referenced) ──────
  const enrichedItems = useMemo<EnrichedItem[]>(() => {
    const taxRate = taxData?.ventasRate ?? 0;
    return activeItems.map(item => {
      const commRate = ML_COMMISSION[item.listing_type_id] ?? 0.12;
      const commAmt = item.price * commRate;
      const shippingAmt = item.price * (shippingRate / 100);
      const iibbAmt = item.price * (taxRate / 100);

      const costEntry = costs[item.id] ?? null;
      const unitCost = costEntry?.costo ?? null;
      const precioLista = costEntry?.precioLista ?? null;

      const unitProfit = unitCost !== null
        ? item.price - commAmt - unitCost - shippingAmt - iibbAmt
        : null;
      const unitMargin = unitProfit !== null && item.price > 0
        ? (unitProfit / item.price) * 100
        : null;

      const profitItem = profitMap[item.id];
      const unitsSold = profitItem?.unitsSold ?? 0;
      const grossRevenue = profitItem?.grossRevenue ?? 0;
      const totalSaleFees = profitItem?.totalSaleFees ?? 0;
      const categoryId = profitItem?.categoryId ?? "sin_categoria";
      const categoryName = profitItem?.categoryName ?? "Sin categoría";
      const totalProfit = unitProfit !== null && unitsSold > 0
        ? unitProfit * unitsSold
        : null;

      return {
        id: item.id,
        title: item.title,
        price: item.price,
        listing_type_id: item.listing_type_id,
        available_quantity: item.available_quantity,
        sold_quantity: item.sold_quantity,
        status: item.status,
        permalink: (item as MLItem & { permalink?: string }).permalink ?? `https://articulo.mercadolibre.com.ar/${item.id}`,
        categoryId,
        categoryName,
        unitsSold,
        grossRevenue,
        totalSaleFees,
        unitCost,
        precioLista,
        commRate,
        commAmt,
        shippingRate,
        shippingAmt,
        iibbRate: taxRate,
        iibbAmt,
        unitProfit,
        unitMargin,
        totalProfit,
      };
    });
  }, [activeItems, profitMap, costs, taxData, shippingRate]);

  // ── Sorted items ───────────────────────────────────────
  const sortedItems = useMemo(() => {
    const base = tableView === "totals"
      ? enrichedItems.filter(i => i.unitsSold > 0)
      : enrichedItems;
    const dir = sortDir === "desc" ? -1 : 1;
    return [...base].sort((a, b) => {
      const nullLast = (av: number | null, bv: number | null): number => {
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return dir * (av - bv);
      };
      switch (sortCol) {
        case "title":       return dir * a.title.localeCompare(b.title);
        case "price":       return dir * (a.price - b.price);
        case "commAmt":     return dir * (a.commAmt - b.commAmt);
        case "shippingAmt": return dir * (a.shippingAmt - b.shippingAmt);
        case "iibbAmt":     return dir * (a.iibbAmt - b.iibbAmt);
        case "unitCost":    return nullLast(a.unitCost, b.unitCost);
        case "unitProfit":  return nullLast(a.unitProfit, b.unitProfit);
        case "unitMargin":  return nullLast(a.unitMargin, b.unitMargin);
        case "unitsSold":   return dir * (a.unitsSold - b.unitsSold);
        case "grossRevenue":return dir * (a.grossRevenue - b.grossRevenue);
        case "totalProfit": return nullLast(a.totalProfit, b.totalProfit);
        default:            return 0;
      }
    });
  }, [enrichedItems, sortCol, sortDir, tableView]);

  // ── Category data (only items with sales) ─────────────
  const categoryData = useMemo<CategoryRow[]>(() => {
    const map: Record<string, {
      categoryId: string; categoryName: string;
      grossRevenue: number; totalSaleFees: number;
      unitsSold: number; skuCount: number; skusWithCost: number; partialProfit: number;
    }> = {};

    for (const item of enrichedItems.filter(i => i.unitsSold > 0)) {
      if (!map[item.categoryId]) {
        map[item.categoryId] = {
          categoryId: item.categoryId, categoryName: item.categoryName,
          grossRevenue: 0, totalSaleFees: 0,
          unitsSold: 0, skuCount: 0, skusWithCost: 0, partialProfit: 0,
        };
      }
      const cat = map[item.categoryId];
      cat.grossRevenue += item.grossRevenue;
      cat.totalSaleFees += item.totalSaleFees;
      cat.unitsSold += item.unitsSold;
      cat.skuCount++;
      if (item.totalProfit !== null) { cat.partialProfit += item.totalProfit; cat.skusWithCost++; }
    }

    return Object.values(map)
      .map(({ partialProfit, ...cat }) => {
        const allHaveCosts = cat.skusWithCost === cat.skuCount && cat.skuCount > 0;
        const netProfit = allHaveCosts ? partialProfit : null;
        const margin = netProfit !== null && cat.grossRevenue > 0
          ? (netProfit / cat.grossRevenue) * 100 : null;
        return { ...cat, netProfit, margin };
      })
      .sort((a, b) => b.grossRevenue - a.grossRevenue);
  }, [enrichedItems]);

  const chartData = categoryData.map(cat => ({
    name: cat.categoryName,
    margin: cat.margin ?? (cat.grossRevenue > 0
      ? ((cat.grossRevenue - cat.totalSaleFees) / cat.grossRevenue) * 100 : 0),
    hasRealMargin: cat.margin !== null,
  }));

  const handleSort = (col: SortCol) => {
    if (col === sortCol) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  // ── Derived counts ─────────────────────────────────────
  const withCostCount = enrichedItems.filter(i => i.unitCost !== null).length;
  const withSalesCount = enrichedItems.filter(i => i.unitsSold > 0).length;

  const taxMonthName = useMemo(() => {
    if (!taxData) return "";
    const d = new Date(taxData.period + "T12:00:00");
    return d.toLocaleString("es-AR", { month: "long" });
  }, [taxData]);

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
  const tdMono: React.CSSProperties = {
    padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: "12px",
  };
  const dRowStyle: React.CSSProperties = {
    display: "flex", justifyContent: "space-between", alignItems: "baseline",
    padding: "7px 0", borderBottom: "1px solid var(--border)",
  };
  const dLabel: React.CSSProperties = { fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" };
  const dValue: React.CSSProperties = { fontSize: "13px", fontFamily: "var(--font-mono)", fontWeight: "500" };

  const set = (field: keyof ProductCalc, value: string | number) =>
    setForm(f => ({ ...f, [field]: value }));

  const result = calcROI(form);
  const isProfitable = result.profit > 0;

  const SkeletonRows = ({ colSpan }: { colSpan: number }) => (
    <>
      {[1, 2, 3, 4, 5].map(i => (
        <tr key={i}>
          <td colSpan={colSpan} style={{ padding: "4px 0" }}>
            <div className="skeleton" style={{ height: "32px", borderRadius: "var(--radius)" }} />
          </td>
        </tr>
      ))}
    </>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>

      {/* ── Header ─────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{
            fontFamily: "var(--font-display)", fontSize: "clamp(22px, 4vw, 28px)",
            fontWeight: "800", letterSpacing: "-0.02em", marginBottom: "4px",
          }}>
            Rentabilidad
          </h1>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {profLoading ? "Cargando ventas…" : `Período: ${dateFrom} → ${dateTo}`}
          </p>
        </div>
        <DateRangePicker
          dateFrom={dateFrom}
          dateTo={dateTo}
          onChange={(from, to) => { setDateFrom(from); setDateTo(to); }}
        />
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
                <span style={{ color: "var(--yellow)", fontWeight: "600" }}>IIBB {taxMonthName}:</span>
                <span style={{ color: "var(--text)" }}>{taxData.ventasRate.toFixed(2)}%</span>
              </span>
            )}
            {shippingData && (
              <span style={{
                display: "inline-flex", alignItems: "center", gap: "4px",
                background: "rgba(96,165,250,0.08)", border: "1px solid rgba(96,165,250,0.2)",
                borderRadius: "20px", padding: "3px 10px",
                fontFamily: "var(--font-mono)", fontSize: "11px",
              }}>
                <span style={{ color: "#60a5fa", fontWeight: "600" }}>Envío ponderado:</span>
                <span style={{ color: "var(--text)" }}>{shippingRate.toFixed(1)}% del precio</span>
              </span>
            )}
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {loading
              ? "Cargando publicaciones…"
              : `${activeItems.length} activas · ${withSalesCount} con ventas · ${withCostCount} con costo · Hacé click para ver detalle`}
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
              {(["unit", "totals"] as const).map(v => (
                <button
                  key={v}
                  onClick={() => {
                    setTableView(v);
                    setSortCol(v === "unit" ? "unitProfit" : "grossRevenue");
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
                      <SortHeader label="Producto"    col="title"        sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Precio"      col="price"        sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Comisión"    col="commAmt"      sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label={`Envío${shippingRate > 0 ? ` (${shippingRate.toFixed(1)}%)` : ""}`} col="shippingAmt" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="IIBB"        col="iibbAmt"      sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Costo u."    col="unitCost"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Ganancia u." col="unitProfit"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Margen"      col="unitMargin"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                    </tr>
                  ) : (
                    <tr>
                      <SortHeader label="Producto"       col="title"        sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                      <SortHeader label="Uds."           col="unitsSold"    sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Revenue"        col="grossRevenue" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Ganancia total" col="totalProfit"  sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                      <SortHeader label="Margen"         col="unitMargin"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} align="right" />
                    </tr>
                  )}
                </thead>
                <tbody>
                  {loading ? (
                    <SkeletonRows colSpan={tableView === "unit" ? 8 : 5} />
                  ) : tableView === "unit" ? (
                    sortedItems.map(item => (
                      <tr key={item.id}
                        onClick={() => setSelectedItem(item)}
                        style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s", cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <td style={{ ...tdMono, maxWidth: "220px" }}>
                          <p style={{ fontFamily: "var(--font-display)", fontSize: "12px", fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</p>
                          <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-dim)", marginTop: "1px" }}>{item.id}</p>
                        </td>
                        <td style={{ ...tdMono, textAlign: "right" }}>{formatARS(item.price)}</td>
                        <td style={{ ...tdMono, textAlign: "right" }}>
                          <span style={{ color: "var(--red)" }}>-{formatARS(item.commAmt)}</span>
                          <span style={{ display: "block", fontSize: "10px", color: "var(--text-dim)" }}>{(item.commRate * 100).toFixed(1)}%</span>
                        </td>
                        <td style={{ ...tdMono, textAlign: "right" }}>
                          {shippingData === null
                            ? <span className="skeleton" style={{ display: "inline-block", width: "40px", height: "12px", borderRadius: "3px" }} />
                            : <span style={{ color: "var(--red)" }}>-{formatARS(item.shippingAmt)}</span>}
                        </td>
                        <td style={{ ...tdMono, textAlign: "right" }}>
                          {item.iibbAmt > 0
                            ? <span style={{ color: "var(--red)" }}>-{formatARS(item.iibbAmt)}</span>
                            : <span style={{ color: "var(--text-dim)" }}>—</span>}
                        </td>
                        <td style={{ ...tdMono, textAlign: "right", color: item.unitCost !== null ? "var(--text)" : "var(--text-dim)" }}>
                          {item.unitCost !== null ? `-${formatARS(item.unitCost)}` : "—"}
                        </td>
                        <td style={{ ...tdMono, textAlign: "right", fontWeight: "600", color: item.unitProfit === null ? "var(--text-dim)" : item.unitProfit >= 0 ? "var(--green)" : "var(--red)" }}>
                          {item.unitProfit !== null ? formatARS(item.unitProfit) : "—"}
                        </td>
                        <td style={{ ...tdMono, textAlign: "right" }}>
                          <MarginText margin={item.unitMargin} />
                        </td>
                      </tr>
                    ))
                  ) : (
                    sortedItems.map(item => (
                      <tr key={item.id}
                        onClick={() => setSelectedItem(item)}
                        style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s", cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <td style={{ ...tdMono, maxWidth: "220px" }}>
                          <p style={{ fontFamily: "var(--font-display)", fontSize: "12px", fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</p>
                          <p style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--text-dim)", marginTop: "1px" }}>{item.id}</p>
                        </td>
                        <td style={{ ...tdMono, textAlign: "right", color: "var(--text-muted)" }}>{item.unitsSold}</td>
                        <td style={{ ...tdMono, textAlign: "right" }}>{formatARS(item.grossRevenue)}</td>
                        <td style={{ ...tdMono, textAlign: "right", fontWeight: "600", color: item.totalProfit === null ? "var(--text-dim)" : item.totalProfit >= 0 ? "var(--green)" : "var(--red)" }}>
                          {item.totalProfit !== null ? formatARS(item.totalProfit) : "—"}
                        </td>
                        <td style={{ ...tdMono, textAlign: "right" }}>
                          <MarginText margin={item.unitMargin} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              {!loading && sortedItems.length === 0 && !fetchError && (
                <p style={{ textAlign: "center", padding: "32px", color: "var(--text-muted)", fontSize: "13px", fontFamily: "var(--font-mono)" }}>
                  {tableView === "totals" ? "Sin ventas en el período" : "Sin publicaciones activas"}
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
            Revenue y márgenes de productos con ventas en el período
          </p>
        </div>

        {loading && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: "12px", marginBottom: "24px" }}>
            {[1, 2, 3].map(i => (
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
              {categoryData.map(cat => (
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
              <input type="text" value={form.title} onChange={e => set("title", e.target.value)}
                placeholder="ej: Auriculares Bluetooth JBL" style={inputStyle} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div>
                <label style={labelStyle}>Costo ($)</label>
                <input type="number" value={form.costPrice || ""} onChange={e => set("costPrice", parseFloat(e.target.value) || 0)} placeholder="0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Precio de venta ($)</label>
                <input type="number" value={form.salePrice || ""} onChange={e => set("salePrice", parseFloat(e.target.value) || 0)} placeholder="0" style={inputStyle} />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Tipo de publicación</label>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                {ML_FEE_TYPES.map(t => (
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
                <input type="number" value={form.mlFeePercent} onChange={e => set("mlFeePercent", parseFloat(e.target.value) || 0)} style={{ ...inputStyle, width: "120px" }} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div>
                <label style={labelStyle}>Envío ($)</label>
                <input type="number" value={form.shippingCost || ""} onChange={e => set("shippingCost", parseFloat(e.target.value) || 0)} placeholder="0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Otros costos ($)</label>
                <input type="number" value={form.otherCosts || ""} onChange={e => set("otherCosts", parseFloat(e.target.value) || 0)} placeholder="Empaque, etc." style={inputStyle} />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Cantidad a vender</label>
              <input type="number" value={form.quantity} onChange={e => set("quantity", parseInt(e.target.value) || 1)} min={1} style={{ ...inputStyle, width: "120px" }} />
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
          <div
            onClick={() => setSelectedItem(null)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100, backdropFilter: "blur(2px)" }}
          />

          <div style={{
            position: "fixed", top: 0, right: 0, bottom: 0,
            width: "min(420px, 100vw)",
            background: "var(--surface)", borderLeft: "1px solid var(--border)",
            zIndex: 101, overflowY: "auto", display: "flex", flexDirection: "column",
          }}>
            {/* Header */}
            <div style={{
              padding: "24px 24px 20px", borderBottom: "1px solid var(--border)",
              display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px",
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontFamily: "var(--font-display)", fontSize: "14px", fontWeight: "700", marginBottom: "6px", lineHeight: "1.3" }}>
                  {selectedItem.title}
                </p>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <a
                    href={selectedItem.permalink} target="_blank" rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--yellow)", textDecoration: "none" }}
                  >
                    {selectedItem.id} ↗
                  </a>
                  <span style={{
                    fontSize: "10px", fontWeight: "600", fontFamily: "var(--font-display)",
                    color: STATUS_COLOR[selectedItem.status] ?? "var(--text-dim)",
                    background: `${STATUS_COLOR[selectedItem.status] ?? "#666"}20`,
                    border: `1px solid ${STATUS_COLOR[selectedItem.status] ?? "#666"}40`,
                    borderRadius: "4px", padding: "1px 7px",
                  }}>
                    {STATUS_LABEL[selectedItem.status] ?? selectedItem.status}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setSelectedItem(null)}
                style={{ background: "transparent", border: "none", color: "var(--text-muted)", fontSize: "18px", cursor: "pointer", padding: "2px 6px", flexShrink: 0, lineHeight: 1 }}
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: "20px", flex: 1 }}>

              {/* Per-unit breakdown */}
              <section>
                <p style={{ ...labelStyle, marginBottom: "12px" }}>Desglose por unidad</p>
                <div>
                  <div style={dRowStyle}>
                    <span style={dLabel}>Precio de venta</span>
                    <span style={{ ...dValue, color: "var(--text)", fontWeight: "700" }}>{formatARS(selectedItem.price)}</span>
                  </div>
                  <div style={dRowStyle}>
                    <span style={dLabel}>Comisión ML ({(selectedItem.commRate * 100).toFixed(1)}%)</span>
                    <span style={{ ...dValue, color: "var(--red)" }}>−{formatARS(selectedItem.commAmt)}</span>
                  </div>
                  <div style={dRowStyle}>
                    <span style={dLabel}>Costo producto</span>
                    <span style={{ ...dValue, color: selectedItem.unitCost !== null ? "var(--red)" : "var(--text-dim)" }}>
                      {selectedItem.unitCost !== null ? `−${formatARS(selectedItem.unitCost)}` : "Sin costo cargado"}
                    </span>
                  </div>
                  <div style={dRowStyle}>
                    <span style={dLabel}>
                      Envío est. ({selectedItem.shippingRate.toFixed(1)}%)
                    </span>
                    <span style={{ ...dValue, color: selectedItem.shippingAmt > 0 ? "var(--red)" : "var(--text-dim)" }}>
                      {selectedItem.shippingAmt > 0
                        ? `−${formatARS(selectedItem.shippingAmt)}`
                        : shippingData ? "—" : "Cargando…"}
                    </span>
                  </div>
                  <div style={{ ...dRowStyle, borderBottom: "none" }}>
                    <span style={dLabel}>IIBB ({selectedItem.iibbRate.toFixed(2)}%)</span>
                    <span style={{ ...dValue, color: selectedItem.iibbAmt > 0 ? "var(--red)" : "var(--text-dim)" }}>
                      {selectedItem.iibbAmt > 0
                        ? `−${formatARS(selectedItem.iibbAmt)}`
                        : taxData ? "—" : "Cargando…"}
                    </span>
                  </div>
                </div>

                {/* Profit box */}
                <div style={{
                  marginTop: "12px", padding: "14px",
                  background: selectedItem.unitProfit == null ? "var(--surface-2)" : selectedItem.unitProfit >= 0 ? "var(--green-dim)" : "var(--red-dim)",
                  border: `1px solid ${selectedItem.unitProfit == null ? "var(--border)" : selectedItem.unitProfit >= 0 ? "rgba(0,212,160,0.25)" : "rgba(255,68,88,0.25)"}`,
                  borderRadius: "var(--radius)",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px" }}>
                    <span style={{ ...labelStyle, marginBottom: 0 }}>Ganancia por unidad</span>
                    <span style={{
                      fontFamily: "var(--font-display)", fontSize: "20px", fontWeight: "800",
                      color: selectedItem.unitProfit == null ? "var(--text-dim)" : selectedItem.unitProfit >= 0 ? "var(--green)" : "var(--red)",
                    }}>
                      {selectedItem.unitProfit !== null ? formatARS(selectedItem.unitProfit) : "—"}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ ...labelStyle, marginBottom: 0 }}>Margen</span>
                    <span style={{
                      fontFamily: "var(--font-mono)", fontSize: "14px", fontWeight: "700",
                      color: selectedItem.unitMargin == null ? "var(--text-dim)"
                        : selectedItem.unitMargin > 20 ? "var(--green)"
                        : selectedItem.unitMargin >= 10 ? "var(--yellow)"
                        : "var(--red)",
                    }}>
                      {selectedItem.unitMargin !== null ? `${selectedItem.unitMargin.toFixed(1)}%` : "—"}
                    </span>
                  </div>
                  {selectedItem.unitProfit == null && (
                    <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: "6px" }}>
                      Cargá el costo del producto para calcular la ganancia
                    </p>
                  )}
                </div>
              </section>

              {/* Sales section */}
              {selectedItem.unitsSold > 0 && (
                <section>
                  <p style={{ ...labelStyle, marginBottom: "12px" }}>Ventas del período</p>
                  <div>
                    <div style={dRowStyle}>
                      <span style={dLabel}>Unidades vendidas</span>
                      <span style={{ ...dValue, color: "var(--text)" }}>{selectedItem.unitsSold}</span>
                    </div>
                    <div style={dRowStyle}>
                      <span style={dLabel}>Revenue total</span>
                      <span style={{ ...dValue, color: "var(--text)" }}>{formatARS(selectedItem.grossRevenue)}</span>
                    </div>
                    <div style={{ ...dRowStyle, borderBottom: "none" }}>
                      <span style={{ ...dLabel, fontWeight: "600" }}>Ganancia total est.</span>
                      <span style={{
                        ...dValue, fontWeight: "700",
                        color: selectedItem.totalProfit == null ? "var(--text-dim)"
                          : selectedItem.totalProfit >= 0 ? "var(--green)" : "var(--red)",
                      }}>
                        {selectedItem.totalProfit !== null ? formatARS(selectedItem.totalProfit) : "Cargá el costo"}
                      </span>
                    </div>
                  </div>
                </section>
              )}

              {/* Stock / price lista */}
              <div style={{
                display: "grid", gridTemplateColumns: selectedItem.precioLista !== null ? "1fr 1fr" : "1fr",
                gap: "12px", padding: "14px",
                background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)",
              }}>
                <div>
                  <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: "4px" }}>STOCK</p>
                  <p style={{
                    fontFamily: "var(--font-mono)", fontSize: "15px", fontWeight: "700",
                    color: selectedItem.available_quantity === 0 ? "var(--red)" : selectedItem.available_quantity <= 3 ? "var(--yellow)" : "var(--green)",
                  }}>
                    {selectedItem.available_quantity}
                  </p>
                </div>
                {selectedItem.precioLista !== null && (
                  <div>
                    <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: "4px" }}>P. LISTA</p>
                    <p style={{ fontFamily: "var(--font-mono)", fontSize: "15px", fontWeight: "700", color: "var(--text)" }}>
                      {formatARS(selectedItem.precioLista)}
                    </p>
                  </div>
                )}
              </div>
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
