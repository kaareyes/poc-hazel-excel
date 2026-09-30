# ARCHITECTURE

Companion docs: [PLAN.md](PLAN.md) · [DATA_SCHEMA.md](DATA_SCHEMA.md) · [AI_EXTRACTION.md](AI_EXTRACTION.md)

Status: proposal for review. Items marked **[DECISION]** need product-owner/tech-lead sign-off.

---

## 0. Revision — hosting & runtime (decided; supersedes §1–3 and §6 where they conflict)

| Concern | Decision |
|---|---|
| Frontend | Current **static Next.js export stays on Cloudflare** (already live). It becomes a pure client of the API. Can move behind CloudFront later without code changes. `output: "export"` is kept. |
| Backend | **Node.js + TypeScript API (Fastify)** in `apps/api`, packaged as a container and run on **AWS ECS Fargate** behind an Application Load Balancer (HTTPS via ACM). Separate **worker** service (same image, different entrypoint) consumes **SQS** for import jobs. |
| Database | **PostgreSQL 16 on Amazon RDS** (single-AZ for MVP, Multi-AZ for production), encrypted (KMS), private subnets, automated backups + PITR. RLS + `withTenant()` exactly as in §4. **Drizzle ORM** + SQL migrations. |
| Files | **S3** private bucket (SSE-KMS, block public access, versioning), presigned PUT/GET ≤ 5 min. |
| Jobs | **SQS** (+ DLQ) replaces pg-boss. |
| Secrets | **AWS Secrets Manager / KMS** — the AI API key is stored encrypted and only the API/worker task role can read it. |
| Region | **ap-southeast-2 (Sydney)** proposed (AUD/AU customers). To be confirmed (Q1). |
| IaC / CI | **AWS CDK (TypeScript)**; GitHub Actions builds image → ECR → ECS deploy; migrations run as a pre-deploy task. |
| Auth (MVP-1) | No login. API is called by the Cloudflare-hosted site over CORS (allow-list of the site origin); Admin endpoints require `ADMIN_PASSWORD`-derived session. Real auth in the later phase. |
| Repo layout | Monorepo: `apps/web` (current Next app), `apps/api`, `packages/core` (the pure logic now in `src/lib`: dates, money, mapping, normalize, calc — shared by web and api), `infra/` (CDK). |

Consequences: the Next.js Route-Handler/Server-Action/Proxy parts of §1–3 are not used; all server logic lives in the Fastify API. Everything else (schema, calc definitions, AI layer, security model) is unchanged.

## 1. Summary

A multi-tenant, server-rendered SaaS. Files are uploaded to private object storage, inspected and normalised by deterministic code in a background worker, structure is interpreted by an AI provider behind an interface, a human confirms the mapping, and a **pure deterministic calculation engine** produces verified snapshots that power the dashboard and (later) the Copilot.

```
Browser (Next.js App Router, React 19, Tailwind 4)
   │  Server Components / Server Actions / Route Handlers
   ▼
Application layer (TypeScript, "modules")
   ├─ auth & tenancy      ├─ imports (inspect/map/validate/normalize)
   ├─ calc engine (pure)  ├─ read models (dashboard/customer queries)
   ├─ collections         ├─ ai (provider iface, extraction, copilot tools)
   └─ audit
   ▼
PostgreSQL (RLS)  ◄──── background worker (job queue in Postgres)
S3-compatible storage (private, SSE, signed URLs)
AI provider (OpenAI | Anthropic | Google) via AIProvider interface
```

## 2. Technology choices

