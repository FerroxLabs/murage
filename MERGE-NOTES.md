# int19m2-pre merge notes

Base verified: dev/1019-int19m2-pre and dev/1019-int19l both at 0bcda6c9e746f99950e7b692bb587dfe654cd8cd; initial worktree clean.
Only the four requested lane tips are being merged, in order, without squash.

## bot-create — 821b4eae5

Conflicts and resolutions (all original guards and incoming authority checks retained):
- server/bot-access.ts: keep HighLevel connection context/native precedence; add staged-bot refusal.
- server/boundary-ports.ts: preserve PackAuthority argument and add a separate HeldPeerAuthority argument; forward both.
- server/data-dir-inventory.ts: retain browser-modes record and incoming bot-review persistence documentation.
- server/delegations.ts: union imports; preserve authenticated owner-root proof and independently forward held authority to delegation preparation.
- server/drivers/acp/core.ts: union hook/tripwire and helper-evidence imports; retain helper lifecycle evidence and tool tripwire.
- server/drivers/claude.ts: union Windows-hide/HighLevel and helper-settlement imports.
- server/drivers/codex.ts: union hook/Windows-hide and helper-evidence imports; clear turn tracking and record helper completion evidence.
- server/handoff-boundary.ts: retain packAuthorityOf and add holdBotWork to the route context.
- server/index.ts: keep Windows-hide first; union release cleanup; preserve Cloud birth fallback/browser busy tracking plus bot-review setup; union approval surface/receipt/HighLevel/proven-desktop fields; retain owner-browser refusal and incoming consent authority; retain cancelled-dispatch cleanup and bind settlement ledger. Held release passes its snapshot separately from PackAuthority.
- server/store.ts: preserve browser storage imports and incoming permission-write marker.
- server/turn-dispatch-guard.ts: retain submitted-work notification guard and incoming staged-bot refusal.
- src/components/ApprovalCard.tsx: display both HighLevel live review and bot authority fields.
- src/state/store.tsx: retain and transmit both HighLevel reviewDigest and bot-review seen receipt.

Validation receipts are stored outside git in /work/fuigo-builds/swarm-b/int19m2-pre/.

Integration validation: adapted the held-contract and held-persistence tests to the new separate authority argument positions, retaining every assertion. The first typecheck caught the old test argument position. Incoming mutants.tsv trailing tabs are intentional empty TSV fields and are preserved.

Semantic inventory conflict: server/testing/botcreate-spec/writers.json now classifies 364 integrated writer sites (360 on the older bot-create base). Reviewed HighLevel answer/backstop, browser setup acceptance, Cloud engine re-pick/sign-in selection, owner MCP import, desktop folder proof, and updated caller context. The scanner and exact-match/mutant assertions are unchanged. First complete run: types PASS; 438/439 tests PASS, only the stale inventory failed; isolated fixture PASS.

Bot-create final targeted rerun: 10/10 inventory/review tests PASS, including the unclassified-writer mutant; all 439 lane tests passed across the complete run and targeted correction. Both type checks and isolated fixture passed.

## memio — bd9960b11

No textual conflicts. Retained the incoming bounded rollover writes and retired-schema cache without behavior changes.

Memio validation: both type checks PASS; cumulative bot-create + memio 502/502 tests PASS. Additional conflict-focused tests: 192/192 PASS (owner-rooted delegation/pack proof, bot access, HighLevel precedence, dispatch guards).

## leakscrub — 7a5662a9d

No textual conflicts. Shared leak guard and public-source scrub retained unchanged. Incoming OPEN-RUNTIME-NAMES.md documents 50 unresolved runtime-contract hits awaiting MAIN ruling; this is not a waiver. No patterns, exclusions, runtime names, or behavior changed by this integration.

Leakscrub validation: both type checks PASS; root cumulative tests 993/997 PASS (47 files), with only four locale/ledger failures. The same four failures reproduce on untouched 0bcda6c9e (160/164 PASS); no shipped locale input changed in this integration. Cloud lane tests: 388/388 PASS. Shared guard's seven tests, including the real repository release assertion, PASS with the current canonical shared pair; the historical direct invocation passed with that pair. The final canonical pair changed and fails, as recorded below.

## winscen — 967196f77

- docs/verification/windows-hide-desktop-gate.md: retain the approved two-receipt desktop/handoff flow and add the retained int19l desktop/manifest guarantees and helper staging requirement.
- scripts/after-pack.mjs: union anchored-reader/OS-shell validation imports with packaged-build provenance; retain all packing checks.
- scripts/windows-hide-desktop-gate.ps1: retain the incoming split-gate orchestrator. Relocate the outgoing desktop identity checks into scripts/windows/owned-process.ps1 and invoke them before sampling and on every tick. Preserve the approved owned-process positive controls, require their observed window to close, and run the existing control assertion. In scripts/windows/scenario-common.ps1 retain exact int19l package-manifest verification before and after the scenario, plus identity/control/manifest evidence, alongside incoming provenance and independent outer finalization. Both scenario halves receive these guards.
- Existing scripts/windows-hide-gate.node-test.mjs and scripts/windows-hide-gate-checks.test.ps1 assertions now follow the relocated implementation. No desktop/control/manifest negative case or scanner rule was removed; PowerShell parsing expands from three files to seven.

Windows validation correction: the unchanged ownership scanner rejected a computed parent-directory helper import. Moved the exact helper implementation to scripts/windows/windows-hide-gate-checks.ps1 and retained the original root path as a compatibility forwarder; the scenario imports a literal sibling. No scanner allowlist changed. The first Sentinel Node test lacked its built host-boundary module; the complete server bundle is now staged before rerunning it.

Semantic safety inventory conflict: server/testing/data-safety.test.ts now classifies scripts/windows/scan-native.mjs's existing parser scratch cleanup. Its const root is created by mkdtempSync in the same call and never comes from scanned input; only disposable parser files are deleted. The cleanup implementation and safety scanner remain unchanged.

Windows final validation: both type checks PASS; cumulative root lane tests 993/997 PASS, with the same four baseline locale failures; Cloud 388/388 PASS; isolated fixture PASS (doctor, create, send, settle, reply). Windows Node tests 139/139 PASS; PowerShell desktop/control assertions 13/13 and manifest assertions 12/12 PASS; seven scripts parse and the actual shared observer C# compiles. Assertion-wrapper proof: 6/6 successful assertions count once and 6/6 failing assertions throw without counting; patched scenario driver has zero scanner findings. Native Windows desktop execution was not performed on this Linux host.

## Test environment and release status

