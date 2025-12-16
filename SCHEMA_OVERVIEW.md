# Database table creation paths and duplication risks

## Where tables are defined

- **Prisma schema (`prisma/schema.prisma`)** defines the core product tables and column shapes for:
  - `customer_credits` with `customer_id`, `balance`, and timestamps.
  - `auto_topup_settings` with `customer_id`, `enabled`, `monthly_limit_packs`, and timestamps.
  - `sessions` keyed by `id` and linked to `customer_id`, plus `platform`, `title`, and timestamps.
  - `generations` keyed by `id` with `type`, `session_id`, `customer_id`, `platform`, `prompt`, `output_url`, `meta`, and timestamps.
  - `feedbacks` keyed by `id` with optional `session_id` / `generation_id`, `customer_id`, `result_type`, media URLs, and timestamps.

- **Supabase bootstrap SQL (`supabase/admin_audit_sessions.sql`)** creates the admin-only tables and adds observability columns:
  - `admin_sessions` for admin login tracking (`session_hash`, optional `user_id`/`email`, IP, user agent, and timestamps).
  - `admin_audit` for admin route auditing (`id`, `action`, `route`, `method`, `status`, optional `user_id`/`email`, details JSON, timestamp indexes).
  - Adds `model`, `provider`, `latency_ms`, `input_chars`, `output_chars`, and `meta` columns to `generations` if they are missing.

- **Implicit/external tables** – The application code reads/writes tables that are **not defined in this repo’s schema files**, so they must already exist in Supabase (or be created manually): `customers`, `credit_transactions`, `runtime_config`, `app_config`, `profiles`, `feedback` (singular), and `sessions`/`generations` with Shopify fields. These interactions assume columns such as `shopify_customer_id`, `credits`, `expires_at`, `last_active`, `disabled`, `meta`, and `updated_at` on `customers`, plus Shopify-aware columns on `generations`/`feedback`.

## Potential duplication and cleanup targets

- **Admin allowlist tables:** The code only uses environment variables to allowlist admins; it never queries a table. Both `admin_allowlist` and `mina_admin_allowlist` appear in the Supabase dashboard but have no references in the codebase, so they are candidates for removal.

- **Runtime config tables:** Only `runtime_config` is read/written in code. Tables named `runtime_config_flat` and `mina_runtime_config` are unused and look like obsolete variants that can be cleaned up.

- **Profile tables:** The code upserts into `profiles` via Supabase admin APIs. A `users_profile` table exists in the dashboard but is never referenced in the codebase, so it is likely redundant.

- **Feedback table naming:** The Prisma schema maps to the `feedbacks` table, while the runtime Supabase calls use `feedback` (singular). Ensure only one canonical table is kept; the unused variant should be dropped after confirming production data location.

## Summary

Schema creation is split between the Prisma models (core product tables) and the Supabase SQL bootstrap for admin/audit needs. Several similarly named tables surfaced in Supabase (allowlist, runtime config variants, profile variants, feedback/feedbacks) are not referenced in code and can be removed after verifying they do not hold live data.
