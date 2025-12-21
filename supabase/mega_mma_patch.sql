-- Hero Part: MMA migration patch (idempotent)
-- Adds MMA-focused columns and indexes without breaking existing data.

alter table if exists mega_customers
  add column if not exists mg_mma_preferences jsonb default '{}'::jsonb,
  add column if not exists mg_mma_preferences_updated_at timestamptz;

alter table if exists mega_generations
  add column if not exists mg_parent_id text,
  add column if not exists mg_step_no integer,
  add column if not exists mg_step_type text,
  add column if not exists mg_mma_mode text,
  add column if not exists mg_mma_status text,
  add column if not exists mg_mma_vars jsonb default '{}'::jsonb;

create index if not exists idx_mega_generations_generation_step
  on mega_generations (mg_generation_id, mg_record_type, mg_step_no);

create index if not exists idx_mega_generations_pass_record_created
  on mega_generations (mg_pass_id, mg_record_type, mg_created_at desc);

create index if not exists idx_mega_generations_mma_vars_gin
  on mega_generations using gin (mg_mma_vars);

create index if not exists idx_mega_customers_mma_preferences_gin
  on mega_customers using gin (mg_mma_preferences);

-- Optional CHECK for mma_step fields (skip if not supported by installed extensions)
-- alter table mega_generations
--   add constraint mma_step_required_fields
--   check (mg_record_type <> 'mma_step' or (mg_step_no is not null and mg_step_type is not null));
