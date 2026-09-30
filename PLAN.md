# PLAN — AI-Powered Accounts Receivable Intelligence (SaaS)

Status: **PLANNING ONLY — no application code until this plan is approved.**
Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md) · [DATA_SCHEMA.md](DATA_SCHEMA.md) · [AI_EXTRACTION.md](AI_EXTRACTION.md)

Positioning: *"Turn your existing AR reports into actionable collections intelligence."*
Not "AI Excel dashboard". Primary CTA **Analyze My AR Report**, secondary **View Demo**.

> ## SCOPE REVISION — single company first (decided)
> We are building **one application for one company**. SaaS/multi-tenancy is postponed until this works for that company.
> - **Dropped for now:** organizations, multiple users/roles, sign-up, tenant `organization_id` columns, Postgres row-level security, per-org settings, billing, cross-tenant leak tests.
> - **Kept:** a single **admin password** for the Admin page (it holds the AI key and settings), audit log, private S3 storage, import profiles, validation, snapshots/history, configurable settings (ageing buckets, risk rule, payment terms, ledger values) stored as one global config.
> - **Kept so SaaS is cheap later:** all database access goes through one repository layer, UUID primary keys, config in tables (not code). Adding `organization_id` + RLS later is a planned migration, not a rewrite.
> - **Company-specific defaults are allowed** (e.g. pre-loaded column mapping and payment-term codes for their report format), which also means AI mapping becomes optional/later.
> Where ARCHITECTURE.md §4 and DATA_SCHEMA.md describe tenancy, treat it as the *future* SaaS design.

---

## 1. Phase 0 — Audit of what exists

### 1.1 Existing repository (`excel-as-db`)
The old People-Dashboard / SharePoint-Graph POC was removed at the start of this task (backup kept outside the repo).
What remains and what to do with it:

| Item | State | Action |
|---|---|---|
| Next.js `16.3.6`, React 19, Tailwind 4, TS | Scaffold only | **Keep** (matches preferred stack) |
| `next.config.ts` → `output: "export"` | Static export | **Remove** — SaaS needs a server runtime (auth, DB, uploads, jobs) |
| `@azure/msal-browser` dependency | Old POC | **Remove** (re-introduced later only in Phase 15 for SharePoint, server-side) |
| `AGENTS.md` / `CLAUDE.md` | "This is NOT the Next.js you know" | **Keep**. Read `node_modules/next/dist/docs/` before each phase. Notable for us: Next 16 renamed Middleware → **Proxy** (`proxy.ts`), and the docs explicitly say Proxy is for optimistic checks only, *not* authorization. Our authz therefore lives in the server data-access layer + Postgres RLS (see ARCHITECTURE §4). |
| Git | Clean history: 4 commits from old POC | Start new work on a branch; old POC stays in history only |

Greenfield: nothing else to migrate.

### 1.2 Reference product: "AR Control Centre" (single-file HTML, jQuery + Chart.js + DataTables + SheetJS)
Analysed from `Accounts Receivable Aging and Outstanding Report 1.html` (739 lines; all logic client-side, in-browser only).

**Information architecture (retain as product concepts):**
Executive Overview · Customer Detail · Collections Performance · Managerial Insights · Data & Configuration.

**Inputs it expects (SAP FBL5N-style):** workbook with sheets *Open Items*, *Payments*, *PayT Mapping* (or SharePoint tables `tblOpenItems`, `tblPayments`, `tblPayTMapping`, `tblLedgerMapping`). Header row auto-located by finding a row with a "customer" and an "amount" column. Column aliases (fuzzy, punctuation-insensitive): Customer, Customer Name1/2, DocumentNo, Type, PayT, Clrng doc., CoCd, BusA, Reference, Text, Doc. Date, Pstng Date, Amt in loc.cur., LCurr, Pmnt date, Net due dt, Ledger, Account.

**Business rules found in the reference (and disposition):**

