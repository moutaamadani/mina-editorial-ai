# MEGA Tables Architecture — MEGA-only + MMA (no flags)

**File:** `MEGA_MMA.md`  
**Date:** 2025-12-19 (Asia/Dubai)  
**Scope:** Consolidated Supabase schema + MEGA-only persistence model extended to support **Mina Mind API (MMA)** **without introducing new tables**.  
**Tables remain exactly three:**
- **`MEGA_CUSTOMERS`** — one row per Pass ID (credits + verification + billing + **MMA preference snapshot**)
- **`MEGA_GENERATIONS`** — append-only unified ledger (sessions, generations, feedback, credit txns, **MMA steps**, **MMA events**)
- **`MEGA_ADMIN`** — admin sessions/audits/config/profile mappings

**Important:** In MEGA-only mode, legacy tables (`customers`, `sessions`, `generations`, `feedback`, `credit_transactions`, legacy admin tables) are **not written**. The application writes exclusively to MEGA tables.

All columns use `mg_` prefixes to avoid quoting issues and keep naming consistent.

---

## 0) MEGA Core Rules

### 0.1 Pass ID rule (`mg_pass_id`)

`mg_pass_id` is the stable primary identifier for a customer across all systems.

Recommended deterministic mapping (stable across backfills and replays):

- If `shopify_customer_id` exists and is not `"anonymous"` → `pass:shopify:<shopify_customer_id>`
- Else if `user_id` exists → `pass:user:<user_id>`
- Else → `pass:anon:<uuid>` (generated once and persisted)

**Invariant:** Every record in `MEGA_GENERATIONS` and `MEGA_ADMIN` that references a user must link to a `mg_pass_id`.

---

### 0.2 Namespaced `mg_id` rule (prevents collisions)

All rows use a **namespaced primary key** so different record types never collide:

- Session row: `mg_id = "session:<session_id>"`
- Generation row: `mg_id = "generation:<generation_id>"`
- Feedback row: `mg_id = "feedback:<feedback_id>"`
- Credit transaction row: `mg_id = "credit_transaction:<txn_id>"`
- Admin audit row: `mg_id = "admin_audit:<audit_id>"`
- Admin session row: `mg_id = "admin_session:<session_hash>"`
- Runtime config row: `mg_id = "runtime_config:<runtime_id>"`
- App config row: `mg_id = "app_config:<key>"`

**MMA additions (still MEGA-only):**
- MMA step row: `mg_id = "mma_step:<generation_id>:<step_no>"`
- MMA event row: `mg_id = "mma_event:<event_id>"`

**Invariant:** `mg_record_type` must match the namespace prefix.

---

### 0.3 Permanent asset URLs rule (R2)

All stored URLs in MEGA must be **public non-expiring** URLs (e.g., your R2 public domain). Never store signed URLs.

---

### 0.4 Credits rule

Credits are written in **two places**:

- Append-only ledger: `MEGA_GENERATIONS` row with `mg_record_type="credit_transaction"` and `mg_delta`.
- Current balance: `MEGA_CUSTOMERS.mg_credits` updated to the latest balance.

This allows fast reads while preserving full reconciliation.

---

### 0.5 MMA persistence rule (MEGA-only)

MMA writes exclusively to MEGA tables:

- **Final artifact** (still/video) is stored as `MEGA_GENERATIONS` row with `mg_record_type="generation"`.
- **Every MMA pipeline stage** is stored as `MEGA_GENERATIONS` row with `mg_record_type="mma_step"`.
- **Every user interaction** (like/dislike/download/preference_set/feedback/tweak) is stored as `MEGA_GENERATIONS` row with `mg_record_type="mma_event"`.
- **Current learned preference snapshot** is stored on the customer row in `MEGA_CUSTOMERS.mg_mma_preferences` (JSONB) for fast reads.

---

## 1) MEGA_CUSTOMERS

### Purpose

Single row per customer identity (Pass ID), used for:

- current credits balance
- billing defaults (auto-topup settings)
- verification flags
- lifecycle timestamps and soft-delete
- stable join key for all events/artifacts
- **MMA preference snapshot** for personalization (hard blocks + weights)

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
| `mg_mma_preferences`                | `JSONB`       | **MMA preference snapshot** (hard blocks + weights). |
| `mg_mma_preferences_updated_at`     | `TIMESTAMPTZ` | Snapshot write time.                               |

### `mg_mma_preferences` shape (recommended)

