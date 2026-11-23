# No holds on hand-offs (1.0.3, release-blocking; Sean approved 2026-10-20)

## Scope
- Supported: only 1.0.2 data as the starting point. Out of scope: pre-release 1.0.3 builds (their held rows are retired below, best effort).
- A downgrade to 1.0.2 ends everything on the hiding side; after a re-upgrade, anything unverifiable reads as no-answer.
- Fail-closed default: an unclear case gives the asker the no-answer line, never the words.

## Rule
A delegation result (delegate_bot, ask_bot, a queued or shared hand-off, and their continuations) whose gate verdict is `checking` is never held.
The asker gets a final result at once: status `no_answer_checking`, "(no answer: that memory is still being checked, try again later)".
The request completes, the asker is woken exactly once through the normal completion path, and the worker's words are stored on no receipt,
replay record, frozen-reply row, wake payload or routine answer record. `withheld` keeps its own line the same way. The owner reads the reply
in the worker's own chat (unchanged); the pair-room/channel mirror stays the checking line; card deliveries and owner-facing holds are untouched.

## Every place a delegation result was held, and what it does now
1. `runFinalizeDelegationWatch` (direct and room hand-offs, handoff-boundary.ts ~189): no `held`. Checking => reply = no-answer line, written as
   the ordinary result row under `dres-<task>`, receipt `done` with the no-answer status and no `copyOf`, owed reply = the line. The direct asker
   wakes through `askerWake.returned` after commit; a room hand-off completes its request in the same transaction (`completeRoomAsk`).
2. `runDeliverSharedResult` (team queue, including a shared hand-off from a direct chat): `deliverHeldShared` removed. Checking => the
   destination gets the no-answer row, the receipt keeps the no-answer status, delivery is marked; the pair room gets the checking line.
3. check/wait_delegation (`receiptResultShown`, the `ended.key` shortcut): checking => no-answer line. The receipt is terminal, so reading it
   consumes the wake intent exactly as for any finished hand-off (poll-while-checking can no longer strand a later settle: there is none).
4. Synchronous ask_bot (direct pair and shared): checking => the asker reads the no-answer line; the event receipt is `noanswer:checking`
   (`noanswer:withheld` for withheld), decoded by event-limit.ts and replayed as that line: a repeat in the same event never re-reads originals.
5. `storedAnswerText` (handoff-replay.ts) for older `answer:` records: checking => no-answer line.
6. `continuationOutcome` (the wake prompt of a request tree): checking => no-answer line; the wake itself carries only ids.
7. Frozen-reply boot recovery (1.0.2 rows): a gate verdict of checking holds nothing and writes nothing; the slice stops before that row
   (cursor kept) and the recovery runs again when the revocation runner goes idle or lineage warms, so the row is then restored with its words
   (C5) or stays the withheld line if really withheld. It never stays stuck frozen. The `hold` port is removed.

## The asker's one wake is durable (revision 1: Astra design round 1, three Highs, all taken)
The no-answer rides the normal wake, so the normal wake is made crash-proof on every path that delivers a delegation result to an asker:
1. Direct `delegate_bot` (no room request): the wake intent is registered BEFORE the hand-off is acknowledged, and `register` reports whether
   it reached disk (one retry). If it did not, the just-queued hand-off is dropped (it cannot have started: a direct queue drains only when the
   asking turn ends), the charge is given back and the bot reads `could_not_start`. No acknowledged hand-off lacks a durable intent.
2. Completion: a direct hand-off's receipt keeps its owed reply past the final commit until `askerWake.returned` reports the wake on disk
   (`finishHandoff(..., { keepOwed })`, then `releaseOwedReply`). A crash in between leaves the receipt owing: the boot pass
   (`deliverOwedReplies` -> `settleReceipted` -> `replayOwedReply`, stable row id) runs the receipt hook, which marks the row as an external
   update and calls `wakeAfterRecoveredReceipt`; `AskerWakes.deliver` dedupes by task and row id, so the wake is never doubled.
3. Shared hand-off from a direct chat (ask_bot to a teammate shared with a team, no parent request): today no wake exists on this path for any
   result. It gets the same intent as (1), keyed by the request id, registered ONLY when the asker does not read the answer in its own turn:
   in line (a failed write cancels the queued request, refunds and refuses) or past its wait. A synchronous answer registers nothing, so no
   consume is needed and none can be lost (Astra design r2 High 2). delegate_bot and ask_bot's busy fallback to a shared teammate from a
   direct chat register it at admission through `admitAskerWake` (Astra final High): a failed write cancels the request and refuses; the delivery wakes it through `sharedResultReturned` (handoff-boundary.ts, wired by index.ts), tested from the route through completion. `runDeliverSharedResult`
   (the one delivery, for text, withheld and no-answer alike) marks the row as an external update and calls `returned` for the request; the
   request is marked delivered only once that wake is on disk, so the owed-delivery sweep or the boot repeats the call (deduped) after a crash.
   Requests with a parent (room turns, W1/W2 under S) wake through the request tree as today; the root S of a chain started from a direct chat
   is the parentless request whose delivery wakes the asker.
4. The boot retirement marks the rewritten row as an external update before its direct wake (Astra round 1 follow-up).

## Continuation chains (S waits on W1, W1 on W2)
Nothing is held, so the chain runs today's wait-and-continue path unchanged. The request that DELIVERS to the asker (the one whose completion
wakes it: S's continuation through `continueFrom`) reads its result through `continuationOutcome`, so a checking verdict there is the no-answer
line. W1/W2 are intermediate turns: their own results go back into the chain exactly as today.

## Boot recovery of rows held by earlier builds (held-replies.ts becomes a one-shot retire)
For each receipt still `held`, once at boot (after receipts and asker wakes load), in this order, idempotent:
1. the held row (or a held `dres-` row no receipt names, S24) is rewritten in place to the no-answer result row: words, `copyOf` and the
   checking flag removed; a missing row is written as the no-answer row under the stable id;
2. completion: a room request still open completes `done` at that row; a direct asker is woken once (`wakeAfterRecoveredReceipt`, deduped by
   task and row id in AskerWakes.deliver);
3. the receipt: `held`, `reply` and `copyOf` cleared, result = the no-answer status. An owed held reply replayed by any path writes the
   no-answer line, never the words. A crash between steps repeats them; none of them can write words.

## Downgrade
Nothing to carry: no new tables, columns, files or receipt fields. A 1.0.2 reader sees ordinary result rows and receipts.

## Removed code
`wakeAfterHeldSettle`, `deliverHeldShared`, the held branches of `runFinalizeDelegationWatch`, the hold settle pass and its sweep/kick sites
(`settleHeldReplies`, `kickHeldReplies`, the `configureHeldReplies` judge/deliver ports), the frozen-replies `hold` port and its checking branch,
the held branch of `appendHandoffReply`/`owedReplyOf`.

## FOLLOW-UPS (1.0.4, not blocking under the Scope rule)
- Direct ask_bot timeout hand-over (handoff-boundary.ts, `outcome.status === "timeout"` branch, ~l.631-651 at 5464a691f): the wake intent is
  registered after the peer is running and its write result is not checked; a failed write followed by a crash loses that wake. Pre-existing
  in the 1.0.3 delegate-wake lane; 1.0.2 (afbf549ba) has no asker wake at all on this path. Not touched or made more reachable by this change.
  The shared hand-off's timeout branch registers the same way and carries the same limit.
- Astra r2 follow-ups: delegations.ts ~611 and room-request-owed.ts ~344 clear owed state on other recovery paths before proving wake persistence.
