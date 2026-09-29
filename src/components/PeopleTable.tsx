import type { Person } from "@/types/person";

const HEADERS = ["Name", "Gender", "Location", "City", "Province"];

export default function PeopleTable({ rows }: { rows: Person[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
          <tr>
            {HEADERS.map((h) => (
              <th key={h} className="px-4 py-3 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((p, i) => (
            <tr key={i} className="hover:bg-slate-50">
              <td className="px-4 py-3 font-medium">{p.Name}</td>
              <td className="px-4 py-3">{p.Gender}</td>
              <td className="px-4 py-3">{p.Location}</td>
              <td className="px-4 py-3">{p.city}</td>
              <td className="px-4 py-3">{p.province}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
