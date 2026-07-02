-- Hermas SaaS v1 scale schema for Supabase/Postgres.
-- Purpose: 20-brand approval-first rollout with project isolation, durable queues,
-- background jobs, audit events, and channel adapter records.
-- Safe to run after the existing Supabase v1 schema; extends existing tables when
-- names already exist and creates the missing SaaS tables.

begin;

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  company_key text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  timezone text not null default 'Asia/Kuala_Lumpur',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  project_key text not null unique,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  automation_mode text not null default 'approval_first' check (automation_mode in ('approval_first', 'auto_reply_limited', 'autonomous')),
  timezone text not null default 'Asia/Kuala_Lumpur',
  currency text not null default 'MYR',
  default_language text not null default 'zh-MY',
  readiness_status text not null default 'not_ready' check (readiness_status in ('not_ready', 'testing', 'ready', 'live')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  email text not null unique,
  full_name text,
  role text not null default 'staff' check (role in ('super_admin', 'admin', 'staff')),
  status text not null default 'active' check (status in ('active', 'disabled', 'invited')),
  password_hash text,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  session_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz not null default now()
);

create table if not exists public.project_memberships (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.projects(project_key) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner', 'admin', 'staff', 'viewer')),
  status text not null default 'active' check (status in ('active', 'disabled', 'invited')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_key, user_id)
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.projects(project_key) on delete cascade,
  channel_connection_id uuid,
  external_customer_id text,
  phone_e164 text,
  display_name text,
  first_name text,
  last_name text,
  avatar_url text,
  locale text default 'zh-MY',
  source text,
  tags text[] not null default '{}',
  profile jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_key, channel_connection_id, external_customer_id)
);

