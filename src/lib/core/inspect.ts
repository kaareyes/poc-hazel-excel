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

