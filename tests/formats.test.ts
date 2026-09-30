import { describe, expect, it } from "vitest";
import { computeMetrics, DEFAULT_BUCKETS, DEFAULT_RISK } from "../src/lib/calc";
import { parseDate } from "../src/lib/dates";
import { parseMoneyCents } from "../src/lib/money";
import { suggestMapping, type FieldId } from "../src/lib/mapping";
import { detectTerms, normalizeImport, type SheetConfig } from "../src/lib/normalize";
import { inspectSheet } from "../src/lib/workbook";

// Same underlying business data expressed in three very different company formats.
const D = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const base = [
  ["905559", "SAI & SONS PTY LTD", "2026-08-27", 2562.0, 7, "2026-08-20"],
  ["905559", "SAI & SONS PTY LTD", "2026-09-25", 400.5, 7, "2026-09-18"],
  ["905560", "MORE THAN MILK CO", "2026-09-10", 10000, 14, "2026-08-27"],
  ["905561", "GLOBAL FOOD & WINE", "2026-10-15", 250, 30, "2026-09-15"],
  ["905561", "GLOBAL FOOD & WINE", "2026-09-20", -100, 30, "2026-09-20"],
] as const;

const A: unknown[][] = [
  ["AR Open Items — FBL5N"], [], ["Run date 29.09.2026"],
  ["Customer", "Customer Name1", "Net due dt", "Amt in loc.cur.", "PayT", "User Name"],
  ...base.map((r) => [r[0], r[1], r[2].split("-").reverse().join("."), r[3].toLocaleString("en-US", { minimumFractionDigits: 2 }), `AR0${r[4] === 7 ? 2 : r[4] === 14 ? 3 : 5}`, "jsmith"]),
];
const B: unknown[][] = [
  ["Account Number", "Business Name", "Due Date", "Outstanding Amount", "Payment Terms"],
  ...base.map((r) => [r[0], r[1], D(+r[2].slice(0, 4), +r[2].slice(5, 7), +r[2].slice(8, 10)), r[3], `Net ${r[4]}`]),
];
const C: unknown[][] = [
  ["Overdue register (internal)", null, null, null, null],
  ["Client Ref", "Trading Name", "Expected Payment Date", "Open Balance", "Credit Days"],
  ...base.map((r) => [Number(r[0]), r[1], r[2], r[3] < 0 ? `(${Math.abs(r[3]).toFixed(2)})` : r[3].toFixed(2), r[4]]),
];

function run(raw: unknown[][], termDays: Record<string, number | null> = {}) {
  const sheet = inspectSheet("s", raw)!;
  expect(sheet.kind).toBe("open_items");
  const sug = suggestMapping(sheet.headers, sheet.rows, "open_items");
  const mapping: SheetConfig["mapping"] = {};
  sug.forEach((s) => { if (s.field && s.confidence >= 0.7) mapping[s.field as FieldId] = s.index; });
  for (const f of ["customer_id", "customer_name", "due_date", "amount", "payment_terms"] as FieldId[]) expect(mapping[f], f).toBeDefined();
  const cfg: SheetConfig = { sheet, kind: "open_items", mapping };
  const { dataset, issues } = normalizeImport({ fileName: "x", sheets: [cfg], asOf: "2026-09-29", currency: "AUD", termDays });
  expect(issues.filter((i) => i.severity === "ERROR")).toEqual([]);
  return { dataset, terms: detectTerms(cfg), m: computeMetrics(dataset.items, [], { asOf: "2026-09-29", buckets: DEFAULT_BUCKETS, risk: DEFAULT_RISK }) };
}

describe("three formats -> same dashboard", () => {
  const a = run(A, { AR02: 7, AR03: 14, AR05: 30 }); // SAP codes need user mapping
  const b = run(B);
  const c = run(C);
  const strip = (r: ReturnType<typeof run>) => r.dataset.items.map(({ sourceRow, termCode, ...x }) => x);
  it("normalizes to identical canonical items", () => {
    expect(strip(b)).toEqual(strip(a));
    expect(strip(c)).toEqual(strip(a));
  });
  it("produces identical metrics", () => {
    expect(b.m).toEqual(a.m);
    expect(c.m).toEqual(a.m);
  });
  it("computes the expected numbers", () => {
    // total = 2562 + 400.5 + 10000 + 250 - 100 = 13112.50
    expect(a.m.totalCents).toBe(1311250);
    // overdue: 2562 (33d) + 10000 (19d) ; 400.5 due 09-25 (4d) ; -100 due 09-20 (9d) ; 250 not due
    expect(a.m.overdueCents).toBe(256200 + 40050 + 1000000 - 10000);
    expect(a.m.customerCount).toBe(3);
    expect(a.m.overdueCustomers).toBe(2); // 905561 only has an overdue credit (-100), so overdue is not > 0
    const bk = Object.fromEntries(a.m.aging.map((x) => [x.bucket.key, x.cents]));
    expect(bk["1_7"]).toBe(40050);
    expect(bk["8_14"]).toBe(-10000);
    expect(bk["15_30"]).toBe(1000000);
    expect(bk["31_60"]).toBe(256200);
    expect(bk["current"]).toBe(25000);
    expect(a.m.aging.reduce((s, x) => s + x.cents, 0)).toBe(a.m.totalCents);
  });
  it("flags SAP term codes as needing a mapping", () => {
    expect(run(A, {}).terms.some((t) => t.code === "AR02" && t.suggested === null)).toBe(true);
  });
});

describe("parsers", () => {
  it("money", () => {
    expect(parseMoneyCents("1,234.50")).toBe(123450);
    expect(parseMoneyCents("(1,234.50)")).toBe(-123450);
    expect(parseMoneyCents("1.234,50")).toBe(123450);
    expect(parseMoneyCents("$ 99")).toBe(9900);
    expect(parseMoneyCents("12-")).toBe(-1200);
    expect(parseMoneyCents("abc")).toBeNull();
    expect(parseMoneyCents("")).toBeNull();
  });
  it("dates", () => {
    expect(parseDate("29.09.2026")).toBe("2026-09-29");
    expect(parseDate("2026-09-29")).toBe("2026-09-29");
    expect(parseDate("03/04/2026")).toBe("2026-04-03"); // day-first
    expect(parseDate("13/04/2026")).toBe("2026-04-13");
    expect(parseDate(46294)).toBe("2026-09-29"); // Excel serial
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("nonsense")).toBeNull();
  });
});

describe("weekly comparison is like-for-like", () => {
  it("does not compare a part-week with a full week", () => {
    const items = [{ customerId: "1", customerName: "x", document: "", postingDate: null, dueDate: null, amountCents: 100, termCode: "", termDays: null, dimension: "", sourceRow: 2 }];
    // asOf Wed 2026-09-30: week starts Mon 09-28
    const pay = (date: string, c: number) => ({ customerId: "1", date, amountCents: c, sourceRow: 1 });
    const m = computeMetrics(items, [pay("2026-09-28", 100), pay("2026-09-29", 100), pay("2026-09-21", 100), pay("2026-09-22", 100), pay("2026-09-26", 1000)], { asOf: "2026-09-30", buckets: DEFAULT_BUCKETS, risk: DEFAULT_RISK });
    expect(m.paymentsThisWeekCents).toBe(200);
    expect(m.paymentsSameDaysLastWeekCents).toBe(200); // Mon-Wed last week
    expect(m.paymentsLastWeekCents).toBe(1200); // full last week incl. the Saturday
    expect(m.wowPct).toBe(0);
  });
});
