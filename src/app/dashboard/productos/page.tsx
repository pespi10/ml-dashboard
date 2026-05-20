// src/app/dashboard/productos/page.tsx
"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import type { MLItem } from "@/lib/ml-api";
import { formatARS } from "@/lib/ml-api";

// ── Constants ─────────────────────────────────────────────────────────────────

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
  under_review: "#60a5fa",
};

// ML commission rates by listing type
const ML_COMMISSION: Record<string, number> = {
  gold_special: 0.125,
  gold_pro: 0.09,
  gold_premium: 0.16,
  silver: 0.08,
  bronze: 0.06,
  free: 0,
};

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = "active" | "paused" | "closed" | "all";

type ProductCost = {
  ml_id: string;
  costo: number;
  titulo_ml?: string | null;
};

type ShippingData = {
  avgSellerCost: number;
  mlShippingRate: number;
  propiaShippingRate: number;
  splitRatio: { ml: number; propia: number };
  pctSellerPays: number;
};

type TaxData = {
  ventasRate: number;
};

// ── Styles ────────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontSize: "10px",
  fontWeight: "600",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

const sectionTitle: React.CSSProperties = {
  ...labelStyle,
  marginBottom: "12px",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  padding: "7px 0",
  borderBottom: "1px solid var(--border)",
};

const rowLabel: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

