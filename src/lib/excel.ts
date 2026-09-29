import * as XLSX from "xlsx";
import { PERSON_COLUMNS, type Person } from "@/types/person";
import { EXCEL_URL, FETCH_TIMEOUT_MS } from "./config";

export type ExcelErrorCode =
  | "NETWORK_OR_CORS"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "NOT_XLSX"
  | "INVALID_WORKBOOK"
  | "NO_WORKSHEET"
  | "EMPTY"
  | "MISSING_COLUMNS";

export class ExcelError extends Error {
  constructor(
    public code: ExcelErrorCode,
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
  }
}

export interface LoadResult {
  rows: Person[];
  sheetName: string;
  httpStatus: number;
  fetchedAt: Date;
  finalUrlHost: string;
}

/** Downloads the workbook bytes in the browser. Cache-busts and disables HTTP caching. */
export async function fetchWorkbook(url: string = EXCEL_URL) {
  const sep = url.includes("?") ? "&" : "?";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${url}${sep}_=${Date.now()}`, { cache: "no-store", signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new ExcelError("TIMEOUT", "Request timed out.");
    // Browsers hide the real reason: CORS blocks and offline both surface as a TypeError.
    throw new ExcelError(
      "NETWORK_OR_CORS",
      "The browser could not fetch the workbook (network error or blocked by CORS).",
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ExcelError("HTTP_ERROR", `Server responded with HTTP ${res.status}.`, res.status);
  const buffer = await res.arrayBuffer();
  const host = (() => {
    try {
      return new URL(res.url).host;
    } catch {
      return "unknown";
    }
  })();
  return { buffer, status: res.status, host };
}

/** Parses XLSX bytes into a workbook, rejecting HTML (viewer pages) and corrupt files. */
export function parseWorkbook(buffer: ArrayBuffer): XLSX.WorkBook {
  const head = new Uint8Array(buffer.slice(0, 2));
  if (!(head[0] === 0x50 && head[1] === 0x4b)) {
    throw new ExcelError("NOT_XLSX", "Response was not an XLSX file (likely an HTML viewer/login page).");
  }
  try {
    return XLSX.read(buffer, { type: "array" });
  } catch {
    throw new ExcelError("INVALID_WORKBOOK", "The file could not be read as an Excel workbook.");
  }
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

/** Maps sheet rows to Person by header name (case-insensitive), skipping empty rows. */
export function normalizeRows(raw: Record<string, unknown>[]): Person[] {
  if (raw.length === 0) throw new ExcelError("EMPTY", "The worksheet has no data rows.");
  const headers = Object.keys(raw[0]);
  const byLower = new Map(headers.map((h) => [norm(h), h]));
  const missing = PERSON_COLUMNS.filter((c) => !byLower.has(norm(c)));
  if (missing.length === PERSON_COLUMNS.length) {
    throw new ExcelError("MISSING_COLUMNS", `Expected columns not found. Found: ${headers.join(", ")}`);
  }
  const rows = raw.map((r) => {
    const p = {} as Person;
    for (const c of PERSON_COLUMNS) {
      const h = byLower.get(norm(c));
      p[c] = h ? cell(r[h]) : "";
    }
    return p;
  });
  const nonEmpty = rows.filter((p) => PERSON_COLUMNS.some((c) => p[c] !== ""));
  if (nonEmpty.length === 0) throw new ExcelError("EMPTY", "The worksheet has no data rows.");
  return nonEmpty;
}

/** Full pipeline: fetch → ArrayBuffer → XLSX.read → worksheet → JSON → Person[]. */
export async function loadPeople(url: string = EXCEL_URL): Promise<LoadResult> {
  const { buffer, status, host } = await fetchWorkbook(url);
  const wb = parseWorkbook(buffer);
  const sheetName = wb.SheetNames[0];
  const ws = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!ws) throw new ExcelError("NO_WORKSHEET", "The workbook contains no worksheet.");
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "", blankrows: false });
  return { rows: normalizeRows(raw), sheetName, httpStatus: status, fetchedAt: new Date(), finalUrlHost: host };
}

export const DEMO_ROWS: Person[] = [
  { Name: "Niña", Gender: "Female", Location: "Mandaluyong", city: "Santa Maria", province: "Bulacan" },
  { Name: "Hazel", Gender: "Female", Location: "Ortigas", city: "Santa Maria", province: "Bulacan" },
  { Name: "Bella", Gender: "Female", Location: "Santa Maria", city: "Santa Maria", province: "Bulacan" },
];
