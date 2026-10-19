-- SPDX-License-Identifier: AGPL-3.0-or-later
-- SUPERSEDED: install custom-access-token-hook-oauth-guard.sql instead. This file lacks the OAuth link guard and the
-- `mfa_factor_id` claim; without that claim no step-up ever counts (src/trusted-factors.ts).
-- Murage Cloud: the members area's Supabase Custom Access Token Hook (CONTRACT.md section 1). The control plane
-- refuses any token without app_metadata.email_verified = true; this hook is the only thing that sets it, from
-- auth.users.email_confirmed_at, on every issued token. The members area (MakerKit) installs this file verbatim as a
-- schema/migration and enables it in supabase/config.toml (and in the hosted project: Auth > Hooks):
--
--   [auth.hook.custom_access_token]
--   enabled = true
--   uri = "pg-functions://postgres/public/custom_access_token_hook"
--
-- Runs as supabase_auth_admin (which owns auth.users). Not SECURITY DEFINER. Tested against Postgres with MakerKit's
-- own revocations by supabase/hook-pg-test.sh.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := event->'claims';
  confirmed boolean;
begin
  select u.email_confirmed_at is not null into confirmed from auth.users u where u.id = (event->>'user_id')::uuid;
  claims := jsonb_set(claims, '{app_metadata}', coalesce(claims->'app_metadata', '{}'::jsonb));
  claims := jsonb_set(claims, '{app_metadata,email_verified}', to_jsonb(coalesce(confirmed, false)));
  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- MakerKit revokes all on schema public from public (supabase/schemas/00-privileges.sql): without this grant
-- supabase_auth_admin cannot reach the function and every sign-in fails.
grant usage on schema public to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
