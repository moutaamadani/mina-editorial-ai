-- MEGA tables for consolidated Supabase schema (lowercase, MEGA-only)
-- Idempotent: uses CREATE TABLE IF NOT EXISTS and guarded indexes

-- =========================
-- MEGA_CUSTOMERS
-- =========================
CREATE TABLE IF NOT EXISTS public.mega_customers (
  mg_pass_id TEXT PRIMARY KEY,
  mg_shopify_customer_id TEXT,
  mg_user_id UUID,
  mg_email TEXT,
  mg_first_name TEXT,
  mg_last_name TEXT,
  mg_display_name TEXT,
  mg_locale TEXT,
  mg_timezone TEXT,
  mg_marketing_opt_in BOOLEAN DEFAULT FALSE,
  mg_product_updates_opt_in BOOLEAN DEFAULT FALSE,
  mg_credits INTEGER DEFAULT 0,
  mg_expires_at TIMESTAMPTZ,
  mg_last_active TIMESTAMPTZ,
  mg_disabled BOOLEAN DEFAULT FALSE,
  mg_verified_email BOOLEAN DEFAULT FALSE,
  mg_verified_google BOOLEAN DEFAULT FALSE,
  mg_verified_apple BOOLEAN DEFAULT FALSE,
  mg_verified_any BOOLEAN GENERATED ALWAYS AS (
    COALESCE(mg_verified_email, FALSE)
    OR COALESCE(mg_verified_google, FALSE)
    OR COALESCE(mg_verified_apple, FALSE)
  ) STORED,
  mg_verification_method TEXT,
  mg_verification_at TIMESTAMPTZ,
  mg_verification_keynumber TEXT,
  mg_topup_default_packs INTEGER DEFAULT 3 CHECK (mg_topup_default_packs >= 0),
  mg_auto_topup_enabled BOOLEAN DEFAULT FALSE,
  mg_auto_topup_monthly_limit_packs INTEGER CHECK (mg_auto_topup_monthly_limit_packs IS NULL OR mg_auto_topup_monthly_limit_packs >= 0),
  mg_last_topup_at TIMESTAMPTZ,
  mg_topup_source TEXT,
  mg_meta JSONB DEFAULT '{}'::jsonb,
  mg_source_system TEXT,
  mg_deleted_at TIMESTAMPTZ,
  mg_created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()),
  mg_updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW())
);

CREATE UNIQUE INDEX IF NOT EXISTS mega_customers_shopify_idx ON public.mega_customers (mg_shopify_customer_id) WHERE mg_shopify_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mega_customers_user_idx ON public.mega_customers (mg_user_id) WHERE mg_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mega_customers_email_idx ON public.mega_customers (LOWER(mg_email));

-- =========================
-- MEGA_GENERATIONS (event/artifact ledger)
-- =========================
CREATE TABLE IF NOT EXISTS public.mega_generations (
  mg_id TEXT PRIMARY KEY,
  mg_record_type TEXT NOT NULL CHECK (mg_record_type IN ('generation', 'session', 'feedback', 'credit_transaction')),
  mg_pass_id TEXT REFERENCES public.mega_customers(mg_pass_id) ON UPDATE CASCADE,
  mg_session_id TEXT,
  mg_generation_id TEXT,
  mg_platform TEXT,
  mg_title TEXT,
  mg_type TEXT,
  mg_prompt TEXT,
  mg_output_url TEXT,
  mg_output_key TEXT,
  mg_provider TEXT,
  mg_model TEXT,
  mg_latency_ms INTEGER,
  mg_input_chars INTEGER,
  mg_output_chars INTEGER,
  mg_input_tokens INTEGER,
  mg_output_tokens INTEGER,
  mg_content_type TEXT,
  mg_status TEXT,
  mg_error TEXT,
  mg_result_type TEXT,
  mg_comment TEXT,
  mg_image_url TEXT,
  mg_video_url TEXT,
  mg_delta INTEGER,
  mg_reason TEXT,
  mg_source TEXT,
  mg_ref_type TEXT,
  mg_ref_id TEXT,
  mg_client_version TEXT,
  mg_os TEXT,
  mg_browser TEXT,
  mg_device TEXT,
  mg_meta JSONB DEFAULT '{}'::jsonb,
  mg_payload JSONB,
  mg_source_system TEXT,
  mg_deleted_at TIMESTAMPTZ,
  mg_created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()),
  mg_updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS mega_generations_pass_idx ON public.mega_generations (mg_pass_id);
