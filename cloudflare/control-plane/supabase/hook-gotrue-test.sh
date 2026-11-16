#!/bin/sh
# GoTrue semantics for the enable step (design CLOUD-ONE-CODE-PROOF r5 test 24, r6 tests 31 33 34, r7 tests 31a 31b 33).
# A local GoTrue v2.197.0 server and Postgres in ONE container, loopback only, no network:
#   docker run --rm --network none -v "$PWD":/w -v "$GOTRUE_DIR":/g postgres:16-alpine sh /w/hook-gotrue-test.sh
# GOTRUE_DIR holds `auth` (the supabase/auth v2.197.0 binary) and `migrations/`. No live request of any kind.
# Deviation from the design text: the passkey ceremony (software authenticator) is not run. Session P is seeded with the
# rows GoTrue itself writes for a passkey login (auth.sessions, auth.refresh_tokens, auth.mfa_amr_claims method 'passkey'),
# and the refresh goes through GoTrue's real /token endpoint, so the hook runs inside GoTrue's own transaction.
PGDATA=/tmp/pg; export PGDATA
PGUSER=supabase_admin; export PGUSER
mkdir -p "$PGDATA" && chown postgres "$PGDATA"
su postgres -c "initdb -U supabase_admin -A trust -D $PGDATA >/dev/null 2>&1 && pg_ctl -D $PGDATA -o '-c listen_addresses=127.0.0.1' -w start >/dev/null"
q() { psql -v ON_ERROR_STOP=1 -qtAX -d postgres "$@"; }
qp() { PGUSER=postgres psql -v ON_ERROR_STOP=1 -qtAX -d postgres "$@"; }
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
alter default privileges revoke execute on functions from public;
revoke all on schema public from public;
create extension pgcrypto;
alter role supabase_auth_admin set search_path = auth;
SQL
export GOTRUE_DB_DRIVER=postgres DATABASE_URL="postgres://supabase_auth_admin@127.0.0.1:5432/postgres" GOTRUE_DB_NAMESPACE=auth \
  GOTRUE_JWT_SECRET=testsecrettestsecrettestsecret123456 API_EXTERNAL_URL=http://127.0.0.1:9999 GOTRUE_SITE_URL=http://127.0.0.1:3000 \
  GOTRUE_DB_MIGRATIONS_PATH=/g/migrations GOTRUE_API_HOST=127.0.0.1 PORT=9999 GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated \
  GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_DISABLE_SIGNUP=false GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true \
  GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/public/custom_access_token_hook \
  GOTRUE_LOG_LEVEL=info GOTRUE_SMTP_MAX_FREQUENCY=1s GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED=false \
  GOTRUE_MFA_TOTP_ENROLL_ENABLED=true GOTRUE_MFA_TOTP_VERIFY_ENABLED=true \
  GOTRUE_HOOK_SEND_EMAIL_ENABLED=true GOTRUE_HOOK_SEND_EMAIL_URI=pg-functions://postgres/public/capture_email GOTRUE_RATE_LIMIT_EMAIL_SENT=1000
/g/auth migrate >/tmp/migrate.log 2>&1 || { echo "FAIL gotrue migrate"; tail -3 /tmp/migrate.log; }
q -c "grant usage on schema auth to postgres; grant all on all tables in schema auth to postgres; grant all on all sequences in schema auth to postgres" >/dev/null
pass=0; failn=0
ok()  { pass=$((pass+1)); echo "ok   $1"; }
bad() { failn=$((failn+1)); echo "FAIL $1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1 -> $2"; else bad "$1 -> got '$2' want '$3'"; fi; }
U() { printf '00000000-0000-0000-0000-%012d' "$1"; }
S() { printf '00000000-0000-0000-0000-00000000b%03d' "$1"; }
A() { psql -qtAX -d postgres -c "set role supabase_auth_admin; $1" 2>&1 | head -3; }
cd /w
[ -f onecode-epoch-table.sql ] && qp -f onecode-epoch-table.sql >/dev/null 2>&1
# A send-email hook (a Postgres function, still inside GoTrue's own transaction) captures the real emails GoTrue would send, so
# the real one-time codes and token hashes can be read back without any SMTP server. Test-only; nothing here touches the reviewed hook.
qp >/dev/null 2>&1 <<'SQL'
create table public.mailsink (id serial primary key, addr text, kind text, token text, token_hash text, token_new text, token_hash_new text);
create function public.capture_email(event jsonb) returns jsonb language plpgsql security definer set search_path = '' as $f$
begin
  insert into public.mailsink (addr, kind, token, token_hash, token_new, token_hash_new)
  values (event->'user'->>'email', event->'email_data'->>'email_action_type', event->'email_data'->>'token', event->'email_data'->>'token_hash',
          event->'email_data'->>'token_new', event->'email_data'->>'token_hash_new');
  return '{}'::jsonb;
