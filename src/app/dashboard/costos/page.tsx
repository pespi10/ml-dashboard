// src/app/dashboard/costos/page.tsx
"use client";

import { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import { formatARS } from "@/lib/ml-api";

// ── Types ────────────────────────────────────────────────────────────────────

type ParsedRow = { id: string; title: string; cost: number };

type EanRow = {
  ean: string;
  codigo: string;
  nombre: string;
  costo_sin_iva: number;
  costo_con_iva: number;
  precio_lista: number;
};

type SyncResult = EanRow & {
  ml_id: string | null;
  titulo_ml: string | null;
  found: boolean;
};

type SyncProgress = {
  status: "running" | "done";
  total: number;
  processed: number;
  matched: number;
  notFound: number;
  results: SyncResult[];
};

export type SyncedCostEntry = {
  ean: string;
  codigo: string;
  nombre: string;
  titulo_ml: string | null;
  costo_sin_iva: number;
  costo_con_iva: number;
  precio_lista: number;
};

// ── CSV/XLSX parsers ─────────────────────────────────────────────────────────

function parseDirectCSV(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const lines = text.trim().split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
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
    if (cols.length >= 3) { title = cols[1].trim(); cost = parseFloat(cols[2]) || 0; }
    else cost = parseFloat(cols[1]) || 0;
    if (!id || cost <= 0) continue;
    rows.push({ id, title, cost });
  }
  return rows;
}

function parseDirectXLSX(buffer: ArrayBuffer): ParsedRow[] {
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
    if (row.length >= 3) { title = String(row[1]).trim(); cost = parseFloat(String(row[2])) || 0; }
    else cost = parseFloat(String(row[1])) || 0;
    if (!id || cost <= 0) continue;
    rows.push({ id, title, cost });
  }
  return rows;
}

function normalizeHeader(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "_");
}

function detectEanIndices(headers: string[]) {
  let eanIdx = 2, codigoIdx = 0, nombreIdx = 1;
  let costoSinIdx = 3, costoCnIdx = 5, precioListaIdx = 6;
  headers.forEach((h, i) => {
    const n = normalizeHeader(h);
    if (n.includes("ean") || n.includes("barcode") || n.includes("codigo_barra")) eanIdx = i;
    else if ((n.includes("codigo") || n.includes("sku")) && !n.includes("barra")) codigoIdx = i;
    else if (n.includes("nombre") || n.includes("descripcion") || n.includes("producto")) nombreIdx = i;
    else if (n.includes("costo_sin") || n === "costo_sin_iva" || n === "precio_sin_iva") costoSinIdx = i;
    else if (n.includes("costo_con") || n === "costo_con_iva" || n === "costo" || n === "precio_costo") costoCnIdx = i;
    else if (n.includes("precio_lista") || n === "lista" || n === "pvp" || n === "precio_publico") precioListaIdx = i;
  });
  return { eanIdx, codigoIdx, nombreIdx, costoSinIdx, costoCnIdx, precioListaIdx };
}

function parseEanCSV(text: string): EanRow[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const delim = lines[0].split(";").length > lines[0].split(",").length ? ";" : ",";

  const parseLine = (line: string): string[] => {
    const cols: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === delim && !inQuote) { cols.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  };

  const firstRow = parseLine(lines[0]);
  const hasHeaders = firstRow.some(c =>
    ["ean", "codigo", "costo", "precio", "nombre"].some(h => normalizeHeader(c).includes(h))
  );
  const indices = hasHeaders ? detectEanIndices(firstRow) : {
    eanIdx: 2, codigoIdx: 0, nombreIdx: 1, costoSinIdx: 3, costoCnIdx: 5, precioListaIdx: 6,
  };

  const rows: EanRow[] = [];
  for (let i = hasHeaders ? 1 : 0; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const ean = cols[indices.eanIdx]?.replace(/\D/g, "") || "";
    if (!ean) continue;
    const costo_con_iva = parseFloat(cols[indices.costoCnIdx]?.replace(",", ".") || "0") || 0;
    if (costo_con_iva <= 0) continue;
    rows.push({
      ean,
      codigo: cols[indices.codigoIdx]?.trim() || "",
      nombre: cols[indices.nombreIdx]?.trim() || "",
      costo_sin_iva: parseFloat(cols[indices.costoSinIdx]?.replace(",", ".") || "0") || 0,
      costo_con_iva,
      precio_lista: parseFloat(cols[indices.precioListaIdx]?.replace(",", ".") || "0") || 0,
    });
  }
  return rows;
}

