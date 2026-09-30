import { addDays, diffDays, weekStart } from "./dates";
import type { Bucket, CalcConfig, CustomerRow, DashboardMetrics, OpenItem, Payment } from "./types";

export const DEFAULT_BUCKETS: Bucket[] = [
  { key: "current", label: "Current", from: 0, to: 0 },
  { key: "1_7", label: "1–7", from: 1, to: 7 },
  { key: "8_14", label: "8–14", from: 8, to: 14 },
  { key: "15_30", label: "15–30", from: 15, to: 30 },
  { key: "31_60", label: "31–60", from: 31, to: 60 },
  { key: "61_90", label: "61–90", from: 61, to: 90 },
  { key: "90p", label: "90+", from: 91, to: null },
];

export const DEFAULT_RISK = { balanceCents: 1_000_000, overduePct: 50 };
export const TERM_GROUPS = [7, 14, 21, 30];
export const OTHER_TERM = "Other / Unmapped";

export const termGroup = (days: number | null) => (days !== null && TERM_GROUPS.includes(days) ? `${days} Days` : OTHER_TERM);

function bucketFor(buckets: Bucket[], days: number): Bucket {
  return buckets.find((b) => days >= b.from && (b.to === null || days <= b.to)) ?? buckets[buckets.length - 1];
}

/**
 * Pure, deterministic AR calculations. Money is integer cents; dates are ISO day strings.
 * Definitions: see ARCHITECTURE.md §7. No AI, no I/O.
 */
