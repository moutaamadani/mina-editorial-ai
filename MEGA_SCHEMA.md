# MEGA Tables Architecture (MEGA-only, no flags)

This document defines the consolidated Supabase schema and **MEGA-only** persistence model built around three core tables:

* **`MEGA_CUSTOMERS`** — single Pass ID per customer; lifecycle, verification, billing defaults, and credit balance.
* **`MEGA_GENERATIONS`** — unified event/artifact ledger for sessions, generations, feedback, and credit transactions.
* **`MEGA_ADMIN`** — admin sessions/audit trails/config entries and profile mappings.

**Important:** In MEGA-only mode, the legacy tables (`customers`, `sessions`, `generations`, `feedback`, `credit_transactions`, legacy admin tables) are **not written**. The application writes exclusively to MEGA tables.

All columns use `mg_` prefixes to avoid quoting issues and keep naming consistent.

---

## 0) MEGA Core Rules

### 0.1 Pass ID rule (`mg_pass_id`)

`mg_pass_id` is the stable primary identifier for a customer across all systems.

Recommended deterministic mapping (stable across backfills and replays):

* If `shopify_customer_id` exists and is not `"anonymous"` → `pass:shopify:<shopify_customer_id>`
* Else if `user_id` exists → `pass:user:<user_id>`
* Else → `pass:anon:<uuid>` (generated once and persisted)

**Invariant:** Every record in `MEGA_GENERATIONS` and `MEGA_ADMIN` that references a user should link to a `mg_pass_id`.

---

### 0.2 Namespaced `mg_id` rule (prevents collisions)

All rows use a **namespaced primary key** so different record types never collide:

* Session row: `mg_id = "session:<session_id>"`
* Generation row: `mg_id = "generation:<generation_id>"`
* Feedback row: `mg_id = "feedback:<feedback_id>"`
* Credit transaction row: `mg_id = "credit_transaction:<txn_id>"`
* Admin audit row: `mg_id = "admin_audit:<audit_id>"`
* Admin session row: `mg_id = "admin_session:<session_hash>"`
* Runtime config row: `mg_id = "runtime_config:<runtime_id>"`
* App config row: `mg_id = "app_config:<key>"`

**Invariant:** `mg_record_type` must match the namespace prefix.

---

### 0.3 Permanent asset URLs rule (R2)

All stored URLs in MEGA must be **public non-expiring** URLs (e.g., your R2 public domain). Never store signed URLs.

---

### 0.4 Credits rule

Credits are written in **two places**:

* Append-only ledger: `MEGA_GENERATIONS` row with `mg_record_type="credit_transaction"` and `mg_delta`.
* Current balance: `MEGA_CUSTOMERS.mg_credits` updated to the latest balance.

This allows fast reads while preserving full reconciliation.

---

## 1) MEGA_CUSTOMERS

### Purpose

Single row per customer identity (Pass ID), used for:

* current credits balance
* billing defaults (auto-topup settings)
* verification flags
* lifecycle timestamps and soft-delete
* stable join key for all events/artifacts

### Table

