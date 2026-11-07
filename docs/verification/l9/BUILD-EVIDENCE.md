# L9 build evidence

## Review-fix relaunch driver 2 — 2026-11-06

The supplied review narrows this run to B3(d). The cloud-intent guard in
`dc80fd8693` is unchanged.

| Finding | Fix commit | Regression test |
| --- | --- | --- |
| Medium B3(d): marked Check card claims the owner looks signed in | d6873f03fb798fcbff564bca24b2dfce7ccb66fb | `src/components/EngineSetup.test.ts` → `B3(d): marked reply-check copy`, English and German cases. Each asserts the new reply-check line, excludes the signed-in claim with both setUp values, and preserves ordinary unmarked signed-in copy. |

The marked card now uses `engineCheck.replyLine` in all eight locales; ordinary
cards retain `engineCheck.line`. Translation source hashes follow the existing
SHA-256 rule. No other review item was changed.

- Red run before implementation: **2 failed, 0 passed, 18 skipped**;
  [red transcript](evidence/b3d-copy-red.log) shows both rendered signed-in claims.
- Final targeted and neighbouring run: **162 passed, 1 failed, 0 skipped** in
  10 files. Both new regression cases pass.
  [Full transcript](evidence/b3d-copy-targeted.log).
- The sole failure is `locale-copy.test.ts > fr uses informal address only`:
  the existing `engineSignIn.signedIn` contains “Fermez” and “utilisez”. Replacing
  only fr.json with its original HEAD contents reproduced the identical failure:
  **45 passed, 1 failed**, [baseline transcript](evidence/b3d-copy-baseline.log).
  That dialog string is unchanged, respecting the review's card-only scope.
- Both TypeScript projects exited **0**, no diagnostics, with the required
  8192 MB heap setting.
- Locale catalog check: **exit 0**, eight languages. Library catalog check:
  **exit 0**, up to date. `git diff --check`: **exit 0**.

Commands:

```sh
TMPDIR="$PWD/t" node_modules/.bin/vitest run src/components/EngineSetup.test.ts -t 'B3\(d\): marked reply-check copy'
TMPDIR="$PWD/t" node_modules/.bin/vitest run src/components/EngineSetup.test.ts src/components/EngineSignInButton.test.ts src/components/EnginesSettings.test.ts src/lib/engine-setup-check.test.ts src/lib/local-engine-login.test.ts src/lib/i18n.test.ts src/lib/i18n-intl-locale.test.ts src/locales/locale-copy.test.ts src/locales/terms-copy.test.ts scripts/generate-locale.test.mjs
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.json
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.server.json
node scripts/generate-locale.mjs --check
node --experimental-strip-types scripts/build-local-catalog.mjs --check
```

This is static renderer verification, not a packaged Electron smoke or a
server/conversation workflow claim. No real provider requests or live app
mutations occurred. Temporary test files stayed inside the lane repository.

## Review relaunch — 2026-11-06

The round-three review of `6f0ef65833` identified only Medium 1. Earlier B, G,
and R items below are unchanged.

| Finding | Fix commit | Regression test |
| --- | --- | --- |
| Medium 1: cloud recovery overrides local-model setup | dc80fd8693dbb1db7f639596498c4b4378cf3e2a | `src/components/EngineSetup.test.ts`, `Medium 1: marked Kimi recovery respects setup intent`: inject retains local-model setup and excludes reply check/sign-in; cloud retains reply check, each with `setUp=false` and `setUp=true`. |

The recovery branch now requires `intent === "cloud"`. Before the fix, the
new regression cases produced **2 failed, 2 passed, 14 skipped**; both inject
cases rendered the cloud reply check. See [red evidence](evidence/medium1-red.log).
After the fix, the complete targeted and neighbouring suites produced
**68 passed, 0 failed, 0 skipped**, across five files; see
[green evidence](evidence/medium1-green.log).

Commands (from the lane repository, existing dependencies):

