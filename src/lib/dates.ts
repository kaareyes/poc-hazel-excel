const pad = (n: number) => String(n).padStart(2, "0");

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function toEpochDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function fromEpochDay(n: number): string {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export const diffDays = (a: string, b: string) => toEpochDay(a) - toEpochDay(b);
export const addDays = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);

/** Start of week containing `iso` (default Monday). Pure calendar arithmetic, no timezones. */
export function weekStart(iso: string, startDay = 1): string {
  const dow = new Date(toEpochDay(iso) * 86400000).getUTCDay();
  return addDays(iso, -((dow - startDay + 7) % 7));
}

function valid(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Parse a cell into an ISO date. Day-first for ambiguous a/b/yyyy strings
 * (AU/UK/SAP convention); month-first only when the day part cannot be a month.
 */
export function parseDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const t = new Date(v.getTime() + 12 * 3600 * 1000); // absorb tz offsets on midnight values
    return valid(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  if (typeof v === "number") {
    if (v > 20000 && v < 80000) return fromEpochDay(Math.floor(v) - 25569); // Excel serial
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const a = +m[1];
    const b = +m[2];
    return valid(y, b, a) ?? valid(y, a, b);
  }
  return null;
}
