# PIP-FLUX-SCHEMA: retry journal r5 verification

This entry supersedes the earlier checkpoint verification. Starting HEAD was
`87a2fa974f8ef0bab530b8024d384a30b09f7f75`; specification:
`/root/swarm1018/_reviews/eld-pipj-design.md` (read in full).
The earlier checkpoint results do not verify this implementation.

## Execution evidence and limits

- One normal repository Vitest attempt, with temporary files confined to this repo:
  `TMPDIR="$PWD/.pip-test-tmp" node_modules/.bin/vitest run src/components/LearningPausedCard.test.ts src/lib/memory-learning-text.test.ts server/memory/pip-transport.test.ts`.
  All three suites stopped in `server/testing/setup.ts:132` with
  `no free port block for offsets 0 in 19600..22600`. **No tests ran.**
  No retry, alternative setup, port shim, or process/socket suite was run.
- `node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.server.json`
  exhausted Node's heap (exit 134). **No successful typecheck is claimed.**
- TypeScript source parsing of the edited TS files found no syntax diagnostics.
  A limited unresolved-import diagnostic inspection is not a typecheck.
- `node scripts/ci-test-tiers.mjs check`: `ok: 3481 Vitest files; 1993 gate, 1488 extended`.
  Both new test files have named rows in `ci/gate-tests.txt`.
- `git diff --check` succeeded. Locale JSON, new key parity/source hashes, and
  preservation of existing key values were checked directly against the start commit.
- No build, install, network, provider call, live-app mutation, merge, or push.
  No isolated server launch was attempted: the user's explicit socket/process
  constraint applies. No end-to-end workflow success is claimed.
- The IJFW memory-prelude tool was unavailable and `.ijfw` was absent in this repo.
- L-COPY merge and copy review are reserved for the lane owner. This tree has no
  `scripts/copy-review.mjs`; none was created. The English strings match the design.
  Fuigo usage remains **source read, not run**; the LFU2 real-engine receipt is
  still the lane owner's final gate, not evidence from this sandbox.

## Final-tree refusal readers

Fresh search after the implementation and tests:

```sh
rg -n 'refused:(cap|monthly-limit|unseen-calls|call-pace)|startsWith\("refused:"\)|isTerminalFamilyState|status\.refusals|state\.refusals|s\.refusals|refusalLine\(' server src shared --glob '*.ts' --glob '*.tsx' --glob '!*.test.*' --glob '!*.spec.*'
```

Every PIP reader in those results:

| Reader | What it does with the new states |
| --- | --- |
| `server/memory/pip-reflect.ts:113` | `isTerminalFamilyState`: all `refused:` states are terminal. |
| `server/memory/pip-reflect.ts:117` | Clears terminal result text/admission through that predicate. |
| `server/memory/pip-reflect.ts:549` | `noteRefusal` retains the last three state/reason entries without an enum filter. |
| `server/memory/pip-reflect.ts:1166` | Keeps a refused family's run while it still owns transport. |
| `server/memory/pip-reflect.ts:1173` | Settles every terminal refusal; only `refused:unstable` adds cooldown at 1175. |
| `server/memory/pip-reflect.ts:1257` | Reaps every refused state that still owns transport. |
| `server/memory/pip-reflect.ts:1270` | Confirmed cleanup drops transport on a refused state. |
| `server/memory/pip-reflect.ts:1433` | Status returns the persisted refusal entries unchanged. |
| `server/memory/pip-reflect.ts:1441` | Try again retains refused runs with transport and clears only fully released ones. |
| `src/lib/continuity.ts:216` | `REFUSAL_LINES` maps the three new states, daily bytes, and the two legacy cap reason keys. |
| `src/lib/continuity.ts:231` | `refusalLine` tries the reason-qualified key before the state key. |
| `src/lib/continuity.ts:247` | Any recorded refusal makes reflection assistance visible. |
| `src/components/ContinuityView.tsx:208` | Takes the last three persisted refusals. |
| `src/components/ContinuityView.tsx:215` | Renders each through `refusalLine`. |

The other PIP hits are writers: daily cap (`pip-reflect.ts:631`), input limit
(`:727`, no `noteRefusal`), and the new lease-refusal map (`:941`). They retain the
specified behavior. `server/email/capabilities.ts` and `server/room-dispatcher.ts`
search hits belong to unrelated refusal stores/functions, not PIP states.
Generic persistence also retains these states without filtering: `readReflectState`
(`pip-reflect.ts:107`) and the maintenance inventory (`:1183`).
`FamilyStateName` already admits `refused:${string}` (`pip-reflect.ts:66`).
`TERMINAL` in `pip-r8-resume-terminal.test.ts` now includes all three new states.

## BUILD-FIX review by number

These are implementation/test references, **not passing runtime results**.

