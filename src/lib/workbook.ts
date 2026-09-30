import { FIELDS, classifySheet, norm, type SheetKind } from "./mapping";

export interface InspectedSheet {
  name: string;
  headerRow: number; // 0-based index into raw
  headers: string[];
  rows: unknown[][]; // data rows after header
  firstDataRowNumber: number; // 1-based spreadsheet row number of rows[0]
  kind: SheetKind;
  kindConfidence: number;
  rowCount: number;
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALIAS_SET = new Set(Object.values(FIELDS).flatMap((f) => f.aliases));

function findHeaderRow(raw: unknown[][]): number {
  let best = -1;
  let bestScore = 0;
  const limit = Math.min(raw.length, 40);
  for (let i = 0; i < limit; i++) {
    const r = raw[i] ?? [];
    const strings = r.filter((c) => typeof c === "string" && c.trim() !== "");
    if (strings.length < 3) continue;
    const uniq = new Set(strings.map((s) => norm(s))).size;
    const hits = strings.filter((s) => ALIAS_SET.has(norm(s))).length;
    const followed = raw.slice(i + 1, i + 6).filter((x) => (x ?? []).some((c) => c != null && c !== "")).length;
    const score = hits * 10 + uniq + followed;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export function inspectSheet(name: string, raw: unknown[][]): InspectedSheet | null {
  const headerRow = findHeaderRow(raw);
  if (headerRow < 0) return null;
  const headerCells = raw[headerRow] ?? [];
  const width = Math.max(...raw.slice(headerRow, headerRow + 50).map((r) => (r ?? []).length), headerCells.length);
  const headers: string[] = [];
  for (let c = 0; c < width; c++) headers.push(String(headerCells[c] ?? "").trim());
  const rows = raw.slice(headerRow + 1).filter((r) => (r ?? []).some((c) => c != null && c !== ""));
  const { kind, confidence } = classifySheet(headers, rows);
  return { name, headerRow, headers, rows, firstDataRowNumber: headerRow + 2, kind, kindConfidence: confidence, rowCount: rows.length };
}

export async function readWorkbook(file: File): Promise<{ sheets: InspectedSheet[]; warnings: string[] }> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const lower = file.name.toLowerCase();
  const warnings: string[] = [];
  const out: InspectedSheet[] = [];
  if (lower.endsWith(".xlsx")) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (!(head[0] === 0x50 && head[1] === 0x4b)) throw new Error("This does not look like a valid .xlsx file.");
    const { default: readXlsx } = await import("read-excel-file/browser");
    const sheets = (await readXlsx(file)) as { sheet: string; data: unknown[][] }[];
    for (const s of sheets) {
      const ins = inspectSheet(s.sheet, s.data);
      if (ins) out.push(ins);
      else warnings.push(`Sheet "${s.sheet}" skipped: no header row found.`);
    }
  } else if (lower.endsWith(".csv")) {
    const Papa = (await import("papaparse")).default;
    const text = await file.text();
    const parsed = Papa.parse<unknown[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
    const ins = inspectSheet(file.name, parsed.data as unknown[][]);
    if (ins) out.push(ins);
    else warnings.push("No header row found in the CSV.");
  } else if (lower.endsWith(".xls")) {
    throw new Error("Legacy .xls files aren't supported in this preview yet — please save as .xlsx or .csv.");
  } else {
    throw new Error("Unsupported file type. Use .xlsx or .csv.");
  }
  if (!out.length) throw new Error("No usable worksheet found in this file.");
  return { sheets: out, warnings };
}
