# DELETE-REVOKE-SCOPE (1.0.15) r2

Incident (rc1014 idle smoothness run): deleting task thread A while a Grok turn on unrelated thread B sat between dispatch.send and
engine.acquire. B ended with a card ("context revoked during dispatch ... after 0 rebuilds"). House rule: deleting one chat never stops
an unrelated turn. Pre-existing since 1.0.7.

## Cause (GrokBuild ruling, 2026-11-03)
1. captureThreadDeletion (memory/capture.ts:242) moves the global deletion_epoch. B's acceptance (index.ts memoryReceipt.accepted ->
   disclosures.ts:57 -> policy.ts:509 assertMemoryAccess) compares the frozen access.deletionEpoch and throws MEMORY_CONTEXT_REVOKED.
   bumpAuthorityHard (policy.ts:187) is redundant there and is not the throw.
2. 0 rebuilds: ACP hands the id back at launch (acp/core.ts:5634), before its prompt write (core.ts:5445). The boundary is "unknown"
   from fence.invoked on (turn-dispatch-guard.ts:10), so canRetry is false and the setup catch (index.ts:13053) cards.
Privacy needs a revoke of what was shown TO A and what came FROM A, not the failure of every in-flight turn.

## Slice (a): rebuild a turn refused at acceptance when the engine proves it wrote nothing
A1. `capabilities.fencedWrites` (server/contracts.ts ProviderAdapter), narrow meaning (GrokBuild r1): the turn's prompt bytes and any
    steer bytes are written only after `turn.beforeSubmit()` passes, with no await between check and write, and a steer is possible only
    after the prompt was sent. It does NOT claim the engine holds nothing: argv, env, session/new or session/load and MCP connects may run
    before; they carry no memory frame, and live MCP re-checks the epoch (routes.ts:62). Set on ACP core only (prompt core.ts:5445->5457,
    steer beforeWrite 4454->4468 behind promptSent 4449). Every other adapter is unset and keeps today's card.
A2. TurnSubmissionBoundary counts `released` (passed beforeSubmit calls), never reset (a notWritten after a release still counts).
A3. `sealUnwritten(error, fencedWrites)`: only when the flag is true, state is "unknown", released is 0 and acceptedBy was not called.
    One synchronous step in the acceptance callback, before guardTurnDispatch awaits stopAfterSetup: state "refused" with that error,
    and every later beforeSubmit of the turn throws it before validating (and calls notWritten). Teardown (stopAfterSetup, interrupt
    and resetSession) is kept and awaited before the rebuild. canRetry is then true and the existing rebuild runs.
A4. One helper `acceptMemoryReceipt` at both acceptance sites (direct index.ts ~12937, room ~18478). The room catch keeps its own
    re-dispatch (runGroupMemberTurn, always sessionReset); the helper only seals, never calls rebuildRefusedDirectTurn.
A5. The rebuild mints a fresh access under the current epoch (turnMemoryAccess, dispatchAccess); the epoch mismatch clears the resume
    cursor and sets sessionReset (index.ts ~12380), so no session/load of a session that held A's memory. A's deny row is written in the
    deletion's transaction. Fail closed: a throw while deciding, or no proof, leaves the card.
Unchanged (not this slice): a refusal after a released write (state "refused" through beforeSubmit) keeps today's canRetry; Stop and
budget-exhausted behaviour; watchdog wait cleanup on a retired provider's completion (Astra r1 Mediums, follow-up list).
Tests: turn-dispatch-guard.test.ts (proof needs flag, unknown, zero releases, not accepted; seal refuses later writes before
validating); delete-revoke-scope-api.test.ts with the fake late driver (FAKE_LATE_PRE_HANDBACK_GATE holds before handback,
FAKE_LATE_IGNORE_STOP makes the stopped engine still try its write): delete chat A while B is held; B is rebuilt, one reply, no card,
the held attempt's write is refused by the seal, one prompt written, A's marker not in B's frame, B's receipt on the new epoch; an
unflagged engine still cards (control).

## Slice (b), design only, on top of (a): narrow the deletion scope
Per-thread or per-scope deletion check replacing the global compares, all moved together: assertMemoryAccess (policy.ts:509, both its
deletionEpoch and policyRevision halves where bot delete capture.ts:269 and forget.ts:36 bump both), the receipt watermark
(deny-read.ts:577-579), fullContinuationCheck (disclosures.ts:197-207), and the "*" pending window (revoke-commit.ts:280-286), which
must still cover every reader of A. Roster removal uses a SOFT authority bump logging the removed thread's record, source, message,
scope and root ids instead of bumpAuthorityHard (policy.ts:187, :209); without the cited-id log a hold could skip a deleted line
(disclosures.ts:150). messages_d (authority-epoch.ts:103) is a hard authority bump, handled the same way. Fail closed to a full check
when softChangedSince is null, triggers are missing, there is no hold, or inside a transaction. Citing receipts on other threads are
revoked (revokeRecordDisclosures shape). Rightly global, unchanged: audience, identity canon, restore, team, settings and mode.
Overlap: the forget fence R4 (designs/MEM-LEARNING-FENCE-R4.md section 3) keeps its own counter (TEMP triggers on tombstones, deny rows
and policy/epoch updates) and does not depend on deletion_epoch. (b) keeps writing deny rows and tombstones on every delete and Forget,
as today. Not yet safe to narrow (GrokBuild r2): a thread delete does not tombstone in its commit (capture.ts:230-231), and these
revoke by deletion_epoch alone and must move with the list above: procedure-review.ts:153, consolidate.ts:447,
evolution-runtime.ts:111, routes.ts:157; the authority and provenance TEMP counters bump on deletion_epoch, not on memory_deny.
(b) is agreed with GrokBuild and Astra before it is built.

