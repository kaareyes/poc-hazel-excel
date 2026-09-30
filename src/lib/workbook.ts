import { MAX_FILE_BYTES, inspectSheet, type InspectedSheet } from "@/lib/core";

export type { InspectedSheet };

export async function readWorkbook(file: File): Promise<{ sheets: InspectedSheet[]; warnings: string[] }> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const lower = file.name.toLowerCase();
  const warnings: string[] = [];
  const out: InspectedSheet[] = [];
  if (lower.endsWith(".xlsx")) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (!(head[0] === 0x50 && head[1] === 0x4b)) throw new Error("This does not look like a valid .xlsx file.");
    const { default: readXlsx } = await import("read-excel-file/browser");
    const sheets = (await readXlsx(file)) as { sheet: string; data: unknown[][] }[];
    for (const s of sheets) {
      const ins = inspectSheet(s.sheet, s.data);
      if (ins) out.push(ins);
      else warnings.push(`Sheet "${s.sheet}" skipped: no header row found.`);
    }
  } else if (lower.endsWith(".csv")) {
    const Papa = (await import("papaparse")).default;
    const text = await file.text();
    const parsed = Papa.parse<unknown[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
    const ins = inspectSheet(file.name, parsed.data as unknown[][]);
    if (ins) out.push(ins);
    else warnings.push("No header row found in the CSV.");
  } else if (lower.endsWith(".xls")) {
    throw new Error("Legacy .xls files aren't supported in this preview yet — please save as .xlsx or .csv.");
  } else {
    throw new Error("Unsupported file type. Use .xlsx or .csv.");
  }
  if (!out.length) throw new Error("No usable worksheet found in this file.");
  return { sheets: out, warnings };
}