All test execution used /work/fuigo-builds/tools/it-remote.sh with IT_JOB=int19m2-pre, this worktree as IT_W, and /work/fuigo-builds/tools/it-local-generic.sh as IT_ORIG. At most two isolated, network-disabled containers ran at a time. The wrapper's local fallback was used for the job's fixture/native-tool mounts; host load was checked below the requested limit. Shared dependencies and the browser-asset location were mounted read-only. The configured external Chrome executable and libraries were absent at the final host check (final-browser-assets.json); real-browser and Electron-runtime failures are not claimed as passing coverage. No live user app or data was used; no credentials or paid service was used.

The int19l touched-test inventory is the test-file union from 375f8e0c5..0bcda6c9e: 307 Vitest files, 38 Node files, and the PowerShell guard test. The Vitest gate ran as two shards of 152 and 155 files, each with --fileParallelism --maxWorkers=4; Node used --test-concurrency=1. Exact lists, commands, JSON reports and logs are in /work/fuigo-builds/swarm-b/int19m2-pre/.

The gate is OPEN. Three operator-creation cases in server/index.test.ts return 403 on the merged tree and pass on untouched 0bcda6c9e (operator-current-tests.json versus operator-base-tests.json). Approved bot-create authority behavior and the original assertions are preserved. The four locale failures also reproduce on untouched 0bcda6c9e with identical normalized failure messages (baseline-locale-comparison.json). Other failures are not assumed to be baseline failures without a comparison. The initial touched-run data-safety inventory failure is superseded by its final 6/6 passing rerun after the documented scratch-path classification.

The earlier shared guard pair returned PASS with zero hits at 0c3d483fb (leak-guard-integrated.json): guard SHA-256 d2f0edb0a84f07feb8526f49ab57af117979cc65117b9927f0559ec90065e515, patterns SHA-256 41e24650cefe80bf5c8a6016d4027846a08a1836d6aede298910e9013d1a4c9c. That historical result is not the final release result. During the run, the shared guard and patterns were replaced externally. The final direct invocation against committed bd699f7ff and base 0bcda6c9e FAILS: 550 whole-tree hits, zero added-line hits, exit 1. Current guard SHA-256: 4f02023f3f43c1703177b6648bcb513f8d63531adc9b7d96549727e1b38fd9e1; patterns SHA-256: 062a8d4d1b44bb1bb8711faabaf0ef5b953dce4c1f3e3da86214c84f8ecf6ca3. The new guard validates patterns and fails on scan errors; the earlier script lacked those checks. No shared patterns, exclusions or guard implementation were changed by this job. Final committed-tree evidence is recorded in leak-guard-final.json outside git. Both the shared leak gate and the touched-test gate are OPEN; this branch is not release-ready.

History audit: the only first-parent merges after the verified base have second parents 821b4eae5, bd9960b11, 7a5662a9d and 967196f77, in that order. No int19m or other lane was merged. Integration commits use ci <sean@seandonahoe.com> without attribution trailers.

Final source checks: app and server types PASS again at 0c3d483fb. In an isolated archived copy, dropping the Windows scanner's constructor ban makes the exact regression assertion fail as required; the scanner hash before/after is identical (final-constructor-mutant.log).

The completed touched Vitest run reports 5,312 PASS, 176 FAIL, 95 skipped and 7 todo tests (5,590 total), plus two suite-load errors for missing Electron installation. The one data-safety failure is superseded by 6/6 PASS on the final inventory, leaving 175 unresolved failed assertions. The 38 touched Node files report 586 PASS, zero FAIL and 9 skipped (595 total). The touched PowerShell test reports all 25 assertions PASS, seven parses and one observer compilation PASS.

A clean isolated source copy reproduces all five after-pack test failures: the old signing fixture does not supply context.packager.projectDir, which the approved new provenance check requires (clean-package-tests.json). The initial dirty-tree failures therefore do not explain away this fixture incompatibility. No provenance check was bypassed and no packaging assertion was weakened. Full per-test failure names are retained in int19l-touched-summary.json; the table below lists all failing files from the original complete run.

| File | Failed assertions / suite error |
| --- | ---: |
| electron/browser-closed-shadow.electron.test.mjs | suite load error |
| electron/updater-handoff.electron.test.mjs | suite load error |
| server/app-grant-a13-r2-api.test.ts | 3 |
| server/approve-all-http.test.ts | 5 |
| server/auto-operator.test.ts | 1 |
| server/automations-chat-api.test.ts | 2 |
| server/backup-waiting-api.test.ts | 1 |
| server/browser-document-guard-oopif.real-chrome.test.ts | 3 |
| server/comms.test.ts | 4 |
| server/engine-dispatch-parity.test.ts | 1 |
| server/engine-exclusion.test.ts | 1 |
| server/folder-trust-api.test.ts | 8 |
| server/grok-deny-unanswered-api.test.ts | 3 |
| server/index.test.ts | 3 |
| server/launch-inventory-1018.test.ts | 2 |
| server/lee-phantom-scenario.test.ts | 2 |
| server/needs-door-flow.test.ts | 3 |
| server/nolimits-owner-started-api.test.ts | 15 |
| server/person-handoff-extended.test.ts | 1 |
| server/respond-authority.test.ts | 6 |
| server/routine-approval-hold-api.test.ts | 4 |
| server/drivers/codex-mcp-env-launcher.test.ts | 2 |
| server/memory/strip-types-load.test.ts | 1 |
| server/testing/data-safety.test.ts | 1; superseded by passing rerun |
| server/testing/temp-cleanup-guard.test.ts | 1 |
| scripts/after-pack-windows-signing.test.mjs | 5 |
| server/always-allow-grant-scope.test.ts | 4 |
| server/app-grant-a13-r1-api.test.ts | 2 |
| server/browser-unavailable-turn-api.test.ts | 5 |
| server/container-mcp.test.ts | 1 |
| server/decision-log-wiring.test.ts | 7 |
| server/desktop-attention-http.test.ts | 9 |
| server/engine-change-and-close.test.ts | 7 |
| server/engine-questions-api.test.ts | 4 |
| server/folder-trust-v2-api.test.ts | 11 |
| server/folder-trust-v2-settings.test.ts | 2 |
| server/full-access-api.test.ts | 7 |
| server/full-access-options-api.test.ts | 4 |
| server/index-3.test.ts | 6 |
| server/longwork-sleep-api.test.ts | 1 |
| server/respond-fresh-auth.test.ts | 9 |
| server/routine-permissions-api.test.ts | 6 |
| server/sse-scope.e2e.test.ts | 1 |
| server/team-section-create.test.ts | 1 |
| server/thread-recall-seal.test.ts | 2 |
| server/unattended.test.ts | 4 |
| server/vps-container-mcp.test.ts | 1 |
| server/vps-routing.test.ts | 1 |
| server/wait-caller-bundle.test.ts | 1 |
| server/drivers/chat-mcp-client.test.ts | 1 |
| server/drivers/headless-target-guard.real-chrome.test.ts | 1 |