```json
{
  "hard_blocks": ["motion.light_flicker", "motion.light_flare"],
  "tag_weights": {
    "style.minimal": 1.8,
    "style.editorial_still_life": 1.4,
    "motion.light_flicker": -999
  },
  "updated_at": "2025-12-19T10:00:00Z",
  "source": "mma"
}
```

---

## 2) MEGA_GENERATIONS (Event / Artifact Ledger)

### Purpose

Single append-only ledger for:

- sessions (`mg_record_type="session"`)
- generations (`mg_record_type="generation"`)
- feedback/likes (`mg_record_type="feedback"`)
- credit transactions (`mg_record_type="credit_transaction"`)
- **MMA pipeline steps** (`mg_record_type="mma_step"`)
- **MMA interaction events** (`mg_record_type="mma_event"`)

### Table

| Column              | Type          | Notes                                                              |
| ------------------- | ------------- | ------------------------------------------------------------------ |
| `mg_id`             | `TEXT`        | **Primary key** (namespaced).                                      |
| `mg_record_type`    | `TEXT`        | `generation`, `session`, `feedback`, `credit_transaction`, `mma_step`, `mma_event`. |
| `mg_pass_id`        | `TEXT`        | FK → `MEGA_CUSTOMERS.mg_pass_id`.                                  |
| `mg_session_id`     | `TEXT`        | Session identifier (UUID or legacy text).                          |
| `mg_generation_id`  | `TEXT`        | Generation id associated with feedback/steps/events.               |
| `mg_parent_id`      | `TEXT`        | For `mma_step`: `generation:<generation_id>`                       |
| `mg_step_no`        | `INT`         | For `mma_step` only (0..N).                                        |
| `mg_step_type`      | `TEXT`        | For `mma_step` only (scan_product/gpt_reader/seedream_generate/etc). |
| `mg_platform`       | `TEXT`        | Platform identifier (web/ios/etc.).                                |
| `mg_title`          | `TEXT`        | Session title.                                                     |
| `mg_type`           | `TEXT`        | Generation type (image/motion/text).                               |
| `mg_prompt`         | `TEXT`        | Prompt used (or user text for feedback).                           |
| `mg_output_url`     | `TEXT`        | Public non-expiring output URL (R2).                               |
| `mg_output_key`     | `TEXT`        | Storage key for the output.                                        |
| `mg_provider`       | `TEXT`        | Provider (openai/replicate/seedream/kling/etc.).                   |
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
| `mg_mma_mode`       | `TEXT`        | `still` or `video` (generation + steps).                           |
| `mg_mma_status`     | `TEXT`        | `queued/scanning/prompting/generating/postscan/done/error`         |
| `mg_mma_vars`       | `JSONB`       | **Canonical MMA variable map** (store on `generation` row).        |

### Required `mg_id` shapes by `mg_record_type`

- `session` → `session:<session_id>`
- `generation` → `generation:<generation_id>`
- `feedback` → `feedback:<feedback_id>`
- `credit_transaction` → `credit_transaction:<txn_id>`
- `mma_step` → `mma_step:<generation_id>:<step_no>`
- `mma_event` → `mma_event:<event_id>`

### MMA invariants (enforced by code; optional DB CHECK)

For `mg_record_type="mma_step"`:
- `mg_generation_id` is required
- `mg_parent_id` must be `generation:<mg_generation_id>`
- `mg_step_no` and `mg_step_type` required
- step input/output must be stored in `mg_payload` (or `mg_meta`) in a consistent shape

For `mg_record_type="mma_event"`:
- `mg_pass_id` required
- `mg_meta.event_type` required (`like/dislike/download/preference_set/create/tweak/feedback`)
- if the event targets a generation, set `mg_generation_id`

---

## 3) MEGA_ADMIN

### Purpose

Unified admin table for:

- admin sessions (`mg_record_type="admin_session"`)
- admin audits (`mg_record_type="admin_audit"`)
- profile mappings (`mg_record_type="profile"`)
- runtime config mirror (`mg_record_type="runtime_config"`)
- app config mirror (`mg_record_type="app_config"`)

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

- `admin_session` → `admin_session:<session_hash>`
- `admin_audit` → `admin_audit:<audit_id>`
- `profile` → `profile:<profile_id>`
- `runtime_config` → `runtime_config:<runtime_id>`
- `app_config` → `app_config:<key>`

---

## 4) Integration Steps (MEGA-only)

### Step 1 — Create tables

Run `supabase/mega_tables.sql` in Supabase SQL editor (or CLI).

### Step 2 — Backfill (one-time)

Backfill legacy data into MEGA (no legacy writes after cutover):

