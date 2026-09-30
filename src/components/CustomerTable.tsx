"use client";

import { useMemo, useState } from "react";
import { fmtMoney, fmtPct } from "@/lib/format";
import type { CustomerRow } from "@/lib/types";

type SortKey = "name" | "balance" | "overdue" | "pct" | "last" | "oldest" | "days";
const QUICK = [
  { id: "all", label: "All customers" },
  { id: "overdue", label: "Has overdue" },
  { id: "risk", label: "High risk" },
  { id: "nopay30", label: "No payment in 30 days" },
  { id: "credit", label: "Credit balances" },
] as const;

/** Neutralise spreadsheet formula injection in exported cells. */
const csvCell = (v: string | number) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export default function CustomerTable({ rows, currency, dimensionLabel }: { rows: CustomerRow[]; currency: string; dimensionLabel: string }) {
  const [q, setQ] = useState("");
  const [quick, setQuick] = useState<(typeof QUICK)[number]["id"]>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "balance", dir: -1 });
  const [page, setPage] = useState(0);
  const size = 15;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let r = rows.filter((c) => !needle || `${c.customerId} ${c.name} ${c.dimensions.join(" ")} ${c.terms.join(" ")}`.toLowerCase().includes(needle));
    if (quick === "overdue") r = r.filter((c) => c.overdueCents > 0);
    if (quick === "risk") r = r.filter((c) => c.highRisk);
    if (quick === "nopay30") r = r.filter((c) => c.daysSincePayment === null || c.daysSincePayment > 30);
    if (quick === "credit") r = r.filter((c) => c.balanceCents < 0);
    const val = (c: CustomerRow): string | number => {
      switch (sort.key) {
        case "name": return c.name.toLowerCase();
        case "balance": return c.balanceCents;
        case "overdue": return c.overdueCents;
        case "pct": return c.overduePct ?? -1;
        case "last": return c.lastPayment ?? "";
        case "oldest": return c.oldestDue ?? "9999";
        case "days": return c.maxDaysOverdue;
      }
    };
    return [...r].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  }, [rows, q, quick, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const cur = Math.min(page, pages - 1);
  const slice = filtered.slice(cur * size, cur * size + size);

  const th = (key: SortKey, label: string, right = false) => (
    <th className={`th ${right ? "text-right" : ""}`} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button className="chip-btn inline-flex items-center gap-1" onClick={() => { setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 })); setPage(0); }}>
        {label}<span aria-hidden style={{ opacity: sort.key === key ? 1 : 0.3 }}>{sort.key === key && sort.dir === 1 ? "▲" : "▼"}</span>
      </button>
    </th>
  );

  const exportCsv = () => {
    const head = ["Customer ID", "Customer Name", dimensionLabel, "Terms", "Outstanding", "Overdue", "Overdue %", "Last payment", "Oldest due", "Max days overdue", "High risk"];
    const lines = filtered.map((c) => [c.customerId, c.name, c.dimensions.join("; "), c.terms.join("; "), (c.balanceCents / 100).toFixed(2), (c.overdueCents / 100).toFixed(2), c.overduePct === null ? "" : c.overduePct.toFixed(1), c.lastPayment ?? "", c.oldestDue ?? "", c.maxDaysOverdue, c.highRisk ? "Yes" : "No"].map(csvCell).join(","));
    const url = URL.createObjectURL(new Blob([[head.map(csvCell).join(","), ...lines].join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "ar-customers.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card p-4" aria-label="Customers">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-[15px] font-semibold">Customers <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>({filtered.length.toLocaleString()} of {rows.length.toLocaleString()})</span></h2>
        <input className="field w-56" placeholder="Search customer, name, terms…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} aria-label="Search customers" />
        <select className="field" value={quick} onChange={(e) => { setQuick(e.target.value as typeof quick); setPage(0); }} aria-label="Quick filter">
          {QUICK.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <button className="btn" onClick={exportCsv}>Export CSV</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="th">ID</th>
              {th("name", "Customer")}
              <th className="th">{dimensionLabel}</th>
              <th className="th">Terms</th>
              {th("balance", "Outstanding", true)}
              {th("overdue", "Overdue", true)}
              {th("pct", "Overdue %", true)}
              {th("last", "Last payment")}
              {th("oldest", "Oldest due")}
              {th("days", "Days overdue", true)}
              <th className="th">Risk</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((c) => (
              <tr key={c.customerId}>
                <td className="td tabnum" style={{ color: "var(--muted)" }}>{c.customerId}</td>
                <td className="td font-medium">{c.name}</td>
                <td className="td">{c.dimensions.join(", ") || "—"}</td>
                <td className="td">{c.terms.join(", ")}</td>
                <td className="td tabnum text-right">{fmtMoney(c.balanceCents, currency)}</td>
                <td className="td tabnum text-right">{c.overdueCents > 0 ? fmtMoney(c.overdueCents, currency) : <span style={{ color: "var(--muted)" }}>—</span>}</td>
                <td className="td text-right">
                  {c.overduePct === null ? <span className="pill pill-mute">Credit</span> : (
                    <span className={`pill tabnum ${c.overduePct <= 10 ? "pill-good" : c.overduePct <= 50 ? "pill-warn" : "pill-bad"}`}>
                      <span aria-hidden>{c.overduePct <= 10 ? "●" : c.overduePct <= 50 ? "▲" : "■"}</span>{fmtPct(c.overduePct)}
                    </span>
                  )}
                </td>
                <td className="td tabnum">{c.lastPayment ? <>{c.lastPayment} <span style={{ color: "var(--muted)" }}>· {c.daysSincePayment}d ago</span></> : <span className="pill pill-warn">None recorded</span>}</td>
                <td className="td tabnum">{c.oldestDue ?? "—"}</td>
                <td className="td tabnum text-right">{c.maxDaysOverdue || "—"}</td>
                <td className="td">{c.highRisk ? <span className="pill pill-bad"><span aria-hidden>■</span>High risk</span> : <span style={{ color: "var(--muted)" }}>—</span>}</td>
              </tr>
            ))}
            {slice.length === 0 && <tr><td className="td" colSpan={11} style={{ color: "var(--muted)" }}>No customers match.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm" style={{ color: "var(--ink-2)" }}>
        <span>Page {cur + 1} of {pages}</span>
        <div className="flex gap-2">
          <button className="btn" disabled={cur === 0} onClick={() => setPage(cur - 1)}>Previous</button>
          <button className="btn" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Next</button>
        </div>
      </div>
    </section>
  );
}