| BUILD-FIX | Code | Regression coverage |
| --- | --- | --- |
| 1 | `src/lib/continuity.ts:226`; ownership guard `server/memory/pip-reflect.ts:1166` retained | `pip-paid-calls.test.ts`, test 30 repeated reap failure through elapsed cooldown, Try again and confirmed cleanup; `ContinuityView.test.ts` unstable causes. |
| 2 | `extract.ts:346` reservation-fit check; `pip-reflect.ts:941`; `continuity.ts:216` | `learning-budget.test.ts`, test 30 reservation does not fit below ceiling, then admission reopens after lower settlement; host ceiling-to-line case in `pip-paid-calls.test.ts`. |
| 3 | `headless-text-only.ts:132` distinct retained answer evidence and stdout bytes; `pip-transport.ts:762` estimate helper | `headless-text-only.retry-ledger.test.ts`, test 29 real empty answer; `pip-transport.test.ts` helper zero-byte case. |
| 4 | `headless-text-only.ts:349` scopes `extraUnseen` to a journal; single-run report at `:244` | `retry-ledger.test.ts`, test 29 single empty/partial/silent cases and journaled mixed sides, absent result and Stop cases. |
| 5 | `headless-text-only.ts:151` retained result/answer evidence, `:312` independent estimate sum, `:329` first report; `extract.ts:378` lease first settlement | `retry-ledger.test.ts`, test 29 overflow plus throwing hook, independent estimated sum, mixed missing totals; existing lease first-report behavior remains. |
| 6 | `pip-transport.ts:769` accepts Claude StructuredOutput input by presence | `pip-transport.test.ts`, test 29 StructuredOutput fixture with 0/0 gets an estimate. |
| 7 | `extract.ts:357` call pace and `:358` daily byte fit; `continuity.ts:218` and `:219` | `pip-paid-calls.test.ts`, test 30 zero pace, full pace and daily bytes below cap but too little room for the request. |
| 8 | `server/memory/settings.ts:548` explicit ceiling acceptance at maxima and release of deferrals; `LearningPausedCard.tsx:20` resume action | `learning-budget.test.ts:404` maximum presses; `:416` month rollover with old row unchanged; `:428` editor save after Leave paused. All admit through real `reserveExtraction`. |
| 9 | `src/locales/en.json` two new usage keys; unchanged existing values | Existing price-word assertion in `LearningPausedCard.test.ts` is unchanged and includes the new L6 key; test 31 pins rendered copy. Seven translated packs and matching source hashes added. |

| 10 | `LearningPausedCard.tsx:26` reservation-fit success promise; `learning-limit.ts:48` exhausted-maximum rule; `memory-learning-text.ts:55` no ineffective raise | `LearningPausedCard.test.ts:80` rendered way-out table; `MemorySection.test.ts:248` no raise on Memory page; `learning-budget.test.ts:477` cleared status, refused large reservation, admitted fitting reservation. |

## Required-test inventory

All tests below are committed for the test rig; none is claimed to have passed here.
`J` = `server/memory/pip-retry-journal.test.ts`;
`D` = `server/drivers/headless-text-only.retry-ledger.test.ts`;
`P` = `server/memory/pip-paid-calls.test.ts`.
Committed state assertions use separate SQLite read connections.

| Design tests | Test location / scenario |
| --- | --- |
| 1, 2, 3 | J: complete/incomplete dead boot, excess on both ledgers, unknown count, replay. |
| 4 | D: independent read inside actual retry spawn; J: live-boot record remains untouched. |
| 5 | D: real reserved retry release, gate rollback, interrupted settlement and close/reopen; J: committed record survives rollback. |
| 6 | J: held writer lock, settlement timer lost, restart without transport state. |
| 7, 17 | J: maintenance without bots/attempts, 100 month rows and 10,000 unrelated rows, 13 month reads, bounded day reads, once-only flag and busy retry. |
| 8 | J: own day/month across boundary, absent day, current month unchanged. |
| 9 | J: admission sees recovered tokens and unseen count before deciding. |
| 10 | J: clear reconciles tokens first, then clears unknown counts. |
| 11 | J: this boot is untouched. |
| 12 | D/J: absent scope, outer transaction, throwing write, cap; first miss retained, no second spawn. |
| 13, 14 | J: empty usage and malformed records. |
| 15 | J: grounding scope and capture retain the reservation handle. Adapter retry suites use real Continuity reservation scopes via `server/testing/retry-reservation.ts`. |
| 16 | J/D: complete, partial, absent, stopped and unreleased retry; known floor, deferred write and replay after settlement. |
| 18 | J: fifty interrupted settlements/restarts through admission, bounded records; owner clears accepted unseen pauses to continue the loop. |
| 19 | J: committed record without second release, reported and estimated first run, one unseen, estimate marker and clear/resume. |
| 20, 28 | P: real gate, validated/isolation/transient unconfirmed content and probe, ownership retained, no cached probe or second send before reap. |
| 21 | D: real gate COMMIT exception with registration success/failure and stop confirmed/unconfirmed; P live-COMMIT case retains transport through host conclusion. |
| 22 | `headless-text-only.retry-verdict.test.ts`: validated/miss/transient/isolation/unsupported/uncertain, cap and cancellation, root lifecycle. |
| 23 | Earlier tests retained; old checkpoint crash cases in P rewritten onto the journal; all three adapter retry suites now use real reservations. |
| 24 | P: eighteen separately named cases, first/retry/probe by six charge/release windows, independent durable count and restart cap; `learning-send.test.ts` release-level evidence. |
| 25 | `learning-send.test.ts`: checks, held check, busy, onAdmit, repeated refusal, failed charge/refund and released exceptions. P covers cap refusal without a refund. |
| 26 | J: one recovered record out of two open on the dead boot. |
| 27 | D/J: partial/missing/estimated combinations, unseen applied once. |
| 29 | D: ten double misses with absent or 0/0 usage; exact byte totals, three single-run engines, real/mixed tokens, floors, Stop timing, single-run exceptions, overflow, throwing hook and trace values. J: estimated crash/month boundary. `pip-transport.test.ts`: zero bytes and Claude structured answer. |
| 30 | P: admission reason to line, terminal settlement and no new cooldown, daily cap and reaper ownership. `learning-budget.test.ts`: reopening and unchanged non-Continuity reasons. `ContinuityView.test.ts`: legacy and unstable keys. Terminal list extended. |
| 31 | Server Inbox tests: limit/unseen/both, doubling and leaving at maxima; client tests: exact body/line, absent cause defaults to limit, maximum button table and request bodies. See the current-round way-out matrix below. MemorySection fixture typed to the updated shared status. |

