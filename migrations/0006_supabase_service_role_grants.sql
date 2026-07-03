-- Hermas SaaS Supabase API grants.
-- Run this once in Supabase SQL Editor after creating the SaaS tables.
-- It lets the backend-only service_role key read/write Hermas tables through
-- Supabase REST. It does not expose secrets and does not change automation mode.

begin;

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public
grant select, insert, update, delete on tables to service_role;

alter default privileges in schema public
grant usage, select on sequences to service_role;

alter default privileges in schema public
grant execute on functions to service_role;

commit;
