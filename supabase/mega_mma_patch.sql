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
  if not exists (
    select 1 from pg_constraint
    where conname = 'mega_generations_mma_step_requires_fields'
      and conrelid = 'public.mega_generations'::regclass
  ) then
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
  end if;
exception
  when duplicate_object then
    null;
end$$;