No design/code conflict required deferring an implementation item. Copy review
and real-provider receipts remain external lane-owner gates as explicitly directed.


## Current round: maximum-limit ways out (2026-11-06)

Starting HEAD: `00d51f931e`. Read only the requested owner pause-card section
through “What the press promises”, BUILD-FIX 8 and 10, and test 31.
This round replaces the earlier hidden-button behavior. No extra design/code
conflict required deferring an item.

| Way out or boundary | Code | Test answering it |
| --- | --- | --- |
| One side at maximum, with room: Double remains and clears unseen | `learning-limit.ts:17`; `settings.ts:548` | `LearningPausedCard.test.ts:90,110` labels and actual action callback request; `learning-budget.test.ts:404` both orientations and real admission |
| Both maxima, unseen: Resume sends unchanged ceiling and releases sources | `LearningPausedCard.tsx:20`; `settings.ts:550` | Card table at `:80`, callback at `:110`; budget test at `:404` checks unseen removal, due deferral, Inbox removal and admission |
| No press, new month | Existing month-scoped ledger in `extract.ts:329` | `learning-budget.test.ts:416`: old unseen row unchanged, status open, real admission |
| Leave paused, then editor save at maxima | `inbox-learning-paused.ts:44`; `settings.ts:548` | `learning-budget.test.ts:428`: hidden card but refused admission before save, unseen cleared and held source released after save, real admission |
| Leave paused lasts only this month | Existing month-scoped dismissal | `learning-budget.test.ts:441`: new month admits, new limit pause renders a row |
| Limit pause at one exhausted maximum or both maxima | `learning-limit.ts:48`; `LearningPausedCard.tsx:42` | Card table `:80` separately checks input maximum, output maximum, both maxima and legacy absent cause: month title plus Leave paused, no Double; Memory table `:248` checks no Raise it |
| Unchanged below-maximum save, either one-sided raise, or learning-only save at maxima | `settings.ts:548` requires each side increased or explicitly saved at maximum | Budget table `:458` keeps unseen counts and refusal; unchanged and learning-only saves keep deferrals held |
| Explicit exhausted maximum save accepts unseen but retains limit pause | `settings.ts:548`, existing usage comparison | Budget `:469`: unseen gone, limit cause and reservation refusal remain |
| Cleared unseen hold with insufficient reservation room | Existing admission fit check; new exact success copy | Budget `:477`: status unpaused, larger run refused, fitting run admitted; card `:100,110` pins promise and failure key |

All file references in the matrix use `server/memory/`, `src/lib/`,
or `src/components/` as appropriate. New coverage extends existing test files;
no new test file needs a tier row.

Current-round execution:
- One requested pure Vitest attempt:
  `TMPDIR="$PWD/.pip-test-tmp" node_modules/.bin/vitest run src/components/LearningPausedCard.test.ts src/lib/memory-learning-text.test.ts`.
  Both suites stopped at `server/testing/setup.ts:132`:
  `no free port block for offsets 0 in 19600..22600`. No tests ran.
  No retry or setup workaround; later-added cases remain unrun as well.
- `node scripts/ci-test-tiers.mjs check` passed:
  `ok: 3481 Vitest files; 1993 gate, 1488 extended`.
- Edited TypeScript syntax parsing and locale key/hash checks passed.
  Locale diffs only append the three new keys; existing text is unchanged.
  An initial combined static-check command stopped at Node's `spawnSync git EPERM`;
  direct file parsing/hash checks subsequently completed without subprocesses.
  These checks are not a typecheck or runtime verification.
- `git diff --check` passed. No builds, installs, network/provider calls,
  socket/process suites, live-data verification, merges or pushes.
  The user prohibited socket/process verification, so no isolated server launch
  was attempted and no server workflow success is claimed.
- The memory-prelude tool is unavailable and `.ijfw` is absent.
  L-COPY and test-rig execution remain with the lane owner.

## Rig-failure repair round (starting HEAD 1915e27a9c)

Design authority: eld-pipj-design.md r5; review: eld-pipr9-astra.md.
The supplied rig output has 56 failed / 477 passed. The diagnoses below are
source traces of those failures, not claims that the repaired tests ran here.

