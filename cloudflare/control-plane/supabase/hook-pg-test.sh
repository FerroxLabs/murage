#!/bin/sh
# Hook and enable-step tests against a real Postgres whose auth schema comes from GoTrue's OWN migrations (design
# CLOUD-ONE-CODE-PROOF r5 test 23, r6 tests 35 and 38, r7 tests 39 and 40; replaces the older basic harness, whose
# installer custom-access-token-hook.sql is deleted). No network: run with --network none after the images are pulled.
#   docker run --rm --network none -v "$PWD":/w -v "$GOTRUE_DIR":/g postgres:16-alpine sh /w/hook-pg-test.sh
# GOTRUE_DIR holds `auth` (the supabase/auth v2.197.0 binary) and `migrations/` (its migration files).
# Roles follow hosted Supabase: the bootstrap superuser is supabase_admin; postgres is NOT a superuser (createrole,
# bypassrls) and is a member of supabase_auth_admin; supabase_auth_admin has no BYPASSRLS; GoTrue's migrations run as it.
# Every case prints ok or FAIL; the last line is the count. Setup errors never abort: they show up as FAIL cases.
PGDATA=/tmp/pg; export PGDATA
PGUSER=supabase_admin; export PGUSER
mkdir -p "$PGDATA" && chown postgres "$PGDATA"
su postgres -c "initdb -U supabase_admin -A trust -D $PGDATA >/dev/null 2>&1 && pg_ctl -D $PGDATA -o '-c listen_addresses=127.0.0.1' -w start >/dev/null"
q() { psql -v ON_ERROR_STOP=1 -qtAX -d postgres "$@"; }
qp() { PGUSER=postgres psql -v ON_ERROR_STOP=1 -qtAX -d postgres "$@"; }   # as the deployment role
q <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role supabase_auth_admin login createrole noinherit;
create role postgres login nosuperuser createrole createdb replication bypassrls;
grant supabase_auth_admin to postgres;
alter database postgres owner to postgres;
grant anon, authenticated, service_role to postgres, supabase_auth_admin;
create schema auth authorization supabase_auth_admin;
grant usage on schema public to anon, authenticated, service_role;
grant all on schema public to postgres, supabase_auth_admin;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
-- MakerKit supabase/schemas/00-privileges.sql
alter default privileges revoke execute on functions from public;
revoke all on schema public from public;
revoke all privileges on schema public from anon;
SQL
export GOTRUE_DB_DRIVER=postgres DATABASE_URL="postgres://supabase_auth_admin@127.0.0.1:5432/postgres" GOTRUE_DB_NAMESPACE=auth \
  GOTRUE_JWT_SECRET=testsecrettestsecrettestsecret123456 API_EXTERNAL_URL=http://127.0.0.1:9999 GOTRUE_SITE_URL=http://127.0.0.1:3000 \
  GOTRUE_DB_MIGRATIONS_PATH=/g/migrations
/g/auth migrate >/tmp/migrate.log 2>&1 || { echo "FAIL gotrue migrate"; tail -3 /tmp/migrate.log; }
q <<'SQL'
-- hosted Supabase lets postgres use the auth schema
grant usage on schema auth to postgres;
grant all on all tables in schema auth to postgres;
grant all on all sequences in schema auth to postgres;
SQL
pass=0; failn=0
ok()   { pass=$((pass+1)); echo "ok   $1"; }
bad()  { failn=$((failn+1)); echo "FAIL $1"; }
chk()  { if [ "$2" = "$3" ]; then ok "$1 -> $2"; else bad "$1 -> got '$2' want '$3'"; fi; }
U() { printf '00000000-0000-0000-0000-%012d' "$1"; }
SESS() { printf '00000000-0000-0000-0000-00000000a%03d' "$1"; }

# --- install: the epoch table, then the canonical hook, as the deployment role ---------------------------------------------
cd /w
[ -f onecode-epoch-table.sql ] && qp -f onecode-epoch-table.sql >/tmp/inst1.log 2>&1
qp -f custom-access-token-hook-oauth-guard.sql >/tmp/inst2.log 2>&1 || { echo "note: installer failed"; head -3 /tmp/inst2.log; }

