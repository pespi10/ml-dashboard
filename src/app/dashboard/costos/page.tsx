// src/app/dashboard/costos/page.tsx
"use client";

import { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import { formatARS } from "@/lib/ml-api";

type ParsedRow = { id: string; title: string; cost: number };

function parseCSV(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const lines = text.trim().split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    // Handle quoted CSV fields
    const cols: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === "," && !inQuote) { cols.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cols.push(cur.trim());

    if (cols.length < 2) continue;
    const id = cols[0].trim();
    if (!id || id.toLowerCase() === "id" || id.toLowerCase() === "sku") continue;

    let title = "";
    let cost = 0;
    if (cols.length >= 3) {
      title = cols[1].trim();
      cost = parseFloat(cols[2]) || 0;
    } else {
      cost = parseFloat(cols[1]) || 0;
    }
    if (!id || cost <= 0) continue;
    rows.push({ id, title, cost });
  }
  return rows;
}

function parseXLSX(buffer: ArrayBuffer): ParsedRow[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1 });
  const rows: ParsedRow[] = [];

  for (const row of json) {
    if (!row || row.length < 2) continue;
    const id = String(row[0]).trim();
    if (!id || id.toLowerCase() === "id" || id.toLowerCase() === "sku") continue;

    let title = "";
    let cost = 0;
    if (row.length >= 3) {
      title = String(row[1]).trim();
      cost = parseFloat(String(row[2])) || 0;
    } else {
      cost = parseFloat(String(row[1])) || 0;
    }
    if (!id || cost <= 0) continue;
    rows.push({ id, title, cost });
  }
  return rows;
}

function loadFromStorage() {
  if (typeof window === "undefined") return { costs: {}, titles: {} };
  try {
    const costs: Record<string, number> = JSON.parse(localStorage.getItem("ml_costs") || "{}");
    const titles: Record<string, string> = JSON.parse(localStorage.getItem("ml_costs_titles") || "{}");
    return { costs, titles };
  } catch {
    return { costs: {}, titles: {} };
  }
}

const inputStyle = {
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "8px 12px",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: "13px",
  outline: "none",
};