| Failure or review item | Cause and change | Evidence expected on the rig |
| --- | --- | --- |
| A: server types | Test table explicitly accepts `Record<string, number>`. Pure ceiling request functions moved into `src/lib/learning-limit-request.ts` with relative imports, re-exported by `learning-limit.ts`; copyright header is first. Server budget tests import the pure module. | Server tsc exits zero; existing client imports retain the same functions. |
| B: all 16 flux-schema and 10 retry-verdict setup failures | Shared setup creates HOME, not DATA_DIR. These suites opened SQLite before making DATA_DIR; later setup never assigned `base`, causing the secondary SafeWipeRefused errors. Both now mkdir DATA_DIR before database(), matching retry-ledger. | Both files reach their test bodies and clean up their assigned temp roots. |
| D retry-ledger: “29: ten tokenless double misses…” (absent and 0/0); “29: real tokens remain exact and a mixed retry adds its estimate”; “29: a fully reported retry has no estimate marker”; “29: trace and reported over-limit still use the engine's values” | Test fixture: partial importOriginal of pip-reaper follows pip-transport → acp/grok → headless back into the adapter before the mock is ready. Synthetic PIDs reach real registration, producing register-failed, so no schema retry runs. Install a namespace spy after module loading. Estimate summation code is unchanged. | Two runs contribute exactly their reported/estimated tokens, with the original assertions unchanged. |
| D retry-ledger: “16, 29: estimated run plus released Stop…”; “29: single run silent preserves the existing accounting” | Same registration fixture failure: the early register-failed return bypasses the ordinary confirmed cancellation path. Exit evidence in the failure output is already true; the uncertain verdict is registration failure, not an unconfirmed-exit accounting bug. | Released Stop rejects and preserves the specified known floor / reservation. |
| D retry-ledger: “12: journal … refusal…” (no-scope, outer, write, cap) | Same fixture failure prevents the initial schema miss and journal path. | Confirmed first miss remains refused/no-structured-output; one spawn and exact settlement. |
| D retry-ledger: “27, 29: mixed sides…” (all three rows); “29: estimated plus a released absent result…” | Same fixture failure prevents run 2 and journal creation, hence absent extraUnseen and knownFloor. | Both released runs are counted; estimate markers and known floors retain their original exact assertions. |
| D retry-ledger: “5: after retry spawn, rollback and reopen…” | Same fixture failure means the second spawn and injected COMMIT failure never happen. | Real second-send rollback, independent committed journal, reopen and exactly-once reconciliation. |
| Retry-verdict fixture seams | Registration and gateRun spies now install after module loading, avoiding the same circular partial-mock mechanism. | Selector and unconfirmed-exit tests exercise their intended verdicts. |
| P: “30: … admission reaches its exact refusal line” (ceiling, unseen, pace-zero, pace-full, bytes) | **Production finding:** HTTP intent was persisted before lease admission, then the certain not-started refusal kept that intent. settleRun correctly refused to discard an owned transport, leaving the run behind. conclude now clears transport for a lease refusal. | Existing no-fetch, exact-line, no-cooldown and run-released assertions all hold; uncertain-child ownership tests remain unchanged. |
| P: “30: daily-cap admission…” | Test seeded a full cap before candidate selection, so scheduling correctly returned no candidate and never reached admission's refusal. Set the competing cap during route resolution, between selection and the admission transaction. | Real daily-cap refusal, exact line, no provider call, no retained run/cooldown. |
| P: “24: … paid cap at …” (first/probe: after-charge-before-begin, after-commit, refusal-before-refund; retry: after-commit) | Test read paidCalls after terminal settlement removed the run, interpreting absence as zero. Capture and assert the committed reflection state through the independent connection at each named window. Replay that actual snapshot for restart, rather than the later live conclusion; retain exact spawn bounds and live-COMMIT ownership assertions. Registration uses the same post-load spy. | All 18 windows must actually checkpoint; 2 before charge commit, 3 thereafter; restart cannot release a fourth call. |
| Astra 1: multi-bot budget | Twenty finish() calls are metered reservations, not unseen calls; ceiling is already full and its check comes first. Test expectation restored to spend-ceiling. | Existing unseen-specific tests remain separate. |
| Astra 2 / BUILD-FIX 5 | Added “BUILD-FIX 5: a single lease ignores a different duplicate report without closing another reservation” in pip-retry-journal.test.ts. Calls reportMemoryUsage directly in one inference lease, outside the retry wrapper, with 91/47 + one estimate then 901/407 + two estimates, while another reservation stays open. | Independent day/month reads unchanged after duplicate, exactly one open reservation remains, final tokens 91/47 and estimate count 1. Removing the lease's state guard changes totals and consumes the other open reservation, failing the test. |
| Astra 3 / Rule 1 | Reworked journal test “5: parent rollback…” to reserve and call journalMemoryRetry before injecting release-transaction rollback; no directly seeded committed record. The adapter crash test is also retained. | Independent connection sees the committed real journal during and after rollback; final settlement removes it. |
| Astra 4 / crash table “During reconciliation” | Added AFTER UPDATE month trigger failure in the caller-owned reconciliation transaction, after the day write and record deletion have been prepared. | Independent reads show original day and month (including the record) after failure; removing fault allows settlement once, repeated reconcile changes nothing. |

Execution and boundaries:
- One Vitest attempt: `TMPDIR="$PWD/.pip-test-tmp" node_modules/.bin/vitest run server/memory/pip-retry-journal.test.ts`.
  Setup failed at ports.ts:36 / setup.ts:132 with “no free port block for offsets 0 in 19600..22600”; zero tests ran.
  No setup bypass or second Vitest attempt.