CREATE INDEX IF NOT EXISTS mega_generations_session_idx ON public.mega_generations (mg_session_id) WHERE mg_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mega_generations_generation_idx ON public.mega_generations (mg_generation_id) WHERE mg_generation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mega_generations_record_type_idx ON public.mega_generations (mg_record_type);
CREATE INDEX IF NOT EXISTS mega_generations_created_idx ON public.mega_generations (mg_created_at DESC);

-- =========================
-- MEGA_ADMIN
-- =========================
CREATE TABLE IF NOT EXISTS public.mega_admin (
  mg_id TEXT PRIMARY KEY,
  mg_record_type TEXT NOT NULL CHECK (mg_record_type IN ('admin_session', 'admin_audit', 'profile', 'runtime_config', 'app_config')),
  mg_actor_pass_id TEXT REFERENCES public.mega_customers(mg_pass_id) ON UPDATE CASCADE,
  mg_session_hash TEXT,
  mg_user_id UUID,
  mg_email TEXT,
  mg_ip TEXT,
  mg_user_agent TEXT,
  mg_first_seen_at TIMESTAMPTZ,
  mg_last_seen_at TIMESTAMPTZ,
  mg_profile_id UUID,
  mg_shopify_customer_id TEXT,
  mg_action TEXT,
  mg_route TEXT,
  mg_method TEXT,
  mg_status INTEGER,
  mg_detail JSONB,
  mg_runtime_id INTEGER,
  mg_runtime_flat JSONB,
  mg_key TEXT,
  mg_value JSONB,
  mg_meta JSONB DEFAULT '{}'::jsonb,
  mg_payload JSONB,
  mg_source_system TEXT,
  mg_deleted_at TIMESTAMPTZ,
  mg_created_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW()),
  mg_updated_at TIMESTAMPTZ DEFAULT TIMEZONE('utc', NOW())
);

CREATE INDEX IF NOT EXISTS mega_admin_actor_pass_idx ON public.mega_admin (mg_actor_pass_id);
CREATE INDEX IF NOT EXISTS mega_admin_record_type_idx ON public.mega_admin (mg_record_type);
CREATE INDEX IF NOT EXISTS mega_admin_session_hash_idx ON public.mega_admin (mg_session_hash) WHERE mg_session_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS mega_admin_created_idx ON public.mega_admin (mg_created_at DESC);

-- =========================
-- Trigger helpers to keep mg_updated_at current
-- =========================
CREATE OR REPLACE FUNCTION public.mega_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.mg_updated_at = TIMEZONE('utc', NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to each table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'mega_customers_set_updated_at'
  ) THEN
    CREATE TRIGGER mega_customers_set_updated_at
    BEFORE UPDATE ON public.mega_customers
    FOR EACH ROW EXECUTE FUNCTION public.mega_set_updated_at();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'mega_generations_set_updated_at'
  ) THEN
    CREATE TRIGGER mega_generations_set_updated_at
    BEFORE UPDATE ON public.mega_generations
    FOR EACH ROW EXECUTE FUNCTION public.mega_set_updated_at();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'mega_admin_set_updated_at'
  ) THEN
    CREATE TRIGGER mega_admin_set_updated_at
    BEFORE UPDATE ON public.mega_admin
    FOR EACH ROW EXECUTE FUNCTION public.mega_set_updated_at();
  END IF;
END;
$$;
