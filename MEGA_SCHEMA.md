# MEGA Tables Architecture

This document outlines the consolidated Supabase schema built around three core tables:

- `MEGA_CUSTOMERS` — single Pass ID per customer, lifecycle, verification, and billing defaults.
- `MEGA_GENERATIONS` — unified event/artifact ledger for sessions, generations, feedback, and credit transactions.
- `MEGA_ADMIN` — admin sessions/audit trails/config entries and profile mappings.

Each table uses `mg_` prefixes for all columns to avoid quoting issues and keep naming consistent.

## MEGA_CUSTOMERS
| Column | Type | Notes |
| --- | --- | --- |
| `mg_pass_id` | `TEXT` | **Primary key** (Pass ID). |
| `mg_shopify_customer_id` | `TEXT` | Shopify customer id (nullable). |
| `mg_user_id` | `UUID` | Supabase auth user id if present. |
| `mg_email` | `TEXT` | Primary contact email. |
| `mg_first_name` | `TEXT` | Optional given name for personalization. |
| `mg_last_name` | `TEXT` | Optional family name. |
| `mg_display_name` | `TEXT` | Friendly name to show in UI. |
| `mg_locale` | `TEXT` | BCP-47 locale (e.g., `en-US`). |
| `mg_timezone` | `TEXT` | IANA timezone (e.g., `America/Los_Angeles`). |
| `mg_marketing_opt_in` | `BOOL` | Marketing/newsletter consent. |
| `mg_product_updates_opt_in` | `BOOL` | Product-update consent. |
| `mg_credits` | `INT` | Current credit balance. |
| `mg_expires_at` | `TIMESTAMPTZ` | Credit expiry timestamp. |
| `mg_last_active` | `TIMESTAMPTZ` | Last activity timestamp. |
| `mg_disabled` | `BOOL` | Set true to disable account. |
| `mg_verified_email` | `BOOL` | Email verification flag. |
| `mg_verified_google` | `BOOL` | Google login verification. |
| `mg_verified_apple` | `BOOL` | Apple login verification. |
| `mg_verified_any` | `BOOL` | Convenience flag if any verification succeeded. |
| `mg_verification_method` | `TEXT` | How verification was completed (email/google/apple/manual). |
| `mg_verification_at` | `TIMESTAMPTZ` | When verification occurred. |
| `mg_verification_keynumber` | `TEXT` | Keynumber/token issued for verification. |
| `mg_topup_default_packs` | `INT` | Default Shopify top-up pack count (defaults to 3). |
| `mg_auto_topup_enabled` | `BOOL` | Whether auto top-up is enabled. |
| `mg_auto_topup_monthly_limit_packs` | `INT` | Monthly limit on auto top-ups. |
| `mg_last_topup_at` | `TIMESTAMPTZ` | Last successful top-up timestamp. |
| `mg_topup_source` | `TEXT` | Source channel for the last top-up (e.g., shopify/manual). |
| `mg_meta` | `JSONB` | Flexible metadata bucket. |
| `mg_source_system` | `TEXT` | Provenance for migrated rows. |
| `mg_deleted_at` | `TIMESTAMPTZ` | Soft-delete marker. |
| `mg_created_at` | `TIMESTAMPTZ` | Row creation time. |
| `mg_updated_at` | `TIMESTAMPTZ` | Last update time. |

