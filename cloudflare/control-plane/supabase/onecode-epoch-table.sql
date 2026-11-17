-- SPDX-License-Identifier: AGPL-3.0-or-later
-- ONECODE enable step, table setup (design CLOUD-ONE-CODE-PROOF r7 section 1). NOT applied anywhere live by this repo.
--
-- public.onecode_epoch(user_id, epoch_at): one row per user covered by the one-code epoch. The custom access token hook
-- (custom-access-token-hook-oauth-guard.sql, predicates E2 and E3) reads it. The hook runs as supabase_auth_admin, so
-- row level security must give THAT role a read policy: a table grant alone does not bypass RLS, and an RLS table with
-- no policy makes the hook read zero rows, which would treat every user as a non-epoch user.
--
-- Idempotent. Run as the deployment role (postgres on the project), which becomes the owner. It is included by
-- onecode-enable-e1.sql (inside the E1 transaction) and by the hook installer's precondition check, which refuses to
-- install the hook unless this table exists.

create table if not exists public.onecode_epoch (
  user_id uuid primary key,
  epoch_at timestamptz not null
);

-- Everything below is applied only when the catalog differs from the intended state. When the table is already
-- correct (the normal case at E1, because the hook installer needs the table first) this takes no ALTER TABLE lock, so a
-- sign-in that runs the hook while E1 is open is not queued behind it (test 40).
-- Intended state: RLS on and not forced; the owner holds its own rights; supabase_auth_admin has SELECT and nothing else;
-- PUBLIC, anon, authenticated and service_role hold nothing; exactly one policy, a permissive SELECT policy for
-- supabase_auth_admin with USING (true).
do $$
declare
  hook_role oid := (select oid from pg_roles where rolname = 'supabase_auth_admin');
  tbl regclass := 'public.onecode_epoch'::regclass;
  state_ok boolean;
  p record;
begin
  select c.relrowsecurity and not c.relforcerowsecurity
         and not exists (
           select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           where a.grantee <> c.relowner and not (a.grantee = hook_role and a.privilege_type = 'SELECT'))
         and exists (
           select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           where a.grantee = hook_role and a.privilege_type = 'SELECT')
         and (select count(*) = 1 and bool_and(pl.polname = 'onecode_epoch_auth_read' and pl.polcmd = 'r' and pl.polpermissive
                    and pl.polroles = array[hook_role] and pg_get_expr(pl.polqual, pl.polrelid) = 'true')
                from pg_policy pl where pl.polrelid = tbl)
    into state_ok
  from pg_class c where c.oid = tbl;

  if not coalesce(state_ok, false) then
    alter table public.onecode_epoch enable row level security;
    alter table public.onecode_epoch no force row level security;
    -- Undo Supabase's default privileges on new public tables, then give the hook role read access and nobody else anything.
    revoke all on table public.onecode_epoch from public, anon, authenticated, service_role, supabase_auth_admin;
    grant select on table public.onecode_epoch to supabase_auth_admin;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'onecode_epoch' loop
      execute format('drop policy %I on public.onecode_epoch', p.policyname);
    end loop;
    create policy onecode_epoch_auth_read on public.onecode_epoch
      as permissive for select to supabase_auth_admin using (true);
  end if;
end
$$;