| Column                              | Type          | Notes                                              |
| ----------------------------------- | ------------- | -------------------------------------------------- |
| `mg_pass_id`                        | `TEXT`        | **Primary key** (Pass ID).                         |
| `mg_shopify_customer_id`            | `TEXT`        | Shopify customer id (nullable).                    |
| `mg_user_id`                        | `UUID`        | Supabase auth user id if present.                  |
| `mg_email`                          | `TEXT`        | Primary contact email.                             |
| `mg_first_name`                     | `TEXT`        | Optional given name.                               |
| `mg_last_name`                      | `TEXT`        | Optional family name.                              |
| `mg_display_name`                   | `TEXT`        | Friendly name for UI.                              |
| `mg_locale`                         | `TEXT`        | BCP-47 locale (e.g., `en-US`).                     |
| `mg_timezone`                       | `TEXT`        | IANA timezone.                                     |
| `mg_marketing_opt_in`               | `BOOL`        | Marketing consent.                                 |
| `mg_product_updates_opt_in`         | `BOOL`        | Product-update consent.                            |
| `mg_credits`                        | `INT`         | **Current credit balance**.                        |
| `mg_expires_at`                     | `TIMESTAMPTZ` | Credit expiry timestamp.                           |
| `mg_last_active`                    | `TIMESTAMPTZ` | Last activity timestamp.                           |
| `mg_disabled`                       | `BOOL`        | Disable account.                                   |
| `mg_verified_email`                 | `BOOL`        | Email verification flag.                           |
| `mg_verified_google`                | `BOOL`        | Google login verification.                         |
| `mg_verified_apple`                 | `BOOL`        | Apple login verification.                          |
| `mg_verified_any`                   | `BOOL`        | True if any verification succeeded.                |
| `mg_verification_method`            | `TEXT`        | email/google/apple/manual.                         |
| `mg_verification_at`                | `TIMESTAMPTZ` | When verification occurred.                        |
| `mg_verification_keynumber`         | `TEXT`        | Keynumber/token issued for verification.           |
| `mg_topup_default_packs`            | `INT`         | Default Shopify top-up pack count (defaults to 3). |
| `mg_auto_topup_enabled`             | `BOOL`        | Auto top-up enabled.                               |
| `mg_auto_topup_monthly_limit_packs` | `INT`         | Monthly limit on auto top-ups.                     |
| `mg_last_topup_at`                  | `TIMESTAMPTZ` | Last successful top-up time.                       |
| `mg_topup_source`                   | `TEXT`        | shopify/manual/etc.                                |
| `mg_meta`                           | `JSONB`       | Flexible metadata bucket.                          |
| `mg_source_system`                  | `TEXT`        | Provenance (e.g., `legacy`, `api`).                |
| `mg_deleted_at`                     | `TIMESTAMPTZ` | Soft-delete marker.                                |
| `mg_created_at`                     | `TIMESTAMPTZ` | Row creation time.                                 |
| `mg_updated_at`                     | `TIMESTAMPTZ` | Last update time.                                  |

---

## 2) MEGA_GENERATIONS (Event / Artifact Ledger)

### Purpose

Single append-only ledger for:

* sessions (`mg_record_type="session"`)
* generations (`mg_record_type="generation"`)
* feedback/likes (`mg_record_type="feedback"`)
* credit transactions (`mg_record_type="credit_transaction"`)

### Table

