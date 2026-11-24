# CANCEL-TREE-104: a cancel reaches a hand-off in setup, mixed wakes keep outside results, the source room hears the closing

Lane fix/104-cancel-tree-d12 on d12c102b6 (U31). Builds on rules D1-D4 and H1/H2 already on the branch (failed askers end bound work, no hop cap,
mixed wakes run, decide() and pump() guarded, same-bot return wakes told by payload, the dispatcher starts the stored row). This addendum answers
Astra's REVISE: (A) a cancel that lands while a hand-off's turn is being set up, (B) a cancelled subtree that carries another tree's result,
(C) the source room's closing line. Round 2: every round-1 item is answered in place (R1 binding, R2 states, R2b acceptance order, R2c quiet
path, R3 shared and the attempt limit, R4 boot, R5 scope, R6 ordering and the drop path).

## 1. The hand-off start, as a state machine (one pending_delegations row and its room request)

| State | Row | Request | Leaves by |
|---|---|---|---|
| S0 queued | phase queued/fresh | queued | decide(): start (S1), or cancel verdict when the request ended or the asker ended (D4) |
| S1 in setup | started, submitted_at null, no acceptance | running (the same transaction as the prompt append) | submitted() or accepted() (S2); a setup error (afterStartFailure); THE CANCEL (A) |
| S2 handed to the provider | submitted_at or accepted_turn_id set | running | the turn's end (receipt, request terminal); a cancel interrupts the provider turn; a refused send after submission: held |
| S3 settled | row removed, receipt | terminal | - |

A cancel of the asker writes the request `cancelled` in the cancel's transaction (the walk), then runs the post-commit effects: dropDelegationsOf
(S0 rows) and interruptRequestTurns (running rows). Today S1 is the hole: interruptTurn finds no provider turn, submitted() checks only the phase,
and the provider gets the turn of a cancelled request.

## 2. Rules

R1 (revoke at the cancel, bound to the request). The host registers every hand-off turn in turnRequestByGeneration at dispatch (generation ->
request id), as card runs, shared runs and room turns are today. interruptRequestTurns, for each interrupted request: the live generation of its
target thread (directRuns, else internalTurnOwners) is this request's only when it is bound to this request (bound at the claim, one synchronous
step). Anything else, bound to another request or unbound, is never touched (Astra r4 High 2). A room setup BEFORE its claim owns its own cancel
(R1 v2, CANCEL-TREE-SETUP-ROW-DESIGN.md v2.2): runGroupMemberTurn reads the row the claim would bind
(roomTurnRequests, which holds a memory_revoked re-dispatch, else pendingRoomTurnRequests) and the one it started with, at entry, after
prepareThread and immediately before the claim; an ended or missing row stops it and settles the setup (idempotent). startRoomRequestTurn reads
it at the head of the room queue. After the claim the room turn's write (beforeSubmit) also refuses when its generation was revoked, so an engine
that had not registered the turn yet (and could not hear the interrupt) writes nothing (Astra r5 High, design r1 High). When bound: cancelDirectTurnDispatch(bot.id, threadId, note) revokes the
dispatch claim (a setup in flight throws DirectTurnSetupCancelled at its next checkpoint, every checkpoint reads directTurnClaimIsCurrent), then
adapter.interruptTurn(threadId) stops a turn the provider already has, as today. F6 is closed by the binding, not permitted.

R2 (recheck at the hand-over, fail-closed). markDelegationSubmitted and markDelegationAccepted each run their check and write in one
transaction: the row must be phase started; for origin room the request must exist and be `running`; for origin shared it must exist and be
`running` or `waiting_owner`; a direct hand-off (no request) is checked by its row alone, as today. Anything else throws DELEGATION_NOT_STARTABLE
("the request that asked ended before the handoff was handed over") and writes nothing: a missing request, a queued one, a terminal one. Both
acceptance orders are covered: a provider that is told accepted before its submit callback (the cloud computer: recordHandoffAccepted at
dispatch) is refused at accepted(), one that submits first is refused at submitted(); neither write lands, so the row still reads "never handed".

