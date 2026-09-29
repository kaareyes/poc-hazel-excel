export default function LoadingState() {
  return (
    <div role="status" className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-6 text-slate-600">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      Loading Excel data...
    </div>
  );
}
