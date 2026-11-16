# Keystore on int2: W2 verification

Date: 2026-11-11. Branch: `feat/1019-keystore-on-int2`.
Tested code head: `f388309cbb3b2836ca13f9395abe10bcbf887a18`.
Integration base: `8a18c49fd1834452830a5343a17fe3e42b0a9b06`.
Keystore r3.2p: `356b4b34eee26964c27832e9d122f808305326c0`.

## Merge

r3.2p is already included through no-ff merge `896d2b05709849972085291772eabbe05ba1745d`. The requested `git merge --no-ff 356b4b34ee` returned `Already up to date.` No new conflict hunks arose. The lane's `RESOLUTION.md` records this and retains all three prior resolution explanations.

The resolved binding service retains both intents: reconnect commits `step: null` before clearing its cursor; removal clears reconnect and rotation cursors in the same transaction as int2 removal completion; boot resumes removals before replaying pending reconnects. The existing follow-up routes stray revocation through int2's removal gate, and the mutant anchor matches that routed call. No assertions or production code were changed during this verification pass.

## Execution

Artifacts and launch scripts: `/work/fuigo-builds/ks-on-int2/final-r32p/`. Every container launch waits for the integer one-minute load to fall below 60. At most two containers run for this lane. All use `--rm --network none --user 1000:1000`, image `murage-tt-t2-node24`, and labels `owner=mc63`, `purpose=ks-int2`, `expires_at=2026-11-14`. Dependencies are mounted read-only with temporary Vitest caches.

Required commands run against the merged code:

```sh
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.server.json --noEmit
npx vitest run server/email/exec-spec/keystore --exclude "**/iter.test.ts" --reporter=json --outputFile=/out/ks.json
npx vitest run server/email --exclude "**/exec-spec/**" --reporter=json --outputFile=/out/email.json
GATE_LANE=/work/fuigo-builds/ks-on-int2/final-r32p bash server/email/exec-spec/keystore/gate-rc-d6.sh final
MUTK_LANE=/work/fuigo-builds/ks-on-int2/final-r32p/mut python3 -u server/email/exec-spec/keystore/mutk.py --selftest
MUTK_LANE=/work/fuigo-builds/ks-on-int2/final-r32p/mut python3 -u server/email/exec-spec/keystore/mutk.py
```

The d6 gate invokes `GATE_NONCE=<run nonce> DEPTH=6 STATE_CAP=0 PROFILES=<profile> npx vitest run server/email/exec-spec/keystore/iter.test.ts` once each for `ci` and `ci-276`. The mutant runner uses a separate archive of the tested head, restores each mutation, and checks baseline totals before scoring a kill.

Additional checks cover all eleven changed test files and the prior restore/park selection. Comparison runs use the original int2 base and its three existing changed test files. Pinned Linux age and age-keygen binaries were verified against `shared/backup-age-pins.mjs`; provenance is retained in `age-provenance.txt`. The fixture launch, doctor, and models commands follow `docs/verification/README.md` inside a network-isolated container.

## Results

Both TypeScript configurations passed. The complete mutant set reports `killed=75/75 bad=0`: every mutant produced a test-level RED result, with GREEN baselines before and after (48, 82, 34, and 13 tests). The classifier self-test passed, including rejection of a real broken import as a load error. SHA256 checks confirm that the three mutated source files and the import-control test were restored byte for byte. No new tests were introduced in this verification pass.

| Selection | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: |
| Keystore spec | 96 | 0 | 0 |
| Head email | 825 | 4 | 0 |
| Base email | 769 | 4 | 0 |
| Head changed files | 193 | 0 | 0 |
| Base existing changed files | 28 | 0 | 0 |
| Head restore/park | 369 | 5 | 0 |
| Base restore/park | 369 | 5 | 0 |

The 193 changed-file tests include the Cloud keystore tests. The keystore witness suite pins all 164 witnesses. The earlier missing-age fixture failures were resolved by supplying the hash-verified tools, with no assertion changes.

The isolated fixture returned `doctor.ok=true` and exposed the `verification` fake engine. Its launch JSON, doctor/models JSON, and server log are retained under `out/`. The launcher received SIGINT, exited successfully, and removed its temporary data. This check establishes local boot and engine readiness; keystore behavior is covered by the product tests, executable model, and mutations.

The exhaustive d6 gate passed for both profiles. Each reports zero violations, reducer failures, cycles, and freezes, with `truncated=false`, a passing Vitest test, and `rc=0`.

| Profile | States | Transitions | Stalled-close transitions |
| --- | ---: | ---: | ---: |
| ci | 834,970 | 2,287,650 | 20 |
| ci-276 | 956,434 | 2,593,111 | 20 |

## Cleanup and handoff

All containers created for this pass exited and were removed. The mutant source snapshot and temporary age binaries were deleted. Logs, JSON reports, source hashes, scripts, and tool provenance remain in `final-r32p/`; `checksums.sha256` records the retained artifact hashes. Pre-existing lane dependencies and worktrees were retained. No dependency installation or build command was run.

This commit adds only this verification note. The tested production and test code is unchanged from `f388309cbb`. The lane resolution record outside the worktree was updated with the already-merged r3.2p status.
