// src/app/dashboard/rentabilidad/page.tsx
"use client";

import { useState } from "react";
import { formatARS } from "@/lib/ml-api";

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

export default function RentabilidadPage() {
  const [form, setForm] = useState<ProductCalc>({
    title: "",
    costPrice: 0,
    salePrice: 0,
    mlFeePercent: 13,
    shippingCost: 0,
    otherCosts: 0,
    quantity: 1,
  });

  const result = calcROI(form);
  const isProfitable = result.profit > 0;

  const set = (field: keyof ProductCalc, value: string | number) =>
    setForm((f) => ({ ...f, [field]: value }));

  const inputStyle = {
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "10px 14px",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: "14px",
    outline: "none",
    width: "100%",
  };

  const labelStyle = {
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
    color: "var(--text-muted)",
    marginBottom: "6px",
    display: "block",
    fontFamily: "var(--font-mono)",
  };

  return (
    <div>
      <div style={{ marginBottom: "28px" }}>
        <h1 style={{
          fontFamily: "var(--font-display)", fontSize: "clamp(22px, 4vw, 28px)",
          fontWeight: "800", letterSpacing: "-0.02em", marginBottom: "4px",
        }}>Calculadora de Rentabilidad</h1>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          Calculá margen y ROI antes de publicar
        </p>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "24px",
        alignItems: "start",
      }} className="rent-grid">

        {/* Form */}
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "28px",
          display: "flex",
          flexDirection: "column",
          gap: "20px",
        }}>
          <div>
            <label style={labelStyle}>Nombre del producto</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="ej: Auriculares Bluetooth JBL"
              style={inputStyle}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <label style={labelStyle}>Costo ($)</label>
              <input
                type="number"
                value={form.costPrice || ""}
                onChange={(e) => set("costPrice", parseFloat(e.target.value) || 0)}
                placeholder="0"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Precio de venta ($)</label>
              <input
                type="number"
                value={form.salePrice || ""}
                onChange={(e) => set("salePrice", parseFloat(e.target.value) || 0)}
                placeholder="0"
                style={inputStyle}
              />
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
                    background: form.mlFeePercent === t.value && t.value !== 0
                      ? "var(--yellow-dim)"
                      : "var(--surface-2)",
                    border: `1px solid ${form.mlFeePercent === t.value && t.value !== 0 ? "rgba(255,230,0,0.25)" : "var(--border)"}`,
                    color: form.mlFeePercent === t.value && t.value !== 0
                      ? "var(--yellow)"
                      : "var(--text-muted)",
                    borderRadius: "20px",
                    padding: "5px 12px",
                    fontSize: "12px",
                    fontFamily: "var(--font-display)",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  {t.label} {t.value > 0 ? `(${t.value}%)` : ""}
                </button>
              ))}
            </div>
            <div style={{ marginTop: "10px" }}>
              <label style={labelStyle}>Comisión ML (%)</label>
              <input
                type="number"
                value={form.mlFeePercent}
                onChange={(e) => set("mlFeePercent", parseFloat(e.target.value) || 0)}
                style={{ ...inputStyle, width: "120px" }}
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            <div>
              <label style={labelStyle}>Envío ($)</label>
              <input
                type="number"
                value={form.shippingCost || ""}
                onChange={(e) => set("shippingCost", parseFloat(e.target.value) || 0)}
                placeholder="0"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Otros costos ($)</label>
              <input
                type="number"
                value={form.otherCosts || ""}
                onChange={(e) => set("otherCosts", parseFloat(e.target.value) || 0)}
                placeholder="Empaque, etc."
                style={inputStyle}
              />
            </div>
          </div>

          <div>
            <label style={labelStyle}>Cantidad a vender</label>
            <input
              type="number"
              value={form.quantity}
              onChange={(e) => set("quantity", parseInt(e.target.value) || 1)}
              min={1}
              style={{ ...inputStyle, width: "120px" }}
            />
          </div>
        </div>

        {/* Results */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {/* ROI badge */}
          <div style={{
            background: isProfitable ? "var(--green-dim)" : "var(--red-dim)",
            border: `1px solid ${isProfitable ? "rgba(0,212,160,0.25)" : "rgba(255,68,88,0.25)"}`,
            borderRadius: "var(--radius-lg)",
            padding: "28px",
            textAlign: "center",
          }}>
            <p style={{
              fontSize: "11px", fontWeight: "600", letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: isProfitable ? "var(--green)" : "var(--red)",
              fontFamily: "var(--font-mono)",
              marginBottom: "12px",
            }}>
              {isProfitable ? "✓ Rentable" : "✗ No rentable"}
            </p>
            <p style={{
              fontFamily: "var(--font-display)",
              fontSize: "56px",
              fontWeight: "800",
              letterSpacing: "-0.03em",
              color: isProfitable ? "var(--green)" : "var(--red)",
              lineHeight: 1,
              marginBottom: "8px",
            }}>
              {result.roi.toFixed(1)}%
            </p>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              ROI por unidad
            </p>
          </div>

          {/* Breakdown */}
          <div style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
          }}>
            {[
              { label: "Precio de venta", value: form.salePrice, color: "var(--text)" },
              { label: `Comisión ML (${form.mlFeePercent}%)`, value: -result.mlFee, color: "var(--red)" },
              { label: "Envío", value: -form.shippingCost, color: "var(--red)" },
              { label: "Otros costos", value: -form.otherCosts, color: "var(--red)" },
              { label: "Costo del producto", value: -form.costPrice, color: "var(--red)" },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "13px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  {label}
                </span>
                <span style={{ fontSize: "14px", fontFamily: "var(--font-mono)", fontWeight: "500", color }}>
                  {value < 0 ? "-" : ""}{formatARS(Math.abs(value))}
                </span>
              </div>
            ))}

            <div style={{
              borderTop: "1px solid var(--border)",
              paddingTop: "14px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}>
              <span style={{
                fontFamily: "var(--font-display)", fontSize: "15px",
                fontWeight: "700",
              }}>Ganancia neta</span>
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: "18px", fontWeight: "700",
                color: isProfitable ? "var(--green)" : "var(--red)",
              }}>
                {formatARS(result.profit)}
              </span>
            </div>

            <div style={{
              background: "var(--surface-2)",
              borderRadius: "var(--radius)",
              padding: "14px",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "12px",
            }}>
              <div>
                <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: "4px" }}>
                  MARGEN
                </p>
                <p style={{
                  fontFamily: "var(--font-display)", fontSize: "20px",
                  fontWeight: "800", color: isProfitable ? "var(--yellow)" : "var(--red)",
                }}>
                  {result.margin.toFixed(1)}%
                </p>
              </div>
              <div>
                <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginBottom: "4px" }}>
                  GANANCIA TOTAL ({form.quantity} u.)
                </p>
                <p style={{
                  fontFamily: "var(--font-display)", fontSize: "20px",
                  fontWeight: "800", color: isProfitable ? "var(--green)" : "var(--red)",
                }}>
                  {formatARS(result.totalProfit)}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .rent-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
