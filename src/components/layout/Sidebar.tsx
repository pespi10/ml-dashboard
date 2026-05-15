// src/components/layout/Sidebar.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/dashboard",          label: "Overview",    icon: "⬡" },
  { href: "/dashboard/productos", label: "Productos",   icon: "◈" },
  { href: "/dashboard/ventas",    label: "Ventas",      icon: "◆" },
  { href: "/dashboard/rentabilidad", label: "Rentabilidad", icon: "◇" },
];

export default function Sidebar() {
  const path = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* ── Mobile top bar ─────────────────────────────────────────── */}
      <header style={{
        display: "none",
        position: "fixed",
        top: 0, left: 0, right: 0,
        height: "56px",
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 20px",
        zIndex: 100,
      }} className="mobile-header">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{
            width: "28px", height: "28px",
            background: "var(--yellow)", borderRadius: "6px",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "var(--font-display)", fontWeight: "800", fontSize: "14px", color: "#000",
          }}>M</div>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "16px" }}>ML Dashboard</span>
        </div>
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          style={{
            background: "none", border: "1px solid var(--border)",
            borderRadius: "6px", padding: "6px 10px",
            color: "var(--text)", cursor: "pointer", fontSize: "16px",
          }}
        >
          {mobileOpen ? "✕" : "≡"}
        </button>
      </header>

      {/* ── Mobile nav drawer ──────────────────────────────────────── */}
      {mobileOpen && (
        <div
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.7)",
            zIndex: 99,
          }}
          onClick={() => setMobileOpen(false)}
        >
          <nav
            style={{
              position: "absolute", top: "56px", left: 0, right: 0,
              background: "var(--surface)",
              borderBottom: "1px solid var(--border)",
              padding: "16px",
              display: "flex", flexDirection: "column", gap: "4px",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                style={{
                  display: "flex", alignItems: "center", gap: "12px",
                  padding: "12px 16px",
                  borderRadius: "var(--radius)",
                  textDecoration: "none",
                  fontSize: "14px",
                  fontFamily: "var(--font-display)",
                  fontWeight: "600",
                  background: path === item.href ? "var(--yellow-dim)" : "transparent",
                  color: path === item.href ? "var(--yellow)" : "var(--text-muted)",
                  border: path === item.href ? "1px solid rgba(255,230,0,0.2)" : "1px solid transparent",
                }}
              >
                <span style={{ fontSize: "16px" }}>{item.icon}</span>
                {item.label}
              </Link>
            ))}
            <div style={{ height: "1px", background: "var(--border)", margin: "8px 0" }} />
            <a
              href="/api/auth/logout"
              style={{
                display: "flex", alignItems: "center", gap: "12px",
                padding: "12px 16px",
                borderRadius: "var(--radius)",
                textDecoration: "none",
                fontSize: "14px",
                fontFamily: "var(--font-display)",
                fontWeight: "600",
                color: "var(--text-muted)",
              }}
            >
              <span>⤺</span> Cerrar sesión
            </a>
          </nav>
        </div>
      )}

      {/* ── Desktop sidebar ─────────────────────────────────────────── */}
      <aside className="desktop-sidebar" style={{
        width: "220px",
        minHeight: "100vh",
        background: "var(--surface)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        padding: "24px 12px",
        position: "fixed",
        top: 0, left: 0,
        zIndex: 50,
      }}>
        {/* Logo */}
        <div style={{
          display: "flex", alignItems: "center", gap: "10px",
          padding: "8px 12px",
          marginBottom: "32px",
        }}>
          <div style={{
            width: "32px", height: "32px",
            background: "var(--yellow)", borderRadius: "8px",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "var(--font-display)", fontWeight: "800", fontSize: "16px", color: "#000",
          }}>M</div>
          <span style={{
            fontFamily: "var(--font-display)", fontWeight: "700",
            fontSize: "15px", letterSpacing: "-0.01em",
          }}>ML Dashboard</span>
        </div>

        {/* Nav */}
        <nav style={{ display: "flex", flexDirection: "column", gap: "2px", flex: 1 }}>
          <p style={{
            fontSize: "10px", fontWeight: "600", letterSpacing: "0.1em",
            color: "var(--text-dim)", padding: "0 12px 8px",
            textTransform: "uppercase",
          }}>Secciones</p>
          {NAV.map((item) => {
            const active = path === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                style={{
                  display: "flex", alignItems: "center", gap: "10px",
                  padding: "9px 12px",
                  borderRadius: "var(--radius)",
                  textDecoration: "none",
                  fontSize: "13px",
                  fontFamily: "var(--font-display)",
                  fontWeight: active ? "600" : "500",
                  background: active ? "var(--yellow-dim)" : "transparent",
                  color: active ? "var(--yellow)" : "var(--text-muted)",
                  border: active ? "1px solid rgba(255,230,0,0.15)" : "1px solid transparent",
                  transition: "all 0.15s",
                }}
              >
                <span style={{ fontSize: "14px", opacity: active ? 1 : 0.5 }}>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Bottom */}
        <div style={{
          borderTop: "1px solid var(--border)",
          paddingTop: "16px",
          marginTop: "16px",
        }}>
          <a
            href="/api/auth/logout"
            style={{
              display: "flex", alignItems: "center", gap: "10px",
              padding: "9px 12px",
              borderRadius: "var(--radius)",
              textDecoration: "none",
              fontSize: "13px",
              fontFamily: "var(--font-display)",
              color: "var(--text-dim)",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--red)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
          >
            <span>⤺</span> Cerrar sesión
          </a>
        </div>
      </aside>

      <style>{`
        @media (max-width: 768px) {
          .mobile-header { display: flex !important; }
          .desktop-sidebar { display: none !important; }
        }
      `}</style>
    </>
  );
}
