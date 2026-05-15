// src/components/charts/RevenueChart.tsx
"use client";

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import { format, parseISO } from "date-fns";
import { es } from "date-fns/locale";

interface RevenueChartProps {
  data: { date: string; revenue: number; orders: number }[];
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;

  return (
    <div style={{
      background: "var(--surface-2)",
      border: "1px solid var(--border-light)",
      borderRadius: "8px",
      padding: "12px 16px",
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
    }}>
      <p style={{ color: "var(--text-muted)", marginBottom: "8px" }}>
        {format(parseISO(label), "d MMM", { locale: es })}
      </p>
      <p style={{ color: "var(--yellow)", fontWeight: "500" }}>
        ${new Intl.NumberFormat("es-AR").format(payload[0]?.value ?? 0)}
      </p>
      <p style={{ color: "var(--text-dim)" }}>
        {payload[1]?.value ?? 0} órdenes
      </p>
    </div>
  );
};

export default function RevenueChart({ data }: RevenueChartProps) {
  return (
    <div style={{
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)",
      padding: "24px",
    }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "24px",
      }}>
        <div>
          <h3 style={{
            fontFamily: "var(--font-display)",
            fontSize: "16px",
            fontWeight: "700",
            marginBottom: "4px",
          }}>Revenue diario</h3>
          <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>Últimos 30 días</p>
        </div>
        <div style={{
          display: "flex",
          gap: "16px",
          fontSize: "11px",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
        }}>
          <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ width: "8px", height: "2px", background: "var(--yellow)", display: "inline-block", borderRadius: "2px" }} />
            Revenue
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffe600" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#ffe600" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}
            tickFormatter={(v) => format(parseISO(v), "d/M")}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}
            tickFormatter={(v) => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`}
            axisLine={false}
            tickLine={false}
            width={52}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: "var(--border-light)", strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey="revenue"
            stroke="var(--yellow)"
            strokeWidth={2}
            fill="url(#revGrad)"
            dot={false}
            activeDot={{ r: 4, fill: "var(--yellow)", stroke: "var(--bg)", strokeWidth: 2 }}
          />
          <Area
            type="monotone"
            dataKey="orders"
            stroke="var(--green)"
            strokeWidth={1.5}
            fill="transparent"
            dot={false}
            activeDot={{ r: 3, fill: "var(--green)", stroke: "var(--bg)", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
