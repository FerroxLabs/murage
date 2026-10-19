#!/bin/sh
# Runs custom-access-token-hook-oauth-guard.sql against a real Postgres with Supabase's roles, auth.users and
# auth.identities shaped like Supabase's, Supabase's default function grants and MakerKit's revocations. Users and
# identities are written AS supabase_auth_admin in the order Supabase Auth writes them (user row with app_metadata
# provider and user_metadata sub, then the identity; linking adds an identity and rewrites app_metadata.provider).
# Run inside postgres:16-alpine with --network none:
#   docker run --rm --network none -v "$PWD":/w postgres:16-alpine sh /w/hook-oauth-guard-pg-test.sh
set -eu
export PGDATA=/tmp/pg PGUSER=postgres
mkdir -p "$PGDATA" && chown postgres "$PGDATA"
su postgres -c "initdb -A trust -D $PGDATA >/dev/null && pg_ctl -D $PGDATA -o '-c listen_addresses=' -w start >/dev/null"
q() { psql -v ON_ERROR_STOP=1 -qtAX -d postgres "$@"; }
q <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create role supabase_auth_admin nologin;
create schema auth authorization supabase_auth_admin;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, created_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb);
create table auth.identities (id uuid primary key default gen_random_uuid(), provider_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade, identity_data jsonb not null, provider text not null,
  created_at timestamptz default now(), last_sign_in_at timestamptz,
  email text generated always as (lower(identity_data->>'email')) stored,
  unique (provider_id, provider));
alter table auth.users owner to supabase_auth_admin;
alter table auth.identities owner to supabase_auth_admin;
create table auth.flow_state (id uuid primary key, user_id uuid, auth_code text not null, provider_type text not null,
  created_at timestamptz default now());
alter table auth.flow_state owner to supabase_auth_admin;
-- auth.mfa_factors and auth.sessions as Supabase Auth defines them (migrations 20221003041349_add_mfa_schema,
-- 20221003041400_add_aal_and_factor_id_to_sessions): sessions.factor_id is the factor that last verified the session.
create type auth.aal_level as enum ('aal1', 'aal2', 'aal3');
create type auth.factor_type as enum ('totp', 'webauthn', 'phone');
create type auth.factor_status as enum ('unverified', 'verified');
create table auth.mfa_factors (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  friendly_name text, factor_type auth.factor_type not null, status auth.factor_status not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(), updated_at timestamptz default now(), factor_id uuid null, aal auth.aal_level null);
alter table auth.mfa_factors owner to supabase_auth_admin;
alter table auth.sessions owner to supabase_auth_admin;
-- Hosted Supabase: the API roles have usage on schema public (supabase/postgres initial schema), and its default
-- grants on new public functions.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
-- MakerKit supabase/schemas/00-privileges.sql
alter default privileges revoke execute on functions from public;
revoke all on schema public from public;
revoke all privileges on schema public from anon;
-- A user created before the guard was installed (no provenance row).
insert into auth.users values ('00000000-0000-0000-0000-000000000097', 'old@x.test', now(), now(),
  '{"provider":"google","providers":["google"]}', '{"sub":"g-old"}');
insert into auth.identities (provider_id, user_id, identity_data, provider)
  values ('g-old', '00000000-0000-0000-0000-000000000097', '{"sub":"g-old","email":"old@x.test"}', 'google');
SQL
q -f /w/custom-access-token-hook-oauth-guard.sql