A full checkout of untouched 0bcda6c9e also fails four assertions across launch-inventory, strip-types loadability and temp-cleanup guards (baseline-guards-tests.json: 12/16 PASS). This does not establish that every finding is inherited: the merged cleanup guard reports 17 findings versus 16 on the base, and strip-types reports two versus one. These remain open. The earlier archive-only cleanup probe lacked an export-ignored test file and is superseded by this full-checkout probe.

Cleanup: job-created dependency links, native/runtime tools, server build output, TypeScript build metadata, fixture listing and temporary homes are removed. Test evidence and generated planning receipts are retained under /work/fuigo-builds/swarm-b/int19m2-pre/evidence/. The owned remote replica was removed and no job containers remain. Shared caches and other jobs' assets are not removed. Final hub verification is recorded in push-verification.json outside git.


---

# Integration int19m2-preB

Base: d0f3e7a4393743cfacdd0581fa17083ce0e48778, verified equal to dev/1019-int19l at start. Only the three requested tips are merged, in order, without squash.

## 1. Locale base fix — e15ebee9655a69ecf770c286fd8d61e68b8c4585

Conflicts and resolutions:

- `server/drivers/acp/core.ts`: retain the existing `openCodeToolLimitStore(DATA_DIR)` factory and import, preserving hardened store creation.
- `server/drivers/acp/fuigo-root-state.test.ts`: retain the existing validated session-open anchor and bounded source slice.
- `server/drivers/acp/opencode-tool-budget.ts`: retain the existing safe catalog-restriction wording; keep the incoming path helper addition.
- `server/installation-app-schema-downgrade.ts`: retain the existing beginWrite/endWrite/undoWrite transaction helpers, which preserve the transaction guard.
- `server/outside-own.ts`: retain the existing catalog-publication comment; both sides exclude the same route from tool marking.
- `src/locales/copy-lint/reviewed.json`: merge records by key; retain both branches' reviews and take the incoming accepted same-as-English file hash.
- `src/locales/source-hashes.json`: merge accepted hashes by locale/key, retaining keys added on the integration base.
- `src/locales/de.json`: merge by key; preserve integration-only browser/HighLevel strings and take the reviewed incoming copy edits.
- `src/locales/en.json`: merge by key; preserve integration-only browser/HighLevel strings and take the reviewed incoming copy edits.
- `src/locales/es.json`: merge by key; preserve integration-only browser/HighLevel strings and take the reviewed incoming copy edits.
- `src/locales/fr.json`: merge by key; preserve integration-only browser/HighLevel strings and take the reviewed incoming copy edits.
- `src/locales/hi.json`: merge by key; preserve integration-only browser/HighLevel strings and take the reviewed incoming copy edits.
- `src/locales/ja.json`: merge by key; preserve integration-only browser/HighLevel strings and take the reviewed incoming copy edits.
- `src/locales/pt-br.json`: merge by key; preserve integration-only browser/HighLevel strings and take the reviewed incoming copy edits.
- `src/locales/zh.json`: merge by key; preserve integration-only browser/HighLevel strings and take the reviewed incoming copy edits.

Automatic-merge overlaps found by validation:

- `server/data-dir-inventory.ts`: remove duplicate incoming model-catalog cache classification; retain the existing equivalent exclusion.
- `server/write-tx.structure.test.ts`: retain the base's exact count of three inline guarded transaction openers, matching the retained helper-based delegation downgrade. No transaction assertion is relaxed.
- `electron/cloud-step-up-label.mjs` and all seven translated step-up packs: align the lookup label with the reviewed incoming English label and refresh the source blob hash. Both branches' translations are retained.
- All seven main translated packs and their source hashes: remove obsolete `settings.route.checkingCredit`, already removed from the base's English catalog.
- Rebuild `copy-lint/reviewed.json` from the immutable review records using the repository tool.

Initial checks: types caught the duplicate inventory key; locale/related tests 911 passed, 28 failed (939 total). Remaining baseline copy/review failures are recorded separately after rerun; no review is fabricated.

Locale rerun: all three type targets PASS; 932/939 tests pass, 7 copy/review checks fail. Remaining failures cover pre-existing hook safety wording, browser/HighLevel copy lint and missing/stale review coverage; no behavior or review assertion was changed to hide them.

## 2. askcards + HighLevel — 0675358d6b2f84c0009378af6b05e48dc3308e33

- `ci/gate-tests.txt` (only textual conflict): retain the union of integration snapshot/phone/Windows gates and all incoming askcards/HighLevel gates.
- `server/index.ts` auto-merge inspected: permanent mark is written before creating the HighLevel mount; the typed persisted mark feeds the permission backstop; runtime receives the persisted-mark reader for native calls, including previously mounted capabilities.
- `server/highlevel/engine-policy.ts`, `thread-marks.ts`, `thread-marks-restore.ts`, `runtime.ts` and incoming mark regression tests are retained unchanged from the reviewed unit. Existing integration-only call-ledger and anchored/config test updates survive.
- Both restore paths retain the union-before-replacement refusal logic. Provider confirmations, unconfirmed continuations, one dispatcher/journal and exact follower-set semantics remain from the reviewed unit.

Automatic-merge overlap: `server/added-table-lifecycle.ts` received a second `phone_ask_optins` key. Retain the existing equivalent marker classification (the effective last property) and remove the incoming duplicate; keep the new permanent HighLevel mark entry. TypeScript identified the duplicate; lifecycle/snapshot checks are rerun after this correction.

Second merge validation: all three type targets PASS after deduplication. Full askcards/HighLevel/snapshot run: 15,760 passed, 6 platform skips across 59 files; includes all 12 askcards budget cases (120 fake-engine turns). Metadata-only lifecycle correction recheck: 18 passed, 3 platform skips. Logs retain the initial duplicate-key warning and the clean recheck.

## 3. pause100 — 61ee68d8ce0a856320bb2bea8c912ecbad5da461