```sh
TMPDIR="$PWD/t" node_modules/.bin/vitest run src/components/EngineSetup.test.ts -t 'Medium 1'
TMPDIR="$PWD/t" node_modules/.bin/vitest run src/components/EngineSetup.test.ts src/components/EngineSignInButton.test.ts src/components/EnginesSettings.test.ts src/lib/engine-setup-check.test.ts src/lib/local-engine-login.test.ts
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.json
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.server.json
```

Both TypeScript projects exited **0**, with no diagnostics. This is static
renderer verification, not a packaged Electron smoke or a server/conversation
workflow claim. No provider requests or live application mutations were made.

## Previous build evidence

This build does not close the parent substitution race or the parent swap work.
Implementation: `f1d7fffe820eacc8f47de545067233c1ff8f7bc1`.
R1 correction: `41da866a8d`. B7 remains `d4529b5c7a` unchanged.

| Item | Commit | Test | Proof |
| --- | --- | --- | --- |
| B1, G2, G3, G5 | f1d7fffe82 | kimi-signin; contract-audit.md | Comments describe identity observations and accepted outside reads; late-swap test renamed. Documentation correction only. |
| B2, G1 | f1d7fffe82 | kimi-signin; kimi-signin-probe; regression | Tombstone without swap=false, early swap reads outside bytes=true; malformed input covered; return/log mutants rejected. Characterization guards. |
| B3(a), B6 | f1d7fffe82 | kimi-signin-probe | Removing the hint guard changes marked snapshot from false to true and fails test (a). Runtime correction. |
| B3(b) | f1d7fffe82 | kimi-signin-probe | Real fake-CLI setup reply answers ready and clears the mark. |
| B3(c) | f1d7fffe82 | kimi-signin-probe | Non-hint engine still clears at the sign-in probe. |
| B3(d) | f1d7fffe82 | EngineSetup; EngineSignInButton; locale check | Existing real-reply Check is offered; eight translations no longer promise successful login. Static renderer test, not a packaged Electron smoke. |
| B4, G6 | f1d7fffe82 | kimi-signin-regression | Held/tombstone/unknown/malformed have identical initialize/session-new traces and fake auth refusal. Scan-dependent core gate mutant rejected. Characterization guard. |
| B5 | f1d7fffe82 | kimi-signin-regression; kimi-signin-probe | Open candidate survives Stop; next turn refuses normally; same-root callers share expired unknown until cleanup; independent process and real server restart read freshly. Premature map deletion mutant rejected. Characterization guard. |
| B7 | d4529b5c7a | opencode-catalog-isolation | Existing referenced-file cache isolation tests pass; production OpenCode files untouched. |
| G4 | evidence commit | README consumer audit | Named consumers reviewed; only B3 policy changed. |
| R1 | 41da866a8d | cloud-home/opencode-key-wiring (4) | Culprit 1b4f75f181 added required --print-logs at opencode-go.ts:846. Exact argv expectation corrected; credential-grant assertions retained. Base and final tests pass. |
| R2 | evidence commit | pool; engine-tree-stop | Same seven test names and ProviderStopUnconfirmed errors on a5450e2b53 and build; no changes to either suite. |

Final Linux runs (overlapping follow-ups are not added to these counts):

- Targeted suites: **323 passed**, 20 files.
- Broad ACP neighbour: **471 passed, 1 failed, 2 skipped**, 474 tests. The failure
  is the upstream-trusted-folder test. It also fails alone on base a5450e2b53
  and this build with the same 30-second request-open timeout. No folder-trust
  code or test was changed.
- R2 suites: **61 passed, 7 failed**, 68 tests. Base additionally ran the four
  OpenCode wiring tests, giving 65 passed and the identical seven failures.
- Unique final test inventory: **855 passed, 8 baseline failures, 2 skipped**.
- Five deliberate mutations rejected. Each file was restored in a finally block.
- `tsc -p tsconfig.server.json` and `tsc -p tsconfig.json`: **exit 0**, each with
  `NODE_OPTIONS=--max-old-space-size=8192`.
- `node scripts/generate-locale.mjs --check`: **exit 0**, eight languages.