# Supabase Auth's writes, as supabase_auth_admin. U n = user uuid n.
A() { q -c "set role supabase_auth_admin; $1"; }
U() { printf '00000000-0000-0000-0000-%012d' "$1"; }
# signup N PROVIDER SUB EMAIL [confirmed]: user row (app_metadata provider, user_metadata = provider claims), then
# its identity (email: provider_id = user id).
signup() {
  id=$(U "$1"); conf=${5:-now()}
  if [ "$2" = email ]; then meta="'{\"sub\":\"forged-sub\",\"name\":\"x\"}'"; pid=$id; else meta="'{\"sub\":\"$3\",\"email\":\"$4\"}'"; pid=$3; fi
  A "insert into auth.users values ('$id', '$4', $conf, now(), '{\"provider\":\"$2\",\"providers\":[\"$2\"]}', $meta);
     insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ('$pid', '$id', jsonb_build_object('sub', '$pid', 'email', '$4', 'email_verified', true), '$2');"
}
# link N PROVIDER SUB EMAIL: DetermineAccountLinking LinkAccount (new identity, then UpdateAppMetaDataProviders).
link_sql() {
  echo "insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ('$3', '$(U "$1")', jsonb_build_object('sub', '$3', 'email', '$4', 'email_verified', true), '$2');
     update auth.users set raw_app_meta_data = raw_app_meta_data || '{\"provider\":\"$2\"}' where id = '$(U "$1")';"
}
link() { A "$(link_sql "$@")"; }
fail=0
# sqlstate ROLE SQL -> the SQLSTATE of the first error, or "ok"; always rolled back.
sqlstate() {
  out=$(printf '\\set VERBOSITY sqlstate\nbegin;\nset role %s;\n%s;\nrollback;\n' "$1" "$2" | psql -qtAX -d postgres 2>&1 >/dev/null | head -1)
  case "$out" in "") echo ok ;; *) echo "$out" | sed -n 's/^.*ERROR: *\([0-9A-Z]\{5\}\).*$/\1/p' ;; esac
}
# refused_link N PROVIDER SUB EMAIL: Supabase Auth's link, as supabase_auth_admin, must raise 42501 at the identity
# insert (the guard), and nothing of it may remain. Then the same identity is planted with the guard disabled, as a
# row from before the guard, so the token hook's own refusal is still exercised.
refused_link() {
  got=$(sqlstate supabase_auth_admin "$(link_sql "$@")")
  n=$(q -c "select count(*) from auth.identities where provider = '$2' and provider_id = '$3'")
  if [ "$got" = 42501 ] && [ "$n" = 0 ]; then echo "ok   guard refuses linking $2/$3 to user $1"; else echo "FAIL guard let $2/$3 link to user $1 ($got, $n)"; fail=1; fi
  q -c "alter table auth.identities disable trigger murage_guard_identity_link"
  link "$@"
  q -c "alter table auth.identities enable trigger murage_guard_identity_link"
}

signup 1  email  -       e1@thirdparty.test                       # email-only
signup 2  google g2      a@gmail.com                              # Google-created
signup 3  google g3      b@thirdparty.test                        # Google-created on a third-party address
link   3  email  "$(U 3)" b@thirdparty.test                       #   later got an email identity too
signup 4  apple  a4      x4@privaterelay.appleid.com              # Apple relay
signup 5  azure  m5      a@outlook.com                            # Microsoft
signup 6  email  -       e6@thirdparty.test                       # email, then Google auto-linked
refused_link 6  google g6      e6@thirdparty.test
signup 7  google g7      c@thirdparty.test                        # Google-created, then a second Google identity
refused_link 7  google g7b     c@thirdparty.test
signup 8  email  -       e8@thirdparty.test                       # attacker Google identity linked, then its email
refused_link 8  google g8      e8@thirdparty.test                 #   changes to a Gmail address (provider+sub kept)
A "update auth.identities set identity_data = identity_data || '{\"email\":\"attacker@gmail.com\"}'
   where provider = 'google' and provider_id = 'g8'"
signup 9  email  -       e9@thirdparty.test null                  # Astra #2: unconfirmed email sign-up, OAuth link
refused_link 9  google g9      e9@thirdparty.test                 #   removes the unconfirmed identities and confirms
A "delete from auth.identities where user_id = '$(U 9)' and provider = 'email';
   update auth.users set email_confirmed_at = now() where id = '$(U 9)'"
