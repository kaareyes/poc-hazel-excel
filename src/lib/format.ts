export function fmtMoney(cents: number, currency = "AUD"): string {
  try {
    return new Intl.NumberFormat("en-AU", { style: "currency", currency, maximumFractionDigits: 0 }).format(cents / 100);
  } catch {
    return `${Math.round(cents / 100).toLocaleString()}`;
  }
}
export const fmtCompact = (cents: number, currency = "AUD"): string => {
  try {
    return new Intl.NumberFormat("en-AU", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(cents / 100);
  } catch {
    return String(Math.round(cents / 100));
  }
};
export const fmtPct = (v: number | null, d = 1) => (v == null ? "—" : `${v.toFixed(d)}%`);