- `server/drivers/openai-chat.ts`: keep the base's options-object constructor and Cloud-specific refusal classifier/early return. Add the incoming request-key argument as an options property, forward the dispatched key at the call site, and pass it to the incoming scoped 402 reporter. Preserve key-evidence ordering and the incoming pre-dispatch spend gate before the synchronous memory-header decision/fetch.
- `server/web-search.ts`: retain the base's ordered key-health evidence imports and reporting; add the incoming spend-gate import and await before taking the request's evidence ticket. Both admission and stale-response protection survive.
- `server/index.ts` automatic merge inspected: pause/account wiring is added independently of the permanent HighLevel mark, mount gate, permission backstop and runtime state reader. No additional branch is merged.

Automatic integration inventory reconciliation: `server/flux-admission.ts` now declares two base-only paths as `none`: `cloud-home/flux-home-gate.ts` performs GET `/v1/cloud-home/status`; `drivers/openai-compat.ts` performs GET `/models` and delegates model turns to the already-gated shared runtime. These match the existing memory-header inventory classifications; no admission behavior or lint assertion changes. Initial pause test run: 290 passed, one missing-inventory failure.

## Verification and open gates

All execution used `IT_JOB=int19m2-preB`, the specified worktree and `it-remote.sh` with the specified generic fallback. At most two containers ran concurrently, with observed local load below 85. Containers used Node 24, an unprivileged user and no network. No live app/data or provider was used.

| Stage | Types | Tests |
| --- | --- | --- |
| Locale | app, server, conformance pass after reconciliation | 932 passed, 7 failed / 939 |
| askcards + HighLevel | app, server, conformance pass after reconciliation | 15,760 passed, 6 platform skips / 15,766 (59 files) |
| Lifecycle recheck | included with corrected HighLevel types | 18 passed, 3 platform skips / 21 |
| pause100 | app, server, conformance pass, including the final inventory recheck | 291 passed / 291 (10 files) |

The isolated fake-engine fixture passed Doctor and cleaned up its owned server/data; fixture info, explicit-URL command list, Doctor JSON, server log and cleanup JSON are retained. Askcards retains the 120-turn driver/card counts and fixture server log. HighLevel source files implementing the typed mark, permission backstop, native runtime check and restore union are byte-identical to the reviewed incoming unit.

**OPEN: shared leak guard.** The required `leak-guard.sh <tree> 0bcda6c9e` fails, with matches in 14 tracked files. A filename-only comparison at starting tip `d0f3e7a43` also identifies the same 14 files. The parallel `leakscrub` branch is outside this three-merge job and was not merged. No exclusions were added and no matches were concealed. Full reports are in the job directory.

**OPEN: locale acceptance/reviews.** `generate-locale.mjs <locale> --accept` was run for de, es, fr, hi, ja, pt-br and zh; all seven exit 1. They refuse missing reviews, including all 17 incoming `ux.l2c.pause.*` English strings and existing browser/HighLevel/hook copy. The locale-stage seven failures are the copy-rule, locale-copy and copy-final review/rule checks. No reviewer approval or acceptance hash was fabricated. These require reviewed copy artifacts before this branch can be called green.

Evidence destination: `/work/fuigo-builds/swarm-b/int19m2-preB/evidence/` (summary JSON, raw logs, test JSON, exact final-check script, fixture evidence and per-locale acceptance exits). Guard reports and baseline filename summary are alongside that directory. Job-created dependency/cache/build outputs are removed after verification; tracked build assets and evidence are retained.


# Integration int19m2 Wave B

Starting branch dev/1019-int19m2-waveB verified clean at 4dbd8ce177c35ea7a12172606a2c9202afb50828. Read MUSTMERGE and Wave A notes before merging. Blocked lanes excluded. Memory prelude tool unavailable and .ijfw/memory absent.

## 1. Memory-start recovery — 7bb5b132c

- ci/gate-tests.txt: union of existing HighLevel, askcards and busyloop registrations with incoming settle-target gate; retain revoke-settle-bounds registration.
- server/turn-dispatch-guard.ts and server/database-busy.test.ts merged automatically; preserve staged-bot/submission guards and recovery seal checks, busy classification and new budget tests.

## 2. Public-source scrub — 18eee2f73
- `cloudflare/control-plane/src/flux-grants.ts`: take incoming public-safe comment wording; runtime code and assertions from both sides retained.
- `docs/superpowers/plans/2026-09-30-flux-streaming-transcription-flux-handoff.md`: retain Wave A public-safe documentation and anonymized references; incoming non-conflicting scrubs retained.
- `docs/superpowers/specs/2026-09-30-flux-streaming-transcription-design.md`: retain Wave A public-safe documentation and anonymized references; incoming non-conflicting scrubs retained.
- `server/avatar-image.ts`: take incoming public-safe comment wording; runtime code and assertions from both sides retained.
- `server/drivers/openai-chat.test.ts`: take incoming public-safe comment wording; runtime code and assertions from both sides retained.
- `server/email/flux-email-client.ts`: take incoming public-safe comment wording; runtime code and assertions from both sides retained.
- `server/flux-contract-endpoints.ts`: take incoming public-safe comment wording; runtime code and assertions from both sides retained.
- `server/flux-hourly-burn.test.ts`: take incoming public-safe comment wording; runtime code and assertions from both sides retained.
- `server/flux-refusal.ts`: take incoming public-safe comment wording; runtime code and assertions from both sides retained.
- `server/gateway-busy.test.ts`: take incoming public-safe comment wording; runtime code and assertions from both sides retained.
- `server/limit-continuation.ts`: take incoming public-safe comment wording; runtime code and assertions from both sides retained.
- `server/memory/pin-budget-104.test.ts`: retain Wave A neutral old-product fixture wording; same assertion behavior.
- `src/lib/flux-invite.test.ts`: take incoming public-safe comment wording; runtime code and assertions from both sides retained.

## 3. Notifications — 1d05f2f39, then 0f05216b4

Both merged without textual conflicts, one merge each. Preserve disabled action-button policy; S0 adds measurement kit only.

## 4. Pause copy — cbf6f5813

