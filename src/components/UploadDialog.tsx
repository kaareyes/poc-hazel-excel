"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { todayIso } from "@/lib/core";
import { FIELDS, FIELDS_FOR, REQUIRED, suggestMapping, type ColumnSuggestion, type FieldId, type SheetKind } from "@/lib/core";
import { detectTerms, normalizeImport, type SheetConfig } from "@/lib/core";
import type { Dataset } from "@/lib/core";
import { readWorkbook, type InspectedSheet } from "@/lib/workbook";

interface SheetState {
  sheet: InspectedSheet;
  kind: SheetKind;
  suggestions: ColumnSuggestion[];
  assign: Record<number, FieldId | "">;
  manual: Set<number>; // columns the user explicitly confirmed/changed
}

const KIND_LABEL: Record<SheetKind, string> = { open_items: "Open items", payments: "Payments", ignore: "Ignore" };

function buildState(sheet: InspectedSheet, kind: SheetKind): SheetState {
  const suggestions = kind === "ignore" ? [] : suggestMapping(sheet.headers, sheet.rows, kind);
  const assign: Record<number, FieldId | ""> = {};
  suggestions.forEach((s) => { if (s.field && s.confidence >= 0.3) assign[s.index] = s.field; });
  return { sheet, kind, suggestions, assign, manual: new Set() };
}

const confLabel = (c: number) => (c >= 0.9 ? { t: "High", cls: "pill-good" } : c >= 0.7 ? { t: "Review recommended", cls: "pill-warn" } : { t: "⚠ Review required", cls: "pill-bad" });

