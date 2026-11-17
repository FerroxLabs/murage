-- SPDX-License-Identifier: AGPL-3.0-or-later
-- ONECODE enable step E1 (design CLOUD-ONE-CODE-PROOF r6 section 1 and r7 section 1). NOT applied anywhere live by this
-- repo. Sean runs it once, in the window, per ONECODE-ENABLE-RUNBOOK.md, with psql from this directory:
--   psql "$(cat <connection-string-file>)" -X -v ON_ERROR_STOP=1 -f onecode-enable-e1.sql
-- It is one transaction. It either commits whole or leaves nothing behind.
--
--   1. table setup: public.onecode_epoch, RLS on, read policy for supabase_auth_admin only (onecode-epoch-table.sql).
--   2. one row per existing auth.users row, epoch_at = now() (the transaction start; T_epoch).
--   3. DELETE every session of those users, which is what GoTrue's Logout does (models/sessions.go:358); refresh tokens
--      and mfa_amr_claims go with them by their foreign keys (on delete cascade).
--   4. self-check, as supabase_auth_admin: the hook role must SEE every epoch row (an RLS table without a policy shows it
--      none) and no session older than the epoch may remain (a session created while E1 is open is fine: E3 judges it). Anything else raises and the whole transaction rolls back.
--
-- Precondition: the role running this is a member of supabase_auth_admin (checked below).
-- Re-running it is allowed: it takes a new epoch_at for every user and deletes sessions again (the design's reset).

\set ON_ERROR_STOP on
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

do $$
begin
  if not pg_has_role(current_user, 'supabase_auth_admin', 'MEMBER') then
    raise exception 'onecode e1: % is not a member of supabase_auth_admin; do not run this form, ask Sean', current_user;
  end if;
end
$$;

\ir onecode-epoch-table.sql

with ins as (
  insert into public.onecode_epoch (user_id, epoch_at)
  select u.id, now() from auth.users u
  on conflict (user_id) do update set epoch_at = excluded.epoch_at
  returning 1
)
select count(*) as n_inserted from ins \gset
select set_config('onecode.inserted', :'n_inserted', true);

delete from auth.sessions where user_id in (select user_id from public.onecode_epoch);
-- E1-AFTER-DELETE (test 40 pauses the transaction here)

do $$
declare
  n_owner bigint;
  n_visible bigint;
  n_sessions bigint;
  n_expected bigint := current_setting('onecode.inserted')::bigint;
begin
  select count(*) into n_owner from public.onecode_epoch;
  set local role supabase_auth_admin;
  select count(*) into n_visible from public.onecode_epoch;
  -- A session that another connection creates while this transaction is open has created_at at or after epoch_at (the
  -- transaction start): E2 passes it and E3 judges its method (r7 test 40), so it must not abort E1. What must be gone
  -- is every session that existed before the epoch.
  select count(*) into n_sessions from auth.sessions s join public.onecode_epoch e on e.user_id = s.user_id
   where s.created_at is null or s.created_at < e.epoch_at;
  reset role;
  if n_visible <> n_owner or n_visible < n_expected then
    raise exception 'onecode e1 self-check: hook role sees % epoch rows, table holds %, inserted %', n_visible, n_owner, n_expected;
  end if;
  if n_sessions <> 0 then
    raise exception 'onecode e1 self-check: % pre-epoch sessions of epoch users remain', n_sessions;
  end if;
end
$$;

select 'E1 inserted' as what, current_setting('onecode.inserted') as value
union all select 'E1 epoch_at (T_epoch)', max(epoch_at)::text from public.onecode_epoch;
commit;