- `shared/provider-error.ts`: take reviewed incoming copy for overlapping keys/comments; retain both sides of non-overlapping changes.
- `src/locales/copy-lint/links.json`: take reviewed incoming copy for overlapping keys/comments; retain both sides of non-overlapping changes.
- `src/locales/copy-lint/reviewed.json`: retain existing review entries and incoming non-conflicting records; regenerate from immutable records during validation.
- `src/locales/copy-lint/same-as-english.json`: union of same-as-English accepted keys.
- `src/locales/de.json`: take reviewed incoming copy for overlapping keys/comments; retain both sides of non-overlapping changes.
- `src/locales/en.json`: take reviewed incoming copy for overlapping keys/comments; retain both sides of non-overlapping changes.
- `src/locales/es.json`: take reviewed incoming copy for overlapping keys/comments; retain both sides of non-overlapping changes.
- `src/locales/fr.json`: take reviewed incoming copy for overlapping keys/comments; retain both sides of non-overlapping changes.
- `src/locales/hi.json`: take reviewed incoming copy for overlapping keys/comments; retain both sides of non-overlapping changes.
- `src/locales/ja.json`: take reviewed incoming copy for overlapping keys/comments; retain both sides of non-overlapping changes.
- `src/locales/pt-br.json`: take reviewed incoming copy for overlapping keys/comments; retain both sides of non-overlapping changes.
- `src/locales/zh.json`: take reviewed incoming copy for overlapping keys/comments; retain both sides of non-overlapping changes.

## 5. Browser copy — 4d3887e4b

- `src/locales/copy-lint/reviewed.json`: retain ledger provisionally; rebuild from all immutable review records during verification.
- `src/locales/de.json`: retain Wave A overlapping browser disclosure wording (including separate action approval and explicit browser control); incoming non-conflicting copy fixes retained. No permission policy changes.
- `src/locales/en.json`: retain Wave A overlapping browser disclosure wording (including separate action approval and explicit browser control); incoming non-conflicting copy fixes retained. No permission policy changes.
- `src/locales/es.json`: retain Wave A overlapping browser disclosure wording (including separate action approval and explicit browser control); incoming non-conflicting copy fixes retained. No permission policy changes.
- `src/locales/fr.json`: retain Wave A overlapping browser disclosure wording (including separate action approval and explicit browser control); incoming non-conflicting copy fixes retained. No permission policy changes.
- `src/locales/hi.json`: retain Wave A overlapping browser disclosure wording (including separate action approval and explicit browser control); incoming non-conflicting copy fixes retained. No permission policy changes.
- `src/locales/ja.json`: retain Wave A overlapping browser disclosure wording (including separate action approval and explicit browser control); incoming non-conflicting copy fixes retained. No permission policy changes.
- `src/locales/pt-br.json`: retain Wave A overlapping browser disclosure wording (including separate action approval and explicit browser control); incoming non-conflicting copy fixes retained. No permission policy changes.
- `src/locales/zh.json`: retain Wave A overlapping browser disclosure wording (including separate action approval and explicit browser control); incoming non-conflicting copy fixes retained. No permission policy changes.

## 6. Fake fixture request — fd825341c

- server/testing/fake-claude-cli.ts: remove duplicate inline fixtureRequested and use incoming shared helper. The shared helper retains delegation-context stripping and current room-request matching from both sides. Other fake engines now share it; keep marker regression suites.

## 7. No-limits replay runner — 397b1bba4

Merged without conflicts. Runner and offline qualification only; no live/provider run or ONE RULE merge.

## 8. Locale follow-up — 9aaeaa119

Skipped: tip is already an ancestor after the preceding reviewed copy merges. Recheck immediately before push.

Semantic reconciliation: the shared fixture-request helper initially stripped only one trailing delegation pack, while Wave A's Claude fake supported three. Retain the bounded three-pack loop in the shared helper, together with incoming fixture IDs and room-trailer matching; add a cross-contract positive/negative regression.

Review ledger rebuilt using scripts/copy-review.mjs from all immutable merged records; no reviewer approvals were fabricated. All three typecheck targets pass.

Gate inventory reconciliation: register the two new fixture-marker Vitest suites. The inherited unclassified suites remain separately reported as BASE; no inventory check was weakened.

## Wave B verification and disposition

All checks use IT_JOB=int19m2-B, IT_W=/work/fuigo-builds/swarm-b/int19m2-B/wt, IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh and it-remote.sh. Its local fallback supplies read-only shared dependencies/native fixture tools and the private hub. Containers use network none, an unprivileged user, six CPUs and 14 GB each; at most four job containers ran concurrently. Observed launch loads stayed below 40 (wrapper refuses local launch at 60), below the limit of 85. No Mac, live user application/data, external provider, or paid service was touched.

- Typecheck: app, server and conformance pass; final repeat follows the shared helper reconciliation.
- Touched/related root tests: 2,680 pass, 12 fail, 2 skipped across 45 files.
- Notification Node tests: 154/154 pass across 12 files, including disabled-action refusal and S0 production exclusion. Native desktop measurements are not claimed.
- Additional memory settlement/fence tests: 65/65 pass across six files. Shared helper and fake adapter regression recheck: 7/7 pass.
- Final release-inventory tests: 78 pass, one BASE failure; exact remaining inventory findings are identical to Wave A (35), with zero new findings after registering both incoming fixture suites.
- Isolated fixture passes Doctor, create, send, settled state and bot reply; commands, resulting transcript and persistent server log are retained.
- Runner-only offline self-test passes ten structural controls and the fake Ask case, then rejects a bot settings PATCH with HTTP 400. The identical runner against untouched Wave A product fails at the same call. The incoming runner directory was added only as test support to the disposable baseline checkout; tracked baseline product files remained unchanged. Live real-engine replay is not run.

The comparison base is Wave A 4dbd8ce177c35ea7a12172606a2c9202afb50828. Every current red is listed below. Mixed assertions with any new findings are conservatively NEW: six NEW checks, eight BASE checks including the offline runner. Therefore dev/1019-int19m2 must not be fast-forwarded by this job.

Copy detail: deterministic copy rules and completeness have zero findings (28 and 119 baseline findings removed). The rebuilt ledger has 439 findings: 395 retained BASE findings and 44 new findings, with 17 old findings removed. New findings concern hook-repair/browser review coverage and the merged same-as-English file. Catalog validation has 672 diagnostics versus 616 on the base: 497 unchanged, 119 removed missing-translation messages, and 175 newly worded diagnostics (119 now-present translations lack acceptance; 56 source-hash changes). The two catalog assertions and four review/pinning assertions remain NEW; neither accepted hashes nor review approval was invented.

The first fixture attempt failed before launch because the external evidence directory was not writable by the container user; ownership was corrected and the successful rerun supersedes that setup failure. The first inventory run added two unclassified fixture tests; their final registration removes those new findings. The baseline guard fixture invocation additionally reported a repository configuration failure; this does not substitute for the independent matching 31-versus-32 fixture failure or the direct canonical whole-tree guard run.

