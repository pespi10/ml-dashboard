// src/app/dashboard/costos/page.tsx
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import { formatARS } from "@/lib/ml-api";
import { LOGISTICA_PROPIA_COSTO_POR_PEDIDO } from "@/lib/shipping-config";

// ── Types ────────────────────────────────────────────────────────────────────

type ParsedRow = { id: string; title: string; cost: number };

type EanRow = {
  ean: string;
  codigo: string;
  nombre: string;
  costo: number;
  precio_lista: number;
};

type MatchMethod = "gtin" | "sku" | "not_found";

type SyncResult = EanRow & {
  ml_id: string | null;
  titulo_ml: string | null;
  found: boolean;
  match_method: MatchMethod;
};

type SyncProgress = {
  status: "running" | "done";
  total: number;
  processed: number;
  matched: number;
  matchedByGtin: number;
  matchedBySku: number;
  notFound: number;
  results: SyncResult[];
};

export type SyncedCostEntry = {
  ean: string;
  codigo: string;
  nombre: string;
  titulo_ml: string | null;
  costo: number;
  precio_lista: number;
  match_method?: MatchMethod;
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

// Normaliza a minúsculas sin tildes ni espacios
function normCol(s: string): string {
  return s.trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "_");
}

// Construye un mapa { header_normalizado → índice }
function buildColMap(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  headers.forEach((h, i) => { map[normCol(h)] = i; });
  return map;
}

// Busca el primer candidato que exista en el mapa, devuelve -1 si ninguno
function colIdx(map: Record<string, number>, ...candidates: string[]): number {
  for (const c of candidates) if (map[c] !== undefined) return map[c];
  return -1;
}

// Parsea número con soporte para formato argentino: "1.500,50" → 1500.50
function parseNum(s: string | number | undefined | null): number {
  if (s === undefined || s === null) return 0;
  if (typeof s === "number") return s;
  const v = s.trim().replace(/\s/g, "");
  if (!v) return 0;
  // Ambos separadores: determinar cuál es decimal según posición
  if (v.includes(".") && v.includes(",")) {
    return v.lastIndexOf(".") < v.lastIndexOf(",")
      ? parseFloat(v.replace(/\./g, "").replace(",", ".")) || 0   // 1.500,50
      : parseFloat(v.replace(/,/g, "")) || 0;                     // 1,500.50
  }
  if (v.includes(",")) {
    const parts = v.split(",");
    // "15000,50" → decimal; "1,500" → miles
    return parts.length === 2 && parts[1].length <= 2
      ? parseFloat(v.replace(",", ".")) || 0
      : parseFloat(v.replace(/,/g, "")) || 0;
  }
  // "15.000" → miles argentino si termina en exactamente 3 dígitos tras el punto
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
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }  // escaped "" → single "
        else inQuote = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === delim) { cols.push(cur.trim()); cur = ""; }
      else { cur += ch; }
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

  console.log("[EAN parser] raw headers:", headers);
  console.log("[EAN parser] norm headers:", headers.map(normCol));
  console.log("[EAN parser] indices → ean:%d  cod:%d  nom:%d  costo:%d  lista:%d", iEan, iCod, iNom, iCosto, iLista);
  if (dataRows.length > 0) {
    console.log("[EAN parser] row[0] raw cols:", dataRows[0]);
    console.log("[EAN parser] row[0] ean=%s  costo=%s", dataRows[0][iEan], dataRows[0][iCosto]);
  }

  if (iEan === -1) { console.warn("[EAN parser] EAN column not found — aborting"); return []; }

  const rows: EanRow[] = [];
  for (const cols of dataRows) {
    const ean = String(cols[iEan] ?? "").replace(/\D/g, "");
    if (!ean) continue;
    const costo = parseNum(iCosto >= 0 ? cols[iCosto] : undefined);
    if (costo <= 0) continue;
    rows.push({
      ean,
      codigo:       iCod   >= 0 ? (cols[iCod]   ?? "").trim() : "",
      nombre:       iNom   >= 0 ? (cols[iNom]   ?? "").trim() : "",
      costo,
      precio_lista: parseNum(iLista >= 0 ? cols[iLista] : undefined),
    });
  }

  console.log("[EAN parser] parsed %d/%d rows — first 3:", rows.length, dataRows.length, rows.slice(0, 3));
  return rows;
}

