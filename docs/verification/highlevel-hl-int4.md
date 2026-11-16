# HighLevel recovery integration: hl-int4

Base: `f6b9b86de72d64bd10f1d0363b7d44f58ae3af32`.
Evidence: `/work/build/hl-int4/evidence/`.

## Merge interaction and binding design

The hlf2 merge `862daffa0` introduced three RV7 collection assertions and one
deletion assertion expecting `not_applied` from negative recovery flags.
The earlier HighLevel integration `67367218d` introduced the shared
`readReconciliation` guard. It rejects negative flags anywhere in the original
response before hlf2 can construct an effect witness or infer deletion from
absence. The guard is byte-identical before and after the hlf2 merge. The
ftsdrain merge `dc1d2ede5` changes no files under `server/highlevel`.

The approved recovery amendment is MAIN (1),
`/work/build/hlint1/prompt.txt:2`:

> Validate the WHOLE provider response, including nonmatching collection members,
> before any reconstruction. A negative or missing confirmation means unconfirmed,
> never applied.

The already committed interpretation at
[`hlint1-CHANGED-EXPECTATIONS.md:7`](hlint1-CHANGED-EXPECTATIONS.md#changed-expectations)
explicitly requires `outcome_unknown` for recovery expectations based solely on
negative provider flags. It distinguishes these from proven absence. This
recovery-specific amendment follows the older returned-identity ruling that
classifies negative immediate mutation responses as not applied.

The product follows RULE A. The change adopts the approved amendment in the four
stale RV7 assertions and records each change in the expectation ledger. It also
requires the exact single declared lookup, identical replay results on the same
and a fresh host, no subsequent reads, and the original single mutation. Existing
positive, present-target, proven-absence, identity, pagination and immediate
mutation-response assertions remain.

The isolated server fixture additionally drives all four negative recovery cases
through the real host, registry, durable approval journal and fake provider. Each
must return `outcome_unknown` with one pipeline lookup and zero resends.

## Verification

All tests run through `/work/fuigo-builds/tools/it-remote.sh` with `IT_JOB=hl-int4`,
the assigned worktree, `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`, and
network disabled. One container runs at a time; launches wait while host load
exceeds 60. The isolated fixture uses `launchVerificationServer`, an explicit URL
for Doctor, a temporary home/data directory and fake engines/providers, and
closes its owned server in `finally`.

`red.json` records exactly the four assigned failures and 116 passes on the
untouched base. `green.json` records the broader HighLevel run.
`base-failure-comparison.json` compares any broader failures with an archive of
the untouched base. `typecheck.log`, `fixture/`, `mutant.json`, `restored.json`
and `leak-v2.log` retain the remaining verification evidence. The guard-bypass
mutant disables the original-response confirmation check only inside the test
container, then restores the original bytes before rerunning the witnesses.

| Check | Result |
| --- | --- |
| Original dispatch file, before changes | 4 failed, 116 passed |
| Dispatch file with the approved recovery expectations | 120 passed |
| Broader HighLevel suite, shared types and components | 15,700 passed, 4 failed, 3 skipped across 56 files |
| Four broader failures on an untouched base archive | Same four failures; zero new failures |
| Full `pnpm typecheck` | Passed |
| Isolated server workflow and explicit-URL Doctor | Passed; all four new recovery witnesses use one read and zero resends |
| Confirmation-guard bypass mutant | Four witnesses failed; all four passed after restoring the guard |

The broader failures are the F0.1/F0.2/frozen signature snapshots and the native
owner-turn static source assertion in `runtime.test.ts`. They reproduce on the
assigned starting tip and remain outside these four recovery fixes. The broader
suite is not claimed to be fully green. The baseline comparison's first attempt
exceeded Node's default output buffer, and a retry used a local fallback without
dependencies. Both attempts are retained; the completed comparison uses the
remote container, a larger capture buffer, and unchanged source/assertions.

No product or UI strings change. No live app, real account, billable provider or
Mac is used. The requested project-memory tool is unavailable and `.ijfw/memory/`
is absent.
