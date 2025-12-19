-- MMA/MEGA patch to extend MEGA tables with MMA fields (idempotent)
-- Safe to run multiple times; guarded with IF NOT EXISTS clauses

-- 1) MEGA_CUSTOMERS: preference snapshot fields
ALTER TABLE public.mega_customers
  ADD COLUMN IF NOT EXISTS mg_mma_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS mg_mma_preferences_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS mega_customers_mma_preferences_gin
  ON public.mega_customers USING gin (mg_mma_preferences);

-- 2) MEGA_GENERATIONS: mma steps/events + vars
ALTER TABLE public.mega_generations
  ADD COLUMN IF NOT EXISTS mg_parent_id TEXT,
  ADD COLUMN IF NOT EXISTS mg_step_no INTEGER,
  ADD COLUMN IF NOT EXISTS mg_step_type TEXT,
  ADD COLUMN IF NOT EXISTS mg_mma_mode TEXT,
  ADD COLUMN IF NOT EXISTS mg_mma_status TEXT,
  ADD COLUMN IF NOT EXISTS mg_mma_vars JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Expand allowed record types for MMA
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mega_generations_mg_record_type_check'
  ) THEN
    ALTER TABLE public.mega_generations
      ADD CONSTRAINT mega_generations_mg_record_type_check
      CHECK (mg_record_type IN ('generation', 'session', 'feedback', 'credit_transaction', 'mma_step', 'mma_event'));
  ELSE
    ALTER TABLE public.mega_generations
      DROP CONSTRAINT mega_generations_mg_record_type_check,
      ADD CONSTRAINT mega_generations_mg_record_type_check
      CHECK (mg_record_type IN ('generation', 'session', 'feedback', 'credit_transaction', 'mma_step', 'mma_event'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS mega_generations_mma_steps_lookup
  ON public.mega_generations (mg_generation_id, mg_step_no)
  WHERE mg_record_type = 'mma_step';

CREATE INDEX IF NOT EXISTS mega_generations_mma_step_type_lookup
  ON public.mega_generations (mg_step_type)
  WHERE mg_record_type = 'mma_step';

CREATE INDEX IF NOT EXISTS mega_generations_mma_vars_gin
  ON public.mega_generations USING gin (mg_mma_vars);