function parseEanCSV(text: string): EanRow[] {
  // Strip UTF-8 BOM if present
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const lines = clean.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const delim = lines[0].split(";").length > lines[0].split(",").length ? ";" : ",";
  console.log("[EAN parser] delimiter detected:", JSON.stringify(delim), "| first line:", lines[0].slice(0, 80));
  const headers = splitCsvLine(lines[0], delim);
  const dataRows = lines.slice(1).map(l => splitCsvLine(l, delim));
  return extractEanRows(headers, dataRows);
}

function parseEanXLSX(buffer: ArrayBuffer): EanRow[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // header:1 → array of arrays; primera fila siempre es header
  const json = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, raw: false });
  if (json.length < 2) return [];
  const headers = (json[0] as (string | number)[]).map(c => String(c));
  const dataRows = json.slice(1).map(row =>
    (row as (string | number)[]).map(c => String(c ?? ""))
  );
  return extractEanRows(headers, dataRows);
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
  const [costs, setCosts] = useState<Record<string, number>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [syncedCosts, setSyncedCosts] = useState<Record<string, SyncedCostEntry>>({});

  // Shipping config state
  const [shippingInput, setShippingInput] = useState("");
  const [shippingOverride, setShippingOverride] = useState<number | null>(null);
  const [shippingSaved, setShippingSaved] = useState(false);

  useEffect(() => {
    try {
      console.log("localStorage keys:", Object.keys(localStorage));
      console.log("localStorage contents:", Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)?.slice(0, 50)])));
      const synced: Record<string, SyncedCostEntry> = JSON.parse(localStorage.getItem("ml_costs_ean") || "{}");
      const c: Record<string, number> = JSON.parse(localStorage.getItem("ml_costs") || "{}");
      const t: Record<string, string> = JSON.parse(localStorage.getItem("ml_costs_titles") || "{}");
      setSyncedCosts(synced);
      setCosts(c);
      setTitles(t);
      const shippingConfig = JSON.parse(localStorage.getItem("shipping_config") || "null");
      if (shippingConfig?.costoPorPedido) {
        setShippingOverride(shippingConfig.costoPorPedido);
        setShippingInput(String(shippingConfig.costoPorPedido));
      }
    } catch {
      // localStorage unavailable or corrupt — leave state as empty
    }
  }, []);

  const saveShippingConfig = () => {
    const val = parseFloat(shippingInput);
    if (isNaN(val) || val <= 0) return;
    localStorage.setItem("shipping_config", JSON.stringify({ costoPorPedido: val }));
    setShippingOverride(val);
    setShippingSaved(true);
    setTimeout(() => setShippingSaved(false), 3000);
  };

  const clearShippingConfig = () => {
    localStorage.removeItem("shipping_config");
    setShippingOverride(null);
    setShippingInput("");
    setShippingSaved(false);
  };

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
    const csv = "codigo,nombre,costo,precio_lista,ean\nSKU001,Auriculares JBL,15000,22000,7898000000001\n";
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
    const allResults: SyncResult[] = [];
    let totalMatched = 0;
    let totalByGtin = 0;
    let totalBySku = 0;
    let totalNotFound = 0;

    // Borrar explícitamente todas las keys conocidas antes de guardar
    ['ml_costs', 'ml_costs_titles', 'ml_costs_ean', 'ml_synced_costs', 'ml_costs_synced'].forEach(k => localStorage.removeItem(k));
    setCosts({});
    setTitles({});
    setSyncedCosts({});
    console.log("[runSync] localStorage after clear:", Object.keys(localStorage));
    console.log("[runSync] React state reset — costs:{} titles:{} syncedCosts:{}");

    setSyncProgress({ status: "running", total: eanRows.length, processed: 0, matched: 0, matchedByGtin: 0, matchedBySku: 0, notFound: 0, results: [] });

    // Send all items in one request — the server builds both maps once
    try {
      const res = await fetch("/api/costs/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: eanRows }),
      });
      const data = await res.json();
      allResults.push(...(data.results ?? []));
      totalByGtin = data.matched_by_gtin ?? 0;
      totalBySku = data.matched_by_sku ?? 0;
      totalMatched = data.matched ?? (totalByGtin + totalBySku);
      totalNotFound = data.not_found ?? eanRows.length - totalMatched;
    } catch {
      totalNotFound = eanRows.length;
      allResults.push(...eanRows.map(item => ({ ...item, ml_id: null, titulo_ml: null, found: false, match_method: "not_found" as MatchMethod })));
    }

    setSyncProgress({
      status: "running",
      total: eanRows.length,
      processed: eanRows.length,
      matched: totalMatched,
      matchedByGtin: totalByGtin,
      matchedBySku: totalBySku,
      notFound: totalNotFound,
      results: [...allResults],
    });

    // Reemplaza completamente — limpiar datos anteriores
    const newCosts: Record<string, number> = {};
    const newTitles: Record<string, string> = {};
    const newSynced: Record<string, SyncedCostEntry> = {};

    for (const r of allResults) {
      if (r.found && r.ml_id) {
        newCosts[r.ml_id] = r.costo;
        newTitles[r.ml_id] = r.titulo_ml ?? r.nombre;
        newSynced[r.ml_id] = {
          ean: r.ean,
          codigo: r.codigo,
          nombre: r.nombre,
          titulo_ml: r.titulo_ml,
          costo: r.costo,
          precio_lista: r.precio_lista,
          match_method: r.match_method,
        };
      }
    }

    localStorage.setItem("ml_costs", JSON.stringify(newCosts));
    localStorage.setItem("ml_costs_titles", JSON.stringify(newTitles));
    localStorage.setItem("ml_costs_ean", JSON.stringify(newSynced));
    setCosts(newCosts); setTitles(newTitles); setSyncedCosts(newSynced);
    console.log("[runSync] localStorage after save:", Object.keys(localStorage));

    setSyncProgress(prev => prev ? { ...prev, status: "done", processed: eanRows.length, matched: totalMatched, matchedByGtin: totalByGtin, matchedBySku: totalBySku, notFound: totalNotFound, results: allResults } : null);
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
                codigo · nombre · costo · precio_lista · ean
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
                    {["Código", "Nombre", "EAN", "Costo", "Precio Lista"].map((h, j) => (
                      <th key={j} style={{ ...labelStyle, padding: "8px 12px", textAlign: j >= 3 ? "right" : "left", borderBottom: "1px solid var(--border)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {eanPreview.map((row, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-dim)" }}>{row.codigo || "—"}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)", maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.nombre || "—"}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--yellow)" }}>{row.ean}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--green)", fontWeight: "600", textAlign: "right" }}>{formatARS(row.costo)}</td>
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
            <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
              <div style={{ background: "var(--green-dim)", border: "1px solid rgba(0,212,160,0.2)", borderRadius: "var(--radius)", padding: "10px 16px", textAlign: "center", flex: 1 }}>
                <p style={{ fontFamily: "var(--font-display)", fontSize: "22px", fontWeight: "800", color: "var(--green)" }}>{syncProgress.matched}</p>
                <p style={{ fontSize: "10px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>vinculados</p>
              </div>
              <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "10px 16px", textAlign: "center", flex: 1 }}>
                <p style={{ fontFamily: "var(--font-display)", fontSize: "22px", fontWeight: "800", color: "var(--yellow)" }}>{syncProgress.matchedByGtin}</p>
                <p style={{ fontSize: "10px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>por GTIN</p>
              </div>
              <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "10px 16px", textAlign: "center", flex: 1 }}>
                <p style={{ fontFamily: "var(--font-display)", fontSize: "22px", fontWeight: "800", color: "var(--yellow)" }}>{syncProgress.matchedBySku}</p>
                <p style={{ fontSize: "10px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>por SKU</p>
              </div>
              <div style={{ background: "var(--red-dim)", border: "1px solid rgba(255,68,88,0.15)", borderRadius: "var(--radius)", padding: "10px 16px", textAlign: "center", flex: 1 }}>
                <p style={{ fontFamily: "var(--font-display)", fontSize: "22px", fontWeight: "800", color: "var(--text-muted)" }}>{syncProgress.notFound}</p>
                <p style={{ fontSize: "10px", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>no encontrados</p>
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
                    {r.found && r.match_method !== "not_found" && (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: r.match_method === "gtin" ? "var(--green)" : "var(--yellow)", background: "var(--surface-2)", borderRadius: "4px", padding: "2px 6px", flexShrink: 0 }}>
                        {r.match_method}
                      </span>
                    )}
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
                  {["Código", "Nombre", "EAN", "Costo", "P. Lista", "Match", ""].map((h, j) => (
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
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-dim)" }}>{entry.codigo || "—"}</td>
                    <td style={{ padding: "10px 12px", maxWidth: "200px" }}>
                      <p style={{ fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.nombre}</p>
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-dim)" }}>{entry.ean}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--green)", fontWeight: "600", textAlign: "right" }}>{formatARS(entry.costo)}</td>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text)", textAlign: "right" }}>{entry.precio_lista > 0 ? formatARS(entry.precio_lista) : "—"}</td>
                    <td style={{ padding: "10px 12px" }}>
                      {entry.match_method && entry.match_method !== "not_found" && (
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: entry.match_method === "gtin" ? "var(--green)" : "var(--yellow)", background: "var(--surface-2)", border: `1px solid ${entry.match_method === "gtin" ? "rgba(0,212,160,0.25)" : "rgba(255,230,0,0.2)"}`, borderRadius: "4px", padding: "2px 7px" }}>
                          {entry.match_method}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right" }}>
                      <button
                        onClick={() => {
                          const newSynced = { ...syncedCosts }; delete newSynced[mlId];
                          const newCosts = { ...costs };
                          if (newCosts[mlId] === entry.costo) delete newCosts[mlId];
                          const newTitles = { ...titles }; delete newTitles[mlId];
                          localStorage.setItem("ml_costs_ean", JSON.stringify(newSynced));
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

      {/* ── SECCIÓN: Configuración de envíos ── */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "28px" }}>
        <div style={{ marginBottom: "20px" }}>
          <p style={{ ...labelStyle, marginBottom: "4px" }}>Configuración de envíos</p>
          <p style={{ fontSize: "12px", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            El valor en código es {formatARS(LOGISTICA_PROPIA_COSTO_POR_PEDIDO)} (pendiente confirmar). Podés sobreescribirlo acá temporalmente.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", gap: "24px", flexWrap: "wrap" }}>
          <div>
            <label style={{ ...labelStyle, marginBottom: "6px", display: "block" }}>
              Costo por pedido — logística propia (GBA Norte + CABA)
            </label>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                type="number"
                value={shippingInput}
                onChange={(e) => { setShippingInput(e.target.value); setShippingSaved(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") saveShippingConfig(); }}
                placeholder={String(LOGISTICA_PROPIA_COSTO_POR_PEDIDO)}
                style={{ ...inputStyle, width: "140px" }}
              />
              <button
                onClick={saveShippingConfig}
                style={{ background: "var(--yellow)", border: "none", borderRadius: "var(--radius)", padding: "8px 18px", color: "#000", fontFamily: "var(--font-display)", fontWeight: "700", fontSize: "13px", cursor: "pointer" }}
              >
                Guardar
              </button>
              {shippingOverride !== null && (
                <button
                  onClick={clearShippingConfig}
                  style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 14px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "12px", cursor: "pointer" }}
                >
                  Restaurar default
                </button>
              )}
            </div>
          </div>

          <div>
            <p style={{ ...labelStyle, marginBottom: "4px" }}>Valor activo</p>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <p style={{ fontFamily: "var(--font-display)", fontSize: "22px", fontWeight: "800", color: shippingOverride !== null ? "var(--green)" : "var(--yellow)" }}>
                {formatARS(shippingOverride ?? LOGISTICA_PROPIA_COSTO_POR_PEDIDO)}
              </p>
              {shippingOverride === null && (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "#ff8c00", background: "rgba(255,140,0,0.1)", border: "1px solid rgba(255,140,0,0.25)", borderRadius: "4px", padding: "2px 7px" }}>
                  ⚠ pendiente confirmar
                </span>
              )}
              {shippingOverride !== null && (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: "var(--green)", background: "var(--green-dim)", border: "1px solid rgba(0,212,160,0.25)", borderRadius: "4px", padding: "2px 7px" }}>
                  override activo
                </span>
              )}
            </div>
          </div>
        </div>

        {shippingSaved && (
          <p style={{ marginTop: "12px", fontSize: "12px", color: "var(--green)", fontFamily: "var(--font-mono)" }}>
            ✓ Guardado. El badge de advertencia desaparecerá de Rentabilidad.
          </p>
        )}
      </div>

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