The required integrator ci-try gate could not be executed: no ci-try command,
configuration or connected CI runner was available, and pushing is prohibited.
macOS and Windows results are **unverified**, not represented as passing.
The new suites contain no platform skips and use directory symlinks on Unix,
junctions on Windows. This external acceptance gate remains unsatisfied.

## Reproduction

All commands ran inside the lane repository with `TMPDIR="$PWD/t"`; this keeps
fixture homes, data, logs and sockets inside the lane. Dependencies were already
installed. `pnpm` was not on PATH, so the installed bin entry points were used.

```sh
TMPDIR="$PWD/t" node_modules/.bin/vitest run \
  server/drivers/acp/kimi-signin.test.ts \
  server/drivers/acp/kimi-signin-regression.test.ts \
  server/kimi-signin-probe.test.ts \
  server/harness/registry.test.ts server/harness/registry-platform.test.ts \
  server/key-rejections.test.ts server/engine-signin-api.test.ts \
  server/engine-setup-check-api.test.ts server/engine-reply-check.test.ts \
  server/cloud-home/opencode-key-wiring.test.ts \
  server/drivers/acp/opencode-quiet.test.ts \
  server/drivers/acp/opencode-stderr-privacy.test.ts \
  server/drivers/acp/opencode-catalog-isolation.test.ts \
  src/components/EngineSetup.test.ts src/components/EngineSignInButton.test.ts \
  src/components/EnginesSettings.test.ts src/lib/engine-setup-check.test.ts \
  src/lib/local-engine-login.test.ts src/state/store-fresh-auth.test.ts \
  src/state/store.test.ts
TMPDIR="$PWD/t" node_modules/.bin/vitest run server/drivers/acp/acp.test.ts
TMPDIR="$PWD/t" node_modules/.bin/vitest run server/drivers/acp/pool.test.ts server/drivers/acp/engine-tree-stop.test.ts
TMPDIR="$PWD/t" node_modules/.bin/vitest run server/drivers/acp/acp.test.ts -t 'an upstream-trusted folder never sees a card'
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.server.json
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.json
node scripts/generate-locale.mjs --check
```

The broad run actually combined ACP with the 20 targeted files; its log shows
793 passed, one failed and two skipped. The final targeted-only run includes
one additional real server restart test, bringing that set to 323 passed.
Base comparisons used an isolated detached worktree under scratch/l9-base at
a5450e2b53 with the existing node_modules linked; the worktree was removed.

The route suite uses launchVerificationServer from the documented control
surface, fake ACP only, isolated data/home and the existing test-only host-power
seam. It asserts exact POST probe/setup-check and GET snapshot responses. No
real provider APIs or owner credentials are used. The route transcript records
URL, PID, original log path, request and resulting response. Protocol evidence
records all four credential states' complete method/params traces and refusal.
Original fixture logs were archived into evidence/server-*.log before cleanup.
The test seam can retain fresh evidence with L9_EVIDENCE_PATH (routes) and
L9_PROTOCOL_EVIDENCE_PATH (protocol). Renderer verification is static markup;
no packaged Electron workflow or cross-OS run is claimed.

## Mutation recipes

Each mutation was applied alone, the named test run, then the original file
restored. See evidence/l9-mutant-*.log and evidence/l9-mutations.json.

1. B3: remove `&& !snapshot?.signInAnswerIsLocalHint` from the probe's clearing
   condition. Run kimi-signin-probe.test.ts with `-t 'L9 B3\(a\)'`.
2. B2 return: replace kimiSignedIn's `return result` with a promise returning
   the fake access sentinel. Run kimi-signin.test.ts with `-t 'L9 B2/G1'`.
3. B2 log: add `console.debug(parsed, total)` before the candidate token-shape
   check. Run the same B2/G1 cases. The valid outside file leaks and fails;
   malformed JSON still exits before this injected logger.
4. B4: change the core pre-spawn condition to also require authentication for
   driverKind kimiAgent. Run regression with `-t 'L9 B4/G6'`.
5. B5: delete the root's map entry in the deadline callback. Run regression
   with `-t 'L9 B5'`. Expired same-root promise identity fails.
