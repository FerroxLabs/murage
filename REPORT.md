# Reviewed lane reports

Integration owner: int-train5. Source report owners: acp-stop-retire and gnl-inherit.

These are the input lanes' verification reports at their reviewed tips.
Train-wide qualification is recorded in the integration job evidence.

# ACP Stop retirement, 1.0.19

Owner of the ACP lifecycle producer: acp-stop-retire. Owner of the inert peer,
HTTP tests, and desktop/paired-owner card consumer checks: acp-stop-retire.
There is no new cross-lane contract.

Starting train: `2c608e760185b5f0691fb516be02022f9146b25f`.
Read both abandoned changes: `8c0b84dfb6` and `a843949ebc`.

## Regression evidence

Tests were written and run before the production change. Run 1 exposed an
incorrect untouched-write fixture assumption. Run 2 put a real native answer
write in flight before every adapter ending and reproduced the product defect.
No existing test was removed, skipped, or weakened.

| Test in stop-retire-1019.test.ts | Before | After |
| --- | --- | --- |
| Owner Stop with a pending native receipt | Stop returned with zero request resolutions | Passed |
| Turn settle with a pending native receipt | Passed: existing retirement bound already covers settle | Passed |
| Engine crash with a pending native receipt | Stop returned with zero request resolutions | Passed |
| Second Stop while a receipt is pending | Both Stops returned before request resolution | Passed |
| Stop racing a late answer receipt | Stop returned before request resolution | Passed |

Each adapter case requires exactly one request resolution and one completed
turn, a closed child, one native write, and no second terminal event when the
held callback eventually reports success.

`acp-stop-retire-api-1019.test.ts` has twelve separate cases: question and
approval, each with owner Stop, turn settle, engine crash, abrupt app restart,
second Stop, and late answer. Before the train's recall repair, all twelve were
blocked before ACP dispatch by `MEMORY_RECALL_UNAVAILABLE`; those failures are
not presented as ACP product failures. The strengthened fixture selects only
the actual ACP card through its registered engine record and checks its durable approval record before and after
the ending. Restart kills the exact fixture server with the record still open,
then exercises real boot recovery. Both desktop and paired-owner companion
reads must show one terminal card. Late callback and repeated Stop must leave
that terminal record unchanged. Run 4 passes all twelve API cases. Informational cards are allowed only when
they expose no live request handle.

| API scenario | Question before / after | Approval before / after |
| --- | --- | --- |
| Owner Stop while pending | Recall blocked / Passed | Recall blocked / Passed |
| Turn settle while pending | Recall blocked / Passed | Recall blocked / Passed |
| Engine crash while pending | Recall blocked / Passed | Recall blocked / Passed |
| Abrupt app restart with open recorded ask | Recall blocked / Passed | Recall blocked / Passed |
| Second Stop | Recall blocked / Passed | Recall blocked / Passed |
| Stop racing a late answer callback | Recall blocked / Passed | Recall blocked / Passed |

Logs are outside the repository in the job evidence directory, `run1.log`,
`run2.log`, and subsequent numbered validation logs. These are isolated fake
engine and real server checks, with no installed engine or live user data.
Phone coverage includes authenticated companion HTTP reads and the live SSE
terminal patches consumed by the paired phone. It is not a physical handset
rendering test. Restart coverage verifies the reloaded durable projection.

## Port and omissions

Ported the independent retirement/Stop intent from both abandoned commits:
Stop now joins the turn's settlement promise alongside physical child and pool
teardown. Repeated Stop joins that same promise, including when the child has
already closed. Settlement resolves only after ask retirement and publication
of the single terminal turn event. Existing bounded native retirement stays
in place, so a missing callback cannot hold Stop indefinitely. The abandoned
Stop hunk waited only for an unspawned turn's retirement; the new crash and
held-callback tests prove a spawned child can close before its receipt retires,
so the adapted port joins settlement for both spawned and unspawned turns.

The current train already waits for native question/folder retirement on
settle and uses bounded `deliverNative` retirement, which joins an in-flight
write even when its cancellation frame differs. The abandoned extra slot map
and duplicate receipt collection are therefore redundant and were omitted.
The current notification path also preserves order while posture is idle;
the old notification hunk was not copied over its newer implementation.