end $f$;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.capture_email(jsonb) to supabase_auth_admin;
SQL

# ---- GoTrue over loopback with busybox nc (HTTP/1.0, so no chunking) -------------------------------------------------------
/g/auth serve >/tmp/serve.log 2>&1 &
GPID=$!
i=0; while [ $i -lt 40 ]; do printf 'GET /health HTTP/1.0\r\nHost: x\r\n\r\n' | nc -w 2 127.0.0.1 9999 2>/dev/null | grep -q '200' && break; i=$((i+1)); sleep 1; done
# http METHOD PATH JSON [BEARER] -> "STATUS BODY"
http() {
  body=$3; len=$(printf '%s' "$body" | wc -c)
  auth=""; [ -n "$4" ] && auth="Authorization: Bearer $4\r\n"
  { printf '%s %s HTTP/1.0\r\nHost: x\r\nContent-Type: application/json\r\n%bContent-Length: %s\r\n\r\n%s' "$1" "$2" "$auth" "$len" "$body"; sleep 1; } | nc 127.0.0.1 9999 2>/dev/null | tr -d '\r' | awk 'NR==1{s=$2; next} /^$/ && !b{b=1; printf "%s ", s; next} b{printf "%s",$0}'
}
code() { echo "$1" | cut -d' ' -f1; }
msg()  { echo "$1" | cut -d' ' -f2- | sed -n 's/.*"error_code":"\([^"]*\)".*/\1/p' | head -1; }
# JWT signing with pgcrypto (the container has no openssl): HS256 over the project secret, base64url without padding.
jwt() { # SESSION USER -> access token for that session, 1h
  exp=$(( $(date +%s) + 3600 ))
  q -c "with p as (select
          translate(rtrim(encode(convert_to('{\"alg\":\"HS256\",\"typ\":\"JWT\"}', 'utf8'), 'base64'), '='), E'+/\\n', '-_') as h,
          translate(rtrim(replace(encode(convert_to('{\"aud\":\"authenticated\",\"exp\":$exp,\"sub\":\"$2\",\"role\":\"authenticated\",\"aal\":\"aal1\",\"session_id\":\"$1\",\"email\":\"x@x.test\",\"amr\":[{\"method\":\"otp\",\"timestamp\":1}]}', 'utf8'), 'base64'), E'\\n', ''), '='), '+/', '-_') as c)
        select h || '.' || c || '.' || translate(rtrim(replace(encode(hmac(convert_to(h || '.' || c, 'utf8'), convert_to('$GOTRUE_JWT_SECRET', 'utf8'), 'sha256'), 'base64'), E'\\n', ''), '='), '+/', '-_') from p"
}
for n in 1 2 3 7; do
  q -c "insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
          confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
        values ('00000000-0000-0000-0000-000000000000', '$(U $n)', 'authenticated', 'authenticated', 'u$n@x.test', crypt('pw-$n', gen_salt('bf')), now(), now(), now(), '{\"provider\":\"email\",\"providers\":[\"email\"]}', '{}', '', '', '', '', '', '', '', '')" >/dev/null 2>&1