| # | Rule in reference | Disposition |
|---|---|---|
| R1 | Total AR = Σ amount of open items (after ledger/term filter) | **Retain** |
| R2 | Item overdue if `dueDate < asAt` (strict); due-today = Current | **Retain**, made explicit + configurable (`overdue_grace_days`, default 0) |
| R3 | Days overdue = `floor((asAt − dueDate)/86400000)` | **Redesign**: pure date arithmetic (no ms/timezone/DST math) |
| R4 | Aging buckets Current, 1–7, 8–14, 15–30, 31–60, 61–90, 90+ **per open item** | **Retain**; bucket set becomes per-org config |
| R5 | Blank/invalid due date ⇒ silently "not overdue"; only a footnote counts them | **Redesign**: validation WARNING; optional derivation `due = baseline_date + term_days`; org policy decides |
| R6 | Overdue % = overdue ÷ balance, shown only if balance > 0, else "Credit" chip | **Retain** |
| R7 | Overdue Customers = customers with overdue > 0 | **Retain** |
| R8 | Customer = group by customer id; name = Name1 + Name2 | **Redesign**: reference concatenation produces "MORE THAN MILK CO PTY LTD MORE THAN MILK CO PTY LTD". Keep name1/name2 separately; display name = name1, secondary = name2 (dedupe if equal) |
| R9 | Payment terms bucketed 7/14/21/30/Other via hard-coded `DEFAULT_TERMS` (AR02→7 …) or PayT Mapping sheet; `"N Days"` passes through | **Redesign**: per-org `payment_term_mappings`; SAP codes not universal; unmapped codes surfaced *during onboarding* (reference dataset has ~5,000 unmapped rows—0021, ZR16, AR16, … — showing it must be a first-class step) |
| R10 | Ledger 84/86/88 hard-coded in UI; derived from Ledger column, or from Account via ledger-mapping table | **Redesign**: configurable **business dimensions** (see DATA_SCHEMA) |
| R11 | Payments: `Math.abs(amount)`; date = Pmnt date, fallback Pstng date; blank date ⇒ ignored | **Retain with explicit sign convention** per profile; fallback rule configurable |
| R12 | Weeks are Mon–Sun, computed from as-at | **Retain**, `week_start_day` configurable |
| R13 | "Payments This Week" = week-to-date; WoW % compares it with the *full* previous week | **Redesign — this is a defect.** The reference's own screenshot shows −88.8% ($191,928 vs $1,716,728) purely because it's mid-week. Default to *like-for-like* comparison (same elapsed days of prior week) and also show last *complete* week. |
| R14 | "Collection Recovery" = this-week payments ÷ current total AR | **Redesign**: ill-defined denominator. Rename *Weekly Collection Rate* = payments in period ÷ opening AR of period (from the prior snapshot), and document it |
| R15 | Balance change vs previous upload — stored in browser `localStorage` | **Redesign**: server-side historical snapshots (the core reason for a SaaS) |
| R16 | Last payment per customer from Payments sheet; "no payment in 30/60d" also includes customers with *no* payment on record | **Retain**; add caveat "payments cover N days" (reference already prints it) |
| R17 | High Risk = balance > $10,000 AND overdue % > 50% (both editable in UI, not persisted) | **Retain as default rule**, persisted per org, extensible rule engine |
| R18 | Colour thresholds: overdue % ≤10 green / ≤risk% amber / else red; last payment ≤30d green ≤60 amber else red | **Retain as config defaults** |
| R19 | "Balance rising" = delta > $0.50 vs previous snapshot; "No change" if |Δ| < $0.50 | **Retain**, epsilon in config |
| R20 | Per-customer "Payments vs last week" (tw − lw) | **Retain** |
| R21 | As-at inferred as max posting/doc date in data | **Redesign**: taken from report metadata / user-confirmed at import; stored on the import |
| R22 | Aging Mix doughnut clamps negatives to 0 ("debit balances") | **Retain**, label credits separately |
| R23 | `isOpen(r) = !r.clearing` — but `clearing` is never copied into the normalised row, so the filter is a no-op | **Redesign**: explicit, tested "open item" rule; clearing-document rows flagged in validation |
| R24 | Currency hard-coded AUD in formatter; `LCurr` read but unused | **Redesign**: currency on every amount; multi-currency policy (Open Question Q6) |
| R25 | Exports: customer table → CSV/XLSX | **Retain** |
| R26 | Filters: Ledger, Payment Terms, As-At, risk thresholds; clickable ledger/term tiles cross-filter | **Retain** (tiles become dimension-driven) |
| R27 | Demo data generator | **Retain** as seeded demo tenant ("View Demo") |
| R28 | Print view | Nice-to-have, post-MVP |

