export default function ErrorState({
  message,
  onRetry,
  onShowDemo,
}: {
  message: string;
  onRetry: () => void;
  onShowDemo: () => void;
}) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-6">
      <p className="font-semibold text-red-800">Unable to load Excel data.</p>
      <p className="mt-1 text-sm text-red-700">{message}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={onRetry} className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800">
          Try Again
        </button>
        <button onClick={onShowDemo} className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-800 hover:bg-red-100">
          Show demo data (not from Excel)
        </button>
      </div>
    </div>
  );
}
