/** Parse a cell into integer cents. Returns null (never 0) when it is not a number. */
export function parseMoneyCents(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  let s = String(v).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (/-$/.test(s)) {
    neg = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/[^\d.,-]/g, "");
  if (s.startsWith("-")) {
    neg = true; // leading minus
    s = s.slice(1);
  }
  if (!s || !/\d/.test(s)) return null;
  // decide decimal separator: the last of , or . followed by 1-2 digits at the end
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastComma > lastDot && /,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  const c = Math.round(n * 100);
  return neg ? -c : c;
}
