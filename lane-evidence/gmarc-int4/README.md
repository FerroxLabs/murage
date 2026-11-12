# Scheduled Buffer integration gate

The failure is an obsolete round-1 fixture expectation, inherited from the
G-MARC lane. It was not introduced by Sable, ftsdrain r3, S6, or hlf2.

## Cause and design authority

The unchanged test fails at line 61 on both `f6b9b86de` and `b31dfd13c`:
expected one incident, received zero. At that point it has created no routine.
The account inventory remains ACTIVE, so the test requires an unsolicited
provider probe to discover its synthetic lapse.

The binding round-3 design is
`/work/fuigo-builds/swarm-b/bld-connreconnect/DESIGN-CONN-r3.md`, section 4,
lines 69–79. Line 74 explicitly says: “A routine with no learned toolkits gets
no background read; its dispatch-time preflight (:2158-2162) still runs.”
Lines 76–79 require zero provider reads without routines and first-run
dispatch preflight. The review amendments in
`/work/fuigo-builds/swarm-b/rev-conn-d3/REVIEW-from-last.txt`, items 6–7,
retain that restriction and define advance detection as bounded best effort.
Commit `862d6a3f5` implemented this policy before lane tip `b31dfd13c`.

The complete scheduled monitor block in `server/index.ts` has SHA-256
`7e4c03de5a255b2f63d7046595515cc50fed1397cf57b9f46a73fda85b5117eb`
on the lane, the G-MARC merge, and every subsequent integration merge.
Connector health parsing, safe reads, store, monitor, and the failing test
also have identical Git blobs on those revisions. The only `composio.ts`
difference from the lane is a comment. Provenance reports and the original
policy-change diff are retained in the job evidence directory.

The lane's round-3 `verify.sh` ran the two round-2 workflows, but omitted
`connector-health-scheduled-workflow.test.ts`. Its recorded green result
therefore does not establish that this older gate passed at the lane tip.
The integration comparison calls the failure NEW because the file does not
exist on the integration base, rather than because it passed on `b31dfd13c`.

## Change

The fixture now creates the first scheduled Buffer run before expecting its
reconnect incident, as required by the approved design. All 16 original
assertion-bearing lines remain verbatim; the incident and probe assertions
move after dispatch. No assertion is weakened or removed.

Additional assertions require no incident/probe before the routine, exactly
one fixed Buffer account-context probe, the exact failed account, and a
Buffer-specific reconnect error on the failed run. The fake engine reports
success, requiring the product to mark the schedule failed from the connector
failure itself. Existing checks still require visible failure text, zero
expired-account action calls, the normal reconnect route, exactly one
successful scheduled continuation, its transcript, and an empty incident list.

No product change is needed: broadening passive probing would violate the
round-3 policy. The unchanged round-3 schedule regressions cover the matching
no-routine, learned-routine, budget, and dispatch-time behaviors.

## Verification

| Source | Original gate | Corrected gate |
| --- | --- | --- |
| `b31dfd13c` | FAIL: zero incidents at line 61 | PASS |
| `f6b9b86de` | FAIL: zero incidents at line 61 | PASS |

Both corrected fixture transcripts show one failed scheduled run, one
completed scheduled run after reconnect, zero expired-account action calls,
and exactly one completed safe read. Each test launches and closes its own
`launchVerificationServer` fixture with a fake engine and loopback broker,
pins its URL, and retains messages, control wait output, and the server log.

The original report of 470 passing tests across 21 files was incomplete.
It is superseded by the fix-round verification below. The RED coverage audit
rejects those original reports: 21 of 43 required files covered, 22 missing.

The complete set is the union of all four historical G-MARC `verify.sh`
scripts and both `finish.sh` scripts. `test-set.json` records all 34 Vitest
and nine Electron files, with the six source scripts. `verify.py` checks that
the manifest equals that union and that every file has an executed result.
It archives changed workflow artifacts and restores historical lane evidence.
The coverage audit measures completeness separately from test success.

Reproduce only through the prescribed network-none container runner:

```sh
IT_JOB=afix-gmarc-int4 \
IT_W=/work/fuigo-builds/swarm-b/gmarc-int4/wt \
IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh \
/work/fuigo-builds/tools/it-remote.sh \
  'python3 lane-evidence/gmarc-int4/verify.py run .planning/afix-gmarc-int4/final'
```

The complete integrated-tree result is 839 passing tests and one inherited
failure across 34 Vitest files; all 213 Electron tests across nine files
pass. No tests are skipped. Full `pnpm typecheck` passes (UI, server,
and Flux conformance). All 43 files have results, including connected-app
operations, notification preferences, mobile-push routes, tray/route policy,
Electron sign-in/receipt tests, and the corrected scheduled Buffer workflow.

The inherited failure is `server/route-policy.test.ts:255`,
`route policy (strict) > the hidden-bot rule covers every non-desktop route
on one bot or room`: expected no uncovered routes, received
`GET /api/bots/a/review` and `POST /api/bots/a/review`.
Separate runs on both original input `f6b9b86de` and pre-integration base
`c1bb72379` reproduce exactly that assertion (44 pass, one fail each).
The route-policy test blob matches on all three; the product blob is
unchanged from the original integrated input.
This failure is retained and classified; the complete verifier returns
nonzero for it. The earlier integration's inherited connected-app relay
replay failure passes in this run; no causal fix is claimed.

Two mutants are checked in this fix round. Removing the connected-app
operations result from an otherwise complete report makes the audit fail
with exactly that missing file. The original P2-6 recovery mutant, removing
`clearNeedsReconnect(owner, slug)` after authoritative account replacement
in `server/composio.ts`, is rerun against the corrected Buffer fixture.
It is killed at `server/connector-health-scheduled-workflow.test.ts:90`:
the incident remains after reconnect instead of the required empty list.
The source is restored byte for byte, and the unchanged scheduled workflow
passes again. No runtime source or existing assertion changes in this round.
No new English product strings.

Fix-round raw evidence remains untracked under
`/work/fuigo-builds/swarm-b/afix-gmarc-int4/evidence/` and
`.planning/afix-gmarc-int4/`. It includes the manifest, commands and exits,
complete Vitest JSON and per-file Electron TAP logs, full typecheck output,
RED/GREEN coverage audits, both killed mutants, source hashes, baseline
failure comparisons, and isolated fixture messages/wait/server logs.
The initial complete run used Node's default reporter, whose counts did not
parse; its tests and passing typecheck are retained in `full/`. The final
run selects TAP explicitly. A baseline attempt that fell back to a local
container without dependencies exited 127 and is not counted as a test run;
the remote retry supplies the baseline result.

All fix-round runs use `/work/fuigo-builds/tools/it-remote.sh`,
`IT_JOB=afix-gmarc-int4`, the designated worktree (or isolated detached
baseline), and `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`.
Containers use network none; at most two run concurrently. Launches wait
while host load exceeds 60. Workflows launch and close their own
`launchVerificationServer` fixtures with fake engines and loopback brokers,
pin their URLs, and retain wait/messages/server-log evidence. No live
app/data, billable provider, or Mac is used. Evidence directories remain;
job-created dependencies, typecheck caches and containers are cleaned up.

Original RED/GREEN reports, design source, assertion-preservation check,
and merge provenance remain under
`/work/fuigo-builds/swarm-b/gmarc-int4/evidence/`.

The requested `ijfw_memory_prelude` tool is unavailable and `.ijfw/memory/`
is absent in this checkout.