# --- fixtures ---------------------------------------------------------------------------------------------------------------
A() { psql -qtAX -d postgres -c "set role supabase_auth_admin; $1" 2>&1 | head -2; }
for n in 1 2 3; do
  A "insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
     values ('$(U $n)', 'authenticated', 'authenticated', 'u$n@x.test', now(), now(), now(), '{\"provider\":\"email\",\"providers\":[\"email\"]}', '{}')" >/dev/null
done
T0="2026-11-10 12:00:00+00"
# user 1 is an epoch user (epoch_at T0); users 2 and 3 are not.
qp -c "insert into public.onecode_epoch values ('$(U 1)', '$T0')" >/dev/null 2>&1
sess() { # N USER# CREATED(sql expr)
  A "insert into auth.sessions (id, user_id, created_at, updated_at) values ('$(SESS $1)', '$(U $2)', $3, now())" >/dev/null
}
sess 1 1 "'$T0'::timestamptz - interval '1 hour'"     # old session of the epoch user
sess 2 1 "'$T0'::timestamptz + interval '1 hour'"     # new session of the epoch user
sess 3 1 "null"                                       # session with no created_at
sess 4 2 "now()"                                      # another user's session
sess 5 2 "now()"                                      # non-epoch user's session
OT='[{"method":"otp","timestamp":1}]'

# hk USER# SESSION|none AUTHMETHOD AMR|none -> "ok", "error=<code>:<message prefix>", or "err" if the call itself failed
hk() { id=$(U "$1")
  if [ "$2" = none ]; then sid="'{}'::jsonb"; else sid="jsonb_build_object('session_id','$2')"; fi
  if [ "$4" = none ]; then amr="'{}'::jsonb"; else amr="jsonb_build_object('amr','$4'::jsonb)"; fi
  out=$(printf "set role supabase_auth_admin;\nselect coalesce('error=' || (r->'error'->>'http_code') || ':' || left(r->'error'->>'message', 8), 'ok')
    from (select public.custom_access_token_hook(jsonb_build_object('user_id','$id','authentication_method','$3',
      'claims', jsonb_build_object('sub','$id','aal','aal1','app_metadata','{\"provider\":\"email\"}'::jsonb) || $sid || $amr)) r) s;\n" | psql -qtAX -d postgres 2>&1 | tail -1)
  case "$out" in ok|error=*) echo "$out" ;; *) echo "err" ;; esac
}
R=error=403:This\ acc    # the generic refusal prefix
PW=error=403:Password    # the password refusal prefix
t() { chk "$1" "$(hk "$2" "$3" "$4" "$5")" "$6"; }