Dropped the old policy assertions, command classifiers, deny-set assumptions,
Codex posture/refusal change, and live workflow/phone-witness script changes.
They are unrelated to this lifecycle defect or belong to the discarded
permission design. No permission option, No limits inheritance, wipe rule,
copy, or locale changed. No token floor, deny list, SQL inspection, printf
inspection, or shell inspection was added.

## Other driver inspection

| Driver | Retirement pattern and disposition |
| --- | --- |
| Claude | Broker nextGeneration drains receipts under a fixed bound, then destroys connections and retires remaining cards; leave unchanged. |
| Codex | Settle invokes native ask finish callbacks without awaiting each one, then recycles when approvals were open and joins child teardown. Similar asynchronous pattern merits a dedicated held-receipt test; no defect proven in this lane, unchanged. |
| Pi | closeTurn invokes pending retire callbacks without awaiting them before its terminal event and child termination. Similar pattern merits a dedicated held-receipt test; no defect proven here, unchanged. |
| Antigravity | Untouched system retirement closes its card synchronously; in-flight writes use deliverNative. No equivalent failure proven here, unchanged. |
| Muse Code | finishTurn clears pending entries and emits system resolutions before its terminal gate event; unchanged. |
| OpenAI-compatible drivers | Abort removes pending host approvals and resolves them locally before terminal emission; these are in-process decisions, not ACP stdin receipts. Unchanged. |
| Box | respondToRequest reports unavailable; this engine exposes no native asks. Unchanged. |
| Native logging helpers | Diagnostic serialization only, no approval lifecycle. Unchanged. |

## Integration and qualification

Merged the moving `dev/1019-int-train5` release branch, including the wipe
hybrid ancestry and the recall repair. The older INT-TIP file names train 3;
the explicit MAIN 1114-TRAIN5-IS-THE-RELEASE-TRAIN ruling selects train 5.
Run 3 passed both server and src typechecks and all five new adapter cases,
all three existing native-retirement cases, and the native-ask helper tests.
The existing approval-delivery suite passed 32 of 33 cases. Its HTTP failed-
delivery label assertion sees "Cancelled" instead of the expected delivery
failure message. Run 4 reverses this lane's complete core port in the isolated
replica, reproduces the same assertion, and restores the fixed source before
running the state tests. No expectation was changed.

The broader Stop-gate checker reports seven failures in pre-existing Codex,
Antigravity, Claude and Muse wrapper inventories and their three aggregate
checks. Every scanned driver and checker/config/test source is byte-identical
to the integration base; ACP core is outside that checker inventory. No gate
rule or inventory was changed.

Run 4's ACP Stop-fence card tests pass all 22 cases. Its 43-case Stop-fence
suite has one T13 fixture setup failure: no session/load was observed before
its Stop action. Run 5 reverses the complete core port and reproduces the same
failure at the same line, confirming it is inherited. The assertion stays.
Run 4's patched stage passes 90 of 91 targeted cases, including all 17 new
state regressions. Run 5 repeats those regressions, compares T13 against the
unported core, runs the isolated doctor/new-bot/send/wait/messages workflow,
and repeats server/src typechecks after the final train merge. All 26 state/native cases pass in that final repeat.

The gate-list merge conflict was additive on both sides; kept both ACP entries
and both integration fixture entries. The final integration tip included is
`411660583b` on `dev/1019-int-train5`.

Final validation:

- Run 5: all 26 state/native tests pass; isolated doctor, new-bot, send, wait,
  and messages smoke passes; server and src typechecks both exit 0.
- Run 6: all 26 tests pass again with live desktop and paired-owner SSE
  assertions; the final server typecheck exits 0. Both connected clients
  receive the terminal card patch without refreshing. Restart reads the
  expired durable card after reconnecting to the new server.
- Six remote runs used, within the ten-run cap, all with network disabled.
- Own-diff gitleaks findings: 0. Private-string matches: 0 against both the
  integration base and the original starting train. The full merged diff has
  one gitleaks finding already present in the integration-only diff, with the
  same flagged line and rule; new findings: 0. This follows the MAIN ruling
  that inherited findings do not block a lane's push.
- No existing test was removed, skipped in source, or weakened. Filtered
  baseline reproductions leave the original assertions unchanged.

The hub push and cleanup receipt are recorded in the job's `last.txt`.

---

# G-NL inherited No limits