const rowValue: React.CSSProperties = {
  fontSize: "13px",
  fontFamily: "var(--font-mono)",
  fontWeight: "500",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProductosPage() {
  // Product list state
  const [active, setActive] = useState<MLItem[]>([]);
  const [paused, setPaused] = useState<MLItem[]>([]);
  const [closed, setClosed] = useState<MLItem[]>([]);
  const [closedTotal, setClosedTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("active");
  const [search, setSearch] = useState("");

  // Shared data (loaded once)
  const [costs, setCosts] = useState<Record<string, ProductCost>>({});
  const [shipping, setShipping] = useState<ShippingData | null>(null);
  const [taxes, setTaxes] = useState<TaxData | null>(null);
  const [profitMap, setProfitMap] = useState<Record<string, number>>({}); // itemId → sold qty

  // Drawer state
  const [selected, setSelected] = useState<MLItem | null>(null);
  const [costInput, setCostInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);
  const [editing, setEditing] = useState(false);

  // ── Data loading ────────────────────────────────────────────────────────────

  useEffect(() => {
    Promise.all([
      fetch("/api/products").then(r => r.json()),
      fetch("/api/costs").then(r => r.ok ? r.json() : []),
      fetch("/api/shipping").then(r => r.ok ? r.json() : null),
      fetch("/api/billing/taxes").then(r => r.ok ? r.json() : null),
      fetch("/api/dashboard?section=profitability").then(r => r.ok ? r.json() : null),
    ]).then(([products, costsData, shippingData, taxData, profitData]) => {
      setActive(products.active ?? []);
      setPaused(products.paused ?? []);
      setClosed(products.closed ?? []);
      setClosedTotal(products.closedTotal ?? 0);

      const costsMap: Record<string, ProductCost> = {};
      for (const c of (costsData as ProductCost[] ?? [])) costsMap[c.ml_id] = c;
      setCosts(costsMap);

      if (shippingData && !("error" in shippingData)) {
        setShipping({
          avgSellerCost: shippingData.avgSellerCost ?? 0,
          mlShippingRate: shippingData.mlShippingRate ?? 0,
          propiaShippingRate: shippingData.propiaShippingRate ?? 0,
          splitRatio: shippingData.splitRatio ?? { ml: 100, propia: 0 },
          pctSellerPays: shippingData.pctSellerPays ?? 100,
        });
      }
      if (taxData?.ventasRate != null) setTaxes({ ventasRate: taxData.ventasRate });

      if (profitData?.profitabilityByItem) {
        const pm: Record<string, number> = {};
        for (const it of profitData.profitabilityByItem) pm[it.itemId] = it.unitsSold;
        setProfitMap(pm);
      }
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const reloadCosts = useCallback(async () => {
    const res = await fetch("/api/costs");
    if (!res.ok) return;
    const costsData: ProductCost[] = await res.json();
    const costsMap: Record<string, ProductCost> = {};
    for (const c of costsData) costsMap[c.ml_id] = c;
    setCosts(costsMap);
  }, []);

  // ── Panel open/close ─────────────────────────────────────────────────────────

  const openPanel = (item: MLItem) => {
    setSelected(item);
    setSavedMsg(false);
    setEditing(false);
    setCostInput("");
  };

  const closePanel = () => setSelected(null);

  // ── Save cost ────────────────────────────────────────────────────────────────

  const saveCost = async () => {
    if (!selected) return;
    const val = parseFloat(costInput);
    if (isNaN(val) || val <= 0) return;
    setSaving(true);
    try {
      await fetch("/api/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ml_id: selected.id, nombre: selected.title, costo: val }),
      });
      await reloadCosts();
      setSavedMsg(true);
      setEditing(false);
      setCostInput("");
    } finally {
      setSaving(false);
    }
  };

  // ── Filtering ────────────────────────────────────────────────────────────────

  const allItems = useMemo(() => [...active, ...paused, ...closed], [active, paused, closed]);
  const tabItems: Record<Tab, MLItem[]> = { active, paused, closed, all: allItems };
  const filtered = useMemo(() => {
    const base = tabItems[tab];
    if (!search) return base;
    const q = search.toLowerCase();
    return base.filter(i => i.title.toLowerCase().includes(q) || i.id.toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, search, active, paused, closed]);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "active", label: "Activas", count: active.length },
    { key: "paused", label: "Pausadas", count: paused.length },
    { key: "closed", label: "Cerradas", count: closedTotal },
    { key: "all", label: "Todas", count: active.length + paused.length + closedTotal },
  ];

  // ── Panel calculations ───────────────────────────────────────────────────────

  const panelCalc = useMemo(() => {
    if (!selected) return null;
    const price = selected.price;
    const commRate = ML_COMMISSION[selected.listing_type_id] ?? 0.12;
    const commAmt = price * commRate;
    const costo = costs[selected.id]?.costo ?? null;
    const iibbRate = taxes?.ventasRate ?? null;
    const iibbAmt = iibbRate != null ? price * (iibbRate / 100) : null;

    const mlShippingCost = shipping != null
      ? price * (shipping.mlShippingRate / 100) * (shipping.splitRatio.ml / 100)
      : null;
    const propiaShippingCost = shipping != null
      ? price * (shipping.propiaShippingRate / 100) * (shipping.splitRatio.propia / 100)
      : null;
    const avgShip = mlShippingCost != null && propiaShippingCost != null
      ? mlShippingCost + propiaShippingCost
      : null;

    const canCompute = costo != null && avgShip != null && iibbAmt != null;
    const ganancia = canCompute ? price - commAmt - costo! - avgShip! - iibbAmt! : null;
    const margen = ganancia != null && price > 0 ? ganancia / price : null;

    return { price, commRate, commAmt, costo, avgShip, mlShippingCost, propiaShippingCost, iibbRate, iibbAmt, ganancia, margen };
  }, [selected, costs, shipping, taxes]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(22px,4vw,28px)", fontWeight: "800", letterSpacing: "-0.02em", marginBottom: "4px" }}>
          Productos
        </h1>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {loading ? "Cargando publicaciones…" : `${active.length} activas · ${paused.length} pausadas · ${closedTotal} cerradas`}
        </p>
      </div>

      {/* Tabs + search */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "20px", alignItems: "center" }}>
        {tabs.map(({ key, label, count }) => (
          <button key={key} onClick={() => setTab(key)} style={{
            background: tab === key ? "var(--yellow-dim)" : "var(--surface)",
            border: `1px solid ${tab === key ? "rgba(255,230,0,0.25)" : "var(--border)"}`,
            color: tab === key ? "var(--yellow)" : "var(--text-muted)",
            borderRadius: "20px", padding: "6px 14px",
            fontSize: "12px", fontFamily: "var(--font-display)", fontWeight: "600", cursor: "pointer",
          }}>
            {label} · {loading ? "…" : count}
          </button>
        ))}
        <input
          type="text"
          placeholder="Buscar publicación..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginLeft: "auto", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 14px", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: "12px", outline: "none", width: "220px" }}
        />
      </div>

      {tab === "closed" && !loading && closedTotal > closed.length && (
        <div style={{ marginBottom: "16px", padding: "10px 16px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          Mostrando {closed.length} de {closedTotal} publicaciones cerradas
        </div>
      )}

      {/* Table */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
        <div className="table-header" style={{ display: "grid", gridTemplateColumns: "1fr 100px 80px 80px 100px", gap: "16px", padding: "12px 20px", borderBottom: "1px solid var(--border)", fontSize: "10px", fontWeight: "600", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          <span>Publicación</span><span>Precio</span><span>Stock</span><span>Vendidos</span><span>Estado</span>
        </div>

        {loading && (
          <div style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "12px" }}>
            {[...Array(5)].map((_, i) => <div key={i} className="skeleton" style={{ height: "52px", borderRadius: "8px" }} />)}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div style={{ padding: "48px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
            {search ? "Sin resultados para esa búsqueda" : "Sin publicaciones en esta categoría"}
          </div>
        )}

        {!loading && filtered.map((item, i) => (
          <div
            key={item.id}
            onClick={() => openPanel(item)}
            style={{ display: "grid", gridTemplateColumns: "1fr 100px 80px 80px 100px", gap: "16px", padding: "14px 20px", borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none", alignItems: "center", transition: "background 0.1s", cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: "13px", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: "2px" }}>{item.title}</p>
              <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{item.id}</p>
            </div>
            <span style={{ fontSize: "13px", fontFamily: "var(--font-mono)", color: "var(--text)" }}>{formatARS(item.price)}</span>
            <span style={{ fontSize: "14px", fontFamily: "var(--font-mono)", fontWeight: "700", color: item.available_quantity === 0 ? "var(--red)" : item.available_quantity <= 3 ? "var(--yellow)" : "var(--text)" }}>
              {item.available_quantity}
            </span>
            <span style={{ fontSize: "13px", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{item.sold_quantity}</span>
            <span style={{ fontSize: "11px", fontWeight: "600", fontFamily: "var(--font-display)", color: STATUS_COLOR[item.status] || "var(--text-dim)", display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: STATUS_COLOR[item.status] || "var(--text-dim)", flexShrink: 0 }} />
              {STATUS_LABEL[item.status] || item.status}
            </span>
          </div>
        ))}
      </div>

      {/* ── Detail drawer ── */}
      {selected && panelCalc && (
        <>
          {/* Backdrop */}
          <div onClick={closePanel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100, backdropFilter: "blur(2px)" }} />

          {/* Panel */}
          <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(420px, 100vw)", background: "var(--surface)", borderLeft: "1px solid var(--border)", zIndex: 101, overflowY: "auto", display: "flex", flexDirection: "column" }}>

            {/* Header */}
            <div style={{ padding: "24px 24px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontFamily: "var(--font-display)", fontSize: "14px", fontWeight: "700", marginBottom: "6px", lineHeight: "1.3" }}>{selected.title}</p>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <a
                    href={selected.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--yellow)", textDecoration: "none" }}
                  >
                    {selected.id} ↗
                  </a>
                  <span style={{ fontSize: "10px", fontWeight: "600", fontFamily: "var(--font-display)", color: STATUS_COLOR[selected.status], background: `${STATUS_COLOR[selected.status]}20`, border: `1px solid ${STATUS_COLOR[selected.status]}40`, borderRadius: "4px", padding: "1px 7px" }}>
                    {STATUS_LABEL[selected.status] || selected.status}
                  </span>
                </div>
              </div>
              <button onClick={closePanel} style={{ background: "transparent", border: "none", color: "var(--text-muted)", fontSize: "18px", cursor: "pointer", padding: "2px 6px", flexShrink: 0, lineHeight: 1 }}>✕</button>
            </div>

            {/* Body */}
            <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: "24px" }}>

              {/* ── Stock y ventas ── */}
              <section>
                <p style={sectionTitle}>Stock y ventas</p>
                <div>
                  <div style={rowStyle}>
                    <span style={rowLabel}>Stock actual</span>
                    <span style={{ ...rowValue, color: selected.available_quantity === 0 ? "var(--red)" : selected.available_quantity <= 3 ? "var(--yellow)" : "var(--green)", fontWeight: "700" }}>
                      {selected.available_quantity} unid.
                    </span>
                  </div>
                  <div style={rowStyle}>
                    <span style={rowLabel}>Vendidos (último mes)</span>
                    <span style={rowValue}>{profitMap[selected.id] != null ? `${profitMap[selected.id]} unid.` : `${selected.sold_quantity} total`}</span>
                  </div>
                  <div style={{ ...rowStyle, borderBottom: "none" }}>
                    <span style={rowLabel}>Precio actual en ML</span>
                    <span style={{ ...rowValue, color: "var(--text)" }}>{formatARS(selected.price)}</span>
                  </div>
                </div>
              </section>

              {/* ── Desglose de costos ── */}
              <section>
                <p style={sectionTitle}>Desglose de costos</p>
                <div>
                  <div style={rowStyle}>
                    <span style={rowLabel}>Costo del producto</span>
                    <span style={{ ...rowValue, color: panelCalc.costo != null ? "var(--text)" : "var(--text-dim)" }}>
                      {panelCalc.costo != null ? formatARS(panelCalc.costo) : "Sin costo cargado"}
                    </span>
                  </div>
                  <div style={rowStyle}>
                    <span style={rowLabel}>
                      Comisión ML ({selected.listing_type_id.replace("gold_", "").replace("_", " ")} · {(panelCalc.commRate * 100).toFixed(1)}%)
                    </span>
                    <span style={{ ...rowValue, color: "var(--red)" }}>−{formatARS(panelCalc.commAmt)}</span>
                  </div>
                  <div style={rowStyle}>
                    <span style={rowLabel}>
                      Envío ML (~{shipping?.splitRatio.ml.toFixed(0) ?? "?"}%)
                    </span>
                    <span style={{ ...rowValue, color: panelCalc.mlShippingCost != null && panelCalc.mlShippingCost > 0 ? "var(--red)" : "var(--text-dim)" }}>
                      {panelCalc.mlShippingCost != null
                        ? `${shipping!.mlShippingRate.toFixed(1)}% → −${formatARS(panelCalc.mlShippingCost)}`
                        : "Sin datos"}
                    </span>
                  </div>
                  <div style={rowStyle}>
                    <span style={rowLabel}>
                      Envío propio (~{shipping?.splitRatio.propia.toFixed(0) ?? "?"}%)
                    </span>
                    <span style={{ ...rowValue, color: "var(--text-muted)" }}>
                      {panelCalc.propiaShippingCost != null
                        ? <>{shipping!.propiaShippingRate.toFixed(1)}% → −{formatARS(panelCalc.propiaShippingCost)}<span style={{ fontSize: "9px", color: "var(--text-dim)", marginLeft: "4px" }}>est.</span></>
                        : "Sin datos"}
                    </span>
                  </div>
                  <div style={{ ...rowStyle }}>
                    <span style={rowLabel}>
                      IIBB estimado{panelCalc.iibbRate != null ? ` (${panelCalc.iibbRate.toFixed(2)}%)` : ""}
                    </span>
                    <span style={{ ...rowValue, color: panelCalc.iibbAmt != null ? "var(--red)" : "var(--text-dim)" }}>
                      {panelCalc.iibbAmt != null ? `−${formatARS(panelCalc.iibbAmt)}` : "Sin datos"}
                    </span>
                  </div>

                  {/* Ganancia */}
                  <div style={{ marginTop: "12px", padding: "12px 14px", background: panelCalc.ganancia == null ? "var(--surface-2)" : panelCalc.ganancia >= 0 ? "var(--green-dim)" : "var(--red-dim)", border: `1px solid ${panelCalc.ganancia == null ? "var(--border)" : panelCalc.ganancia >= 0 ? "rgba(0,212,160,0.25)" : "rgba(255,68,88,0.25)"}`, borderRadius: "var(--radius)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "4px" }}>
                      <span style={{ ...labelStyle }}>Ganancia estimada</span>
                      <span style={{ fontFamily: "var(--font-display)", fontSize: "18px", fontWeight: "800", color: panelCalc.ganancia == null ? "var(--text-dim)" : panelCalc.ganancia >= 0 ? "var(--green)" : "var(--red)" }}>
                        {panelCalc.ganancia != null ? formatARS(panelCalc.ganancia) : "—"}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ ...labelStyle }}>Margen estimado</span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "13px", fontWeight: "600", color: panelCalc.margen == null ? "var(--text-dim)" : panelCalc.margen >= 0 ? "var(--green)" : "var(--red)" }}>
                        {panelCalc.margen != null ? `${(panelCalc.margen * 100).toFixed(1)}%` : "—"}
                      </span>
                    </div>
                    {panelCalc.ganancia == null && (
                      <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: "6px" }}>
                        Cargá el costo del producto para calcular la ganancia
                      </p>
                    )}
                  </div>
                </div>
              </section>

              {/* ── Cargar / editar costo ── */}
              <section style={{ paddingBottom: "24px" }}>
                <p style={sectionTitle}>Costo unitario</p>

                {savedMsg && (
                  <div style={{ marginBottom: "12px", padding: "8px 12px", background: "var(--green-dim)", border: "1px solid rgba(0,212,160,0.25)", borderRadius: "var(--radius)", color: "var(--green)", fontSize: "12px", fontFamily: "var(--font-mono)" }}>
                    ✓ Costo guardado
                  </div>
                )}

                {costs[selected.id] && !editing ? (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
                    <div>
                      <p style={{ ...labelStyle, marginBottom: "2px" }}>Costo actual</p>
                      <p style={{ fontFamily: "var(--font-mono)", fontSize: "15px", fontWeight: "600", color: "var(--green)" }}>{formatARS(costs[selected.id].costo)}</p>
                    </div>
                    <button
                      onClick={() => { setEditing(true); setCostInput(String(costs[selected.id].costo)); setSavedMsg(false); }}
                      style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 14px", color: "var(--text-muted)", fontFamily: "var(--font-display)", fontWeight: "600", fontSize: "12px", cursor: "pointer" }}
                    >
                      Editar
                    </button>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    <div>
                      <label style={{ ...labelStyle, display: "block", marginBottom: "6px" }}>Costo unitario ($)</label>
                      <input
                        type="number"
                        value={costInput}
                        onChange={(e) => setCostInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveCost(); if (e.key === "Escape") { setEditing(false); setCostInput(""); } }}
                        placeholder="0"
                        autoFocus
                        style={{ width: "100%", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "9px 12px", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: "14px", outline: "none", boxSizing: "border-box" }}
                      />
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      {editing && (
                        <button onClick={() => { setEditing(false); setCostInput(""); }} style={{ flex: 1, background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "9px", color: "var(--text-muted)", fontFamily: "var(--font-display)", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}>
                          Cancelar
                        </button>
                      )}
                      <button
                        onClick={saveCost}
                        disabled={saving || !costInput}
                        style={{ flex: 2, background: saving ? "var(--surface-2)" : "var(--yellow)", border: "none", borderRadius: "var(--radius)", padding: "9px", color: saving ? "var(--text-muted)" : "#000", fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "13px", cursor: saving ? "default" : "pointer", opacity: saving ? 0.7 : 1 }}
                      >
                        {saving ? "Guardando…" : "Guardar"}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </div>
        </>
      )}

      <style>{`
        @media (max-width: 640px) {
          .table-header { display: none !important; }
        }
      `}</style>
    </div>
  );
}
