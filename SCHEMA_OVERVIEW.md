# Database table creation paths and duplication risks

## Where tables are defined

- **Supabase core schema (`supabase/schema.sql`)** now defines all application tables so everything is created directly in Supabase (no Prisma). It covers:
  - `customers` (Shopify customer record, credits, metadata, timestamps, disabled flag, optional expiry).
  - `credit_transactions` (per-customer deltas with reason/source and optional refs).
  - `sessions` (UUID key, Shopify customer linkage, platform/title, timestamps).
  - `generations` (text ID, session/customer linkage, prompt/output fields, provider/model/metrics, meta JSON).
  - `feedback` (UUID key tied to Shopify customer + optional session/generation, prompt/comment/media fields, timestamps).
  - `runtime_config` (row id=1 storing flattened knobs for models/credits/prompts with `updated_by`).
  - `app_config` (key/value JSON store for runtime overrides).
  - `profiles` (user_id/email/shopify_customer_id mapping with timestamps).

- **Supabase bootstrap SQL (`supabase/admin_audit_sessions.sql`)** creates admin-only tables and keeps `generations` observability columns in sync:
  - `admin_sessions` for admin login tracking (`session_hash`, optional `user_id`/`email`, IP, user agent, and timestamps).
  - `admin_audit` for admin route auditing (`id`, `action`, `route`, `method`, `status`, optional `user_id`/`email`, details JSON, timestamp indexes).
  - Adds `model`, `provider`, `latency_ms`, `input_chars`, `output_chars`, and `meta` columns to `generations` if they are missing.

## Potential duplication and cleanup targets

- **Admin allowlist tables:** The code only uses environment variables to allowlist admins; it never queries a table. Both `admin_allowlist` and `mina_admin_allowlist` appear in the Supabase dashboard but have no references in the codebase, so they are candidates for removal.

- **Runtime config tables:** Only `runtime_config` is read/written in code. Tables named `runtime_config_flat` and `mina_runtime_config` are unused and look like obsolete variants that can be cleaned up.

- **Profile tables:** The code upserts into `profiles` via Supabase admin APIs. A `users_profile` table exists in the dashboard but is never referenced in the codebase, so it is likely redundant.

- **Feedback table naming:** Runtime Supabase calls use `feedback` (singular). Ensure any unused variant (`feedbacks`) is dropped after confirming production data location.

## Summary

Supabase SQL files now own table creation for both business data and admin auditing. Remove unused Supabase tables (allowlist variants, runtime config variants, profile variants, extra feedback table) once production data is verified to be absent.