Implementation and display owner: gnl-inherit. Regression producer and consumer owner: gnl-inherit.
Wipe-check producer owner: wipe-hybrid; release integration owner: int-train5. This lane changes no wipe classifier or release check.

Base: `2c608e760185b5f0691fb516be02022f9146b25f`.
Binding rule: SEAN 11-12 / 11-14 inherited No limits, with only the wipe check asking. Other people's chats remain Ask under SEAN 11-12 12:40Z. Explicit lower levels, draft-only bots and disabled features retain their existing behavior.

## Behavior before and after

The tests were added before the repairs. All commands below are inert policy inputs. The HTTP tests launch the documented isolated verification server, use a fake native engine and the real permission broker, dispatch, channel, webhook and creation routes. Optional recall is disabled through the owner API. The fake's permission marker is recognized inside webhook and channel envelopes; it never executes a command or changes production origin checks.

| Path | Original explicit No limits bot | Original bot inheriting the No limits default | Repaired behavior |
| --- | --- | --- | --- |
| Routine | Normal dispatch has no non-wipe card. The legacy BASE path incorrectly asks when a proven scheduled routine is unattended; a revision-zero No limits record also incorrectly asks. | Ask and Auto defaults follow No limits. An implicit legacy Full access record is incorrectly lowered before inheritance on the external path. | Inherits No limits on every tested path. Non-wipe calls run; the wipe check still asks. |
| Webhook | Normal dispatch has no non-wipe card. A revision-zero No limits record incorrectly asks on the external policy path. | Normal dispatch has no non-wipe card. An implicit legacy Full access record incorrectly asks on the external policy path. | Inherits No limits. Non-wipe calls run; the wipe check still asks. |
| Owner turn from another channel | No non-wipe card. Tested with a paired, owner-linked Telegram message. | No non-wipe card. | Remains No limits. Other people's messages retain Ask and channel-off retains its refusal behavior. |
| Bot-created seat | Incorrectly falls to Ask: the new seat receives a non-wipe key-read card. | Runs without a non-wipe card because the global default rescues the dropped flags. | The seat preserves its creator's effective No limits on its profile and seed conversation. |

`server/no-limits-default-inheritance.test.ts` covers explicit, revision-zero, inherited Ask, inherited Auto and inherited legacy Full access across all four origin projections, ordinary commands, key reads, ordinary protected-file writes, opaque commands, actual broker delivery, zero open non-wipe cards and wipe cards. It also retains explicit lower-level and guest controls. `server/no-limits-default-inheritance-api.test.ts` exercises all eight real dispatch combinations, including actual bot creation. The existing ceiling matrix retains the admitted lower-level controls.

The root repairs resolve live inheritance before any trigger downgrade, retain proven scheduled routine origins when unattended, and preserve effective No limits when creating a seat. A proven No limits service turn can also retain its level when creating from an automated context. Legacy Full access triggers without a No limits default retain their previous lower policy, with dedicated regression controls. No permission check, token floor, deny list, SQL reader, printf reader or shell reader is added.

## Ported and dropped pieces

All four requested commits were inspected with `git show`; their changes were rewritten against the train.

| Commit | Ported or retained | Dropped and reason |
| --- | --- | --- |
| `bff0a7d2fc` | Settings uses the effective bot profile for the selected level and level-change hook, so choosing Ask below inherited No limits is a real choice. The routine editor resolves the same profile. The stale-terms notice describes reviewing terms without promising extra permission cards. `NoLimitsDefaultInheritance.test.ts` now covers the actual display and example rows. | The old helper treated any legacy Full access flag as an explicit owner choice. The current server's stored provenance rules take precedence: legacy Full access inherits unless explicitly chosen. Evidence scripts and evidence directories are outside this display port. The restored display test and both new runtime files are registered in G-NL and the CI gate inventory, preserving every existing entry. |
| `fbeeb009e1` | The renderer uses the shared org-chart reader to identify the workspace Chief, matching the server's single-Chief lookup. | No duplicated role classification is introduced. |
| `5d2d74fc41` | Webhook cells run at No limits; their rendered cells use the existing translated “Goes ahead” label. The routine payment prohibition is hidden at No limits. Webhooks and other people's channel messages have separate rows, preserving guest Ask behavior. A short Settings sentence names the bot, routines, webhooks and the wipe-only rule. No limits channel and setup option labels describe their effective behavior without extra key or setup approval cards; the underlying Full access choices are preserved. | The abandoned unconditional routine “Goes ahead” cell would hide explicit lower routine ceilings. The train's lower-of-ceiling cells are retained. The old combined guest/webhook label is replaced because it describes two different policies. |
| `8c122120a9` | The train already deletes `rest.permissionExplicit` before staging the level write in `server/level-change.ts`. That atomic provenance fix is retained as-is. | No duplicate implementation is needed. Its evidence scripts and gate changes do not belong to this port. |

