"use client";

import { useState } from "react";

export interface Datum {
  label: string;
  value: number;
  color?: string;
  note?: string;
}

/** Card with title, optional subtitle and a chart <-> table toggle so data is never colour/graphic-only. */
export function ChartCard({
  title, subtitle, data, format, valueHeader = "Amount", children, className = "",
}: {
  title: string; subtitle?: string; data: Datum[]; format: (v: number) => string; valueHeader?: string;
  children: React.ReactNode; className?: string;
}) {
  const [table, setTable] = useState(false);
  return (
    <section className={`card p-4 ${className}`} aria-label={title}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>{subtitle}</p>}
        </div>
        <button className="chip-btn rounded-md px-2 py-1 text-xs" style={{ color: "var(--ink-2)", border: "1px solid var(--border)" }} onClick={() => setTable(!table)} aria-pressed={table}>
          {table ? "Chart" : "Table"}
        </button>
      </div>
      {table ? (
        <table className="w-full text-sm">
          <thead><tr><th className="th">Item</th><th className="th text-right">{valueHeader}</th></tr></thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.label}><td className="td">{d.label}</td><td className="td tabnum text-right">{format(d.value)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : (
        children
      )}
    </section>
  );
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function BarChartV({ data, format, axisFormat, height = 220 }: { data: Datum[]; format: (v: number) => string; axisFormat: (v: number) => string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.value, 0)), 0));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  return (
    <div className="relative" style={{ height: height + 28 }}>
      <div className="absolute left-0 right-0 top-0" style={{ height }}>
        {ticks.map((t, i) => (
          <div key={i} className="absolute left-0 right-0 flex items-center" style={{ bottom: `${(t / max) * 100}%` }}>
            <span className="tabnum w-14 shrink-0 pr-2 text-right text-[11px]" style={{ color: "var(--muted)", transform: "translateY(0)" }}>{axisFormat(t)}</span>
            <div className="flex-1" style={{ borderTop: `1px solid ${i === 0 ? "var(--axis)" : "var(--grid)"}` }} />
          </div>
        ))}
        <div className="absolute bottom-0 left-14 right-0 top-0 flex items-end justify-around">
          {data.map((d, i) => (
            <div key={d.label} className="relative flex h-full flex-1 items-end justify-center" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${d.label}: ${format(d.value)}`}>
              <div style={{ width: "min(44px, 60%)", height: `${(Math.max(d.value, 0) / max) * 100}%`, background: d.color ?? "var(--bar)", borderRadius: "4px 4px 0 0", opacity: hover === null || hover === i ? 1 : 0.55, minHeight: d.value > 0 ? 2 : 0 }} />
              {hover === i && (
                <div className="pointer-events-none absolute z-10 rounded-md px-2 py-1 text-xs shadow-md" style={{ bottom: `calc(${(Math.max(d.value, 0) / max) * 100}% + 8px)`, background: "var(--surface)", border: "1px solid var(--border)", whiteSpace: "nowrap" }}>
                  <div style={{ color: "var(--muted)" }}>{d.label}</div>
                  <div className="tabnum font-semibold">{format(d.value)}</div>
                  {d.note && <div style={{ color: "var(--muted)" }}>{d.note}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="absolute bottom-0 left-14 right-0 flex justify-around text-[11px]" style={{ color: "var(--ink-2)" }}>
        {data.map((d) => <span key={d.label} className="flex-1 text-center">{d.label}</span>)}
      </div>
    </div>
  );
}

export function BarChartH({ data, format }: { data: Datum[]; format: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <ul className="space-y-1.5">
      {data.map((d, i) => (
        <li key={d.label} className="flex items-center gap-3 rounded-md px-1 py-0.5" style={{ background: hover === i ? "var(--hover)" : "transparent" }} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
          <span className="w-40 shrink-0 truncate text-[13px]" title={d.label} style={{ color: "var(--ink-2)" }}>{d.label}</span>
          <div className="h-3 flex-1 rounded-r" style={{ background: "transparent" }}>
            <div style={{ width: `${Math.max((d.value / max) * 100, 0.5)}%`, height: "100%", background: d.color ?? "var(--bar)", borderRadius: "0 4px 4px 0" }} />
          </div>
          <span className="tabnum w-20 shrink-0 text-right text-[13px] font-medium">{format(d.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Single 100% stacked bar with a 2px surface gap between segments + legend (identity never colour-only). */
export function StackedMix({ data, format }: { data: Datum[]; format: (v: number) => string }) {
  const pos = data.map((d) => ({ ...d, value: Math.max(d.value, 0) }));
  const total = pos.reduce((s, d) => s + d.value, 0) || 1;
  return (
    <div>
      <div className="flex h-8 w-full overflow-hidden rounded-md" style={{ gap: 2 }} role="img" aria-label="Ageing mix">
        {pos.filter((d) => d.value > 0).map((d) => (
          <div key={d.label} title={`${d.label}: ${format(d.value)} (${((d.value / total) * 100).toFixed(1)}%)`} style={{ width: `${(d.value / total) * 100}%`, background: d.color }} />
        ))}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
        {pos.map((d) => (
          <li key={d.label} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: d.color }} />
            <span style={{ color: "var(--ink-2)" }}>{d.label}</span>
            <span className="tabnum ml-auto font-medium">{((d.value / total) * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
