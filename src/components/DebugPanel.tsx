export interface DebugInfo {
  requestStatus: "idle" | "loading" | "success" | "error";
  httpStatus?: number;
  workbookLoaded: boolean;
  worksheet?: string;
  rows: number;
  fetchTime?: string;
  errorCode?: string;
  host?: string;
  url: string;
}

export default function DebugPanel({ info }: { info: DebugInfo }) {
  const items: [string, string][] = [
    ["Excel request status", info.requestStatus],
    ["HTTP status", info.httpStatus?.toString() ?? "n/a"],
    ["Workbook loaded", info.workbookLoaded ? "Yes" : "No"],
    ["Worksheet detected", info.worksheet ?? "n/a"],
    ["Rows detected", String(info.rows)],
    ["Last fetch time", info.fetchTime ?? "n/a"],
    ["Error code", info.errorCode ?? "none"],
    ["Final host", info.host ?? "n/a"],
    ["Request URL", info.url],
  ];
  return (
    <details className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <summary className="cursor-pointer font-medium text-slate-700">Debug Information</summary>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
        {items.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="break-all font-mono text-xs text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