const labelStyle: React.CSSProperties = {
  fontSize: "10px",
  fontWeight: "600",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

export default function CostosPage() {
  const initial = loadFromStorage();
  const [costs, setCosts] = useState<Record<string, number>>(initial.costs);
  const [titles, setTitles] = useState<Record<string, string>>(initial.titles);

  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ParsedRow[] | null>(null);
  const [allParsed, setAllParsed] = useState<ParsedRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ updated: number; added: number } | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback((file: File) => {
    setParseError(null);
    setSummary(null);
    setPreview(null);

    const name = file.name.toLowerCase();
    const reader = new FileReader();

    if (name.endsWith(".csv")) {
      reader.onload = (e) => {
        const text = e.target?.result as string;
        const rows = parseCSV(text);
        if (!rows.length) {
          setParseError("No se encontraron datos válidos. Revisá el formato del CSV.");
          return;
        }
        setAllParsed(rows);
        setPreview(rows.slice(0, 10));
      };
      reader.readAsText(file, "utf-8");
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      reader.onload = (e) => {
        try {
          const rows = parseXLSX(e.target?.result as ArrayBuffer);
          if (!rows.length) {
            setParseError("No se encontraron datos válidos. Revisá el formato del Excel.");
            return;
          }
          setAllParsed(rows);
          setPreview(rows.slice(0, 10));
        } catch {
          setParseError("Error al leer el archivo Excel. Asegurate de que sea un .xlsx válido.");
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setParseError("Formato no soportado. Subí un archivo .csv o .xlsx");
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleConfirm = () => {
    const newCosts = { ...costs };
    const newTitles = { ...titles };
    let updated = 0;
    let added = 0;

    for (const row of allParsed) {
      if (newCosts[row.id] !== undefined) updated++;
      else added++;
      newCosts[row.id] = row.cost;
      if (row.title) newTitles[row.id] = row.title;
    }

    localStorage.setItem("ml_costs", JSON.stringify(newCosts));
    localStorage.setItem("ml_costs_titles", JSON.stringify(newTitles));
    setCosts(newCosts);
    setTitles(newTitles);
    setSummary({ updated, added });
    setPreview(null);
    setAllParsed([]);
  };

  const handleDelete = (id: string) => {
    const newCosts = { ...costs };
    const newTitles = { ...titles };
    delete newCosts[id];
    delete newTitles[id];
    localStorage.setItem("ml_costs", JSON.stringify(newCosts));
    localStorage.setItem("ml_costs_titles", JSON.stringify(newTitles));
    setCosts(newCosts);
    setTitles(newTitles);
  };

  const startEdit = (id: string) => {
    setEditingId(id);
    setEditValue(String(costs[id]));
  };

  const commitEdit = () => {
    if (!editingId) return;
    const val = parseFloat(editValue);
    if (!isNaN(val) && val > 0) {
      const newCosts = { ...costs, [editingId]: val };
      localStorage.setItem("ml_costs", JSON.stringify(newCosts));
      setCosts(newCosts);
    }
    setEditingId(null);
  };

  const downloadTemplate = () => {
    const csv =
      "id,titulo,costo\nMLA123456789,Auriculares JBL,15000\nMLA987654321,Zapatillas Nike,25000\nMLA555555555,Cargador USB-C,3500\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "plantilla_costos.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const entries = Object.entries(costs).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      {/* Header */}
      <div>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(22px, 4vw, 28px)",
            fontWeight: "800",
            letterSpacing: "-0.02em",
            marginBottom: "4px",
          }}
        >
          Costos de Productos
        </h1>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          Cargá tus costos vía CSV o Excel para calcular rentabilidad real
        </p>
      </div>

      {/* Upload area */}
      <div
        style={{
          background: "var(--surface)",
          border: `1px solid ${dragging ? "var(--yellow)" : "var(--border)"}`,
          borderRadius: "var(--radius-lg)",
          padding: "28px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <p style={{ ...labelStyle }}>Subir archivo</p>
          <button
            onClick={downloadTemplate}
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "6px 14px",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--yellow)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          >
            ↓ Descargar plantilla CSV
          </button>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${dragging ? "var(--yellow)" : "var(--border-light)"}`,
            borderRadius: "var(--radius-lg)",
            padding: "48px 24px",
            textAlign: "center",
            cursor: "pointer",
            background: dragging ? "var(--yellow-glow)" : "var(--surface-2)",
            transition: "all 0.15s",
          }}
        >
          <div style={{
            fontSize: "36px", marginBottom: "12px",
            filter: dragging ? "brightness(1.5)" : "none",
            transition: "filter 0.15s",
          }}>
            ◉
          </div>
          <p style={{
            fontFamily: "var(--font-display)",
            fontSize: "15px",
            fontWeight: "600",
            color: dragging ? "var(--yellow)" : "var(--text)",
            marginBottom: "6px",
          }}>
            {dragging ? "Soltar archivo aquí" : "Arrastrá tu archivo o hacé click para seleccionar"}
          </p>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            Formatos soportados: .csv · .xlsx · .xls
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) processFile(f); e.target.value = ""; }}
          />
        </div>

        {/* Format hint */}
        <div style={{
          marginTop: "16px",
          padding: "14px 18px",
          background: "var(--surface-2)",
          borderRadius: "var(--radius)",
          display: "flex",
          alignItems: "center",
          gap: "16px",
          flexWrap: "wrap",
        }}>
          <p style={{ ...labelStyle }}>Formato esperado:</p>
          <code style={{
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            color: "var(--yellow)",
            background: "rgba(255,230,0,0.07)",
            padding: "4px 10px",
            borderRadius: "4px",
          }}>
            MLA123456789, Nombre del producto (opcional), 15000
          </code>
        </div>

        {/* Error */}
        {parseError && (
          <div style={{
            marginTop: "16px",
            padding: "12px 16px",
            background: "var(--red-dim)",
            border: "1px solid rgba(255,68,88,0.25)",
            borderRadius: "var(--radius)",
            color: "var(--red)",
            fontSize: "13px",
            fontFamily: "var(--font-mono)",
          }}>
            ✗ {parseError}
          </div>
        )}

        {/* Summary */}
        {summary && (
          <div style={{
            marginTop: "16px",
            padding: "12px 16px",
            background: "var(--green-dim)",
            border: "1px solid rgba(0,212,160,0.25)",
            borderRadius: "var(--radius)",
            color: "var(--green)",
            fontSize: "13px",
            fontFamily: "var(--font-mono)",
          }}>
            ✓ {summary.updated} productos actualizados · {summary.added} productos nuevos
          </div>
        )}
      </div>

      {/* Preview */}
      {preview && (
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "24px",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <p style={{ ...labelStyle, marginBottom: "4px" }}>Vista previa</p>
              <p style={{ fontSize: "13px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                {preview.length} de {allParsed.length} registros{allParsed.length > 10 ? " (mostrando primeros 10)" : ""}
              </p>
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={() => { setPreview(null); setAllParsed([]); }}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "8px 16px",
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-display)",
                  fontWeight: "600",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Cancelar
              </button>
              <button
                onClick={handleConfirm}
                style={{
                  background: "var(--yellow)",
                  border: "none",
                  borderRadius: "var(--radius)",
                  padding: "8px 20px",
                  color: "#000",
                  fontFamily: "var(--font-display)",
                  fontWeight: "700",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Confirmar {allParsed.length} registros
              </button>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["ID / SKU", "Título", "Costo"].map((h) => (
                    <th
                      key={h}
                      style={{
                        ...labelStyle,
                        padding: "8px 12px",
                        textAlign: "left",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{
                      padding: "10px 12px",
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      color: "var(--yellow)",
                    }}>
                      {row.id}
                    </td>
                    <td style={{
                      padding: "10px 12px",
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      color: "var(--text-muted)",
                      maxWidth: "300px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {row.title || <span style={{ color: "var(--text-dim)" }}>—</span>}
                    </td>
                    <td style={{
                      padding: "10px 12px",
                      fontFamily: "var(--font-mono)",
                      fontSize: "13px",
                      color: "var(--green)",
                      fontWeight: "500",
                    }}>
                      {formatARS(row.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Costs table */}
      {entries.length > 0 && !preview && (
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "24px",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <p style={{ ...labelStyle, marginBottom: "4px" }}>Costos cargados</p>
              <p style={{ fontSize: "13px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                {entries.length} producto{entries.length !== 1 ? "s" : ""} con costo registrado
              </p>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["ID / SKU", "Título", "Costo", ""].map((h, i) => (
                    <th
                      key={i}
                      style={{
                        ...labelStyle,
                        padding: "8px 12px",
                        textAlign: i === 3 ? "right" : "left",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map(([id, cost]) => (
                  <tr
                    key={id}
                    style={{ borderBottom: "1px solid var(--border)" }}
                  >
                    <td style={{
                      padding: "10px 12px",
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      color: "var(--yellow)",
                    }}>
                      {id}
                    </td>
                    <td style={{
                      padding: "10px 12px",
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      color: "var(--text-muted)",
                      maxWidth: "280px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {titles[id] || <span style={{ color: "var(--text-dim)" }}>—</span>}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {editingId === id ? (
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                          <input
                            type="number"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingId(null); }}
                            autoFocus
                            style={{ ...inputStyle, width: "120px" }}
                          />
                          <button
                            onClick={commitEdit}
                            style={{
                              background: "var(--yellow)",
                              border: "none",
                              borderRadius: "var(--radius)",
                              padding: "5px 12px",
                              color: "#000",
                              fontFamily: "var(--font-display)",
                              fontWeight: "700",
                              fontSize: "12px",
                              cursor: "pointer",
                            }}
                          >
                            ✓
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            style={{
                              background: "transparent",
                              border: "1px solid var(--border)",
                              borderRadius: "var(--radius)",
                              padding: "5px 10px",
                              color: "var(--text-muted)",
                              fontFamily: "var(--font-mono)",
                              fontSize: "12px",
                              cursor: "pointer",
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEdit(id)}
                          style={{
                            background: "transparent",
                            border: "none",
                            padding: "0",
                            fontFamily: "var(--font-mono)",
                            fontSize: "13px",
                            fontWeight: "500",
                            color: "var(--green)",
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                          title="Click para editar"
                        >
                          {formatARS(cost)}
                          <span style={{ color: "var(--text-dim)", fontSize: "10px", marginLeft: "6px" }}>✎</span>
                        </button>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right" }}>
                      <button
                        onClick={() => handleDelete(id)}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--text-dim)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "13px",
                          cursor: "pointer",
                          padding: "4px 8px",
                          borderRadius: "var(--radius)",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--red)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
                        title="Eliminar"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {entries.length === 0 && !preview && (
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "48px 24px",
          textAlign: "center",
        }}>
          <p style={{ fontSize: "32px", marginBottom: "12px" }}>◉</p>
          <p style={{
            fontFamily: "var(--font-display)",
            fontSize: "15px",
            fontWeight: "600",
            color: "var(--text-muted)",
            marginBottom: "6px",
          }}>
            Sin costos cargados
          </p>
          <p style={{ fontSize: "12px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            Subí un CSV o Excel con tus costos para empezar
          </p>
        </div>
      )}
    </div>
  );
}