## 1.0.18 implementation and verification

Conversation deletion now uses the existing durable `memory_deny('thread', id)` fact. `captureThreadDeletion` no longer increments
`memory_meta.deletion_epoch`, and `commitRevoke` no longer advances the installation-wide receipt watermark for a thread root.
`assertMemoryAccess` checks the thread deny by primary key on every acceptance/submission check, including an empty frame. Global
Forget, bot-scope deletion, policy, identity and audience changes retain their existing fences.

A thread denial, receipt revocation/removal and message deletion invalidate authority cache proofs through the bounded soft dependency log. Session holds retain
threads of cited sources, conversation-scoped records and replay roots. Derived records and bring-in sources retain a conservative full-check fallback on thread changes when their transitive thread dependencies are not recorded. Removing a task from the roster logs the removed thread;
removing a whole bot or room still takes the hard cache fallback, since it can withdraw container scopes. Missing triggers, log overflow,
transactions and restarted connections retain the existing full-check fallback. Source/record cleanup still invalidates affected cached
content, and deny writes explicitly invalidate provenance and legacy lineage caches. The latter is necessary even before cleanup has
written tombstones; the old global epoch used to provide that invalidation incidentally.

Background evaluation has a separate durable `thread-deletion-clock` binding. `learningDeletionEpoch` combines it with the existing
global epoch for procedure/evolution/skill publication and async consolidation/correction checks. The binding is bookkeeping, not a
foreground authority change. Source job publication and source-only disclosure validation also check the source's durable deny fact directly. There is no scan over deleted
threads: foreground denial and the background counter use primary-key reads; frame/session validation keeps its existing fixed limits.
The durable marker, its conservative pending windows, cross-thread carries, deny-generation send fence, and cleanup jobs remain intact:
unknown dependency closures must still fail closed until proved. The change does not waive a pending or genuinely dependent reader.

Tests cover prepared and late-submit windows, two deletions, unchanged unrelated prompt identity (zero rebuilds), unfenced adapters,
A's refused frame, B actually citing A, stale search hits, restart, and background publication. The real-server fixtures use fake engines.
The verification launcher now sets `NODE_ENV=test` when it explicitly forwards the test-only exclusion helper; without that setting,
`overrideAllowed` rejected the forwarded helper and engine cleanup failed in a source checkout with no native build.

### G8 idle I/O investigation (2026-11-06)

Compared `f22181a3fa` (1.0.15) with lane base `b2588099f9`. The conversation's global deletion epoch bump and global watermark predate
this train; the intervening capture changes concern shared-room messages and transcript decoding, not deletion. A material I/O change
is commit `1f88adc79d`: FTS merging moved from deletion's main-thread commit to bounded worker merge/prove/scrub steps
(`server/message-db.ts:1489`, `server/database.ts:360`, `server/search-merge-runner.ts:287`). This changes when and how many operations
occur, but does not by itself establish which measured stalls grew.

The supplied `inputs/GATE-PREP.md` has only aggregate counts (S9.io 2→3, ALL.io 8→10, ALL.eld250 8→10), with traces located on an
unmounted gate host. The rig commit `e0a34e2c5` and `scripts/smoothness` are absent from this lane's object database/tree. Requested the
1.0.15 and 1.0.18 idle trace/verdict files. Without their event timestamps, operation labels, durations and thresholds, the extra rows
cannot be causally attributed; no speculative I/O change was made. This attribution and the driver's G8 rerun remain unverified.

### Phase-2 publication fence (2026-11-06 review fix)

The production procedure host now calls `assertProcedurePublicationCurrent` before evaluated or owner-edited publication. It checks
`learningDeletionEpoch` and rehydrates the bounded evidence through the existing `sourceDenied` and lineage checks. Revocation returns
`MEMORY_CONSOLIDATION_REVOKED`, even when cleanup has not yet retired the source. The same host serves automatic review publication
(both the inline and outbox paths) and accepted suggestions; edited suggestions use the same fence. No foreground authority or deletion
semantics change.

Both skill publishers are synchronous. Routine `promoteInstructions` and owner-edit `update` synchronously call `commitMutation`,
`save`, `saveNow`, and `saveFull`/the journal writer; `saveFull` uses `writeFileAtomic`. There is no await between the final host check
and durable publication. The regression uses the real production host and publisher, proves the phase-1 outbox is committed, then
commits a same-source deletion with cleanup pending, an unrelated deletion (clock-only), or a denial before phase 2. It checks the revoked outcome, unchanged routine file and absent evidence handles, with
unchanged controls for both routines and skills. Before the fix, the eight new cases produced six failures (the skill clock already
refused deletion, but used a different error); afterward all eight pass.