- Insert customers into `MEGA_CUSTOMERS` using the Pass ID rule.
- Insert sessions/generations/feedback/credit_transactions into `MEGA_GENERATIONS` using the namespaced `mg_id`.
- Insert admin audit/admin sessions/profiles/runtime_config/app_config into `MEGA_ADMIN` using the namespaced `mg_id`.
- Store the full legacy row (or provider payload) into `mg_payload` during backfill.

### Step 3 — MEGA-only writes in API (no feature flags)

Replace all legacy DB writes with MEGA writes:

- Customer ensure → upsert `MEGA_CUSTOMERS` (returns `mg_pass_id`)
- Session upsert → insert `MEGA_GENERATIONS` (`mg_record_type="session"`)
- Generation upsert → insert `MEGA_GENERATIONS` (`mg_record_type="generation"`)
- Feedback insert → insert `MEGA_GENERATIONS` (`mg_record_type="feedback"`)
- Credit txn insert → insert `MEGA_GENERATIONS` (`mg_record_type="credit_transaction"`) **and** update `MEGA_CUSTOMERS.mg_credits`
- Admin audit → insert `MEGA_ADMIN` (`mg_record_type="admin_audit"`)
- Admin session → upsert `MEGA_ADMIN` (`mg_record_type="admin_session"`)
- Runtime/app config → upsert `MEGA_ADMIN` (`mg_record_type="runtime_config"` / `app_config`)

### Step 4 — Parity checks (admin endpoint or script)

- counts by day and record_type
- sample compare (random 100 ids) vs legacy snapshot (if kept)
- credits reconciliation (ledger sum vs `MEGA_CUSTOMERS.mg_credits`)

### Step 5 — Cutover reads (MEGA-only)

- Read history/profile/likes from MEGA
- Compute credits from `MEGA_CUSTOMERS.mg_credits` (reconcile against ledger periodically)

---

## 5) MMA Integration (MEGA-only, no new tables)

### 5.1 Still creation (Seedream)
**Writes:**
1) Insert **generation row**:
- `mg_id = "generation:<generation_id>"`
- `mg_record_type="generation"`
- `mg_type="image"` (or `"still"`)
- `mg_provider="seedream"`
- `mg_prompt` = final clean prompt
- `mg_output_url` = final output image URL (public R2)
- `mg_mma_mode="still"`
- `mg_mma_status="done"` (or intermediate statuses during run)
- `mg_mma_vars` = **full MMA variable map** (assets, scans, prompts, userMessages, settings, outputs)

2) Insert **mma_step rows** (0..N):
- `mg_id = "mma_step:<generation_id>:<step_no>"`
- `mg_record_type="mma_step"`
- `mg_generation_id="<generation_id>"`
- `mg_parent_id="generation:<generation_id>"`
- `mg_step_no=<step_no>`
- `mg_step_type="scan_product" | "scan_logo" | "scan_inspiration" | "like_history" | "gpt_reader" | "seedream_generate" | "postscan"`
- Put step input/output + timings into `mg_payload` (recommended) or `mg_meta`

**Recommended `mg_payload` shape for `mma_step`:**
```json
{
  "input": { "assets": {}, "inputs": {}, "history": {} },
  "output": { "crt": "...", "userMessage": "...", "prompt": "..." },
  "timing": { "started_at": "...", "ended_at": "...", "duration_ms": 1234 },
  "error": null
}
```

### 5.2 Still tweak (feedback loop)
- Insert a new `mma_event` describing feedback
- Insert a series of `mma_step` rows for feedback prompt → generation → postscan
- Insert a new **generation row** (recommended) OR update prior generation depending on your UX
  - Preferred: new generation id per tweak so history is immutable

### 5.3 Video animate (Kling)
Same pattern as still:
- Generation row: `mg_type="motion"` / `mg_provider="kling"` / `mg_mma_mode="video"`
- Steps: scan still → motion suggestion or reader2 → kling generate

### 5.4 Likes / dislikes / downloads / preference_set
Insert as **mma_event** records:

- `mg_id="mma_event:<event_id>"`
- `mg_record_type="mma_event"`
- `mg_pass_id`
- optional `mg_generation_id`
- `mg_meta.event_type` required: `like | dislike | download | preference_set | create | tweak | feedback`
- `mg_meta.payload` carries UI context

Then update the **customer snapshot**:
- `MEGA_CUSTOMERS.mg_mma_preferences` (hard blocks + weights)
- `MEGA_CUSTOMERS.mg_mma_preferences_updated_at = now()`

---

## 6) Frontend read/write patterns (how to “call it”)

### 6.1 Create still/video (write)
Frontend calls your API; your API writes MEGA rows as described above.

