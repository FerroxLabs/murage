> Binding amendment: RULING-l8-1019.md (2026-11-10) overrides this historical r2 text. Slice 0 is seated by the l8r0 task. The original F7 review is recovered in evidence/F7-review-original.md and mapped in evidence/l8-provenance.md. Schema/type stubs belong to the separate Slice I0. All implementation and final proof gates remain open for their assigned slices.

# L8 TURN-STATE: complete replacement design for Murage 1.0.19
Revision: r2 plus binding RULING-l8-1019; Slice 0 seated as l8r0. Final implementation review remains required before release.

Job odr2-l8. This revision supersedes DESIGN.md's implementation deferrals and the previous BUILD.md. It is ready for design review, not an assertion of build acceptance. Scope is fixed: L4B section 9, F7, phone/browser turn state, L13 and M2 all ship together. No tests, builds or code changes were performed in this design job. The integration base was independently read with `git rev-parse`: `c12aaad9341e8f87126a193f35b5c2768f0aa66f`.

## 1. Authority, scope and historical evidence

Citations: B = `/work/fuigo-builds/orph/_base`; E = `/work/fuigo-builds/orph/_ev`; P = `/work/fuigo-builds/orph/ORPHAN-PLAN-1019.md`; R = `/fixture/jobs/odes-l8/last.txt`; UX = `/fixture/jobs/_designs/MURAGE-UX-BAR.md`. Source-relative implementation paths below are for the future integration checkout, never permission to edit B.

| Source and quoted decision | Required outcome |
|---|---|
| P:48–50, “L4B-F7 + turn state”, “L13”, “M2 (M2-TURNID)” | All remain in this lane. |
| P:96, “confirming s9 + M2 still fit int/1019” | Port semantics through current lifecycle and security, not old line-number patches. |
| P:109, “L13 rows 5 and 8 NOT FIXED and help-ask-fixture.human.spec.ts never ran” | Keep these proof rows NOT FIXED; the packaged baseline is the build job's first test execution. |
| E/handoffs/FIX-LEDGER.md:3469, “Sean MOVED to 1.0.19 … L4B-F7 + turn state, L13” | Prior BLOCKs do not authorize cuts. |
| E/designs/UX-L4B-FULL-1018.md:139, “isolation is a fact on the run record itself” | Persist isolation through queue, run, rebuild and restart. |
| E/handoffs/HANDOFF-1019-ux-l4b-full.md:3–6, “section 9 … wins where more specific”, both reviews “AGREE” | Preserve section 9 and its later corrections. |
| E/designs/L4B-M2-REDESIGN-1018.md:12–15, “must cost that turn's rows and never the thread's history”, “exact for any writer” | Exact indexed reads with raw-writer maintenance; no scan/span/expression fallback. |
| E/handoffs/FIX-LEDGER.md:3790, “the budget stays”, “additive-only migration”, “bounded batched backfill”, “damaged row never throwing or being lost” | Preserve exactness, migration and measured performance gates. |
| UX:9–43, “Simple on the surface, complete underneath”, “Fine control is never removed” | Section 8 supplies actual layouts, defaults, actions and G9 proof. |
| E/designs/SETTINGS-NO-REGRESS-GATES-1019.md:18, “G9 Meets the UX bar” | Fable Krug review, complete Advanced, search and click evidence are acceptance gates. |

The feature is a view of an ordinary owner conversation with the visible Chief in its pinned direct thread. It introduces no hidden conversation, special engine, approval privilege or memory policy. Existing origin, authority, deletion, retention, usage, FIFO, restore and broad Stop contracts survive. R1-05 remains the help-copy lint plus scripted real-engine release gate on Fuigo, Claude and Codex, including the Dana email case; the panel does not claim to filter arbitrary model prose or change permission levels.

### 1.1 Historical recovery and fixed answers

All nine answers at R:5–13 are adopted without disagreement:

1. The F7 draft is historical input from `304e59c7b`. The complete original review has been recovered from Appendix A of the binding ruling and copied to `evidence/F7-review-original.md`; all six High and eight Medium/Low findings are mapped in `evidence/l8-provenance.md`. Ruling R1 replaces the former missing-review prerequisite. Mapping is complete; behavioral verification remains with the named slices.
2. M2 r1.3 remains rejected. Its actual review was recovered from `/work/swarm1018/_reviews/D-M2-TURNID-astra-r13.md` (84 lines), copied to `evidence/M2-astra-r13.md`. It identifies tree `13315e2a7089360b06d0db253b7e329f8187c2db` and design SHA256 `973fe9fb9fc7288043a866a82fc1c4eb72d87a62805a44fe513518b56c15f458`. Section 9 maps its High and four Mediums to this replacement design. Exactness and performance budgets stay binding.
3. Choose app-maintained `messages.turn_id` with `(thread_id,turn_id)` index, transactional dirty identities for all writers and same-snapshot readiness. Performance is measured, never inferred.
4. Payload-free receipts live as long as their transcript. Deletion first creates scoped irreversible retired-ID digests, retained until installation reset; no duplicate transcript text is stored in receipts.
5. Port verified changes onto the supplied base. Use `571b3212b` for L4B code; `13315e2a7` for M2 history/tests; `5b0a0a1eb` and `19ef45264` for L13 comparison. `29f17944b` is proof provenance; `7c5cbfc3e` is an unverified historical pointer. No wholesale span-era merge or shared-branch rewrite.
6. Preserve the plan's never-run report and E/handoffs/HANDOFF-1018-ux-l4b-full.md:151–155's later `19ef45264` q12 “ALL 15 PASS” report. Neither closes this base. The full packaged fixture, including 7b, runs first under xvfb in a build host container with source/package identity recorded.
7. Old clients keep broad Stop. New clients require affirmative scoped capability; its absence means Open in chat. Never test an old server by sending `turnId`.
8. Current ownership, submission, restore, authorization, deletion and lineage contracts win. Combined-SHA proof is mandatory.
9. Estimate 9–12 builder-sessions plus 1–2 design/review sessions, provisional rather than promised. Sections 3 and 6 now specify the missing schema/protocol. Scope and hard budgets do not shrink if the estimate slips.

No product question is left to the builder. The historical F7 review is an explicit evidence prerequisite, not an invitation to guess its eight findings or to claim their closure.

## 2. Verified current-source facts

These are bounded source reads/symbol searches, not test results. Earlier design citations remain useful provenance; the key replacement boundaries were read again for r2.

| Current evidence | Consequence |
|---|---|
| B/server/turn-dispatch-guard.ts:14–38: `started()` marks unknown; `beforeSubmit` increments `released` and catches `onPassed` errors. `acceptedBy` records provider acceptance, not transport delivery. | A throwing durable gate must precede release; an observer cannot enforce persistence. |
| B/server/index.ts:13075–13078 binds attribution; :14263–14274 invokes `sendProjectUsageTurn` and passes write callbacks. | Persist before this invocation when complete write fencing is not declared/proven. |
| B/server/index.ts:14596–14629 uses `giveBackAdmittedTurn`, report callback and drains. | Extend the current terminalizer hooks; do not add independent cleanup callbacks. Gate release/drain on committed receipt. |
| B/server/index.ts:3009–3051 checks generation before browser release and afterwards, but closes approvals after awaited provider interrupt without a fresh ownership check; final frame also awaits before release. | Recheck every await and every state mutation; return explicit Stop result. |
| B/server/send-store.ts:600–619 checks fingerprint and restore/Stop/action tokens, then deletes failed/refused rows. | Consult durable receipts first; lost acknowledgement must not recreate a failed-with-line send. |
| B/server/send-store.ts:630–636 omits isolation; :883–887 does not recover all started/failed states; :931–950 prunes queue rows. | Add isolation and durable non-prunable receipt semantics. |
| B/server/message-tables.ts:26–35 defines `(thread_id,id)` primary key and optional `seq`; no turn column. | Stable dirty identity is this composite key, never rowid. |
| B/server/message-db.ts:276–297 scans from `turn_first` through later rows; text reader depends on `line`. | Replace both with turn-index seeks; class filtering happens over exact selected rows. |
| B/server/store.ts:3366–3376 filters loaded history and falls back when unprepared; :3396–3400 filters loaded replies. | All three readers must use the authoritative database regardless of loaded state. |
| B/server/store.ts:3382–3390 patches open tools from `turnRowsBounded`; B/server/index.ts:10217,10233,10286,10333,10812,17980 consume these APIs. | Terminal images/replies, activity, task links, reply originals and tool cleanup share explicit not-ready handling. |
| B/server/memory/turn-replay-inputs.ts:4–9,68–103 owns the shared replay selection/widening loop; B/server/memory/lineage-warm.ts:363–380 checks epochs/data_version. | Exclusion is a shared selection input and a warm-proof dependency, not just an index.ts skip list. |
| B/server/memory/disclosures.ts:400–405 filters memory replay; B/server/turn-context.ts:140–186 renders native/non-native transcript input. | Both need exclusion defense, including retained sessions and copies. |
| B/server/memory/optional-index.ts:9,20–36,83–102 uses inline-source Worker threads, catches errors and releases on message/error; readiness at :41–44 checks name only. | Required M2 readiness needs a separate exact-definition controller and observed-worker-exit ownership. |
| B/server/installation-database-snapshot.ts:76 allows `messages.seq` only; :149 has no `owner_sends.isolated`. | Register all schema changes and the actual downgrade/restore transformations. |
| B/src/components/help/HelpAskChief.tsx:4–8,32–68 is the fallback; `HelpAsk.tsx`/packaged fixture are absent in the supplied base. | Recover UI and harness changes; absence/import failures are not behavioral RED. |
| B/server/index.ts:31002–31029 has broad Stop paths; B/server/route-policy.ts:397,416,427–432 and B/companion/src/routes.ts lack the new subject/proof coverage. | Parse scoped shape first and add every authorized door explicitly. |

Isolation inventory additionally includes B/server/steer-queue.ts:88–93,184–192,305–311; B/server/independent-thread-runs.ts:114–125; B/server/steer-lineage.ts:317–318; B/server/loop-nudge.ts:137–138; B/server/index.ts:11453–11536. The direct nudge is a second engine-write entry, correcting the historical single-caller assumption.

## 3. Frozen durable attempt contract (F7)

### 3.1 Schema and immutable identities

All authoritative receipt tables are in the existing messages database so transcript, queue and receipt mutations share a SQLite transaction. `server/send-attempt-state.ts` exports the initializer and typed operations; the integration owner registers it in `database.ts` and the snapshot reference. SQL types: IDs/digests TEXT, revisions/counts/times INTEGER; all non-null unless marked `?`. Enums have CHECK constraints. UUIDs are minted once, not on network retry. No receipt stores text, prompt, attachments or raw error payloads.

| Table | Columns and keys |
|---|---|
| `send_attempts` | `attempt_id` PK; `owner_id, bot_id, thread_id, send_id, fingerprint, isolated, queue_only, phase, delivery, replay_policy, revision, binding_epoch, stop_gen?, restore_gen?, message_id?, queue_id?, terminal_outcome?, terminal_reason?, terminal_at?, cleanup_owed, created_at, updated_at`. UNIQUE `(thread_id,send_id)`; unique partial `(thread_id,message_id)` where message_id not null. `isolated => queue_only`. `phase` = queued/starting/running/stopping/held/terminal. `delivery` = not_submitted/uncertain/submitted. `terminal_outcome` = completed/failed/refused/removed/stopped/abandoned_uncertain. `replay_policy` = exclude/allow. `phase=terminal` iff terminal_outcome is non-null. Terminality does not replace delivery certainty. |
| `send_attempt_bindings` | `(attempt_id,binding_epoch)` PK; `generation`; `provider_instance_id, provider_turn_id?, session_id?, released_writes, invocation_released, sealed, active`. Store `thread_id`; index `(provider_instance_id,thread_id,provider_turn_id,generation)` for correlation, non-unique because an ordinary batch shares a provider run. UNIQUE `(attempt_id,generation)`. Partial unique `attempt_id WHERE active=1`. Scope matches the parent. |
| `send_actions` | `(owner_id,action_id)` PK; `bot_id,thread_id,kind,target_attempt_id,target_revision,target_binding_epoch,target_provider_turn_id?,fingerprint,stop_gen?,restore_gen?,replacement_attempt_id?,replacement_send_id?,status,result_code?,created_at`. `kind` = resend/remove/stop; `status` = pending/done. Resend has unique non-null replacement_attempt_id and replacement_send_id. Action target and request fingerprint never change. |
| `send_replay_exclusions` | `(thread_id,message_id)` PK; `attempt_id?,reason,revision`. Index on attempt_id. Every new attempt's attached user line begins excluded, including ordinary sends. A positively submitted attempt may allow its line under ordinary memory/lineage rules. |
| `send_replay_epochs` | `thread_id` PK, `revision`. Increment in the transaction that changes exclusion or copy eligibility; survives queue pruning. |
| `turn_cleanup_owed` | `(thread_id,generation,kind)` PK; `attempt_id?,provider_turn_id?,terminal_revision?,status`. Kinds tools/replies/images/approvals/release/publication. No payload. Dispatch binding creates recovery ownership before any submit. |
| `send_retirement_keys` | `key_id` PK; `digest_version,installation_scope,key_bytes,active`. One active installation-owned 256-bit random HMAC key; retained read-only keys support imported retirement fences. No transcript data. |
| `retired_send_ids` | `(key_id,digest_version,digest)` PK plus kind and retired_at. Digest is HMAC-SHA256 with installation retirement key over a length-prefixed `(installation,owner,bot,thread,id-kind,id)` tuple. No original IDs, text or reversible encoding. Include attempt/send/action/queue IDs. Keep key and fences until explicit installation reset. |

