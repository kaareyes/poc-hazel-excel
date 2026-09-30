import { parseDate } from "./dates";
import { parseMoneyCents } from "./money";

export type FieldId =
  | "customer_id" | "customer_name" | "customer_name_2" | "document_number" | "posting_date"
  | "due_date" | "amount" | "payment_terms" | "dimension" | "payment_date";

export type SheetKind = "open_items" | "payments" | "ignore";

export interface FieldSpec {
  id: FieldId;
  label: string;
  kind: "id" | "text" | "date" | "money" | "terms";
  aliases: string[];
}

export const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const F = (id: FieldId, label: string, kind: FieldSpec["kind"], aliases: string[]): FieldSpec => ({ id, label, kind, aliases });

export const FIELDS: Record<FieldId, FieldSpec> = {
  customer_id: F("customer_id", "Customer ID", "id", ["customer", "customerno", "customernumber", "customerid", "custno", "custid", "customercode", "account", "accountno", "accountnumber", "acct", "businesspartner", "clientid", "clientref", "clientno", "client", "debtor", "debtorno", "debtorcode", "debtorid"]),
  customer_name: F("customer_name", "Customer Name", "text", ["customername1", "customername", "name1", "name", "businessname", "tradingname", "clientname", "debtorname", "accountname", "customerdescription", "company", "companyname"]),
  customer_name_2: F("customer_name_2", "Customer Name 2", "text", ["customername2", "name2"]),
  document_number: F("document_number", "Document No.", "id", ["documentno", "documentnumber", "document", "docno", "docnumber", "invoice", "invoiceno", "invoicenumber", "invoicenum", "invno"]),
  posting_date: F("posting_date", "Posting / Document Date", "date", ["pstngdate", "postingdate", "postdate", "docdate", "documentdate", "invoicedate", "issuedate", "date"]),
  due_date: F("due_date", "Due Date", "date", ["netduedt", "netduedate", "duedate", "duedt", "dueon", "expectedpaymentdate", "paymentduedate", "maturitydate", "due"]),
  amount: F("amount", "Amount", "money", ["amtinloccur", "amtinlocalcur", "amountinlocalcurrency", "amountinlocalcurr", "amount", "outstandingamount", "outstanding", "balance", "openamount", "openbalance", "invoicebalance", "amt", "amountdue", "balancedue", "paymentamount", "amountpaid", "received"]),
  payment_terms: F("payment_terms", "Payment Terms", "terms", ["payt", "paymentterms", "paymentterm", "terms", "creditdays", "creditterms", "termsdays", "netdays", "termscode"]),
  dimension: F("dimension", "Ledger / Segment", "text", ["ledger", "ledgerno", "ledgernumber", "businessunit", "division", "region", "segment", "businessarea", "busa", "branch", "entity"]),
  payment_date: F("payment_date", "Payment Date", "date", ["pmntdate", "paymentdate", "datepaid", "receiptdate", "receiveddate", "datereceived", "receivedon", "clearingdate", "postingdate", "pstngdate", "date"]),
};

export const REQUIRED: Record<Exclude<SheetKind, "ignore">, FieldId[]> = {
  open_items: ["customer_id", "amount", "due_date"],
  payments: ["customer_id", "payment_date", "amount"],
};

export const FIELDS_FOR: Record<Exclude<SheetKind, "ignore">, FieldId[]> = {
  open_items: ["customer_id", "customer_name", "customer_name_2", "document_number", "posting_date", "due_date", "amount", "payment_terms", "dimension"],
  payments: ["customer_id", "payment_date", "amount"],
};

export interface ColumnSuggestion {
  index: number;
  header: string;
  field: FieldId | null;
  confidence: number;
  note?: string;
  samples: string[];
}

const sampleOf = (rows: unknown[][], idx: number, n = 200) =>
  rows.slice(0, n).map((r) => r[idx]).filter((v) => v != null && v !== "");

function typeFit(kind: FieldSpec["kind"], values: unknown[]): number {
  if (!values.length) return 0;
  let ok = 0;
  for (const v of values) {
    if (kind === "date") ok += parseDate(v) ? 1 : 0;
    else if (kind === "money") ok += parseMoneyCents(v) !== null ? 1 : 0;
    else if (kind === "terms") ok += 1;
    else ok += String(v).trim() ? 1 : 0;
  }
  return ok / values.length;
}

/** Deterministic alias + type-gate mapper. AI can later replace/refine this (see AI_EXTRACTION.md). */
export function suggestMapping(headers: string[], rows: unknown[][], kind: Exclude<SheetKind, "ignore">): ColumnSuggestion[] {
  const fields = FIELDS_FOR[kind].map((id) => FIELDS[id]);
  const cands: { col: number; field: FieldSpec; conf: number; note?: string }[] = [];
  headers.forEach((h, col) => {
    const nh = norm(h);
    if (!nh) return;
    const vals = sampleOf(rows, col);
    for (const f of fields) {
      let base = 0;
      const exact = f.aliases.indexOf(nh);
      if (exact >= 0) base = nh === "date" || nh === "name" || nh === "balance" || nh === "due" || nh === "client" || nh === "account" ? 0.85 : 0.97;
      else if (nh.length >= 4 && f.aliases.some((a) => a.length >= 4 && (nh.includes(a) || a.includes(nh)))) base = 0.72;
      if (!base) continue;
      const fit = typeFit(f.kind, vals);
      let conf = base;
      let note: string | undefined;
      if (f.kind === "date" || f.kind === "money") {
        if (fit < 0.9) {
          conf = Math.min(conf, 0.3);
          note = `Only ${Math.round(fit * 100)}% of sample values look like ${f.kind === "date" ? "dates" : "amounts"}`;
        }
      } else if (f.kind === "id" && f.id === "customer_id" && vals.length < 1) conf = Math.min(conf, 0.3);
      cands.push({ col, field: f, conf, note });
    }
  });
  cands.sort((a, b) => b.conf - a.conf);
  const usedCols = new Set<number>();
  const usedFields = new Set<FieldId>();
  const chosen = new Map<number, { field: FieldId; conf: number; note?: string }>();
  for (const c of cands) {
    if (usedCols.has(c.col) || usedFields.has(c.field.id)) continue;
    usedCols.add(c.col);
    usedFields.add(c.field.id);
    chosen.set(c.col, { field: c.field.id, conf: c.conf, note: c.note });
  }
  return headers.map((h, index) => {
    const c = chosen.get(index);
    return {
      index,
      header: h,
      field: c ? c.field : null,
      confidence: c ? c.conf : 0,
      note: c?.note,
      samples: sampleOf(rows, index, 50).slice(0, 3).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))),
    };
  });
}

/** Score how well a sheet's headers fit each report type; used to classify sheets. */
export function classifySheet(headers: string[], rows: unknown[][]): { kind: SheetKind; confidence: number } {
  const score = (kind: Exclude<SheetKind, "ignore">) => {
    const s = suggestMapping(headers, rows, kind);
    const req = REQUIRED[kind];
    const confs = req.map((f) => s.find((x) => x.field === f)?.confidence ?? 0);
    return Math.min(...confs);
  };
  const open = score("open_items");
  const pay = score("payments");
  if (open >= 0.6 && open >= pay - 0.05) return { kind: "open_items", confidence: open };
  if (pay >= 0.6) return { kind: "payments", confidence: pay };
  return { kind: "ignore", confidence: Math.max(open, pay) };
}
