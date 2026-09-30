# DATA_SCHEMA

Companion docs: [PLAN.md](PLAN.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [AI_EXTRACTION.md](AI_EXTRACTION.md)

Two schemas live here:
1. **Canonical schema** (`schema_version` 1.0) — the *interchange* format all company formats map into.
2. **Database schema** — Postgres tables (multi-tenant, RLS) that persist canonical records, config, snapshots, collections, AI and audit data.

---

## 1. Canonical schema v1.0

### 1.1 Design changes vs. the conceptual example
| Change | Reason |
|---|---|
| `customer_id` is the **source-system key** (string, never numeric; leading zeros preserved) | IDs like `0000905559` must not become numbers |
| `payment_term` stored as `{code, days, label}` where `days` is **optional/null** until mapped | Codes aren't universal; mapping is org config |
| Segmentation via `dimensions: { "<dimension_key>": "<value_key>" }` instead of `ledger` | Ledger 84/86/88 is one company's dimension; supports N dimensions |
| `amount` is a **decimal string** (`"2562.00"`) | No float drift across JSON |
| `open_items[].currency` **and** optional `amount_local`, `amount_foreign` | Real ERPs carry both; MVP uses one designated amount |
| Every record has `lineage: {sheet, row}` | Auditability |
| `document_type` + `is_credit` derived flag | Credit notes/unapplied cash handling (Q4) |
| Explicit `due_date_source` (`source \| derived \| missing`) | Transparency of assumptions |
| `payments[].sign_convention` resolved at normalization so canonical payments are **positive** = money received | Reference used `abs()`; make it explicit |
| `source.as_of_date` required (confirmed by user) | Reference inferred it from max posting date |
| `extraction` block records AI/profile provenance | Trust & debugging |
| Dates: ISO `YYYY-MM-DD`, no times/timezones | Avoid DST/off-by-one |
| Additional report types allowed in one workbook (`collection_actions`) | Import historical notes |
| `unmapped_columns` keeps ignored columns' names (not values) | Schema-drift detection |

### 1.2 Canonical JSON (illustrative, complete)

```jsonc
{
  "schema_version": "1.0",

  "source": {
    "file_name": "AR_Report.xlsx",
    "file_sha256": "…",
    "source_system": "SAP",                 // free text/enum: SAP|ORACLE|DYNAMICS|NETSUITE|XERO|MYOB|QUICKBOOKS|CUSTOM|UNKNOWN
    "report_types_present": ["OPEN_ITEMS", "PAYMENTS", "PAYMENT_TERMS"],
    "as_of_date": "2026-09-29",
    "as_of_date_source": "user_confirmed",   // detected_in_file | user_confirmed | filename | default_today
    "reporting_currency": "AUD",
    "profile": { "id": "…", "version": 3, "name": "SAP FBL5N Weekly Export" }
  },

  "customers": [
    {
      "customer_id": "905559",
      "customer_name": "SAI & SONS PTY LTD",
      "customer_name_2": "FOODWORKS CIVIC FAIR",
      "dimensions": { "ledger": "84" },            // keys = org business_dimensions.key
      "payment_term": { "code": "AR02", "days": 7 },
      "company_code": null,
      "business_area": null,
      "lineage": { "sheet": "FBL5N", "row": 12 }
    }
  ],

  "open_items": [
    {
      "customer_id": "905559",
      "document_number": "1900012345",
      "document_type": "RV",
      "document_date": "2026-08-20",
      "posting_date": "2026-08-20",
      "due_date": "2026-08-27",
      "due_date_source": "source",
      "amount": "2562.00",                          // reporting-currency, signed
      "currency": "AUD",
      "amount_foreign": null,
      "foreign_currency": null,
      "is_credit": false,
      "dimensions": { "ledger": "84" },
      "payment_term": { "code": "AR02", "days": 7 },
      "clearing_document": null,
      "reference": null,
      "text": null,
      "lineage": { "sheet": "FBL5N", "row": 12 }
    }
  ],

  "payments": [
    {
      "customer_id": "905559",
      "payment_date": "2026-09-23",
      "amount": "504.00",                           // positive = received
      "currency": "AUD",
      "document_number": null,
      "reference": null,
      "dimensions": {},
      "lineage": { "sheet": "Payments", "row": 3 }
    }
  ],

  "payment_term_mappings": [ { "code": "AR02", "days": 7, "label": "7 Days", "group": "7 Days" } ],
  "dimension_mappings":    [ { "dimension": "ledger", "match_on": "gl_account", "source_value": "1200-84", "value": "84" } ],
  "collection_actions":    [],

  "extraction": {
    "method": "profile",                           // profile | ai_suggested_confirmed | manual
    "ai_run_ids": ["…"],
    "confidence": 0.97,
    "warnings": [],
    "unmapped_columns": [ { "sheet": "FBL5N", "column": "User Name" } ],
    "unavailable_fields": ["clearing_document"]
  }
}
```

### 1.3 Field catalogue & requirements

**Open item** — required for import: `customer_id`, `amount`, and (`due_date` **or** derivable via `document_date/posting_date` + term days). Recommended: `document_number`, `currency`, `document_date`.
**Payment** — required: `customer_id`, `payment_date`, `amount`.
**Customer** — required: `customer_id`. Name strongly recommended (falls back to id, WARNING).
**Payment-term mapping** — `code`, `days`, optional `label/group`.

Canonical field ids used by AI/mapping UI (the *target vocabulary*):

```
customers:   customer_id, customer_name, customer_name_2, payment_term_code, company_code, business_area, <dimension:*>
open_items:  customer_id, customer_name, customer_name_2, document_number, document_type,
             document_date, posting_date, due_date, amount, currency, amount_foreign, foreign_currency,
             payment_term_code, clearing_document, reference, text, <dimension:*>, gl_account
payments:    customer_id, payment_date, amount, currency, document_number, reference, <dimension:*>
payment_terms: code, days, label
dimension_map: source_value, dimension_value
collection_actions: customer_id, action_type, action_date, notes, promise_to_pay_date, promise_to_pay_amount, next_follow_up, status
```
The vocabulary is versioned with `schema_version`; adding a field is minor, renaming is major.

### 1.4 Zod/JSON-Schema
Source of truth is a Zod definition in `src/lib/canonical/v1.ts`; JSON Schema is generated from it and used for (a) AI structured output, (b) fixture validation, (c) external API docs. Migration functions `v1→v2` are registered when schema changes; snapshots record the schema/calc versions used.

---

## 2. Database conventions

- Postgres 16, `uuid` PKs (UUIDv7 for locality), `created_at/updated_at timestamptz`, `deleted_at` where soft-delete applies (†).
- **Every tenant-owned table has `organization_id uuid NOT NULL`** with composite uniqueness `(organization_id, id)` so children FK to `(organization_id, parent_id)`.
- RLS enabled + forced on all tenant tables (ARCHITECTURE §4). Non-tenant tables: `users`, `organizations`, platform config.
- Money: `numeric(19,4)`. Dates: `date`. Codes/IDs: `text` (never numeric).
- `raw` payloads: `jsonb`. Enums implemented as `text` + `CHECK` (easier evolution than PG enums).
- Append-only tables (‡): `audit_logs`, `ai_runs`, `import_issues` — app role has no UPDATE/DELETE.

## 3. Entity summary

```
AI CONFIG      ai_settings · ai_prompts
PLATFORM        users · organizations† · organization_users · invitations
CONFIG (org)    business_dimensions · dimension_values · dimension_rules · payment_term_mappings
                aging_configs · risk_rules · org_settings
INGESTION       data_sources† · uploaded_files · import_profiles · import_profile_versions
                import_jobs · import_issues‡ · import_sheets
DATA            customers† · open_items · payments
SNAPSHOTS       ar_snapshots · customer_snapshots · aging_snapshots · payment_period_snapshots
COLLECTIONS     collection_actions† · customer_assignments · customer_notes†
AI              ai_sessions · ai_messages · ai_runs‡
GOVERNANCE      audit_logs‡ · secrets (encrypted) · export_jobs
```

## 4. Tables (DDL sketch)

> Sketch level: enough to review relationships/indexes. Final DDL is produced in Phase 2 migrations.

### 4.1 Platform

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY, email citext UNIQUE NOT NULL, name text,
  password_hash text, email_verified_at timestamptz, totp_secret_enc bytea,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
  reporting_currency char(3) NOT NULL DEFAULT 'AUD',
  timezone text NOT NULL DEFAULT 'Australia/Brisbane',
  plan text NOT NULL DEFAULT 'trial', retention_days int,
  ai_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE organization_users (
  organization_id uuid NOT NULL REFERENCES organizations, user_id uuid NOT NULL REFERENCES users,
  role text NOT NULL CHECK (role IN ('owner','admin','ar_manager','collector','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE invitations (id uuid PRIMARY KEY, organization_id uuid NOT NULL, email citext NOT NULL,
  role text NOT NULL, token_hash text NOT NULL, expires_at timestamptz NOT NULL, accepted_at timestamptz,
  invited_by uuid NOT NULL);
```
(`organization_users` is the RLS bootstrap table: readable per-user to resolve orgs; policy keyed on `user_id = current_setting('app.current_user')`.)

### 4.2 Configuration (per org)

```sql
CREATE TABLE business_dimensions (           -- e.g. key='ledger', label='Ledger'
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, key text NOT NULL, label text NOT NULL,
  source_field text,                          -- canonical field carrying the value (e.g. 'business_area', 'gl_account')
  sort_order int NOT NULL DEFAULT 0, is_primary boolean NOT NULL DEFAULT false,
  UNIQUE (organization_id, key), UNIQUE (organization_id, id)
);
CREATE TABLE dimension_values (              -- e.g. '84','86','88' | 'North','South'
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, dimension_id uuid NOT NULL,
  value text NOT NULL, label text, color text, sort_order int NOT NULL DEFAULT 0,
  UNIQUE (organization_id, dimension_id, value),
  FOREIGN KEY (organization_id, dimension_id) REFERENCES business_dimensions (organization_id, id)
);
CREATE TABLE dimension_rules (               -- derive dimension from another field (replaces tblLedgerMapping)
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, dimension_id uuid NOT NULL,
  match_field text NOT NULL, match_op text NOT NULL DEFAULT 'equals' CHECK (match_op IN ('equals','prefix','regex')),
  match_value text NOT NULL, dimension_value text NOT NULL, priority int NOT NULL DEFAULT 100
);
CREATE TABLE payment_term_mappings (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL,
  code text NOT NULL, days int NOT NULL CHECK (days >= 0), label text, group_label text, -- '7 Days'
  UNIQUE (organization_id, code)
);
CREATE TABLE aging_configs (                 -- one active per org, versioned
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, version int NOT NULL,
  buckets jsonb NOT NULL,                     -- [{key:'current',label:'Current',from:null,to:0},{key:'1_7',from:1,to:7},…,{key:'90p',from:91,to:null}]
  overdue_grace_days int NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, version)
);
CREATE TABLE risk_rules (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, key text NOT NULL, label text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','watch','high')),
  definition jsonb NOT NULL,                  -- {"all":[{"metric":"balance","op":">","value":10000},{"metric":"overdue_pct","op":">","value":50}]}
  is_active boolean NOT NULL DEFAULT true, UNIQUE (organization_id, key)
);
CREATE TABLE org_settings (                   -- policies from ARCHITECTURE §7
  organization_id uuid PRIMARY KEY,
  missing_due_date_policy text NOT NULL DEFAULT 'derive_from_terms',
  credits_in_overdue text NOT NULL DEFAULT 'net' CHECK (credits_in_overdue IN ('net','exclude')),
  week_start_day smallint NOT NULL DEFAULT 1, wow_mode text NOT NULL DEFAULT 'like_for_like',
  balance_change_epsilon numeric(19,4) NOT NULL DEFAULT 0.50,
  ui_thresholds jsonb NOT NULL DEFAULT '{"overdue_pct_amber":10,"last_payment_green_days":30,"last_payment_amber_days":60}'
);
```

### 4.3 Ingestion

```sql
CREATE TABLE data_sources (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, kind text NOT NULL DEFAULT 'manual_upload',
  name text NOT NULL, config jsonb NOT NULL DEFAULT '{}', secret_id uuid,
  status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (organization_id, id)
);

CREATE TABLE uploaded_files (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, data_source_id uuid NOT NULL,
  uploaded_by uuid REFERENCES users, original_name text NOT NULL, mime text, size_bytes bigint NOT NULL,
  sha256 text NOT NULL, storage_key text NOT NULL, scan_status text NOT NULL DEFAULT 'pending'
    CHECK (scan_status IN ('pending','clean','infected','failed')),
  created_at timestamptz NOT NULL DEFAULT now(), purge_after date, purged_at timestamptz,
  UNIQUE (organization_id, id), UNIQUE (organization_id, sha256)   -- same file ⇒ idempotent
);

CREATE TABLE import_profiles (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, data_source_id uuid,
  name text NOT NULL, source_system text, current_version int NOT NULL DEFAULT 1,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (organization_id, id), UNIQUE (organization_id, name)
);
CREATE TABLE import_profile_versions (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, profile_id uuid NOT NULL, version int NOT NULL,
  definition jsonb NOT NULL,      -- sheets[]: {match:{name_pattern,fingerprint}, report_type, header_row, skip_rows, footer_rule,
                                  --   column_mapping:{"Cust No.":"customer_id",…}, ignored:[…], unavailable:[…],
                                  --   parse:{date_format,decimal_sep,thousands_sep,negative_style,payment_sign}, as_of:{strategy,cell/regex}}
  fingerprint text NOT NULL,      -- hash of normalised sorted header set per sheet (drift detection)
  confirmed_by uuid NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, profile_id, version)
);

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, data_source_id uuid NOT NULL,
  uploaded_file_id uuid NOT NULL, profile_id uuid, profile_version int,
  status text NOT NULL,                        -- state machine, ARCHITECTURE §5
  as_of_date date, as_of_date_source text, reporting_currency char(3),
  workbook_profile jsonb,                      -- deterministic inspection output
  ai_analysis jsonb,                           -- validated AI suggestion (masked, no raw data)
  confirmed_mapping jsonb,                     -- what the human approved
  counts jsonb,                                -- {customers, open_items, payments, ...}
  superseded_by uuid, error text,
  started_at timestamptz, completed_at timestamptz, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE INDEX ON import_jobs (organization_id, data_source_id, as_of_date DESC) WHERE status = 'completed' AND superseded_by IS NULL;

CREATE TABLE import_sheets (                   -- per worksheet outcome
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, import_job_id uuid NOT NULL,
  sheet_name text NOT NULL, report_type text, report_type_confidence numeric(4,3),
  selected boolean NOT NULL DEFAULT false, header_row int, row_count int
);

CREATE TABLE import_issues (‡
  id bigserial PRIMARY KEY, organization_id uuid NOT NULL, import_job_id uuid NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO','WARNING','ERROR')),
  code text NOT NULL, message text NOT NULL, sheet_name text, source_row int, column_name text,
  details jsonb, overridden_by uuid, overridden_at timestamptz
);
CREATE INDEX ON import_issues (organization_id, import_job_id, severity);
```

### 4.4 Core data

```sql
CREATE TABLE customers (                       -- master, upserted across imports
  id uuid PRIMARY KEY, organization_id uuid NOT NULL,
  customer_key text NOT NULL,                  -- source customer_id, verbatim string
  name text NOT NULL, name_2 text, first_seen_import uuid, last_seen_import uuid,
  attributes jsonb NOT NULL DEFAULT '{}',      -- company_code, business_area, etc.
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (organization_id, customer_key), UNIQUE (organization_id, id)
);
CREATE INDEX ON customers USING gin (organization_id, name gin_trgm_ops);   -- search (btree_gin + pg_trgm)

CREATE TABLE open_items (                      -- snapshot rows: belong to ONE import
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, import_job_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  document_number text, document_type text, document_date date, posting_date date,
  due_date date, due_date_source text NOT NULL DEFAULT 'source',
  amount numeric(19,4) NOT NULL, currency char(3) NOT NULL, amount_foreign numeric(19,4), foreign_currency char(3),
  is_credit boolean NOT NULL, dimensions jsonb NOT NULL DEFAULT '{}',
  payment_term_code text, payment_term_days int,
  clearing_document text, reference text, text text,
  -- lineage
  uploaded_file_id uuid NOT NULL, source_sheet text NOT NULL, source_row int NOT NULL,
  raw jsonb, imported_at timestamptz NOT NULL DEFAULT now(),
  dup_key text NOT NULL,                       -- hash(customer, doc no, doc type, amount, due date) for duplicate detection
  FOREIGN KEY (organization_id, import_job_id) REFERENCES import_jobs (organization_id, id),
  FOREIGN KEY (organization_id, customer_id)   REFERENCES customers   (organization_id, id)
);
CREATE INDEX ON open_items (organization_id, import_job_id, customer_id);
CREATE INDEX ON open_items (organization_id, import_job_id, due_date);
CREATE INDEX ON open_items (organization_id, import_job_id, dup_key);
CREATE INDEX ON open_items USING gin (dimensions jsonb_path_ops);

CREATE TABLE payments (                        -- global rolling ledger with dedupe
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, customer_id uuid NOT NULL,
  data_source_id uuid NOT NULL, first_import_job_id uuid NOT NULL, last_import_job_id uuid NOT NULL,
  payment_date date NOT NULL, amount numeric(19,4) NOT NULL, currency char(3) NOT NULL,
  document_number text, reference text, dimensions jsonb NOT NULL DEFAULT '{}',
  dedupe_key text NOT NULL,   -- hash(data_source, customer, date, amount, document_number, occurrence_index)
  uploaded_file_id uuid NOT NULL, source_sheet text NOT NULL, source_row int NOT NULL, raw jsonb,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, dedupe_key)
);
CREATE INDEX ON payments (organization_id, customer_id, payment_date DESC);
CREATE INDEX ON payments (organization_id, payment_date);
```
`occurrence_index` disambiguates legitimately identical payments within the same file (two $504 payments on the same day) while remaining stable across re-exports (ordering by source row within identical keys).

### 4.5 Snapshots (calculation output; immutable once written)

```sql
CREATE TABLE ar_snapshots (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, import_job_id uuid NOT NULL, data_source_id uuid NOT NULL,
  as_of_date date NOT NULL, currency char(3) NOT NULL,
  calc_version int NOT NULL, config_hash text NOT NULL, config jsonb NOT NULL,   -- frozen aging/risk/policy used
  total_ar numeric(19,4) NOT NULL, total_overdue numeric(19,4) NOT NULL, current_ar numeric(19,4) NOT NULL,
  overdue_pct numeric(9,4), customer_count int NOT NULL, overdue_customer_count int NOT NULL,
  item_count int NOT NULL, undated_item_count int NOT NULL,
  payments_this_week numeric(19,4), payments_last_week numeric(19,4), wow_change_pct numeric(9,4),
  weekly_collection_rate numeric(9,4),
  by_dimension jsonb NOT NULL,    -- {"ledger":{"84":{balance,overdue,customers},…,"_unassigned":{…}}}
  by_term jsonb NOT NULL,         -- {"7 Days":{…},"Other / Unmapped":{…}}
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, import_job_id)
);
CREATE TABLE aging_snapshots (
  organization_id uuid NOT NULL, ar_snapshot_id uuid NOT NULL,
  scope_type text NOT NULL DEFAULT 'all',      -- all | dimension | term
  scope_key text NOT NULL DEFAULT '',          -- e.g. 'ledger=84'
  bucket_key text NOT NULL, amount numeric(19,4) NOT NULL, item_count int NOT NULL,
  PRIMARY KEY (ar_snapshot_id, scope_type, scope_key, bucket_key)
);
CREATE TABLE customer_snapshots (
  organization_id uuid NOT NULL, ar_snapshot_id uuid NOT NULL, customer_id uuid NOT NULL,
  dimensions jsonb NOT NULL, payment_terms text[] NOT NULL,
  balance numeric(19,4) NOT NULL, overdue numeric(19,4) NOT NULL, current_amount numeric(19,4) NOT NULL,
  overdue_pct numeric(9,4), oldest_due_date date, max_days_overdue int,
  last_payment_date date, last_payment_amount numeric(19,4), days_since_last_payment int,
  payments_this_week numeric(19,4), payments_last_week numeric(19,4),
  balance_change numeric(19,4), payment_trend text,       -- up|flat|down|null
  aging jsonb NOT NULL,                                   -- {bucket_key: amount}
  risk_flags text[] NOT NULL DEFAULT '{}', is_high_risk boolean NOT NULL DEFAULT false,
  open_item_count int NOT NULL,
  PRIMARY KEY (ar_snapshot_id, customer_id)
);
CREATE INDEX ON customer_snapshots (organization_id, ar_snapshot_id, balance DESC);
CREATE INDEX ON customer_snapshots (organization_id, ar_snapshot_id, overdue_pct DESC);
CREATE TABLE payment_period_snapshots (       -- weekly series for the 8-week trend; recomputed as payments arrive
  organization_id uuid NOT NULL, ar_snapshot_id uuid NOT NULL, week_start date NOT NULL,
  scope_type text NOT NULL DEFAULT 'all', scope_key text NOT NULL DEFAULT '',
  amount numeric(19,4) NOT NULL, payment_count int NOT NULL, is_complete boolean NOT NULL,
  PRIMARY KEY (ar_snapshot_id, week_start, scope_type, scope_key)
);
```
Dashboard reads for the "As-of Date" filter select **an existing snapshot** (a historical import). A "what-if" live recompute for arbitrary dates runs the calc engine against that import's `open_items` (not stored).

### 4.6 Collections

```sql
CREATE TABLE collection_actions (†
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, customer_id uuid NOT NULL, user_id uuid NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('phone_call','email','sms','meeting','promise_to_pay','dispute','escalation','other')),
  action_date date NOT NULL, notes text,
  promise_to_pay_date date, promise_to_pay_amount numeric(19,4),
  next_follow_up date, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','broken','cancelled','disputed')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id)
);
CREATE INDEX ON collection_actions (organization_id, customer_id, action_date DESC);
CREATE INDEX ON collection_actions (organization_id, next_follow_up) WHERE status = 'open';

