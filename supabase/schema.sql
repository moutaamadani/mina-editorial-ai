-- Core business tables managed in Supabase (no Prisma)

create table if not exists public.customers (
  shopify_customer_id text primary key,
  user_id uuid null,
  email text null,
  credits integer default 0,
  expires_at timestamptz null,
  last_active timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  disabled boolean default false,
  meta jsonb default '{}'::jsonb
);

create index if not exists customers_last_active_idx on public.customers (last_active);
create index if not exists customers_email_idx on public.customers (email);

create table if not exists public.credit_transactions (
  id uuid primary key,
  shopify_customer_id text not null references public.customers(shopify_customer_id) on delete cascade,
  delta integer not null,
  reason text not null,
  source text not null,
  ref_type text null,
  ref_id text null,
  created_at timestamptz default now()
);

create index if not exists credit_transactions_customer_idx on public.credit_transactions (shopify_customer_id, created_at desc);

create table if not exists public.sessions (
  id uuid primary key,
  shopify_customer_id text null references public.customers(shopify_customer_id) on delete set null,
  platform text not null,
  title text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists sessions_customer_created_idx on public.sessions (shopify_customer_id, created_at desc);

create table if not exists public.generations (
  id text primary key,
  type text not null,
  session_id uuid null references public.sessions(id) on delete set null,
  customer_id text null,
  shopify_customer_id text null references public.customers(shopify_customer_id) on delete set null,
  platform text null,
  prompt text not null,
  output_url text null,
  output_key text null,
  provider text null,
  model text null,
  latency_ms integer null,
  input_chars integer null,
  output_chars integer null,
  meta jsonb null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists generations_customer_created_idx on public.generations (shopify_customer_id, created_at desc);

create table if not exists public.feedback (
  id uuid primary key,
  shopify_customer_id text not null references public.customers(shopify_customer_id) on delete cascade,
  session_id uuid null references public.sessions(id) on delete set null,
  generation_id text null references public.generations(id) on delete set null,
  result_type text not null,
  platform text null,
  prompt text not null,
  comment text null,
  image_url text null,
  video_url text null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists feedback_customer_created_idx on public.feedback (shopify_customer_id, created_at desc);

create table if not exists public.runtime_config (
  id integer primary key default 1,
  updated_at timestamptz default now(),
  updated_by text null,
  seadream_model text null,
  kling_model text null,
  gpt_model text null,
  image_cost integer null,
  motion_cost integer null,
  seadream_size text null,
  seadream_enhance_prompt boolean null,
  seadream_sequential_image_generation text null,
  kling_mode text null,
  kling_negative_prompt text null,
  gpt_editorial_temperature numeric null,
  gpt_editorial_max_tokens integer null,
  gpt_editorial_system_text text null,
  gpt_editorial_user_extra text null,
  gpt_motion_prompt_temperature numeric null,
  gpt_motion_prompt_max_tokens integer null,
  gpt_motion_prompt_system_text text null,
  gpt_motion_prompt_user_extra text null,
  gpt_motion_suggest_temperature numeric null,
  gpt_motion_suggest_max_tokens integer null,
  gpt_motion_suggest_system_text text null,
  gpt_motion_suggest_user_extra text null
);

create table if not exists public.app_config (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  updated_by text null
);

create table if not exists public.profiles (
  user_id uuid primary key,
  email text null,
  shopify_customer_id text null references public.customers(shopify_customer_id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
