# HighLevel C2 F0.2.3 adoption

Job `cfix2-hlc2-f02` started at `fd225afa5f4ea1d39d01e54a6255ccf06c2cf002`
on `dev/1019-hlc2` and merged frozen shared commit
`6eafab70c3eade254255ebb6c1193497418ee053` from `dev/1019-hls0-f021`.

The host registers a live approved invocation before its first post-approval
asynchronous authorization check. Authorized duplicates join that invocation
using the approval journal's storage identity and approval ID. Each caller still
checks authority before releasing the outcome. With no live owner, missing and
pending journal claims use the existing read-only reconciliation path; an
inconclusive read remains unconfirmed and cannot resend.

Tag mutations read the declared contact preflight, validate the target, location
and full tag set, and retain a detached snapshot with the exact frozen request.
After approval validation, the shared tag adapter combines that snapshot with
the retained add/remove delta. The whole-response identity binder runs before
family hooks and requires the exact post-state, including unrelated tags.

## Evidence

Evidence is retained at
`/work/build/hlc2/evidence/cfix2-hlc2-f02/`.

- `red.log`: the reviewer interleaving, corrected earlier concurrency test, and
  tags-only add/remove successes fail: 4 failed, 21 passed.
- `red-prestate.log`: additional preflight and unrelated-tag witnesses expand
  the baseline to 9 failed, 21 passed.
- `green.log`: all 30 C2 regression cases pass. Both concurrent calls return
  the same applied result, with one PUT, one review and one beginDispatch.
  The duplicate starts and authorizes while the original is held before PUT.
- `baseline-full.log`: 17 failures, 11,878 passes. This includes the 9 new RED
  cases plus 8 existing compatibility failures: the retired `locations.get`
  lookup and a settings test forbidding globally shared C2 approval copy.
  The location lookup now uses `location.get`; the settings test still forbids
  approval UI on the read-only card without forbidding the shared translation.
- `full.log`: 12,368/12,368 tests pass across 33 files, without exclusions.
  Includes all `server/highlevel` suites, shared HighLevel tests and both
  HighLevel component suites.
- `tsc-server.exit`, `tsc-app.exit`: both zero.
- `ci-inventory.log`: merged inventory passes (3,839 Vitest files).
- `fixture-info.json`, `fixture-doctor.json`, `fixture-server.log`: isolated
  fake-engine launch, explicit-URL Doctor, and owned-process cleanup.
- Exact commands are in `red-command.sh`, `verification-command.sh` and the
  runner logs retained alongside the evidence directory. The initial test-only
  type assertion failure and corrected passing check are also retained.

All execution used `it-remote.sh` with `IT_JOB=cfix2-hlc2-f02`,
`IT_W=/work/build/hlc2/wt`, and
`IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`, one container at a time.
The freeze was awaited in one shell loop using `sleep 180`.

The operation regression fixtures use the production manifest, argument/wire
schemas, endpoint objects, host, transport and durable journals. This C2 branch's
contacts family extension point is still empty, so tests supply minimal family
prepare/projection hooks. The Doctor check proves isolated startup; these
checks do not claim a live provider workflow or complete family integration.

Job-created dependency/build artifacts were removed on all three used workers
(`murage-vt3`, `murage-vt4`, `murage-vt5`); no owned containers remained. Tracked
`build/` assets were preserved. Evidence was archived outside the worktree.
