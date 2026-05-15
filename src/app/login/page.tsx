// src/app/login/page.tsx
"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginContent() {
  const params = useSearchParams();
  const error = params.get("error");

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      position: "relative",
      zIndex: 1,
    }}>
      <div className="animate-fade-up" style={{
        width: "100%",
        maxWidth: "380px",
        display: "flex",
        flexDirection: "column",
        gap: "32px",
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center" }}>
          <div style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "10px",
            marginBottom: "8px",
          }}>
            <div style={{
              width: "36px",
              height: "36px",
              background: "var(--yellow)",
              borderRadius: "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "18px",
              fontWeight: "800",
              color: "#000",
              fontFamily: "var(--font-display)",
            }}>M</div>
            <span style={{
              fontFamily: "var(--font-display)",
              fontSize: "22px",
              fontWeight: "700",
              letterSpacing: "-0.02em",
              color: "var(--text)",
            }}>ML Dashboard</span>
          </div>
          <p style={{
            fontSize: "13px",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}>Control de rentabilidades y stock</p>
        </div>

        {/* Card */}
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "32px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}>
          <div>
            <h1 style={{
              fontFamily: "var(--font-display)",
              fontSize: "20px",
              fontWeight: "700",
              marginBottom: "8px",
            }}>Conectá tu cuenta</h1>
            <p style={{
              fontSize: "13px",
              color: "var(--text-muted)",
              lineHeight: 1.6,
            }}>
              Autorizá el acceso a tu cuenta de Mercado Libre para ver tus ventas, stock y rentabilidades en tiempo real.
            </p>
          </div>

          {error && (
            <div style={{
              background: "var(--red-dim)",
              border: "1px solid var(--red)",
              borderRadius: "var(--radius)",
              padding: "12px 16px",
              fontSize: "13px",
              color: "var(--red)",
            }}>
              {error === "no_code" && "Error en la autorización. Intentá de nuevo."}
              {error === "auth_failed" && "No se pudo conectar con Mercado Libre. Verificá tus credenciales."}
              {!["no_code", "auth_failed"].includes(error) && "Error desconocido. Intentá de nuevo."}
            </div>
          )}

          <a
            href="/api/auth/login"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "10px",
              background: "var(--yellow)",
              color: "#000",
              border: "none",
              borderRadius: "var(--radius)",
              padding: "14px 24px",
              fontSize: "14px",
              fontWeight: "600",
              fontFamily: "var(--font-display)",
              cursor: "pointer",
              textDecoration: "none",
              transition: "opacity 0.15s",
              letterSpacing: "0.01em",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.88")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="9" stroke="#000" strokeWidth="1.5" />
              <path d="M6.5 10h7M10.5 7l3 3-3 3" stroke="#000" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Conectar con Mercado Libre
          </a>

          <div style={{
            borderTop: "1px solid var(--border)",
            paddingTop: "16px",
          }}>
            <p style={{ fontSize: "11px", color: "var(--text-dim)", lineHeight: 1.6 }}>
              Solo lectura. No se realizan acciones en tu cuenta sin tu confirmación. Los tokens se guardan en una cookie segura.
            </p>
          </div>
        </div>

        {/* Permisos requeridos */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "8px",
        }}>
          {["Órdenes de venta", "Publicaciones", "Estadísticas", "Preguntas"].map((p) => (
            <div key={p} style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "10px 12px",
              fontSize: "11px",
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}>
              <span style={{ color: "var(--green)", fontSize: "10px" }}>●</span>
              {p}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
