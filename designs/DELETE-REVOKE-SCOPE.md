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