## MEGA_GENERATIONS (event/artifact ledger)
| Column | Type | Notes |
| --- | --- | --- |
| `mg_id` | `TEXT` | **Primary key**; accepts generation/session/feedback/txn IDs. |
| `mg_record_type` | `TEXT` | One of `generation`, `session`, `feedback`, `credit_transaction`. |
| `mg_pass_id` | `TEXT` | FK → `MEGA_CUSTOMERS.mg_pass_id`. |
| `mg_session_id` | `TEXT` | Session identifier (UUID or legacy text). |
| `mg_generation_id` | `TEXT` | Generation id associated with a feedback row. |
| `mg_platform` | `TEXT` | Platform identifier (web/ios/etc.). |
| `mg_title` | `TEXT` | Session title. |
| `mg_type` | `TEXT` | Generation type. |
| `mg_prompt` | `TEXT` | User prompt. |
| `mg_output_url` | `TEXT` | Public non-expiring output URL (R2). |
| `mg_output_key` | `TEXT` | Storage key for the output. |
| `mg_provider` | `TEXT` | Model provider. |
| `mg_model` | `TEXT` | Model name. |
| `mg_latency_ms` | `INT` | Latency in milliseconds. |
| `mg_input_chars` | `INT` | Input character count. |
| `mg_output_chars` | `INT` | Output character count. |
| `mg_input_tokens` | `INT` | Optional token count in. |
| `mg_output_tokens` | `INT` | Optional token count out. |
| `mg_content_type` | `TEXT` | Media/content type (text/image/video). |
| `mg_status` | `TEXT` | Status such as `pending`, `succeeded`, `failed`. |
| `mg_error` | `TEXT` | Error details on failure. |
| `mg_result_type` | `TEXT` | Feedback result type. |
| `mg_comment` | `TEXT` | Feedback comment. |
| `mg_image_url` | `TEXT` | Feedback image URL. |
| `mg_video_url` | `TEXT` | Feedback video URL. |
| `mg_delta` | `INT` | Credit delta. |
| `mg_reason` | `TEXT` | Reason for credit change. |
| `mg_source` | `TEXT` | Source for credit change. |
| `mg_ref_type` | `TEXT` | Reference type for credit change. |
| `mg_ref_id` | `TEXT` | Reference id for credit change. |
| `mg_client_version` | `TEXT` | Client version string. |
| `mg_os` | `TEXT` | OS identifier. |
| `mg_browser` | `TEXT` | Browser name/version. |
| `mg_device` | `TEXT` | Device name/type. |
| `mg_meta` | `JSONB` | Arbitrary metadata for the record. |
| `mg_source_system` | `TEXT` | Provenance for migrated rows. |
| `mg_deleted_at` | `TIMESTAMPTZ` | Soft-delete marker. |
| `mg_created_at` | `TIMESTAMPTZ` | Creation time. |
| `mg_updated_at` | `TIMESTAMPTZ` | Last update time. |

## MEGA_ADMIN
| Column | Type | Notes |
| --- | --- | --- |
| `mg_id` | `TEXT` | **Primary key** for admin-related rows. |
| `mg_record_type` | `TEXT` | One of `admin_session`, `admin_audit`, `profile`, `runtime_config`, `app_config`. |
| `mg_actor_pass_id` | `TEXT` | Optional FK → `MEGA_CUSTOMERS.mg_pass_id` for customer acting-on. |
| `mg_session_hash` | `TEXT` | Admin session hash. |
| `mg_user_id` | `UUID` | Admin auth user id. |
| `mg_email` | `TEXT` | Admin email. |
| `mg_ip` | `TEXT` | IP captured for admin session/audit. |
| `mg_user_agent` | `TEXT` | User agent for admin session/audit. |
| `mg_first_seen_at` | `TIMESTAMPTZ` | First seen timestamp. |
| `mg_last_seen_at` | `TIMESTAMPTZ` | Last seen timestamp. |
| `mg_profile_id` | `UUID` | Legacy profile id reference. |
| `mg_shopify_customer_id` | `TEXT` | Shopify id stored in profile mapping. |
| `mg_action` | `TEXT` | Admin action name. |
| `mg_route` | `TEXT` | Route accessed. |
| `mg_method` | `TEXT` | HTTP method. |
| `mg_status` | `INT` | HTTP status code. |
| `mg_detail` | `JSONB` | Arbitrary audit detail. |
| `mg_runtime_id` | `INT` | Runtime config id (e.g., 1). |
| `mg_runtime_flat` | `JSONB` | Flattened runtime knobs. |
| `mg_key` | `TEXT` | App config key. |
| `mg_value` | `JSONB` | App config value. |
| `mg_meta` | `JSONB` | Flexible metadata. |
| `mg_source_system` | `TEXT` | Provenance for migrated rows. |
| `mg_deleted_at` | `TIMESTAMPTZ` | Soft-delete marker. |
| `mg_created_at` | `TIMESTAMPTZ` | Creation time. |
| `mg_updated_at` | `TIMESTAMPTZ` | Last update time. |

## Execution
Use the Supabase SQL editor or the CLI to run [`supabase/mega_tables.sql`](supabase/mega_tables.sql):

```bash
# With Supabase CLI authenticated and project linked
supabase db push --file supabase/mega_tables.sql

# Or directly against Postgres/Supabase via psql
psql "$SUPABASE_CONNECTION_STRING" -f supabase/mega_tables.sql
```

The script is idempotent (`CREATE TABLE IF NOT EXISTS`) and adds indexes/constraints for Pass ID lookups and record-type validation.