**Screens/widgets to carry over:** 6 KPI tiles; ledger tiles; AR ageing bar + mix doughnut; payment-terms cards; Top-10 exposure; matching-customers table; Customer Detail table (11 cols + quick filters: overdue/high-risk/no-pay-30/balance-rising/credit); Collections page (4 metrics, 8-week trend, this-vs-last week bar); Insights (Top 20 exposure, highest overdue %, no-pay 30/60, high-risk, control notes); Data & Configuration.

**What the reference does *not* have (new for SaaS):** auth, tenancy, persistence, import history, mapping review, validation engine, audit trail, collection actions/notes/assignment, customer drill-down page, AI copilot, RBAC.

---

## 2. Product principles (non-negotiable)

1. **AI interprets structure; code calculates money.** No LLM ever produces a balance, total, date difference or risk flag. (AI_EXTRACTION §10)
2. **Human confirms every first-time mapping.** No silent acceptance of low-confidence output. Schema drift halts import.
3. **Tenant isolation is designed in, at two layers** (application scoping + Postgres RLS).
4. **Everything traceable:** dashboard number → normalized record → source row → original file.
5. **Company keeps its report format.** One dashboard for all formats — proven by the 3-format POC test.
6. **Privacy-minimal AI:** structure + masked samples only.

---

## 3.0 Step 0 — static preview on Cloudflare (DONE)
Dashboard page + **Upload files** button as a static export served by a Cloudflare Worker (`wrangler.jsonc`, `out/`). Everything runs in the browser (`.xlsx`/`.csv` only; `.xls` needs the backend parser). Pure logic lives in `src/lib` (dates, money, mapping, normalize, calc) and is reused unchanged by the backend stage. Tests: `npm test` (three formats A/B/C, real `.xlsx` in `fixtures/formats`). Live: https://ar-intelligence.kaareyes-developer.workers.dev

## 3. MVP definition (first sellable) — REVISED

**Product-owner direction (latest):** the MVP is **one dashboard page with an "Upload files" button**. AI is **not** wired in for the first build; it is added later on the backend and configured from an **Admin page in the web app** (provider, API key, prompts).

```
Dashboard page ──[ Upload files ]──► inspect workbook ──► mapping review (deterministic suggestions)
   ▲                                                         │ confirm
   └──────── dashboard refreshes from verified snapshot ◄── validate → normalize → calculate
```

**MVP-1 (build first)**
- A single **Dashboard** page (KPIs, ageing, mix, top exposure, terms cards, customer table with search/sort/filter/export) with an **Upload files** button (also drag-and-drop) accepting `.xlsx/.xls/.csv`.
- Upload → deterministic workbook inspection → **heuristic column mapping** (alias dictionary + type checks from AI_EXTRACTION §2/§4.3) → mapping review dialog (confirm / change / ignore / unavailable) → validation summary → import → dashboard updates.
- Saved import profile so the next upload is recognised and applied (with drift detection).
- Payment-term mapping and dimension (ledger/segment) setup inside the review dialog.
- Original file stored privately; import history list; deterministic calc engine + snapshots.
- Minimal **Admin page**: users/roles basics and the **AI Settings** section (see §3.1) — present but AI "disabled" until a key is saved.

**MVP-2 (right after)**: customer detail page, collection actions/notes/assignment, collections performance + 8-week trend, insights lists, full auth/multi-org onboarding UI, demo tenant.

**Later:** AI extraction switched on via Admin settings (Phase 4 — the plumbing and fallback already exist), Copilot (Phase 13), automated data sources (Phase 15).

Note: the multi-tenant foundation (organization_id + RLS) is still built in from the start even though the first UI shows one company — retrofitting it later is the expensive path.