| Concern | Choice | Notes |
|---|---|---|
| Web | **Next.js 16 (App Router), React 19, TypeScript, Tailwind 4** | Already installed. `output: "export"` **removed**. Read `node_modules/next/dist/docs` per phase (AGENTS.md). |
| Backend | Same Next.js app (Route Handlers + Server Actions) for request/response; **separate worker process** (same repo, `src/worker`) for imports and AI calls | Keeps long jobs off the web tier. One codebase, one deploy unit initially. |
| DB | **PostgreSQL 16+** | RLS for tenancy, `numeric` money, JSONB for raw rows/profiles. |
| ORM/migrations | **Drizzle** (SQL-first, RLS/policy friendly) | Alternative: Prisma. Raw SQL migrations for policies regardless. |
| Job queue | **pg-boss** (Postgres-backed) | No Redis to operate for MVP. Swap to SQS/BullMQ later behind `JobQueue` interface. |
| Object storage | S3-compatible (AWS S3 / Cloudflare R2 / MinIO in dev) | Private bucket, SSE, presigned PUT/GET ≤ 5 min. |
| Auth | **Better Auth** (organizations plugin) or Auth.js **[DECISION Q3]** | Sessions in DB, HttpOnly cookies, argon2id, email verification, TOTP 2FA, optional Entra/Google SSO later. |
| Validation | **Zod** everywhere (canonical schema, API input, AI output) + generated JSON Schema for AI structured output | |
| Excel/CSV parsing | **Deterministic parser in an isolated worker** | `.xlsx`: `exceljs` (streaming reader) or `read-excel-file`; `.xls` (BIFF) + fallback: SheetJS **0.20.x from cdn.sheetjs.com tarball** (the npm `xlsx@0.18.5` is stale with known CVEs — do not use); `.csv`: `csv-parse` with delimiter/encoding sniffing (`chardet`, BOM handling). **[DECISION: final library bake-off in Phase 3 against fixtures]** |
| Money & dates | `decimal.js` (or `big.js`) in TS; Postgres `numeric(19,4)`; calendar dates as `date` / ISO-8601 strings, **never JS `Date` in calc** | Avoids FP drift and timezone/DST off-by-one (the reference's `floor(ms/86400000)` pattern). |
| Charts | Recharts or visx (React-native, SSR-friendly) | Replaces Chart.js; follow dataviz palette rules. |
| Tables | TanStack Table + server-side pagination/sort/filter | Replaces DataTables/jQuery. |
| Testing | Vitest (unit/golden), Playwright (E2E), testcontainers-postgres (RLS/leak tests) | |
| Observability | OpenTelemetry (Next.js has instrumentation hook), structured logs with `org_id`/`import_id` (never row data), Sentry-class error tracking with PII scrubbing | |

## 3. Proposed project structure

```
excel-as-db/
├─ PLAN.md  ARCHITECTURE.md  DATA_SCHEMA.md  AI_EXTRACTION.md
├─ drizzle/                      # SQL migrations incl. RLS policies
├─ fixtures/
│   ├─ formats/{A-sap,B-generic,C-strange}.xlsx   # POC success test
│   ├─ expected/*.canonical.json  *.metrics.json  # golden outputs
│   └─ messy/                                     # subtotals, merged cells, xls, csv
├─ src/
│  ├─ app/                       # Next.js routes (thin)
│  │  ├─ (marketing)/            # landing, demo
│  │  ├─ dashboard/              # MVP-1: single dashboard page + Upload files button (dialog wizard)
│  │  ├─ admin/ai/               # MVP-1: AI Settings (provider, key, model, prompts, test)
│  │  ├─ (auth)/                 # sign-in, sign-up, invite
│  │  ├─ (app)/[orgSlug]/        # tenant-scoped app
│  │  │   ├─ overview/  customers/ customers/[id]/  collections/
│  │  │   ├─ insights/  imports/ imports/new/ imports/[id]/review/
│  │  │   ├─ settings/ (terms, dimensions, risk rules, users, profiles)
│  │  │   └─ copilot/
│  │  └─ api/                    # upload-url, webhooks, health
│  ├─ proxy.ts                   # Next 16 Proxy: optimistic session redirect ONLY
│  ├─ server/                    # NEVER imported by client code
│  │  ├─ auth/                   # session, requireOrgRole(), policies
│  │  ├─ tenancy/                # withTenant(orgId, fn) → sets app.current_org in tx
│  │  ├─ db/                     # drizzle schema, repositories (org-scoped)
│  │  ├─ storage/                # StorageProvider (s3), signed URLs, scan hooks
│  │  ├─ imports/
│  │  │   ├─ inspect/            # workbook → WorkbookProfile (deterministic)
│  │  │   ├─ mapping/            # profile matching, drift detection
│  │  │   ├─ parse/              # date/money/id parsers
│  │  │   ├─ normalize/          # source rows → canonical records
│  │  │   ├─ validate/           # rule set → ValidationIssue[]
│  │  │   └─ commit/             # transactional import
│  │  ├─ calc/                   # PURE functions, no I/O (see §7)
│  │  ├─ read-models/            # dashboard/customer/insight queries over snapshots
│  │  ├─ collections/
│  │  ├─ ai/
│  │  │   ├─ provider.ts         # AIProvider interface
│  │  │   ├─ providers/{openai,anthropic,google,mock}.ts
│  │  │   ├─ extraction/         # minimization, masking, prompts, schemas
│  │  │   └─ copilot/            # tool registry, planner, answer composer
│  │  ├─ datasources/            # DataSource interface + manual-upload impl
│  │  ├─ audit/                  # writeAudit(), lineage resolver
│  │  └─ jobs/                   # queue defs
│  ├─ worker/                    # entrypoint: pg-boss consumers (parse-heavy, AI)
│  ├─ components/                # UI (design system, charts, tables)
│  ├─ lib/                       # shared pure utils, canonical Zod schemas (isomorphic)
│  └─ types/
└─ tests/  (unit, golden, rls-leak, e2e)
```

Rules: `src/server/**` is guarded with `import "server-only"`; UI never touches `db` directly; only `read-models` and `collections` services are called from pages/actions; `calc/` has **zero** imports from db/ai/next.

## 4. Multi-tenancy & authorization

**Model:** shared database, shared schema, `organization_id` on every tenant-owned row. Composite FKs `(organization_id, id)` so a child can never reference another tenant's parent.

**Two independent enforcement layers:**
1. **Application layer.** Every request resolves `{ user, org, role }` server-side via `requireOrg(orgSlug)`. All DB access goes through `withTenant(orgId, tx => …)`, which opens a transaction and executes `SELECT set_config('app.current_org', $1, true)` (transaction-local). Repositories cannot be constructed without a tenant context; there is no exported unscoped db handle outside `db/admin` (used only by the migration/worker-bootstrap code and lint-banned elsewhere).
2. **Database layer — Row-Level Security.** For each tenant table:
   ```sql
   ALTER TABLE open_items ENABLE ROW LEVEL SECURITY;
   ALTER TABLE open_items FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON open_items
     USING (organization_id = current_setting('app.current_org', true)::uuid)
     WITH CHECK (organization_id = current_setting('app.current_org', true)::uuid);
   ```
   The application connects as a non-owner role (`app_rw`) without `BYPASSRLS`. If `app.current_org` is unset, the policy yields zero rows (fail-closed).
3. **Worker** jobs carry `organization_id`; the worker calls the same `withTenant`. A job payload never contains financial rows — only ids.
4. **Storage:** object keys are `org/{orgId}/imports/{importId}/{fileId}`; access only via server-issued signed URLs after an authz check; bucket has no public ACL.
5. **Cache safety:** no cross-tenant cache keys — every cache key includes `orgId`. Next.js data caching of tenant data is avoided or tagged per org (see docs `08-caching.md`).
6. **Proxy (`proxy.ts`)** only redirects unauthenticated users (optimistic). Per Next.js docs it is not an authorization boundary.

**Leak-test suite (Phase 2, CI-blocking):** seed orgs A & B; for every table and every read-model/repository function assert that a session for A returns 0 rows of B, including via joins, search, export, signed-URL issuance, AI tool calls and job payloads. A meta-test enumerates all tables with an `organization_id` column and fails if RLS is not enabled.

**RBAC** (org-scoped; a user may belong to several orgs with different roles):

| Capability | Owner | Admin | AR Manager | Collector | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| Delete org / billing / transfer ownership | ✅ | | | | |
| Manage users & roles | ✅ | ✅ | | | |
| Upload/confirm imports, edit mappings/profiles | ✅ | ✅ | | | |
| Configure terms, dimensions, risk rules, aging | ✅ | ✅ | | | |
| View dashboards & all customers | ✅ | ✅ | ✅ | assigned only* | ✅ |
| Create/edit collection actions, notes, assign collectors | ✅ | ✅ | ✅ | own/assigned | |
| Export data | ✅ | ✅ | ✅ | assigned | |
| Download original source files | ✅ | ✅ | | | |
| View audit log | ✅ | ✅ | | | |
| Use AR Copilot | ✅ | ✅ | ✅ | ✅ (scoped) | ✅ (read-only Q&A) |

\* Collector scope (Q10). Enforced in repository layer by adding an `assigned_collector_user_id` predicate, and mirrored by an RLS policy for `collector` role for defence in depth.

Permissions are expressed as capability strings (`import:confirm`, `customer:read`, `collection:write`, …) in one table `role → capabilities`; UI and server both call `can(ctx, cap, resource?)`.

## 5. Import pipeline (state machine)

```
UPLOADED → SCANNING → INSPECTING → (PROFILE_MATCHED | AWAITING_AI)
  AWAITING_AI → AI_ANALYZED → NEEDS_REVIEW → CONFIRMED
  PROFILE_MATCHED → (DRIFT_DETECTED → NEEDS_REVIEW | CONFIRMED)
CONFIRMED → NORMALIZING → VALIDATING → (BLOCKED_BY_ERRORS | READY_TO_COMMIT)
READY_TO_COMMIT → COMMITTING → CALCULATING → COMPLETED
any → FAILED | CANCELLED     (each transition writes an audit_log row)
```

1. **Upload:** client asks `POST /api/uploads` (authz: `import:create`) → server checks quota, returns presigned PUT with content-length limit + `Content-Type` condition. Client uploads direct to storage. `POST /api/uploads/complete` registers `uploaded_files` (status `quarantined`).
2. **Scan/validate file:** size ≤ limit (e.g. 50 MB MVP, configurable per plan), extension ∈ {xlsx,xls,csv}, **magic-byte sniff** (ZIP `PK` w/ `[Content_Types].xml` for xlsx; OLE2 `D0CF11E0` for xls; text for csv), reject encrypted/macro-enabled (`xlsm`, `vbaProject.bin`), ZIP-bomb guard (uncompressed/compressed ratio & entry-count caps), malware scan (ClamAV sidecar or managed scanner — **[DECISION]**), SHA-256 hash (dedupe/idempotency). Only then `status = clean`.
3. **Inspect** (deterministic, no AI): produces `WorkbookProfile` (AI_EXTRACTION §2). Parsing runs in a worker with memory/time/row/cell caps.
4. **Profile match:** compute structural fingerprint per candidate sheet; look up the org's `import_profiles`. Match → apply; drift → NEEDS_REVIEW.
5. **AI analysis** (only if no profile match or drift needs a suggestion): minimized + masked payload → `AIProvider`. Output validated by Zod; low confidence flagged.
6. **Human review:** mapping UI; confirmation writes/updates an `import_profile` version.
7. **Normalize:** stream source rows → canonical records with `source_sheet`, `source_row`, `raw` JSON retained.
8. **Validate:** rule engine (DATA_SCHEMA §6) → `import_issues`. Any `ERROR` blocks commit unless the rule is `overridable` and an Admin explicitly overrides (audited).
9. **Commit:** single DB transaction: upsert customers; insert open items for this import (snapshot semantics); insert payments with dedupe; write lineage; mark import `COMPLETED`. Idempotent by `(organization_id, file_sha256, profile_version)`.
10. **Calculate:** run engine over the import's records → write `ar_snapshots`, `customer_snapshots`, `ar_aging_snapshots`, `payment_period_snapshots`. Dashboard reads snapshots (fast, reproducible, historical).

**Snapshot semantics:** an Open Items report is the *complete list of open items as of a date*. Each import owns its `open_items` rows (`import_id`); "current" = latest completed import per data source (and per `as_of_date` for history). Payments are a rolling window that overlaps between imports → global per-org table with dedupe key. Re-importing the same as-of date creates a new import that **supersedes** the prior (kept, marked `superseded_by`).

## 6. DataSource abstraction

```ts
interface DataSource {
  id: string; kind: 'manual_upload' | 'sharepoint' | 'onedrive' | 'gdrive' | 'sftp' | 'email' | 'erp_api';
  // Produces immutable file payloads; never parses or interprets them.
  listAvailable(cursor?: string): Promise<SourceArtifact[]>;   // for pull sources
  fetch(artifact: SourceArtifact): Promise<ReadableStream>;    // → same upload pipeline
  health(): Promise<{ok: boolean; detail?: string}>;
}
```
MVP: `manual_upload` only. All future connectors *only deliver files* into step 1 of the pipeline, so mapping/validation/calc are untouched. ERP API connectors (SAP/NetSuite/Xero/QuickBooks) would instead emit **canonical records directly** through a `CanonicalIngest` port, skipping inspect/map (still validated). Credentials for sources live in an encrypted secrets table (envelope encryption, KMS key per environment; per-org DEK).

## 7. Deterministic calculation engine

`src/server/calc` — pure, synchronous, no I/O. Inputs: canonical open items, payments, customers, org config (`AgingConfig`, `RiskRules`, `TermMappings`, `Dimensions`, `WeekConfig`, `as_of_date`, `previous_snapshot?`). Outputs: typed metric objects. All money via `Decimal`. All dates are `YYYY-MM-DD` values and day arithmetic is `epochDay(a) − epochDay(b)` on UTC-midnight integers.

### 7.1 Definitions (v1, "calc_version": 1; changes bump the version and are recorded on each snapshot)

Let `asOf` = import's confirmed as-of date. An **open item** i has `amount` (signed: invoices +, credit notes/unapplied cash −) and `due_date` (may be derived; §7.2).

| Metric | Definition |
|---|---|
| `days_overdue(i)` | `max(0, asOf − due_date(i) − grace)` in whole days; `due_date` null ⇒ per policy (default: treated as not overdue **and** counted in `undated_items` warning) |
| `is_overdue(i)` | `days_overdue(i) ≥ 1` (due today = not overdue; matches reference R2) |
| **Total AR** | Σ `amount` over included open items (filters applied) |
| **Total Overdue** | Σ `amount` where `is_overdue` (credits that are overdue by date net against it, as in reference — **policy `credits_in_overdue: net|exclude`, Q4**) |
| **Current AR** | Total AR − Total Overdue |
| **Overdue %** | `Total Overdue / Total AR × 100` if Total AR > 0 else `null` (UI shows "Credit") |
| **Customer balance** | Σ `amount` by customer |
| **Overdue customers** | count of customers with customer overdue > 0 |
| **Customer count** | distinct customers with ≥1 included open item |
| **Aging bucket(i)** | first bucket whose `[from,to]` contains `days_overdue(i)`; bucket 0 = Current. Default config: Current, 1–7, 8–14, 15–30, 31–60, 61–90, 90+. Buckets are an ordered list in org config; must be contiguous and non-overlapping (validated) |
| **Aging mix** | bucket totals; negative totals reported as "Credits" instead of clamped |
| **Oldest due date** | min `due_date` of customer's open *debit* items |
| **Max days overdue** | max `days_overdue` of customer's items |
| **Payments (period)** | Σ `payment_sign_policy(amount)` of payments with `payment_date ∈ [start,end]` (default policy `abs`, per-profile) |
| **Week bounds** | week starts `week_start_day` (default Monday); `week(asOf, k)` = k weeks back |
| **Payments This Week** | week-to-date (`weekStart(asOf,0) … asOf`) |
| **Payments Last Week** | full previous week |
| **WoW change (default, like-for-like)** | `(thisWTD − lastWeekSameElapsedDays) / lastWeekSameElapsedDays`; alt `complete_weeks` mode compares last two complete weeks. Never divides by 0 → `null` |
| **Weekly Collection Rate** | payments in period ÷ opening Total AR of period (previous snapshot's Total AR); `null` if no previous snapshot |
| **Last payment** | max `payment_date` per customer (and amount of that payment; multiple same-day summed) |
| **Days since last payment** | `asOf − last_payment_date`; `null` ⇒ "none recorded" |
| **No payment in N days** | `last_payment` null OR days_since > N; UI shows the payment-data window `[min,max]` as caveat |
| **Balance change** | customer balance now − customer balance in previous snapshot **of the same data source**; `null` if none; |Δ| < ε (default 0.50) ⇒ "no change" |
| **Payment trend** | last-4-complete-weeks slope classification (up/flat/down) using configured thresholds; plus this-vs-last-week delta as in reference |
| **Risk (default rule)** | `balance > risk.balance_threshold AND overdue_pct > risk.overdue_pct_threshold` (defaults 10,000 & 50, per org). Rules are data: an ordered list of predicates over customer metrics (`all`/`any` of comparisons); each rule has id, label, severity. Customer `risk_flags[]` records which rule ids fired |
| **Top exposure** | customers ordered by balance desc, ties by customer id |
| **Credit balances** | customers with balance < 0 |
| **Balance increasing** | balance change > ε |
| **Collection recovery** | (deprecated name; see Weekly Collection Rate) |

### 7.2 Due-date policy (org config)
`missing_due_date_policy`: `treat_current` (reference behaviour) | `derive_from_terms` (`baseline_date + term_days`, baseline = document date | posting date | baseline date column) | `error`. Any derived/assumed date is flagged on the item (`due_date_source`) and counted in the dashboard's control notes.

### 7.3 Filters
Dimension/term/currency/data-source filters apply *before* aggregation. Payments are filtered by the customer's dimension/term membership (reference rule R26), defined explicitly: a payment belongs to a filter if its customer has ≥1 included open item matching the filter, *or* if the payment row carries the dimension itself.

### 7.4 Verification
- **Golden tests:** fixtures A/B/C → identical metrics JSON. A separate golden run replicates the reference implementation's numbers on a reference dataset (with the known defects toggled to "reference-compat" mode) so differences are intentional and documented.
- **Property tests:** Σ bucket totals = Total AR; Σ customer balances = Total AR; Σ dimension totals + unassigned = Total AR; overdue ≤ … invariants; permutation invariance of row order.
- **Reconciliation checks at import:** if the source file contains a control total/“Total” row, compare to Σ imported amount and raise a WARNING/ERROR on mismatch.
- Snapshots store `calc_version`, config hash, and input row counts so any number is reproducible.

## 8. AI layer (summary — detail in AI_EXTRACTION.md)

`AIProvider` interface with `analyzeWorkbook`, `detectReportType`, `suggestColumnMappings`, `explainCustomer`, `answerARQuestion`. Providers are adapters (OpenAI/Anthropic/Google/mock). Provider + model chosen per org/config, recorded on every `ai_runs` row. AI receives minimized, masked structural data; outputs are schema-validated; nothing AI-generated is authoritative for numbers. The Copilot uses a **tool layer** on the same read-models the UI uses, running under the caller's tenant context and role.

## 9. Security architecture

| Area | Design |
|---|---|
| Transport | HTTPS only, HSTS, TLS 1.2+; DB and storage connections TLS-required |
| At rest | Managed-DB disk encryption + object-store SSE (KMS); backups encrypted; field-level envelope encryption for data-source credentials and (optionally) `raw_row` JSON |
| AuthN | Argon2id, email verification, TOTP 2FA (mandatory for Owner/Admin — proposal), session rotation, short-lived sessions, device list, brute-force lockout |
| AuthZ | RBAC capabilities + RLS (§4); server-side checks in every action/handler/tool; IDs never trusted from client without org check |
| Uploads | Direct-to-storage presigned, size caps, MIME + magic-byte validation, malware scan, quarantine, hash, no execution of macros, isolated parse worker (no network egress, ulimits), CSV/formula-injection neutralisation on **export** (prefix `'` for `= + - @` cells) |
| File access | Private bucket; download only via authz-checked, ≤5-min signed URL; every download audited |
| AI config | Provider/API key/prompts managed in Admin → AI Settings (Owner/Admin only); key encrypted in `secrets`, write-only in UI, decrypted only in server/worker at call time; prompt edits versioned + eval-gated; guardrails (schema, masking, validation) live in code and cannot be edited from the UI; changes audited |
| Secrets | Env via secret manager (not repo); rotation runbook; separate keys per environment; AI API keys never reach client |
| Rate limiting | Per IP + per user + per org on auth, upload, AI, export, Copilot endpoints (token bucket in Postgres/Redis-compatible store) |
| AI data minimization | Structure + masked samples only; per-org toggle to disable AI (falls back to deterministic heuristics + manual mapping); provider zero-retention / DPA; redaction happens before the provider adapter is invoked (single choke point `prepareAIPayload()`) with unit tests asserting no raw customer names/IDs leak |
| Prompt injection | Cell contents are *data*, delimited and never treated as instructions; AI output is only ever parsed against a strict schema; tools are allow-listed; no tool can write, and no tool accepts free-form SQL; Copilot tool args validated (Zod) and re-authorised |
| Audit | Append-only `audit_logs` (who/what/when/where/before-after hash), no UPDATE/DELETE privilege for app role; covers login, role changes, uploads, downloads, mapping confirmations, import commit/override, exports, config changes, collection actions, AI runs, admin lineage views |
| Retention/deletion | Configurable retention per org; scheduled purge of files/snapshots; org deletion = soft-delete → grace period → cryptographic erase (delete DEK) + object purge; user-data-deletion requests handled by admin tooling; legal-hold flag |
| Backups/DR | PITR on Postgres, daily verified restore test, object-store versioning, documented RPO/RTO |
| App hardening | CSP (Next.js docs: `content-security-policy.md`), secure headers, CSRF protection for mutations (Server Actions origin checks + SameSite cookies), dependency audit + lockfile pinning in CI, SAST, secret scanning |
| Compliance posture | Design toward SOC 2 controls; Australian Privacy Principles/GDPR-aware (data residency Q1) |

## 10. Audit & lineage

Every canonical record carries: `organization_id`, `import_id`, `uploaded_file_id`, `source_sheet`, `source_row` (1-based Excel row), `imported_at`, and `raw` (original cell values as JSON). Lineage resolver (Admin only): 
`Dashboard number → (filter/metric definition + snapshot id) → contributing open_items/payments → import + source_sheet + source_row → uploaded file → (signed download)`. UI: "Explain this number" drawer on KPIs and table cells lists contributing rows (paged) and the definition/version used.

## 11. Performance & scale

Reference dataset ≈ 12k open items / 1.3k customers; target design point 500k open items/import, 50k customers. Streaming parse, COPY-based batch insert, indexes on `(organization_id, import_id, customer_id)`, `(… due_date)`. Dashboard reads pre-aggregated snapshots (O(buckets), O(customers)); "what-if as-of date" recomputes live from a single import's open items (sub-second at MVP scale, capped otherwise).

## 12. Environments & delivery

`local` (docker-compose: Postgres, MinIO, ClamAV, mock AI) · `staging` · `production`. CI: typecheck, lint, unit+golden, RLS leak tests (ephemeral Postgres), Playwright smoke, dependency audit. Migrations run pre-deploy; forward-only with expand/contract.

## 13. Key architectural decisions (ADR index — to be written as they are ratified)
1. Shared-schema multi-tenancy with RLS (vs schema-per-tenant / DB-per-tenant). *Revisit for enterprise tenants.*
2. Snapshot-per-import storage of open items; global payment ledger with dedupe.
3. Pure calc engine + materialised snapshots; calc_version pinning.
4. AI only at ingestion-time interpretation and read-only Q&A; never in numeric path.
5. Postgres-backed job queue for MVP.
6. Server-rendered app; no static export.