CREATE TABLE customer_assignments (           -- "assigned collector"
  organization_id uuid NOT NULL, customer_id uuid NOT NULL, collector_user_id uuid NOT NULL,
  assigned_by uuid NOT NULL, assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, customer_id)
);
CREATE TABLE customer_notes (†
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, customer_id uuid NOT NULL, user_id uuid NOT NULL,
  body text NOT NULL, pinned boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
```
Collection data is *operational* and keyed on the stable `customers.id`, so it survives across imports and is never overwritten by re-imports.

### 4.7 AI

```sql
CREATE TABLE ai_settings (                     -- Admin → AI Settings. v1: exactly ONE platform-wide row (organization_id NULL); per-org rows reserved for later
  id uuid PRIMARY KEY, organization_id uuid UNIQUE NULL, enabled boolean NOT NULL DEFAULT false,
  provider text CHECK (provider IN ('openai','anthropic','google')), model text,
  api_key_secret_id uuid REFERENCES secrets,           -- encrypted; never returned by any API
  data_policy text NOT NULL DEFAULT 'structure_only' CHECK (data_policy IN ('off','structure_only','structure_plus_codes')),
  monthly_token_cap bigint, monthly_cost_cap_usd numeric(10,2),
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_prompts (                      -- versioned, editable instruction text
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, purpose text NOT NULL,   -- workbook_analysis|report_type|column_mapping|copilot|explain_customer
  version int NOT NULL, body text NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  test_result jsonb, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, purpose, version)
);
-- one active prompt per (org, purpose): CREATE UNIQUE INDEX ON ai_prompts (organization_id, purpose) WHERE status='active';

CREATE TABLE ai_runs (‡                        -- every provider call (extraction AND copilot)
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, purpose text NOT NULL,   -- workbook_analysis|report_type|column_mapping|copilot|explain_customer
  provider text NOT NULL, model text NOT NULL, prompt_version text NOT NULL,
  input_hash text NOT NULL, input_summary jsonb,        -- what categories/counts were sent (NOT the data)
  masking jsonb,                                         -- policy applied
  output jsonb, validation_ok boolean, tokens_in int, tokens_out int, cost_usd numeric(10,6), latency_ms int,
  import_job_id uuid, ai_session_id uuid, user_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_sessions (id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid NOT NULL,
  title text, scope jsonb NOT NULL,   -- {data_source_id, ar_snapshot_id}
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
CREATE TABLE ai_messages (id uuid PRIMARY KEY, organization_id uuid NOT NULL, ai_session_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content jsonb NOT NULL,             -- assistant: {calculated:[…refs to tool results…], interpretation:"…", unavailable:[…]}
  tool_name text, tool_args jsonb, tool_result_ref text, created_at timestamptz NOT NULL DEFAULT now());
```

### 4.8 Governance

```sql
CREATE TABLE audit_logs (‡
  id bigserial PRIMARY KEY, organization_id uuid, user_id uuid, at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,           -- 'import.commit','file.download','mapping.confirm','role.change','export.create',…
  entity_type text, entity_id text, ip inet, user_agent text,
  before_hash text, after_hash text, metadata jsonb NOT NULL DEFAULT '{}'   -- never contains financial row data
);
CREATE INDEX ON audit_logs (organization_id, at DESC); CREATE INDEX ON audit_logs (organization_id, entity_type, entity_id);
CREATE TABLE secrets (id uuid PRIMARY KEY, organization_id uuid NOT NULL, kind text NOT NULL, ciphertext bytea NOT NULL, key_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE export_jobs (id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid NOT NULL, kind text NOT NULL, params jsonb NOT NULL, storage_key text, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
```

## 5. Key relationships

```
organizations 1─* organization_users *─1 users
organizations 1─* data_sources 1─* uploaded_files 1─1 import_jobs ─* import_issues
import_profiles 1─* import_profile_versions ; import_jobs *─1 import_profiles(version)
import_jobs 1─* open_items *─1 customers ; import_jobs 1─1 ar_snapshots 1─* customer_snapshots
customers 1─* payments ; customers 1─* collection_actions ; customers 1─0..1 customer_assignments
open_items/payments ─► uploaded_files (+ source_sheet, source_row)   ← lineage
```

## 6. Validation rules catalogue

Severity default; `overridable` = Admin may override with reason (audited). Rules run over normalized records with source coordinates.

| Code | Rule | Default severity | Overridable |
|---|---|---|---|
| `REQ_FIELD_MISSING` | Required canonical field unmapped (customer_id, amount; due_date if no derivation) | ERROR | no |
| `SHEET_NOT_FOUND` | No sheet classified OPEN_ITEMS | ERROR | no |
| `LOW_CONFIDENCE_UNCONFIRMED` | AI/profile mapping below threshold not confirmed by human | ERROR | no |
| `SCHEMA_DRIFT` | Profile fingerprint mismatch not yet reviewed | ERROR | no |
| `CUSTOMER_ID_MISSING` | Row with amount but blank customer id | ERROR (row count > 0) | yes* |
| `AMOUNT_INVALID` | Non-numeric amount | ERROR | no |
| `DATE_INVALID` | Unparseable date; year outside 2000–2100 | WARNING (ERROR if due_date policy = error) | yes |
| `DUE_DATE_MISSING` | Missing due date | WARNING (per policy) | yes |
| `DUE_DATE_BEFORE_DOC_DATE` | due < document date | WARNING | yes |
| `FUTURE_DOC_DATE` | document/posting date > as-of + 1 day | WARNING | yes |
| `DUPLICATE_ROW` | Exact duplicate row (same dup_key & source values) | WARNING (ERROR if it would double a control total) | yes |
| `POTENTIAL_DUPLICATE_INVOICE` | Same customer+doc number, different rows | WARNING | yes |
| `NEGATIVE_BALANCE_CUSTOMER` | Customer total < 0 | INFO | — |
| `UNEXPECTED_NEGATIVE_ITEM` | Negative amount on doc type not known as credit | WARNING | yes |
| `CURRENCY_UNKNOWN` | Not ISO 4217 | ERROR | no |
| `CURRENCY_MIXED` | >1 currency in single-currency org | ERROR | yes (Q6) |
| `PAYMENT_TERM_UNMAPPED` | Term code without mapping | WARNING (routes to term-mapping step) | yes |
| `UNMAPPED_COLUMNS` | Columns ignored by mapping | INFO | — |
| `CLEARED_ITEM_IN_OPEN_LIST` | Row has clearing document | WARNING (excluded by default) | yes |
| `PAYMENT_INVALID` | Missing date/amount/customer on payment row | WARNING (row skipped; ERROR if > x%) | yes |
| `PAYMENT_CUSTOMER_UNKNOWN` | Payment customer not present in any open items or master | INFO | — |
| `CONTROL_TOTAL_MISMATCH` | Σ amounts ≠ file total row | ERROR | yes |
| `ROW_COUNT_ANOMALY` | Row count deviates > 30% from previous import | WARNING | — |
| `ASOF_DATE_MISSING` | As-of date unresolved | ERROR | no |
| `SUBTOTAL_ROW_DETECTED` | Row looks like subtotal/total | INFO (skipped) | — |

A rule set is versioned (`validation_version`) and results stored per import for reproducibility. ERRORs block `READY_TO_COMMIT`.

## 7. Indexing & performance notes
- All tenant indexes lead with `organization_id`.
- Partial index for "latest completed, non-superseded import per data source".
- `customer_snapshots` sorted-metric indexes power Top-N and insights lists without scanning items.
- pg_trgm for customer search; keyset pagination for tables (no OFFSET on large sets).
- Partition candidates when scale demands: `open_items` by `organization_id` hash, `audit_logs` by month.

## 8. Retention & deletion
- `uploaded_files.purge_after` per org retention; purge job deletes object, sets `purged_at`, keeps hash + metadata (lineage still shows "file purged").
- Org deletion: soft-delete (`deleted_at`) → 30-day grace → hard delete rows + crypto-erase DEK + purge objects; audit log retained per legal need.
- Soft-deleted (†) rows excluded by default views; never soft-delete financial snapshot data — retire via retention only.