function parseEanXLSX(buffer: ArrayBuffer): EanRow[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1 });
  if (!json.length) return [];
  const firstRow = (json[0] as (string | number)[]).map(c => String(c));
  const hasHeaders = firstRow.some(c =>
    ["ean", "codigo", "costo", "precio", "nombre"].some(h => normalizeHeader(c).includes(h))
  );
  const indices = hasHeaders ? detectEanIndices(firstRow) : {
    eanIdx: 2, codigoIdx: 0, nombreIdx: 1, costoSinIdx: 3, costoCnIdx: 5, precioListaIdx: 6,
  };
  const rows: EanRow[] = [];
  for (let i = hasHeaders ? 1 : 0; i < json.length; i++) {
    const row = json[i] as (string | number)[];
    if (!row || row.length < 3) continue;
    const ean = String(row[indices.eanIdx] ?? "").replace(/\D/g, "");
    if (!ean) continue;
    const costo_con_iva = parseFloat(String(row[indices.costoCnIdx] ?? "0")) || 0;
    if (costo_con_iva <= 0) continue;
    rows.push({
      ean,
      codigo: String(row[indices.codigoIdx] ?? "").trim(),
      nombre: String(row[indices.nombreIdx] ?? "").trim(),
      costo_sin_iva: parseFloat(String(row[indices.costoSinIdx] ?? "0")) || 0,
      costo_con_iva,
      precio_lista: parseFloat(String(row[indices.precioListaIdx] ?? "0")) || 0,
    });
  }
  return rows;
}

// ── Storage helpers ──────────────────────────────────────────────────────────

function loadFromStorage() {
  if (typeof window === "undefined") return { costs: {}, titles: {}, syncedCosts: {} };
  try {
    const costs: Record<string, number> = JSON.parse(localStorage.getItem("ml_costs") || "{}");
    const titles: Record<string, string> = JSON.parse(localStorage.getItem("ml_costs_titles") || "{}");
    const syncedCosts: Record<string, SyncedCostEntry> = JSON.parse(localStorage.getItem("ml_synced_costs") || "{}");
    return { costs, titles, syncedCosts };
  } catch {
    return { costs: {}, titles: {}, syncedCosts: {} };
  }
}

// ── Styles ───────────────────────────────────────────────────────────────────

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

// ── Component ────────────────────────────────────────────────────────────────