### 3.1 Admin → AI Settings (configurable AI, no redeploy)
- Fields: **Provider** (OpenAI / Anthropic / Google), **API key**, **Model**, **Enabled** toggle, per-purpose **prompt text** (workbook analysis, report-type, column mapping, copilot, explain-customer), **AI data policy** (`off | structure_only | structure_plus_codes`), monthly token/cost cap, **Test connection** button.
- **API key:** write-only in the UI (shown as `sk-…••••1a2b`), stored encrypted server-side (envelope encryption), never sent to the browser, never logged; rotation supported.
- **Prompts are editable, guardrails are not:** the editable part is the *instruction text*. The output JSON schema, masking (`prepareAIPayload`), validation, confidence gates and "AI never calculates" rules stay in code and are appended/enforced regardless of what the prompt says. Prompts are versioned (draft → test on fixtures → activate), with one-click rollback and "Reset to default"; each `ai_runs` row records the prompt version used.
- Only **Owner/Admin** may view or change these settings; every change is audit-logged (without the key value).
- Scope (**decided, Q14**): **one platform-wide provider/key/prompt set**, managed by the operator in the Admin page. It is a single row (no per-org override in v1); AI stays off until configured, and the product works fully without it. The `ai_settings`/`ai_prompts` tables keep a nullable `organization_id` so per-org override can be added later without a migration of meaning.
- **No login in MVP-1 (decided):** the app opens straight to the dashboard for a single implicit company. Because the Admin page holds the AI key, it is gated by a server-side `ADMIN_PASSWORD` env var (session cookie after entering it) — not left open. Real auth/RBAC/multi-org sign-up arrives in MVP-2; the code paths still go through `withTenant()` with a fixed default org so nothing is rewritten then.
- **Sample data (decided):** no customer samples available; we generate the three POC formats (A/B/C) plus messy variants as synthetic fixtures.

**Explicitly out of MVP:** SharePoint/OneDrive/Drive/SFTP/email/ERP connectors; AI Copilot (beta after MVP — Phase 13); AI extraction itself (enabled later from Admin settings); SSO/SAML; billing/subscriptions (decision Q9); multi-language; email/SMS sending from the app; dunning automation; mobile app; PDF board pack.

**Acceptance for MVP ("POC success test"):** three workbooks in three different formats (A SAP-style, B generic, C odd naming — fixtures specified in AI_EXTRACTION §8) all produce identical canonical records and — for equivalent data — byte-identical dashboard numbers, with **zero dashboard code changes**.

---


### 3.2 Admin sign-in (decided)
- Single admin account: username **`hazel`**. The initial password is a bootstrap value supplied through the environment (`ADMIN_INITIAL_PASSWORD`, seeded once; **never hard-coded in source**), and the account is created with `must_change_password = true`.
- **Forced change on first sign-in:** after a successful login the API returns a restricted session that can only call "change password"; nothing else in Admin works until it is changed. The new password must differ from the initial one and meet the policy (min 10 chars, not equal to the username, not on a common-password list).
- Storage: `admin_users(id, username unique, password_hash argon2id, must_change_password, failed_attempts, locked_until, password_changed_at, created_at)`. Passwords are only ever stored as argon2id hashes.
- Protection: login rate-limit + lockout after repeated failures (e.g. 5 tries → 15 min), generic error messages, HttpOnly + Secure + SameSite cookie session with idle/absolute timeouts, CSRF protection, audit log entries for login, failed login, password change.
- Deployment note: the bootstrap password is weak by design, so **sign in and change it immediately after the first deploy** (the admin page is the only exposed surface until then). Serving the API on a subdomain of the same registrable domain as the website (e.g. `api.<domain>`) keeps the cookie first-party.
- Scope: this same account is the only admin; it guards AI settings and dashboard configuration. Multi-user/roles remain a later phase.

## 4. Phased implementation plan

> **Revised order after the static preview (hosting: Node.js API on AWS, Postgres on RDS, frontend on Cloudflare — see ARCHITECTURE §0):**
> 1. Backend foundation (monorepo, `packages/core`, Fastify API, RDS schema + RLS, default company, CDK skeleton) ·
> 2. Upload + S3 storage + server-side inspection (adds `.xls`) ·
> 3. Import profiles, validation, import with source-row lineage ·
> 4. Saved data + history (snapshots, balance change, 8-week trend) — dashboard reads the API ·
> 5. Admin page + AI settings (password-gated) ·
> 6. AI mapping on ·
> then: login/multi-company, customer detail + collections, insights/export, Copilot, hardening, automated sources.
>
> The original phase table below is kept for reference.