create table if not exists public.channel_connections (
  id uuid primary key default gen_random_uuid(),
  project_key text references public.projects(project_key) on delete cascade,
  connection_key text,
  provider text not null default 'chatdaddy',
  provider_account_id text,
  provider_connection_id text,
  display_name text,
  phone_e164 text,
  status text not null default 'draft',
  webhook_secret_ref text,
  webhook_secret_hash text,
  secret_ref text,
  config jsonb not null default '{}'::jsonb,
  rate_limit jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  project_key text references public.projects(project_key) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  channel_connection_id uuid,
  external_conversation_id text,
  external_thread_id text,
  status text not null default 'open',
  stage text,
  summary text,
  owner_user_id uuid references public.users(id) on delete set null,
  last_message_at timestamptz,
  last_customer_message_at timestamptz,
  last_agent_message_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  project_key text references public.projects(project_key) on delete cascade,
  conversation_id uuid,
  customer_id uuid references public.customers(id) on delete set null,
  direction text not null default 'inbound',
  sender_type text not null default 'customer',
  sender_user_id uuid references public.users(id) on delete set null,
  provider text,
  provider_message_id text,
  text text,
  message_type text not null default 'text',
  attachments jsonb not null default '[]'::jsonb,
  content jsonb not null default '{}'::jsonb,
  status text not null default 'received',
  message_at timestamptz not null default now(),
  raw_payload_ref text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.approval_cases (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.projects(project_key) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  conversation_id uuid,
  trigger_message_id uuid,
  status text not null default 'pending' check (status in ('pending', 'needs_approval', 'returned_ai', 'handoff', 'manual_resolved', 'sent', 'auto_record', 'closed', 'failed')),
  queue_bucket text not null default 'pending' check (queue_bucket in ('pending', 'approvable', 'human', 'order_payment', 'auto_record', 'closed')),
  stage text,
  intent text,
  risk_level text not null default 'medium' check (risk_level in ('low', 'medium', 'high')),
  customer_last_text text,
  suggested_reply text,
  next_action text,
  confidence numeric(5, 4),
  reason text,
  provider text,
  provider_case_id text,
  idempotency_key text,
  assigned_to uuid references public.users(id) on delete set null,
  due_at timestamptz,
  closed_at timestamptz,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.case_actions (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.projects(project_key) on delete cascade,
  case_id uuid not null references public.approval_cases(id) on delete cascade,
  operator_id uuid references public.users(id) on delete set null,
  action text not null,
  before_status text,
  after_status text,
  message_text text,
  amount numeric(12, 2),
  currency text default 'MYR',
  note text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_decisions (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.projects(project_key) on delete cascade,
  case_id uuid references public.approval_cases(id) on delete set null,
  conversation_id uuid,
  trigger_message_id uuid,
  model text,
  prompt_version text,
  decision text not null,
  risk_level text,
  stage_before text,
  stage_after text,
  suggested_reply text,
  next_action text,
  confidence numeric(5, 4),
  tokens_input integer not null default 0,
  tokens_output integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  latency_ms integer,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.flow_events (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.projects(project_key) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  conversation_id uuid,
  channel_connection_id uuid,
  provider text not null default 'chatdaddy',
  provider_event_id text,
  flow_id text,
  flow_key text,
  flow_step text,
  event_type text not null,
  status text not null default 'received',
  event_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  project_key text references public.projects(project_key) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  conversation_id uuid,
  case_id uuid references public.approval_cases(id) on delete set null,
  status text not null default 'draft',
  order_type text not null default 'cod',
  currency text not null default 'MYR',
  total_amount numeric(12, 2),
  package_code text,
  package_name text,
  customer_name text,
  phone_e164 text,
  address text,
  data jsonb not null default '{}'::jsonb,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.projects(project_key) on delete cascade,
  order_id uuid,
  customer_id uuid references public.customers(id) on delete set null,
  conversation_id uuid,
  case_id uuid references public.approval_cases(id) on delete set null,
  amount numeric(12, 2),
  currency text not null default 'MYR',
  method text,
  status text not null default 'pending' check (status in ('pending', 'reviewing', 'confirmed', 'rejected', 'refunded')),
  evidence_type text,
  evidence_ref text,
  confirmed_by uuid references public.users(id) on delete set null,
  confirmed_at timestamptz,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.learning_notes (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.projects(project_key) on delete cascade,
  case_id uuid references public.approval_cases(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  source text not null default 'manual_review',
  status text not null default 'open' check (status in ('open', 'reviewed', 'applied', 'ignored')),
  title text,
  customer_pattern text,
  bad_reply text,
  better_reply text,
  proposed_rule text,
  reviewed_by uuid references public.users(id) on delete set null,
  reviewed_at timestamptz,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  project_key text references public.projects(project_key) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  actor_user_id uuid references public.users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id text,
  ip_hash text,
  user_agent_hash text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.usage_costs (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.projects(project_key) on delete cascade,
  usage_date date not null default current_date,
  provider text not null,
  model text,
  operation text,
  units integer not null default 0,
  tokens_input integer not null default 0,
  tokens_output integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_key, usage_date, provider, model, operation)
);

create table if not exists public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  project_key text references public.projects(project_key) on delete cascade,
  job_type text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
  priority integer not null default 5,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.channel_connections add column if not exists project_key text references public.projects(project_key) on delete cascade;
alter table public.channel_connections add column if not exists connection_key text;
alter table public.channel_connections add column if not exists provider_connection_id text;
alter table public.channel_connections add column if not exists webhook_secret_ref text;
alter table public.channel_connections add column if not exists webhook_secret_hash text;
alter table public.channel_connections add column if not exists rate_limit jsonb not null default '{}'::jsonb;

alter table public.conversations add column if not exists project_key text references public.projects(project_key) on delete cascade;
alter table public.conversations add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.messages add column if not exists project_key text references public.projects(project_key) on delete cascade;
alter table public.messages add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.messages add column if not exists message_type text not null default 'text';
alter table public.messages add column if not exists raw_payload_ref text;
alter table public.messages add column if not exists provider text;
alter table public.orders add column if not exists project_key text references public.projects(project_key) on delete cascade;
alter table public.orders add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.orders add column if not exists conversation_id uuid;
alter table public.orders add column if not exists case_id uuid references public.approval_cases(id) on delete set null;

create index if not exists idx_projects_company_status_updated on public.projects(company_id, status, updated_at desc);
create index if not exists idx_project_memberships_user_status on public.project_memberships(user_id, status, project_key);
create index if not exists idx_channel_connections_project_status_updated on public.channel_connections(project_key, status, updated_at desc);
create index if not exists idx_customers_project_updated on public.customers(project_key, updated_at desc);
create index if not exists idx_customers_project_phone on public.customers(project_key, phone_e164);
create index if not exists idx_conversations_project_status_updated on public.conversations(project_key, status, updated_at desc);
create index if not exists idx_conversations_project_customer on public.conversations(project_key, customer_id);
create index if not exists idx_messages_project_message_at on public.messages(project_key, message_at desc);
create index if not exists idx_messages_project_customer on public.messages(project_key, customer_id);
create index if not exists idx_messages_project_conversation_time on public.messages(project_key, conversation_id, message_at desc);
create index if not exists idx_approval_cases_project_status_updated on public.approval_cases(project_key, status, updated_at desc);
create index if not exists idx_approval_cases_project_bucket_updated on public.approval_cases(project_key, queue_bucket, updated_at desc);
create index if not exists idx_approval_cases_project_customer on public.approval_cases(project_key, customer_id);
create index if not exists idx_approval_cases_project_conversation on public.approval_cases(project_key, conversation_id);
create index if not exists idx_case_actions_project_case_time on public.case_actions(project_key, case_id, created_at desc);
create index if not exists idx_ai_decisions_project_case_time on public.ai_decisions(project_key, case_id, created_at desc);
create index if not exists idx_flow_events_project_status_time on public.flow_events(project_key, status, event_at desc);
create index if not exists idx_flow_events_project_customer on public.flow_events(project_key, customer_id);
create index if not exists idx_orders_project_status_updated on public.orders(project_key, status, updated_at desc);
create index if not exists idx_orders_project_customer on public.orders(project_key, customer_id);
create index if not exists idx_payments_project_status_updated on public.payments(project_key, status, updated_at desc);
create index if not exists idx_payments_project_customer on public.payments(project_key, customer_id);
create index if not exists idx_learning_notes_project_status_updated on public.learning_notes(project_key, status, updated_at desc);
create index if not exists idx_audit_events_project_time on public.audit_events(project_key, created_at desc);
create index if not exists idx_usage_costs_project_date on public.usage_costs(project_key, usage_date desc);
create index if not exists idx_background_jobs_project_status_next on public.background_jobs(project_key, status, next_run_at, priority);

create unique index if not exists uniq_messages_project_provider_message
on public.messages(project_key, provider, provider_message_id)
where provider_message_id is not null;

create unique index if not exists uniq_customers_project_phone
on public.customers(project_key, phone_e164)
where phone_e164 is not null;

create unique index if not exists uniq_flow_events_project_provider_event
on public.flow_events(project_key, provider, provider_event_id)
where provider_event_id is not null;

create unique index if not exists uniq_background_jobs_project_dedupe
on public.background_jobs(project_key, dedupe_key)
where dedupe_key is not null;

drop trigger if exists set_companies_updated_at on public.companies;
create trigger set_companies_updated_at before update on public.companies
for each row execute function public.set_updated_at();

drop trigger if exists set_projects_updated_at on public.projects;
create trigger set_projects_updated_at before update on public.projects
for each row execute function public.set_updated_at();

drop trigger if exists set_users_updated_at on public.users;
create trigger set_users_updated_at before update on public.users
for each row execute function public.set_updated_at();

drop trigger if exists set_project_memberships_updated_at on public.project_memberships;
create trigger set_project_memberships_updated_at before update on public.project_memberships
for each row execute function public.set_updated_at();

drop trigger if exists set_customers_updated_at on public.customers;
create trigger set_customers_updated_at before update on public.customers
for each row execute function public.set_updated_at();

drop trigger if exists set_approval_cases_updated_at on public.approval_cases;
create trigger set_approval_cases_updated_at before update on public.approval_cases
for each row execute function public.set_updated_at();

drop trigger if exists set_payments_updated_at on public.payments;
create trigger set_payments_updated_at before update on public.payments
for each row execute function public.set_updated_at();

drop trigger if exists set_learning_notes_updated_at on public.learning_notes;
create trigger set_learning_notes_updated_at before update on public.learning_notes
for each row execute function public.set_updated_at();

drop trigger if exists set_background_jobs_updated_at on public.background_jobs;
create trigger set_background_jobs_updated_at before update on public.background_jobs
for each row execute function public.set_updated_at();

create or replace function public.hermas_current_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.id
  from public.users u
  where u.status = 'active'
    and (u.auth_user_id = auth.uid() or u.id = auth.uid())
  limit 1
$$;

create or replace function public.hermas_is_project_member(target_project_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.project_memberships pm
    join public.users u on u.id = pm.user_id
    where pm.project_key = target_project_key
      and pm.status = 'active'
      and u.status = 'active'
      and (pm.user_id = public.hermas_current_user_id() or u.role = 'super_admin')
  )
$$;

create or replace function public.hermas_is_project_admin(target_project_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.project_memberships pm
    join public.users u on u.id = pm.user_id
    where pm.project_key = target_project_key
      and pm.status = 'active'
      and u.status = 'active'
      and pm.role in ('owner', 'admin')
      and (pm.user_id = public.hermas_current_user_id() or u.role = 'super_admin')
  )
$$;

create or replace function public.hermas_is_company_admin(target_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects p
    join public.project_memberships pm on pm.project_key = p.project_key
    join public.users u on u.id = pm.user_id
    where p.company_id = target_company_id
      and pm.status = 'active'
      and u.status = 'active'
      and (u.role = 'super_admin' or (pm.role in ('owner', 'admin') and pm.user_id = public.hermas_current_user_id()))
  )
$$;

alter table public.companies enable row level security;
alter table public.projects enable row level security;
alter table public.users enable row level security;
alter table public.user_sessions enable row level security;
alter table public.project_memberships enable row level security;
alter table public.channel_connections enable row level security;
alter table public.customers enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.approval_cases enable row level security;
alter table public.case_actions enable row level security;
alter table public.ai_decisions enable row level security;
alter table public.flow_events enable row level security;
alter table public.orders enable row level security;
alter table public.payments enable row level security;
alter table public.learning_notes enable row level security;
alter table public.audit_events enable row level security;
alter table public.usage_costs enable row level security;
alter table public.background_jobs enable row level security;

drop policy if exists "companies_project_members_select" on public.companies;
create policy "companies_project_members_select" on public.companies
for select using (
  public.hermas_is_company_admin(id)
  or exists (
    select 1 from public.projects p
    where p.company_id = companies.id and public.hermas_is_project_member(p.project_key)
  )
);

drop policy if exists "companies_admin_write" on public.companies;
create policy "companies_admin_write" on public.companies
for all using (public.hermas_is_company_admin(id))
with check (public.hermas_is_company_admin(id));

drop policy if exists "projects_members_select" on public.projects;
create policy "projects_members_select" on public.projects
for select using (public.hermas_is_project_member(project_key));

drop policy if exists "projects_admin_write" on public.projects;
create policy "projects_admin_write" on public.projects
for all using (public.hermas_is_company_admin(company_id))
with check (public.hermas_is_company_admin(company_id));

drop policy if exists "users_self_or_admin_select" on public.users;
create policy "users_self_or_admin_select" on public.users
for select using (
  id = public.hermas_current_user_id()
  or exists (
    select 1
    from public.project_memberships pm
    join public.projects p on p.project_key = pm.project_key
    where pm.user_id = users.id and public.hermas_is_company_admin(p.company_id)
  )
);

drop policy if exists "users_admin_write" on public.users;
create policy "users_admin_write" on public.users
for all using (
  role = 'super_admin'
  or exists (
    select 1
    from public.project_memberships pm
    join public.projects p on p.project_key = pm.project_key
    where pm.user_id = users.id and public.hermas_is_company_admin(p.company_id)
  )
) with check (true);

drop policy if exists "user_sessions_self_select" on public.user_sessions;
create policy "user_sessions_self_select" on public.user_sessions
for select using (user_id = public.hermas_current_user_id());

drop policy if exists "project_memberships_self_or_admin_select" on public.project_memberships;
create policy "project_memberships_self_or_admin_select" on public.project_memberships
for select using (
  user_id = public.hermas_current_user_id()
  or public.hermas_is_project_admin(project_key)
);

drop policy if exists "project_memberships_admin_write" on public.project_memberships;
create policy "project_memberships_admin_write" on public.project_memberships
for all using (public.hermas_is_project_admin(project_key))
with check (public.hermas_is_project_admin(project_key));

drop policy if exists "channel_connections_project_admin_select" on public.channel_connections;
create policy "channel_connections_project_admin_select" on public.channel_connections
for select using (project_key is not null and public.hermas_is_project_admin(project_key));

drop policy if exists "channel_connections_project_admin_write" on public.channel_connections;
create policy "channel_connections_project_admin_write" on public.channel_connections
for all using (project_key is not null and public.hermas_is_project_admin(project_key))
with check (project_key is not null and public.hermas_is_project_admin(project_key));

drop policy if exists "customers_project_members_select" on public.customers;
create policy "customers_project_members_select" on public.customers
for select using (public.hermas_is_project_member(project_key));

drop policy if exists "customers_project_members_write" on public.customers;
create policy "customers_project_members_write" on public.customers
for all using (public.hermas_is_project_member(project_key))
with check (public.hermas_is_project_member(project_key));

drop policy if exists "conversations_project_members_select" on public.conversations;
create policy "conversations_project_members_select" on public.conversations
for select using (project_key is not null and public.hermas_is_project_member(project_key));

drop policy if exists "messages_project_members_select" on public.messages;
create policy "messages_project_members_select" on public.messages
for select using (project_key is not null and public.hermas_is_project_member(project_key));

drop policy if exists "approval_cases_project_members_select" on public.approval_cases;
create policy "approval_cases_project_members_select" on public.approval_cases
for select using (public.hermas_is_project_member(project_key));

drop policy if exists "approval_cases_project_members_write" on public.approval_cases;
create policy "approval_cases_project_members_write" on public.approval_cases
for all using (public.hermas_is_project_member(project_key))
with check (public.hermas_is_project_member(project_key));

drop policy if exists "case_actions_project_members_select" on public.case_actions;
create policy "case_actions_project_members_select" on public.case_actions
for select using (public.hermas_is_project_member(project_key));

drop policy if exists "case_actions_project_members_insert" on public.case_actions;
create policy "case_actions_project_members_insert" on public.case_actions
for insert with check (public.hermas_is_project_member(project_key));

drop policy if exists "ai_decisions_project_admin_select" on public.ai_decisions;
create policy "ai_decisions_project_admin_select" on public.ai_decisions
for select using (public.hermas_is_project_admin(project_key));

drop policy if exists "flow_events_project_members_select" on public.flow_events;
create policy "flow_events_project_members_select" on public.flow_events
for select using (public.hermas_is_project_member(project_key));

drop policy if exists "orders_project_members_select" on public.orders;
create policy "orders_project_members_select" on public.orders
for select using (project_key is not null and public.hermas_is_project_member(project_key));

drop policy if exists "orders_project_members_write" on public.orders;
create policy "orders_project_members_write" on public.orders
for all using (project_key is not null and public.hermas_is_project_member(project_key))
with check (project_key is not null and public.hermas_is_project_member(project_key));

drop policy if exists "payments_project_members_select" on public.payments;
create policy "payments_project_members_select" on public.payments
for select using (public.hermas_is_project_member(project_key));

drop policy if exists "payments_project_members_write" on public.payments;
create policy "payments_project_members_write" on public.payments
for all using (public.hermas_is_project_member(project_key))
with check (public.hermas_is_project_member(project_key));

drop policy if exists "learning_notes_project_admin_select" on public.learning_notes;
create policy "learning_notes_project_admin_select" on public.learning_notes
for select using (public.hermas_is_project_admin(project_key));

drop policy if exists "learning_notes_project_admin_write" on public.learning_notes;
create policy "learning_notes_project_admin_write" on public.learning_notes
for all using (public.hermas_is_project_admin(project_key))
with check (public.hermas_is_project_admin(project_key));

drop policy if exists "audit_events_project_admin_select" on public.audit_events;
create policy "audit_events_project_admin_select" on public.audit_events
for select using (
  (project_key is not null and public.hermas_is_project_admin(project_key))
  or (company_id is not null and public.hermas_is_company_admin(company_id))
);

drop policy if exists "usage_costs_project_admin_select" on public.usage_costs;
create policy "usage_costs_project_admin_select" on public.usage_costs
for select using (public.hermas_is_project_admin(project_key));

drop policy if exists "background_jobs_project_admin_select" on public.background_jobs;
create policy "background_jobs_project_admin_select" on public.background_jobs
for select using (project_key is not null and public.hermas_is_project_admin(project_key));

commit;
