-- Hermas SaaS project-level ads connection.
-- Purpose: let Admin configure Meta CAPI per project without storing 20 project
-- tokens as Cloudflare secrets. Token values are encrypted by the Worker before
-- they are saved here. Staff Dashboard never reads this table directly.

begin;

create extension if not exists pgcrypto;

create table if not exists public.project_ads_connections (
  id uuid primary key default gen_random_uuid(),
  project_key text not null references public.projects(project_key) on delete cascade,
  provider text not null default 'meta_capi' check (provider in ('meta_capi')),
  status text not null default 'not_configured' check (status in ('not_configured', 'active', 'paused', 'error')),
  pixel_id text,
  dataset_id text,
  page_id text,
  ad_account_id text,
  graph_version text not null default 'v23.0',
  test_event_code text,
  access_token_ciphertext text,
  access_token_iv text,
  access_token_key_version text not null default 'v1',
  access_token_last4 text,
  access_token_configured boolean not null default false,
  auto_track_enabled boolean not null default false,
  purchase_auto_track_enabled boolean not null default false,
  last_test_at timestamptz,
  last_test_status text,
  last_test_result jsonb not null default '{}'::jsonb,
  data jsonb not null default '{}'::jsonb,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_key, provider)
);

create index if not exists idx_project_ads_connections_project_status
on public.project_ads_connections(project_key, status, updated_at desc);

drop trigger if exists set_project_ads_connections_updated_at on public.project_ads_connections;
create trigger set_project_ads_connections_updated_at
before update on public.project_ads_connections
for each row execute function public.set_updated_at();

alter table public.project_ads_connections enable row level security;

drop policy if exists project_ads_connections_admin_select on public.project_ads_connections;
create policy project_ads_connections_admin_select
on public.project_ads_connections
for select using (public.hermas_is_project_admin(project_key));

drop policy if exists project_ads_connections_admin_write on public.project_ads_connections;
create policy project_ads_connections_admin_write
on public.project_ads_connections
for all using (public.hermas_is_project_admin(project_key))
with check (public.hermas_is_project_admin(project_key));

grant select, insert, update, delete on public.project_ads_connections to service_role;
grant usage, select on all sequences in schema public to service_role;

commit;