Every phase ends with: tests green, docs updated, demo-able slice, reviewed before the next begins.

**Phase 0 — Project audit** ✅ (this document §1).

**Phase 1 — Architecture, canonical schema, fixtures**
- Approve these four docs. Freeze canonical schema v1.0 (Zod + JSON Schema).
- Create the *three POC workbooks* + a golden expected-output file. Build fixtures **before** code — they are the acceptance tests for Phases 3–8.
- Repo scaffold decisions: package manager, lint/format, CI, env handling. Remove `output: "export"`, MSAL.

**Phase 2 — Auth & multi-tenancy**
- Postgres + migrations (Drizzle), auth, organizations, memberships, RBAC helpers.
- Tenant-scoped data-access layer + RLS policies + **cross-tenant leak test suite** (must exist from day one).
- Audit-log plumbing. Onboarding step 1: create company.

**Phase 3 — Upload & workbook inspection**
- Signed-URL upload to S3-compatible storage, size/MIME/magic-byte checks, hash, quarantine → scan → available.
- Deterministic inspector → `WorkbookProfile` JSON (sheets, header-row candidates, tables, merged cells, types, samples).
- Import job state machine + background worker.

**Phase 4 — AI schema detection**
- `AIProvider` interface + first provider adapter + mock provider for tests.
- Masking/minimization, prompts, JSON-schema-constrained output, confidence policy, deterministic fallback heuristics (alias dictionary reused from reference R-list as *hints*, not authority).
- Eval harness over fixtures; store `ai_runs` (prompts hash, model, tokens, cost).

**Phase 5 — Human mapping confirmation**
- Mapping review screen (per AI_EXTRACTION §5): change / ignore / mark-unavailable / confirm; low-confidence blocking; report-type override; sheet selection.
- Payment-term mapping step (unmapped codes) and dimension mapping step.

**Phase 6 — Import profiles**
- Save profile (structural fingerprint), recognize on next upload, apply, drift detection (`SCHEMA CHANGE DETECTED`), versioned profiles.

**Phase 7 — Normalization & validation**
- Parsers (dates incl. Excel serials/`dd/mm/yyyy`, money incl. `(1,234.50)`/trailing minus/locale), canonical mapper, dedupe keys, validation rule set, import commit transaction, row-level lineage.

**Phase 8 — Calculation engine**
- Pure-TS deterministic engine + golden tests (numbers reconciled against reference on the same dataset), snapshot materialization (`ar_snapshots`, `customer_snapshots`, aging, weekly payments), configurable buckets/risk rules.

**Phase 9 — Executive dashboard**
- KPIs, ageing, mix, top exposure, terms cards, dimension tiles, filters (org, data source, as-of, segment, terms, currency).

**Phase 10 — Customer review**
- Customer list (search/sort/filter/pagination/column selection/export) and full Customer Detail page (aging, open invoices, payment history, risk indicators, trend, lineage drill-through).

**Phase 11 — Collections management**
- Actions, notes, promise-to-pay, follow-up date, assignment, "Collections list / today's worklist", collector-scoped views.

**Phase 12 — Historical comparisons**
- Import history UI, balance change, payment trend, 8-week trend, WoW like-for-like, snapshot comparison, restatement handling (re-import of same as-of date).

**Phase 13 — AR Copilot** (post-MVP beta)
- Tool/query layer, tool schemas, authorization, answer format with CALCULATED vs INTERPRETATION separation, session logging, eval set of the example questions.

**Phase 14 — Audit & security hardening**
- Pen-test checklist, rate limits, retention & deletion jobs, backup/restore drill, secret rotation, CSP, dependency audit, SOC2-style controls doc.

**Phase 15 — Automated data sources**
- `DataSource` connectors: SharePoint/OneDrive first (reuse learnings from the old POC — server-side Graph, app-only or delegated OAuth per tenant), then Google Drive, SFTP, email ingestion; scheduled pulls feeding the *same* import pipeline.

**Improvements over the suggested phases:** (a) fixtures + golden dataset moved to Phase 1; (b) tenant-leak tests in Phase 2 not Phase 14; (c) payment-term/dimension mapping pulled into Phase 5 (reference shows unmapped terms are the norm); (d) Copilot moved out of MVP but kept designed-for (tool layer sits on the same query services the UI uses); (e) demo tenant added to Phase 9.