All changed and new localized copy is present in English, German, Spanish, French, Hindi, Japanese, Brazilian Portuguese and Chinese, with source hashes updated only for those keys. The existing controls, four level choices and lower-level examples remain available. The compact helper and existing detailed example table follow the UX bar's simple surface and complete detail. Draft-only profiles display Ask even if their stored flags once said No limits.

## Verification

Evidence logs are outside the repository, in the job directory. No evidence captures or host-specific paths are committed.

- Run 1: original-train policy/display RED, 14 failures and 22 passes. Four runtime scenarios expose the revision-zero and legacy Full access trigger defects; ten display cases expose the missing port.
- Runs 2 and 3: fixture setup failures, not behavioral RED. They exposed optional-recall setup, Telegram pairing requirements and unavailable remote Git metadata. No product assertion was removed or skipped to resolve them.
- Run 4: normal routines and the inherited seat pass; wrapped trigger messages did not yet request the fake tool. Those rows are not counted as behavioral RED.
- Run 5: final isolated workflow fixture on the original product, 7 passes and 1 behavioral failure. Only the explicit No limits creator's seat produces the unexpected card.
- Run 6: all eight repaired HTTP workflows pass. The broader focused run finds the scheduled legacy BASE-origin gap, stale guest/source assertions and HTML escaping in the new renderer test. These are repaired with named ruling comments where an existing expectation changes.
- Run 7: the existing No limits replay file exposes six obsolete opaque-evaluation card expectations. MAIN NARROW-WIPE explicitly supersedes those expectations; all original inputs and test cases are retained, and each now requires RUN.
- Run 8: 448 passes and one new renderer-test failure caused by HTML attribute order; both the checked and disabled assertions are retained independently of attribute order. Server and locale checks are recorded separately in the run log.
- Run 9, source candidate `a5478f7bc6f1bd3f0e88b93d18bcaf55887fc18e`: all 451 tests pass across 14 focused files; the release-gate syntax and operator inventory check pass; renderer and server typechecks pass; all locale catalogs validate.
- Run 10: the documented isolated control smoke passes doctor, new-bot, send, wait and messages. The captured JSON includes the actual settled state and fake-engine reply, plus bounded server events. Only the fixture's optional recall setting and No limits default were configured.
- Latest integrated release train: `dev/1019-int-train5` at `411660583bec8585b191cf83dd872cf5152c95bd`. The wipe-hybrid commit `fe3d078fdd34` is an ancestor. Integration merges needed no conflict resolution.
- Secret scans against the original base: `gitleaks detect --pipe` on the zero-context diff reports 0 findings; the full-diff private-string scan reports 0 matches. `git diff --check` is clean.

The ten-run limit is fully accounted for above. The final source checks and isolated smoke are green; the remaining commit records this report only.

Every changed existing expectation names its binding MAIN/SEAN ruling. Existing tests, assertions and wipe controls remain; no test is weakened by skipping or deleting it. Packaged macOS, Windows and Linux visual journeys and real model gate rehearsal remain the release integrator's qualification; this report claims the isolated workflows and focused checks only.

# Warm continuation, 1.0.19

Continuation decision, bounded preparation, reset diagnostics, and regression consumer owner: warm-keep.
Recall bundle, reader-view admission, and dispatch recovery owner: recall-s1s2b (successor to recall-s1s2).
The existing marker and write-admission APIs are consumed unchanged; this lane changes no recall bundle, reader-view, recovery, renderer, or shared dispatch-boundary region.

Base: `a28c1436fe8626690b28b2cbe81b0f86aadab10b`.

