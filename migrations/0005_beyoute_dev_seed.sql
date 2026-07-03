-- Hermas SaaS dev seed for the current Beyoute pilot.
-- This creates non-secret company/project/channel rows so webhook intake can
-- satisfy Supabase foreign keys. It does not store API keys or webhook secrets.

begin;

create unique index if not exists uniq_channel_connections_project_connection_key
on public.channel_connections(project_key, connection_key)
where connection_key is not null;

create unique index if not exists uniq_conversations_project_external
on public.conversations(project_key, external_conversation_id)
where external_conversation_id is not null;

create unique index if not exists uniq_approval_cases_project_idempotency
on public.approval_cases(project_key, idempotency_key)
where idempotency_key is not null;

insert into public.companies (company_key, name, status, timezone, settings)
values (
  'ctg',
  'CTG Business',
  'active',
  'Asia/Kuala_Lumpur',
  '{"managed_saas": true}'::jsonb
)
on conflict (company_key) do update
set
  name = excluded.name,
  status = excluded.status,
  timezone = excluded.timezone,
  settings = public.companies.settings || excluded.settings,
  updated_at = now();

insert into public.projects (
  company_id,
  project_key,
  name,
  status,
  automation_mode,
  timezone,
  currency,
  default_language,
  settings
)
select
  c.id,
  'beyoute',
  'Beyoute',
  'active',
  'approval_first',
  'Asia/Kuala_Lumpur',
  'MYR',
  'zh-MY',
  '{
    "pilot": true,
    "approval_first": true,
    "auto_send_enabled": false,
    "auto_trigger_flows_enabled": false
  }'::jsonb
from public.companies c
where c.company_key = 'ctg'
on conflict (project_key) do update
set
  company_id = excluded.company_id,
  name = excluded.name,
  status = excluded.status,
  automation_mode = 'approval_first',
  timezone = excluded.timezone,
  currency = excluded.currency,
  default_language = excluded.default_language,
  settings = public.projects.settings || excluded.settings,
  updated_at = now();

insert into public.channel_connections (
  project_key,
  connection_key,
  provider,
  provider_connection_id,
  display_name,
  status,
  config,
  rate_limit
)
values (
  'beyoute',
  'beyoute-chatdaddy',
  'chatdaddy',
  'beyoute-chatdaddy',
  'Beyoute ChatDaddy',
  'active',
  '{
    "approval_first": true,
    "notes": "Non-secret placeholder. Replace provider ids/secrets in Cloudflare or provider vault only."
  }'::jsonb,
  '{"initial_target_messages_per_day": 100}'::jsonb
)
on conflict (project_key, connection_key) where connection_key is not null do update
set
  provider = excluded.provider,
  provider_connection_id = excluded.provider_connection_id,
  display_name = excluded.display_name,
  status = excluded.status,
  config = public.channel_connections.config || excluded.config,
  rate_limit = public.channel_connections.rate_limit || excluded.rate_limit,
  updated_at = now();

commit;