Attempt scope, sendId, fingerprint and isolation are immutable. The fingerprint uses the existing canonical request fingerprint including text, reply target, attachments and origin; an action fingerprint also covers its exact target and fence tokens. Same send ID plus different fingerprint returns 409 `send_id_conflict` without mutation. Binding generation is immutable within a binding; a pre-submission rebuild atomically seals the old binding and creates the next epoch. Old callbacks retain their old binding token and cannot settle the new binding. A provider ID allocation may populate linkage but never changes delivery to submitted. A transcript line is linked exactly once in the same transaction that appends it. No timestamp or `dispatchedIn` alone proves delivery.

Frozen types (server-internal; not authorization tokens):

```
AttemptKey = {ownerId, botId, threadId, sendId, attemptId}
BindingKey = AttemptKey & {bindingEpoch, generation, providerInstanceId, providerTurnId?}
readAttempt(authorizedScope, sendId): AttemptSnapshot | Missing | Retired
recordInvocation(key, expectedRevision, fencedWrites): ReceiptRevision // throwing
releaseWrite(key, expectedRevision, writeOrdinal): ReceiptRevision    // throwing
settleAttempt(key, expectedRevision, outcome, deliveryEvidence):
  {kind:'committed'|'already'|'stale', receipt, effectsOwed}
```

All mutation functions use compare-and-set on attempt id, revision, active binding epoch/generation and current Stop/restore fence. Zero rows changed is stale/already, never permission to mutate another attempt. A current callback may reload and retry CAS after an intervening evidence update only if its immutable binding, terminal status and fences still match; it never adopts a replacement binding. Ordinary batched receipts share generation/provider correlation and settle together; isolated bindings must have exactly one member. Final settlement atomically commits outcome, delivery, replay policy/epoch, queue disposition, action result and owed effects. Repeating the same settlement returns the original receipt. A conflicting late terminal callback cannot change an already final outcome; stronger positive delivery evidence may be recorded idempotently as evidence without changing a completed Stop into completion or authorizing resend. Unknown evidence never becomes known-unsent merely because time passed.

### 3.2 Mandatory throwing submission gate

Keep `onPassed`/`onNotWritten` as best-effort observers for existing attribution only. Introduce a separate mandatory synchronous persistence gate in `TurnSubmissionBoundary`; it is never wrapped in an error-swallowing observer. The invocation wrapper calls it before evaluating any adapter operation that could submit. For adapters without complete `fencedWrites === true`, persist `delivery=uncertain` and `invocation_released=1` before invocation. For proven fully fenced adapters, invocation may remain not_submitted, but every released write must first pass all current origin, audience, lineage, seal, delegation, ownership and Stop checks and commit `delivery=uncertain`, incremented released_writes and the ordinal. Only then may control return to the adapter's write.

If durable recording throws, the adapter invocation/write must not occur. The attempt stays held and no terminal event/drain is published until a terminal receipt can commit. Do not increment the in-memory released counter before commit. A callback for provider-ID allocation is linkage only. Positive adapter delivery acknowledgement or a provenance-matched provider response promotes uncertain to submitted. `notWritten` may prove a particular ordinal did not write; it cannot erase uncertainty from any previously released write or an unfenced invocation. This design conservatively keeps uncertain once a write was released; automatic rebuild/retry is permitted only while all bindings are positively not_submitted and sealed. Multiple writes, synchronous throws, async setup rejection and post-acceptance refusal are separate tests.

If SQLite becomes unavailable after release, seal further writes, request generation-bound provider Stop, keep resource/thread ownership, return state unavailable rather than a false receipt, and retry settlement with capped exponential delay (1, 2, 4, then 5 seconds while process lives). Existing durable active bindings supply restart recovery if the process dies. Never drain or publish a terminal state because logging succeeded.

### 3.3 Transition table and commit boundaries

| Event and guard | Durable transition | Publication/release rule |
|---|---|---|
| New authorized send; no prior/retired identity | Atomically create receipt and existing outbox/queue row, not_submitted, queued, exclude. If indexing prevents durable acceptance, return 503 and retain client outbox, not a fake accepted receipt. | 202 only after commit; same-ID retry returns it. |
| Queue selection while ownership/fences match | Starting + active binding + cleanup ownership; append/link line transactionally. Isolated row is one batch. | No engine call before commit. |
| Admission refused or setup fails before any possible submission | Terminal refused or failed, not_submitted, exclude, reason code. Preserve visible line if one exists. | Commit then publish and release/drain once, only if still owner. |
| Invocation/write gate | Commit uncertain and release counter before possible operation. | Persistence failure prevents the operation and holds ownership. |
| Provider allocates id | Bind id with current generation CAS. | No delivery/terminal inference. |
| Proven acknowledgement or response | Submitted; running; replay may allow under current memory rules. | Publish after commit. |
| Safe prewrite rebuild | Seal old not_submitted binding; allocate new epoch/generation, preserve attempt/line/isolation/fences. | Intermediate failure is not terminal while replacement owns attempt. |
| Postwrite failure without confirmed delivery | Held or terminal abandoned_uncertain after process closure; delivery uncertain; exclude. | State unknown. Never automatic retry or “did not send”. |
| Failure after positive delivery | Terminal failed, submitted; replay ordinarily allowed. | State submitted_but_failed, not failed-start. |
| Matching provider completion | Terminal completed; submitted only with positive correlated evidence; otherwise uncertain outcome remains unknown. | Receipt before bus event, idle/release and queue drain. |
| Queue Remove before dispatch | Terminal removed, not_submitted, exclude; action committed. | Cancelled visible on every surface. |
| Stop at any owned phase | Seal in memory synchronously before await; persist stop_gen/Stop intent when database permits; phase stopping. Confirm provider closure or proven no process before terminal stopped. | Provider interruption does not wait for DB readiness. Unconfirmed keeps ownership and unknown certainty. Terminal receipt must commit before release. |
| Persistence fails during terminal handling | Retain active ownership and pre-existing cleanup_owed; no terminal receipt is fabricated. | Provider Stop still reachable; replayable terminal job retried without holding a transaction/callback stack. |
| Restart | Scan all active bindings plus started/failed/dispatched/unconfirmed legacy queue rows. Recover committed outcomes; seal abandoned bindings. Proven no invocation/write may settle failed-not-submitted; any possible release is uncertain. | Never infer completion from no live process; never automatically replay uncertain inputs. |

Terminalizer is shared by queue throw, ACP setup failure, background failure after `startTurn` returns, final rebuild exhaustion, provider terminal, scoped/broad Stop, restart and restore. It wraps current admitted-turn give-back hooks and owns their release permission. Callback error does not produce an alternate terminalizer. Batch ordinary sends settle each receipt in the same batch transaction; isolated sends cannot enter a mixed batch. Queue/drain effects are idempotent jobs keyed by terminal revision, so crash after commit and before publication resumes them once without re-executing the send.

### 3.4 Retry, pruning, deletion, restore and downgrade

Same-ID retries return the immutable receipt for every terminal class, including failed-with-line and failed-without-line. Explicit Send again creates a new sendId and attemptId under one persisted action; repeat of that action returns the same replacement. The old receipt remains. It cannot reuse the old transcript line as the new live input. Preserve isolated, queueOnly, via/device/origin and reply/attachment semantics; no new owner authority arises from Help or resend. The request must include the current stopGen and restoreGen when the target is held by either fence; check current restore generation as the existing send-store does. A stale action is never rebound to the latest target.

Queue pruning removes only queue payload/projection rows after their receipt and transcript linkage commit. It cannot remove attempt/action receipts, exclusions, owed effects or deduplication. A no-line rejected attempt retains identity until explicit dismissal/deletion; deletion replaces it with a retired fence too. Keep only one authoritative transcript/outbox payload under existing lifecycle; receipts contain none.

Deletion first revokes current dispatch/replay access, then in one owned transaction inserts retired digests for all receipt/action identities, deletes associated receipts/exclusions and follows the existing transcript deletion lifecycle. Failed transaction leaves the original deduplication protection intact. Installation-wide retired digests and their key are outside transcript retention. Measure rows/bytes for 1,000, 100,000 and 1,000,000 attempts and action/deletion cycles, DB/WAL peaks and bytes per digest; publish estimates for one year at measured rates. No automatic fence expiry or pruning cap is permitted.

Migration adds tables/columns atomically and is idempotent. Import decisive legacy queue evidence as receipts; legacy ambiguous attempted sends get uncertain/excluded and explicit owner handoff. A normal historical conversation with no new receipt remains ordinary context. Do not classify every old line as a failed attempt. Started/failed legacy rows with no reliable write proof remain uncertain. A torn migration exposes maintenance, never partially enabled mutation capabilities.

Backup includes receipts, exclusions, cleanup, replay epochs and retired fences/key through the installation-owned snapshot path. Restore first preserves/merges destination retirement fences and fences source dispatches; rotate restore generation, invalidate pending actions and live bindings, and mark potentially delivered active attempts uncertain. Historical submitted/completed records remain history; nothing restored is an instruction to send. Legacy archives start M2 not-ready and get receipt migration. Retired IDs from before a newer deletion cannot revive when an older backup is restored. Installation reset is the sole lifetime boundary for retirement fences. Import source retirement keys as read-only verification keys and union their fences before the database swap; use the destination active key for new deletions. Lookup checks the scoped digest under each retained key, never raw identities. Key material follows installation backup access controls and is never exposed by state/action APIs.

An older client may read legacy projections, but all server acceptance paths consult receipts. Failed legacy resend flags without a fresh authorized action cannot rerun failed-with-line receipts. For downgrade to an older binary, the controlled exporter seals and confirms closure of active work, preserves receipt/fence metadata in the installation-owned `send-attempt-compat.v1` archive member (versioned, checksummed, atomic export/import through `send-attempt-compat.ts`, no message payload), strips new SQL objects and columns, and prevents old replay of excluded lines with an in-place reversible JSON projection: excluded text rows become non-replay activity rows, keeping their text once and a payload-free original role/kind/version marker. Clear pending executable queue rows into existing restore-held form; bind their retry identities to the compatibility archive, so re-upgrade cannot treat them as new. The downgrade confirmation explicitly says that held failed/uncertain messages require opening chat before sending again. Never copy excluded words into a second text row. Re-upgrade reverses the marker only after receipt/fence recovery and fresh M2 reconciliation. Ordinary completed history is unchanged. Actual 1.0.17 inspector and replay tests must verify the projection; unsupported/ambiguous archives fail export with the source untouched. A manually opened unsupported file has no compatibility guarantee; supported downgrade must not silently discard safety state.

## 4. Isolation and shared replay inputs

An owner Help send uses `noSteer:true`, persisted `isolated=1, queue_only=1`, and `typedStop:false`. A question containing “stop” is text. The server resolves the visible Chief and authorized pinned direct thread; no arbitrary-bot fallback. On resend and rebuild carry isolation from the receipt/run, even if the request omits noSteer. `IndependentThreadRuns.takeOver` captures isolation before removing the held record. The next unrelated generation defaults non-isolated.

Queue splitting treats an isolated row as the entire batch if first and as a boundary if later. Admission checks isolation before ordinary FIFO/busy steering; every actual write repeats it. The only exception is an authenticated answer to an open card owned by that same live generation/provider turn after current card, audience, seal and lineage checks. A guessed turnId, stale card or foreign bot card does not bypass FIFO. Ordinary sends behind Help run exactly once after Help releases; if a refusal occurs while any phase still owns the thread, return to queue and clear speculative dispatched markers. A delayed loop nudge admitted for an ordinary run is dropped at the write fence if an isolated run has taken ownership; it is not queued for later.

Frozen replay interface: `replayEligibility(threadId, messageIds, copyRoots, snapshot) -> {excludedIds, revision}`. It performs indexed point/page lookups for the selected window, not an unbounded query over all failed sends. Any known not-submitted or uncertain attempt line is excluded from automatic provider history, regardless of Help flag. Current attempt input is supplied once by its explicit submission path; it cannot also ride the replay window. Explicit resend creates exactly one replacement input; old excluded lines stay excluded.

| Actual reader/input | Required integration |
|---|---|
| `server/memory/turn-replay-inputs.ts` | Apply eligibility before window budgeting and every widening iteration, merge with existing skip/withheld sets, return exclusion revision as a proof input. |
| `server/memory/lineage-warm.ts` | Include replay exclusion revisions in captured/confirmed proof dependencies; mutation of eligibility, copy roots or restore invalidates warm records even if message text/turn id is unchanged. Check again at write time. |
| `server/memory/disclosures.ts` | Intersect direct and memory replay filters with attempt eligibility; include source exclusions for copy/excerpt provenance. Memory selection cannot reintroduce a failed line through a copy. |
| `server/turn-context.ts` | Render only filtered transcript for both native and textual replay. Revalidation failure causes fresh safe context or held state, never an unfiltered fallback. |
| `server/index.ts` | Direct-start selection, early bundle, both rebuilds, continuation and retained/native session reuse all receive the same revision/proof; no independent skip list. |
| `server/memory/replay-lineage.ts`, `server/branch-store.ts` | Copy/excerpt ancestry preserves source eligibility; deletion/revocation invalidates descendants through existing lineage. Selected copy roots are checked even after queue pruning. |