---

## 5. Technical risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Real-world workbooks are messy (multi-header, subtotals, merged cells, footers "Total") | Wrong imports | Inspector detects subtotal/blank patterns; validation flags; human review; profile stores row-skip rules |
| AI mislabels a column (amount vs. balance vs. foreign-currency amount) | Wrong dollars | Human confirmation; data-type/plausibility checks in code; reconciliation: sum of imported amounts vs. control total when present in file |
| Definition ambiguity (what is "overdue", credits, sign of payments) | Numbers disagree with customer's ERP | Explicit per-org policy config, documented definitions, "explain this number" lineage, golden tests |
| Cross-tenant leak | Catastrophic | RLS + scoped repository + leak tests in CI + no raw SQL outside data layer |
| Copilot hallucinated numbers | Trust loss | Tool-only numeric access; response schema separating calculated/interpretation; numbers rendered from tool results by code, not typed by model |
| Sending customer data to an LLM | Privacy/contract | Masking, samples only, provider DPA/zero-retention, per-org AI opt-out, redaction log |
| Malicious file upload (macro/zip bomb/CSV injection/XXE) | Server compromise | Size/type limits, magic-byte check, parse in isolated worker with memory/time limits, no macro execution, ZIP-ratio cap, escape formula prefixes on export, malware scan |
| Excel parsing library risk (SheetJS npm build is stale/vulnerable; xls is legacy) | RCE/DoS | Use maintained builds, isolate parsing, cap rows/cells, fuzz fixtures |
| Large files (100k+ open items) | Timeouts | Streaming parse, background job, chunked inserts, COPY, progress events |
| Re-import / overlapping payments windows | Double counting | Payment dedupe key, snapshot semantics for open items, idempotent import via file hash |
| Schema drift between weeks | Silent bad data | Fingerprint compare; hard stop with review |
| Time zones / as-of semantics | Off-by-one overdue | Date-only types (no timestamps) in calc; org timezone for "today" |
| LLM cost/latency | Margin | Cache by structural fingerprint; profiles avoid re-inference; small model for classification |
| Vendor lock-in to one AI provider | Strategic | `AIProvider` interface + contract tests + mock |
| Scope creep into ERP integrations | Delay | Explicit MVP boundary |

---

## 6. Open questions / product-owner decisions

Must answer before Phase 2 (blockers):
- **Q1 Hosting & residency:** Where will it run (Vercel + Neon/Supabase? AWS? Cloudflare?) and are there data-residency needs (e.g., AU-only)? Drives storage, DB and **AI-provider region**.
- **Q2 First AI provider:** Anthropic, OpenAI, or Google first? Any zero-data-retention contract requirement?
- **Q3 Auth approach:** managed (Clerk/WorkOS/Auth0) vs. self-hosted (Better Auth / Auth.js)? SSO (Microsoft Entra) needed at launch? *Recommendation: self-hosted library with organizations plugin for MVP; keep interface to swap to WorkOS for SSO.*
- **Q4 Definition of "overdue" & credits:** Do credit notes / unapplied payments inside the open-items list reduce Total Overdue (reference behaviour) or are they reported separately?
- **Q5 Report semantics:** Is each weekly open-items export always a **full snapshot** of all open items (assumed), or can it be incremental/delta for some customers?
- **Q6 Currency:** single reporting currency per org (reference behaviour) or true multi-currency with FX? *MVP recommendation: one reporting currency per import; foreign-currency column captured but not converted.*
- **Q7 Week-on-week:** approve like-for-like default (R13) and the *Weekly Collection Rate* rename (R14).

Can be decided later:
- Q8 Retention period for original files and imports (default proposal: 7 years finance / configurable, delete-on-request).
- Q9 Pricing/billing model & plan limits (rows, users, imports) — affects quotas, not architecture.
- Q10 Do collectors see only assigned accounts or everything read-only?
- Q11 Is the AR Copilot allowed to *draft* emails (still no sending) in v1?
- Q12 Name/brand and domain (landing copy assumes "AR Intelligence").
- Q13 Provide 2–3 real (anonymised) customer workbooks in addition to synthetic fixtures — highest-value input for Phase 4 accuracy.
