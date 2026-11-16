-- SPDX-License-Identifier: AGPL-3.0-or-later
-- ONECODE gate d, post-epoch inventory (design r6 section 2 d). Counts only, read only, no user data printed. NOT applied
-- anywhere live by this repo.
--   psql "$(cat <connection-string-file>)" -X -qtA -F '|' -f onecode-gate-d-inventory.sql
-- Every row below except the ones marked info must be 0; the last row, HITS, counts the nonzero ones. Any hit needs a
-- per-user disposition with Sean before any one-code flag (STOP).
-- Completed email changes (design r6 gate d, Astra r8 High 1) are BLOCKING, not informational. Real GoTrue v2.197.0 shape
-- (hook-gotrue-test.sh): a completed change clears email_change and email_change_token_new, KEEPS email_change_sent_at, updates
-- the email identity, and writes a user_modified audit entry with only actor_id/actor_username/action (no traits). So:
--   email_change_ever_requested        epoch users whose email_change_sent_at is set (a change was requested at some time)
--   email_differs_from_email_identity  epoch users whose auth.users.email differs from their email identity (direct edits)
--   audit_user_modified_epoch_users    epoch users with a user_modified audit entry (any profile update, so it over-reports)
--   audit_coverage_gap_epoch_users     epoch users created before the earliest audit entry, or every epoch user if the log is
--                                      empty: the log cannot show their history, so each one counts as a hit
-- Every hit needs an explicit per-user disposition with Sean before any one-code flag.
-- Method sets: E = otp, magiclink, email/signup, email_change, recovery, invite; S = totp, mfa/phone, mfa/webauthn,
-- mfa/recovery_code.
begin read only;
with epoch_users as (select user_id, epoch_at from public.onecode_epoch),
amr as (
  select s.id as session_id, s.user_id, c.authentication_method as method
  from auth.sessions s
  join epoch_users e on e.user_id = s.user_id
  left join auth.mfa_amr_claims c on c.session_id = s.id
),
bad_amr as (
  select session_id from amr
  group by session_id
  having bool_or(method is not null and method not in
           ('otp','magiclink','email/signup','email_change','recovery','invite','totp','mfa/phone','mfa/webauthn','mfa/recovery_code'))
      or not bool_or(coalesce(method in ('otp','magiclink','email/signup','email_change','recovery','invite'), false))
),
checks(ord, name, n, info) as (
  select 1, 'sessions_before_epoch', count(*), false from auth.sessions s join epoch_users e on e.user_id = s.user_id
    where s.created_at is null or s.created_at < e.epoch_at
  union all select 2, 'sessions_amr_outside_E_S_or_no_E', count(*), false from bad_amr
  union all select 3, 'webauthn_credentials', count(*), false from auth.webauthn_credentials w join epoch_users e on e.user_id = w.user_id
  union all select 4, 'mfa_factors_other_than_verified_totp', count(*), false from auth.mfa_factors f join epoch_users e on e.user_id = f.user_id
    where not (f.factor_type::text = 'totp' and f.status::text = 'verified')
  union all select 5, 'identities_non_email', count(*), false from auth.identities i join epoch_users e on e.user_id = i.user_id
    where i.provider <> 'email'
  union all select 6, 'users_with_phone_or_phone_change', count(*), false from auth.users u join epoch_users e on e.user_id = u.id
    where coalesce(u.phone, '') <> '' or coalesce(u.phone_change, '') <> ''
  union all select 7, 'users_with_pending_email_change', count(*), false from auth.users u join epoch_users e on e.user_id = u.id
    where coalesce(u.email_change, '') <> '' or coalesce(u.email_change_token_new, '') <> ''
  union all select 70, 'email_change_ever_requested', count(*), false from auth.users u join epoch_users e on e.user_id = u.id
    where u.email_change_sent_at is not null
  union all select 71, 'email_differs_from_email_identity', count(*), false from auth.users u join epoch_users e on e.user_id = u.id
    join auth.identities i on i.user_id = u.id and i.provider = 'email'
    where lower(coalesce(u.email, '')) <> lower(coalesce(i.identity_data->>'email', ''))
  union all select 72, 'audit_user_modified_epoch_users', count(distinct u.id), false from auth.users u join epoch_users e on e.user_id = u.id
    join auth.audit_log_entries a on a.payload->>'action' = 'user_modified' and a.payload->>'actor_id' = u.id::text
  union all select 73, 'audit_coverage_gap_epoch_users', count(*), false from auth.users u join epoch_users e on e.user_id = u.id
    where u.created_at is null or u.created_at < (select min(created_at) from auth.audit_log_entries)
       or not exists (select 1 from auth.audit_log_entries)
  union all select 8, 'info_verified_totp_factors', count(*), true from auth.mfa_factors f join epoch_users e on e.user_id = f.user_id
    where f.factor_type::text = 'totp' and f.status::text = 'verified'
  union all select 9, 'info_audit_user_modified_entries_all_users', count(*), true from auth.audit_log_entries a
    where a.payload->>'action' = 'user_modified'
)
select name, n from (
  select name, n from checks
  union all select 'HITS', count(*) from checks where not info and n <> 0
) q order by (name = 'HITS'), name;
commit;