done
# Sessions come from GoTrue itself: a password grant while a pass-through hook is installed (the real refresh tokens GoTrue
# writes, in its own format), then the amr claim and created_at are set to the shape under test, and the hook under test is
# put back. CUR is the file of the hook body that is installed.
CUR=""
install() { CUR=$1; qp -f "$1" >/tmp/install.log 2>&1 || { echo "note: install $1 failed"; head -2 /tmp/install.log; }; }
cat > /tmp/passthrough.sql <<'SQL'
create or replace function public.custom_access_token_hook(event jsonb) returns jsonb language sql stable set search_path = '' as $f$ select event $f$;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
SQL
# mintsess N USER# AMR_METHOD CREATED_SQL -> sets MS (session id) and MT (refresh token)
mintsess() {
  keep=$CUR; qp -f /tmp/passthrough.sql >/dev/null 2>&1
  r=$(http POST '/token?grant_type=password' "{\"email\":\"u$2@x.test\",\"password\":\"pw-$2\"}")
  MT=$(echo "$r" | sed -n 's/.*"refresh_token":"\([^"]*\)".*/\1/p')
  MS=$(q -c "select session_id from auth.refresh_tokens where token = '$MT'")
  q -c "update auth.mfa_amr_claims set authentication_method = '$3' where session_id = '$MS'; update auth.sessions set created_at = $4 where id = '$MS'" >/dev/null 2>&1
  [ -n "$MS" ] || echo "note: mintsess $1 got no session: $(echo "$r" | cut -c1-120)"
  [ -n "$keep" ] && install "$keep"
}
refresh() { http POST '/token?grant_type=refresh_token' "{\"refresh_token\":\"$1\"}"; }
rt_count() { q -c "select count(*) from auth.refresh_tokens where session_id = '$1'"; }

# ---- test 24 (password grant, sequential) and the r5 arm of 31a: the r5 fenced body is installed ------------------------------
mintsess 1 1 passkey "now() - interval '1 hour'"; P1=$MS; T1=$MT
echo "== arm F: r5 fenced body (no epoch fences)"
install fixtures/hook-body-r5-fenced.sql
before=$(q -c "select (select count(*) from auth.sessions) || ',' || (select count(*) from auth.refresh_tokens)")
r=$(http POST '/token?grant_type=password' '{"email":"u7@x.test","password":"pw-7"}')
chk "24 password grant refused with the hook message" "$(code "$r")" 403
chk "24 sessions and refresh tokens unchanged (rolled back)" "$(q -c "select (select count(*) from auth.sessions) || ',' || (select count(*) from auth.refresh_tokens)")" "$before"
qp -c "insert into public.onecode_epoch values ('$(U 1)', now())" >/dev/null 2>&1
r=$(refresh "$T1")
chk "31a on the r5 body: refresh of the passkey session P answers 200 (the gap E2 and E3 close)" "$(code "$r")" 200

# ---- arm E: the canonical installer -----------------------------------------------------------------------------------------
echo "== arm E: canonical installer with F1, E2, E3"
mintsess 2 1 passkey "now() - interval '1 hour'"; P2=$MS; T2=$MT      # P: older than the epoch_at set just below
mintsess 3 2 otp "now() - interval '1 hour'"; Q=$MS                    # Q: an otp session, with a signed access token
TQ=$(jwt "$Q" "$(U 2)")
install custom-access-token-hook-oauth-guard.sql
before=$(q -c "select (select count(*) from auth.sessions) || ',' || (select count(*) from auth.refresh_tokens)")
r=$(http POST '/token?grant_type=password' '{"email":"u7@x.test","password":"pw-7"}')
chk "24 password grant refused (canonical installer)" "$(code "$r")" 403
chk "24 sessions and refresh tokens unchanged (canonical installer)" "$(q -c "select (select count(*) from auth.sessions) || ',' || (select count(*) from auth.refresh_tokens)")" "$before"
# 31a: the hook alone. epoch_at is set now, so P (created an hour ago) is older; no DELETE ran.
qp -c "update public.onecode_epoch set epoch_at = now() where user_id = '$(U 1)'" >/dev/null
rc0=$(rt_count "$P2")
r=$(refresh "$T2")
chk "31a on E: refresh of P refused by the hook (E2, hook only, DELETE skipped)" "$(code "$r")" 403
chk "31a on E: no new refresh_tokens row for P" "$(rt_count "$P2")" "$rc0"
# Tests 33 and 31b: the real E1.
r=$(http GET /user '' "$TQ")
chk "33 control: the pre-epoch access token works before E1" "$(code "$r")" 200
if [ -f onecode-enable-e1.sql ]; then PGUSER=postgres psql -X -qtA -d postgres -f onecode-enable-e1.sql >/tmp/e1.log 2>&1; e1=$?; else e1=127; fi
chk "E1 commits" "$e1" 0
r=$(http GET /user '' "$TQ")
chk "33 after E1: GET /user with the pre-epoch access token" "$(code "$r") $(msg "$r")" "403 session_not_found"
r=$(http PUT /user '{"phone":"+15550100"}' "$TQ")
chk "33 after E1: PUT /user {phone} with the pre-epoch access token" "$(code "$r") $(msg "$r")" "403 session_not_found"
r=$(refresh "$T2")
chk "31b after full E1: refresh of P answers GoTrue's response for a gone refresh token" "$(code "$r") $(msg "$r")" "400 refresh_token_not_found"
echo "note: 31b response body: $(echo "$r" | cut -c1-200)"
chk "31b P has 0 rows in auth.sessions" "$(q -c "select count(*) from auth.sessions where id = '$P2'")" 0
chk "31b P has 0 rows in auth.refresh_tokens" "$(rt_count "$P2")" 0
# Test 34 positives: after E1 an epoch user signs in again (a new session, created after the epoch) and refreshes.
mintsess 4 3 otp "now() + interval '1 second'"; R2=$MS; TR2=$MT
mintsess 5 3 passkey "now() + interval '1 second'"; TR3=$MT
r=$(refresh "$TR2")
chk "34 an epoch user's post-epoch otp session refreshes" "$(code "$r")" 200
r=$(refresh "$TR3")
chk "34 an epoch user's post-epoch passkey session is refused (E3)" "$(code "$r")" 403