export function computeMetrics(items: OpenItem[], payments: Payment[], cfg: CalcConfig): DashboardMetrics {
  const { asOf, buckets, risk } = cfg;
  const aging = buckets.map((bucket) => ({ bucket, cents: 0, count: 0 }));
  const cust = new Map<string, CustomerRow & { _dims: Set<string>; _terms: Set<string> }>();
  const termAgg = new Map<string, { balanceCents: number; overdueCents: number; c: Set<string> }>();
  const dimAgg = new Map<string, { balanceCents: number; overdueCents: number; c: Set<string> }>();
  let total = 0, overdue = 0, undated = 0;

  for (const it of items) {
    const due = it.dueDate;
    if (!due) undated++;
    const days = due ? Math.max(0, diffDays(asOf, due)) : 0;
    const isOverdue = days >= 1;
    total += it.amountCents;
    if (isOverdue) overdue += it.amountCents;
    const b = aging.find((a) => a.bucket === bucketFor(buckets, days))!;
    b.cents += it.amountCents;
    b.count++;

    let c = cust.get(it.customerId);
    if (!c) {
      c = {
        customerId: it.customerId, name: it.customerName, dimensions: [], terms: [], balanceCents: 0, overdueCents: 0,
        overduePct: null, oldestDue: null, maxDaysOverdue: 0, lastPayment: null, lastPaymentCents: null,
        daysSincePayment: null, paidThisWeekCents: 0, paidLastWeekCents: 0, highRisk: false, itemCount: 0,
        _dims: new Set(), _terms: new Set(),
      };
      cust.set(it.customerId, c);
    }
    c.balanceCents += it.amountCents;
    if (isOverdue) c.overdueCents += it.amountCents;
    c.itemCount++;
    if (it.dimension) c._dims.add(it.dimension);
    const tg = termGroup(it.termDays);
    c._terms.add(tg);
    if (due && it.amountCents > 0 && (!c.oldestDue || due < c.oldestDue)) c.oldestDue = due;
    c.maxDaysOverdue = Math.max(c.maxDaysOverdue, days);

    const t = termAgg.get(tg) ?? { balanceCents: 0, overdueCents: 0, c: new Set<string>() };
    t.balanceCents += it.amountCents;
    if (isOverdue) t.overdueCents += it.amountCents;
    t.c.add(it.customerId);
    termAgg.set(tg, t);
    if (it.dimension) {
      const d = dimAgg.get(it.dimension) ?? { balanceCents: 0, overdueCents: 0, c: new Set<string>() };
      d.balanceCents += it.amountCents;
      if (isOverdue) d.overdueCents += it.amountCents;
      d.c.add(it.customerId);
      dimAgg.set(it.dimension, d);
    }
  }

  // ---- payments (only those on/before as-of) ----
  const thisStart = weekStart(asOf);
  const lastStart = addDays(thisStart, -7);
  const sameDayLastWeekEnd = addDays(asOf, -7);
  const inRange = (d: string, a: string, b: string) => d >= a && d <= b;
  let wtd = 0, sameDays = 0, lastFull = 0;
  const weeklyTotals = new Map<string, number>();
  let minP: string | null = null, maxP: string | null = null;

  const lastPay = new Map<string, { date: string; cents: number }>();
  for (const p of payments) {
    if (p.date > asOf) continue;
    if (!minP || p.date < minP) minP = p.date;
    if (!maxP || p.date > maxP) maxP = p.date;
    const ws = weekStart(p.date);
    weeklyTotals.set(ws, (weeklyTotals.get(ws) ?? 0) + p.amountCents);
    const c = cust.get(p.customerId);
    if (inRange(p.date, thisStart, asOf)) { wtd += p.amountCents; if (c) c.paidThisWeekCents += p.amountCents; }
    if (inRange(p.date, lastStart, sameDayLastWeekEnd)) sameDays += p.amountCents;
    if (inRange(p.date, lastStart, addDays(thisStart, -1))) { lastFull += p.amountCents; if (c) c.paidLastWeekCents += p.amountCents; }
    const lp = lastPay.get(p.customerId);
    if (!lp || p.date > lp.date) lastPay.set(p.customerId, { date: p.date, cents: p.amountCents });
    else if (p.date === lp.date) lp.cents += p.amountCents;
  }

  const customers: CustomerRow[] = [...cust.values()].map((c) => {
    const lp = lastPay.get(c.customerId);
    const pct = c.balanceCents > 0 ? (c.overdueCents / c.balanceCents) * 100 : null;
    const { _dims, _terms, ...row } = c;
    return {
      ...row,
      dimensions: [..._dims].sort(),
      terms: [..._terms].sort(),
      overduePct: pct,
      lastPayment: lp?.date ?? null,
      lastPaymentCents: lp?.cents ?? null,
      daysSincePayment: lp ? diffDays(asOf, lp.date) : null,
      highRisk: c.balanceCents > risk.balanceCents && pct !== null && pct > risk.overduePct,
    };
  });

  const weekly: DashboardMetrics["weekly"] = [];
  for (let k = 7; k >= 0; k--) {
    const ws = addDays(thisStart, -7 * k);
    weekly.push({ weekStart: ws, cents: weeklyTotals.get(ws) ?? 0, partial: k === 0 && asOf < addDays(ws, 6) });
  }

  const terms = [...TERM_GROUPS.map((d) => `${d} Days`), OTHER_TERM];
  return {
    totalCents: total,
    overdueCents: overdue,
    currentCents: total - overdue,
    overduePct: total > 0 ? (overdue / total) * 100 : null,
    customerCount: customers.length,
    overdueCustomers: customers.filter((c) => c.overdueCents > 0).length,
    itemCount: items.length,
    undatedItems: undated,
    paymentsThisWeekCents: wtd,
    paymentsSameDaysLastWeekCents: sameDays,
    paymentsLastWeekCents: lastFull,
    wowPct: sameDays > 0 ? ((wtd - sameDays) / sameDays) * 100 : null,
    aging,
    byTerm: terms.map((label) => {
      const t = termAgg.get(label);
      return { label, balanceCents: t?.balanceCents ?? 0, overdueCents: t?.overdueCents ?? 0, customers: t?.c.size ?? 0 };
    }),
    byDimension: [...dimAgg.entries()]
      .map(([value, d]) => ({ value, balanceCents: d.balanceCents, overdueCents: d.overdueCents, customers: d.c.size }))
      .sort((a, b) => b.balanceCents - a.balanceCents),
    weekly,
    customers,
    paymentWindow: minP && maxP ? { from: minP, to: maxP } : null,
  };
}