- Initial server tsc exhausted Node's default 4 GiB heap. With
  `NODE_OPTIONS=--max-old-space-size=12288 node_modules/.bin/tsc -p tsconfig.server.json`, server tsc exited 0.
- `node scripts/ci-test-tiers.mjs check`: passed, 3481 files / 1993 gate / 1488 extended.
  All new cases extend existing tiered test files; no new test file was created.
- `git diff --check` passed. No locale strings changed. No builds, installs,
  network/provider calls, merges, pushes, or live-data verification.
- Runtime and mutation verification remain with the lane owner's isolated rig.
  No server-workflow success or mutation-test execution is claimed here.
  The memory-prelude tool is unavailable. No design conflict or copy change blocks an item.

## Review round: Grok B r3, Grok A r3, Astra r10 (all items in 1.0.18)

These cases are committed for the isolated rig. The sandbox's one Vitest attempt
failed during setup, so no runtime or mutation result is claimed in this round.

| Item | Change and regression evidence |
| --- | --- |
| A1 | `LearningPausedCard.tsx` chooses `settings.l6.paused.resumed` for unseen; limit/absent cause chooses new `settings.l6.paused.doubledFits`. Card tests exercise all three causes and both returned pause statuses. |
| A2 | `memoryPage.ceiling.raised` now says exactly “Limit raised. Learning resumes as soon as a run fits your limit.” All seven non-English packs carry the same conditional meaning; English source SHA-256 hashes updated as in the earlier locale commits. |
| A3 | Shared pure `canRaiseCeiling` compares each exhausted side to its capped doubled limit, strictly. Both screens use it. Card tests cover equality, excess, just-under, capped growth, one/both maxima, unseen and absent cause; Memory page adds equality/excess rows. |
| A4 | `settings.ts:539-561` already saves a valid doubled ceiling and returns current `learning.ceiling`; usage at/above it still says paused. No server settings change. `learning-budget.test.ts` calls `/api/memory/action` via owner route with usage equal to and greater than the doubled limit, asserts persisted settings, returned pause and refused admission. Both clients read that response; a still-paused response hides raise and keeps month copy instead of a success line. Memory `act` now returns its answer. Component tests cover returned-status copy and rendered no-raise state. |
| A5 | French `settings.l6.paused.bodyUnseen`, `memoryLearning.ceiling.pausedUnseen`, `settings.l6.paused.resumed` use “ta limite”; body also uses “Tes bots”. New/changed keys in every pack checked against locale-copy's exact language, dash and prohibited-word patterns. No allowlist change. |
| B | Card no-raise rows assert month title and Leave paused. Memory no-raise rows now render inside `AdvancedHost` with Advanced closed, as the real page does: paused sentence and Needs you count are visible; “Resets on the 1st.” and “Change limit” are not. The way out is the separate Needs you card; the limit editor is under Advanced (also available after Leave paused). Zero/off retains its existing Open Advanced test. |
| C1 | `pip-reflect.ts` treats cancelled notStarted like extractor-busy/request-busy: pending, transport cleared, no refusal note. `pip-paid-calls.test.ts` injects that lease result with cancellation and asserts the stored state, no note and no fetch. |
| C2 | Reaper test passes the stored family reason to `refusalLine` and compares it with the persisted refusal note, replacing synthetic “reaper”. |
| D1 | Both headless usage reads preserve earlier real usage when the later result defines neither side. Retry-ledger tests stream the later empty result separately and check exact 9000/5000 settlement, with/without overflow. |
| D2 | Retry-ledger stub sends first result and overflow padding in the same chunk. One spawn, one estimate, exact input estimate and output ceil(total stdout bytes / 3.5). |
| D3 / Astra Low | Paid-call matrix blocks only gate BEGIN for after-charge-before-begin, observes working refund at 2. Refusal-before-refund checkpoints at refund BEGIN after gate refusal, before its write, asserts that separate boundary fired, and replays that snapshot at 3. These refused live passes stop after refund so driveRun cannot consume another call before observation; restart uses a fresh signal. |
| D4 | Journal tests retitled as independent read without spawn and hand-written UPDATE rollback. Comment names the real spawn-window proofs in `headless-text-only.retry-ledger.test.ts`, tests 4/5 (original review lines 72/166). |
| E1 | `pip-maintenance.audit3.test.ts` warms boot reconciliation before measuring steady state (one SELECT, zero fs calls). New first test asserts 13 month-key reads plus one eligibility read, then only one SELECT per subsequent tick. Existing journal boot test retains 13-month/busy-retry coverage. Production once-per-process flag unchanged. |
| E2 | Boundary plant matches current `spawnIt = () => spawned = spawnCli(...)`; still plants setImmediate in the helper, asserts the plant changed source and the scanner catches it. Scan unchanged. |
| F settlement-transaction-atomicity | `server/memory/pip-retry-journal.test.ts`: direct lease settlement, trigger failure at month write after day write, independent reads require rollback of both rows and retained journal; timer retry then commits both and deletes record. Direct lease is intentional: the retry wrapper buffers reports until its callback returns. |
| F known-floor-input / known-floor-output | `server/drivers/headless-text-only.retry-ledger.test.ts`: released incomplete run reports a 900000-token floor on one side, released retry is cancelled; both ledgers retain that floor, two incomplete calls counted. Removing either floor update fails its row. |
| F refund-run-identity / refund-attempt-identity | `server/memory/pip-paid-calls.test.ts`: after charge but before refused gate BEGIN, replace run or attempt identity and set its paid count to 3. Old refund must leave 3; boundary and no-fetch assertions required. |
| F refusal-state-budget-exhausted | `server/memory/pip-paid-calls.test.ts`: inject notStarted budget-exhausted, assert persisted refusal note state is refused:cap (terminal run may be removed), no fetch. |
| F raised-ceiling-output-cap | `src/components/MemorySection.test.ts`: 900 billion output doubles to exactly LEARNING_CEILING_MAX, while input doubles normally. |
| G | This table records every requested item and mutation entry, including production behavior and verification limits. |

