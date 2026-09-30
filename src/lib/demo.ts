import { addDays, todayIso } from "@/lib/core";
import type { Dataset, OpenItem, Payment } from "@/lib/core";

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["Harbour Fresh Foods", "Bright Retail Group", "Cedar Supplies", "Delta Wholesale", "Evergreen Market", "Ironbark Trading", "Jupiter Stores", "Kangaroo Distribution", "Lighthouse Cafe Co", "Metro Provisions", "Northstar Grocers", "Orchid Wholesale", "Pacific Market", "Queensland Dairy Supply", "Riverbend Bakery", "Summit Hospitality", "Tidewater Deli", "Uplands Catering", "Valley Fresh IGA", "Westside Foodservice", "Yarra Provedores", "Zenith Convenience", "Amber Coffee Roasters", "Banksia Nursing Home", "Coastal Fresh Market", "Driftwood Kitchens", "Eastgate Supermarket", "Fernhill School Canteen", "Granite Belt Produce", "Hilltop Pantry"];

/** Deterministic sample dataset relative to `asOf` so the page always has a realistic story. */
export function makeSampleDataset(asOf = todayIso()): Dataset {
  const r = rng(42);
  const units = ["North", "South", "West"];
  const termDays = [7, 7, 7, 14, 14, 21, 30, 45];
  const items: OpenItem[] = [];
  const payments: Payment[] = [];
  let row = 2;
  NAMES.forEach((name, ci) => {
    const size = Math.pow(r(), 2.2) * 9 + 0.25; // heavy tail
    const days = termDays[Math.floor(r() * termDays.length)];
    const unit = units[ci % 3];
    const n = 3 + Math.floor(r() * 9);
    for (let k = 0; k < n; k++) {
      const age = Math.floor(r() * (r() > 0.8 ? 130 : 45));
      const posting = addDays(asOf, -age);
      const amount = Math.round((400 + r() * 6000) * size) * 100 + Math.round(r() * 99);
      items.push({
        customerId: String(100200 + ci), customerName: name, document: String(1900000 + ci * 40 + k),
        postingDate: posting, dueDate: addDays(posting, days), amountCents: r() < 0.04 ? -Math.round(amount / 3) : amount,
        termCode: `Net ${days}`, termDays: days, dimension: unit, sourceRow: row++,
      });
    }
    const weeks = 10;
    for (let w = 0; w < weeks; w++) {
      if (r() < (ci % 7 === 0 ? 0.15 : 0.55)) {
        const date = addDays(asOf, -(w * 7 + Math.floor(r() * 7)));
        payments.push({ customerId: String(100200 + ci), date, amountCents: Math.round((300 + r() * 4000) * size) * 100, sourceRow: row++ });
      }
    }
  });
  return { kind: "sample", name: "Sample data", asOf, currency: "AUD", dimensionLabel: "Business unit", items, payments, notes: [] };
}