export default function UploadDialog({ file, onClose, onImport }: { file: File; onClose: () => void; onImport: (d: Dataset) => void }) {
  const [state, setState] = useState<{ status: "reading" | "error" | "ready"; error?: string; sheets: SheetState[]; warnings: string[] }>({ status: "reading", sheets: [], warnings: [] });
  const [asOf, setAsOf] = useState(todayIso());
  const [currency, setCurrency] = useState("AUD");
  const [termDays, setTermDays] = useState<Record<string, number | null>>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    readWorkbook(file)
      .then(({ sheets, warnings }) => {
        if (!alive) return;
        let openTaken = false;
        const ss = sheets.map((s) => {
          let kind = s.kind;
          if (kind === "open_items") { if (openTaken) kind = "ignore"; openTaken = true; }
          return buildState(s, kind);
        });
        setState({ status: "ready", sheets: ss, warnings });
      })
      .catch((e: Error) => alive && setState({ status: "error", error: e.message, sheets: [], warnings: [] }));
    return () => { alive = false; };
  }, [file]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const update = (name: string, fn: (s: SheetState) => SheetState) =>
    setState((st) => ({ ...st, sheets: st.sheets.map((s) => (s.sheet.name === name ? fn(s) : s)) }));

  const setKind = (name: string, kind: SheetKind) =>
    setState((st) => ({
      ...st,
      sheets: st.sheets.map((s) => {
        if (s.sheet.name === name) return buildState(s.sheet, kind);
        return kind === "open_items" && s.kind === "open_items" ? buildState(s.sheet, "ignore") : s; // only one open-items sheet
      }),
    }));

  const setField = (name: string, col: number, field: FieldId | "") =>
    update(name, (s) => {
      const assign = { ...s.assign };
      if (field) for (const k of Object.keys(assign)) if (assign[+k] === field) delete assign[+k];
      if (field) assign[col] = field; else delete assign[col];
      return { ...s, assign, manual: new Set(s.manual).add(col) };
    });

  const configs: SheetConfig[] = useMemo(
    () =>
      state.sheets
        .filter((s): s is SheetState & { kind: "open_items" | "payments" } => s.kind !== "ignore")
        .map((s) => {
          const mapping: SheetConfig["mapping"] = {};
          Object.entries(s.assign).forEach(([col, f]) => { if (f) mapping[f] = +col; });
          return { sheet: s.sheet, kind: s.kind, mapping };
        }),
    [state.sheets],
  );

  const openCfg = configs.find((c) => c.kind === "open_items");
  const terms = useMemo(() => detectTerms(openCfg), [openCfg]);
  const result = useMemo(
    () => (state.status === "ready" ? normalizeImport({ fileName: file.name, sheets: configs, asOf, currency: currency.toUpperCase(), termDays }) : null),
    [state.status, configs, asOf, currency, termDays, file.name],
  );

  const pendingReview = state.sheets.reduce((n, s) => {
    if (s.kind === "ignore") return n;
    return n + s.suggestions.filter((x) => s.assign[x.index] && x.confidence < 0.7 && !s.manual.has(x.index)).length;
  }, 0);
  const errors = result?.issues.filter((i) => i.severity === "ERROR") ?? [];
  const canImport = state.status === "ready" && errors.length === 0 && pendingReview === 0 && /^\d{4}-\d{2}-\d{2}$/.test(asOf) && /^[A-Za-z]{3}$/.test(currency);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ background: "rgba(0,0,0,0.5)" }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Review upload" className="card w-full max-w-5xl outline-none">
        <div className="flex items-center justify-between border-b p-4" style={{ borderColor: "var(--grid)" }}>
          <div>
            <h2 className="text-lg font-semibold">Review your report</h2>
            <p className="text-xs" style={{ color: "var(--muted)" }}>{file.name} · processed in your browser — nothing is uploaded to a server yet</p>
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        {state.status === "reading" && <p className="p-6 text-sm" style={{ color: "var(--ink-2)" }}>Reading workbook…</p>}
        {state.status === "error" && (
          <div className="p-6"><p className="pill pill-bad">{state.error}</p></div>
        )}

        {state.status === "ready" && result && (
          <div className="space-y-6 p-4">
            {state.warnings.map((w) => <p key={w} className="pill pill-warn">{w}</p>)}

            <section>
              <h3 className="mb-2 text-sm font-semibold">1. Worksheets</h3>
              <div className="space-y-2">
                {state.sheets.map((s) => (
                  <div key={s.sheet.name} className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="w-56 truncate font-medium" title={s.sheet.name}>{s.sheet.name}</span>
                    <span style={{ color: "var(--muted)" }}>{s.sheet.rowCount.toLocaleString()} rows · header on row {s.sheet.headerRow + 1}</span>
                    <select className="field" value={s.kind} onChange={(e) => setKind(s.sheet.name, e.target.value as SheetKind)} aria-label={`Report type for ${s.sheet.name}`}>
                      {(Object.keys(KIND_LABEL) as SheetKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                    </select>
                    {s.kind !== "ignore" && <span className={`pill ${confLabel(s.sheet.kindConfidence).cls}`}>Detected {Math.round(s.sheet.kindConfidence * 100)}%</span>}
                  </div>
                ))}
              </div>
            </section>

            {state.sheets.filter((s) => s.kind !== "ignore").map((s) => {
              const kind = s.kind as "open_items" | "payments";
              const missing = REQUIRED[kind].filter((f) => !Object.values(s.assign).includes(f));
              return (
                <section key={s.sheet.name}>
                  <h3 className="mb-2 text-sm font-semibold">2. Map columns — {s.sheet.name} <span style={{ color: "var(--muted)" }} className="font-normal">({KIND_LABEL[kind]})</span></h3>
                  {missing.length > 0 && <p className="pill pill-bad mb-2">Required field(s) not mapped: {missing.map((f) => FIELDS[f].label).join(", ")}</p>}
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead><tr><th className="th">Source column</th><th className="th">Sample</th><th className="th">Mapped field</th><th className="th">Confidence</th></tr></thead>
                      <tbody>
                        {s.sheet.headers.map((h, i) => {
                          if (!h) return null;
                          const sug = s.suggestions.find((x) => x.index === i);
                          const field = s.assign[i] ?? "";
                          const manual = s.manual.has(i);
                          const c = manual ? { t: "Confirmed", cls: "pill-good" } : field && sug ? confLabel(sug.confidence) : { t: "Ignored", cls: "pill-mute" };
                          return (
                            <tr key={i}>
                              <td className="td font-medium">{h}</td>
                              <td className="td" style={{ color: "var(--muted)" }}>{sug?.samples.join(" · ")}</td>
                              <td className="td">
                                <select className="field" value={field} onChange={(e) => setField(s.sheet.name, i, e.target.value as FieldId | "")} aria-label={`Field for column ${h}`}>
                                  <option value="">— Ignore column —</option>
                                  {FIELDS_FOR[kind].map((f) => <option key={f} value={f}>{FIELDS[f].label}</option>)}
                                </select>
                              </td>
                              <td className="td">
                                <span className={`pill ${c.cls}`}>{c.t}{!manual && field && sug ? ` · ${Math.round(sug.confidence * 100)}%` : ""}</span>
                                {field && !manual && sug && sug.confidence < 0.7 && <button className="btn ml-2 !h-7 !px-2 text-xs" onClick={() => setField(s.sheet.name, i, field)}>Confirm</button>}
                                {sug?.note && !manual && <div className="mt-1 text-xs" style={{ color: "var(--warn)" }}>{sug.note}</div>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}

            <section>
              <h3 className="mb-2 text-sm font-semibold">3. Settings</h3>
              <div className="flex flex-wrap gap-4">
                <label className="flex flex-col gap-1"><span className="label">Report as-of date</span><input type="date" className="field" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
                <label className="flex flex-col gap-1"><span className="label">Currency</span><input className="field w-24 uppercase" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} /></label>
              </div>
              {terms.length > 0 && (
                <div className="mt-4">
                  <p className="label mb-1">Payment terms found — how many days does each mean? (blank = Other / Unmapped)</p>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {terms.slice(0, 30).map((t) => (
                      <label key={t.code} className="flex items-center gap-2 text-sm">
                        <span className="w-28 truncate font-medium" title={t.code}>{t.code || "(blank)"}</span>
                        <span style={{ color: "var(--muted)" }}>{t.count} items →</span>
                        <input className="field w-16" inputMode="numeric" placeholder="days" value={(t.code in termDays ? termDays[t.code] : t.suggested) ?? ""} onChange={(e) => { const v = e.target.value.trim(); setTermDays((p) => ({ ...p, [t.code]: v === "" || isNaN(+v) ? null : Math.max(0, Math.round(+v)) })); }} aria-label={`Days for terms ${t.code}`} />
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold">4. Validation</h3>
              <ul className="space-y-1.5 text-sm">
                {result.issues.length === 0 && <li className="pill pill-good">No issues found</li>}
                {result.issues.map((i, k) => (
                  <li key={k} className="flex items-start gap-2">
                    <span className={`pill shrink-0 ${i.severity === "ERROR" ? "pill-bad" : i.severity === "WARNING" ? "pill-warn" : "pill-mute"}`}>{i.severity}</span>
                    <span style={{ color: "var(--ink-2)" }}>{i.message}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>Ready to import: {result.dataset.items.length.toLocaleString()} open items, {result.dataset.payments.length.toLocaleString()} payments.</p>
            </section>

            <div className="flex items-center justify-end gap-3 border-t pt-4" style={{ borderColor: "var(--grid)" }}>
              {pendingReview > 0 && <span className="text-sm" style={{ color: "var(--warn)" }}>{pendingReview} low-confidence mapping(s) need your review</span>}
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!canImport} onClick={() => { onImport(result.dataset); onClose(); }}>Confirm &amp; import</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