| Class | File | Failed check |
| --- | --- | --- |
| BASE | `server/flux-contract-endpoints.test.ts` | Flux contract: endpoint list every file that uses a Flux base or host is listed, and every listed file still does |
| BASE | `scripts/leak-guard/check.test.mjs` | shared guard fixtures delegates every shared pattern to the shared script without disclosing fixture contents |
| NEW | `scripts/generate-locale.test.mjs` | locale draft validation accepts every shipped catalog |
| NEW | `scripts/generate-locale.test.mjs` | D24 catalog and hashes include the English fragment actually shipped to the renderer |
| BASE | `server/database-busy.test.ts` | every HTTP answer for a lock goes through busyJson: 503, code DATABASE_BUSY, Retry-After, and no 409 is built from a busy error |
| BASE | `server/index.test.ts` | harness HTTP API lets a Chief create operators from its direct and channel tasks but not from channels it cannot access |
| BASE | `server/index.test.ts` | harness HTTP API create_bot operators inherit the Chief's Auto only when a human enabled it, computer off (AUTOOP1) |
| BASE | `server/index.test.ts` | harness HTTP API create_bot reads the Auto of the task that calls it, not the Chief's profile bit (AUTOOP2 finding 2) |
| NEW | `src/locales/copy-final.test.ts` | copy final lint (blocking, all 8 languages, main and Help) section 2: every review record and ledger entry is valid (and complete once LEDGER_REQUIRED) |
| NEW | `src/locales/copy-final.test.ts` | copy final lint (blocking, all 8 languages, main and Help) busyloop: all 32 recovery strings and their English fallback file have accepted review records |
| NEW | `src/locales/copy-final.test.ts` | copy final lint (blocking, all 8 languages, main and Help) section 2: the records alone give a valid ledger, so a reviewed.json merge conflict can always be rebuilt |
| NEW | `src/locales/copy-final.test.ts` | copy final lint (blocking, all 8 languages, main and Help) section 4: the ledger is required and pins every lint file |
| BASE | `scripts/release-workflows.test.mjs` | only GATE tests block CI (ci/gate-tests.txt) classifies every Vitest file exactly once, each gate file with its OSes and the failure it prevents |
| BASE | `scripts/no-limits-live/self-test.mjs` | offline runner: settings PATCH rejected 400 after fake-ask PASS |

Evidence: /work/fuigo-builds/swarm-b/int19m2-B/evidence/ contains raw logs and JSON, branch audit, test lists/summary, exact per-check red table, copy/catalog/inventory comparisons, isolated fixture evidence and canonical leak guard receipts.

Final gate/cleanup: canonical leak guard v2 passed the whole committed tree and the diff from Wave A with zero hits, including zero tailnet hits. Guard and pattern SHA-256 values are retained in evidence. The pre-push merge of the current dev/1019-int19m2 tip (4dbd8ce17) reports already up to date; the locale tip remains an ancestor. Final app/server/conformance typechecks pass. Job-created dependency links, native mount directories and TypeScript build metadata were removed; the disposable baseline worktree was removed after its tracked files passed an unchanged-source check. No job containers remain. Raw test and guard evidence is retained outside the worktree. Wave B is eligible for the requested branch push, but the six NEW copy/catalog checks prevent the conditional main-branch fast-forward.


# Integration int19m2-Bfix — OPEN

Re-ran the repository ledger rebuild and all seven locale acceptance commands on the clean Wave B tree. The rebuilt ledger is byte-identical; all acceptance commands refuse missing reviews without writing hashes. The complete merged-history audit finds no dropped record that can supply the missing approvals. There are 423 strings without matching accepted records, 12 browser strings with newer explicit Sol fail verdicts, and two unreviewed merged lint files. All 32 busyloop strings already have accepted records; their aggregate test fails on the same-as-English file pin. No copy review, hash, product source or assertion was fabricated or changed.

The exact 435 string IDs, audit conclusions and reproduction details are in [the OPEN copy report](docs/verification/int19m2-bfix-open-copy.md). Raw evidence is under `/work/fuigo-builds/swarm-b/int19m2-Bfix/evidence/`.

Container verification through the required wrapper used network none and at most two concurrent containers: 522 passed and 13 failed Vitest assertions across the full red-table set and generator review regressions. Those failures are exactly the original six NEW and seven BASE checks. The offline runner retains the eighth BASE failure (settings PATCH HTTP 400 after fake Ask passes). No additional failed check appeared. The separate isolated fixture passes Doctor/create/send/settle/reply and closes its owned data and server. The six NEW failures remain OPEN, so `dev/1019-int19m2` is not eligible for fast-forward.

# Integration int19m2-C

Starting Wave B tip: `dfb1dcab2f5c693db81a15e1f3966c5347a310af`.
Comparison base: `dev/1019-int19m2`, `28811f8bb0356e19e77d7705636f41832a359908`.

## Copy review

Extracted the single fenced JSON bundle from Sol's `REVIEW-from-last.txt` without modifying its bytes or verdicts. `copy-review.mjs record --reviewer sol --slug int19b` recorded 435 strings and two complete lint files: 417 passes (including the files), 20 fails. Applied each failure's exact `Corrected string` to its locale, then rebuilt the ledger. All 20 corrections remain on the explicit NEEDS-RE-REVIEW list at `/work/fuigo-builds/swarm-b/int19m2-C/NEEDS-RE-REVIEW.md`, with IDs and old/new text; no new review verdict was authored. Some corrected text already matches historical accepted records, which the existing resolver reuses; this does not represent a fresh review of these corrections.

Archived the two fully superseded pass-only orphan records unchanged under the job's `superseded-records/`, then removed their repository copies as required by the copy lint. Retained all records containing failures. Coverage checks permitted `generate-locale.mjs <locale> --accept` only for `ja`, `pt-br`, and `zh`; `de`, `es`, `fr`, and `hi` remain incomplete and were not accepted.

## Ordered merges and conflict resolutions

All branch tips were fetched from `/work/mb-105-git.git` and verified against full SHAs before merging. Each merge preserves the incoming history.

1. `dev/1019-browser-lock-release`, `360c80ca24c5cac587124d227061b0ff9f80f4f5` (G-MARC CONFIRMED), merge `906e9deca`.
   - `CHANGED-EXPECTATIONS.md`: retained both complete expectation records.
   - `server/index.ts`: combined `browserExecutions.forget` with the existing outside-write release, turn-origin cleanup, task-allowance cleanup, owner/HighLevel cleanup and shared-thread wakeups in `directRuns.onReleased`.