Minimum required for frontend:
- generation id
- status transitions (SSE or polling)
- final output URL

### 6.2 Load “My generations” (read)
Query:
- `MEGA_GENERATIONS`
- filter: `mg_pass_id = <current_user_pass_id> AND mg_record_type='generation'`
- order: `mg_created_at DESC`

Use:
- `mg_output_url` to show image/video
- `mg_prompt` (optional “advanced”)
- `mg_mma_vars.userMessages.scan_lines[]` to replay loading lines if user refreshes
- `mg_mma_vars.scans.*` to show “what MMA understood”

### 6.3 Load audit trail (admin/dev) (read)
Query:
- `MEGA_GENERATIONS`
- filter: `mg_record_type='mma_step' AND mg_generation_id=<id>`
- order: `mg_step_no ASC`

### 6.4 Like/dislike/download (write)
Write `mma_event` row with `mg_meta.event_type`, then let backend update `mg_mma_preferences` snapshot.

---

## 7) Schema patch SQL (idempotent)
Create a migration file: `supabase/mega_mma_patch.sql`

```sql
-- =========================================================
-- MEGA-only MMA Patch (3 tables only)
-- Date: 2025-12-19
-- =========================================================

-- 1) MEGA_CUSTOMERS: preference snapshot
alter table if exists public.mega_customers
  add column if not exists mg_mma_preferences jsonb not null default '{}'::jsonb,
  add column if not exists mg_mma_preferences_updated_at timestamptz;

create index if not exists mega_customers_mma_preferences_gin
  on public.mega_customers using gin (mg_mma_preferences);

-- 2) MEGA_GENERATIONS: support mma_step + mma_event + mma vars on generation
alter table if exists public.mega_generations
  add column if not exists mg_parent_id text,
  add column if not exists mg_step_no int,
  add column if not exists mg_step_type text,
  add column if not exists mg_mma_mode text,
  add column if not exists mg_mma_status text,
  add column if not exists mg_mma_vars jsonb not null default '{}'::jsonb;

-- Helpful indexes (fast history + per-generation audit)
create index if not exists mega_generations_generation_recordtype_stepno
  on public.mega_generations (mg_generation_id, mg_record_type, mg_step_no);

create index if not exists mega_generations_pass_recordtype_created
  on public.mega_generations (mg_pass_id, mg_record_type, mg_created_at desc);

create index if not exists mega_generations_mma_vars_gin
  on public.mega_generations using gin (mg_mma_vars);

-- Optional constraint: enforce required fields for mma_step rows
do $$
begin
  begin
    alter table public.mega_generations
      add constraint mega_generations_mma_step_requires_fields
      check (
        mg_record_type <> 'mma_step'
        or (
          mg_step_no is not null
          and mg_step_type is not null
          and mg_parent_id like 'generation:%'
          and mg_generation_id is not null
        )
      );
  exception when duplicate_object then
    null;
  end;
end$$;
```

---

## 8) Execution

```bash
# With Supabase CLI authenticated and project linked
supabase db push --file supabase/mega_mma_patch.sql

# Or directly against Postgres/Supabase via psql
psql "$SUPABASE_CONNECTION_STRING" -f supabase/mega_mma_patch.sql
```

---

## 9) Quick sanity queries

### 9.1 Latest generations for a user
```sql
select mg_id, mg_created_at, mg_type, mg_provider, mg_output_url, mg_mma_mode, mg_mma_status
from public.mega_generations
where mg_pass_id = $1
  and mg_record_type = 'generation'
order by mg_created_at desc
limit 50;
```

### 9.2 MMA steps for a generation
```sql
select mg_step_no, mg_step_type, mg_created_at, mg_payload
from public.mega_generations
where mg_record_type='mma_step'
  and mg_generation_id = $1
order by mg_step_no asc;
```

### 9.3 MMA events for a user (likes/dislikes/etc.)
```sql
select mg_created_at, mg_meta
from public.mega_generations
where mg_pass_id = $1
  and mg_record_type='mma_event'
order by mg_created_at desc
limit 100;
```

### 9.4 Credit reconciliation (ledger sum vs current)
```sql
select
  c.mg_pass_id,
  c.mg_credits as current_credits,
  coalesce(sum(g.mg_delta), 0) as ledger_sum
from public.mega_customers c
left join public.mega_generations g
  on g.mg_pass_id = c.mg_pass_id
 and g.mg_record_type = 'credit_transaction'
where c.mg_pass_id = $1
group by c.mg_pass_id, c.mg_credits;
```

