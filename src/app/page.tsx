"use client";

import { useCallback, useEffect, useState } from "react";
import DebugPanel, { type DebugInfo } from "@/components/DebugPanel";
import ErrorState from "@/components/ErrorState";
import LoadingState from "@/components/LoadingState";
import PeopleTable from "@/components/PeopleTable";
import RefreshButton from "@/components/RefreshButton";
import { EXCEL_URL } from "@/lib/config";
import { DEMO_ROWS, ExcelError, loadPeople } from "@/lib/excel";
import type { Person } from "@/types/person";

const timeFmt = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const durationFmt = (milliseconds: number) =>
  milliseconds < 1_000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1_000).toFixed(2)} s`;

export default function Page() {
  const [rows, setRows] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [updated, setUpdated] = useState<string | null>(null);
  const [fetchDuration, setFetchDuration] = useState<number | null>(null);
  const [success, setSuccess] = useState(false);
  const [debug, setDebug] = useState<DebugInfo>({
    requestStatus: "idle", workbookLoaded: false, rows: 0, url: EXCEL_URL,
  });

  const load = useCallback(async () => {
    const startedAt = performance.now();
    setLoading(true);
    setFetchDuration(null);
    setError(null);
    setSuccess(false);
    setDemo(false);
    setDebug((d) => ({ ...d, requestStatus: "loading" }));
    try {
      const r = await loadPeople();
      setRows(r.rows);
      setUpdated(timeFmt(r.fetchedAt));
      setSuccess(true);
      setDebug({
        requestStatus: "success", httpStatus: r.httpStatus, workbookLoaded: true, worksheet: r.sheetName,
        rows: r.rows.length, fetchTime: r.fetchedAt.toISOString(), host: r.finalUrlHost, url: EXCEL_URL,
      });
    } catch (e) {
      const err = e instanceof ExcelError ? e : new ExcelError("INVALID_WORKBOOK", "Unexpected error.");
      if (process.env.NODE_ENV !== "production") console.error("[excel] load failed", e);
      setRows([]);
      setError(err.message);
      setDebug({
        requestStatus: "error", httpStatus: err.httpStatus, workbookLoaded: false, rows: 0,
        fetchTime: new Date().toISOString(), errorCode: err.code, url: EXCEL_URL,
      });
    } finally {
      setFetchDuration(performance.now() - startedAt);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">People Dashboard</h1>
          <p className="text-slate-500">Live data from OneDrive Excel</p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <RefreshButton onClick={load} loading={loading} />
          <p className="text-xs text-slate-500">Last updated: {updated ?? "—"}</p>
          <p className="text-xs text-slate-500" aria-live="polite">
            Fetch duration: {loading ? "Measuring…" : fetchDuration === null ? "—" : durationFmt(fetchDuration)}
          </p>
        </div>
      </header>

      {loading && <LoadingState />}
      {!loading && success && (
        <p className="mb-3 text-sm text-emerald-700">Loaded {rows.length} rows from Excel.</p>
      )}
      {!loading && error && !demo && (
        <ErrorState message={error} onRetry={load} onShowDemo={() => { setRows(DEMO_ROWS); setDemo(true); }} />
      )}
      {!loading && demo && (
        <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          DEMO DATA — hardcoded fallback, NOT read from Excel. <button className="underline" onClick={load}>Try Excel again</button>
        </p>
      )}
      {!loading && rows.length > 0 && <PeopleTable rows={rows} />}

      <DebugPanel info={debug} />
    </main>
  );
}
