import { addDays, parseDate } from "./dates";
import { parseMoneyCents } from "./money";
import type { FieldId } from "./mapping";
import type { InspectedSheet } from "./inspect";
import type { Dataset, OpenItem, Payment } from "./types";

export type Severity = "INFO" | "WARNING" | "ERROR";
export interface Issue {
  severity: Severity;
  code: string;
  message: string;
}

export interface SheetConfig {
  sheet: InspectedSheet;
  kind: "open_items" | "payments";
  mapping: Partial<Record<FieldId, number>>; // field -> column index
}

export interface ImportInput {
  fileName: string;
  sheets: SheetConfig[];
  asOf: string;
  currency: string;
  termDays: Record<string, number | null>; // raw term value -> days (user-confirmed)
}

/** "7", "Net 7", "NET30", "30 days", "14D" -> days. Anything else is a code the user must map. */
export function guessTermDays(raw: string): number | null {
  const m = raw.trim().match(/^(?:net\s*)?(\d{1,3})\s*(?:d|days?)?$/i);
  return m ? +m[1] : null;
}

const cell = (row: unknown[], idx: number | undefined) => (idx == null ? undefined : row[idx]);
const str = (v: unknown) => (v == null ? "" : v instanceof Date ? (parseDate(v) ?? "") : String(v).trim());

/** Distinct payment-term values found in the open-items sheet, with counts and suggested days. */
export function detectTerms(cfg: SheetConfig | undefined): { code: string; count: number; suggested: number | null }[] {
  if (!cfg || cfg.mapping.payment_terms == null) return [];
  const counts = new Map<string, number>();
  for (const r of cfg.sheet.rows) {
    const v = str(r[cfg.mapping.payment_terms]);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count, suggested: code ? guessTermDays(code) : null }))
    .sort((a, b) => b.count - a.count);
}