Production changes are limited to headless usage preservation, cancelled
notStarted handling, effective-raise eligibility, response-aware pause UI, and
localized copy. No settings-server, maintenance-scan or boundary-scanner change.

Validation this round:
- One command: `node_modules/.bin/vitest run server/drivers/headless-text-only.retry-ledger.test.ts server/memory/pip-maintenance.audit3.test.ts`.
  Both suites stopped at `server/testing/ports.ts:36`, called by `setup.ts:132`:
  “no free port block for offsets 0 in 19600..22600”. Zero tests executed.
  No retry, setup bypass, fixture server, provider call or mutation-script run.
- `node scripts/ci-test-tiers.mjs check`: passed, 3481 files, 1993 gate / 1488 extended.
  All additions are cases in existing tiered files; no new test file.
- Changed/new copy in all eight packs passed the locale-copy language rules via
  a read-only Node check. Source hashes use SHA-256 of the exact English value.
- Frontend `tsc --noEmit -p tsconfig.json --pretty false`: passed after the added render cases.
- Server no-emit check first exhausted the default 4 GiB heap. The larger-heap
  check identified the optional stored refusal reason; its assertion is now
  paired with the persisted note and uses the known-present reason.
- Final server typecheck and diff-check results are recorded below.
- No design/code disagreement was found. The memory-prelude tool is unavailable.
  Runtime and mutation execution remain for the lane owner's isolated rig;
  no live app/data verification, builds, installs, merges or pushes were done.
- Final `NODE_OPTIONS=--max-old-space-size=12288 node_modules/.bin/tsc --noEmit -p tsconfig.server.json --pretty false`: passed (exit 0).
- Final `git diff --check`: passed. Read-only source-hash verification passed for
  both new/changed English keys across all seven translation packs.

## Flux UNKNOWN ruling round (starting HEAD c82fc2dd6c)

A: `pip-transport.ts:762-767` normalizes Flux zero/absent usage to unknown,
with one estimate marker and one unseen. HTTP uses its existing `isFluxUrl`
decision (`http-text-only.ts:73-74`); headless uses the existing schema-in-prompt
route bit (`headless-text-only.ts:158`). The headless aggregate preserves the
explicit single-run unseen count (`:319`); a journaled retry still supplies its
own once-per-released-run count. No production receipt/spend-record read or
provider call was added. Off-Flux accounting is unchanged.

The in-repo design copy is `eld-pipj-design.md`, Rule 2a. Historical test 29's
Flux byte-estimate expectations are superseded by the owner's new ruling;
its retry, overflow, first-report, floor and trace assertions remain, updated
to the reservation and unseen semantics. Off-Flux byte-estimate/empty/partial/
silent controls remain explicit.

All rows below are in `server/drivers/headless-text-only.retry-ledger.test.ts`.
The HTTP driver consumes chat-completions envelopes, not a Responses endpoint;
its Responses fixture represents the zero usage delivered at that adapter
boundary. The cancelled Messages fixture streams message_start with 0/0 and
errors without message_delta. Fetch, child spawn/stop/registration and address
checks are mocked; the real reservation, settlement and independent SQLite
reader are used. These are adapter accounting regressions, not provider-protocol
or end-to-end workflow verification.

| Test name / row | Required assertion | Mutation entry |
| --- | --- | --- |
| A messages-cancelled: http | Both ledgers retain reservation; estimatedRuns 1; exactly one settled unseen | flux-messages-cancelled-http |
| A messages-cancelled: headless | Same; exactly one child | flux-messages-cancelled-headless |
| A responses-zero: http | Both ledgers retain reservation; estimatedRuns 1; exactly one settled unseen | flux-responses-zero-http |
| A responses-zero: headless | Same; exactly one child | flux-responses-zero-headless |
| A finished-missing: http | Reservation, marker and exactly one unseen | — |
| A finished-missing: headless | Reservation, marker and exactly one unseen | — |
| A HTTP off-Flux 0/0 control | Zero charge, no marker, no unseen | — |
| 29: single off-Flux fuigo tokenless run | Existing exact byte estimates, no unseen | — |
| 29: single off-Flux grok tokenless run | Existing exact byte estimates, no unseen | — |
| 29: single off-Flux claude tokenless run | Existing exact byte estimates, no unseen | — |
| 29: single run empty / partial / silent | Existing zero / partial / held-reservation rules; no estimate or unseen | — |
| A headless silent cancellation | Reservation, marker and exactly one unseen | — |
| A headless empty 0/0 result | Reservation, marker and exactly one unseen; no second release | — |

