// src/app/dashboard/costos/page.tsx
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import { formatARS } from "@/lib/ml-api";

// ── Types ────────────────────────────────────────────────────────────────────

type EanRow = {
  ean: string;
  codigo: string;
  nombre: string;
  costo: number;
  precio_lista: number;
};

type ProductCostRow = {
  ml_id: string;
  ean?: string | null;
  codigo?: string | null;
  nombre?: string | null;
  titulo_ml?: string | null;
  costo: number;
  precio_lista?: number | null;
  match_method?: string | null;
};

type UploadResult = { nuevos: number; actualizados: number; sinMatch: number };

// ── Parsing helpers ───────────────────────────────────────────────────────────

function normCol(s: string): string {
  return s.trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "_");
}
function buildColMap(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  headers.forEach((h, i) => { map[normCol(h)] = i; });
  return map;
}
function colIdx(map: Record<string, number>, ...candidates: string[]): number {
  for (const c of candidates) if (map[c] !== undefined) return map[c];
  return -1;
}
function parseNum(s: string | number | undefined | null): number {
  if (s == null) return 0;
  if (typeof s === "number") return s;
  const v = s.trim().replace(/\s/g, "");
  if (!v) return 0;
  if (v.includes(".") && v.includes(",")) {
    return v.lastIndexOf(".") < v.lastIndexOf(",")
      ? parseFloat(v.replace(/\./g, "").replace(",", ".")) || 0
      : parseFloat(v.replace(/,/g, "")) || 0;
  }
  if (v.includes(",")) {
    const parts = v.split(",");
    return parts.length === 2 && parts[1].length <= 2
      ? parseFloat(v.replace(",", ".")) || 0
      : parseFloat(v.replace(/,/g, "")) || 0;
  }
  if (v.includes(".")) {
    const parts = v.split(".");
    if (parts.length === 2 && parts[1].length === 3 && !isNaN(Number(parts[0])))
      return parseFloat(v.replace(/\./g, "")) || 0;
  }
  return parseFloat(v) || 0;
}
function splitCsvLine(line: string, delim: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === delim) { cols.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}
function extractEanRows(headers: string[], dataRows: string[][]): EanRow[] {
  const map = buildColMap(headers);
  const iEan   = colIdx(map, "ean", "barcode", "codigo_barra", "cod_barra", "gtin");
  const iCod   = colIdx(map, "codigo", "sku", "cod", "id", "referencia");
  const iNom   = colIdx(map, "nombre", "descripcion", "producto", "name", "titulo");
  const iCosto = colIdx(map, "costo", "precio_costo", "costo_neto");
  const iLista = colIdx(map, "precio_lista", "lista", "pvp", "precio_publico", "p_lista");
  if (iEan === -1) return [];
  const rows: EanRow[] = [];
  for (const cols of dataRows) {
    const ean = String(cols[iEan] ?? "").replace(/\D/g, "");
    if (!ean) continue;
    const costo = parseNum(iCosto >= 0 ? cols[iCosto] : undefined);
    if (costo <= 0) continue;
    rows.push({
      ean,
      codigo: iCod  >= 0 ? (cols[iCod]  ?? "").trim() : "",
      nombre: iNom  >= 0 ? (cols[iNom]  ?? "").trim() : "",
      costo,
      precio_lista: parseNum(iLista >= 0 ? cols[iLista] : undefined),
    });
  }
  return rows;
}
function parseEanCSV(text: string): EanRow[] {
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const lines = clean.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const delim = lines[0].split(";").length > lines[0].split(",").length ? ";" : ",";
  const headers = splitCsvLine(lines[0], delim);
  const dataRows = lines.slice(1).map(l => splitCsvLine(l, delim));
  return extractEanRows(headers, dataRows);
}
function parseEanXLSX(buffer: ArrayBuffer): EanRow[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, raw: false });
  if (json.length < 2) return [];
  const headers = (json[0] as (string | number)[]).map(c => String(c));
  const dataRows = json.slice(1).map(row => (row as (string | number)[]).map(c => String(c ?? "")));
  return extractEanRows(headers, dataRows);
}