A retained provider session that may already contain newly excluded input cannot safely forget it merely by filtering the next prompt. Seal its cursor and start a fresh authorized session with filtered replay; do not resume it. Native transcript adapters receive the same filtered entries. Missing source proof in a known attempted-line copy fails closed. Ordinary legacy chat without an ambiguous attempt remains eligible under existing memory and audience rules. Test fresh, resumed, native, rebuilt, copied, pruned, backup/restored and legacy conversations, with actual captured adapter input and warm-cache reuse attempts.

## 5. Scoped Stop, authorization and complete wire contract

### 5.1 Generation-safe Stop

Validate the presence/type of every scoped field before examining `all` or broad Stop branches. If any scoped field is present, require the complete v1 tuple and reject `all:true`, missing/empty/oversized IDs, arrays or wrong types with 400 `bad_scope`; never fall through to broad Stop. Route authorization and subject visibility precede receipt lookup. Match `(owner,bot,thread,send,attempt,bindingEpoch,providerTurnId,generation)` to the live binding. A mismatch returns matched:false, stopped:false and touches no queues/approvals.

Synchronously seal/cancel the captured generation before the first await. The provider interruption stage bypasses the database writer gate and all cleanup writes, but keeps authentication and current in-memory ownership checks. Use the existing authorized request context; if authorization cannot be established, deny rather than bypass it. Release browser capabilities only for captured generation. Recheck ownership after browser release, after provider interrupt success OR rejection, and after final-frame await. Immediately before EACH approval close, email/card cleanup, idle write, watchdog settlement, lease release and drain effect, verify captured identity again. Approval cleanup filters the generation/turn; never closes all approvals on the thread after an await. A thread-scoped adapter call must be dispatched only while the captured generation still owns the thread; current run stays stopping/owned until close confirmation. New provider ownership cannot enter during that call.

Frozen internal result: `{matched:boolean, stopped:boolean, unconfirmed:boolean, attemptId, bindingEpoch}`. `stopped:true` requires confirmed provider closure or proven unwritten/no process plus durable terminal receipt. `Promise<void>`, undefined adapter result and a kill request alone do not prove success for this scoped path. If the run changed, return unmatched and perform no later cleanup. If the provider stopped but persistence is unavailable, report unconfirmed/settlement_pending and retain ownership; retry the same action. Old clients' broad Stop stays broad and keeps its existing queue behavior, routed through the same durable per-attempt terminalizer. Scoped Stop never calls broad queue cancellation, `markSendsStopped` for siblings or unrelated botCalls cancellation.

### 5.2 Capability and state envelope (frozen v1)

`GET /api/config` advertises `turnStateContract:1`, `scopedTurnStop:1`, `sendActionContract:1`, and `queueRemovable:boolean`. Values are subject/surface-filtered; no field or unsupported version means no new mutation. Server advertises them only when migrations/route implementations exist, with runtime maintenance represented by state. Old broad Stop is never used as a panel fallback.

`GET /api/bots/:id/turn-state?threadId=<id>&sendId=<id>[&turnId=<hint>]` returns 200:

```
{ contract:1, botId, threadId, sendId,
  attemptId:null|string, receiptRevision:null|number, bindingEpoch:null|number,
  messageId:null|string, queueId:null|string, turnId:null|string,
  state:'queued'|'sending'|'running'|'approval'|'ended'|'cancelled'|'refused'|
        'failed'|'submitted_but_failed'|'stopped'|'unknown'|'indexing',
  delivery:'not_submitted'|'uncertain'|'submitted'|'unknown',
  terminalOutcome:null|'completed'|'failed'|'refused'|'removed'|'stopped'|'abandoned_uncertain',
  reason:null|string, stopGen:null|string, restoreGen:null|string,
  actions:{remove:boolean,stop:boolean,resend:boolean,openChat:boolean},
  retryAfterMs:null|number }
```

Generation is internal; bindingEpoch + resolved turnId prevent client retargeting. A mismatched hint never follows the hinted foreign turn. Unknown/missing send returns null linkage and unknown, never a guessed latest turn. Forbidden/hidden bot or thread uses the current indistinguishable 404/403 policy with no receipt existence leak. Database unavailable returns 503 `{code:'turn_state_unavailable',retryAfterMs:5000}`; client maps to unknown while keeping prior display, never ended.

| State | Authoritative predicate; allowed mutations |
|---|---|
| queued | Committed not_submitted queued receipt. Remove if authorized. |
| sending | Starting receipt, no matched live provider or awaiting submission classification. No Stop until exact bound target exists; Open in chat. |
| running / approval | Live current binding, with correlated activity/card. Scoped Stop only for an exact bound provider and capability. Approval itself is handled in chat. |
| ended | Committed completed receipt for the current binding, with submitted delivery. Done; never infer from idle or a later message. |
| cancelled | Committed removed receipt. Done. |
| refused / failed | Committed pre-submission refusal/failure and not_submitted proof. Explicit Send again if policy now permits and current fences supplied. |
| submitted_but_failed | Committed failed receipt and submitted delivery. Explicit resend warns about duplication. |
| stopped | Durable stopped receipt. Delivery remains its independent value. New explicit resend uses current Stop fence. |
| unknown | Ambiguous/missing linkage, uncertain delivery, unconfirmed Stop or pruned legacy evidence. Open in chat always available for accessible thread. Resend only when an authoritative target and safe stopped/restore fence can be obtained. A known uncertain attempt with no live process receives a new durable stop_gen only after owned restart recovery proves the old process/session cannot write; uncertainty still remains about prior delivery. |
| indexing | Required read not ready; text/attachments/reply target/send identity remain in durable server queue or local outbox. Manual Try again uses same send identity. Stop for an already resolved live target remains available. |

### 5.3 Actions and HTTP outcomes

All new action bodies include `{contract:1,actionId,threadId,sendId,attemptId,receiptRevision,bindingEpoch}`. `actionId` is minted at first user press and persisted before request. Network retries reuse the byte-equivalent target/body; a new user action after a target change mints a new id. An action lookup is performed only after current authorization and subject checks. Existing receipts may be returned without reexecuting after a fence change; a pending action may not cross a new Stop/restore fence.

| Route/body | Result and retry semantics |
|---|---|
| Existing bot send route, fresh `{sendId,text,replyToId?,attachments?,noSteer:true}` | 202 queued/sending receipt only after commit; 200 existing receipt for idempotent retry; 409 `send_id_conflict` or `retired_send_id`. 503 `turn_index_not_ready` includes `{accepted:false,retryAfterMs:5000}` before dispatch marking; client retains original outbox, never generic definitive failure. |
| `DELETE /api/bots/:id/queue/:queueId`, v1 body above | 200 `{ok:true,state:'cancelled',actionId,receipt}` after commit. 404 authorized row-derived state: `started` -> follow; `sending` -> keep pending/follow; `cancelled` -> removed; `failed`/`refused` -> exact receipt state; `missing` -> unknown and Open in chat. messageId included when authorized and known. Older 404/no state, malformed body, 5xx and timeout mean retryable action error, not Done. Existing old-client DELETE response compatibility is preserved. |
| `POST /api/bots/:id/interrupt`, body above plus `{turnId}` | 200 `{ok:true,matched,stopped,unconfirmed:false,actionId,receipt}` on committed match or safe mismatch. 409 `{code:'provider_stop_unconfirmed',matched:true,stopped:false,unconfirmed:true,actionId}` or `settlement_pending` keeps exact target and offers Try again. Invalid scoped bodies 400 before broad branches. |
| `POST /api/bots/:id/send-actions`, body above plus `{kind:'resend',replacementSendId,stopGen?,restoreGen?,confirmDuplicate:boolean}` | Server generates replacement attempt once in the action transaction. Text comes from authorized original transcript/outbox; no payload in receipt. 202/200 `{actionId,replacementSendId,replacementAttemptId,receipt}` new/existing. 409 `stale_action` for changed target/fences; 409 `stop_required` if old generation still owns possible work; 409 `duplicate_confirmation_required` if delivery uncertain/submitted and confirmation absent; 410 `retired_send_id` if transcript was deleted; no silent recreation. |

For uncertain delivery the UI first offers Open in chat and Stop where positively supported. Resend requires proven current generation closure or restore-held fence plus explicit “This may send your question twice.” confirmation. A pending request whose existence is unknown retries its original sendId; it never mints a new send to escape uncertainty. A pre-submission attempt still holding ownership after a persistence error must first settle/release before even a known-unsent replacement may run. Refused/failed-not-submitted uses “Send again” with no false duplication claim. Capability names and numeric version are frozen; client ignores unknown state/action values safely as unknown.

Every GET/DELETE/POST above is listed in `server/route-policy.ts` and `companion/src/routes.ts`: owner desktop, paired owner phone and permitted owner browser need route proof and bot/thread conversation subject checks. Reject service, anonymous, remembered-owner, wrong device, wrong bot/thread/group, hidden subject and expired/replayed phone/browser proof. Chat-only Cloud browser gets state/chat handoff but no Remove where current policy denies it. Config/SSE `sends` visibility uses the same subject policy. Existing broad Stop authorization is not weakened.

## 6. Frozen M2 physical design and writer protocol

### 6.1 Exact schema; no expression or history fallback

Add `messages.turn_id TEXT` nullable with `ALTER TABLE` only if absent. The source of truth is safe parsing of the final row's existing JSON: a nonempty string `turnId` is its identity; missing, empty, non-string or malformed JSON maps to NULL without rewriting JSON. All comparison/cursor columns use SQLite BINARY collation. Keep `turn_first` for unrelated readers; these APIs never consult it.

```
CREATE INDEX messages_turn_v2 ON messages(thread_id,turn_id)
  WHERE turn_id IS NOT NULL;
CREATE TABLE turn_index_dirty(
  thread_id TEXT NOT NULL, message_id TEXT NOT NULL, ticket INTEGER NOT NULL,
  PRIMARY KEY(thread_id,message_id));
CREATE TABLE turn_index_state(
  id INTEGER PRIMARY KEY CHECK(id=1), protocol INTEGER NOT NULL,
  build_id TEXT NOT NULL, schema_digest TEXT NOT NULL,
  phase TEXT NOT NULL, cursor_thread TEXT, cursor_message TEXT,
  epoch INTEGER NOT NULL, backfill_done INTEGER NOT NULL,
  verified INTEGER NOT NULL);
```

`phase` is absent/installing/backfilling/reconciling/ready/repairing/error. The persisted word ready alone confers no authority. `schema_digest` hashes exact canonical column/index/trigger definitions; readiness also verifies them from `sqlite_schema`/`table_xinfo`/`index_xinfo`. The physical index has exactly `(thread_id,turn_id)` keys with SQLite rowid as the implicit tie-break. Query `SELECT rowid,seq,json FROM messages INDEXED BY messages_turn_v2 WHERE thread_id=? AND turn_id=? AND turn_id IS NOT NULL ORDER BY rowid`. Plan must be an indexed seek, never the thread prefix scan. Text reads use the same turn seek and classify selected JSON with existing `lineClassesOf`; they never require `line`, its class counters, or derived preparation. Work is O(log(total rows) + target turn rows), including text reads. No turn_last/span/floor design, expression index or slow correctness fallback is permitted.

Persistent SQL triggers, containing no JSON functions, cover every writer:

* `messages_turn_dirty_insert AFTER INSERT`: increment `turn_index_state.epoch`; UPSERT `(NEW.thread_id,NEW.id,new epoch)` into dirty. This also covers INSERT OR REPLACE: the final inserted key is dirty even with recursive delete triggers disabled. The only message uniqueness is the composite primary key; any added unique constraint must extend replacement coverage before approval.
* `messages_turn_dirty_update AFTER UPDATE ON messages`: increment epoch; UPSERT OLD identity and NEW identity with that ticket (same pair coalesces). This covers JSON, turn-column, thread/id, metadata, rowid and class changes, including a raw mutation of an already non-null turn column. Do not restrict this to `turn_id IS NULL` or only UPDATE OF turn_id.
* `messages_turn_dirty_delete AFTER DELETE`: increment epoch and UPSERT OLD identity; reconciliation verifies absence and clears the tombstone. A stale marker for a removed row is harmless but blocks readiness until cleared.

Each trigger first checks that the singleton state row/protocol exists and aborts the write on missing controller metadata; a raw writer cannot silently omit a marker because the metadata UPDATE changed zero rows. There is no application bypass flag and no TEMP trigger dependency. Trigger installation/replacement and state creation commit atomically. Arbitrary manual DDL disabling the protocol makes readiness false at the next read/open; successful integrity/schema inspection and full backfill are then required. Ordinary raw DML never requires app cooperation.

### 6.2 Application writes and bounded reconciliation

Both production insertion paths and every patch/upsert route in `message-db.ts` compute the candidate turn id from the final serialized JSON already being written. In the SAME write transaction: write row/turn_id, let dirty triggers run, read back the final row, validate its final JSON identity and column, and only then delete the marker for its current ticket. If another trigger changed the final JSON/identity, correct and revalidate, or abort; never clear on the basis of the caller's pre-write object. Any OLD key whose identity moved is cleared only after checking absence (or reconciling the row now occupying it). App deletion validates absence before clearing. No raw writer is assumed to do this; its committed marker remains.

The controller uses a dedicated Worker thread and its own database connection for parsing, backfill and index construction. Backfill uses a lexicographic `(thread_id,id)` cursor, not a monotone rowid assumption. Install dirty triggers before the census; capture/advance cursor and updated rows in one transaction. Rows inserted/replaced behind the cursor remain dirty and are reconciled. A DELETE or VACUUM cannot change stable message identity. On restart resume only committed cursor progress for the matching build/schema; missing state, index or trigger invalidates ready and causes a fresh pass.