Tests were written before product changes. The isolated dispatch matrix has Claude and ACP/Grok routes, ten owner turns with normal capture after every reply, restart, an old unfinished revoke that predates the session, and background verification. It checks delivered session identity, Claude process reuse/vendor resume, ACP absence of `session/new` after turn one, and zero continuation-reset lines. Forget, correction, reader-access exclusion, roster change, and a targeted session denial are opposite controls. Reader/thread denial is additionally asserted in the active and retained decision tests. A reply through message-only recall recovery cannot satisfy these tests.

The targeted base test run had 6 failures and 8 passes: both active-memory and retained-session checks discarded an unchanged session while an unrelated revoke's wildcard window still needed narrowing; four assertions also exposed lost checking sub-causes. The existing nine pending-window tests pass: `ae50bbba18` already protects sessions born at or after an old revoke's cap. No change to that privacy predicate is needed.

Continuation preparation now finishes only eligible jobs whose pending windows overlap this session. It asks the existing strict session predicate again after each admitted slice; it never substitutes a shown verdict. Work is capped at 32 raw pending candidates, eight 64-row marker slices, and 25 ms per turn allowance. Candidate limiting happens before audience filtering. The same deadline also permits the existing import writer to finish readiness for an unchanged thread only after bounding both its messages and lineage rows to 256, in the same writer transaction. Central measured marker write/pace admission remains mandatory. Missing lineage or a global certificate, oversized or unordered imports, orphaned or unsupported jobs, too many candidates, budget exhaustion, and unsuccessful proofs remain closed. Final submission, tool, and steer checks perform no settlement writes. Full receipt/content checks still follow a successful session predicate.

The reset line retains fixed codes such as `checking:pending`, `checking:thread-not-ready`, `checking:no-lineage`, `checking:lookup-error`, and `checking:root`. Late submission diagnostics retain the same code. `continuationResetCounts()` exposes per-thread counts without waiting for the fourth-reset warning. The existing bounded second look still recognizes checking reasons after adding their diagnostic suffix.

Qualification to date: the clean focused run passed 44/44 tests. All seven mutants were killed by assertion failures: suppress thread-deny, deny-session, watermark, door-epoch, changed-content, and real-line resets; force checking on warm continuations. The clean run includes 14 real-change/denial controls across the active and retained paths. Server and renderer typechecks completed without diagnostics. The subsequent focused run passed 48/48 checks, including bounded-candidate and unrelated-backlog controls; its dispatch matrix stayed red. A further tests-first run reproduced two small-import readiness failures (35 other checks passed) before adding the bounded readiness completion. The post-merge run passed 54/54 focused checks, including the readiness repair, oversized/unordered/missing-certificate controls, and a real source edit after readiness completion. Its 18 engine-level cases remained red: 13 reached recall fallback, four waited out unfinished capture, and one exposed a stale correction-fixture revision. The final fixture fixes the last two premises with the shared idle-load preload and the current revision of the memory the session cited; all original warm/reset assertions remain. Both server and renderer typechecks returned 0 again; final combined-train qualification remains separate.

The full dispatch qualification remains OPEN pending recall admission/recovery. On the base, the four existing continuation API tests and the new engine matrix fail before establishing the required warm sequence. Captured Claude logs show `MEMORY_RECALL_UNAVAILABLE` and `starting turn without recalled memory`. The first ACP run additionally exposed missing inert-engine cage setup; the new fixture now uses the standard test-only unwrap and fake-environment handoff. The final fixture also uses the shared idle-load preload so normal background capture is not stalled by unrelated test-machine load. The second baseline run restored the exact base continuation modules while retaining this corrected fixture: all 18 matrix cases remained red, including all eight warm scenarios. Failures were 13 recall fallbacks, four capture-settlement timeouts, and one stale correction-fixture revision; engine-level warm and real-change qualification therefore remains incomplete. No recall gate or continuation privacy check is bypassed. These failures must not be counted as successful engine-resume controls.

Integrator smoke assertion (required after merging this lane and recall-s1s2b): for **each Claude and ACP route**, create a fresh isolated memory-active conversation and send **ten consecutive owner turns**, waiting for normal capture after each reply. Assert **zero `memory continuation reset` lines** for its thread and **9/9 follow-ups (turns 2–10) reuse the engine process or resume the same vendor session**. For Claude, require ten first-token lines and `process=reused` or `resumed=true` on every follow-up. For ACP, require no `session/new` after turn one and an unchanged delivered session identity. Repeat after app restart (turn one may be cold), with an old pending revoke predating the session, and while verification runs: **36/36 warm follow-ups per engine, zero resets**. Also retain the independent smoke assertions against message-only fallback, empty system/integrations, and missing follow-up transcript. A real shown-memory forget/edit, access/roster withdrawal, or deny must still discard the retained session.