# ---- REAL GoTrue sign-in flows (Astra M2; design tests 32 and 34). The reviewed hook (canonical installer) stays installed the
# whole time: nothing below replaces it, rewrites amr, or edits created_at. Sessions come from GoTrue's own /otp, /verify and
# MFA endpoints; the codes are the ones GoTrue generated, read from the send-email capture table.
echo "== real flows: reviewed hook installed throughout"
chk "reviewed hook body md5 is installed" "$(q -c "select md5(prosrc) from pg_proc where oid = 'public.custom_access_token_hook(jsonb)'::regprocedure")" ba58cc2f3209cb0c3603ab08aa9626f5
atok() { echo "$1" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'; }
sess_of() { q -c "select id from auth.sessions where user_id = '$1' order by created_at desc limit 1"; }
amr_of() { q -c "select coalesce(string_agg(authentication_method, ',' order by authentication_method), '') from auth.mfa_amr_claims where session_id = '$1'"; }
last_mail() { q -c "select $2 from public.mailsink where addr = '$1' order by id desc limit 1"; }
# epoch user 2 (E1 above covered every user). Real OTP: /otp issues, /verify consumes.
sleep 2
r=$(http POST /otp '{"email":"u2@x.test","create_user":false}')
chk "32 real /otp issuance for an epoch user" "$(code "$r")" 200
OTP=$(last_mail u2@x.test token)
chk "32 GoTrue generated a 6 digit code" "$(printf '%s' "$OTP" | grep -c -E '^[0-9]{6}$')" 1
r=$(http POST /verify "{\"type\":\"email\",\"email\":\"u2@x.test\",\"token\":\"$OTP\"}")
chk "32 real OTP sign-in of an epoch user, hook installed" "$(code "$r")" 200
AT2=$(atok "$r")
chk "32 access token issued" "$([ -n "$AT2" ] && echo yes || echo no)" yes
chk "32 session amr is the email proof only" "$(amr_of "$(sess_of "$(U 2)")")" "otp"
r=$(http POST '/token?grant_type=refresh_token' "$(echo "$r" | sed -n 's/.*"refresh_token":"\([^"]*\)".*/{"refresh_token":"\1"}/p')")
chk "34 that real OTP session refreshes" "$(code "$r")" 200
# Magic link: same email, token_hash path.
sleep 2
r=$(http POST /magiclink '{"email":"u2@x.test"}')
chk "32 real /magiclink issuance" "$(code "$r")" 200
TH=$(last_mail u2@x.test token_hash)
r=$(http POST /verify "{\"type\":\"magiclink\",\"token_hash\":\"$TH\"}")
chk "32 real magic-link sign-in of an epoch user" "$(code "$r")" 200
chk "32 magic-link session amr (GoTrue records the verified token as otp)" "$(amr_of "$(sess_of "$(U 2)")")" "otp"
# OTP plus TOTP recovery for a TOTP epoch user (user 7). The factor is seeded; the challenge, the verify and the token are GoTrue's.
q -c "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
      values ('$(S 900)', '$(U 7)', 'totp-r8', 'totp', 'verified', now(), now(), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')" >/tmp/factor.log 2>&1 || { echo "note: factor insert"; head -2 /tmp/factor.log; }
totp() { q -c "with k as (select convert_to('12345678901234567890', 'utf8') as key, floor(extract(epoch from now()) / 30)::bigint as ctr),
  h as (select hmac(decode(lpad(to_hex(ctr), 16, '0'), 'hex'), key, 'sha1') as d from k), o as (select d, get_byte(d, 19) & 15 as off from h)
  select lpad(((((get_byte(d, off) & 127) << 24) | (get_byte(d, off + 1) << 16) | (get_byte(d, off + 2) << 8) | get_byte(d, off + 3)) % 1000000)::text, 6, '0') from o"; }
sleep 2
http POST /otp '{"email":"u7@x.test","create_user":false}' >/dev/null
OTP7=$(last_mail u7@x.test token)
r=$(http POST /verify "{\"type\":\"email\",\"email\":\"u7@x.test\",\"token\":\"$OTP7\"}")
chk "32 TOTP user: real OTP sign-in (aal1)" "$(code "$r")" 200
AT7=$(atok "$r")
r=$(http POST "/factors/$(S 900)/challenge" '{}' "$AT7")
chk "32 TOTP challenge" "$(code "$r")" 200
CH=$(echo "$r" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
r=$(http POST "/factors/$(S 900)/verify" "{\"challenge_id\":\"$CH\",\"code\":\"$(totp)\"}" "$AT7")
chk "32 OTP plus TOTP recovery: verify" "$(code "$r")" 200
chk "32 recovered session amr is otp plus totp" "$(amr_of "$(sess_of "$(U 7)")")" "otp,totp"
AT7B=$(atok "$r")
r=$(http GET /user '' "$AT7B")
chk "32 the aal2 access token works" "$(code "$r")" 200
# Fresh passkey: GoTrue's passkey ceremony needs an ECDSA authenticator signature and this container has no openssl or
# authenticator; a seeded passkey session through GoTrue's real /token refresh is test 34 above. Recorded, not faked.
echo "note: fresh passkey ceremony not run (needs a software authenticator); passkey refusal is covered by the seeded session through the real /token endpoint"
# Real completed email change (shape for the gate d history check): PUT /user then /verify email_change. Last, it renames u2.
sleep 2
r=$(http PUT /user '{"email":"u2new@x.test"}' "$AT2")
chk "email change requested through GoTrue" "$(code "$r")" 200
EC=$(q -c "select coalesce(nullif(token_new, ''), token) from public.mailsink where kind = 'email_change' order by id desc limit 1")
echo "note: email_change mail rows: $(q -c "select addr || '/' || kind from public.mailsink where kind = 'email_change'")"
r=$(http POST /verify "{\"type\":\"email_change\",\"email\":\"u2new@x.test\",\"token\":\"$EC\"}")
chk "email change completed through GoTrue" "$(code "$r")" 200
echo "note: users row after change: $(q -c "select email || ' sent_at_null=' || (email_change_sent_at is null) || ' email_change=[' || email_change || ']' from auth.users where id = '$(U 2)'")"
echo "note: identity email: $(q -c "select identity_data->>'email' from auth.identities where user_id = '$(U 2)' and provider = 'email'")"
echo "note: audit_log shape: $(q -c "select count(*) || ' rows; actions=' || coalesce(string_agg(distinct payload->>'action', ','), '') from auth.audit_log_entries")"
echo "note: audit rows mentioning u2: $(q -c "select count(*) from auth.audit_log_entries where payload::text like '%$(U 2)%' or payload::text like '%u2%x.test%'")"
q -c "select payload::text from auth.audit_log_entries order by created_at desc limit 3" | cut -c1-400 | sed 's/^/note: audit /'
[ "$failn" = 0 ] || { echo "-- gotrue log (errors)"; grep -i -E "error|panic|fail" /tmp/serve.log | tail -8 | cut -c1-400; }
kill $GPID 2>/dev/null
echo "ONECODE-GOTRUE: passed $pass failed $failn"
[ "$failn" = 0 ]