One reconciliation transaction handles at most 64 identities and at most 1 MiB of JSON bytes, measured with `length(CAST(json AS BLOB))`, and yields after a 25 ms target with commit reserve. A row over 1 MiB is processed alone on the worker; never truncated/skipped. Worker blocking and main-thread latency are measured separately; a single large row is not a claim of a hard 25 ms worker bound. Read marker + final row under `BEGIN IMMEDIATE`, parse safely, set turn_id only if it differs, revalidate the final row, then delete the current marker ticket. Reentrant app/trigger updates produce a new ticket and cannot be cleared by an older snapshot. Repeated malformed rows remain byte-identical with NULL turn_id and a counted diagnostic, not an immortal dirty marker; repairing JSON triggers rediscovery. Bounded work retries after lock release at 250 ms, 1 s, then 5 s; no busy spin or thread-history scan on a foreground turn.

Readiness requires ALL of: expected column/index/trigger definitions and protocol; committed complete census; index build/integrity verification; zero unresolved dirty keys. Readiness and target-row query run in one read transaction and one SQLite snapshot. Any stale/non-null column protected by a dirty marker makes the read `not_ready`, even when the requested turn seems unrelated. A second connection committing after the snapshot is a later snapshot, not a mixed answer. Every consumer must await/retry an explicit result; empty ready rows mean exactly zero committed rows for that turn.

Frozen interface in `server/turn-index-state.ts` / `server/message-db.ts`:

```
TurnRead<T> = {kind:'ready', rows:T[], epoch:number}
            | {kind:'not_ready', reason:'schema'|'backfill'|'dirty'|'repair'|'locked', retryAfterMs:5000}
readTurnRows(threadId,turnId): TurnRead<Message>
readTurnTextRows(threadId,turnId,classes): TurnRead<Message>
withTurnReadSnapshot(db, read): TurnRead<T>
```

Keep existing Store method names but change their return types to this explicit result and migrate every caller in the same integration. No throwing `requirePrepared` path may escape through a terminal callback. Database errors translate to not_ready plus diagnostics, never `[]`. Ready-path parsing is solely selected turn rows. A false-ready state under VITEST-unset production is a release blocker.

### 6.3 Caches, consumers and owed terminal work

`Store.turnRows`, `turnRowsBounded` and `turnReplyOriginals` always use authoritative reads, loaded and unloaded alike; eliminate loaded-message fallback. `turnReplyOriginals` applies role/text/copy filtering only after ready rows. `markTurnToolsUnrecorded` only patches point identities from a ready snapshot and rechecks turn membership in its write transaction. All six index.ts call sites in section 2 migrate: staged images, hasReply, terminal lineRows, task suggestions, reply-original copying and turn-scoped work. Other call sites are found by a symbol inventory before type migration; CI must reject a residual unhandled result. This is a complete interface change, not merely replacing two SQL strings.

Turn reads never trust an in-memory turn cache. For loaded transcript views, track `turn_index_state.epoch` and other-connection `PRAGMA data_version`; on mismatch invalidate loaded derived turn/reply maps before use and request authoritative reload. Own writes update/invalidate immediately after commit. A raw writer is visible through epoch/dirty changes, including DELETE/REPLACE. Turn-state uses receipts/database, not loaded display cache. Derived `line`/`turn_first` wipe neither enables a partial result nor disables an otherwise verified turn index. If message/schema repair itself invalidates the protocol, set readiness false in that same repair transaction; `branch-index.ts` must not reset an unrelated completion flag and leave a partial reader enabled.

A not-ready result during terminal handling records `turn_cleanup_owed` in the terminal receipt transaction; the outcome and durable pending work can commit without reading target tools. If the database itself cannot write, the already-durable active binding/cleanup ownership remains and publication/release wait. Park the callback without an open DB transaction or recovery-controller dependency. Retry tools/replies/images against exact reads after readiness; each effect is idempotent and scoped to the old generation. Provider Stop never waits for this read/index gate. Once global readiness returns, new unrelated threads may enter; only threads with owed safety/resource cleanup retain their per-thread barrier. Large settlement backlogs must not impose a hidden global admission hold. Do not close sibling tools or approvals from cached history.

### 6.4 Worker ownership, startup and failure recovery

Required turn-index readiness is an admission gate, not a listener gate. The server may listen and show saved-message/indexing state while migration progresses; no new turn requiring exact data can pass admission. Existing live generations can be interrupted. Optional-index failure is not readiness, and `preListen` name-only success cannot satisfy this contract.

Use Node `worker_threads.Worker` with fixed inline CommonJS source embedded in `turn-index-state.ts`, following the current optional-index precedent. There is no child executable, CLI interpolation, independent entry file or SIGTERM/SIGKILL choreography. Transport only validated database path, protocol and batch options in `workerData`; use current ownership token/lock discipline. Node mode is the existing packaged server/utility process's runtime; the worker inherits that Node runtime, not Electron renderer mode. No `ELECTRON_RUN_AS_NODE` spawn is required because no process is spawned. The server bundle includes the inline source; packaged Mac/Windows/Linux tests must open its SQLite connection and complete a real worker operation.

Controller states: never_created, running, termination_requested, exit_observed. Constructor failure before a Worker exists releases the announced writer hold immediately. Once created, error/message/terminate request is not exit: retain ownership until `exit` or awaited `terminate()` completion proves the worker stopped and its connection closed. Success message also waits for exit before releasing the writer hold. Cooperative cancellation finishes/rolls back the current transaction and closes DB; delayed exit is reported as delayed, with no false fixed-second guarantee. Parent crash kills its worker threads and SQLite recovers the transaction; the installation lock and committed metadata, not a live promise, define reopen recovery. Test constructor failure, worker error before/after DB open, delayed exit, parent crash and repeated recovery.

Index construction is a worker operation under a declared writer hold. The hold protects foreground writes but is not the SQLite lock: worker acquires SQLite directly and never waits on its own announced gate. Provider interruption bypasses that gate. Worker/readiness never waits for live turns or owed tool settlement. Terminal callback parking releases event-delivery backpressure while retaining only the generation's safety ownership. There is therefore no readiness -> Stop settlement -> readiness cycle. Tests must hold an actual worker write lock, not only mock readiness false.

There is zero history-scan fallback allowance, so no elapsed-time counter can reset on crash or clock rollback. Admission refusal can last unbounded time while storage failure persists; the UI retains the send honestly. Conditional recovery time is residual worker exit + retry cadence (at most 5 s once exited) + successful construction/backfill/reconciliation + verification. Target backlog and index size are measured separately; no 22/50.5/72.5-second universal promise. Clearance during a failed in-flight attempt and a large cleanup backlog have dedicated tests. This replaces r1.3's rejected child recovery protocol entirely.

### 6.5 Migration, backup/restore and budgets

Schema owner registers exact initializer SQL, optional column and all table/trigger/index definitions in `server/database.ts`, `server/installation-database-snapshot.ts`, `server/installation-app-schema-downgrade.ts` and `server/installation-memory-downgrade.ts`. A backup may contain dirty/incomplete progress only if that state is preserved; it must never be stamped ready by export. Restore preparation's raw JSON rewrites trigger dirtiness when schema exists; old archives receive a fresh protocol and census. Real restored writers test both directions. Unknown index definitions are rejected/replaced transactionally, not accepted by name. Integrity failure triggers repair/not-ready and never data deletion.