signup 10 google g10     d@thirdparty.test                        # Google-created, own Google email changes later
A "update auth.identities set identity_data = identity_data || '{\"email\":\"d2@thirdparty.test\"}' where provider_id = 'g10'"
signup 11 google g11     f@thirdparty.test                        # Google-created; creation identity gone, another
refused_link 11 google g11b    f@thirdparty.test                  #   Google identity remains
A "delete from auth.identities where provider_id = 'g11'"
signup 12 google g12     h@thirdparty.test                        # Google-created, then a phone identity
link   12 phone  p12     h@thirdparty.test
# Created by a provider not on the list: the identity insert raises, so the whole sign-up rolls back (no user).
got=$(sqlstate supabase_auth_admin "insert into auth.users values ('$(U 13)', 'i@thirdparty.test', now(), now(), '{\"provider\":\"github\"}', '{\"sub\":\"gh13\"}');
  insert into auth.identities (provider_id, user_id, identity_data, provider) values ('gh13', '$(U 13)', '{\"sub\":\"gh13\"}', 'github')")
[ "$got" = 42501 ] && echo "ok   github sign-up refused at the identity insert" || { echo "FAIL github sign-up $got"; fail=1; }
signup 14 google g14     j@thirdparty.test                        # Google-created + Apple linked
refused_link 14 apple  a14     j@thirdparty.test
A "insert into auth.users values ('$(U 15)', 'admin@x.test', now(), now(), '{\"provider\":\"google\"}', '{}')"  # admin-made, no sub
signup 99 email  -       u@x.test null                            # unconfirmed email user

# tok ROLE USER# AUTH_METHOD AMR_JSON -> "verified=<bool>" or "error=<http_code>"
tok() {
  id=$(U "$2")
  if [ "$4" = none ]; then amr="'{}'::jsonb"; else amr="jsonb_build_object('amr', '$4'::jsonb)"; fi
  q -c "set role $1; select coalesce('error=' || (r->'error'->>'http_code'), 'verified=' || (r->'claims'->'app_metadata'->>'email_verified'))
        from (select public.custom_access_token_hook(jsonb_build_object('user_id','$id','authentication_method','$3',
          'claims', jsonb_build_object('sub','$id','aal','aal1','app_metadata', '{\"provider\":\"email\"}'::jsonb)
                    || $amr)) r) s"
}
# Astra MAKERKIT5 #1: the PKCE callback. Supabase commits the new identity and the flow state's user_id/auth code in
# ONE transaction (external.go lines 216-261). The guard's raise rolls back both, so no code exists to retry after
# support removes anything; and there is no identity to remove.
q -c "insert into auth.flow_state (id, auth_code, provider_type) values ('00000000-0000-0000-0000-0000000f1003', 'code-attacker', 'google')"
got=$(sqlstate supabase_auth_admin "$(link_sql 2 google g2-attacker a@gmail.com)
  update auth.flow_state set user_id = '$(U 2)' where id = '00000000-0000-0000-0000-0000000f1003'")
fs=$(q -c "select coalesce(user_id::text, 'null') from auth.flow_state where id = '00000000-0000-0000-0000-0000000f1003'")
n=$(q -c "select count(*) from auth.identities where provider_id = 'g2-attacker'")
if [ "$got" = 42501 ] && [ "$fs" = null ] && [ "$n" = 0 ]; then echo "ok   PKCE callback linking an attacker identity: rolled back, flow state never bound to the victim"
else echo "FAIL PKCE callback $got flow_state.user_id=$fs identities=$n"; fail=1; fi
# Delete the creation identity (support's old 'recovery'), then retry: still nothing bound, OAuth still refused for
# a new identity; a re-link of the creation identity itself is allowed (same user, provider, subject).
got=$(sqlstate supabase_auth_admin "$(link_sql 2 google g2-attacker a@gmail.com)")
[ "$got" = 42501 ] && echo "ok   retry of the attacker link refused again" || { echo "FAIL retry $got"; fail=1; }
got=$(sqlstate supabase_auth_admin "update auth.identities set user_id = '$(U 2)' where provider_id = 'g10'")
[ "$got" = 42501 ] && echo "ok   moving another user's identity onto the victim refused" || { echo "FAIL move $got"; fail=1; }
got=$(sqlstate supabase_auth_admin "update auth.identities set identity_data = identity_data || '{\"name\":\"n\"}', last_sign_in_at = now() where provider_id = 'g8'")
[ "$got" = ok ] && echo "ok   sign-in refresh of an existing identity's data still allowed" || { echo "FAIL identity_data update $got"; fail=1; }
got=$(sqlstate supabase_auth_admin "delete from auth.identities where provider_id = 'g2'; $(link_sql 2 google g2 a@gmail.com)")
[ "$got" = ok ] && echo "ok   the creation identity itself can be linked again" || { echo "FAIL creation identity relink $got"; fail=1; }

raw() { q -c "set role supabase_auth_admin; select coalesce('error=' || (r->'error'->>'http_code'), 'verified=' || (r->'claims'->'app_metadata'->>'email_verified')) from (select public.custom_access_token_hook($1) r) s"; }
OA='[{"method":"oauth","timestamp":1}]'; OT='[{"method":"otp","timestamp":1}]'
MIX='[{"method":"totp","timestamp":2},{"method":"oauth","timestamp":1}]'; OTP2='[{"method":"totp","timestamp":2},{"method":"otp","timestamp":1}]'
t() { got=$(tok supabase_auth_admin "$2" "$3" "$4"); if [ "$got" = "$5" ]; then echo "ok   $1 -> $got"; else echo "FAIL $1 -> $got (want $5)"; fail=1; fi; }
r() { got=$(raw "$2"); if [ "$got" = "$3" ]; then echo "ok   $1 -> $got"; else echo "FAIL $1 -> $got (want $3)"; fail=1; fi; }
t "email-only: otp"                                      1 otp "$OT" verified=true
t "email-only: magic link"                               1 magiclink '[{"method":"magiclink","timestamp":1}]' verified=true
t "email-only: refresh of email session"                 1 token_refresh "$OT" verified=true
t "email-only: totp step-up on email session"            1 totp "$OTP2" verified=true
t "email-only: oauth session refused"                    1 oauth "$OA" error=403
t "google-created: oauth"                                2 oauth "$OA" verified=true
t "google-created: refresh of oauth session"             2 token_refresh "$OA" verified=true
t "google-created: oauth after totp step-up"             2 totp "$MIX" verified=true
t "google-created: otp"                                  2 otp "$OT" verified=true
t "google-created + one email identity: oauth"           3 oauth "$OA" verified=true
t "apple relay created: oauth"                           4 oauth "$OA" verified=true
t "microsoft created: oauth"                             5 oauth "$OA" verified=true
t "microsoft created: refresh"                           5 token_refresh "$OA" verified=true
t "email then google autolink: oauth refused"            6 oauth "$OA" error=403
t "  same: refresh of oauth session refused"             6 token_refresh "$OA" error=403
t "  same: totp step-up on oauth session refused"        6 totp "$MIX" error=403
t "  same: otp allowed"                                  6 otp "$OT" verified=true
t "  same: refresh of email session allowed"             6 token_refresh "$OT" verified=true
t "google-created + second google identity: refused"     7 oauth "$OA" error=403
t "  same: otp allowed"                                  7 otp "$OT" verified=true
t "attacker identity email -> gmail: still refused"      8 oauth "$OA" error=403
t "unconfirmed signup, email removed by link: refused"   9 oauth "$OA" error=403
t "  same: otp allowed"                                  9 otp "$OT" verified=true
t "google-created, own google email changed: oauth"     10 oauth "$OA" verified=true
t "creation identity gone, other google: refused"       11 oauth "$OA" error=403
t "google-created + phone identity: refused"            12 oauth "$OA" error=403
t "github-created (not on list): refused"               13 oauth "$OA" error=403
t "google-created + apple linked: refused"              14 oauth "$OA" error=403
t "admin-made provider google, no sub: refused"         15 oauth "$OA" error=403
t "created before the guard (no record): oauth refused" 97 oauth "$OA" error=403
t "  same: otp allowed"                                 97 otp "$OT" verified=true
t "unconfirmed email user: otp"                         99 otp "$OT" verified=false
# Missing or malformed amr / authentication_method = OAuth session.
t "email-only: missing amr refused"                      1 token_refresh none error=403
t "email-only: empty amr refused"                        1 token_refresh '[]' error=403
t "email-only: amr [{}] refused"                         1 token_refresh '[{}]' error=403
t "email-only: amr not an array refused"                 1 token_refresh '{"method":"otp"}' error=403
t "email-only: amr string entry refused"                 1 token_refresh '["otp"]' error=403
t "email-only: amr method not a string refused"          1 token_refresh '[{"method":1}]' error=403
t "email-only: unknown amr method refused"               1 token_refresh '[{"method":"web3","timestamp":1}]' error=403
t "email-only: otp + oauth in amr refused"               1 otp '[{"method":"otp"},{"method":"oauth"}]' error=403
t "email-only: unknown authentication_method refused"    1 anonymous "$OT" error=403
t "email-only: empty authentication_method refused"      1 '' "$OT" error=403
# Astra MAKERKIT5 #2: an amr entry without an integer timestamp is malformed and never exempt.
t "email-only: amr timestamp absent refused"             1 otp '[{"method":"otp"}]' error=403
t "email-only: amr timestamp null refused"               1 otp '[{"method":"otp","timestamp":null}]' error=403
t "email-only: amr timestamp string refused"             1 otp '[{"method":"otp","timestamp":"invalid"}]' error=403
t "email-only: amr timestamp numeric string refused"     1 token_refresh '[{"method":"otp","timestamp":"1"}]' error=403
t "email-only: amr timestamp fractional refused"         1 otp '[{"method":"otp","timestamp":1.5}]' error=403
t "email-only: one good, one timestamp-less refused"     1 totp '[{"method":"totp","timestamp":2},{"method":"otp"}]' error=403
t "email-only: integer-valued 1.0 timestamp allowed"     1 otp '[{"method":"otp","timestamp":1.0}]' verified=true
t "google-created: timestamp-less amr takes the provenance branch" 2 otp '[{"method":"otp"}]' verified=true
t "google-created: missing amr allowed"                  2 token_refresh none verified=true
G=$(U 2)
r "missing authentication_method (email user)" "jsonb_build_object('user_id','$(U 1)','claims',jsonb_build_object('sub','$(U 1)','amr','$OT'::jsonb))" error=403
r "missing user_id"           "jsonb_build_object('authentication_method','otp','claims',jsonb_build_object('sub','$G','amr','$OT'::jsonb))" error=403
r "user_id not a uuid"        "jsonb_build_object('user_id','nope','authentication_method','otp','claims',jsonb_build_object('sub','nope','amr','$OT'::jsonb))" error=403
r "user_id a number"          "jsonb_build_object('user_id',1,'authentication_method','otp','claims',jsonb_build_object('sub','$G','amr','$OT'::jsonb))" error=403
r "missing claims"            "jsonb_build_object('user_id','$G','authentication_method','otp')" error=403
r "claims not an object"      "jsonb_build_object('user_id','$G','authentication_method','otp','claims','[]'::jsonb)" error=403
r "claims.sub missing"        "jsonb_build_object('user_id','$G','authentication_method','otp','claims',jsonb_build_object('amr','$OT'::jsonb))" error=403
r "claims.sub another user"   "jsonb_build_object('user_id','$G','authentication_method','otp','claims',jsonb_build_object('sub','$(U 1)','amr','$OT'::jsonb))" error=403
r "unknown user"              "jsonb_build_object('user_id','$(U 98)','authentication_method','otp','claims',jsonb_build_object('sub','$(U 98)','amr','$OT'::jsonb))" error=403
r "event not an object"       "'[]'::jsonb" error=403
r "event null"                "'null'::jsonb" error=403
r "app_metadata not an object kept safe" "jsonb_build_object('user_id','$G','authentication_method','otp','claims',jsonb_build_object('sub','$G','amr','$OT'::jsonb,'app_metadata','[]'::jsonb))" verified=true
# The refusal is Supabase's hook error shape: {"error":{"http_code":403,"message":...}} and no claims.
shape=$(q -c "set role supabase_auth_admin; select (r ? 'claims')::text || ',' || (r->'error'->>'message' <> '')::text from (select public.custom_access_token_hook(jsonb_build_object('user_id','$(U 6)','authentication_method','oauth','claims',jsonb_build_object('sub','$(U 6)','amr','$OA'::jsonb))) r) s")
[ "$shape" = "false,true" ] && echo "ok   refusal has error.message and no claims" || { echo "FAIL refusal shape $shape"; fail=1; }
# Provenance is recorded at insert and is not changed by linking (app_metadata.provider was rewritten to google).
prov=$(q -c "select provider || '/' || provider_id from murage_auth.user_creation where user_id = '$(U 6)'")
[ "$prov" = "email/" ] && echo "ok   user 6 provenance stays email" || { echo "FAIL user 6 provenance $prov"; fail=1; }
prov=$(q -c "select raw_app_meta_data->>'provider' from auth.users where id = '$(U 6)'")
[ "$prov" = "google" ] && echo "ok   user 6 app_metadata.provider rewritten to google (not used)" || { echo "FAIL app_metadata $prov"; fail=1; }
# Grants (Astra MAKERKIT5 #3): asserted with has_*_privilege, and each denial probe is a valid statement that fails
# with SQLSTATE 42501 on the intended object, with the API roles holding usage on schema public as on hosted Supabase.
priv() { got=$(q -c "select $2"); if [ "$got" = "$3" ]; then echo "ok   $1 = $3"; else echo "FAIL $1 = $got (want $3)"; fail=1; fi; }
st() { got=$(sqlstate "$2" "$3"); if [ "$got" = "$4" ]; then echo "ok   $1 -> $got"; else echo "FAIL $1 -> $got (want $4)"; fail=1; fi; }
HOOK="'public.custom_access_token_hook(jsonb)'"
EV="jsonb_build_object('user_id','$(U 1)','authentication_method','otp','claims',jsonb_build_object('sub','$(U 1)','amr','$OT'::jsonb))"
for role in anon authenticated service_role; do
  priv "$role execute hook"              "has_function_privilege('$role', $HOOK, 'execute')" f
  priv "$role execute trigger fn"        "has_function_privilege('$role', 'murage_auth.record_user_creation()', 'execute')" f
  priv "$role execute guard fn"          "has_function_privilege('$role', 'murage_auth.guard_identity_link()', 'execute')" f
  priv "$role usage murage_auth"         "has_schema_privilege('$role', 'murage_auth', 'usage')" f
  for p in select insert update delete; do
    priv "$role $p provenance"           "has_table_privilege('$role', 'murage_auth.user_creation', '$p')" f
  done
done
for role in authenticated service_role; do
  priv "$role usage public (hosted)"     "has_schema_privilege('$role', 'public', 'usage')" t
  st "$role calls the hook (valid event)" "$role" "select public.custom_access_token_hook($EV)" 42501
  # User 97 has no provenance row, so this insert is valid apart from the privilege.
  st "$role inserts provenance (valid row)" "$role" "insert into murage_auth.user_creation (user_id, provider, provider_id) values ('$(U 97)', 'google', 'g-old')" 42501
done
priv "auth admin execute hook"           "has_function_privilege('supabase_auth_admin', $HOOK, 'execute')" t
priv "auth admin usage murage_auth"      "has_schema_privilege('supabase_auth_admin', 'murage_auth', 'usage')" t
priv "auth admin select provenance"      "has_table_privilege('supabase_auth_admin', 'murage_auth.user_creation', 'select')" t
priv "auth admin insert provenance"      "has_table_privilege('supabase_auth_admin', 'murage_auth.user_creation', 'insert')" t
priv "auth admin update provenance"      "has_table_privilege('supabase_auth_admin', 'murage_auth.user_creation', 'update')" f
priv "auth admin delete provenance"      "has_table_privilege('supabase_auth_admin', 'murage_auth.user_creation', 'delete')" f
st "auth admin calls the hook"           supabase_auth_admin "select public.custom_access_token_hook($EV)" ok
st "auth admin updates provenance"       supabase_auth_admin "update murage_auth.user_creation set provider = 'google', provider_id = 'g6' where user_id = '$(U 6)'" 42501
st "auth admin deletes provenance"       supabase_auth_admin "delete from murage_auth.user_creation where user_id = '$(U 6)'" 42501
A "delete from auth.users where id = '$(U 99)'"
n=$(q -c "select count(*) from murage_auth.user_creation where user_id = '$(U 99)'")
[ "$n" = 0 ] && echo "ok   provenance deleted with the user" || { echo "FAIL provenance kept after delete"; fail=1; }
# Astra SUPPORT5 P1 #2: mfa_factor_id names the factor that last verified THIS session (auth.sessions.factor_id),
# set server-side in Supabase's own verify transaction (updateMFASessionAndClaims: AddClaimToSession, then
# UpdateAALAndAssociatedFactor, then GenerateAccessToken -> the hook, all on one tx; supabase/auth ce9a8ee
# internal/api/token.go L303-L384). Modelled here as that transaction, as supabase_auth_admin.
S1=00000000-0000-0000-0000-00000000a001; S2=00000000-0000-0000-0000-00000000a002; SX=00000000-0000-0000-0000-00000000a0ff
FM=00000000-0000-0000-0000-00000000f001; FA=00000000-0000-0000-0000-00000000f00a
A "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status) values
     ('$FM', '$(U 1)', 'member phone', 'totp', 'verified'), ('$FA', '$(U 1)', 'attacker', 'totp', 'verified');
   insert into auth.sessions (id, user_id, aal) values ('$S1', '$(U 1)', 'aal1'), ('$S2', '$(U 2)', 'aal1')"
# mf SESSION USER# [EXTRA_CLAIMS] [SQL run first, same transaction] -> the claim's JSON (a quoted uuid or null)
mf() {
  id=$(U "$2")
  q -c "begin; set local role supabase_auth_admin; ${4:-select 1 where false;}
    select coalesce((r->'claims'->'mfa_factor_id')::text, 'absent') from (select public.custom_access_token_hook(jsonb_build_object(
      'user_id','$id','authentication_method','totp','claims', jsonb_build_object('sub','$id','session_id','$1','aal','aal2',
      'amr','$OTP2'::jsonb) || '$3'::jsonb)) r) s; commit;"
}
m() { got=$(mf "$2" "$3" "$4" "$5"); if [ "$got" = "$6" ]; then echo "ok   $1 -> $got"; else echo "FAIL $1 -> $got (want $6)"; fail=1; fi; }
VERIFY_FM="update auth.sessions set aal = 'aal2', factor_id = '$FM' where id = '$S1';"
VERIFY_FA="update auth.sessions set aal = 'aal2', factor_id = '$FA' where id = '$S1';"
m "aal1 session, no factor yet: null"                 "$S1" 1 '{}' ''            null
m "verify the member's factor (same tx as the hook)"  "$S1" 1 '{}' "$VERIFY_FM"  "\"$FM\""
m "refresh afterwards keeps it"                       "$S1" 1 '{}' ''            "\"$FM\""
m "a forged incoming claim is overwritten"            "$S1" 1 "{\"mfa_factor_id\":\"$FA\"}" '' "\"$FM\""
m "attacker's own factor verified on the session"     "$S1" 1 '{}' "$VERIFY_FA"  "\"$FA\""
m "  and its id stays named on refresh"               "$S1" 1 '{}' ''            "\"$FA\""
m "member re-verifies: back to the member's factor"   "$S1" 1 '{}' "$VERIFY_FM"  "\"$FM\""
m "another user's session id: null"                   "$S2" 1 '{}' "update auth.sessions set aal = 'aal2', factor_id = '$FM' where id = '$S2';" null
m "unknown session id: null"                          "$SX" 1 '{}' ''            null
m "malformed session id: null"                        "not-a-uuid" 1 '{}' ''     null
# Unenrolling the factor: DowngradeSessionsToAAL1 -> updateFactorAssociatedSessions (models/sessions.go L349-L351).
m "factor unenrolled: session aal1, null"             "$S1" 1 '{}' "update auth.sessions set aal = 'aal1', factor_id = null where factor_id = '$FM';" null
m "forged claim with no session factor: null"         "$S1" 1 "{\"mfa_factor_id\":\"$FM\"}" '' null
priv "authenticated select auth.sessions"  "has_table_privilege('authenticated', 'auth.sessions', 'select')" f

q -c "revoke usage on schema public from supabase_auth_admin"
if tok supabase_auth_admin 1 otp "$OT" >/dev/null 2>&1; then echo "FAIL works without schema grant"; fail=1; else echo "ok   needs schema grant"; fi
[ $fail -eq 0 ] && echo "HOOK-OAUTH-GUARD PASS" || { echo "HOOK-OAUTH-GUARD FAIL"; exit 1; }