// ── Styles ────────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontSize: "10px",
  fontWeight: "600",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

const PAGE_SIZE = 50;

// ── Component ─────────────────────────────────────────────────────────────────

export default function CostosPage() {
  // Upload state
  const [dragging, setDragging] = useState(false);
  const [parsed, setParsed] = useState<EanRow[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // DB table state
  const [dbRows, setDbRows] = useState<ProductCostRow[]>([]);
  const [dbLoading, setDbLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tablePage, setTablePage] = useState(1);

  const loadDbRows = useCallback(async () => {
    setDbLoading(true);
    try {
      const res = await fetch("/api/costs");
      if (res.ok) setDbRows(await res.json());
    } finally {
      setDbLoading(false);
    }
  }, []);

  useEffect(() => { loadDbRows(); }, [loadDbRows]);

  // ── File parsing ─────────────────────────────────────────────────────────

  const processFile = useCallback((file: File) => {
    setParseError(null);
    setParsed(null);
    setUploadResult(null);
    const name = file.name.toLowerCase();
    const reader = new FileReader();
    if (name.endsWith(".csv")) {
      reader.onload = (e) => {
        const rows = parseEanCSV(e.target?.result as string);
        if (!rows.length) { setParseError("No se detectaron columnas EAN/Costo válidas. Revisá el formato."); return; }
        setParsed(rows);
      };
      reader.readAsText(file, "utf-8");
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      reader.onload = (e) => {
        try {
          const rows = parseEanXLSX(e.target?.result as ArrayBuffer);
          if (!rows.length) { setParseError("No se detectaron columnas EAN/Costo válidas. Revisá el formato."); return; }
          setParsed(rows);
        } catch { setParseError("Error al leer el archivo Excel."); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setParseError("Formato no soportado. Subí un .csv o .xlsx");
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  // ── Upload confirm ────────────────────────────────────────────────────────

  const handleConfirm = async () => {
    if (!parsed) return;
    setUploading(true);
    try {
      const res = await fetch("/api/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await res.json();
      if (!res.ok) {
        setParseError(data.error ?? "Error al guardar");
      } else {
        setUploadResult(data as UploadResult);
        setParsed(null);
        await loadDbRows();
      }
    } finally {
      setUploading(false);
    }
  };

  // ── CSV export ────────────────────────────────────────────────────────────

  const downloadCSV = () => {
    const header = "ml_id,nombre,costo,precio_lista,ean,codigo,match_method";
    const lines = dbRows.map(r => [
      r.ml_id,
      `"${(r.titulo_ml ?? r.nombre ?? "").replace(/"/g, '""')}"`,
      r.costo,
      r.precio_lista ?? 0,
      r.ean ?? "",
      r.codigo ?? "",
      r.match_method ?? "",
    ].join(","));
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "costos.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Table filtering & pagination ─────────────────────────────────────────

  const q = search.toLowerCase();
  const filtered = dbRows.filter(r =>
    !q ||
    (r.titulo_ml ?? r.nombre ?? "").toLowerCase().includes(q) ||
    (r.ean ?? "").includes(q) ||
    (r.codigo ?? "").toLowerCase().includes(q) ||
    r.ml_id.toLowerCase().includes(q)
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((tablePage - 1) * PAGE_SIZE, tablePage * PAGE_SIZE);

  const handleSearch = (v: string) => { setSearch(v); setTablePage(1); };

  // ── Render ────────────────────────────────────────────────────────────────

  const matchColor = (m?: string | null) =>
    m === "gtin" ? "var(--green)" : m === "order_sku" ? "var(--yellow)" : m === "attribute_sku" ? "#ff8c00" : "var(--text-dim)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Header */}
      <div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(22px,4vw,28px)", fontWeight: "800", letterSpacing: "-0.02em", marginBottom: "4px" }}>
          Costos de Productos
        </h1>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          Subí tu lista con EAN → el match con ML se hace automáticamente
        </p>
      </div>

      {/* ── Upload section ── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "28px" }}>
        <p style={{ ...labelStyle, marginBottom: "16px" }}>Cargar lista de costos</p>

        {/* Drop zone — only shown when no file is parsed */}
        {!parsed && (
          <>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragging ? "var(--yellow)" : "var(--border-light)"}`,
                borderRadius: "var(--radius-lg)", padding: "40px 24px", textAlign: "center",
                cursor: "pointer", background: dragging ? "var(--yellow-glow)" : "var(--surface-2)", transition: "all 0.15s",
              }}
            >
              <div style={{ fontSize: "28px", marginBottom: "8px" }}>⊞</div>
              <p style={{ fontFamily: "var(--font-display)", fontSize: "14px", fontWeight: "600", color: dragging ? "var(--yellow)" : "var(--text)", marginBottom: "4px" }}>
                {dragging ? "Soltar archivo aquí" : "Arrastrá o hacé click para seleccionar"}
              </p>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                .csv · .xlsx — columnas: ean · codigo · nombre · costo · precio_lista
              </p>
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) processFile(f); e.target.value = ""; }} />
            </div>

            {parseError && (
              <div style={{ marginTop: "14px", padding: "12px 16px", background: "var(--red-dim)", border: "1px solid rgba(255,68,88,0.25)", borderRadius: "var(--radius)", color: "var(--red)", fontSize: "13px", fontFamily: "var(--font-mono)" }}>
                ✗ {parseError}
              </div>
            )}
          </>
        )}

        {/* Preview */}
        {parsed && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div>
                <p style={{ fontFamily: "var(--font-display)", fontSize: "15px", fontWeight: "700", color: "var(--text)" }}>
                  {parsed.length} productos detectados
                </p>
                {parsed.length > 10 && (
                  <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                    Mostrando primeros 10
                  </p>
                )}
              </div>
              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  onClick={() => { setParsed(null); setParseError(null); }}
                  style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 16px", color: "var(--text-muted)", fontFamily: "var(--font-display)", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
                >
                  Cancelar
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={uploading}
                  style={{ background: uploading ? "var(--surface-2)" : "var(--yellow)", border: "none", borderRadius: "var(--radius)", padding: "8px 24px", color: uploading ? "var(--text-muted)" : "#000", fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "13px", cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.7 : 1 }}
                >
                  {uploading ? "Procesando…" : `Confirmar subida de ${parsed.length} productos`}
                </button>
              </div>
            </div>

            <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Código", "Nombre", "EAN", "Costo", "Precio Lista"].map((h, i) => (
                      <th key={h} style={{ ...labelStyle, padding: "8px 12px", textAlign: i >= 3 ? "right" : "left", borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.slice(0, 10).map((row, i) => (
                    <tr key={i} style={{ borderBottom: i < 9 ? "1px solid var(--border)" : "none" }}>
                      <td style={{ padding: "9px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-dim)" }}>{row.codigo || "—"}</td>
                      <td style={{ padding: "9px 12px", fontSize: "12px", color: "var(--text-muted)", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.nombre || "—"}</td>
                      <td style={{ padding: "9px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--yellow)" }}>{row.ean}</td>
                      <td style={{ padding: "9px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--green)", fontWeight: "600", textAlign: "right" }}>{formatARS(row.costo)}</td>
                      <td style={{ padding: "9px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", textAlign: "right" }}>{row.precio_lista > 0 ? formatARS(row.precio_lista) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Upload result */}
        {uploadResult && !parsed && (
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginTop: "4px" }}>
            <div style={{ background: "var(--green-dim)", border: "1px solid rgba(0,212,160,0.2)", borderRadius: "var(--radius)", padding: "12px 20px", textAlign: "center" }}>
              <p style={{ fontFamily: "var(--font-display)", fontSize: "24px", fontWeight: "800", color: "var(--green)" }}>{uploadResult.nuevos}</p>
              <p style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>nuevos</p>
            </div>
            <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 20px", textAlign: "center" }}>
              <p style={{ fontFamily: "var(--font-display)", fontSize: "24px", fontWeight: "800", color: "var(--yellow)" }}>{uploadResult.actualizados}</p>
              <p style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>actualizados</p>
            </div>
            <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 20px", textAlign: "center" }}>
              <p style={{ fontFamily: "var(--font-display)", fontSize: "24px", fontWeight: "800", color: "var(--text-dim)" }}>{uploadResult.sinMatch}</p>
              <p style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>sin match en ML</p>
            </div>
            <button
              onClick={() => { setUploadResult(null); }}
              style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "12px 16px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "12px", cursor: "pointer", alignSelf: "center" }}
            >
              Subir otro archivo
            </button>
          </div>
        )}
      </div>

      {/* ── DB table ── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", gap: "12px", flexWrap: "wrap" }}>
          <div>
            <p style={{ ...labelStyle, marginBottom: "2px" }}>Costos en base de datos</p>
            <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {filtered.length}{filtered.length !== dbRows.length ? `/${dbRows.length}` : ""} producto{dbRows.length !== 1 ? "s" : ""}
            </p>
          </div>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <input
              type="text"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Buscar nombre, EAN, MLA ID…"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "7px 12px", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: "12px", outline: "none", width: "220px" }}
            />
            {dbRows.length > 0 && (
              <button
                onClick={downloadCSV}
                style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "7px 14px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "12px", cursor: "pointer", whiteSpace: "nowrap" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--yellow)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
              >
                ↓ Descargar CSV
              </button>
            )}
          </div>
        </div>

        {dbLoading ? (
          <p style={{ textAlign: "center", padding: "32px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "13px" }}>
            Cargando…
          </p>
        ) : dbRows.length === 0 ? (
          <p style={{ textAlign: "center", padding: "32px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "13px" }}>
            Sin costos cargados. Subí un archivo para comenzar.
          </p>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Nombre", "Costo", "P. Lista", "MLA ID", "Match"].map((h, i) => (
                      <th key={h} style={{ ...labelStyle, padding: "8px 12px", textAlign: i === 1 || i === 2 ? "right" : "left", borderBottom: "1px solid var(--border)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row, i) => (
                    <tr key={row.ml_id}
                      style={{ borderBottom: i < pageRows.length - 1 ? "1px solid var(--border)" : "none" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <td style={{ padding: "9px 12px", maxWidth: "260px" }}>
                        <p style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {row.titulo_ml ?? row.nombre ?? <span style={{ color: "var(--text-dim)" }}>—</span>}
                        </p>
                        {row.codigo && (
                          <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{row.codigo}</p>
                        )}
                      </td>
                      <td style={{ padding: "9px 12px", fontFamily: "var(--font-mono)", fontSize: "13px", color: "var(--green)", fontWeight: "600", textAlign: "right", whiteSpace: "nowrap" }}>
                        {formatARS(row.costo)}
                      </td>
                      <td style={{ padding: "9px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", textAlign: "right", whiteSpace: "nowrap" }}>
                        {row.precio_lista && row.precio_lista > 0 ? formatARS(row.precio_lista) : "—"}
                      </td>
                      <td style={{ padding: "9px 12px", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--yellow)" }}>
                        {row.ml_id}
                      </td>
                      <td style={{ padding: "9px 12px" }}>
                        {row.match_method && row.match_method !== "not_found" && (
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: matchColor(row.match_method), background: "var(--surface-2)", border: `1px solid ${matchColor(row.match_method)}40`, borderRadius: "4px", padding: "2px 7px" }}>
                            {row.match_method}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "16px", paddingTop: "12px", borderTop: "1px solid var(--border)" }}>
                <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  Página {tablePage} de {totalPages} · {filtered.length} resultados
                </p>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    onClick={() => setTablePage(p => Math.max(1, p - 1))}
                    disabled={tablePage === 1}
                    style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "5px 12px", color: tablePage === 1 ? "var(--text-dim)" : "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "12px", cursor: tablePage === 1 ? "default" : "pointer" }}
                  >
                    ← Anterior
                  </button>
                  <button
                    onClick={() => setTablePage(p => Math.min(totalPages, p + 1))}
                    disabled={tablePage === totalPages}
                    style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "5px 12px", color: tablePage === totalPages ? "var(--text-dim)" : "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "12px", cursor: tablePage === totalPages ? "default" : "pointer" }}
                  >
                    Siguiente →
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