2. `fix/1019-fake-fixture-request`, `dc792faa13d6e06546225b494e98c96138c658b5`, merge `65fc97f64`. Confirmed `fd825341c` was already an ancestor.
   - `server/testing/fixture-request.ts`: retained the incoming loop that strips the entire trailing run of delegation packs, plus the room trailer handling. Both sides' positive/negative multi-pack regression tests remain.
   - ACP import cleanup already matched the merged tree.
3. `fix/1019-int-cloud-reds-b`, `7b34939252f453d916e6ac4d60f77cb428361d64` (MurageCloud B2 AGREE), merge `49fb3a761`.
   - `server/testing/fixture-request.test.ts`: retained the existing additional bounded multi-pack regression as well as incoming tests.
   - `server/browser-handback.test.ts`: retained the existing owned-daemon stop test and all legacy receipt/identity coverage. Added the incoming no-owner/no-signal test and its complete-close fake-time helper, using the current `closeOnly` recovery API. On this tree an absent ownership record causes an immediate refusal before the maintenance CLI; the incoming branch's former 70-second wait is obsolete. Both recorded PIDs must survive the entire settled close, and stale-pid refusal now checks the exact ownership error plus liveness. No production close policy was changed.
   - Incoming delegation-pack fresh-session logic and setup-interrupt baseline assertion merged cleanly.

Verification evidence and final failure classification follow after container checks.

Registered the two incoming browser owner-wait/execution test files in `ci/gate-tests.txt` for all OSes. This prevents new unclassified-test findings from being folded into the known BASE inventory failure; no test assertion or gate was weakened.

The initial copy regression run exposed three obsolete displayed-name assertions for stopped-task `.23`/`.24` instructions. Under Sol's explicit correction, those keys now require asking the bot to start a new task and choosing Continue, and forbid the obsolete extension destination. Existing displayed-name coverage remains on the two applicable keys. The three initial reds are retained in raw evidence and superseded by the final rerun.

## int19m2-C verification and disposition

All verification ran through the requested `it-remote.sh` with `IT_JOB=int19m2-C`, `IT_W=/work/fuigo-builds/swarm-b/int19m2-B/wt`, and `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`. The local fallback mounted shared dependencies, fixture tools, and Git data read-only. Containers had no network, ran as an unprivileged user, and never exceeded two concurrent job containers. No Mac, live application/data, provider, or billable service was used.

- App, server, and conformance typechecks pass. The frontend check was repeated successfully after the copy-test update.
- Final full red-table Vitest set plus copy recorder/regression suites: 527 passed, 11 failed (538 total). Four failures are NEW copy/catalog checks; seven are the known BASE Vitest checks.
- Touched/related tests: 284 passed, 16 failed (300 total). Every failure is in the additional `delegation-pack-dispatch.test.ts` suite, and all 16 reproduce with identical test names and failure-message summaries on untouched `dev/1019-int19m2`. These are additional BASE findings, not integration regressions. The 22 owner-wait API cases, handback ownership tests, extension service/approval tests, direct late-rebuild tests, and other touched suites pass.
- The offline runner passes ten structural controls and fake Ask, then rejects the settings PATCH with HTTP 400 on both trees. This retains the eighth known BASE red.
- The separate isolated fake-engine fixture passes Doctor, create, send, settled state, and a bot reply. Its JSON transcript, action sequence and persistent server log are retained; it closes its exact owned server and temporary data.
- Base comparison used `28811f8bb0356e19e77d7705636f41832a359908`. The incoming offline-runner directory was added only as test support in the disposable base checkout; tracked baseline files remained unchanged.
- Ledger diagnostics fell from 412 on that base to eight, all for the corrected text still lacking a matching review. Catalog diagnostics fell from 616 to 388 (104 new, 284 retained). Both catalog checks remain NEW because they contain new findings. The two ledger completeness checks remain NEW. Busyloop review and complete file pinning now pass. Gate inventory has exactly the same 35 diagnostics as the base, with zero new findings.
- The second recorder invocation correctly refused the unchanged original bundle after the 20 strings changed; it wrote no replacement review. The subsequent rebuild succeeds and leaves 48,752 reviewed strings and all five file pins. The exact original record and all 20 corrections were mechanically compared with Sol's bundle.
- Canonical leak guard v2 passes with zero whole-tree hits and zero added-line hits against the comparison base. Guard/pattern hashes and logs are retained.

Four NEW checks remain, so this job must not advance `dev/1019-int19m2`. The eight known BASE reds retain their classifications. All 20 corrected strings remain explicitly NEEDS-RE-REVIEW, even where historical records already match their corrected bytes. The complete evidence, original bundle, old/new list, archived superseded records, commands, raw test JSON and exact classification are under `/work/fuigo-builds/swarm-b/int19m2-C/`.