export function normalizeImport(input: ImportInput): { dataset: Dataset; issues: Issue[] } {
  const issues: Issue[] = [];
  const items: OpenItem[] = [];
  const payments: Payment[] = [];
  const open = input.sheets.find((s) => s.kind === "open_items");
  let dimensionLabel = "Segment";

  if (!open) issues.push({ severity: "ERROR", code: "SHEET_NOT_FOUND", message: "No worksheet is set as Open Items." });

  if (open) {
    const m = open.mapping;
    for (const f of ["customer_id", "amount", "due_date"] as FieldId[])
      if (m[f] == null) issues.push({ severity: "ERROR", code: "REQ_FIELD_MISSING", message: `Required field not mapped: ${f.replace("_", " ")}.` });
    if (m.dimension != null) dimensionLabel = open.sheet.headers[m.dimension] || "Segment";

    let subtotals = 0, noCustomer = 0, badAmount = 0, badDue = 0, noDue = 0, derived = 0, credits = 0, dups = 0, unmappedTerms = 0;
    const seen = new Set<string>();
    const unmappedCodes = new Set<string>();
    open.sheet.rows.forEach((r, i) => {
      const customerId = str(cell(r, m.customer_id));
      const amountCents = parseMoneyCents(cell(r, m.amount));
      if (/^(grand\s*|sub\s*)?total[s]?$|^result$|^summe$/i.test(customerId) || /^(grand\s*|sub\s*)?total/i.test(str(cell(r, m.customer_name)))) { subtotals++; return; }
      if (!customerId) { noCustomer++; return; }
      if (amountCents === null) { badAmount++; return; }
      const rawDue = cell(r, m.due_date);
      let dueDate = parseDate(rawDue);
      if (rawDue != null && rawDue !== "" && !dueDate) badDue++;
      const postingDate = parseDate(cell(r, m.posting_date));
      const termCode = str(cell(r, m.payment_terms));
      let termDays: number | null = null;
      if (m.payment_terms != null) {
        termDays = termCode in input.termDays ? input.termDays[termCode] : guessTermDays(termCode);
        if (termDays === null) { unmappedTerms++; unmappedCodes.add(termCode || "(blank)"); }
      }
      if (!dueDate) {
        if (postingDate && termDays !== null) { dueDate = addDays(postingDate, termDays); derived++; }
        else noDue++;
      }
      if (amountCents < 0) credits++;
      const name1 = str(cell(r, m.customer_name));
      const name2 = str(cell(r, m.customer_name_2));
      const customerName = name1 ? (name2 && name2 !== name1 ? `${name1} · ${name2}` : name1) : name2 || customerId;
      const document = str(cell(r, m.document_number));
      if (document) {
        const key = `${customerId}|${document}|${amountCents}|${dueDate}`;
        if (seen.has(key)) dups++;
        seen.add(key);
      }
      items.push({
        customerId, customerName, document, postingDate, dueDate, amountCents, termCode, termDays,
        dimension: str(cell(r, m.dimension)) || (m.dimension != null ? "Unassigned" : ""),
        sourceRow: open.sheet.firstDataRowNumber + i,
      });
    });
    if (subtotals) issues.push({ severity: "INFO", code: "SUBTOTAL_ROW_SKIPPED", message: `${subtotals} total/subtotal row(s) skipped.` });
    if (noCustomer) issues.push({ severity: "WARNING", code: "CUSTOMER_ID_MISSING", message: `${noCustomer} row(s) skipped: blank customer ID.` });
    if (badAmount) issues.push({ severity: "WARNING", code: "AMOUNT_INVALID", message: `${badAmount} row(s) skipped: amount is not a number.` });
    if (badDue) issues.push({ severity: "WARNING", code: "DATE_INVALID", message: `${badDue} due date(s) could not be read.` });
    if (derived) issues.push({ severity: "INFO", code: "DUE_DATE_DERIVED", message: `${derived} item(s) had no due date; derived from posting date + payment terms.` });
    if (noDue) issues.push({ severity: "WARNING", code: "DUE_DATE_MISSING", message: `${noDue} item(s) have no usable due date and are treated as not overdue.` });
    if (unmappedTerms) issues.push({ severity: "WARNING", code: "PAYMENT_TERM_UNMAPPED", message: `${unmappedTerms} item(s) have payment terms without a day count (${[...unmappedCodes].slice(0, 6).join(", ")}); shown as Other / Unmapped.` });
    if (dups) issues.push({ severity: "WARNING", code: "DUPLICATE_ROW", message: `${dups} possible duplicate row(s) (same customer, document, amount and due date).` });
    if (credits) issues.push({ severity: "INFO", code: "CREDITS", message: `${credits} negative item(s) (credits) are netted into balances.` });
    const unmappedCols = open.sheet.headers.filter((h, i) => h && !Object.values(m).includes(i));
    if (unmappedCols.length) issues.push({ severity: "INFO", code: "UNMAPPED_COLUMNS", message: `Ignored columns: ${unmappedCols.slice(0, 8).join(", ")}${unmappedCols.length > 8 ? "…" : ""}.` });
  }

  for (const p of input.sheets.filter((s) => s.kind === "payments")) {
    const m = p.mapping;
    for (const f of ["customer_id", "payment_date", "amount"] as FieldId[])
      if (m[f] == null) issues.push({ severity: "ERROR", code: "REQ_FIELD_MISSING", message: `Payments sheet "${p.sheet.name}": required field not mapped: ${f.replace("_", " ")}.` });
    let bad = 0;
    p.sheet.rows.forEach((r, i) => {
      const customerId = str(cell(r, m.customer_id));
      const date = parseDate(cell(r, m.payment_date));
      const cents = parseMoneyCents(cell(r, m.amount));
      if (!customerId || !date || cents === null) { bad++; return; }
      payments.push({ customerId, date, amountCents: Math.abs(cents), sourceRow: p.sheet.firstDataRowNumber + i });
    });
    if (bad) issues.push({ severity: "WARNING", code: "PAYMENT_INVALID", message: `${bad} payment row(s) skipped (missing customer, date or amount).` });
  }
  if (open && !input.sheets.some((s) => s.kind === "payments"))
    issues.push({ severity: "INFO", code: "NO_PAYMENTS", message: "No Payments sheet selected — payment figures will show $0." });
  if (items.length === 0 && open) issues.push({ severity: "ERROR", code: "NO_ROWS", message: "No valid open items were found with this mapping." });

  return {
    dataset: {
      kind: "upload", name: input.fileName, asOf: input.asOf, currency: input.currency, dimensionLabel,
      items, payments, notes: issues.filter((i) => i.severity !== "INFO").map((i) => i.message),
    },
    issues,
  };
}