echo "== 23 password fence F1 (non-epoch users) and parity"
t "F1 password grant refused"                       2 "$(SESS 5)" password '[{"method":"password","timestamp":1}]' "$PW"
t "F1 token_refresh of a password session refused"  2 "$(SESS 5)" token_refresh '[{"method":"password","timestamp":1}]' "$PW"
t "F1 password beside a fresh otp entry refused"    2 "$(SESS 5)" otp '[{"method":"otp","timestamp":2},{"method":"password","timestamp":1}]' "$PW"
t "F1 password beside totp refused"                 3 none totp '[{"method":"totp","timestamp":2},{"method":"password","timestamp":1}]' "$PW"
t "otp-only still allowed (non-epoch)"              2 "$(SESS 5)" otp "$OT" ok
t "no-amr password event on first-party method"     2 none password none "$R"
grep_guard() {
  bodies=0; carry=0
  for f in /w/*.sql; do
    grep -q 'create or replace function public.custom_access_token_hook' "$f" || continue
    bodies=$((bodies+1))
    if grep -q "a.e->>'method' = 'password'" "$f" && grep -q 'epoch_email_proof' "$f" && grep -q 'public.onecode_epoch' "$f"; then carry=$((carry+1)); fi
  done
  [ "$bodies" -ge 1 ] && [ "$bodies" = "$carry" ] && echo "bodies=$bodies all carry F1 E2 E3" || echo "bodies=$bodies carrying=$carry"
}
chk "grep guard: every hook body carries F1, E2 and E3" "$(grep_guard)" "bodies=1 all carry F1 E2 E3"
[ ! -e /w/custom-access-token-hook.sql ] && ok "SUPERSEDED custom-access-token-hook.sql is deleted" || bad "SUPERSEDED custom-access-token-hook.sql still exists"
exp_writes=$(grep -c -E "'(exp|iat)'|\{exp\}|\{iat\}" /w/custom-access-token-hook-oauth-guard.sql)
chk "hook body never writes exp or iat (premise A1)" "$exp_writes" 0

echo "== 35 E2 renewal fence and E3 email proof only (epoch user 1)"
t "E2 pre-epoch session refused"                    1 "$(SESS 1)" token_refresh "$OT" "$R"
t "E2 post-epoch session allowed"                   1 "$(SESS 2)" otp "$OT" ok
t "E2 missing session_id refused"                   1 none otp "$OT" "$R"
t "E2 non-uuid session_id refused"                  1 not-a-uuid otp "$OT" "$R"
t "E2 unknown session id refused"                   1 "$(SESS 99)" otp "$OT" "$R"
t "E2 session with null created_at refused"         1 "$(SESS 3)" otp "$OT" "$R"
t "E2 another user's session refused"               1 "$(SESS 4)" otp "$OT" "$R"
t "E2 non-epoch user, no session: unaffected"       2 none otp "$OT" ok
S2=$(SESS 2)
t "E3 oauth refused"                                1 "$S2" oauth '[{"method":"oauth","timestamp":1}]' "$R"
t "E3 web3 refused"                                 1 "$S2" token_refresh '[{"method":"web3","timestamp":1}]' "$R"
t "E3 passkey refused"                              1 "$S2" token_refresh '[{"method":"passkey","timestamp":1}]' "$R"
t "E3 anonymous refused"                            1 "$S2" token_refresh '[{"method":"anonymous","timestamp":1}]' "$R"
t "E3 sso/saml refused"                             1 "$S2" token_refresh '[{"method":"sso/saml","timestamp":1}]' "$R"
t "E3 totp alone refused"                           1 "$S2" totp '[{"method":"totp","timestamp":1}]' "$R"
t "E3 empty amr refused"                            1 "$S2" token_refresh '[]' "$R"
t "E3 missing amr refused"                          1 "$S2" token_refresh none "$R"
t "E3 timestamp string refused"                     1 "$S2" otp '[{"method":"otp","timestamp":"1"}]' "$R"
t "E3 timestamp absent refused"                     1 "$S2" otp '[{"method":"otp"}]' "$R"
t "E3 timestamp fractional refused"                 1 "$S2" otp '[{"method":"otp","timestamp":1.5}]' "$R"
t "E3 passkey beside otp refused"                   1 "$S2" otp '[{"method":"otp","timestamp":1},{"method":"passkey","timestamp":2}]' "$R"
t "E3 password beside otp refused (F1 first)"       1 "$S2" otp '[{"method":"otp","timestamp":1},{"method":"password","timestamp":2}]' "$PW"
t "E3 otp allowed"                                  1 "$S2" otp "$OT" ok
t "E3 magiclink + totp allowed"                     1 "$S2" totp '[{"method":"magiclink","timestamp":1},{"method":"totp","timestamp":2}]' ok
t "E3 email/signup allowed"                         1 "$S2" otp '[{"method":"email/signup","timestamp":1}]' ok
t "E3 refresh of an otp session allowed"            1 "$S2" token_refresh "$OT" ok
t "non-epoch user keeps r5: passkey amr allowed"    2 none passkey '[{"method":"passkey","timestamp":1}]' ok
t "non-epoch user keeps r5: oauth refused (guard)"  2 none oauth '[{"method":"oauth","timestamp":1}]' "$R"

echo "== E1 as the deployment role (postgres, not superuser, member of supabase_auth_admin)"
# A second batch of users, sessions and tokens, to see the delete cascade.
for n in 4 5; do
  A "insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
     values ('$(U $n)', 'authenticated', 'authenticated', 'u$n@x.test', now(), now(), now(), '{\"provider\":\"email\"}', '{}')" >/dev/null
done
sess 10 4 "now()"; sess 11 5 "now()"
A "insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values (gen_random_uuid(), '$(SESS 10)', now(), now(), 'passkey');
   insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id) values (null, 'rt-10', '$(U 4)', false, now(), now(), '$(SESS 10)')" >/dev/null
if [ -f onecode-enable-e1.sql ]; then
  PGUSER=postgres psql -X -qtA -d postgres -f onecode-enable-e1.sql >/tmp/e1.log 2>&1; e1=$?
else e1=127; fi
chk "E1 commits" "$e1" 0
chk "E1: every user has an epoch row" "$(q -c "select count(*) from public.onecode_epoch where user_id in (select id from auth.users)" 2>/dev/null)" "$(q -c 'select count(*) from auth.users')"
chk "E1: no session of any user remains" "$(q -c 'select count(*) from auth.sessions' 2>/dev/null)" 0
chk "E1: refresh tokens cascade" "$(q -c "select count(*) from auth.refresh_tokens where user_id = '$(U 4)'" 2>/dev/null)" 0
chk "E1: mfa_amr_claims cascade" "$(q -c 'select count(*) from auth.mfa_amr_claims' 2>/dev/null)" 0

echo "== 39 RLS role regression (the real E1 file ran as postgres above)"
t "hook as supabase_auth_admin: pre-epoch session refused (E2)"  4 none token_refresh "$OT" "$R"
sess 20 4 "(select epoch_at from public.onecode_epoch where user_id = '$(U 4)') + interval '1 minute'"
sess 21 4 "(select epoch_at from public.onecode_epoch where user_id = '$(U 4)') - interval '1 minute'"
t "epoch user, amr [passkey] on a post-epoch session refused (E3)" 4 "$(SESS 20)" token_refresh '[{"method":"passkey","timestamp":1}]' "$R"
t "epoch user, amr [otp] on a post-epoch session allowed"        4 "$(SESS 20)" otp "$OT" ok
t "epoch user, amr [otp] on a pre-epoch session refused"         4 "$(SESS 21)" otp "$OT" "$R"
chk "hook role sees every epoch row (RLS read policy)" "$(printf "set role supabase_auth_admin;\nselect count(*) from public.onecode_epoch;\n" | psql -qtAX -d postgres 2>&1 | tail -1)" "$(q -c 'select count(*) from public.onecode_epoch')"
sqlstate() { out=$(printf '\\set VERBOSITY sqlstate\nbegin;\nset role %s;\n%s;\nrollback;\n' "$1" "$2" | psql -qtAX -d postgres 2>&1 >/dev/null | head -1)
  case "$out" in "") echo ok ;; *) echo "$out" | sed -n 's/^.*ERROR: *\([0-9A-Z]\{5\}\).*$/\1/p' ;; esac; }
for r in anon authenticated service_role; do chk "$r select on onecode_epoch denied" "$(sqlstate $r 'select count(*) from public.onecode_epoch')" 42501; done
for p in "insert into public.onecode_epoch values ('$(U 3)', now())" "update public.onecode_epoch set epoch_at = now()" "delete from public.onecode_epoch" "truncate public.onecode_epoch"; do
  chk "supabase_auth_admin denied: $(echo "$p" | cut -d' ' -f1-3)" "$(sqlstate supabase_auth_admin "$p")" 42501
done
chk "hook role is not BYPASSRLS" "$(q -c "select rolbypassrls from pg_roles where rolname = 'supabase_auth_admin'")" f
chk "postgres is not a superuser" "$(q -c "select rolsuper from pg_roles where rolname = 'postgres'")" f
chk "epoch table: RLS on, not forced" "$(q -c "select relrowsecurity::text || ',' || relforcerowsecurity::text from pg_class where oid = 'public.onecode_epoch'::regclass" 2>/dev/null)" "true,false"
chk "epoch table: exactly one policy" "$(q -c "select count(*) || ',' || min(polname) || ',' || min(pg_get_expr(polqual, polrelid)) from pg_policy where polrelid = 'public.onecode_epoch'::regclass" 2>/dev/null)" "1,onecode_epoch_auth_read,true"
chk "auth.sessions owner is supabase_auth_admin" "$(q -c "select pg_get_userbyid(relowner) from pg_class where oid = 'auth.sessions'::regclass")" supabase_auth_admin
# The table file repairs drift: a stray grant and a stray policy are removed, and the state ends exactly as intended.
qp -c "grant select on public.onecode_epoch to authenticated; create policy stray on public.onecode_epoch for select to authenticated using (true)" >/dev/null 2>&1
chk "drift: authenticated can read before the repair" "$(sqlstate authenticated 'select count(*) from public.onecode_epoch')" ok
qp -f onecode-epoch-table.sql >/dev/null 2>&1
chk "drift repaired: authenticated select denied again" "$(sqlstate authenticated 'select count(*) from public.onecode_epoch')" 42501
chk "drift repaired: exactly one policy" "$(q -c "select count(*) from pg_policy where polrelid = 'public.onecode_epoch'::regclass")" 1
# The E1 self-check fires when the policy is missing: a copy of E1 without the table setup, policy dropped first.
if [ -f onecode-enable-e1.sql ]; then
  grep -v '^\\ir onecode-epoch-table.sql' onecode-enable-e1.sql > /tmp/e1-nopolicy.sql
  qp -c "drop policy onecode_epoch_auth_read on public.onecode_epoch" >/dev/null 2>&1
  before=$(q -c "select count(*) from public.onecode_epoch where epoch_at > now() - interval '1 minute'")
  PGUSER=postgres psql -X -qtA -d postgres -f /tmp/e1-nopolicy.sql >/tmp/e1b.log 2>&1; e1b=$?
  [ "$e1b" != 0 ] && grep -q 'self-check' /tmp/e1b.log && ok "E1 self-check rolls back when the read policy is missing" || bad "E1 self-check did not fire (exit $e1b)"
  chk "  and nothing of that run remains (epoch rows unchanged)" "$(q -c "select count(*) from public.onecode_epoch where epoch_at > now() - interval '1 minute'")" "$before"
  qp -f onecode-epoch-table.sql >/dev/null 2>&1   # restore the policy
else bad "E1 self-check (no E1 file)"; fi

echo "== 40 open-window issuance: E1 open on connection A, issuance on connection B"
sess 30 1 "'$T0'::timestamptz + interval '2 hours'"   # a user-1 session that exists before the second E1
if [ -f onecode-enable-e1.sql ]; then
  # A: the real E1 file with a pause after the DELETE (an advisory lock B holds); B: inserts a session and runs the hook.
  sed -e "s/^-- E1-AFTER-DELETE.*/select pg_advisory_lock(7770001); select pg_advisory_unlock(7770001);/" -e 's#^\\ir onecode-epoch-table.sql#\\ir /w/onecode-epoch-table.sql#' onecode-enable-e1.sql > /tmp/e1-paused.sql
  # The user for this case is created fresh, so it has no epoch row until A commits.
  A "insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
     values ('$(U 6)', 'authenticated', 'authenticated', 'u6@x.test', now(), now(), now(), '{\"provider\":\"email\"}', '{}')" >/dev/null
  mkfifo /tmp/bfifo
  ( PGUSER=supabase_admin psql -qtAX -d postgres < /tmp/bfifo > /tmp/b.out 2>&1 ) &
  BPID=$!
  exec 7>/tmp/bfifo
  printf "select pg_advisory_lock(7770001);\n" >&7
  sleep 2
  ( cd /w && PGUSER=postgres psql -X -qtA -d postgres -f /tmp/e1-paused.sql >/tmp/a.out 2>&1 ) &
  APID=$!
  sleep 3
  # B: A is paused after its DELETE, uncommitted. B inserts a session for user 6 and runs the hook: no epoch row visible yet.
  A "insert into auth.sessions (id, user_id, created_at, updated_at) values ('$(SESS 40)', '$(U 6)', now(), now())" >/dev/null
  chk "open window: hook run by B sees no epoch row for user 6 (passkey amr allowed, as designed)" "$(hk 6 "$(SESS 40)" token_refresh '[{"method":"passkey","timestamp":1}]')" ok
  printf "select pg_advisory_unlock(7770001);\n" >&7
  exec 7>&-
  wait $APID; wait $BPID
  chk "A committed" "$(grep -c 'E1 inserted' /tmp/a.out)" 1
  [ "$(grep -c 'E1 inserted' /tmp/a.out)" = 1 ] || { echo "note: A output:"; head -5 /tmp/a.out; }
  # After the commit: B's session (created after the DELETE's snapshot, at or after epoch_at is NOT guaranteed here: it was
  # created before commit but epoch_at is the transaction start) is refused by E3 or E2.
  chk "after commit: B's passkey-method refresh is refused (E3)" "$(hk 6 "$(SESS 40)" token_refresh '[{"method":"passkey","timestamp":1}]')" "$R"
  chk "after commit: the epoch row for user 6 exists" "$(q -c "select count(*) from public.onecode_epoch where user_id = '$(U 6)'")" 1
else bad "open-window case (no E1 file)"; fi

echo "== 38 gate d inventory (GoTrue-migrated schema)"
inv() { PGUSER=postgres psql -X -qtA -F '|' -d postgres -f /w/onecode-gate-d-inventory.sql 2>&1; }
hit() { inv | sed -n "s/^$1|//p"; }
if [ -f onecode-gate-d-inventory.sql ]; then
  # A clean epoch: wipe sessions and credentials of every user, re-run E1, then read.
  q -c "delete from auth.sessions; delete from auth.webauthn_credentials; delete from auth.mfa_factors; delete from auth.identities where provider <> 'email'; update auth.users set phone = null, phone_change = '', email_change = '', email_change_token_new = ''" >/dev/null 2>&1
  PGUSER=postgres psql -X -qtA -d postgres -f onecode-enable-e1.sql >/dev/null 2>&1
  # Audit evidence that reaches back before every epoch user was created (one older entry), so an empty log is not a hit here.
  q -c "delete from auth.audit_log_entries; insert into auth.audit_log_entries (instance_id, id, payload, created_at) values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), '{\"action\":\"login\",\"actor_id\":\"$(U 9)\"}', now() - interval '1 day')" >/dev/null 2>&1
  chk "clean epoch: HITS" "$(hit HITS)" 0
  # r8 Astra High 1: a COMPLETED email change leaves no pending change (GoTrue clears email_change and keeps email_change_sent_at,
  # writes a user_modified audit entry with no traits). The account must still be a hit.
  q -c "update auth.users set email_change_sent_at = now() where id = '$(U 1)'" >/dev/null
  chk "historically redirected account, no pending change: email_change_ever_requested" "$(hit email_change_ever_requested)" 1
  H=$(hit HITS); [ "${H:-0}" -ge 1 ] && ok "historically redirected account, no pending change: HITS >= 1 -> $H" || bad "historically redirected account, no pending change: HITS >= 1 -> got '$H'"
  q -c "update auth.users set email_change_sent_at = null where id = '$(U 1)'" >/dev/null
  chk "reset: HITS" "$(hit HITS)" 0
  q -c "insert into auth.audit_log_entries (instance_id, id, payload, created_at) values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), '{\"action\":\"user_modified\",\"actor_id\":\"$(U 2)\"}', now())" >/dev/null
  chk "a user_modified audit entry for an epoch user: reported" "$(hit audit_user_modified_epoch_users)" 1
  chk "  HITS" "$(hit HITS)" 1
  q -c "delete from auth.audit_log_entries where payload->>'action' = 'user_modified'" >/dev/null
  q -c "insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at) values ('u3@x.test', '$(U 3)', '{\"sub\":\"$(U 3)\",\"email\":\"older@x.test\"}', 'email', now(), now())" >/tmp/idn.log 2>&1 || { echo "note: identity insert"; head -2 /tmp/idn.log; }
  chk "email differs from the email identity: reported" "$(hit email_differs_from_email_identity)" 1
  q -c "delete from auth.identities where user_id = '$(U 3)'" >/dev/null
  q -c "delete from auth.audit_log_entries" >/dev/null
  chk "no audit evidence at all: reported as a hit (insufficient evidence)" "$(hit audit_coverage_gap_epoch_users)" "$(q -c "select count(*) from public.onecode_epoch")"
  chk "  HITS (one check row nonzero)" "$(hit HITS)" 1
  q -c "insert into auth.audit_log_entries (instance_id, id, payload, created_at) values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), '{\"action\":\"login\",\"actor_id\":\"$(U 9)\"}', now() - interval '1 day')" >/dev/null
  chk "evidence restored: HITS" "$(hit HITS)" 0
  EP=$(q -c "select max(epoch_at) from public.onecode_epoch")
  A "insert into auth.sessions (id, user_id, created_at, updated_at) values ('$(SESS 50)', '$(U 1)', '$EP'::timestamptz + interval '1 second', now())" >/dev/null
  A "insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) values (gen_random_uuid(), '$(SESS 50)', now(), now(), 'passkey')" >/dev/null
  chk "post-epoch session with a passkey amr claim: reported" "$(hit sessions_amr_outside_E_S_or_no_E)" 1
  chk "  HITS" "$(hit HITS)" 1
  A "insert into auth.sessions (id, user_id, created_at, updated_at) values ('$(SESS 51)', '$(U 2)', '$EP'::timestamptz - interval '1 second', now())" >/dev/null
  chk "session older than the epoch: reported" "$(hit sessions_before_epoch)" 1
  q -c "insert into auth.webauthn_credentials (id, user_id, credential_id, public_key, attestation_type, aaguid, sign_count, transports, backup_eligible, backed_up, friendly_name, created_at, updated_at)
        values (gen_random_uuid(), '$(U 3)', 'cred'::bytea, 'pk'::bytea, 'none', '00000000-0000-0000-0000-000000000000', 0, '[]', false, false, 'k', now(), now())" >/tmp/wc.log 2>&1 \
    || q -c "insert into auth.webauthn_credentials (user_id, credential_id, public_key) values ('$(U 3)', 'cred'::bytea, 'pk'::bytea)" >>/tmp/wc.log 2>&1
  chk "one seeded webauthn_credentials row: reported" "$(hit webauthn_credentials)" 1
  q -c "update auth.users set phone = '+15550100' where id = '$(U 3)'" >/dev/null
  chk "a confirmed phone: reported" "$(hit users_with_phone_or_phone_change)" 1
  q -c "update auth.users set email_change = 'new@x.test' where id = '$(U 2)'" >/dev/null
  chk "a pending email_change: reported" "$(hit users_with_pending_email_change)" 1
  chk "five seeded problems: HITS" "$(hit HITS)" 5
  chk "the read is read-only (no writes)" "$(PGUSER=postgres psql -X -qtA -d postgres -c "begin read only; select 1" 2>&1 | head -1)" 1
else bad "gate d inventory (no file)"; fi

echo "== rollback: epoch rows removed, nothing else reversed"
if [ -f onecode-enable-rollback.sql ]; then
  sessions_before=$(q -c 'select count(*) from auth.sessions')
  PGUSER=postgres psql -X -qtA -d postgres -f onecode-enable-rollback.sql >/tmp/rb.log 2>&1; rb=$?
  chk "rollback commits" "$rb" 0
  chk "rollback: epoch rows gone" "$(q -c 'select count(*) from public.onecode_epoch')" 0
  t "rollback: an epoch-era user's passkey method is allowed again (no E3)" 1 none passkey '[{"method":"passkey","timestamp":1}]' ok
  t "rollback: password is still refused (F1 stays)" 1 none password '[{"method":"password","timestamp":1}]' "$PW"
  chk "rollback does not restore deleted sessions" "$(q -c 'select count(*) from auth.sessions')" "$sessions_before"
  chk "rollback keeps the table, policy and grants" "$(q -c "select count(*) from pg_policy where polrelid = 'public.onecode_epoch'::regclass")" 1
else bad "rollback (no file)"; fi

echo "reviewed hook body (md5 of pg_proc.prosrc, chars): $(q -c "select md5(prosrc) || ' ' || length(prosrc) from pg_proc where oid = 'public.custom_access_token_hook(jsonb)'::regprocedure" 2>/dev/null)"
echo "ONECODE-HOOK-PG: passed $pass failed $failn"
[ "$failn" = 0 ]