Pre-tool assistant text **is deliberately shown as its own ordinary chat bubble**. Claude emits completed assistant text before iterating tool uses (`server/drivers/claude.ts:5879`, `:5882`); ACP flushes assistant text at a tool boundary (`server/drivers/acp/core.ts:5508`, `:5567`). The server stores completed assistant text as bot text (`server/index.ts:12268`), and ChatView renders it through Bubble (`src/components/ChatView.tsx:1442`). `src/lib/activity-runs.ts:96–101` explicitly preserves progress prose; only foldable tool steps are selected at `:118`. The existing prose-preservation tests remain in `src/lib/activity-runs.test.ts:139–157`. Rendering is unchanged in this lane; MAIN owns that product decision.


Final handoff: **OPEN**. Ten remote invocations were used, with no skipped or deleted tests. The final run tested functional source `fabb98914c3bc4c8f80a9348876d8bf703b7033b` after the notes and downgrade train merges: **54/54 focused tests pass, 14/14 unit privacy controls hold, 7/7 mutants are killed, and server/src typechecks both return 0**. All **18/18 engine-matrix cases remain red**. Final failure groups are seven recall fallbacks, nine capture-settlement timeouts, and two session-continuity failures. The two continuity failures are the ten-turn Claude old-pending case (nine distinct session IDs across turns 2–10) and the roster control's unchanged setup (its second turn already has a different session). No engine-level warm or real-change qualification is claimed.

The captured tail of the Claude old-pending run shows full memory dispatches with `session.reset=0`, `resumed=false`, and no primary continuation-reset line, following `MEMORY_RECALL_UNAVAILABLE` and successful first-tier re-preparation. The relevant upstream path is `server/index.ts:16448–16453`: every `memoryRedispatch >= 1` commits a fence reset, clears the cursor, and calls `resetSession`, even when the rebuilt attempt eventually obtains memory. That path does not call `noteContinuationReset`. This explains how zero primary reset lines can accompany cold follow-ups; the trace and call site establish this path, without attributing every earlier session loss to it. **Recall recovery owner: recall-s1s2b.** Its successful checking-only recovery must preserve the retained session; the integrator must check native reuse/resume as well as zero logged resets. This lane leaves the other owner's recovery boundary unchanged. The nine remaining capture timeouts also require qualification before claiming the requested warm workflow.

Remote-run ledger (logs and JSON are outside the repository):

| Run | Purpose | Result |
| --- | --- | --- |
| 1 | Initial dispatch baseline and existing continuation API tests | 22 red, 9 green; exposed missing ACP fixture unwrap |
| 2 | Continuation tests before product changes | 6 red, 8 green |
| 3 | First repair, broader holds, typechecks | 32 green; 53 hold tests fail at recall-view admission; typechecks clean |
| 4 | Expanded hard-change controls | 40 green; 3 stale-access fixture failures |
| 5 | Corrected control fixtures and mutants | 44 green; 7/7 mutants killed |
| 6 | Bounded candidates/backlog and corrected engine fixture | 48 green; 18 engine cases red; both typechecks 0 |
| 7 | Exact base continuation modules, corrected engine fixture | All 18 engine cases red: 13 fallback, 4 capture, 1 stale correction revision |
| 8 | Readiness tests before the readiness repair | 2 red, 35 green |
| 9 | Bounded readiness repair and repeated mutants | 54 green; 18 engine cases red; both typechecks 0; 7/7 mutants killed |
| 10 | Final merged-train source and deterministic idle fixture | 54 green; 18 engine cases red as classified above; both typechecks 0 |

The current integration train is merged before handoff; the later gate-classification-only commit changes `ci/gate-tests.txt`, not tested application source. Both requested integration refs are contained. Own changes versus the original base are scanned with gitleaks on the diff and the private-string list; counts are recorded in the job handoff. Pre-tool rendering remains unchanged. The branch is a reviewable candidate, not a warm-engine release qualification.
