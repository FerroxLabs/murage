-- SPDX-License-Identifier: AGPL-3.0-or-later
-- ONECODE enable step ROLLBACK (see ONECODE-ENABLE-RUNBOOK.md, section ROLLBACK). NOT applied anywhere live by this repo.
--   psql "$(cat <connection-string-file>)" -X -v ON_ERROR_STOP=1 -f onecode-enable-rollback.sql
-- Precondition (runbook): the one-code flags are already off (site AUTH_CP_CODE off, CP CLOUD_SIGNIN_CODE_ROUTES "0").
--
-- Reverses: the epoch rows. With no row, the hook stops applying E2 and E3 to those users, so the sign-in methods the
-- hook was refusing for them (passkey, a linked OAuth identity, anything else that is not an emailed code) are allowed
-- again, to whatever extent the project settings and the OAuth link guard still allow them.
-- Does NOT reverse: the sessions E1 deleted (those users stay signed out until they sign in again), the password
-- refusal F1 (live since 2026-11-06; it has its own rollback, LIVE-PRESIGNUP-PW-ROLLBACK.sql), the hook body, or the
-- table, policy and grants (an empty table is harmless and the hook needs it to exist). Access tokens already issued
-- are not touched.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';
do $$
begin
  if not pg_has_role(current_user, 'supabase_auth_admin', 'MEMBER') then
    raise exception 'onecode rollback: % is not a member of supabase_auth_admin; ask Sean', current_user;
  end if;
end
$$;
select 'rolled back epoch rows' as what, count(*) as value from public.onecode_epoch;
delete from public.onecode_epoch;
select 'epoch rows now' as what, count(*) as value from public.onecode_epoch;
commit;