Controlled downgrade drops M2 triggers/index/state before dropping turn_id, preserving source JSON, existing columns and unrelated schema. Full downgrade still performs its existing seq handling; the M2 helper must not accidentally drop seq early. Use actual 1.0.17 inspector from the verified historical build, not a hand-written schema approximation. Disk headroom and progress are shown through the DROP COLUMN/table rewrite and checkpoint. E/handoffs/FIX-LEDGER.md:3953 reports 31 GB/2,987,414 messages, 70.8 s DROP COLUMN, 4.5 GB peak WAL, 0.95 s checkpoint; those are historical planning inputs, not current measurements. Failure rollback, reopen and repeated downgrade are mandatory. Upgrade after an older writer rebuilds exact turn state, including arbitrary foreign JSON changes and explicit insertion into old rowid gaps (both were outside r1.3's review; both are now inside scope).

Unchanged performance gates: recovered honest T-WRITE-1 workloads, three quiet final-pair bare-table runs, 200 B strictly <2x and 1 MiB strictly <1.5x (also satisfies the historical ≤1.5x condition); inserts AND updates with identical preparation, byte sizes and baseline. Application/columnReal results are supplementary. T-SMOOTH-1 remains <250 ms in three quiet runs; do not hide backfill, triggers, final-row validation or cache invalidation costs. T-PLAN-1/2 prove both exact seeks; T-SCALE-1 compares 1,000 versus 20,000 unrelated later rows at identical target rows. Real-size startup/migration/downgrade and storage growth are gates. A budget failure means redesign within fixed scope, not approval of a slow fallback or raised budget. First paint/bundle remains at or below 670 KiB.

## 7. L13 proof discipline

Rows 5 and 8 remain **NOT FIXED**. First execution by the authorized build job is the entire unmutated `src/e2e/help-ask-fixture.human.spec.ts`, including 7b, with `src/e2e/help-ask-fixture.config.ts` and matching fixture/package at recovered source. Run a help-fixture packaged Electron app under xvfb in a build host container, never a live app attachment. Record source SHA, package hash, fixture/config hash, executable identity, image, command, exit status, all case names and artifact paths. A launch failure is a blocked baseline, not behavioral RED. No unit test or mutation execution may precede this baseline. Reconcile `5b0a0a1eb` and `19ef45264` provenance before carrying their harness into the new base.

Row 5 separately holds Remove success and `{kind:'fail'}` release across close/reopen. Wait for driver request-id settlement, close/reopen again to observe committed React state, then assert queued question, enabled Remove and old observation `live:false`. M5a and M5b must fail the intended behavioral assertions in rebuilt packages.

Row 8 proves restamp changes BOTH follow key and requested turnId. M8a must fail. With time below the 5-second poll, independently removing `live.turnId`, `live.ended` and `bot.busy` nudges must fail immediate read-count assertions (M8b–d). M8e removes a redundant turnId dependency and is demonstrated equivalence: equal behavior and read counts, expected GREEN, recorded for MAIN disposition. Do not invent a source-text assertion to force it RED. Re-run the full spec and mutation matrix on the final combined SHA.

## 8. Exact UX and G9 contract

The Help panel header is “Ask about this screen” and names the Chief. Search/help stays available without any bot. One main content card shows question/preview, then one state card with the exact selected answer. At most one primary button exists in a view. Fine control remains in full chat and Advanced Settings; no help text/control/value/key/type/default is removed.

Draft defaults empty; Chief and pinned thread resolve automatically and freeze at send time. Input label “Your question”, placeholder “What would you like to know?”, counter `0/400`. Trim leading/trailing whitespace once on preview; count Unicode code points, accept 1–400, reject whitespace-only/overlength identically client/server. Interior whitespace/newlines remain exact. Preview label “Message preview”; exact payload is `<trimmed question>\n\n(Asked from help on the <fixed catalogue title> screen.)`. Use the uninterpolated catalogue title, never bot/person names, drafts, file paths, DOM contents or screenshots. Preview is shown inline before Ask, not hidden behind another step. Disclose exactly: “Your question and this screen's name go to <Name>'s chat. Its usual memory and permissions apply. Replies count toward usage.” This required disclosure is an explicit short-copy exception; do not hide it behind (i). Extra explanation is behind a labelled information button.

| View | Exact status/helper copy | Default and primary | Secondary controls; dismissal |
|---|---|---|---|
| Draft | “<Name> answers” | Empty input; **Ask** disabled until valid. | Help search; Close help preserves account-scoped draft. |
| No Chief | “Add a Chief to ask questions.” | **Add a Chief** opens existing flow. | Help search; no unusable send form; Close help. |
| Sending | “Sending your question…” | No primary while receipt pending. | Open in chat; Close help retains attempt/outbox. |
| Queued | “Your question is in line.” | **Remove from line** only when authorized/capable. | Open in chat; Close help retains queued work. If Remove unavailable, Open in chat is primary. |
| Running | “<Name> is answering.” | **Stop** only for confirmed scoped target/capability. | Open in chat; Close help leaves turn running. Without capability Open in chat is primary. |
| Approval | “<Name> needs your approval.” | **Open in chat** | Stop as secondary if safe; Close help. No approval controls in panel. |
| Ended | “Saved in <Name>'s chat.” | **Done** | Open in chat; Done clears only the panel view, never transcript or receipts. |
| Removed | “Removed from the line.” | **Done** | Open in chat; no replay/resend on dismissal. |
| Refused | “Your question could not start.” | **Open in chat** | Send again if authoritative current permission/fences permit; Done clears view. |
| Failed-not-submitted | “Your question did not send.” | **Send again** if authoritative and permitted. | Open in chat; Done. If resend unavailable Open in chat is primary. |
| Submitted-but-failed | “Your question was sent, but the answer could not finish.” | **Open in chat** | Send again opens duplication confirmation; Done. |
| Stopped | “Stopped.” | **Done** | Open in chat; Send again with current Stop fence and warning if delivery could have occurred. |
| Unknown | “We couldn't confirm what happened.” | **Open in chat** | Check again; Send again only under section 5 safeguards. Close help preserves uncertainty; no Done/completion claim. |
| Indexing | “Preparing faster conversation access.” / “Your message is saved. Try sending again shortly.” | **Try again**, same saved sendId. | Open in chat; Stop secondary if a resolved live attempt exists; Close help preserves outbox. Never show “saved” until local or server outbox commit. |
| Removing / Stopping | “Removing your question…” / “Stopping…” | Pending action disabled; no duplicate press. | Open in chat remains available; Close help does not cancel request. |
| Remove timeout/error | “Could not remove it.” | **Try again**, same action/target. | Open in chat; preserve queued question. |
| Stop timeout/unconfirmed | “Could not confirm it stopped.” | **Try again**, same action/target. | Open in chat; preserve running/unknown evidence; no stopped assertion. |
| Missing transcript | “Open chat to check this question.” | **Open in chat** | Check again; no claim that an unseen answer exists or completed. |
| Duplicate confirmation | “This may send your question twice.” | **Send again** after explicit press | Cancel default focus; no preselected consent, Enter cannot auto-confirm from the previous view. |

All input/action controls have defaults above. Poll every 5 seconds without overlap; live turnId/ended/busy/sends hints trigger immediate guarded follow. After 60 seconds unresolved, keep unknown + Open in chat; never change to ended. Remove/Stop times out after 15 seconds, preserving original action receipt and target for retry. Terminal current receipt, not elapsed time/idle/later transcript, enables Done. Opening another question, account change, panel reopen or restamp changes the callback guard `(account,opening,attempt,action,bindingEpoch)`. Old errors still reach shared outbox/action error UI after close even when they cannot repaint the new panel. Sign-out clears drafts and detaches account-specific listeners. Cross-surface Remove updates to Removed through authoritative state/SSE.

Opening focuses Your question (or the status heading on a resumed attempt); Escape closes and restores focus to the invoking Help button. Tab order is question, preview/info, primary, secondary, Close. Enter submits once only when not composing, valid, no modifiers and not `event.repeat`; Shift+Enter inserts newline. A latch stays set until keyup and settlement; held Enter across render/reopen cannot duplicate Ask or confirm resend. IME composition Enter never sends. New view/action does not steal focus during streaming; statuses use polite live announcements and button names remain stable. Dialog confirmation focuses Cancel, traps focus while open, and returns it to Send again on cancel.

Desktop uses the existing Help side panel, one-column cards and a separately scrolling answer region. At 320 px phone width use full-width sheet, stacked buttons, 44 px minimum targets, wrapping status/preview, safe-area padding and no horizontal overflow; keyboard must not hide the primary action. Light/dark use semantic surfaces/text/focus/error tokens, with identical hierarchy and text labels rather than color-only state. Preview and answer support selectable text; long answers scroll without moving the action row offscreen. Full chat handoff closes Computer and Inspector, selects the exact bot and pinned task, scrolls to the send/answer when present and exposes Stop for the actually running turn even in long chats. It must not select the newest unrelated task.

The mounted load path requests the Chief thread's first page without changing chat selection, waits for `messagesUnloaded` to clear and resets load retry budget after each successful load. Only rows/stream frames for the resolved send's current provider turn appear. A restamp discards old turn answer/follow state before observing the new binding.

Affected Settings click paths: Settings -> Help/“Ask about this screen” -> Ask (2 clicks after entering question); Settings -> Help -> Open in chat (2); Settings search -> exact highlighted control (1 search), including an Advanced control through “Set in Advanced”. These reuse existing home/name/search destinations in Simple and Advanced; the panel does not add a new settings category. The complete G9 15-task matrix remains ≤3 clicks from Settings or 1 search: add OpenAI key; change engine; stop permission questions; connect Gmail; night notifications; pair phone; house rules; morning brief; MCP server; Chrome access; voice; backup; spending; migrate Grok Bot; folder access. This lane records affected paths and verifies no regression across the full matrix, without claiming to implement other lanes' controls. Existing key/sign-in sharing and auto-detection defaults remain unchanged.

Proof: Fable's five-second/word-count/defaults review in both modes; Astra capability/help-text parity against shipped code; full 15-task click table; packaged light/dark/phone states; Sean's 20+ bots/4 teams profile AND a new-user profile on Mac, Windows and Linux, including no-Chief and unsupported-server cases. No overflow, console errors or undefined labels. Required real-engine checks and Sean's evidence review occur before shipping. Passing behavioral tests alone does not satisfy G9.

## 9. Review traceability, risks and closed decisions

### 9.1 All numbered amendments in R:17–35

| Amendment | Replacement contract and proof |
|---|---|
| 1 Concrete F7/M2 mechanisms instead of §§4.2/4.5 and slices 3/6 deferrals | §§3–6 choose the tables, transitions, persistence gate, index, triggers, readiness and recovery. Final slices implement these interfaces; no “choose later” mechanism. |
| 2 F7 schema/transition/transaction/migration/deletion/restore | §§3.1–3.4, F7-RECEIPT/CAS/DB-TERMINAL/DELETE/RESTORE. Delivery and terminal outcome are separate columns. |
| 3 Throwing pre-submit gate, provider-id distinction, multiple writes | §3.2, F7-DB-GATE/INVOKE/ID-NOT-ACK/MULTIWRITE. |
| 4 Actual replay inputs, warmer invalidation, ordinary legacy preservation | §4 inventory, F7-REPLAY/WARM/COPY/LEGACY. |
| 5 All-writer M2 protocol, stable identity, same snapshot, damage/repair | §6.1–6.2, T-RAW-NONNULL/MUTATIONS/SNAPSHOT/BACKFILL/DAMAGE. Expression fallback removed. |
| 6 Loaded/unloaded consumers and cache invalidation; owed terminal cleanup | §6.3, T-CONSUMERS/PRODUCTION/WIPE/TERMINAL/STOP-LOCK. |
| 7 Stop after every await, explicit result, malformed scoped body, siblings | §5.1, STOP-AWAITS/MALFORMED/SIBLINGS/RESULT. |
| 8 Full capabilities/state/actions/status/retry/authority table | §5.2–5.3, STATE-1/CANCEL-16/ACTION-1/DOOR-1/LEGACY-CAP. |
| 9 Exact UX copy/layout/default/actions/keyboard/focus/G9 | §8, UI-INPUT/PREVIEW/UNKNOWN/KEYBOARD/LAYOUT/G9, mounted F5/F6 and L13. |
| 10 BUILD ownership/tests, behavioral vs historical/performance evidence | Updated BUILD.md and §§10–11; one integration/schema owner; distinct RED/regression/mutation/performance classes. |

### 9.2 Historical F7 findings

All fourteen original findings are recovered and mapped in [evidence/l8-provenance.md](evidence/l8-provenance.md), with the exact review in [evidence/F7-review-original.md](evidence/F7-review-original.md). Binding R1 below supplies the six High mappings and F7-ML1 through F7-ML8 decisions, owners and named tests. No finding is left unenumerated; this records contract coverage, not implemented or passing behavior.

### 9.3 Recovered M2 r1.3 findings

| Actual finding, evidence/M2-astra-r13.md | Disposition and exact test |
|---|---|
| 1 High: exit-only dead end, packaged launch, Windows termination | §6.4 replaces process launch with embedded Worker source and explicit never-created/running/termination-requested/exit-observed states. Constructor failure releases; running error holds until observed exit. T-WORKER-SPAWN/EXIT/PACKAGE/PARENT. |
| 2 Medium: checkpoint lock loses fallback budget | No scan fallback or time allowance exists. Committed backfill cursor and markers, not wall time, control correctness. T-BACKFILL-CRASH/CLOCK/STOP-LOCK. |
| 3 Medium: database work before provider Stop | §5.1 extracts authenticated generation interruption before writer gate/DB cleanup. T-STOP-LOCK covers real writer lock, dispatching and project-card variants with failed cleanup writes. |
| 4 Medium: false 50.5-second recovery bound and global settlement dependency | §6.4 states conditional components/unbounded persistent-failure case; §6.3 global readiness releases unrelated admission while per-thread safety barriers remain. T-CLEARANCE/BACKLOG. |
| 5 Medium: calm retained-send refusal unspecified | §5 503 body before dispatch, §8 retained outbox copy/actions, UI-INDEX-RELOAD asserts text/attachments/reply target/sendId survive and retry runs once. |
| Additional wait-for audit | Worker never waits on announced writer gate, callbacks park without transaction or controller dependency, Stop bypasses DB; T-STOP-LOCK and T-BACKLOG. |
| Prior closed obligations | Honest bare-table final-pair runs; byte-based batch accounting/oversized/multibyte rows; actual downgrade seq behavior, atomic trigger/index replacement, second open, actual production insertion functions and isolated fixtures remain mandatory in §6 and §10. |
| Historical out-of-scope exclusions | Arbitrary foreign JSON UPDATE and old rowid-gap insertion are explicitly in this revision's T-RAW-NONNULL/T-MUTATIONS. No r1.3 scope exclusion is inherited. |

### 9.4 Risks with decided responses

* Durability failure holds the attempt and blocks only safety-dependent release; provider interruption stays reachable. The user sees unknown/maintenance, never an invented successful send/Stop.
* Global dirty emptiness can temporarily defer unrelated turn reads. Reconcile bounded batches and measure real load; never weaken the invariant to meet latency.
* Final-row validation and persistent triggers can exceed write budgets. Run the unchanged workloads; failure triggers a same-scope redesign, not an expression fallback.
* Worker exit, index rebuild and target cleanup have no unconditional wall-time bound. Report phase/progress and retain sends; measure each component rather than promising an invalid number.
* Retired digests grow until reset. Measure storage explicitly and document capacity; never age out fences.
* Legacy downgrade projection is a safety migration with actual old-runtime replay and inspector proof. Failure blocks unsafe export, not deletion of original data.
* Historical proof may not reproduce on current lifecycle/security. Only combined-head passes count. All fourteen recovered F7 findings retain their named behavioral gates.
* Parallel owners can conflict at shared schema/index files. One integration owner owns every shared edit; producer modules export frozen functions/DDL and supply patches for review.

These are settled design responses and pending proof obligations, not questions for the builder to decide.

## 10. RED-first matrix and acceptance evidence

All base-RED claims below are predictions from source reading, NOT RUN. A test must reach the behavioral assertion on `c12aaad9341e8f87126a193f35b5c2768f0aa66f`; missing imports/routes/harness startup cannot count as the behavioral failure. Restore/recover a compatible harness first. R = expected behavioral RED on this base; G = regression that may already pass; M = mutation proof; P = measurement/historical acceptance, never advertised as base RED. Every row names the future test file exactly; new files are proposals, not claims that they exist now.

| Test names | Exact file(s) | Assertion and evidence class |
|---|---|---|
| ISO-11, ISO-12, ISO-15 | `server/ux-l4b-isolation-api.test.ts` | Admission queues behind Help; held ordinary steer rechecks replacement isolation and clears dispatched marker; only verified own-card answer bypasses FIFO. R; existing wrong-card checks G. |
| ISO-13 | `server/ux-l4b-isolation.test.ts`, `server/loop-nudge.test.ts` | Inventory all actual steer/write sites; held nudge cannot enter a newly isolated run. R behavior plus source inventory. |
| ISO-14 | `server/send-store.test.ts`, `server/independent-thread-runs.test.ts`, `server/steer-queue.test.ts` | Singleton both positions, takeover/resend/restart preserve flag, next ordinary run clears it. R. |
| F7-RECEIPT, F7-CAS | `server/send-attempt-state.test.ts` | Unique scoped send/line/action constraints; atomic transcript linkage; stale generation/binding/revision cannot settle replacement; duplicate terminal event does not drain twice. R. |
| F7-RETRY, F7-ACTION | `server/send-failure-lifecycle.test.ts` | Lost acknowledgement for failed-with-line returns original; repeated explicit action creates exactly one new send/line; changed fingerprint/target/fence rejects; no automatic resend. R plus existing Stop/restore controls G. |
| F7-DB-GATE, F7-INVOKE, F7-ID-NOT-ACK, F7-MULTIWRITE | `server/turn-dispatch-guard.test.ts`, `server/send-failure-lifecycle.test.ts` | Failed receipt write prevents actual adapter invocation/write; unfenced invocation uncertainty precedes call; allocated ID is not submitted; second-write refusal/notWritten cannot erase earlier uncertainty. R. |
| F7-SETUP, F7-REBUILD | `server/send-failure-lifecycle.test.ts` | Synchronous pre-admission throw, ACP async setup failure, post-return background failure, postwrite failure and final rebuild terminal each reach shared receipt lifecycle; intermediate/stale rebuild does not terminate current binding. R. |
| F7-DB-TERMINAL | `server/send-failure-lifecycle.test.ts` | Terminal commit failure publishes no terminal event, releases no generation, drains no sibling; recovered persistence replays effects once. R. |
| F7-CRASH | `server/send-failure-recovery.test.ts` | Child crash after acceptance/link, before/after gate commit, after possible write, before/after terminal commit/publication/release; restart visits started/failed/uncertain and never auto-resends possible delivery. R. |
| F7-STOP-GAP | `server/ux-l4b-isolation-api.test.ts` | Deterministic barriers between queue selection/start, rebuild and late error; target sealed before write; next generation unaffected. Mixed R/G, record which assertion fails. |
| F7-REPLAY, F7-WARM, F7-COPY, F7-LEGACY | `server/memory/send-replay-exclusion.test.ts`, `server/memory/lineage-warm.test.ts` | Capture real adapter inputs in fresh/native/resumed/rebuilt paths; all failed unsent lines/copies excluded; cached warm proof invalidates; retained cursor seals; ordinary historical context remains. R for new exclusion; ordinary legacy G. |
| F7-PRUNE, F7-DELETE, F7-RESTORE | `server/send-failure-recovery.test.ts`, `server/installation-restore.test.ts` | Pruning retains replay/dedup; deletion creates nonreversible scoped fences before receipts disappear; old backup cannot revive retired send/action; no receipt text retained. R. |
| STATE-1, ACTION-1 | `server/ask-turn-state.test.ts` | Send-keyed state rejects foreign hint; restamp follows current binding; every state/delivery/action combination maps to frozen wire; same-action retries never retarget. R. |
| CANCEL-16 | `server/ux-l4b-isolation-api.test.ts`, `src/components/help/HelpAsk.test.tsx` | Every authorized 404 state and 5xx/legacy/timeout outcome; started/sending never become Done. R. |
| STOP-AWAITS, STOP-RESULT, STOP-SIBLINGS, STOP-MALFORMED | `server/ux-l4b-isolation-api.test.ts` | Swap generation after each browser/provider/final-frame await including catch; no stale approval/idle/release; explicit match/confirmed/unconfirmed result; siblings untouched; malformed scoped body never executes broad branch. R. |
| DOOR-1, LEGACY-CAP | `companion/test/turn-state-door.test.ts`, `server/route-policy.test.ts`, `server/bot-read.test.ts`, `server/channel-queue.test.ts` | Phone/browser proof+subject through every new GET/DELETE/POST, foreign/hidden/group denial before receipt access, chat-only Remove denied, absent capability sends no scoped interrupt. R for new allowed paths, existing denials G. |
| T-PLAN-1, T-PLAN-2, T-SCALE-1 | `server/turn-index.test.ts` | Both production readers seek exact turn; parsed/work counts flat with 1,000/20,000 unrelated later rows and no derived line scan. R. |
| T-RAW-NONNULL, T-MUTATIONS | `server/turn-index.test.ts` | Raw change of JSON turn while stale non-null column remains; raw turn column mutation; insert/replace/update identity/delete/rowid-gap writes; dirty read returns not_ready then exactly full-parse oracle. R for maintenance contract; baseline ordinary correctness G. |
| T-DAMAGE, T-BYTES | `server/turn-index.test.ts` | Malformed/non-string/empty identities preserved byte-for-byte; repaired row becomes discoverable; BLOB-byte and oversized/multibyte batch rules. G for preservation controls, R for maintenance. |
| T-SNAPSHOT, T-READY, T-SCHEMA | `server/turn-index.test.ts` | Two connections interleave readiness/read; never mixed snapshot; wrong same-name index/trigger, absent state and incomplete census cannot publish ready; final row validation before clearing marker. R. |
| T-BACKFILL-CRASH, T-CLOCK, T-OLD | `server/turn-index-recovery.test.ts` | Interrupted bounded pass resumes committed cursor; writes behind cursor/old rowid gaps found; clock rollback creates no scan allowance; older writes exact on upgrade. R for protocol, G for atomic SQLite controls. |
| T-CONSUMERS, T-WIPE, T-PRODUCTION | `server/turn-index-consumers.test.ts` | Loaded/unloaded Store rows/replies/tools equal authoritative DB after raw writes; line/turn_first wipe cannot create incomplete reads; child with VITEST unset handles not_ready. R. |
| T-TERMINAL, T-STOP-LOCK, T-BACKLOG, T-CLEARANCE | `server/turn-index-stop.api.test.ts` | Not-ready terminal persists owed tools; actual worker writer lock still permits authenticated provider interruption for direct/dispatching/project-card turns; cleanup write failure does not strand Stop; ready unrelated threads admit while old-thread backlog retained; clearance during failed worker honored. R plus existing scoped-tool behavior G. |
| T-WORKER-SPAWN, T-WORKER-EXIT, T-WORKER-PARENT | `server/turn-index-recovery.test.ts` | Never-created releases immediately; error/success/termination request cannot release running worker ownership before observed exit; parent crash recovers lock/progress. R. |
| T-WORKER-PACKAGE | `src/e2e/turn-index-worker.human.spec.ts` | Packaged Mac/Windows/Linux Node worker opens DB, batches/builds/exits; no external CLI/process-mode assumptions. P. |
| T-DOWN, T-BACKUP, T-RESTORE, F7-DOWN-REPLAY | `server/installation-downgrade-117.test.ts`, `server/installation-database-snapshot.test.ts`, `server/installation-restore-preparation.test.ts` | Actual old inspector accepts controlled export; actual old replay excludes projected failed inputs; rollback/second open preserve JSON/seq; receipt metadata/fences roundtrip; raw restore writes invalidate index. R/G by fixture, actual old-runtime rehearsal P. |
| T-WRITE-1, T-SMOOTH-1, F7-STORAGE | `server/turn-index.perf.test.ts`, `server/send-attempt-storage.perf.test.ts` | Three quiet identical final-pair insert/update budgets, <250 ms smoothness, real data migration and measured receipt/fence growth. P; historical expression-index write failure is retained, not relabelled current RED. |
| UI-F5, UI-F6 | `src/components/help/HelpAsk.test.tsx` | Mounted unload/reload retry reset, exact pinned-chat handoff closes overlays and shows true Stop in long chat. R. |
| UI-INPUT, UI-PREVIEW, UI-KEYBOARD | `src/components/help/HelpAsk.test.tsx`, `src/lib/screen-envelope.test.ts` | 1–400 Unicode chars, exact typed payload/fixed title, no private interpolation; held/IME Enter cannot duplicate or confirm resend; focus restoration. R. |
| UI-STALE, UI-EXTERNAL-CANCEL, UI-UNKNOWN, UI-CAP | `src/components/help/HelpAsk.test.tsx` | Account/opening/attempt/action/restamp guards; post-close errors remain observable; other-surface Remove; unknown/timeouts retain chat, no false failure/completion; capability absence. R. |
| UI-INDEX-RELOAD | `src/state/send-delivery.test.ts`, `src/components/help/HelpAsk.test.tsx` | 503 maintenance before dispatch preserves text/attachments/reply/sendId across reload; same-ID retry after ready executes once; unknown action response never mints resend. R. |
| L13-5, M5a, M5b, L13-8, M8a, M8b, M8c, M8d, M8e | `src/e2e/help-ask-fixture.human.spec.ts`, `src/components/help/help-ask-fixture.test.ts` | §7 package observation assertions; M5a/b and M8a–d intended mutations fail; M8e equal reads/behavior demonstrated GREEN. M/P, not missing-harness RED. |
| UI-LAYOUT, UI-G9 | `src/e2e/help-ask-fixture.human.spec.ts`, `evidence/l8-g9-clicks.md` | §8 light/dark/320px/focus screenshots and exact click table; Fable/Sean/new-user/20+bot cross-platform proof. P with automated layout assertions where supported. |

Run gates appropriate to final files, compare zero NEW reds with the supplied integration base and release run `42028153798`, and register selected behavioral gates in `ci/gate-tests.txt`. Historical reports are provenance only. Quiet performance and packaged human review follow behavioral implementation; repeat on final combined SHA after meaningful integration changes. No READY-to-ship claim until every fixed-scope behavior and proof gate is satisfied.

## 11. Ordered build slices to seat in parallel

This is the final build order and ownership contract. Sizes include tests, not measured line counts. Total remains a provisional 9–12 builder-sessions plus 1–2 design/review sessions. Seat one integration owner I for **all shared schema files and server/index.ts**. A2 supplies exported schema definitions/patches; I alone edits `server/message-tables.ts`, `server/database.ts`, snapshot/downgrade/restore files. All owners use the frozen interfaces below; a change to one requires coordinated review before dependent seats continue. New source/test files are explicitly proposed by this revision. No agent delegation is performed by this design job.

Frozen interfaces: F1 = §3 receipt/BindingKey/CAS/terminal effects; F2 = §3.2 throwing submission gate; F3 = §4 replay eligibility/revision/isolation; F4 = §5 capability/state/action/auth wire; F5 = §6 TurnRead/dirty/readiness/worker; F6 = §8 exact UI copy/identity/layout; F7 = §7 packaged fixture observations/mutation identities. Contracts may be represented in proposed `shared/help-turn-state.ts`; only I owns that shared file, exporting the wire enums/types without runtime authority decisions.

### Slice 0 — serial provenance and packaged baseline (S, 0.5–1 session)

Owner I. Exact files: `src/e2e/help-ask-fixture.human.spec.ts`, `src/e2e/help-ask-fixture.config.ts`, `src/components/help/help-ask-fixture.ts`, `src/components/help/help-ask-fixture.test.ts`, `src/components/help/help-ask-port.ts`, `src/components/help/help-ask-build.test.ts`, `scripts/check-help-fixture-absent.mjs`, `playwright.config.ts`, recovered matching package/fixture wiring in `src/components/help/HelpAsk.tsx`, `package.json`; design-only manifests `DESIGN-r2.md`, `BUILD.md`, `evidence/l8-provenance.md`, `evidence/l8-baseline.md`, `evidence/F7-review-original.md`. Recover source wiring via the historical diff; do not substitute current product fixes before baseline. Build package from the matching recovered historical tree in an isolated workspace, with its recorded config.

Depends on F7 and header reviews/MAIN seating, exact historical source identities, recovery of F7 original review with all six High/eight Medium/Low mappings. First test execution: entire **`src/e2e/help-ask-fixture.human.spec.ts`**, including 7b, in a build host container against packaged Electron under xvfb. Preserve both L13 reports. A failed launch blocks baseline; it is not RED. After baseline, separate Slice I0 lands shared `shared/help-turn-state.ts` and schema contract stubs; Slice 0 does not edit those files. Exit: source/package/config hashes and observed baseline recorded; rows 5/8 still NOT FIXED pending final proof.

### Slice A1 — parallel wave A, durable lifecycle and isolation (L, 2–2.5 sessions)

Exact production files: `server/send-store.ts`, `server/steer-queue.ts`, `server/independent-thread-runs.ts`, `server/turn-dispatch-guard.ts`, `server/admitted-turn.ts`, proposed `server/send-attempt-state.ts`, proposed `server/send-attempt-compat.ts`. Exact test files: `server/send-store.test.ts`, `server/steer-queue.test.ts`, `server/independent-thread-runs.test.ts`, `server/turn-dispatch-guard.test.ts`, `server/send-attempt-state.test.ts`, `server/send-failure-lifecycle.test.ts`, `server/send-failure-recovery.test.ts`, `server/send-attempt-storage.perf.test.ts`. Schema registration and index.ts call sites are patches handed to I, not concurrent edits.

Depends on F1/F2/F3/F4 and current ownership/restore contracts; uses F5 not-ready union for owed effects without waiting for A2 implementation. RED first: **ISO-14; F7-RECEIPT; F7-CAS; F7-RETRY; F7-ACTION; F7-DB-GATE; F7-INVOKE; F7-ID-NOT-ACK; F7-MULTIWRITE; F7-SETUP; F7-REBUILD; F7-DB-TERMINAL; F7-CRASH; F7-STOP-GAP**. Then F7-PRUNE/DELETE/RESTORE and storage measurement. Exit: terminal receipt is the sole release authority; failed durable recording never permits engine write.

### Slice A2 — parallel wave A, exact turn storage (L, 1.5–2 sessions)

Exact production files owned by A2: `server/message-db.ts`, proposed `server/turn-index-state.ts`. Exact shared schema file supplied as a reviewed patch for I: `server/message-tables.ts`. Exact tests: `server/turn-index.test.ts`, `server/turn-index-recovery.test.ts`, `server/turn-index.perf.test.ts`, `src/e2e/turn-index-worker.human.spec.ts`. No app-wide migration file is edited by this seat.

Depends on F5, stable `(thread_id,id)` identity, I's schema registration and current worker ownership primitives. RED first: **T-PLAN-1/2; T-SCALE-1; T-RAW-NONNULL; T-MUTATIONS; T-SNAPSHOT; T-READY; T-SCHEMA; T-DAMAGE; T-BYTES; T-BACKFILL-CRASH; T-CLOCK; T-WORKER-SPAWN/EXIT/PARENT**. Then T-OLD, packaged worker acceptance and unchanged T-WRITE-1/T-SMOOTH-1. Exit: no unresolved dirty marker can coexist with a ready read; full-parse oracle exactness and final-row validation proven. Performance is a gate, not assumed by the physical choice.

### Slice A3 — parallel wave A, Help panel and retained send UI (M–L, 1–1.5 sessions)

Exact production files: `src/components/help/HelpAsk.tsx`, `src/components/help/HelpPanel.tsx`, `src/state/store.tsx`, `src/state/send-delivery.ts`, `src/lib/screen-envelope.ts`, `src/locales/en-ux/l4b.json`. Exact tests: recovered `src/components/help/HelpAsk.test.ts` (pure regression suite), `src/components/help/HelpAsk.test.tsx` (mounted suite), `src/state/send-delivery.test.ts`, `src/lib/screen-envelope.test.ts`. Do not concurrently edit the packaged fixture spec; B3 owns it after baseline.

Depends on F4/F6 and shared wire types, existing pinned-thread loading/chat navigation/outbox interfaces. RED first: **UI-F5; UI-F6; UI-INPUT; UI-PREVIEW; UI-KEYBOARD; UI-STALE; UI-EXTERNAL-CANCEL; UI-UNKNOWN; UI-CAP; UI-INDEX-RELOAD; CANCEL-16**. Mounted tests exercise unload/reload, close/reopen, account/action/restamp guards, exact preview, precise handoff and external cancellation. Exit: every §8 state has exact copy/actions/focus behavior; no old server receives scoped Stop.

### Slice B1 — parallel wave B, state API and authorization (M, 0.75–1 session)

Starts after A1/F1 and A2/F5 stabilize. Exact production files: proposed `server/ask-turn-state.ts`, `server/route-policy.ts`, `server/sse-visibility.ts`, `companion/src/routes.ts`. Exact tests: `server/ask-turn-state.test.ts`, `server/route-policy.test.ts`, `server/bot-read.test.ts`, `server/channel-queue.test.ts`, `companion/test/turn-state-door.test.ts`. I owns all route/config/Stop wiring in `server/index.ts` and shared type changes.

Depends on F1/F4/F5, current authorization/proof/visibility policy. RED first: **STATE-1; ACTION-1; CANCEL-16; DOOR-1; LEGACY-CAP**, including wrong bot/thread/send/hint, hidden subjects and proof checks for every route. Exit: authorization precedes receipt access, state derives from current send receipt, legacy compatibility explicit.

### Slice B2 — parallel wave B, replay and recovery integration (M–L, 0.75–1 session)

Exact production files: `server/memory/turn-replay-inputs.ts`, `server/memory/lineage-warm.ts`, `server/memory/disclosures.ts`, `server/memory/replay-lineage.ts`, `server/turn-context.ts`, `server/branch-store.ts`. Exact tests: `server/memory/send-replay-exclusion.test.ts`, `server/memory/lineage-warm.test.ts`. index.ts replay/rebuild wiring and snapshot/restore registration go to I; A1 retains ownership of recovery test files until handoff.

Depends on F1/F3/F5 and current lineage/session proof rules. RED first: **F7-REPLAY; F7-WARM; F7-COPY; F7-LEGACY** plus integrated F7-PRUNE/RESTORE after A1 handoff. Exit: captured fresh/resumed/native/rebuilt inputs exclude all failed-unsubmitted/uncertain attempts; warm proof invalidates and ordinary legacy history survives.

### Slice B3 — parallel wave B, L13 proof work (M, 0.75–1 session)

Exact files: `src/e2e/help-ask-fixture.human.spec.ts`, `src/e2e/help-ask-fixture.config.ts`, `src/components/help/help-ask-fixture.ts`, `src/components/help/help-ask-fixture.test.ts`, `src/components/help/help-ask-port.ts`, `src/components/help/help-ask-build.test.ts`, `scripts/check-help-fixture-absent.mjs`, `playwright.config.ts`, `evidence/l8-l13-mutations.md`, `evidence/l8-g9-clicks.md`. Mounted additions to `src/components/help/HelpAsk.test.tsx` transfer from A3 only after its wave-A work is committed; no simultaneous editing.

Depends on F4/F6/F7, baseline artifact identities and A3 UI handoff. Mutation RED first: **L13-5/M5a/M5b; L13-8/M8a/M8b/M8c/M8d** against rebuilt packages. **M8e remains GREEN demonstrated equivalence** with equal read counts. Then UI-LAYOUT/UI-G9, full unmutated fixture including 7b. Exit: concrete package/React observations and mutation evidence, rerun on final combined head; MAIN may close rows 5/8 only after review.

### Slice I — serial integration and acceptance (L, 1.75–2 sessions; same sole integration owner)

Exact production/shared files: `shared/help-turn-state.ts`, `server/index.ts`, `server/store.ts`, `server/loop-nudge.ts`, `server/steer-lineage.ts`, `server/message-tables.ts`, `server/database.ts`, `server/branch-index.ts`, `server/memory/optional-index.ts`, `server/installation-database-snapshot.ts`, `server/installation-app-schema-downgrade.ts`, `server/installation-memory-downgrade.ts`, `server/installation-restore.ts`, `server/installation-restore-preparation.ts`, `ci/gate-tests.txt`. Exact tests: `server/ux-l4b-isolation-api.test.ts`, `server/ux-l4b-isolation.test.ts`, `server/loop-nudge.test.ts`, `server/turn-index-consumers.test.ts`, `server/turn-index-stop.api.test.ts`, `server/installation-downgrade-117.test.ts`, `server/installation-database-snapshot.test.ts`, `server/installation-restore.test.ts`, `server/installation-restore-preparation.test.ts`. Exact evidence files: `evidence/l8-combined.md`, `evidence/l8-performance.md`, `evidence/l8-g9-clicks.md` (B3 handoff). Each producer's schema patch is integrated here by I; integration test harness REDs may be authored before wave A but executed only after Slice 0's mandated first run.

Depends on all F1–F7 and all completed producer handoffs. RED first: **ISO-11/12/13/15; STOP-AWAITS/RESULT/SIBLINGS/MALFORMED; T-CONSUMERS; T-WIPE; T-PRODUCTION; T-TERMINAL; T-STOP-LOCK; T-BACKLOG; T-CLEARANCE; T-DOWN; T-BACKUP; T-RESTORE; F7-DOWN-REPLAY**. Assert actual downgrade inspector and restored raw-writer cycle. Then combined cross-turn/crash/Stop/restart tests; three quiet honest performance/smoothness runs; real-size migration/downgrade/storage measurements; final rebuilt packaged L13/mutations, real-engine and full G9 evidence. Record final combined SHA and zero NEW reds against both required baselines. Independent Astra and Fable reviews plus MAIN disposition are required before release; an evidence gap or failed fixed-scope gate is never a scope cut.


# Binding MAIN amendment (verbatim)

# RULING: l8 (turn state: L4B-F7 receipts, L13, M2, Murage 1.0.19)

Status: BINDING Opus ruling. Closes the second Astra DISAGREE (swarm-b/odes2-l8/last.txt) on `orph/l8/DESIGN-r2.md` and `orph/l8/BUILD.md`.
Base: int/1019 `c12aaad93`. Scope is unchanged: F7 durable attempt receipts, isolation, scoped Stop, M2 turn index, L13 rows 5 and 8, Help UI, G9. Nothing is deferred.
Builders build DESIGN-r2 as amended here. Where this ruling and DESIGN-r2 or BUILD.md differ, this ruling wins. No question is left for a builder or for Sean.

Open points closed: 4 (review points 1 to 3 plus the builder clarification). Point 1 closes all 14 historical F7 findings, including the 8 Medium/Low that DESIGN-r2 reserved as F7-ML1 to F7-ML8.

---

## R1. The original F7 review is recovered and every finding is mapped (review point 1, Blocking)

### Evidence of recovery

The review DESIGN-r2 could not find (`scratchpad/l4b-f7-astra-d1.md`) is recovered verbatim from the Codex session log that produced it:
`/fixture-home/.codex-acct4/sessions/2026/11/07/rollout-2026-11-07T06-19-15-01a1b328-c04b-7992-864f-f0ac07558596.jsonl` (session `01a1b328-c04b-7992-864f-f0ac07558596`, started 2026-11-06T23:19:15Z, cwd `wt-1018-rb-l4b-phone-turnstate`, final `task_complete` message, `VERDICT: BLOCK`). It reviews `designs/L4B-F7-SEND-FAIL-1018.md` (R1 to R6, tests 1 to 6) and has exactly 6 High, 7 Medium and 1 Low findings, matching the handoff (`_ev/handoffs/HANDOFF-1018-l4b-phone-turnstate-m2.md:248`: "BLOCK, 6 Highs ... Plus 8 Medium/Low"). Line numbers in it refer to the 1018 L4B worktree; current int/1019 anchors are given below.

The full text is Appendix A of this ruling. Slice 0 copies Appendix A to `orph/l8/evidence/F7-review-original.md` with the source path above. DESIGN-r2 section 1.1 item 1 and section 9.2's "not enumerated / NOT VERIFIED" paragraph are replaced by this section. The claim "no implementation decision remains pending" is now true, because every finding below has a contract decision and a named test.

### High findings (items 1 to 6): DESIGN-r2 mapping confirmed

| F7 item | Contract paragraph in DESIGN-r2 | Named tests |
|---|---|---|
| 1 High: all definitively unsubmitted failed lines (ordinary and lateRefused) leave replay | section 3.1 `send_replay_exclusions` (every new attempt starts excluded), section 4 | F7-REPLAY, F7-WARM, F7-COPY |
| 2 High: ACP setup failure after a returned turn id bypasses onDispatchError | section 3.3 shared terminalizer (ACP setup failure, background failure after `startTurn`) | F7-SETUP (rejected dispatch and accepted ACP turn whose setup later fails) |
| 3 High: late rebuild terminal (`settleWithCard`) never settles the batch | section 3.1 binding epochs, section 3.3 "final rebuild exhaustion" | F7-REBUILD (exhaustion, rejected redispatch, Stop during rebuild) |
| 4 High: restart skips started/failed rows | section 3.3 Restart row | F7-CRASH at every committed boundary |
| 5 High: Stop and drain gap lets another turn replay a not-yet-failed line | section 3.3 Stop row, section 3.1 "begins excluded" | F7-STOP-GAP, STOP-AWAITS |
| 6 High: pruning erases retry and exclusion facts | section 3.4 pruning paragraph | F7-PRUNE, F7-DELETE, F7-RESTORE |

### Medium/Low findings (items 7 to 14): new binding decisions

Each row is now F7-ML1 to F7-ML8 in the provenance manifest.

**F7-ML1 (item 7, Medium): room routes.** Anchors on base: `server/channel-queue.ts:13` (owner_sends channel drain), `server/index.ts:28531-28593` (group POST route reopens failed/refused rows and calls `sendStore.retire(stale.seq)`).
Decision: the receipt rule is universal. (a) The owner_sends channel drain creates and settles attempts only through the section 3 terminalizer; room question-card answers ride the same path. (b) The group POST route no longer reopens or retires a failed or refused row by itself: a same-ID request returns the immutable receipt (as for bots); an explicit resend uses the group action route in R2 below. `sendStore.retire` may not be called on any row whose attempt has a linked line. Owner: A1 adds `server/channel-queue.ts` and `server/channel-queue.test.ts`; the `server/index.ts` group-route change is a patch to I.
Tests: `F7-ML1-GROUP-SAMEID` (same-ID retry after a failed-with-line group send returns the receipt, no rerun, no retire), `F7-ML1-GROUP-RESEND` (explicit group resend creates exactly one replacement), `F7-ML1-CHANNEL-DRAIN` (channel drain failure settles the attempt and excludes the line).

**F7-ML2 (item 8, Medium): give-back path may leave no explanation.** Anchor: `server/index.ts:14596-14604` `giveBackAdmittedTurn(..., onDispatchError)`.
Decision: the terminalizer owns the explanation. On a terminal failed or refused outcome it checks whether an activity explanation already exists for `(attempt_id)`; if not, it writes exactly one, keyed by `(attempt_id, terminal_revision)` so repeats are no-ops. The receipt commits first; the explanation is an owed effect of kind `publication` in `turn_cleanup_owed`, retried if writing throws. A thrown explanation never blocks or reverses settlement.
Tests: `F7-ML2-GIVEBACK-LINE` (give-back path with no prior line produces exactly one line), `F7-ML2-LINE-THROWS` (writer throws; receipt still terminal; line appears on the owed-effect retry), `F7-ML2-NO-DUPLICATE` (setup already wrote its line; none added).

**F7-ML3 (item 9, Medium): an existing failed receipt answers as success.** Anchor: `server/index.ts:16670-16682` (`accepted.kind === "match"` returns `{ok:true, ...steered}` whatever the row's state); `src/state/send-delivery.ts` treats that as acknowledged; the Help callback in `src/state/store.tsx` gets no failure field.
Decision: a same-ID retry whose attempt is terminal and not completed returns `200 {ok:false, existing:true, threadId, receipt:{state, attemptId, receiptRevision}}` where `state` is the section 5.2 wire state (`failed`, `refused`, `removed`, `stopped`, `unknown`). `send-delivery.ts` treats `existing:true` with a terminal non-completed receipt as definitive: it stops retrying and hands the receipt to the caller; the Help reader receives `failure: receipt.state`. Completed or in-flight receipts keep today's `ok:true` shape.
Tests: `F7-ML3-LOSTACK-E2E` (server route, real `send-delivery.ts` outbox and real store reducer: first POST commits then the response is dropped; the retry gets the failed receipt; Help shows the failed state and Send again), `F7-ML3-COMPLETED-UNCHANGED`.

**F7-ML4 (item 10, Medium): a cancelled receipt maps to missing.** Decision: the Help receipt mapper maps a confirmed cancelled receipt to `removed`, never `missing`; the server's turn-state check for a cancelled attempt runs before any missing-messageId return. Owner: A3 (Help UI) and B1 (`server/ask-turn-state.ts`).
Tests: `F7-ML4-ACKED-QUEUED-REMOVE` (acknowledged queued send removed on another surface shows Removed and stops following), `F7-ML4-LOSTACK-AFTER-REMOVE` (lost acknowledgement retry after removal returns removed).

**F7-ML5 (item 11, Medium): sends without a send id stay started.** Decision: `send_id` is never null. When a request has no client sendId, the server mints `srv-` plus a UUID inside the acceptance transaction and returns it. Batch settlement is keyed by the attempt ids captured on the binding at queue selection, never by looking up a transcript line's sendId.
Tests: `F7-ML5-ANON-BATCH` (batch of one client-id send and one anonymous send fails; both attempts terminal and excluded), `F7-ML5-ANON-RETURNS-ID`.

**F7-ML6 (item 12, Medium): exclusion query scale.** Decision: replay eligibility is evaluated only for the bounded replay candidate set, one primary-key lookup per candidate on `send_replay_exclusions(thread_id, message_id)`. No query scans failed rows or `owner_sends` by status for replay.
Tests: `F7-ML6-QUERY-PLAN` (EXPLAIN QUERY PLAN shows `SEARCH send_replay_exclusions USING PRIMARY KEY`, no SCAN), `F7-ML6-FAILED-ROWS-INVARIANT` (lookup count identical with 0, 10,000 and 100,000 failed rows in the thread).

**F7-ML7 (item 13, Medium): test honesty.** Decision: every test in DESIGN-r2 section 10 carries a label in `evidence/l8-baseline.md`: RED-ON-BASE (fails on base for the stated defect) or GUARD (passes on base and protects existing behavior). Known GUARDs: Help retry budget reset after a successful load; same recorded `actionId` returning `existing`. F7-REPLAY must force replay into a fresh session (not a resumed one). UI tests must exercise the callback wired by the mounted component, not a source assertion.
Test: `F7-ML7-LABELS` is a check in Slice I that every section 10 test has a label and every RED-ON-BASE test was observed failing on base.

**F7-ML8 (item 14, Low): state-table accuracy.** Decision: DESIGN-r2 section 3.1 already says a `dispatchedIn` stamp never proves delivery. Add to section 3.4 migration: legacy `started` plus `dispatchedIn` imports as `delivery=uncertain`, never `submitted` and never `failed-not-submitted`. Legacy replacement rules (fingerprint, restore, Stop and action-token checks in `server/send-store.ts:606-616`) remain the guard for legacy flags (see R2).
Test: `F7-ML8-LEGACY-DISPATCHED-IMPORT`.

### Seating order

Slice 0 now has this content in hand, so the recovery is done, not a prerequisite left open. Slice 0 still records it in `evidence/F7-review-original.md` and `evidence/l8-provenance.md` before any product seat.

---

## R2. Immutable receipts and the existing chat Send again (review point 2, Required)

### Evidence

- `src/state/store.tsx:4781-4800` is the send delivery owner. `src/store.tsx` does not exist on base. DESIGN-r2 sections 3.4, 5.3, 8, A3 and BUILD.md must say `src/state/store.tsx`.
- `src/components/Composer.tsx:1481-1491` Send again on a refused chip re-dispatches `send`/`sendGroup` with the OLD `sendId`, `resend: true`, a fresh `actionId` per press and the chip's `stopGen`/`restoreGen`.
- `server/send-store.ts:606-616` honors that legacy shape today (restore-held, Stop and action-token rules).
- DESIGN-r2 section 3.4 makes every terminal receipt immutable for its sendId, and section 5.3 defines `POST /api/bots/:id/send-actions` with `replacementSendId`. Composer was not migrated, so an ordinary failed-without-line or restore-held chip could never run again.

### Decision

1. Composer migrates to the action contract. In `onResend`:
   - Mint `actionId` and `replacementSendId` (both `crypto.randomUUID()`) once per press and persist them in the outbox entry for the chip before any request (same outbox the store already uses). A network retry resends the byte-identical body.
   - Bot chat: `POST /api/bots/:id/send-actions` with the section 5.3 body `{contract:1, actionId, threadId, sendId: old, attemptId, receiptRevision, bindingEpoch, kind:"resend", replacementSendId, stopGen?, restoreGen?, confirmDuplicate:false}`.
   - Room chat: new `POST /api/groups/:id/send-actions` with the same body and the same semantics, under the same route policy entries as the bot route (listed in `server/route-policy.ts` and `companion/src/routes.ts`).
   - `attemptId`, `receiptRevision`, `bindingEpoch` come from the chip's receipt (the refused entry now carries them from the state API).

2. Replacement chip reconciliation (store reducer in `src/state/store.tsx`): on 200/202 `{replacementSendId, replacementAttemptId, receipt}`, remove the old refused chip entry for `old` and add the replacement as queued/sending under `replacementSendId`; release the old outbox copy (existing `releaseRecoveredSend`). The old receipt stays as history. On `stale_action`, `stop_required` or `duplicate_confirmation_required`, the chip stays and shows the existing action error; nothing is re-sent.

3. Dismissal is preserved: Dismiss on a refused chip keeps calling `DELETE /api/bots/:id/queue/:queueId` (and the group equivalent) exactly as today. A resend action whose target was dismissed returns 409 `target_dismissed`; the store shows nothing further and keeps the chip gone.

4. Legacy explicit-resend compatibility (older clients, phone, any caller still sending `resend:true` with the old sendId on the bot or group send route):
   - With an `actionId` and current fences: the server converts it into the same send action with `replacementSendId = "r-" + actionId` (deterministic, so a lost-acknowledgement retry of the same press finds the same action and returns the same replacement). Exactly one replacement is created. The response is the send-route shape for the replacement message.
   - Without an `actionId`, with a stale fence, or with a different fingerprint: no rerun; the route returns the immutable receipt (R1 F7-ML3 shape).
   - Automatic same-ID retries without `resend:true` always return the original receipt.

5. Ownership: A3 owns `src/components/Composer.tsx`, `src/state/store.tsx`, `src/state/send-delivery.ts` and their tests. I owns the `server/index.ts` group action route and legacy conversion (A1 supplies the send-store functions).

### Tests (RED first)

- `F7-COMPOSER-RESEND-FAILED-NO-LINE`: mounted Composer, refused chip from a failed-without-line receipt; press Send again; exactly one replacement attempt, chip moves to the replacement. RED: the old-id request returns the immutable receipt.
- `F7-COMPOSER-RESEND-RESTORE-HELD` and `F7-COMPOSER-RESEND-STOP-HELD`: with the current fence, one replacement; with a stale fence, `stale_action` and no send.
- `F7-COMPOSER-LOSTACK`: first action response dropped; retry returns the same replacement ids; one engine turn.
- `F7-COMPOSER-RELOAD`: reload between press and response; the persisted action finishes once.
- `F7-COMPOSER-DISMISS`: Dismiss still works; resend after dismiss returns `target_dismissed`.
- `F7-LEGACY-RESEND-ONE-REPLACEMENT`: old-shape `resend:true` plus `actionId` creates exactly one replacement; repeat returns it.
- `F7-LEGACY-RESEND-NO-ACTIONID`: returns the receipt, no rerun.
- `F7-GROUP-RESEND`: room chip through the group action route.

---

## R3. Downgrade clears retained provider context (review point 3, Required)

### Evidence

- `server/installation-memory-downgrade.ts:380-383`: retained cursors are reset only when `to < 10 && reclaimHasRun(db)` (`resetRetainedSessionCursors`) or `to < 12` (`resetIncarnatedSessionCursors`). A downgrade to 1.0.17 (`to117`) runs neither.
- `server/installation-memory-downgrade.ts:39-63` `resetRetainedSessionCursors(root)` clears `resumeCursors`, `resumePolicies`, `replayPending` and `resumeSeals` on every bot, task and group holder in `bots.json` and `groups.json`, but silently skips a file that does not parse.
- An uncertain write may already sit inside a retained provider session. Converting its transcript row to activity (DESIGN-r2 section 3.4) does not remove it from the provider's own context, so the old build would resume the session and the engine would still see the excluded input.

### Decision

1. New exported function in `server/send-attempt-compat.ts` (A1 owns the module; I wires it):

   ```ts
   export function clearRetainedContextForAmbiguousAttempts(root: string, db: Database): { ambiguous: number; cleared: number };
   ```

   - `ambiguous` = count of `send_attempts` rows with `delivery = 'uncertain'`, or `phase <> 'terminal'`, or `terminal_outcome = 'abandoned_uncertain'`, or a `send_replay_exclusions` row whose attempt's delivery is not `not_submitted`.
   - If `ambiguous > 0`: clear retained context on every holder (bot, each task, each group) in `bots.json` and `groups.json`, with the same fields as `resetRetainedSessionCursors` plus `resumeIncarnations`. This is deliberately install-wide and fail-closed (no fragile thread to holder mapping). Engines start fresh sessions; no message is lost.
   - Strict: a missing file is fine; a file that does not parse, is not an array, or cannot be written atomically THROWS. A throw fails the downgrade or export.
   - Idempotent.

2. In-place downgrade: call it in the downgrade sequence for every target including `to117`, after the receipt/compat export step and before `settleSearchIndexForDowngrade` and the memory schema stamp (so a stopped run repeats it). A throw leaves the stamp up and the downgrade reports failure, as other steps do.

3. Archive export (`send-attempt-compat.v1` path): apply the same clearing to the archive's staged `bots.json` and `groups.json` copies; if that cannot be established, the export fails and no archive is produced.

4. Ordering against recovery: the function runs whether or not normal startup recovery ran after a crash. It does not need the process to have reconciled bindings first; it reads durable rows only.

5. Amend DESIGN-r2 section 3.4 downgrade paragraph and `F7-DOWN-REPLAY` accordingly.

### Tests (RED first), `server/installation-downgrade-117.test.ts` (Slice I)

- `F7-DOWN-RETAINED-SESSION`: seed a bot with a retained `resumeCursors` entry and an attempt with `delivery='uncertain'` (simulate possible delivery, then crash with no recovery); downgrade to 1.0.17; assert all retained context fields are gone; then drive the real 1.0.17 inspector/start path (existing harness) and a subsequent send: a fresh session is used and the old input is not in the captured provider input. RED on base: cursors survive.
- `F7-DOWN-NO-AMBIGUOUS-KEEPS`: no ambiguous attempts; cursors stay (no needless context loss).
- `F7-DOWN-UNPARSEABLE-FAILS`: ambiguous attempt plus corrupt `bots.json`; downgrade fails, stamp not lowered.
- `F7-EXPORT-RETAINED-SESSION`: archive export clears the staged copies; corrupt copy fails the export.
- The existing fresh-replay projection test (`F7-DOWN-REPLAY`) stays alongside.

---

## R4. Schema registration lands before A2 integration tests (builder clarification)

### Decision

Add **Slice I0** (owner I, serial, about 0.25 session) between Slice 0 and wave A. I0 lands, with no behavior:
- `shared/help-turn-state.ts` wire enums and types (F4, F6 shapes);
- `server/database.ts` and `server/message-tables.ts` registration of the F7 tables (section 3.1) and the M2 tables (section 6.1) using the frozen DDL from DESIGN-r2, plus the snapshot reference registration in `server/installation-database-snapshot.ts`;
- typed stub exports in `server/send-attempt-state.ts` and `server/turn-index-state.ts` that throw `not implemented`.

A1 and A2 then own the bodies of their modules; DDL changes after I0 go to I as patches, as DESIGN-r2 says. A2's integration tests depend on I0, not on final I. Final Slice I stays serial and owns combined-head integration.

---

## R5. Ordered slices (binding)

Serial prerequisite, then parallel A1/A2/A3, then parallel B1/B2/B3, then serial integration, as the review confirmed:

1. **Slice 0** (serial, owner I, 0.5 to 1 session): DESIGN-r2 Slice 0 plus write `evidence/F7-review-original.md` from Appendix A and the F7-ML1 to F7-ML8 manifest. First test execution remains the full packaged `src/e2e/help-ask-fixture.human.spec.ts` including 7b, under xvfb in a build host container. L13 rows 5 and 8 stay NOT FIXED until final proof.
2. **Slice I0** (serial, owner I, 0.25 session): R4.
3. **Wave A, parallel:**
   - A1 (2.5 to 3 sessions): DESIGN-r2 files plus `server/channel-queue.ts`, `server/channel-queue.test.ts` and the `clearRetainedContextForAmbiguousAttempts` body in `server/send-attempt-compat.ts`. RED first: DESIGN-r2 A1 list plus F7-ML1, F7-ML2, F7-ML5, F7-ML6, F7-ML8, and the server half of F7-ML3 and the legacy resend tests.
   - A2 (1.5 to 2 sessions): unchanged (`server/message-db.ts`, `server/turn-index-state.ts`, F5), now testing against I0's registration.
   - A3 (1.5 to 2 sessions): store path corrected to `src/state/store.tsx`; add `src/components/Composer.tsx` and its resend/dismiss tests; `src/state/send-delivery.ts` F7-ML3 client handling; Help mapper F7-ML4. Freeze the corrected F4/F6 resend compatibility before implementation. Help UI files are those recovered in Slice 0 (`HelpAsk.tsx` from the L4B branch; `HelpAskChief.tsx` is the current base fallback).
4. **Wave B, parallel:** B1 (adds the F7-ML4 server ordering in `server/ask-turn-state.ts` and the group action route policy entries), B2 (replay: F7-ML6 query plan proof with F7-REPLAY in a fresh session), B3 (L13 proof; M5a/M5b and M8a to M8d mutation failures preserved; M8e stays demonstrated equivalence). Unchanged otherwise.
5. **Slice I** (serial, 1.75 to 2.25 sessions): DESIGN-r2 Slice I plus the group action route, legacy resend conversion, downgrade wiring of R3, `F7-DOWN-RETAINED-SESSION`, `F7-EXPORT-RETAINED-SESSION`, and `F7-ML7-LABELS`. Independent Astra and Fable reviews plus MAIN disposition before release.

Estimate: 10 to 13 builder-sessions plus 1 to 2 review sessions (DESIGN-r2's 9 to 12 plus about one for R1 to R3).

## Decisions for Sean

None. All points are technical and closed above. (R2 keeps every existing Send again and Dismiss behavior; no copy change is introduced.)

---