| Column              | Type          | Notes                                                              |
| ------------------- | ------------- | ------------------------------------------------------------------ |
| `mg_id`             | `TEXT`        | **Primary key** (namespaced).                                      |
| `mg_record_type`    | `TEXT`        | `generation`, `session`, `feedback`, `credit_transaction`.         |
| `mg_pass_id`        | `TEXT`        | FK → `MEGA_CUSTOMERS.mg_pass_id`.                                  |
| `mg_session_id`     | `TEXT`        | Session identifier (UUID or legacy text).                          |
| `mg_generation_id`  | `TEXT`        | Generation id associated with feedback.                            |
| `mg_platform`       | `TEXT`        | Platform identifier (web/ios/etc.).                                |
| `mg_title`          | `TEXT`        | Session title.                                                     |
| `mg_type`           | `TEXT`        | Generation type (image/motion/text).                               |
| `mg_prompt`         | `TEXT`        | Prompt used (or user text for feedback).                           |
| `mg_output_url`     | `TEXT`        | Public non-expiring output URL (R2).                               |
| `mg_output_key`     | `TEXT`        | Storage key for the output.                                        |
| `mg_provider`       | `TEXT`        | Provider (openai/replicate/etc.).                                  |
| `mg_model`          | `TEXT`        | Model name/version.                                                |
| `mg_latency_ms`     | `INT`         | Latency.                                                           |
| `mg_input_chars`    | `INT`         | Input char count.                                                  |
| `mg_output_chars`   | `INT`         | Output char count.                                                 |
| `mg_input_tokens`   | `INT`         | Optional tokens in.                                                |
| `mg_output_tokens`  | `INT`         | Optional tokens out.                                               |
| `mg_content_type`   | `TEXT`        | text/image/video.                                                  |
| `mg_status`         | `TEXT`        | pending/succeeded/failed.                                          |
| `mg_error`          | `TEXT`        | Error details.                                                     |
| `mg_result_type`    | `TEXT`        | Feedback result type.                                              |
| `mg_comment`        | `TEXT`        | Feedback comment.                                                  |
| `mg_image_url`      | `TEXT`        | Feedback image URL (public).                                       |
| `mg_video_url`      | `TEXT`        | Feedback video URL (public).                                       |
| `mg_delta`          | `INT`         | Credit delta.                                                      |
| `mg_reason`         | `TEXT`        | Reason for credit change.                                          |
| `mg_source`         | `TEXT`        | Source for credit change.                                          |
| `mg_ref_type`       | `TEXT`        | Reference type for credit change.                                  |
| `mg_ref_id`         | `TEXT`        | Reference id for credit change.                                    |
| `mg_client_version` | `TEXT`        | Client version.                                                    |
| `mg_os`             | `TEXT`        | OS.                                                                |
| `mg_browser`        | `TEXT`        | Browser.                                                           |
| `mg_device`         | `TEXT`        | Device.                                                            |
| `mg_meta`           | `JSONB`       | Arbitrary metadata for the record.                                 |
| `mg_payload`        | `JSONB`       | **Raw legacy row / raw provider payload** (migration + debugging). |
| `mg_source_system`  | `TEXT`        | Provenance (legacy/api).                                           |
| `mg_deleted_at`     | `TIMESTAMPTZ` | Soft-delete marker.                                                |
| `mg_created_at`     | `TIMESTAMPTZ` | Creation time.                                                     |
| `mg_updated_at`     | `TIMESTAMPTZ` | Last update time.                                                  |

### Required `mg_id` shapes by `mg_record_type`

* `session` → `session:<session_id>`
* `generation` → `generation:<generation_id>`
* `feedback` → `feedback:<feedback_id>`
* `credit_transaction` → `credit_transaction:<txn_id>`

---

## 3) MEGA_ADMIN

### Purpose

Unified admin table for:

* admin sessions (`mg_record_type="admin_session"`)
* admin audits (`mg_record_type="admin_audit"`)
* profile mappings (`mg_record_type="profile"`)
* runtime config mirror (`mg_record_type="runtime_config"`)
* app config mirror (`mg_record_type="app_config"`)

### Table

| Column                   | Type          | Notes                                                                      |
| ------------------------ | ------------- | -------------------------------------------------------------------------- |
| `mg_id`                  | `TEXT`        | **Primary key** (namespaced).                                              |
| `mg_record_type`         | `TEXT`        | `admin_session`, `admin_audit`, `profile`, `runtime_config`, `app_config`. |
| `mg_actor_pass_id`       | `TEXT`        | Optional FK → `MEGA_CUSTOMERS.mg_pass_id` for “customer acted on”.         |
| `mg_session_hash`        | `TEXT`        | Admin session hash.                                                        |
| `mg_user_id`             | `UUID`        | Admin auth user id.                                                        |
| `mg_email`               | `TEXT`        | Admin email.                                                               |
| `mg_ip`                  | `TEXT`        | IP captured.                                                               |
| `mg_user_agent`          | `TEXT`        | UA captured.                                                               |
| `mg_first_seen_at`       | `TIMESTAMPTZ` | First seen timestamp.                                                      |
| `mg_last_seen_at`        | `TIMESTAMPTZ` | Last seen timestamp.                                                       |
| `mg_profile_id`          | `UUID`        | Legacy profile id reference.                                               |
| `mg_shopify_customer_id` | `TEXT`        | Shopify id stored in profile mapping.                                      |
| `mg_action`              | `TEXT`        | Admin action.                                                              |
| `mg_route`               | `TEXT`        | Route accessed.                                                            |
| `mg_method`              | `TEXT`        | HTTP method.                                                               |
| `mg_status`              | `INT`         | HTTP status code.                                                          |
| `mg_detail`              | `JSONB`       | Audit detail.                                                              |
| `mg_runtime_id`          | `INT`         | Runtime config id (e.g., 1).                                               |
| `mg_runtime_flat`        | `JSONB`       | Flattened runtime knobs.                                                   |
| `mg_key`                 | `TEXT`        | App config key.                                                            |
| `mg_value`               | `JSONB`       | App config value.                                                          |
| `mg_meta`                | `JSONB`       | Flexible metadata.                                                         |
| `mg_payload`             | `JSONB`       | Raw legacy row / raw config payload (optional).                            |
| `mg_source_system`       | `TEXT`        | Provenance (legacy/api).                                                   |
| `mg_deleted_at`          | `TIMESTAMPTZ` | Soft-delete marker.                                                        |
| `mg_created_at`          | `TIMESTAMPTZ` | Creation time.                                                             |
| `mg_updated_at`          | `TIMESTAMPTZ` | Last update time.                                                          |

