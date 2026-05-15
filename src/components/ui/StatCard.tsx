// src/components/ui/StatCard.tsx
"use client";

interface StatCardProps {
  label: string;
  value: string;
  subvalue?: string;
  change?: number; // porcentaje
  accent?: "yellow" | "green" | "red" | "blue";
  delay?: number;
}

export default function StatCard({
  label, value, subvalue, change, accent = "yellow", delay = 0,
}: StatCardProps) {
  const accentColor = {
    yellow: "var(--yellow)",
    green: "var(--green)",
    red: "var(--red)",
    blue: "var(--blue)",
  }[accent];

  const positive = change !== undefined && change >= 0;

  return (
    <div
      className="animate-fade-up"
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        position: "relative",
        overflow: "hidden",
        animationDelay: `${delay}ms`,
      }}
    >
      {/* Accent bar */}
      <div style={{
        position: "absolute",
        top: 0, left: 0,
        width: "3px", height: "100%",
        background: accentColor,
        opacity: 0.8,
      }} />

      <p style={{
        fontSize: "11px",
        fontWeight: "500",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
      }}>{label}</p>

      <p style={{
        fontFamily: "var(--font-display)",
        fontSize: "clamp(22px, 4vw, 28px)",
        fontWeight: "800",
        letterSpacing: "-0.02em",
        color: "var(--text)",
        lineHeight: 1,
      }}>{value}</p>

      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "2px" }}>
        {change !== undefined && (
          <span style={{
            fontSize: "12px",
            fontFamily: "var(--font-mono)",
            color: positive ? "var(--green)" : "var(--red)",
            background: positive ? "var(--green-dim)" : "var(--red-dim)",
            padding: "2px 8px",
            borderRadius: "4px",
          }}>
            {positive ? "+" : ""}{change.toFixed(1)}%
          </span>
        )}
        {subvalue && (
          <span style={{
            fontSize: "12px",
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
          }}>{subvalue}</span>
        )}
      </div>
    </div>
  );
}