export default function CostosPage() {
  const initial = loadFromStorage();
  const [costs, setCosts] = useState<Record<string, number>>(initial.costs);
  const [titles, setTitles] = useState<Record<string, string>>(initial.titles);
  const [syncedCosts, setSyncedCosts] = useState<Record<string, SyncedCostEntry>>(initial.syncedCosts);

  // Direct upload state
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<ParsedRow[] | null>(null);
  const [allParsed, setAllParsed] = useState<ParsedRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ updated: number; added: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // EAN sync state
  const [eanDragging, setEanDragging] = useState(false);
  const [eanRows, setEanRows] = useState<EanRow[]>([]);
  const [eanPreview, setEanPreview] = useState<EanRow[] | null>(null);
  const [eanParseError, setEanParseError] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const eanFileInputRef = useRef<HTMLInputElement>(null);

  // ── Direct upload handlers ────────────────────────────────────────────────

  const processDirectFile = useCallback((file: File) => {
    setParseError(null); setSummary(null); setPreview(null);
    const name = file.name.toLowerCase();
    const reader = new FileReader();
    if (name.endsWith(".csv")) {
      reader.onload = (e) => {
        const rows = parseDirectCSV(e.target?.result as string);
        if (!rows.length) { setParseError("No se encontraron datos válidos. Revisá el formato del CSV."); return; }
        setAllParsed(rows); setPreview(rows.slice(0, 10));
      };
      reader.readAsText(file, "utf-8");
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      reader.onload = (e) => {
        try {
          const rows = parseDirectXLSX(e.target?.result as ArrayBuffer);
          if (!rows.length) { setParseError("No se encontraron datos válidos. Revisá el formato del Excel."); return; }
          setAllParsed(rows); setPreview(rows.slice(0, 10));
        } catch { setParseError("Error al leer el archivo Excel."); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setParseError("Formato no soportado. Subí un archivo .csv o .xlsx");
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processDirectFile(file);
  }, [processDirectFile]);

  const handleConfirm = () => {
    const newCosts = { ...costs };
    const newTitles = { ...titles };
    let updated = 0; let added = 0;
    for (const row of allParsed) {
      if (newCosts[row.id] !== undefined) updated++; else added++;
      newCosts[row.id] = row.cost;
      if (row.title) newTitles[row.id] = row.title;
    }
    localStorage.setItem("ml_costs", JSON.stringify(newCosts));
    localStorage.setItem("ml_costs_titles", JSON.stringify(newTitles));
    setCosts(newCosts); setTitles(newTitles);
    setSummary({ updated, added }); setPreview(null); setAllParsed([]);
  };

  const handleDelete = (id: string) => {
    const newCosts = { ...costs }; const newTitles = { ...titles };
    delete newCosts[id]; delete newTitles[id];
    localStorage.setItem("ml_costs", JSON.stringify(newCosts));
    localStorage.setItem("ml_costs_titles", JSON.stringify(newTitles));
    setCosts(newCosts); setTitles(newTitles);
  };

  const startEdit = (id: string) => { setEditingId(id); setEditValue(String(costs[id])); };
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
    const csv = "id,titulo,costo\nMLA123456789,Auriculares JBL,15000\nMLA987654321,Zapatillas Nike,25000\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "plantilla_costos.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // ── EAN sync handlers ─────────────────────────────────────────────────────

  const downloadEanTemplate = () => {
    const csv = "codigo,nombre,ean,costo_sin_iva,iva_21,costo_con_iva,precio_lista\nSKU001,Auriculares JBL,7898000000001,12397,2603,15000,22000\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "plantilla_ean.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const processEanFile = useCallback((file: File) => {
    setEanParseError(null); setEanPreview(null); setSyncProgress(null);
    const name = file.name.toLowerCase();
    const reader = new FileReader();
    if (name.endsWith(".csv")) {
      reader.onload = (e) => {
        const rows = parseEanCSV(e.target?.result as string);
        if (!rows.length) { setEanParseError("No se encontraron datos con EAN válidos."); return; }
        setEanRows(rows); setEanPreview(rows.slice(0, 5));
      };
      reader.readAsText(file, "utf-8");
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      reader.onload = (e) => {
        try {
          const rows = parseEanXLSX(e.target?.result as ArrayBuffer);
          if (!rows.length) { setEanParseError("No se encontraron datos con EAN válidos."); return; }
          setEanRows(rows); setEanPreview(rows.slice(0, 5));
        } catch { setEanParseError("Error al leer el archivo Excel."); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setEanParseError("Formato no soportado. Subí un archivo .csv o .xlsx");
    }
  }, []);

  const handleEanDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setEanDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processEanFile(file);
  }, [processEanFile]);

  const runSync = async () => {
    if (!eanRows.length) return;
    const BATCH = 10;
    const allResults: SyncResult[] = [];
    let totalMatched = 0;
    let totalNotFound = 0;

    setSyncProgress({ status: "running", total: eanRows.length, processed: 0, matched: 0, notFound: 0, results: [] });

    for (let i = 0; i < eanRows.length; i += BATCH) {
      const batch = eanRows.slice(i, i + BATCH);
      try {
        const res = await fetch("/api/costs/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: batch }),
        });
        const data = await res.json();
        allResults.push(...(data.results ?? []));
        totalMatched += data.matched ?? 0;
        totalNotFound += data.notFound ?? 0;
      } catch {
        totalNotFound += batch.length;
        allResults.push(...batch.map(item => ({ ...item, ml_id: null, titulo_ml: null, found: false })));
      }

      setSyncProgress({
        status: "running",
        total: eanRows.length,
        processed: Math.min(i + BATCH, eanRows.length),
        matched: totalMatched,
        notFound: totalNotFound,
        results: [...allResults],
      });
    }

    // Persist matched items to localStorage
    const newCosts = { ...costs };
    const newTitles = { ...titles };
    const newSynced = { ...syncedCosts };

    for (const r of allResults) {
      if (r.found && r.ml_id) {
        newCosts[r.ml_id] = r.costo_con_iva;
        newTitles[r.ml_id] = r.titulo_ml ?? r.nombre;
        newSynced[r.ml_id] = {
          ean: r.ean,
          codigo: r.codigo,
          nombre: r.nombre,
          titulo_ml: r.titulo_ml,
          costo_sin_iva: r.costo_sin_iva,
          costo_con_iva: r.costo_con_iva,
          precio_lista: r.precio_lista,
        };
      }
    }

    localStorage.setItem("ml_costs", JSON.stringify(newCosts));
    localStorage.setItem("ml_costs_titles", JSON.stringify(newTitles));
    localStorage.setItem("ml_synced_costs", JSON.stringify(newSynced));
    setCosts(newCosts); setTitles(newTitles); setSyncedCosts(newSynced);

    setSyncProgress(prev => prev ? { ...prev, status: "done", processed: eanRows.length, matched: totalMatched, notFound: totalNotFound, results: allResults } : null);
    setEanPreview(null);
    setEanRows([]);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const entries = Object.entries(costs).sort((a, b) => a[0].localeCompare(b[0]));
  const syncedEntries = Object.entries(syncedCosts).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      {/* Header */}
      <div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(22px, 4vw, 28px)", fontWeight: "800", letterSpacing: "-0.02em", marginBottom: "4px" }}>
          Costos de Productos
        </h1>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          Cargá costos por ID directo o sincronizá automáticamente desde EAN
        </p>
      </div>

      {/* ── SECCIÓN 1: Carga directa por MLA ID ── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <div>
            <p style={{ ...labelStyle, marginBottom: "4px" }}>Carga directa por ID</p>
            <p style={{ fontSize: "12px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              Formato: MLA ID, nombre (opcional), costo
            </p>
          </div>
          <button
            onClick={downloadTemplate}
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 14px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "12px", cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--yellow)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          >
            ↓ Plantilla CSV
          </button>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${dragging ? "var(--yellow)" : "var(--border-light)"}`,
            borderRadius: "var(--radius-lg)", padding: "36px 24px", textAlign: "center",
            cursor: "pointer", background: dragging ? "var(--yellow-glow)" : "var(--surface-2)", transition: "all 0.15s",
          }}
        >
          <div style={{ fontSize: "28px", marginBottom: "8px" }}>◉</div>
          <p style={{ fontFamily: "var(--font-display)", fontSize: "14px", fontWeight: "600", color: dragging ? "var(--yellow)" : "var(--text)", marginBottom: "4px" }}>
            {dragging ? "Soltar archivo aquí" : "Arrastrá o hacé click para seleccionar"}
          </p>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            .csv · .xlsx · .xls
          </p>
          <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) processDirectFile(f); e.target.value = ""; }} />
        </div>

        {parseError && (
          <div style={{ marginTop: "16px", padding: "12px 16px", background: "var(--red-dim)", border: "1px solid rgba(255,68,88,0.25)", borderRadius: "var(--radius)", color: "var(--red)", fontSize: "13px", fontFamily: "var(--font-mono)" }}>
            ✗ {parseError}
          </div>
        )}
        {summary && (
          <div style={{ marginTop: "16px", padding: "12px 16px", background: "var(--green-dim)", border: "1px solid rgba(0,212,160,0.25)", borderRadius: "var(--radius)", color: "var(--green)", fontSize: "13px", fontFamily: "var(--font-mono)" }}>
            ✓ {summary.updated} actualizados · {summary.added} nuevos
          </div>
        )}
      </div>

      {/* Direct upload preview */}
      {preview && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
            <div>
              <p style={{ ...labelStyle, marginBottom: "4px" }}>Vista previa</p>
              <p style={{ fontSize: "13px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                {allParsed.length} registros{allParsed.length > 10 ? " (mostrando primeros 10)" : ""}
              </p>
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button onClick={() => { setPreview(null); setAllParsed([]); }} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 16px", color: "var(--text-muted)", fontFamily: "var(--font-display)", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}>Cancelar</button>
              <button onClick={handleConfirm} style={{ background: "var(--yellow)", border: "none", borderRadius: "var(--radius)", padding: "8px 20px", color: "#000", fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "13px", cursor: "pointer" }}>
                Confirmar {allParsed.length} registros
              </button>
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["ID / SKU", "Título", "Costo"].map((h) => (
                    <th key={h} style={{ ...labelStyle, padding: "8px 12px", textAlign: "left", borderBottom: "1px solid var(--border)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--yellow)" }}>{row.id}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.title || <span style={{ color: "var(--text-dim)" }}>—</span>}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "13px", color: "var(--green)", fontWeight: "500" }}>{formatARS(row.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── SECCIÓN 2: Sincronizar por EAN ── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <div>
            <p style={{ ...labelStyle, marginBottom: "4px" }}>Sincronizar por EAN</p>
            <p style={{ fontSize: "12px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              Vincula cada EAN con su publicación en ML automáticamente
            </p>
          </div>
          <button
            onClick={downloadEanTemplate}
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 14px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "12px", cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--yellow)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
          >
            ↓ Plantilla EAN
          </button>
        </div>

        {/* EAN drop zone */}
        {!eanPreview && !syncProgress && (
          <>
            <div
              onDragOver={(e) => { e.preventDefault(); setEanDragging(true); }}
              onDragLeave={() => setEanDragging(false)}
              onDrop={handleEanDrop}
              onClick={() => eanFileInputRef.current?.click()}
              style={{
                border: `2px dashed ${eanDragging ? "var(--yellow)" : "var(--border-light)"}`,
                borderRadius: "var(--radius-lg)", padding: "36px 24px", textAlign: "center",
                cursor: "pointer", background: eanDragging ? "var(--yellow-glow)" : "var(--surface-2)", transition: "all 0.15s",
              }}
            >
              <div style={{ fontSize: "28px", marginBottom: "8px" }}>⊞</div>
              <p style={{ fontFamily: "var(--font-display)", fontSize: "14px", fontWeight: "600", color: eanDragging ? "var(--yellow)" : "var(--text)", marginBottom: "4px" }}>
                {eanDragging ? "Soltar archivo aquí" : "Subí tu lista de productos con EAN"}
              </p>
              <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                .csv · .xlsx · .xls
              </p>
              <input ref={eanFileInputRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) processEanFile(f); e.target.value = ""; }} />
            </div>

            {/* Format hint */}
            <div style={{ marginTop: "14px", padding: "12px 16px", background: "var(--surface-2)", borderRadius: "var(--radius)" }}>
              <p style={{ ...labelStyle, marginBottom: "8px" }}>Columnas esperadas:</p>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--yellow)", background: "rgba(255,230,0,0.07)", padding: "4px 10px", borderRadius: "4px", display: "block" }}>
                codigo · nombre · ean · costo_sin_iva · iva_21 · costo_con_iva · precio_lista
              </code>
              <p style={{ fontSize: "11px", color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: "6px" }}>
                También detecta encabezados automáticamente si el orden varía
              </p>
            </div>
          </>
        )}

        {eanParseError && (
          <div style={{ marginTop: "14px", padding: "12px 16px", background: "var(--red-dim)", border: "1px solid rgba(255,68,88,0.25)", borderRadius: "var(--radius)", color: "var(--red)", fontSize: "13px", fontFamily: "var(--font-mono)" }}>
            ✗ {eanParseError}
          </div>
        )}

        {/* EAN preview */}
        {eanPreview && !syncProgress && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <p style={{ fontSize: "13px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                {eanRows.length} productos encontrados{eanRows.length > 5 ? " (mostrando primeros 5)" : ""}
              </p>
              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  onClick={() => { setEanPreview(null); setEanRows([]); }}
                  style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 14px", color: "var(--text-muted)", fontFamily: "var(--font-display)", fontWeight: "600", fontSize: "13px", cursor: "pointer" }}
                >
                  Cancelar
                </button>
                <button
                  onClick={runSync}
                  style={{ background: "var(--yellow)", border: "none", borderRadius: "var(--radius)", padding: "8px 20px", color: "#000", fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "13px", cursor: "pointer" }}
                >
                  Sincronizar {eanRows.length} con ML →
                </button>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["EAN", "Código", "Nombre", "Costo c/IVA", "P. Lista"].map((h, j) => (
                      <th key={j} style={{ ...labelStyle, padding: "8px 12px", textAlign: j >= 3 ? "right" : "left", borderBottom: "1px solid var(--border)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {eanPreview.map((row, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--yellow)" }}>{row.ean}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-dim)" }}>{row.codigo || "—"}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.nombre || "—"}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--green)", textAlign: "right" }}>{formatARS(row.costo_con_iva)}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text)", textAlign: "right" }}>{row.precio_lista > 0 ? formatARS(row.precio_lista) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Sync progress */}
        {syncProgress && (
          <div>
            <div style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <p style={{ fontFamily: "var(--font-mono)", fontSize: "13px", color: "var(--text-muted)" }}>
                  {syncProgress.status === "running"
                    ? `Procesando ${syncProgress.processed} de ${syncProgress.total} productos...`
                    : `Sincronización completa · ${syncProgress.total} productos procesados`}
                </p>
                {syncProgress.status === "done" && (
                  <button
                    onClick={() => { setSyncProgress(null); }}
                    style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "6px 14px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "12px", cursor: "pointer" }}
                  >
                    Limpiar
                  </button>
                )}
              </div>
              {/* Progress bar */}
              <div style={{ background: "var(--border)", borderRadius: "4px", height: "4px" }}>
                <div style={{ background: syncProgress.status === "done" ? "var(--green)" : "var(--yellow)", height: "100%", borderRadius: "4px", width: `${(syncProgress.processed / syncProgress.total) * 100}%`, transition: "width 0.3s" }} />
              </div>
            </div>

            {/* Result counts */}
            <div style={{ display: "flex", gap: "16px", marginBottom: "16px" }}>
              <div style={{ background: "var(--green-dim)", border: "1px solid rgba(0,212,160,0.2)", borderRadius: "var(--radius)", padding: "10px 20px", textAlign: "center", flex: 1 }}>
                <p style={{ fontFamily: "var(--font-display)", fontSize: "24px", fontWeight: "800", color: "var(--green)" }}>{syncProgress.matched}</p>
                <p style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>vinculados a ML</p>
              </div>
              <div style={{ background: "var(--red-dim)", border: "1px solid rgba(255,68,88,0.15)", borderRadius: "var(--radius)", padding: "10px 20px", textAlign: "center", flex: 1 }}>
                <p style={{ fontFamily: "var(--font-display)", fontSize: "24px", fontWeight: "800", color: "var(--text-muted)" }}>{syncProgress.notFound}</p>
                <p style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>no encontrados</p>
              </div>
            </div>

            {/* Results list */}
            {syncProgress.results.length > 0 && (
              <div style={{ maxHeight: "300px", overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
                {syncProgress.results.map((r, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 14px", borderBottom: i < syncProgress.results.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <span style={{ fontSize: "12px", color: r.found ? "var(--green)" : "var(--text-dim)", flexShrink: 0 }}>
                      {r.found ? "✓" : "✗"}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-dim)", width: "120px", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.ean}
                    </span>
                    <span style={{ flex: 1, fontSize: "12px", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.found ? (r.titulo_ml ?? r.nombre) : r.nombre}
                    </span>
                    {r.found && r.ml_id && (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--yellow)", flexShrink: 0 }}>
                        {r.ml_id}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── SECCIÓN 3: Costos sincronizados por EAN ── */}
      {syncedEntries.length > 0 && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "24px" }}>
          <div style={{ marginBottom: "16px" }}>
            <p style={{ ...labelStyle, marginBottom: "4px" }}>Costos sincronizados por EAN</p>
            <p style={{ fontSize: "13px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {syncedEntries.length} producto{syncedEntries.length !== 1 ? "s" : ""} vinculados a ML
            </p>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["MLA ID", "Nombre / Título ML", "EAN", "Costo c/IVA", "P. Lista", ""].map((h, j) => (
                    <th key={j} style={{ ...labelStyle, padding: "8px 12px", textAlign: j >= 3 && j < 5 ? "right" : "left", borderBottom: "1px solid var(--border)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {syncedEntries.map(([mlId, entry]) => (
                  <tr key={mlId} style={{ borderBottom: "1px solid var(--border)" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--yellow)" }}>{mlId}</td>
                    <td style={{ padding: "10px 12px", maxWidth: "240px" }}>
                      <p style={{ fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.titulo_ml ?? entry.nombre}</p>
                      {entry.codigo && <p style={{ fontSize: "10px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{entry.codigo}</p>}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-dim)" }}>{entry.ean}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--green)", textAlign: "right" }}>{formatARS(entry.costo_con_iva)}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text)", textAlign: "right" }}>{entry.precio_lista > 0 ? formatARS(entry.precio_lista) : "—"}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right" }}>
                      <button
                        onClick={() => {
                          const newSynced = { ...syncedCosts }; delete newSynced[mlId];
                          const newCosts = { ...costs };
                          if (newCosts[mlId] === entry.costo_con_iva) delete newCosts[mlId];
                          const newTitles = { ...titles }; delete newTitles[mlId];
                          localStorage.setItem("ml_synced_costs", JSON.stringify(newSynced));
                          localStorage.setItem("ml_costs", JSON.stringify(newCosts));
                          localStorage.setItem("ml_costs_titles", JSON.stringify(newTitles));
                          setSyncedCosts(newSynced); setCosts(newCosts); setTitles(newTitles);
                        }}
                        style={{ background: "transparent", border: "none", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "13px", cursor: "pointer", padding: "4px 8px", borderRadius: "var(--radius)" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--red)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
                        title="Eliminar"
                      >✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── SECCIÓN 4: Costos cargados (directos) ── */}
      {entries.length > 0 && !preview && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "24px" }}>
          <div style={{ marginBottom: "16px" }}>
            <p style={{ ...labelStyle, marginBottom: "4px" }}>Costos cargados</p>
            <p style={{ fontSize: "13px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {entries.length} producto{entries.length !== 1 ? "s" : ""} con costo registrado
            </p>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["ID / SKU", "Título", "Costo", ""].map((h, i) => (
                    <th key={i} style={{ ...labelStyle, padding: "8px 12px", textAlign: i === 3 ? "right" : "left", borderBottom: "1px solid var(--border)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map(([id, cost]) => (
                  <tr key={id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--yellow)" }}>{id}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", maxWidth: "280px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {titles[id] || <span style={{ color: "var(--text-dim)" }}>—</span>}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {editingId === id ? (
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                          <input type="number" value={editValue} onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingId(null); }}
                            autoFocus style={{ ...inputStyle, width: "120px" }} />
                          <button onClick={commitEdit} style={{ background: "var(--yellow)", border: "none", borderRadius: "var(--radius)", padding: "5px 12px", color: "#000", fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "12px", cursor: "pointer" }}>✓</button>
                          <button onClick={() => setEditingId(null)} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "5px 10px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "12px", cursor: "pointer" }}>✕</button>
                        </div>
                      ) : (
                        <button onClick={() => startEdit(id)} style={{ background: "transparent", border: "none", padding: "0", fontFamily: "var(--font-mono)", fontSize: "13px", fontWeight: "500", color: "var(--green)", cursor: "pointer", textAlign: "left" }} title="Click para editar">
                          {formatARS(cost)}<span style={{ color: "var(--text-dim)", fontSize: "10px", marginLeft: "6px" }}>✎</span>
                        </button>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right" }}>
                      <button onClick={() => handleDelete(id)} style={{ background: "transparent", border: "none", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "13px", cursor: "pointer", padding: "4px 8px", borderRadius: "var(--radius)" }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--red)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
                        title="Eliminar">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {entries.length === 0 && syncedEntries.length === 0 && !preview && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "48px 24px", textAlign: "center" }}>
          <p style={{ fontSize: "32px", marginBottom: "12px" }}>◉</p>
          <p style={{ fontFamily: "var(--font-display)", fontSize: "15px", fontWeight: "600", color: "var(--text-muted)", marginBottom: "6px" }}>Sin costos cargados</p>
          <p style={{ fontSize: "12px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            Cargá un CSV directo o sincronizá por EAN para empezar
          </p>
        </div>
      )}
    </div>
  );
}