| Class | File | Failed check |
| --- | --- | --- |
| NEW | `scripts/generate-locale.test.mjs` | locale draft validation accepts every shipped catalog |
| NEW | `scripts/generate-locale.test.mjs` | D24 catalog and hashes include the English fragment actually shipped to the renderer |
| BASE | `scripts/release-workflows.test.mjs` | only GATE tests block CI (ci/gate-tests.txt) classifies every Vitest file exactly once, each gate file with its OSes and the failure it prevents |
| NEW | `src/locales/copy-final.test.ts` | copy final lint (blocking, all 8 languages, main and Help) section 2: every review record and ledger entry is valid (and complete once LEDGER_REQUIRED) |
| NEW | `src/locales/copy-final.test.ts` | copy final lint (blocking, all 8 languages, main and Help) section 2: the records alone give a valid ledger, so a reviewed.json merge conflict can always be rebuilt |
| BASE | `server/database-busy.test.ts` | every HTTP answer for a lock goes through busyJson: 503, code DATABASE_BUSY, Retry-After, and no 409 is built from a busy error |
| BASE | `server/flux-contract-endpoints.test.ts` | Flux contract: endpoint list every file that uses a Flux base or host is listed, and every listed file still does |
| BASE | `server/index.test.ts` | harness HTTP API lets a Chief create operators from its direct and channel tasks but not from channels it cannot access |
| BASE | `server/index.test.ts` | harness HTTP API create_bot operators inherit the Chief's Auto only when a human enabled it, computer off (AUTOOP1) |
| BASE | `server/index.test.ts` | harness HTTP API create_bot reads the Auto of the task that calls it, not the Chief's profile bit (AUTOOP2 finding 2) |
| BASE | `scripts/leak-guard/check.test.mjs` | shared guard fixtures delegates every shared pattern to the shared script without disclosing fixture contents |
| BASE | `server/delegation-pack-dispatch.test.ts` | direct pack write boundary T-WRITE: G1 alone blocks provider bytes and submission |
| BASE | `server/delegation-pack-dispatch.test.ts` | direct pack write boundary T-WRITE: G2 alone blocks provider bytes and submission |
| BASE | `server/delegation-pack-dispatch.test.ts` | direct pack write boundary T-WRITE: G3 alone blocks provider bytes and submission |
| BASE | `server/delegation-pack-dispatch.test.ts` | direct pack write boundary T-WRITE: G4 alone blocks provider bytes and submission |
| BASE | `server/delegation-pack-dispatch.test.ts` | direct pack write boundary T-WRITE: G5 alone blocks provider bytes and submission |
| BASE | `server/delegation-pack-dispatch.test.ts` | direct pack write boundary T-WRITE-APPEND: a new leaf that keeps every retained row passes |
| BASE | `server/delegation-pack-dispatch.test.ts` | direct pack write boundary T-PREPARED: guard pass records ids even when a later check refuses; a storage error permits the write |
| BASE | `server/delegation-pack-dispatch.test.ts` | direct pack write boundary T-FENCE: forgetting a rendered ref refuses at the provider fence, without suppressing eligible future packs |
| BASE | `server/delegation-pack-dispatch.test.ts` | T-WRITE-CHAIN / Codex setup + late refusal: site 0 retains suppression through real takeover |
| BASE | `server/delegation-pack-dispatch.test.ts` | T-WRITE-CHAIN / Codex setup + late refusal: site 1 retains suppression through real takeover |
| BASE | `server/delegation-pack-dispatch.test.ts` | T-POST-TOOL / Codex late refusal: claude tool=false released=false runs the shipped late-ticket settlement |
| BASE | `server/delegation-pack-dispatch.test.ts` | T-POST-TOOL / Codex late refusal: claude tool=true released=false runs the shipped late-ticket settlement |
| BASE | `server/delegation-pack-dispatch.test.ts` | T-POST-TOOL / Codex late refusal: codex tool=false released=false runs the shipped late-ticket settlement |
| BASE | `server/delegation-pack-dispatch.test.ts` | T-POST-TOOL / Codex late refusal: claude tool=false released=true runs the shipped late-ticket settlement |
| BASE | `server/delegation-pack-dispatch.test.ts` | T-POST-TOOL / Codex late refusal: claude tool=true released=true runs the shipped late-ticket settlement |
| BASE | `server/delegation-pack-dispatch.test.ts` | T-POST-TOOL / Codex late refusal: codex tool=false released=true runs the shipped late-ticket settlement |
| BASE | `scripts/no-limits-live/self-test.mjs` | offline runner: settings PATCH rejected 400 after fake-ask PASS |


# Integration int19m2-Cff

Merged `dev/1019-int19m2` at `28811f8bb0356e19e77d7705636f41832a359908` into Wave B at `c1c30c088c6b7bc6a216293308b9d860b7625dfc` with a two-parent merge. The two incoming commits are `e15aa45f3` (Wave A fixture reconciliation) and `28811f8bb` (failure classification). There were no textual conflicts. All six incoming file changes are retained: the Wave A record, exact unknown-submission warning assertions, strip-only-compatible test-world constructor, approved repeated-refusal copy assertion, and bounded About/source-row assertions. Wave B behavior and corrected-copy acceptance remain intact.

The incoming delta contains four test files, one shared test helper and one document, rather than six executable test files. Verification includes all four direct test files and all three suites importing the changed helper, plus the complete preceding red-table and copy/locale set. Results and baseline classification follow below.

## int19m2-Cff verification

Comparison base: `28811f8bb0356e19e77d7705636f41832a359908`. Merge commit: `bf3f3b296aa8cd0db25f4c9517577aac1efc06eb`. No production source or review records were changed by this integration.

All checks used `/work/fuigo-builds/tools/it-remote.sh`, `IT_JOB=int19m2-Cff`, `IT_W=/work/fuigo-builds/swarm-b/int19m2-B/wt`, and `IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`. Its local fallback supplied read-only shared dependencies, Git objects, and fixture tools. Network was `none`; at most two containers ran concurrently. The supplemental locale check waited for host load below 60. No Mac, live app/data, external provider or billable service was used.

- App, server and Flux conformance typechecks PASS on both trees.
- The matched 38-file set covers all four incoming test files, the entire bot-creation suite (including all three changed-helper consumers), both preceding red tables, and copy/locale regressions. Current: 997 PASS, 24 FAIL, 1,021 total. Base: 968 PASS, 31 FAIL, 999 total. Every current failed assertion has the same named failure and full failure details on base after normalizing checkout paths and source line/column numbers. No suite-load errors occurred.
- The supplemental browser-extension locale suite passes 25/25. Combined current result: 1,022 PASS, 24 FAIL across 39 files (1,046 assertions). All 526 copy/locale assertions PASS.
- All four directly changed tests and all three helper consumer suites PASS (222 assertions). The broader bot-creation suite exposes one additional BASE grant-sink inventory failure, reproduced identically on base. No scanner or assertion was weakened.
- The offline runner passes its structural controls and fake Ask, then fails settings PATCH with HTTP 400 on both trees. Its normalized error stacks match. Since the runner is absent from base, only its five test-support modules and README were overlaid in the disposable baseline checkout; tracked baseline files remained unchanged.
- The separate isolated fake-engine fixture passes Doctor, bot creation, send, settled wait, and bot transcript checks. It closes its exact owned server and temporary data; its transcript and server log are retained.
- Canonical shared leak guard v2 PASS: zero whole-tree and zero added-line hits against `28811f8bb`; guard/pattern hashes and raw logs are retained.

**0 NEW reds; 25 BASE reds** (24 Vitest assertions and the offline runner):

| BASE suite | Failed checks |
| --- | ---: |
| release-workflows | 1 |
| bot-create-outside-1019.sites | 1 |
| database-busy | 1 |
| delegation-pack-dispatch | 16 |
| flux-contract-endpoints | 1 |
| index HTTP API | 3 |
| shared leak-guard fixture | 1 |
| offline no-limits runner | 1 |

Exact commands, file lists, raw JSON/logs, per-assertion classification, container isolation, fixture evidence and guard receipts are retained in `/work/fuigo-builds/swarm-b/int19m2-Cff/`. These results satisfy the requested zero-NEW condition for fast-forwarding `dev/1019-int19m2`; existing BASE failures remain open. This is fixture/test coverage, not native desktop or live-provider qualification.
