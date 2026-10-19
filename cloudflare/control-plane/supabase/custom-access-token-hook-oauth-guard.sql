-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Murage Cloud: the members area's Supabase Custom Access Token Hook WITH the OAuth link guard (CONTRACT.md section
-- 6, 2a). Supersedes custom-access-token-hook.sql: it defines the same function, so install this file instead of that
-- one, BEFORE the first user signs up (a user created without the trigger below can never use OAuth, only email
-- codes):
--
--   [auth.hook.custom_access_token]
--   enabled = true
--   uri = "pg-functions://postgres/public/custom_access_token_hook"
--
-- 1. app_metadata.email_verified, from auth.users.email_confirmed_at, on every issued token (unchanged).
--
-- 2. The link guard. Supabase links a new OAuth identity to an existing user whose email equals a verified provider
--    email, and a provider can keep calling an address verified after the mailbox changes hands. Identities are NOT
--    judged by their email (identity_data is rewritten from the provider on every sign-in, so it is attacker
--    controlled). The rule uses the user's CREATION provenance only:
--
--      murage_auth.user_creation records, when Supabase Auth inserts the auth.users row, the creation provider
--      (raw_app_meta_data->>'provider', set by the server before the insert) and, for an OAuth sign-up, the
--      provider subject (raw_user_meta_data->>'sub', the same map Supabase turns into the identity's provider_id).
--      Only supabase_auth_admin (through the trigger) can insert; nobody can update it. app_metadata.provider itself
--      is NOT used: Supabase rewrites it to providers[0] whenever an identity is linked.
--
--    An OAuth session (anything that is not provably an email-code or other first-party session: authentication_method
--    "oauth", an "oauth" amr entry, a missing/empty/malformed amr or authentication_method, or any unrecognised
--    method) gets a token ONLY if the user was created by google, apple or azure AND the user's identities are
--    exactly: the creation identity (that provider, that subject) plus at most one email identity. Any other
--    identity (an auto-linked OAuth identity, a second identity of the same provider, a phone identity) refuses
--    every OAuth session of that user. Email-code sessions are always allowed, so the mailbox owner keeps access.
--
--    Malformed input (event or claims not an object, user_id not a UUID, claims.sub not equal to user_id, unknown
--    user) is refused with 403. An amr entry without an integer timestamp is malformed: the session is treated as OAuth.
--
-- 4. mfa_factor_id (Astra SUPPORT5 P1 #2): the top-level claim `mfa_factor_id` is ALWAYS set by this hook, to
--    auth.sessions.factor_id of the token's own session (claims.session_id, same user, aal2), else JSON null. Supabase
--    Auth writes sessions.factor_id only when a factor is verified on that session (updateMFASessionAndClaims ->
--    UpdateAALAndAssociatedFactor, supabase/auth ce9a8ee internal/api/token.go L303-L384), in the SAME transaction that
--    then issues the token and runs this hook (GenerateAccessToken(r, tx, ...) -> InvokeHook(tx, ...),
--    internal/tokens/service.go L671-L745, internal/hooks/hookspgfunc/hookspgfunc.go L73-L110), so the claim names the
--    factor that verified the session last. Refresh does not change it; unenrolling that factor clears it
--    (internal/models/sessions.go L349-L351). Any incoming value is overwritten. The control plane counts fresh
--    step-up only when this factor is on the account's trusted list (src/trusted-factors.ts).
--
-- The hook runs as supabase_auth_admin (which owns auth.users, auth.identities and auth.sessions) inside Supabase's token transaction.
-- Not SECURITY DEFINER. Tested on Postgres 16 with Supabase's default function grants and MakerKit's revocations by
-- supabase/hook-oauth-guard-pg-test.sh.

-- Creation provenance, written once per user by Supabase Auth's own insert.
create schema if not exists murage_auth;
revoke all on schema murage_auth from public;
grant usage on schema murage_auth to supabase_auth_admin;

create table if not exists murage_auth.user_creation (
  user_id uuid primary key references auth.users (id) on delete cascade,
  provider text not null,     -- raw_app_meta_data->>'provider' as inserted ('' if absent)
  provider_id text not null,  -- raw_user_meta_data->>'sub' as inserted, for a non-email/phone provider; else ''
  created_at timestamptz not null default now()
);
revoke all on table murage_auth.user_creation from public, anon, authenticated, service_role;
grant select, insert on table murage_auth.user_creation to supabase_auth_admin;

-- SECURITY INVOKER: runs as the role inserting the user (supabase_auth_admin), which may only INSERT here.
create or replace function murage_auth.record_user_creation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into murage_auth.user_creation (user_id, provider, provider_id)
  values (new.id,
          coalesce(case when jsonb_typeof(new.raw_app_meta_data) = 'object'
                        then new.raw_app_meta_data->>'provider' end, ''),
          -- An email or phone sign-up's user_metadata is the client's signup data, so its sub is not recorded.
          coalesce(case when jsonb_typeof(new.raw_app_meta_data) = 'object'
                         and coalesce(new.raw_app_meta_data->>'provider', '') not in ('', 'email', 'phone')
                         and jsonb_typeof(new.raw_user_meta_data) = 'object'
                         and jsonb_typeof(new.raw_user_meta_data->'sub') = 'string'
                        then new.raw_user_meta_data->>'sub' end, ''));
  return null;
end;
$$;
revoke all on function murage_auth.record_user_creation() from public, anon, authenticated, service_role;

drop trigger if exists murage_record_user_creation on auth.users;
create trigger murage_record_user_creation
  after insert on auth.users
  for each row execute function murage_auth.record_user_creation();

-- 3. The link guard at the source (Astra MAKERKIT5 #1). The token hook alone judges the identities a user has NOW, so it
--    cannot tell which identity authenticated a pending PKCE exchange: Supabase Auth commits an auto-linked identity
--    and the flow state (user_id, auth code) in the callback transaction (external.go, ce9a8ee, lines 216-261), deletes
--    the flow state only after a token is issued (token.go PKCE, lines 234-280), and DeleteIdentity does not touch
--    flow states. Deleting a refused identity would therefore make its unexpired code acceptable.
--    So a google/apple/azure identity (or any provider other than email and phone) may only be INSERTED, or moved by
--    UPDATE, when it is exactly the user's recorded creation identity (same user, provider and subject). Anything
--    else raises, which rolls back the whole callback transaction (identity, metadata and flow-state update together;
--    createNewIdentity returns an ordinary error, not CommitWithError: external.go lines 323, 379, 907-917;
--    storage/dial.go lines 375-402), so no auth code is ever issued for a link the hook would refuse, and there is
--    no identity row to delete. Rule for support: NEVER delete an identity to "restore" OAuth; ban the user instead.
create or replace function murage_auth.guard_identity_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.provider in ('email', 'phone') then
    return new;
  end if;
  if exists (select 1 from murage_auth.user_creation c
             where c.user_id = new.user_id
               and c.provider in ('google', 'apple', 'azure')
               and c.provider_id <> ''
               and c.provider = new.provider
               and c.provider_id = new.provider_id) then
    return new;
  end if;
  raise exception 'murage: identity link refused' using errcode = '42501';
end;
$$;
revoke all on function murage_auth.guard_identity_link() from public, anon, authenticated, service_role;

drop trigger if exists murage_guard_identity_link on auth.identities;
create trigger murage_guard_identity_link
  before insert or update of user_id, provider, provider_id on auth.identities
  for each row execute function murage_auth.guard_identity_link();

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  refused constant jsonb := jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This account cannot use this sign-in method. Sign in with an email code, or contact support.'));
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  -- Methods that do not come from an OAuth identity (Supabase models.AuthenticationMethod names).
  first_party constant text[] := array['otp', 'magiclink', 'email/signup', 'email_change', 'recovery', 'invite',
    'password', 'totp', 'mfa/phone', 'mfa/webauthn', 'mfa/recovery_code', 'passkey'];
  uid uuid;
  claims jsonb;
  amr jsonb;
  confirmed boolean;
  email_session boolean := false;
  allowed boolean;
  factor uuid;
begin
  if jsonb_typeof(event) is distinct from 'object'
     or jsonb_typeof(event->'claims') is distinct from 'object'
     or jsonb_typeof(event->'user_id') is distinct from 'string'
     or jsonb_typeof(event->'claims'->'sub') is distinct from 'string'
     or (event->>'user_id') !~ uuid_re
     or (event->'claims'->>'sub') !~ uuid_re then
    return refused;
  end if;
  uid := (event->>'user_id')::uuid;
  claims := event->'claims';
  if (claims->>'sub')::uuid <> uid then
    return refused;
  end if;

  select u.email_confirmed_at is not null into confirmed from auth.users u where u.id = uid;
  if not found then
    return refused;
  end if;

  -- An email-code (first-party) session: a known non-OAuth authentication_method and a non-empty amr whose every
  -- entry is an object with a known non-OAuth method. Anything else is treated as OAuth.
  amr := claims->'amr';
  if jsonb_typeof(event->'authentication_method') = 'string'
     and (event->>'authentication_method') = any (first_party || 'token_refresh'::text)
     and jsonb_typeof(amr) = 'array' then
    if jsonb_array_length(amr) > 0 then
      email_session := not exists (
        select 1 from jsonb_array_elements(amr) a(e)
        where jsonb_typeof(a.e) is distinct from 'object'
           or jsonb_typeof(a.e->'method') is distinct from 'string'
           or not ((a.e->>'method') = any (first_party))
           -- Supabase's AMREntry timestamp is an integer (models/sessions.go); absent, null, string or fractional is
           -- malformed, and malformed is never exempt (Astra MAKERKIT5 #2).
           or jsonb_typeof(a.e->'timestamp') is distinct from 'number'
           or (a.e->>'timestamp')::numeric <> trunc((a.e->>'timestamp')::numeric));
    end if;
  end if;

  if not email_session then
    select exists (
      select 1
      from murage_auth.user_creation c
      where c.user_id = uid
        and c.provider in ('google', 'apple', 'azure')
        and c.provider_id <> ''
        -- the creation identity is still there ...
        and exists (select 1 from auth.identities i
                    where i.user_id = uid and i.provider = c.provider and i.provider_id = c.provider_id)
        -- ... every other identity is an email identity ...
        and not exists (select 1 from auth.identities i
                        where i.user_id = uid
                          and i.provider is distinct from 'email'
                          and not (i.provider = c.provider and i.provider_id = c.provider_id))
        -- ... and there is at most one of those.
        and (select count(*) from auth.identities i where i.user_id = uid and i.provider = 'email') <= 1
    ) into allowed;
    if not coalesce(allowed, false) then
      return refused;
    end if;
  end if;

  claims := jsonb_set(claims, '{app_metadata}',
    case when jsonb_typeof(claims->'app_metadata') = 'object' then claims->'app_metadata' else '{}'::jsonb end);
  claims := jsonb_set(claims, '{app_metadata,email_verified}', to_jsonb(confirmed));

  -- The MFA factor that last verified THIS session (section 4 above). Server-set; never taken from the input.
  if jsonb_typeof(claims->'session_id') = 'string' and (claims->>'session_id') ~ uuid_re then
    select s.factor_id into factor from auth.sessions s
     where s.id = (claims->>'session_id')::uuid and s.user_id = uid and s.aal::text = 'aal2';
  end if;
  claims := jsonb_set(claims - 'mfa_factor_id', '{mfa_factor_id}', coalesce(to_jsonb(factor::text), 'null'::jsonb));
  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- MakerKit revokes all on schema public from public (supabase/schemas/00-privileges.sql): without this grant
-- supabase_auth_admin cannot reach the function and every sign-in fails. Supabase's defaults grant execute on new
-- public functions to anon, authenticated and service_role; only Auth may run the hook.
grant usage on schema public to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