R2c (the host's quiet path). In the host's beforeSubmit and in recordHandoffAccepted, a DELEGATION_NOT_STARTABLE refusal of a hand-off whose
request ended is rethrown as DirectTurnSetupCancelled, the same path a stopped wake takes: no error line in the worker conversation, no failure
notice, onDispatchError with the message, the thread idle. Every other refusal keeps today's handling.

R3 (settling the start the cancel cut short). afterStartFailure first reads the hand-off's request. When it is terminal and the row shows the
turn was never handed over (no submitted_at, no accepted_turn_id, no evidence): no could-not-start chip; the row is reset to fresh by a
settle that ignores the attempt limit (a start proven never handed over is never held for the owner because its asker ended: F7 closed);
then the hand-off is admitted at once (admit with probe), decide() returns the cancel verdict, and apply() settles it (R6). The request is
not terminal, or the row shows a hand-over: today's path (held or interrupted by the row).
decide() for a shared request whose state is `cancelled` returns the cancel verdict (receipt cancelled, request set) instead of settled:ended,
so a cancelled shared hand-off is receipted and closed by R6 like a plain one; done/failed shared requests keep settled:ended (their outcome is
on record from the shared run's own finish).

R4 (restart in the middle). (a) The process dies after the cancel commit and before the post-commit effects: at boot, settleStartedDelegations
runs the same settle as R3 on every started row (a never-handed row with a terminal request is reset to fresh whatever its attempts), the boot
drain admits it, decide() sees the terminal request, apply() writes the line and the receipt; a queued row goes the same way. (b) A row that was
handed over (submitted or accepted) with a cancelled request: held or interrupted as today. Residual, stated: a local engine's turn is a child
of the process and ends with it; a cloud computer turn accepted before the crash is not re-interrupted by the boot (outside this lane, noted
for the report).

R5 (a cancelled wake keeps what is not its own). The walk in completeRequest first collects its scope S: the root plus every row it will visit
(whole: all descendants; dependencies: asks and continuation wakes only), then writes. For every open wake (queued or running) it cancels,
the results are split by their request: a result whose request is in S ends with the wake; a result whose request is outside S and still
exists is kept. After every write of the walk, the kept results of each such wake are re-queued by one insertWake (absorb: true, so they join
any queued wake of that bot and thread, never a cancelled one), key `wake:kept:<cancelled wake id>` (`:2`, `:3` when that key exists, as
readdressReviewWake does), parent = the request of the first kept result (outside S, so no fence refuses it), same toBotId and threadId.
The kept wakes are listed in CompletionResult.wakes so the callers pump the dispatcher. Root rule, cancelled roots only: when the owner cancels a wake that carries results, S for the root's split is {root} + whole
subtree(root) + {its parent} (a return wake carries its parent's own result) + the parent's whole subtree only when the cancel actually cascades
to that parent (the root is the parent's own continuation and the parent is waiting_bot: continueFrom completes the parent cancelled, whose walk
ends that subtree). An ordinary return wake's parent is done and not cascaded: its subtree is not in S, so a sibling's surviving result is kept.
A root completed failed/expired/unknown is not split (no cancel; its results end with the failed turn as today). Scope dependencies on a
cascaded failure: cards under the failed turn are outside S, so a card's result absorbed into the lead's continuation survives (D1).

R6 (the closing line, once, durable). One source-room activity line under the stable message id `handoff-cancelled:<hand-off id>` (skipped when
a message with that id exists), text exactly: `Hand-off to @<target name> cancelled because the request that asked ended`, from the sender
bot, with `requestId: <the request id>`. It is Murage's own line (murageLine), not a reply: no `to`, nothing delivered, so the receipt
listener gets delivered null (nothing marks the asker's context updated, no wake) and the asker's request is already terminal.
Order at every site: the line first, then the receipt, which must be on disk (recordDelegationReceipt returns true; a receipt found only in
memory does not authorize the removal), then the queue row's removal; the row stays until the last step, so a crash between any two is
repaired by the next drain, which repeats the site. Sites: (1) apply()'s branch for a request that ended while the hand-off waited
(handoff-dispatch.ts); (2) dropQueuedDelegation when the hand-off's request has ended (the post-commit drop of a queued hand-off under a
cancelled request): same text, same stable id, same order (line, receipt on disk, then acknowledge; a receipt not on disk or an acknowledge
that fails leaves the row for the next drain, where site 1 completes it). The could-not-start drop (handoff-boundary) keeps its own words,
as do the deletion and roster paths.

## 3. Failure list

| # | Case | Outcome |
|---|---|---|
| F1 | cancel lands in S1 before the prompt commit | startDelegation's transaction fails (markRequestDispatched on a cancelled request) -> afterStartFailure -> row not started -> admit -> cancel verdict -> line + receipt |
| F2 | cancel lands in S1 after the stamp | R1: DirectTurnSetupCancelled at the next checkpoint -> R3. No checkpoint before the hand-over: R2 refuses at submitted() or accepted(), R2c keeps it quiet -> R3 |
| F3 | cancel lands after the hand-over, before the turn's end | the provider has the turn; R1's interrupt (bound) stops it; held or interrupted by today's rules |
| F4 | process dies after the cancel commit, before the post-commit effects | R4(a): boot resets the never-handed row; decide() cancels; line + receipt |
| F5 | process dies after R2 threw, before the settle wrote | same as F4 (the row still reads never handed) |
| F6 | request still running while a newer turn is live on the same thread | the generation is bound to the newer turn's request: nothing is revoked or interrupted for the ended one |
| F7 | the cut-short start was past the attempt limit | R3/R4 reset it anyway: never handed over, asker ended, nothing for the owner to decide |
| F8 | kept result whose request row is gone | ends with the wake (nowhere to return to); console.error |
| F9 | running mixed wake interrupted at the cancel | its turn is stopped (no reply): the kept wake is the one delivery. If that turn completed between the cancel commit and the interrupt, the lead reads the outside result twice (bounded to one repeat; a read, not a re-run) |
| F10 | shared hand-off | D4 guards queued; R2 checks the shared request's states; a cancelled shared request is receipted and closed by R3/R6 |
| F11 | the line write fails (thread gone) | nothing after it ran (line first); the row stays; the next drain repeats the site |
| F12 | outside result for a bot whose queued wake is itself in S | the kept wake is inserted after every write of the walk, so absorb never finds a wake the walk cancels |
| F13 | a direct hand-off (no request) | untouched: row checks only, today's receipts and words |

## 4. Tests (fail on base d12c102b6 with D1-D4, pass on the branch)

| Test | Proves |
|---|---|
| T1 setup race (handoff-dispatch, fake host) | host stamps, awaits; the asker is cancelled (the walk); submitted() throws, the provider step never runs; after onDispatchError the row is gone, receipt cancelled, line once with requestId. Second case: accepted() first, then submitted(): both refused, same end. Third: attempts already at the limit: still cancelled, never held |
| T2 merged results (room-requests) | W under A under P absorbed B's result (other root); cancel P: W cancelled carrying only A's result, B's result in `wake:kept:<W>` with parent B, listed in wakes; a root-wake cancel keeps only absorbed results; dependencies scope keeps a card's result |
| T3 closing line | drain of a queued hand-off whose request ended, and dropDelegationsOf's drop: exactly one line with the text and requestId, from the sender; a repeat adds none; the asker's request stays cancelled with no wake rows under it; a cancelled shared request gets the same line and receipt |
| T4 restart mid-cancel | started-not-submitted row (attempts at the limit), request cancelled; boot settle + reconcile + drain: no start, row gone, receipt cancelled, one line |
| T5 sites | index.ts: hand-off turns registered in turnRequestByGeneration; interruptRequestTurns binds by generation and revokes before interrupting; beforeSubmit and recordHandoffAccepted route the refusal to DirectTurnSetupCancelled (source site check, as cancel-tree-104-sites does) |

## 5. The call after round 2 (two Astra rounds, fail-closed)

Adopted from round 2: R5's root scope follows the real cascade (item 4); R6's order is line, receipt on disk, removal at both sites (item 5).
Verified, not changed: R2c (item 3): a throw from the submission fence rejects the adapter's sendTurn (drivers/claude.ts submissionRefusals,
claude-warm.test.ts "COLD-REFUSED"), so it lands in the host's setup catch, where DirectTurnSetupCancelled takes the quiet path; the
submission_refused terminal-event path is for refusals the engine reports after it took the prompt, which R2 prevents for an ended request.
Residual, by contract (item 2): an acceptance stamp means the provider took the turn; a cancel that lands after it is S2 (interrupt, then held
or interrupted by the row), never a "never handed" settle. Residual, outside this lane (item 1): a cloud computer turn accepted before a crash
is not re-interrupted at boot; reported to MurageMain for a follow-up.

## 6. Grok lane review (10-25) calls
High 1 (unbound setup window skipped the interrupt): R1 reworded above; fixed. High 2 (a continuation that absorbed a result after its asker ended
started with the asker's answers): D3's "mixed wakes run" is withdrawn; every continuation under an ended asker is fenced, and the R5 split keeps the
absorbed outside results (repro d2 proves it). Medium (cloud accepted() fell through on DELEGATION_NOT_STARTABLE): quiet cancel too. Medium
(missing ancestor row reads as not ended, cancelledAncestorOrSelf): pre-existing on d12c102b6, logged in OUT-OF-SCOPE-FINDINGS.md.

## 7. Astra build review r4 (10-25) calls
High 1 (a return wake shares `wake:<id>` with a continuation; the R5 root rule took its parent's whole subtree and lost a child card's absorbed
result): the root rule uses isContinuationWake (repro h2). High 2 (unbound ordinary turn interrupted) and High 3 (setup before a generation not
stopped): R1 reworded above.

## 8. Astra build review r5 (10-25) and design rounds r1-r2 (R1 v2)
r5 High (memory_revoked re-dispatch holds its row in roomTurnRequests, no generation, reached the provider after a cancel): R1 v2 above, the setup
reads its own row. Design r1 High (post-claim write before the engine registered the turn): the generation test at the write. Design r2 High (an
acceptance-predicate generation test would also fire after a normal completion, with thread-wide teardown): that part dropped (v2.2); the refused
write already ends the turn as dispatch_failed. Proof: server/cancel-tree-104-setup-row-api.test.ts (real server, fixture engine, zero writes).
