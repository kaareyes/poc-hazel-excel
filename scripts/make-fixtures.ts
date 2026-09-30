/* Generates 3 differently-formatted AR workbooks with the same underlying data (POC success test). */
import ExcelJS from "exceljs";

const asOf = new Date(Date.UTC(2026, 8, 29));
const day = (n: number) => new Date(asOf.getTime() - n * 86400000);
const names = ["SAI & SONS PTY LTD", "MORE THAN MILK CO PTY LTD", "GLOBAL FOOD & WINE PTY LTD", "HM DELIVERIES", "BARLOUSKY PTY LTD", "YAMBA MILK ZAPPA ELECTRICAL P/L", "CREEKGOLD PTY LTD", "BEPL PTY LTD", "DACKER PTY LTD", "MILK'N IT PTY LTD", "DAIRY2GO PTY LTD", "RABNINA PTY LTD"];
const codes: Record<number, string> = { 7: "AR02", 14: "AR03", 30: "AR05", 21: "NO21" };
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

interface Item { id: string; name: string; doc: string; posted: Date; due: Date; amount: number; days: number; ledger: string }
const items: Item[] = [];
const payments: { id: string; date: Date; amount: number }[] = [];
names.forEach((name, i) => {
  const days = [7, 14, 21, 30][i % 4];
  const n = 3 + Math.floor(rnd() * 6);
  for (let k = 0; k < n; k++) {
    const age = Math.floor(rnd() * (rnd() > 0.7 ? 120 : 40));
    const posted = day(age);
    items.push({ id: String(905500 + i), name, doc: String(1900000 + i * 20 + k), posted, due: new Date(posted.getTime() + days * 86400000), amount: Math.round((300 + rnd() * 9000) * (i === 1 ? 12 : 1)) + Math.round(rnd() * 99) / 100, days, ledger: ["84", "86", "88"][i % 3] });
  }
  for (let w = 0; w < 8; w++) if (rnd() > 0.4) payments.push({ id: String(905500 + i), date: day(w * 7 + Math.floor(rnd() * 6)), amount: Math.round(200 + rnd() * 3000) });
});
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const dmy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;

async function write(file: string, build: (wb: ExcelJS.Workbook) => void) {
  const wb = new ExcelJS.Workbook();
  build(wb);
  await wb.xlsx.writeFile(`fixtures/formats/${file}`);
  console.log("wrote", file);
}

(async () => {
  // A — SAP style: title rows, header on row 4, text dates dd.mm.yyyy, codes for terms, ledger column, separate Payments sheet
  await write("A-sap-style.xlsx", (wb) => {
    const ws = wb.addWorksheet("FBL5N");
    ws.addRow(["Customer Line Item Display"]); ws.addRow([]); ws.addRow(["As at 29.09.2026"]);
    ws.addRow(["Customer", "Customer Name1", "DocumentNo", "Type", "Pstng Date", "Net due dt", "Amt in loc.cur.", "LCurr", "PayT", "Ledger", "User Name"]);
    items.forEach((i) => ws.addRow([i.id, i.name, i.doc, "RV", dmy(i.posted), dmy(i.due), i.amount.toLocaleString("en-US", { minimumFractionDigits: 2 }), "AUD", codes[i.days], i.ledger, "batch01"]));
    const p = wb.addWorksheet("DZ Payments");
    p.addRow(["Customer", "Pmnt date", "Amt in loc.cur."]);
    payments.forEach((x) => p.addRow([x.id, dmy(x.date), x.amount]));
  });
  // B — generic: header on row 1, real Excel dates, numeric amounts, "Net N" terms
  await write("B-generic.xlsx", (wb) => {
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Account Number", "Business Name", "Invoice Number", "Due Date", "Outstanding Amount", "Payment Terms", "Region"]);
    items.forEach((i) => ws.addRow([i.id, i.name, i.doc, i.due, i.amount, `Net ${i.days}`, ["North", "South", "West"][Number(i.ledger) % 3]]));
    const p = wb.addWorksheet("Receipts");
    p.addRow(["Account Number", "Payment Date", "Payment Amount"]);
    payments.forEach((x) => p.addRow([x.id, x.date, x.amount]));
  });
  // C — strange naming, banner above header, ISO text dates, accounting-style negatives, credit days as numbers
  await write("C-strange-naming.xlsx", (wb) => {
    const ws = wb.addWorksheet("Debtors_Wk39");
    ws.addRow(["INTERNAL — Overdue register (weekly)"]); ws.mergeCells("A1:E1");
    ws.addRow(["Client Ref", "Trading Name", "Expected Payment Date", "Open Balance", "Credit Days"]);
    items.forEach((i) => ws.addRow([Number(i.id), i.name, fmt(i.due), i.amount < 0 ? `(${Math.abs(i.amount).toFixed(2)})` : i.amount.toFixed(2), i.days]));
    ws.addRow(["Total", "", "", items.reduce((s, i) => s + i.amount, 0).toFixed(2), ""]);
    const p = wb.addWorksheet("Cash received");
    p.addRow(["Client Ref", "Date Received", "Received"]);
    payments.forEach((x) => p.addRow([Number(x.id), fmt(x.date), x.amount]));
  });
})();
