// src/components/ui/DateRangePicker.tsx
"use client";

import type { CSSProperties } from "react";

interface Props {
  dateFrom: string;
  dateTo: string;
  onChange: (from: string, to: string) => void;
}

const INPUT: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "5px 10px",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: "12px",
  colorScheme: "dark",
  cursor: "pointer",
  outline: "none",
};

export function defaultDateRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const to = now.toISOString().split("T")[0];
  return { from, to };
}

export default function DateRangePicker({ dateFrom, dateTo, onChange }: Props) {
  const today = new Date().toISOString().split("T")[0];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
      <input
        type="date"
        value={dateFrom}
        max={dateTo || today}
        onChange={(e) => { if (e.target.value) onChange(e.target.value, dateTo); }}
        style={INPUT}
      />
      <span style={{ fontSize: "11px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>→</span>
      <input
        type="date"
        value={dateTo}
        min={dateFrom}
        max={today}
        onChange={(e) => { if (e.target.value) onChange(dateFrom, e.target.value); }}
        style={INPUT}
      />
    </div>
  );
}
