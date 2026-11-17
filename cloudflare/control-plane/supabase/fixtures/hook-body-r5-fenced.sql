-- SPDX-License-Identifier: AGPL-3.0-or-later
-- TEST FIXTURE ONLY, never installed anywhere live from this repo. The r5 fenced hook body that has been live on the shared
-- project since 2026-11-06 (site migration apps/web/supabase/migrations/20261106120000_hook_refuse_password_amr.sql): the
-- password refusal plus email_verified, with no epoch fences. hook-gotrue-test.sh installs it to show what E2 and E3 add.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  claims jsonb := event->'claims';
  confirmed boolean;
begin
  if jsonb_typeof(claims->'amr') = 'array' and exists (
    select 1 from jsonb_array_elements(claims->'amr') as e(entry)
    where jsonb_typeof(e.entry) = 'object' and jsonb_typeof(e.entry->'method') = 'string' and e.entry->>'method' = 'password'
  ) then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'Password sign-in is not available. Use the emailed code.'));
  end if;

  select u.email_confirmed_at is not null into confirmed from auth.users u where u.id = (event->>'user_id')::uuid;
  claims := jsonb_set(claims, '{app_metadata}', coalesce(claims->'app_metadata', '{}'::jsonb));
  claims := jsonb_set(claims, '{app_metadata,email_verified}', to_jsonb(coalesce(confirmed, false)));
  return jsonb_set(event, '{claims}', claims);
end;
$function$;
grant usage on schema public to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