Mutation list: `lanes/pip-flux-schema/eld-pipmut.json`. Each entry names its
production file, exact `from`/`to` substitution, test file and test-name pattern.
All four revert `server/memory/pip-transport.ts:765` to `return report;`, removing
the Flux UNKNOWN rule. Each named row must fail on that mutation (zero settlement
and/or missing marker/unseen). No earlier eld-pipmut file or entry schema was
present in this checkout or the supplied review directory, so the exact earlier
runner format could not be recovered. No mutation execution is claimed.

Validation:
- One attempt: `TMPDIR="$PWD/.test-tmp" node_modules/.bin/vitest run server/drivers/headless-text-only.retry-ledger.test.ts server/memory/learning-send-transports.test.ts server/memory/learning-send-boundary.test.ts`.
  All three suites stopped in `server/testing/ports.ts:36` via `setup.ts:132`:
  “no free port block for offsets 0 in 19600..22600”. **Zero tests ran**. No retry
  or setup workaround. Later-added cases are also unrun.
- `node scripts/ci-test-tiers.mjs check` passed: 3481 files, 1993 gate / 1488 extended.
  All tests extend existing tiered files; no new test file.
- `git diff --check` passed. No isolated server workflow was run or claimed.
- No builds, installs, network/provider calls, live-app verification, merge or push.
  The requested IJFW memory tool is unavailable and `.ijfw` is absent.

B: timing lock work. At starting HEAD, `headless-text-only.ts:373-375`
built the new schema-in-prompt string outside the lock, but `:115` encoded and
wrote that larger string synchronously inside `gate.send`, then spawned the
child. Compared with b2588099f, the file write and spawn already existed; the
lane added schema bytes to that write. The measurement itself uses `lockedAt`
after BEGIN and records after COMMIT (`learning-send.ts:268-284`); it does not
include schema construction, intent persistence, or the new preSend setup.
The supplied 116 ms sample cannot be attributed to a specific syscall here.

Production change: `headless-text-only.ts:98` prepares the private file before
any child exists; `:118` retains only process launch inside the release gate.
The existing pre-spawn gate recheck and refusal cleanup remain. The sink pin
in `ci/learning-sinks.json` now inventories this local preparation (as with the
existing private-root file creation); it does not exempt spawn or stdin release.
No measurement boundary, percentile calculation, budget, or assertion changed.
The test title in `learning-send-transports.test.ts:114` describes the new boundary.

| Test | Evidence required on rig |
| --- | --- |
| retry-ledger: B prompt prepared, refuse=false | Before send: full file, no transaction, no child. Inside spawn: transaction held. After completion: root removed. |
| retry-ledger: B prompt prepared, refuse=true | Same preparation; refused gate creates no child and removes root. |
| learning-send-transports: PIP Fuigo/Grok | Original 40 real stub calls, p99 < 50 ms, one release each, second connection can commit. |
| retry-ledger: A headless off-Flux 0/0 empty control through route selection | Non-Flux providerRoute selects old accounting: zero, no marker, no unseen, one child. |

The two deterministic B cases would fail if preparation moved back into the
send callback. They were added after the single Vitest setup failure and remain
unrun. The 50 ms runtime result, including whether removing file I/O resolves
the reported intermittent spike, remains unverified here and must be measured
on the rig; no timing pass is claimed.

Final A route audit: routed Claude uses `reflectionRoutesToFlux` too
(`headless-text-only.ts:587`), via a ledger-only flag (`:158`). Its existing
schema arguments and verdict parsing are unchanged. The predicate's body is
unchanged; its engine parameter now accepts Claude as well as Fuigo/Grok.

| Additional test in retry-ledger | Required assertion |
| --- | --- |
| A Claude route: messages-cancelled | Explicit Flux route, message_start only; reservation, marker, exactly one unseen |
| A Claude route: responses-zero | Explicit Flux route, empty 0/0 result; reservation, marker, exactly one unseen |
| A Claude route: finished-missing | Explicit Flux route, absent result usage; reservation, marker, exactly one unseen |
| A Claude route: off-flux-zero | Explicit other route; zero charge, no marker, no unseen |

Static checks: the first server typecheck found an unused test variable after
removing byte-estimate expectations; that variable/import were removed. The
next two server no-emit checks passed (exit 0). Edited-file syntax parsing,
JSON parsing and exact mutation `from`/line matching also passed. Runtime,
mutation killing and p99 timing remain unrun; no setup bypass was used.
- Final tree, including routed Claude coverage:
  `NODE_OPTIONS=--max-old-space-size=12288 node_modules/.bin/tsc --noEmit --incremental false -p tsconfig.server.json --pretty false`
  passed (exit 0). Final tier registration and diff checks passed; all four
  mutation entries still match production line 765 exactly.

## Fixed-rig pfs6 follow-up (base d8f3ec984b)