### Required `mg_id` shapes by `mg_record_type`

* `admin_session` → `admin_session:<session_hash>`
* `admin_audit` → `admin_audit:<audit_id>`
* `profile` → `profile:<profile_id>`
* `runtime_config` → `runtime_config:<runtime_id>`
* `app_config` → `app_config:<key>`

---

## 4) Integration Steps (MEGA-only)

### Step 1 — Create tables

Run `supabase/mega_tables.sql` in Supabase SQL editor (or CLI).

### Step 2 — Backfill (one-time)

Backfill legacy data into MEGA (no legacy writes after cutover):

* Insert customers into `MEGA_CUSTOMERS` using the Pass ID rule.
* Insert sessions/generations/feedback/credit_transactions into `MEGA_GENERATIONS` using the namespaced `mg_id`.
* Insert admin audit/admin sessions/profiles/runtime_config/app_config into `MEGA_ADMIN` using the namespaced `mg_id`.
* Store the full legacy row (or provider payload) into `mg_payload` during backfill.

### Step 3 — MEGA-only writes in API (no feature flags)

Replace all legacy DB writes with MEGA writes:

* Customer ensure → upsert `MEGA_CUSTOMERS` (returns `mg_pass_id`)
* Session upsert → insert `MEGA_GENERATIONS` (`mg_record_type="session"`)
* Generation upsert → insert `MEGA_GENERATIONS` (`mg_record_type="generation"`)
* Feedback insert → insert `MEGA_GENERATIONS` (`mg_record_type="feedback"`)
* Credit txn insert → insert `MEGA_GENERATIONS` (`mg_record_type="credit_transaction"`) **and** update `MEGA_CUSTOMERS.mg_credits`
* Admin audit → insert `MEGA_ADMIN` (`mg_record_type="admin_audit"`)
* Admin session → upsert `MEGA_ADMIN` (`mg_record_type="admin_session"`)
* Runtime/app config → upsert `MEGA_ADMIN` (`mg_record_type="runtime_config"` / `app_config`)

### Step 4 — Parity checks (admin endpoint or script)

* counts by day and record_type
* sample compare (random 100 ids) vs legacy snapshot (if kept)
* credits reconciliation (ledger sum vs `MEGA_CUSTOMERS.mg_credits`)

### Step 5 — Cutover reads (MEGA-only)

* Read history/profile/likes from MEGA
* Compute credits from `MEGA_CUSTOMERS.mg_credits` (reconcile against ledger periodically)

---

## 5) Execution

Run the schema script:

```bash
# With Supabase CLI authenticated and project linked
supabase db push --file supabase/mega_tables.sql

# Or directly against Postgres/Supabase via psql
psql "$SUPABASE_CONNECTION_STRING" -f supabase/mega_tables.sql
```

The script should be idempotent (`CREATE TABLE IF NOT EXISTS`) and add indexes/constraints for:

* `mg_pass_id` lookups
* `mg_record_type` validation
* `mg_created_at` / `mg_session_id` / `mg_generation_id` query performance

