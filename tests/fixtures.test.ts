import { describe, expect, it } from "vitest";
import readXlsx from "read-excel-file/node";
import { computeMetrics, DEFAULT_BUCKETS, DEFAULT_RISK } from "../src/lib/calc";
import { suggestMapping, type FieldId } from "../src/lib/mapping";
import { normalizeImport, type SheetConfig } from "../src/lib/normalize";
import { inspectSheet } from "../src/lib/workbook";

async function load(file: string) {
  const sheets = (await readXlsx(`fixtures/formats/${file}`)) as { sheet: string; data: unknown[][] }[];
  const configs: SheetConfig[] = [];
  for (const s of sheets) {
    const ins = inspectSheet(s.sheet, s.data)!;
    if (ins.kind === "ignore") continue;
    const mapping: SheetConfig["mapping"] = {};
    suggestMapping(ins.headers, ins.rows, ins.kind).forEach((x) => { if (x.field && x.confidence >= 0.7) mapping[x.field as FieldId] = x.index; });
    configs.push({ sheet: ins, kind: ins.kind, mapping });
  }
  const termDays = { AR02: 7, AR03: 14, AR05: 30, NO21: 21 }; // what the user confirms for SAP codes
  const { dataset, issues } = normalizeImport({ fileName: file, sheets: configs, asOf: "2026-09-29", currency: "AUD", termDays });
  return { dataset, issues, kinds: configs.map((c) => c.kind), m: computeMetrics(dataset.items, dataset.payments, { asOf: "2026-09-29", buckets: DEFAULT_BUCKETS, risk: DEFAULT_RISK }) };
}

describe("real .xlsx fixtures A/B/C produce the same dashboard", async () => {
  const [a, b, c] = await Promise.all(["A-sap-style.xlsx", "B-generic.xlsx", "C-strange-naming.xlsx"].map(load));
  it("detects an open-items and a payments sheet in each", () => {
    for (const r of [a, b, c]) expect(r.kinds.sort()).toEqual(["open_items", "payments"]);
  });
  it("no errors", () => {
    for (const r of [a, b, c]) expect(r.issues.filter((i) => i.severity === "ERROR")).toEqual([]);
  });
  it("identical metrics across formats", () => {
    expect(b.m.totalCents).toBe(a.m.totalCents);
    expect(c.m.totalCents).toBe(a.m.totalCents);
    expect(b.m.overdueCents).toBe(a.m.overdueCents);
    expect(c.m.overdueCents).toBe(a.m.overdueCents);
    expect(b.m.aging).toEqual(a.m.aging);
    expect(c.m.aging).toEqual(a.m.aging);
    expect(b.m.paymentsThisWeekCents).toBe(a.m.paymentsThisWeekCents);
    expect(c.m.weekly).toEqual(a.m.weekly);
    expect(c.m.customerCount).toBe(12);
  });
  it("skipped the Total row in format C", () => {
    expect(c.issues.some((i) => i.code === "SUBTOTAL_ROW_SKIPPED")).toBe(true);
  });
});
