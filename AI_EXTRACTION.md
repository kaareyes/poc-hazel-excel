# AI_EXTRACTION

Companion docs: [PLAN.md](PLAN.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [DATA_SCHEMA.md](DATA_SCHEMA.md)

Covers: (A) AI-assisted workbook interpretation & column mapping, (B) privacy/minimization, (C) human review, (D) import profiles & drift, (E) the AR Copilot tool layer, (F) safety, (G) evaluation.

**Golden rule:** AI interprets *structure* and explains *verified* results. Deterministic code parses, validates, calculates. If AI is unavailable or disabled for an org, the product still works via deterministic heuristics + manual mapping.

---

## 1. Pipeline overview

```
File ─► [1] Deterministic inspection ─► WorkbookProfile (structure + typed stats + samples)
        [2] Profile match? ── yes ─► apply saved mapping ─► [5] drift check ─► (ok) → validate/import
             │ no / drift
        [3] Minimize + mask ─► AIProvider ─► schema-validated suggestions
        [4] Deterministic cross-checks (types, plausibility, alias hints) adjust confidence
        [5] Human review UI (confirm / change / ignore / unavailable)
        [6] Save Import Profile (versioned, fingerprinted)
```

## 2. Step 1 — Deterministic workbook inspection (no AI)

Output `WorkbookProfile` (stored on `import_jobs.workbook_profile`; contains real data samples, so it is tenant-private and **never sent to AI as-is**):

```jsonc
{
  "file": { "name": "AR_Report.xlsx", "size": 1842211, "sha256": "…", "format": "xlsx" },
  "sheets": [{
    "name": "FBL5N", "index": 0, "visible": true,
    "dimensions": { "rows": 12431, "cols": 22, "used_range": "A1:V12431" },
    "merged_cells": [{ "range": "A1:F1" }],
    "excel_tables": [{ "name": "tblOpenItems", "range": "A4:V12431" }],
    "blank_row_pattern": { "leading_blank_rows": 3, "interior_blank_rows": 0, "trailing_blank_rows": 0, "subtotal_like_rows": [] },
    "header_candidates": [
      { "row": 4, "score": 0.97, "reasons": ["all-string","unique","followed-by-typed-rows"] }
    ],
    "columns": [{
      "index": 0, "header": "Cust No.", "header_normalized": "custno",
      "detected_type": "identifier",          // identifier|text|integer|decimal|currency_amount|date|datetime|boolean|mixed|empty
      "type_confidence": 0.99,
      "stats": { "non_empty_pct": 1.0, "distinct_ratio": 0.11, "leading_zeros": false,
                 "min": null, "max": null, "neg_pct": null, "date_min": null, "date_max": null,
                 "looks_like_excel_serial": false, "sample_formats": ["####"], "pattern_class": "digits(6-10)" },
      "samples": ["905559", "905560", "…"]     // ≤ 8 distinct, raw (pre-masking)
    }],
    "fingerprint": "sha256(normalized sorted headers + detected types)"
  }],
  "warnings": ["hidden sheet 'Config' ignored"]
}
```

Inspection responsibilities (all deterministic):
- Enumerate sheets (visible+hidden flagged), ignore chart sheets.
- Detect header row: rank rows by (string ratio, uniqueness, non-empty ratio, next-N rows type-consistency, position). Multiple candidates are kept — reference's approach ("row containing a *customer* and an *amount* header") becomes one heuristic signal among several, never the sole rule. Handles multi-row headers by concatenating (`"Amount" + "Local"`).
- Detect Excel Tables (ListObjects), named ranges, merged cells (unmerge fill-down logic recorded, not applied blindly).
- Type detection by sampling up to N=500 rows spread across the sheet: date (Excel serial in plausible range with date format / ISO / `dd/mm/yyyy` vs `mm/dd/yyyy` disambiguation by trying all values), numeric (parentheses, trailing minus, currency symbols, `1.234,56` vs `1,234.56`), identifiers (leading zeros, length distribution), enumerations (low-cardinality → candidate for term codes / dimensions).
- Detect subtotal/total rows (cells like "Total", "Grand Total", "Result", rows where numeric equals sum of the block above), report footers, page-break repeats of headers.
- Detect **as-of date candidates**: title cells ("As at 29.09.2026"), filename patterns, file metadata `modified`, max posting date — returned as candidates with source.
- Detect delimiter/encoding for CSV.

Deterministic **heuristic classifier** (`alias dictionary` seeded from the reference's alias table + SAP/Oracle/NetSuite/Xero/MYOB/QuickBooks column vocabularies + type signals) produces its *own* mapping/confidence, used (a) as a fallback when AI is off, (b) as a cross-check on AI output, (c) to pre-fill if AI fails.

## 3. Step 3 — Minimization & masking (`prepareAIPayload()`)

Single choke point; nothing reaches a provider adapter except through it. Unit tests assert that raw customer names/IDs/references never appear in payloads.

**Sent to AI (default policy `structure_only`):**
- File-level: format, sheet count. **No file name** (may contain company name) — replaced with a token unless org policy allows.
- Per sheet: sheet name, row/col counts, header row candidates, table names, merged-cell flags.
- Per column: header text, detected type + stats (percentages, ranges, patterns), **≤ 5 masked samples**.

**Masking rules per detected type:**

| Type | Masking |
|---|---|
| customer id / identifier | Replace by shape: `905559` → `######` (keep length, digit/letter class, leading-zero flag) plus a stable placeholder set `ID_A1`, `ID_A2` for uniqueness reasoning |
| customer name / free text | Tokenised: `SAI & SONS PTY LTD` → `NAME_1`; only *features* kept (`has_pty_ltd_suffix`, word_count, all_caps) |
| reference / text / document numbers | Shape mask (`19########`) |
| amounts | Shape and range **bucketed**: `"positive decimal, 2dp, magnitude 10^2–10^5, 3% negative"`; a few samples replaced by magnitude-preserving synthetic values (never the real ones) |
| dates | Real dates *may* be sent (low sensitivity) but can be shifted by a per-import random offset; format string and min/max span preserved |
| enumerations (payment term code, doc type, ledger) | Real values allowed **only** when cardinality ≤ 30 and org policy `allow_code_values` = true (needed to understand `AR02`/`NET30`); otherwise placeholders |
| headers, sheet names | Sent verbatim (they are the signal) — but scanned for embedded personal/company names (regex + denylist of org name) and masked if found |

Org-level `ai_policy`: `off` | `structure_only` (default) | `structure_plus_codes` | `full_samples` (explicit admin opt-in, audited). Response is de-masked locally by mapping placeholders back if needed (the AI only ever refers to *column headers*, so de-masking is rarely required).

**Provider requirements:** zero-retention / no-training endpoints, regional endpoint per Q1, TLS, keys server-side only. `ai_runs` records **what categories/counts were sent** (`input_summary`, `masking`) and the hash, not the payload.

Token budget: a 40-column, 3-sheet workbook ≈ 3–5k input tokens; large workbooks never scale token cost because only headers + ≤5 samples per column are sent.

## 3b. AI configuration & phasing (revised)
- **AI is off at first launch.** MVP-1 uses the deterministic heuristic mapper (§2) + human review. Turning AI on = an Admin saving provider, API key, model and (optionally) prompts in **Admin → AI Settings** (PLAN §3.1); no code change or redeploy.
- The backend resolves the provider at call time from `ai_settings` (decrypting the key in-process, in the server/worker only) and instantiates the matching `AIProvider` adapter. If disabled, missing key, cap exceeded or provider error → automatic fallback to heuristics.
- Prompt text comes from the active `ai_prompts` row (defaults shipped in `src/server/ai/extraction/prompts/v1`). The system layer always appends non-editable rules: strict output schema, "structure only, never compute or invent values", untrusted-cell-content notice. Editing a prompt requires a passing run of the fixture eval (§12) before it can be activated.
- The Admin page offers **Test connection** (tiny synthetic request) and **Dry-run on fixture** (Formats A/B/C, reports accuracy) so an admin can validate a new prompt/model safely.
- Key handling: write-only field, envelope-encrypted in `secrets`, redacted from logs/errors/telemetry, never in client bundles or API responses.

## 4. Step 3 — AI tasks & contracts

Provider interface (provider-agnostic; adapters for OpenAI/Anthropic/Google + `MockProvider` for CI):

```ts
interface AIProvider {
  readonly id: string;                                   // 'openai' | 'anthropic' | 'google' | 'mock'
  analyzeWorkbook(input: MinimizedWorkbook, opts: RunOpts): Promise<WorkbookAnalysis>;       // orchestrates 2 & 3 in one call for cost
  detectReportType(input: MinimizedSheet, opts: RunOpts): Promise<ReportTypeResult>;
  suggestColumnMappings(input: MinimizedSheet & { reportType: ReportType; targetFields: FieldSpec[] },
                        opts: RunOpts): Promise<MappingSuggestion>;
  explainCustomer(facts: CustomerFacts /* verified, calculated */, opts: RunOpts): Promise<ExplanationResult>;
  answerARQuestion(req: CopilotRequest, tools: ToolRegistry, opts: RunOpts): Promise<CopilotAnswer>;
}
interface RunOpts { orgId: string; purpose: string; timeoutMs: number; maxOutputTokens: number; promptVersion: string; }
```
Rules: structured output via JSON-Schema/tool-calling with **strict** schema; one automatic repair retry on validation failure; hard timeout; provider errors ⇒ fallback to heuristic mapper (never a failed import for that reason alone); temperature 0 for extraction; deterministic seed when supported; prompts versioned in repo (`src/server/ai/extraction/prompts/v1/*`) with a golden-eval gate before change.

### 4.1 Report type detection
Allowed: `OPEN_ITEMS | PAYMENTS | CUSTOMERS | PAYMENT_TERMS | LEDGER_MAPPING | COLLECTION_ACTIONS | UNKNOWN` (`LEDGER_MAPPING` = generic *dimension mapping*; name kept for compatibility).

```jsonc
{ "sheet": "FBL5N", "report_type": "OPEN_ITEMS", "confidence": 0.98,
  "evidence": ["has due-date-like column 'Net due dt'", "amount column 'Amt in loc.cur.' signed", "document number column present"],
  "alternatives": [{ "report_type": "PAYMENTS", "confidence": 0.02 }] }
```
Policy: `< 0.90` ⇒ flagged "Review required"; `< 0.60` ⇒ forced `UNKNOWN` until user chooses; multiple sheets can share a type (user picks/combines). Deterministic guard: a sheet classified OPEN_ITEMS must contain (mapped or mappable) `customer_id`-like + `amount`-like + a date column, otherwise confidence is capped at 0.5.

### 4.2 Column mapping
Per selected sheet the AI returns:

```jsonc
{
  "sheet": "FBL5N", "report_type": "OPEN_ITEMS", "header_row": 4,
  "source_system_guess": { "value": "SAP", "confidence": 0.93, "evidence": ["'Amt in loc.cur.' and 'Net due dt' are SAP FBL5N labels"] },
  "column_mapping": {
    "Cust No.":        { "field": "customer_id",       "confidence": 0.99, "reason": "unique numeric identifier, 6-digit pattern" },
    "Customer Name1":  { "field": "customer_name",     "confidence": 0.99 },
    "Net due dt":      { "field": "due_date",          "confidence": 0.98 },
    "Amt in loc.cur.": { "field": "amount",            "confidence": 0.99, "note": "local-currency signed amount" },
    "PayT":            { "field": "payment_term_code", "confidence": 0.97 },
    "BusA":            { "field": "dimension:ledger",  "confidence": 0.61, "note": "ambiguous: may be business area not ledger" }
  },
  "ignored_columns": [{ "column": "User Name", "reason": "not needed" }],
  "unavailable_fields": ["clearing_document"],
  "alternatives": { "BusA": [{ "field": "business_area", "confidence": 0.35 }] },
  "parsing_hints": { "date_format": "DD.MM.YYYY", "decimal_separator": ".", "negative_style": "leading_minus", "payment_sign": "unknown" },
  "as_of_date_candidates": [{ "value": "2026-09-29", "source": "cell B2 'As at 29.09.2026'" }],
  "warnings": ["Two amount-like columns: 'Amt in loc.cur.' (local) and 'Amt in doc.curr.' (foreign) — chose local"]
}
```
- A field may be mapped from **at most one** column (unless a documented composite e.g. name1+name2). Duplicate assignments are rejected by schema validation with a repair retry.
- Target vocabulary comes from DATA_SCHEMA §1.3 and the org's business dimensions (so `dimension:ledger` only exists if the org defines it; otherwise AI may propose creating one, subject to user acceptance).
- The AI sees the target field list with short definitions and a couple of **synonym lists per field** (few-shot), e.g. `customer_id ← Customer, Customer No., Account Number, Business Partner, Client ID, Client Ref…`; `amount ← Amt in loc.cur., Outstanding Amount, Balance, Open Amount, Invoice Balance, Open Balance…`; `due_date ← Net due dt, Due Date, Expected Payment Date…`; `payment_term_code/days ← PayT, Payment Terms, Credit Days…`. Note *Credit Days* is a **number of days** not a code — the mapping supports `payment_term_days` as an alternative target so Format C works without a code table.

### 4.3 Deterministic post-processing (confidence adjustment)
Final confidence = f(AI confidence, heuristic agreement, type compatibility):

- **Type compatibility gate:** `due_date`→ column must parse ≥ 90% as dates (else cap 0.3); `amount` → ≥ 95% numeric; `customer_id` → non-empty ≥ 98%; term-days → integers in 0–365. Failure ⇒ confidence capped and message "column contents don't look like a date".
- **Agreement bonus/penalty:** AI and alias-dictionary disagree ⇒ min(...) and flag; agree ⇒ keep.
- **Uniqueness/cardinality plausibility:** customer_id distinct ratio vs. row count; ledger/dimension low cardinality.
- Thresholds (org-tunable, defaults): **≥ 0.90 = auto-suggested (still shown for confirm on first import)**, **0.70–0.90 = "Review recommended"**, **< 0.70 = "⚠ Review required" and blocks confirm until user acts**; required fields (`customer_id`, `amount`, `due_date`) below 0.70 or unmapped block import completely.

## 5. Step 5 — Human-in-the-loop review

Screen (per sheet, tabs for multiple sheets):

```
AI detected your workbook                                  Source: SAP   Report: Open Items   Confidence 97%
Sheet [FBL5N ▾]  Header row [4]   As-of date [2026-09-29 ▾ (found in B2)]   Currency [AUD]

SOURCE COLUMN        SAMPLE (real, shown locally)   MAPPED FIELD          CONF.
Cust No.             905559, 905560                 Customer ID  ▾        99%
Customer Name1       SAI & SONS PTY LTD             Customer Name ▾       98%
Net due dt           27.08.2026                     Due Date ▾            99%
Amt in loc.cur.      2,562.00                       Amount ▾              99%
PayT                 AR02, AR03                     Payment Terms ▾       97%
BusA                 84, 86                         Ledger ▾           ⚠ 61%  Review required
User Name            jsmith                         — Ignore —

Missing required fields: none        Optional unavailable: Clearing Document [Mark unavailable]
[ Preview normalized rows ▸ ]                                   [ Confirm & Import ]
```
Actions per column: **Change mapping** (dropdown of remaining fields, fuzzy search), **Ignore column**, **Mark field unavailable** (for fields no column supplies), **Confirm**. The real samples are shown in the browser from the tenant-private profile (they never went to AI). A **live preview** (first 20 normalized rows + parse-failure counts) is produced deterministically so the user sees what dates/amounts will become before confirming.

Follow-on steps in the same wizard:
1. **Payment terms:** table of distinct codes found (+ row counts) with AI-suggested days where the code is self-describing (`NET30`, `30D`), blank otherwise; user fills/maps (`AR02 → 7 days`). Unmapped ⇒ "Other / Unmapped".
2. **Business dimensions:** if a dimension column/rule was proposed (`Ledger`), user names it and lists values (`84/86/88`); or defines derive-rule (GL account prefix → ledger, replacing the reference's `tblLedgerMapping`).
3. **Validation summary** (INFO/WARNING/ERROR list, drill to rows).
4. **Confirm** → writes `confirmed_mapping`, creates `import_profile` v1, audit event `mapping.confirm`.

Never auto-confirm on first import, regardless of confidence. Subsequent imports may auto-apply a *confirmed* profile.

## 6. Import profiles, recognition & drift

Profile definition (DATA_SCHEMA §4.3) stores per sheet: name pattern, header row rule, `column_mapping`, ignored/unavailable lists, parse settings, as-of-date strategy (`cell:B2 regex` | `filename pattern` | `ask_each_time`), payment sign convention, skip rules (footer/subtotals).

**Recognition:** candidate profiles ranked by (data source, sheet-name match, Jaccard similarity of normalized header sets, type-signature match). ≥ 0.98 similarity ⇒ "**Recognized: ABC Foods — SAP FBL5N Weekly Export**" and auto-applied; 0.6–0.98 ⇒ drift; < 0.6 ⇒ new analysis.

**Drift detection (always runs, even on recognized profiles):**

| Change | Classification | Behaviour |
|---|---|---|
| Column missing that is mapped (required) | **BREAKING** | Block; `SCHEMA CHANGE DETECTED` review |
| Column missing (optional) | WARNING | Proceed with review notice |
| New column | INFO | Listed as `unmapped_columns`; optional mapping |
| Header renamed but position/type/stats match a mapped column | LIKELY RENAME | Suggest carry-over mapping (AI-free heuristic first; AI only if ambiguous) → review |
| Column reorder only | none | Mapping is by header, not position |
| Type change (e.g., date column now text) | BREAKING | Block |
| Header row moved / sheet renamed | WARNING | Re-detect via profile rules; review if unresolved |
| Distribution shift (e.g., amounts now 100× larger, row count ±30%) | WARNING | Flag, possible unit change |

Any confirmed change creates `import_profile_versions` v(n+1); old imports keep their original version for reproducibility. AI is invoked on repeat imports **only** when heuristics can't resolve a drift.

## 7. Normalization contract (post-confirmation, deterministic)

- Parse per profile hints; reject ambiguous formats rather than guess (e.g., `03/04/2026` with unknown day-first — determined once from data during inspection, stored in profile, re-verified each import).
- Money: strip symbols, handle `(1,234.50)`, trailing `-`, locale separators, produce `Decimal`; empty ⇒ null (not 0, unlike the reference `num()` which coerces invalid to 0 — that silently hides bad data).
- IDs: strings, trimmed, preserving leading zeros (with optional profile rule to normalise zero-padding consistently across sheets).
- Payment sign convention from profile (`positive_is_receipt | negative_is_receipt | abs`); `unknown` ⇒ user must choose at review.
- Dimension assignment via column or `dimension_rules`; terms via `payment_term_mappings` (days from column when `payment_term_days` mapped).
- Each output record keeps `lineage` and `raw`.

## 8. The three POC formats (acceptance fixtures)

| Canonical | A — SAP | B — Generic | C — Strange |
|---|---|---|---|
| customer_id | `Customer` | `Account Number` | `Client Ref` |
| customer_name | `Customer Name1` | `Business Name` | `Trading Name` |
| due_date | `Net due dt` | `Due Date` | `Expected Payment Date` |
| amount | `Amt in loc.cur.` | `Outstanding Amount` | `Open Balance` |
| payment terms | `PayT` (code `AR02`) | `Payment Terms` (`Net 7`) | `Credit Days` (`7`) |

Fixtures deliberately vary: header row offset (A has 3 title rows; C has header on row 2 after a merged banner), sheet names (`FBL5N`, `Sheet1`, `Debtors_Wk39`), date formats (`DD.MM.YYYY` text, Excel serial, `2026-09-29` ISO), number styles (`1,234.50`, `(1,234.50)`, `1234.5`), a subtotal footer row, extra junk columns, one Payments sheet each (with different naming), plus `.csv` and `.xls` variants of B. **Pass criteria:** each yields identical canonical JSON (after lineage removal) and identical snapshot metrics; AI mapping accuracy ≥ 95% of columns correct on first suggestion, 100% after the deterministic gates; **no dashboard code differs by format**.

## 9. AR Copilot (Phase 13)

### 9.1 Architecture
```
User question
   ↓ (authz: role, org, scope=snapshot/data source)
Copilot planner (LLM): picks tools + arguments        ← sees tool schemas + org dimension/term vocabulary ONLY
   ↓ tool call (JSON)
Tool Gateway: Zod-validate args → authorize (RBAC, collector scope) → run read-model query under withTenant()/RLS
   ↓ verified structured result (row-capped, sanitized, with result_id)
Answer composer (LLM): explains; must reference result_ids
   ↓ post-check: every number/name in the answer must appear in a tool result (verifier)
Rendered answer: CALCULATED DATA (from tool results, rendered by code) + AI INTERPRETATION (LLM prose)
```
The LLM never sees SQL, table names, other tenants, raw rows beyond what a tool returns, or credentials. **No tool writes data.** (Creating collection actions from Copilot suggestions is a UI action the user performs.)

### 9.2 Tool registry (v1, read-only, all snapshot-scoped)
| Tool | Args (validated) | Returns |
|---|---|---|
| `get_kpis` | `snapshot?`, `filters{dimension, term, currency}` | Total AR, overdue, %, counts, payments this/last week |
| `list_customers` | `filters{overdue_pct_gt, overdue_gt, balance_gt, dimension, term, no_payment_days_gt, risk_flag, balance_change_gt, assigned_to}`, `sort`, `limit≤50` | customer rows (id, name, balance, overdue, %, last payment…) |
| `get_customer` | `customer_id` | full customer profile + aging + last N invoices/payments + collection history |
| `get_aging` | `filters` | bucket totals |
| `compare_snapshots` | `from`, `to`, `metric` | deltas overall and per-customer top movers |
| `get_payment_trend` | `weeks≤26`, `filters` | weekly payment totals |
| `explain_overdue_change` | `from`,`to` | deterministic decomposition: new overdue, aged-in, payments applied, credits (calculated by code) |
| `get_collection_priorities` | `limit`, `strategy: rules_v1` | **rule-ranked** list (e.g., score = overdue$ × age factor − recent payment/promise adjustments; formula documented & configurable) |
| `get_follow_ups_due` | `date`, `assignee?` | open actions/promises due |
| `get_data_quality` | `snapshot` | validation notes, unmapped terms, undated items, payment window |

Example mappings: "Show Ledger 84 customers more than 50% overdue" → `list_customers{dimension:{ledger:'84'}, overdue_pct_gt:50}`; "Which customers should we follow up today?" → `get_follow_ups_due` + `get_collection_priorities`; "Why did overdue AR increase?" → `explain_overdue_change` then LLM narrates; "Summarize ABC Corporation" → `get_customer` (name resolved via search tool returning candidates; ambiguity ⇒ ask user).

### 9.3 Answer format (typed)
```jsonc
{
  "calculated": [ { "label": "Total overdue", "value": "$2,784,014", "source": {"tool":"get_kpis","result_id":"r1","field":"total_overdue"} } ],
  "tables":     [ { "title": "Customers >50% overdue (Ledger 84)", "result_id": "r2" } ],
  "interpretation": "…LLM prose. Clearly marked as interpretation…",
  "unavailable": ["No payment data before 2026-04-17, so 60-day no-payment results are limited."],
  "assumptions": ["“Today” = as-of date of latest import (2026-09-29)."]
}
```
UI renders **Calculated data** panel (numbers formatted by code from tool results) separately from **AI interpretation** (visually distinct, labelled). Numbers inside prose must be *placeholders* (`{{r1.total_overdue}}`) substituted by code; a verifier rejects/rewrites answers containing numeric literals not traceable to a result.

### 9.4 Limits & logging
Row caps, token caps, per-user/org rate & spend limits, session-scoped memory (only prior tool results and messages within the same tenant), full `ai_messages` + `ai_runs` logging (tool args/result ids, not raw data duplication), admin-viewable. Prompt-injection defence: cell text returned from tools (names, notes, references) is wrapped as untrusted data fields; system prompt states tool results are data, not instructions; tool set fixed; no URL fetching; output cannot trigger actions.

### 9.5 `explainCustomer`
Input: a **facts object** (calculated metrics + last payments + collection history, already authorized). Output: short narrative, risk *observations* referencing which deterministic risk rules fired (never inventing a risk level), and suggested next steps labelled as suggestions. Schema forbids numeric fields not present in `facts`.

## 10. Safety & accuracy requirements (testable)

1. AI output is never persisted into canonical/financial tables; only `ai_runs`, `import_jobs.ai_analysis` (mapping suggestions), `ai_messages`.
2. No LLM-authored number reaches the UI without matching a tool result (verifier + tests with adversarial prompts: "just estimate", "ignore the tool", "what would total be if…").
3. Unavailable data ⇒ explicit "unavailable"; tests ensure no answer for unknown customers/dates.
4. Low-confidence mapping cannot be confirmed silently; required-field gates enforced server-side (not just UI).
5. Masking tests: fuzzed workbooks with planted names/IDs/emails must produce provider payloads containing none of them.
6. Injection tests: cells containing "Ignore previous instructions…" must not change mapping schema/behaviour.
7. Provider outage/disabled AI ⇒ heuristic path completes the flow.
8. Every AI call has org, purpose, prompt version, model, tokens, cost recorded.

## 11. Cost, latency, caching
- Extraction is once per *new format*; recognized profiles skip AI. Cache key = (`fingerprint`, `prompt_version`, `policy`) → reuse suggestion across orgs *only for de-identified structural fingerprints* (**[DECISION]** cross-tenant cache of pure-header analyses is optional and off by default).
- Use a small/fast model for report type + mapping; a stronger model only when heuristics and AI disagree. Target < 10 s p95 for analysis; UI shows progress via job events.
- Copilot: one planning call + ≤ 3 tool rounds + one composition call; streaming answer; per-org monthly token budget.

## 12. Evaluation & regression
- **Fixture corpus:** A/B/C formats + ≥ 15 further synthetic variants (Oracle, Dynamics, NetSuite, Xero, MYOB, QuickBooks exports; multi-sheet; merged banners; foreign-language headers; typos), + real anonymised samples when available (Q13).
- **Metrics:** report-type accuracy, per-column mapping precision/recall, calibration (confidence vs. correctness), required-field miss rate, tokens/cost, latency, masking leakage (must be 0).
- **CI gate:** prompt/model/provider change must not regress golden metrics; cross-provider contract tests via the same suite (adapters must satisfy the same schemas).
- **Copilot eval set:** the prompt's example questions + adversarial ones; scored on correct tool choice, correct args, numeric fidelity (100% required), refusal on unavailable data.
- **Production monitoring:** rate of human overrides per suggested mapping (feeds prompt/alias improvements), drift incidents, AI error rate, cost per import.
