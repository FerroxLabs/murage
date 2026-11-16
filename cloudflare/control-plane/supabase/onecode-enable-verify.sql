-- SPDX-License-Identifier: AGPL-3.0-or-later
-- ONECODE enable step, read-only enforcement read (design r6 gate a and b, r7 sections 1 and 2). NOT applied anywhere
-- live by this repo. Run it immediately before E1 (same session as the md5 compare), and again after E1 has committed,
-- in a NEW session; the second run's clock value is T_drain. It writes nothing and prints key|value lines.
--   psql "$(cat <connection-string-file>)" -X -qtA -F '|' -f onecode-enable-verify.sql
-- The runbook compares the lines to the reviewed values; any difference is a STOP.
begin read only;
select 'server_version', current_setting('server_version');
select 'run_as_member_of_auth_admin', pg_has_role(current_user, 'supabase_auth_admin', 'MEMBER');
select 'hook_body_md5', md5(p.prosrc), 'chars', length(p.prosrc), 'oid', p.oid, 'xmin', p.xmin
  from pg_proc p where p.oid = 'public.custom_access_token_hook(jsonb)'::regprocedure;
select 'hook_security_definer', p.prosecdef from pg_proc p where p.oid = 'public.custom_access_token_hook(jsonb)'::regprocedure;
select 'epoch_rls', c.relrowsecurity, 'force', c.relforcerowsecurity, 'owner', pg_get_userbyid(c.relowner)
  from pg_class c where c.oid = 'public.onecode_epoch'::regclass;
select 'epoch_policy', polname, 'xmin', xmin, 'cmd', polcmd, 'roles', polroles::regrole[]::text, 'qual', pg_get_expr(polqual, polrelid)
  from pg_policy where polrelid = 'public.onecode_epoch'::regclass order by polname;
select 'epoch_priv_' || r || '_' || p, has_table_privilege(r, 'public.onecode_epoch', p)
  from unnest(array['supabase_auth_admin','anon','authenticated','service_role']) r,
       unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p order by 1;
select 'auth_sessions_owner', pg_get_userbyid(c.relowner), 'force', c.relforcerowsecurity
  from pg_class c where c.oid = 'auth.sessions'::regclass;
select 'epoch_rows', count(*) from public.onecode_epoch;
select 'epoch_max_epoch_at', max(epoch_at) from public.onecode_epoch;
select 'clock_timestamp (T_drain on the post-commit read)', clock_timestamp();
commit;
