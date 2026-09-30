"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_BUCKETS, DEFAULT_RISK, OTHER_TERM, computeMetrics, termGroup } from "@/lib/calc";
import { diffDays } from "@/lib/dates";
import { makeSampleDataset } from "@/lib/demo";
import { fmtCompact, fmtMoney, fmtPct } from "@/lib/format";
import type { Dataset } from "@/lib/types";
import { BarChartH, BarChartV, ChartCard, StackedMix } from "./Charts";
import CustomerTable from "./CustomerTable";
import UploadDialog from "./UploadDialog";

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: "bad" | "good" }) {
  return (
    <div className="card p-4">
      <div className="label">{label}</div>
      <div className="tabnum mt-1 text-2xl font-semibold" style={{ color: tone === "bad" ? "var(--bad)" : tone === "good" ? "var(--good)" : "var(--ink)" }}>{value}</div>
      {sub && <div className="mt-1 text-xs" style={{ color: "var(--muted)" }}>{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<Dataset | null>(null);
  const [asOf, setAsOf] = useState("");
  const [dim, setDim] = useState("");
  const [term, setTerm] = useState("");
  const [riskBal, setRiskBal] = useState(DEFAULT_RISK.balanceCents / 100);
  const [riskPct, setRiskPct] = useState(DEFAULT_RISK.overduePct);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const d = makeSampleDataset();
    setData(d);
    setAsOf(d.asOf);
  }, []);

  const load = (d: Dataset) => { setData(d); setAsOf(d.asOf); setDim(""); setTerm(""); };

  const view = useMemo(() => {
    if (!data || !asOf) return null;
    const cfg = { asOf, buckets: DEFAULT_BUCKETS, risk: { balanceCents: Math.round(riskBal * 100), overduePct: riskPct } };
    const byDim = dim ? data.items.filter((i) => i.dimension === dim) : data.items;
    const items = term ? byDim.filter((i) => termGroup(i.termDays) === term) : byDim;
    const ids = new Set(items.map((i) => i.customerId));
    const filtered = dim || term;
    const payments = filtered ? data.payments.filter((p) => ids.has(p.customerId)) : data.payments;
    const m = computeMetrics(items, payments, cfg);
    const termTiles = computeMetrics(byDim, [], cfg).byTerm;
    const dimTiles = computeMetrics(term ? data.items.filter((i) => termGroup(i.termDays) === term) : data.items, [], cfg).byDimension;
    return { m, termTiles, dimTiles };
  }, [data, asOf, dim, term, riskBal, riskPct]);

  if (!data || !view) return <main className="p-8 text-sm" style={{ color: "var(--muted)" }}>Loading…</main>;
  const { m, termTiles, dimTiles } = view;
  const cur = data.currency;
  const money = (v: number) => fmtMoney(v, cur);
  const compact = (v: number) => fmtCompact(v, cur);
  const ageData = m.aging.map((a, i) => ({ label: a.bucket.label, value: a.cents, color: `var(--age-${Math.min(i, 6)})`, note: `${a.count} item(s)` }));
  const top = [...m.customers].filter((c) => c.balanceCents > 0).sort((a, b) => b.balanceCents - a.balanceCents).slice(0, 10)
    .map((c) => ({ label: c.name, value: c.balanceCents }));
  const weekly = m.weekly.map((w) => ({ label: w.weekStart.slice(5), value: w.cents, color: w.partial ? "var(--bar-2)" : undefined, note: w.partial ? "Week to date" : `Week from ${w.weekStart}` }));
  const wow = m.wowPct;
  const pw = m.paymentWindow;

  const onFiles = (files: FileList | null) => { const f = files?.[0]; if (f) setFile(f); };

  return (
    <div
      className="min-h-screen"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer.files); }}
    >
      <header className="border-b" style={{ borderColor: "var(--grid)", background: "var(--surface)" }}>
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <div className="mr-auto">
            <h1 className="text-lg font-semibold">AR Intelligence</h1>
            <p className="text-xs" style={{ color: "var(--muted)" }}>{data.name} · as at {asOf}</p>
          </div>
          {data.kind === "upload" && <button className="btn" onClick={() => load(makeSampleDataset())}>Use sample data</button>}
          <input ref={input} type="file" accept=".xlsx,.csv" hidden onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
          <button className="btn btn-primary" onClick={() => input.current?.click()}>
            <span aria-hidden>⬆</span> Upload files
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-4 px-4 py-4 sm:px-6">
        {data.kind === "sample" && (
          <div className="card flex flex-wrap items-center gap-3 p-3 text-sm" style={{ background: "var(--warn-bg)", color: "var(--warn)" }}>
            <strong>Showing sample data.</strong>
            <span>Upload your Accounts Receivable report (.xlsx or .csv) — any column layout — or drop it anywhere on this page. Files are read in your browser; nothing is sent to a server.</span>
          </div>
        )}
        {dragging && <div className="card p-6 text-center text-sm" style={{ borderStyle: "dashed", borderColor: "var(--accent)" }}>Drop your file to upload</div>}

        <section className="card flex flex-wrap items-end gap-3 p-3" aria-label="Filters">
          {dimTiles.length > 0 && (
            <label className="flex flex-col gap-1"><span className="label">{data.dimensionLabel}</span>
              <select className="field" value={dim} onChange={(e) => setDim(e.target.value)}>
                <option value="">All</option>{dimTiles.map((d) => <option key={d.value}>{d.value}</option>)}
              </select></label>
          )}
          <label className="flex flex-col gap-1"><span className="label">Payment terms</span>
            <select className="field" value={term} onChange={(e) => setTerm(e.target.value)}>
              <option value="">All</option>{termTiles.filter((t) => t.customers > 0 || t.label === term).map((t) => <option key={t.label}>{t.label}</option>)}
            </select></label>
          <label className="flex flex-col gap-1"><span className="label">As-of date</span><input type="date" className="field" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
          <label className="flex flex-col gap-1"><span className="label">High-risk balance &gt;</span><input type="number" min={0} className="field w-28" value={riskBal} onChange={(e) => setRiskBal(Math.max(0, +e.target.value))} /></label>
          <label className="flex flex-col gap-1"><span className="label">and overdue % &gt;</span><input type="number" min={0} max={100} className="field w-20" value={riskPct} onChange={(e) => setRiskPct(Math.min(100, Math.max(0, +e.target.value)))} /></label>
          <button className="btn" onClick={() => { setDim(""); setTerm(""); setAsOf(data.asOf); setRiskBal(DEFAULT_RISK.balanceCents / 100); setRiskPct(DEFAULT_RISK.overduePct); }}>Reset</button>
          <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>Currency: {cur}</span>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" aria-label="Key metrics">
          <Kpi label="Total AR" value={money(m.totalCents)} sub={`${m.itemCount.toLocaleString()} open items`} />
          <Kpi label="Total overdue" value={money(m.overdueCents)} tone={m.overdueCents > 0 ? "bad" : undefined} sub="Past due date" />
          <Kpi label="Overdue %" value={fmtPct(m.overduePct)} tone={(m.overduePct ?? 0) > 50 ? "bad" : undefined} sub="Overdue ÷ total AR" />
          <Kpi label="Overdue customers" value={m.overdueCustomers.toLocaleString()} sub={`of ${m.customerCount.toLocaleString()} customers`} />
          <Kpi label="Payments this week" value={money(m.paymentsThisWeekCents)} sub={
            wow === null ? "Week to date" : (
              <span style={{ color: wow >= 0 ? "var(--good)" : "var(--bad)" }}>{wow >= 0 ? "▲" : "▼"} {Math.abs(wow).toFixed(1)}% <span style={{ color: "var(--muted)" }}>vs same days last week</span></span>
            )} />
          <Kpi label="Payments last week" value={money(m.paymentsLastWeekCents)} sub="Last full week (Mon–Sun)" />
        </section>

        {dimTiles.length > 0 && (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={data.dimensionLabel}>
            {dimTiles.slice(0, 8).map((d) => (
              <button key={d.value} onClick={() => setDim(dim === d.value ? "" : d.value)} aria-pressed={dim === d.value} className="card p-4 text-left" style={{ outline: dim === d.value ? "2px solid var(--accent)" : "none" }}>
                <div className="label">{data.dimensionLabel} {d.value}</div>
                <div className="tabnum mt-1 text-xl font-semibold">{money(d.balanceCents)}</div>
                <div className="mt-1 flex gap-4 text-xs" style={{ color: "var(--muted)" }}><span>Overdue <b style={{ color: "var(--ink-2)" }}>{money(d.overdueCents)}</b></span><span>Customers <b style={{ color: "var(--ink-2)" }}>{d.customers}</b></span></div>
              </button>
            ))}
          </section>
        )}

        <div className="grid gap-4 lg:grid-cols-5">
          <ChartCard className="lg:col-span-3" title="AR ageing — balance by days overdue" subtitle="Per open item, as at the selected date" data={ageData} format={money}>
            <BarChartV data={ageData} format={money} axisFormat={compact} />
          </ChartCard>
          <ChartCard className="lg:col-span-2" title="Ageing mix" subtitle="Share of debit balances" data={ageData} format={money}>
            <StackedMix data={ageData} format={money} />
          </ChartCard>
        </div>

        <section aria-label="Payment terms">
          <h2 className="mb-2 text-[15px] font-semibold">Payment terms</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {termTiles.map((t) => (
              <button key={t.label} onClick={() => setTerm(term === t.label ? "" : t.label)} aria-pressed={term === t.label} className="card p-4 text-left" style={{ outline: term === t.label ? "2px solid var(--accent)" : "none", opacity: t.customers === 0 && t.label !== OTHER_TERM ? 0.6 : 1 }}>
                <div className="label">{t.label}</div>
                <div className="tabnum mt-1 text-xl font-semibold">{money(t.balanceCents)}</div>
                <dl className="mt-1 space-y-0.5 text-xs" style={{ color: "var(--muted)" }}>
                  <div className="flex justify-between"><dt>Customers</dt><dd className="tabnum">{t.customers}</dd></div>
                  <div className="flex justify-between"><dt>Overdue</dt><dd className="tabnum">{money(t.overdueCents)}</dd></div>
                  <div className="flex justify-between"><dt>Overdue %</dt><dd className="tabnum">{fmtPct(t.balanceCents > 0 ? (t.overdueCents / t.balanceCents) * 100 : null)}</dd></div>
                </dl>
              </button>
            ))}
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Top 10 customer exposure" subtitle="Outstanding balance" data={top} format={money}>
            <BarChartH data={top} format={compact} />
          </ChartCard>
          <ChartCard title="Weekly payments — last 8 weeks" subtitle="Week commencing Monday; grey = current week to date" data={weekly} format={money} valueHeader="Payments">
            <BarChartV data={weekly} format={money} axisFormat={compact} height={200} />
          </ChartCard>
        </div>

        <CustomerTable rows={m.customers} currency={cur} dimensionLabel={data.dimensionLabel} />

        <section className="card p-4 text-xs leading-relaxed" style={{ color: "var(--muted)" }} aria-label="Control notes">
          <h2 className="mb-1 text-[13px] font-semibold" style={{ color: "var(--ink-2)" }}>Control notes</h2>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>Overdue = due date earlier than the as-of date (due today is Current). Credits are netted into balances.</li>
            <li>High risk = balance above {money(Math.round(riskBal * 100))} and overdue % above {riskPct}%.</li>
            <li>Payments this week are week-to-date (Mon–{asOf}); the change compares them with the same days last week so a part-week is never set against a full week.</li>
            {pw && <li>Payments cover {pw.from} to {pw.to} ({diffDays(pw.to, pw.from) + 1} days); “no payment” results reflect only that window.</li>}
            {m.undatedItems > 0 && <li>{m.undatedItems} open item(s) have no usable due date and are treated as not overdue.</li>}
            {data.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </section>
      </main>

      {file && <UploadDialog file={file} onClose={() => setFile(null)} onImport={load} />}
    </div>
  );
}
