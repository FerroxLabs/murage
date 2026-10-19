#!/bin/sh
# Runs custom-access-token-hook.sql against a real Postgres with Supabase's roles and MakerKit's revocations, then
# calls the hook as supabase_auth_admin (allowed) and as authenticated/anon (refused). Run inside postgres:16-alpine
# with --network none: docker run --rm --network none -v "$PWD":/w postgres:16-alpine sh /w/hook-pg-test.sh
set -eu
export PGDATA=/tmp/pg PGUSER=postgres
mkdir -p "$PGDATA" && chown postgres "$PGDATA"
su postgres -c "initdb -A trust -D $PGDATA >/dev/null && pg_ctl -D $PGDATA -o '-c listen_addresses=' -w start >/dev/null"
q() { psql -v ON_ERROR_STOP=1 -qtAX -d postgres "$@"; }
q <<'SQL'
create role anon nologin; create role authenticated nologin; create role supabase_auth_admin nologin;
create schema auth authorization supabase_auth_admin;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
alter table auth.users owner to supabase_auth_admin;
insert into auth.users values ('11111111-1111-1111-1111-111111111111','c@x.test',now()), ('22222222-2222-2222-2222-222222222222','u@x.test',null);
-- MakerKit supabase/schemas/00-privileges.sql
alter default privileges revoke execute on functions from public;
revoke all on schema public from public;
revoke all privileges on schema public from anon;
SQL
q -f /w/custom-access-token-hook.sql
call() { q -c "set role $1; select public.custom_access_token_hook('{\"user_id\":\"$2\",\"claims\":{\"sub\":\"$2\",\"app_metadata\":{\"provider\":\"email\"}}}'::jsonb)->'claims'->'app_metadata'->>'email_verified'"; }
fail=0
[ "$(call supabase_auth_admin 11111111-1111-1111-1111-111111111111)" = "true" ] && echo "ok confirmed -> true" || { echo "FAIL confirmed"; fail=1; }
[ "$(call supabase_auth_admin 22222222-2222-2222-2222-222222222222)" = "false" ] && echo "ok unconfirmed -> false" || { echo "FAIL unconfirmed"; fail=1; }
[ "$(call supabase_auth_admin 33333333-3333-3333-3333-333333333333)" = "false" ] && echo "ok unknown -> false" || { echo "FAIL unknown"; fail=1; }
for r in authenticated anon; do
  if call $r 11111111-1111-1111-1111-111111111111 >/dev/null 2>&1; then echo "FAIL $r can execute"; fail=1; else echo "ok $r refused"; fi
done
# The grant is load-bearing: without schema usage the auth admin cannot call it.
q -c "revoke usage on schema public from supabase_auth_admin"
if call supabase_auth_admin 11111111-1111-1111-1111-111111111111 >/dev/null 2>&1; then echo "FAIL works without schema grant"; fail=1; else echo "ok needs schema grant"; fi
[ $fail -eq 0 ] && echo "HOOK-PG PASS" || { echo "HOOK-PG FAIL"; exit 1; }
