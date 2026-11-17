# One-code enable and drain (r7)

This is an operator handoff for `CLOUD-ONE-CODE-PROOF-r7.md`, which amends
r6, r5 and r4. Repository tests use fakes and isolated containers only.
Cloud deployment, live reads, E1 and flag changes belong to Sean and the
deployment lane. This lane has performed none of them.

`onecode-drain-gate.sh` calculates an earliest start from recorded evidence.
It does not validate the evidence itself, check the current time, or turn on
flags. `--postread ok` is an operator assertion that **every** post-commit
check below passed. A `START` line alone is not permission to enable.

## Before E1

Keep site `AUTH_CP_CODE` off and CP `CLOUD_SIGNIN_CODE_ROUTES` off. P1 and P2
and the other rollout prerequisites in the agreed design must be qualified.
Confirm the reviewed F1/E2/E3 hook is installed, with the epoch table, policy
and grants from `onecode-epoch-table.sql`.

Record the auth config immediately before E1 and again at gate time:

- Hook enabled, URI `pg-functions://postgres/public/custom_access_token_hook`.
- Email enabled; every other `external_*_enabled` provider disabled, including
  phone, anonymous and web3. Manual identity linking disabled.
- Secure email change enabled. Record `passkey_enabled` and `jwt_exp`; neither
  reduces the seven-day maximum drain.

Run `onecode-enable-verify.sql` immediately before E1. Compare its output to
the reviewed hook body and r7 catalog matrix: invoker rights, epoch RLS on,
FORCE off, exactly the permissive SELECT policy for `supabase_auth_admin`,
SELECT only for that role, no table privileges for anon/authenticated/service_role,
and `auth.sessions` owned by `supabase_auth_admin` with FORCE off. Record body
md5, function oid/xmin, policy xmin, server version and role membership.
If the deployment role cannot SET ROLE to `supabase_auth_admin`, stop; the
design requires Sean's decision on its alternate verification procedure.

Record the historical hook-body review and the design's assumptions:
A1 no earlier hook rewrote exp/iat; A2 storage expiry tolerance at most 30 s;
A3 historical issuer offset plus consumer clock error at most 870 s.
Repository history and a current clock sample cannot prove these assumptions.
Key rotation is an unselected decision for Sean, with verifier cache expiry
also required before it invalidates old tokens.

## E1 and the post-commit read

Sean runs `onecode-enable-e1.sql` with psql ON_ERROR_STOP from this directory.
It snapshots existing users into the epoch table and deletes their sessions
in one bounded transaction. Its role self-check must succeed and COMMIT must
be recorded. Record the inserted count, epoch_at and commit instant. Existing
users are signed out and must return through emailed code (plus TOTP if
enrolled); those epoch users remain email-code only under E3.

After COMMIT, open a **new session** and run `onecode-enable-verify.sql`.
Repeat the config and reviewed-body checks, catalog checks and epoch-count
comparison. Only a passing read supplies T_drain, from its clock_timestamp().
It must follow epoch_at and be no earlier than the recorded commit. Record
an unauthenticated `/auth/v1/health` Date sample against the database clock in
the same minute; the absolute offset must be at most 60 seconds. This sample
supports A3; it does not establish historical clock offsets.

Compute the earliest flag time with UTC epoch seconds, for example:

```sh
sh onecode-drain-gate.sh --epoch-at 1800000000 --commit 1800000030 \
  --t-drain 1800000060 --postread ok --offset 5
```

The result is T_drain + 604800 + 900 seconds (seven days and 15 minutes).
Malformed input, failed/missing post-read, epoch-derived start, pre-commit
start, offset over 60, unreadable CP skew or CP skew over 30 must refuse with
nonzero status and no START line. The source constant is read from
`../src/supabase-jwt.ts` unless `--skew-file` names a reviewed source file.

## At gate time

Wait until the recorded START instant, then repeat both config and catalog
reads. Compare hook md5/oid/xmin and policy xmin to the pre-E1 and post-commit
records. Any mismatch or known enforcement change resets the procedure:
Sean reruns E1, records a new post-commit T_drain, and restarts the full drain.
An off/on config toggle between observations can remain undetected (R-F3).

Run `onecode-gate-d-inventory.sql` read-only. Every prohibited credential,
session, phone, pending email change or completed email-change hit requires
Sean's disposition before flags. Require tests 22–40 and the other agreed
rollout gates, including real-engine and smoothness evidence, to be qualified.
Seeded-session GoTrue fixtures do not prove the software-authenticator passkey
ceremony. Missing evidence leaves enablement OPEN.

## Rollback

Normal order: site AUTH_CP_CODE off, CP routes `drain` (send refuses; existing
verify/bind stay available), then CP routes `0` at least 15 minutes later.
Emergency CP `0` expires pending verification and the next send falls back.

Keep F1, E2 and E3 in force after flags go off: browser fallback still depends
on them. `onecode-enable-rollback.sql` deletes epoch rows and removes E2/E3
protection for those users. It is a **separate security decision for Sean**;
flags off alone do not authorize running it. Deleted sessions cannot be
restored by that file. Do not replace/disable the hook as a flag rollback.