| Item | Change and review evidence | Verification |
| --- | --- | --- |
| A — retained directory | `src/lib/continuity.ts:232` appends the original diagnostic, retaining dash normalization and the 400-character detail cap. `server/memory/pip-paid-calls.test.ts:358` retains prefix/detail assertions and now requires the retained path, including Unix/Windows paths with spaces. Test 27 receives its path through this same helper at `src/components/ContinuityView.tsx:215`, from its refusal reason (`ContinuityView.test.ts:294`); there is no separate display field. | Runtime unrun: setup failure below. Existing test 27 unchanged. |
| B — sink pin | `ci/learning-sinks.json:645` moves only the function/expression to `writeAndSpawn` / `promptBytes`; `not-learning` justification unchanged. Inspection found the helper also reachable through the ungated fallback, so `server/drivers/headless-text-only.ts:125` now calls `spawnIt` directly there; `:99` rejects a supplied prompt without a gate before any write/child and cleans up. `server/drivers/headless-text-only.retry-ledger.test.ts:104` covers that refusal, empty prompt at cleanup, no child, and removed root. | Static call-chain review below; runtime unrun. |
| C — H5 deferral plant | `server/memory/learning-send-boundary.test.ts:580` wraps the prompt write in `setImmediate`, preserving its exact sink anchor and `writeAndSpawn` owner. Expected diagnostic names `writeAndSpawn`; an additional assertion rejects any unpinned or moved-pin diagnostic. | Runtime scan and planted failure unrun: setup failure below. |
| D — evidence | This section records each item, production changes, gate/lock call chain and the single test attempt. | `git diff --check` passed. |

B call chain after the fix: `headlessAttempt` passes the gate and prompt together
at `server/drivers/headless-text-only.ts:413`, calling `runHeadlessCli` at `:407`;
`runHeadlessCli` enters `runHeadlessCliNow` through `oneShots.run` at `:78`.
At `:125`, only `o.gate.send(writeAndSpawn)` reaches the helper (`:121`), which
writes at `:122` then calls `spawnIt` at `:123` (spawn at `:117`).
`server/memory/learning-send.ts:308` delegates `send` to `locked`: BEGIN IMMEDIATE
at `:263`, held checks at `:270`, callback at `:275`, COMMIT at `:277`.
Thus the write and spawn remain synchronous under the same lock. Legacy callers
without a gate already prepare their prompt in `createTempRoot` at
`headless-text-only.ts:387`; Claude uses the separately gated stdin path.

One isolated test attempt, with all temporary homes under the repository:
`TMPDIR="$PWD/.test-tmp" node_modules/.bin/vitest run src/components/ContinuityView.test.ts server/memory/pip-paid-calls.test.ts server/memory/learning-send-boundary.test.ts server/drivers/headless-text-only.retry-ledger.test.ts`.
All four suites stopped in `server/testing/ports.ts:36`, called from
`server/testing/setup.ts:132`: “no free port block for offsets 0 in 19600..22600”.
**Zero tests ran.** No retry or setup workaround; rig verification is outstanding.
No server workflow was run or claimed. No builds, installs, network/provider
calls, live-app mutations, merge or push. IJFW memory prelude was unavailable
in the tool catalog and `.ijfw` is absent from the checkout.


## eld9 narrow-review follow-up (base 0974ce2f35)

| Item | Change and review evidence | Verification |
| --- | --- | --- |
| A — coalesced usage (High) | `server/memory/pip-transport.ts:551-560` retains the latest meaningful usage per result line (either side defined), while preserving the last result's other fields. Driver receipt retention at `server/drivers/headless-text-only.ts:161` and `:255` remains consistent, including overflow. `server/drivers/headless-text-only.retry-ledger.test.ts:200` covers real 9000/5000 then empty usage on Flux in one chunk, separate chunks, the cap-crossing chunk, and cancellation after the result; each asserts day/month totals, no estimate marker and no unseen. Parser coverage at `server/memory/pip-transport.test.ts:39` checks latest one-sided and 0/0 receipts. | Runtime blocked below; no passing test claimed. |
| A — mutation entry | `lanes/pip-flux-schema/eld-pipmut.json:47` adds `flux-coalesced-result-keeps-real-usage`, reverting the per-line keep to `const keptUsage = usage;`. Required failure: `D1: Flux keeps real usage before empty usage (one chunk)`. Existing mutation line offsets refreshed after the parser insertion. | All five exact source/line matches and the new test-name regex checked with Python; mutation killing remains for the rig. |
| B — H5 helper traversal (Medium) | `server/drivers/headless-text-only.ts:125` calls `o.gate.send(() => writeAndSpawn())`. Scanner traversal at `server/memory/learning-send-boundary.test.ts:388` can follow the inline callback into the helper. Existing H5 plant at `:580` and its `deferred write in helper writeAndSpawn (setImmediate)` diagnostic remain unchanged. `ci/learning-sinks.json:644` is unchanged because the write's owner, expression and location are unchanged. No scanner widening. | Static inspection only; H5 execution blocked below. |
| C — evidence | This section records every item, production changes, mutation entry and the single test attempt. | `git diff --check` passed. |

Single isolated test attempt, with temporary homes under the repository:
`TMPDIR="$PWD/.test-tmp" node_modules/.bin/vitest run server/memory/pip-transport.test.ts server/drivers/headless-text-only.retry-ledger.test.ts server/memory/learning-send-boundary.test.ts`.
All three suites failed during setup at `server/testing/ports.ts:36`, called
from `server/testing/setup.ts:132`: “no free port block for offsets 0 in
19600..22600”. **Zero tests ran.** No retry or workaround. Runtime, H5 plant
and mutation verification remain for the lane owner's rig. No server workflow
was run or claimed; no live app/data was used. No builds, installs, provider
calls, merge or push. IJFW memory prelude is unavailable in the tool catalog;
`.ijfw/memory` is absent. No design/code disagreement found in these items.
