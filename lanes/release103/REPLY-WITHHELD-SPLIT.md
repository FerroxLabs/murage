# Build split for fix/103-reply-withheld (tests at fb111a781)

Base for every piece: branch fix/103-reply-withheld at fb111a781 (fix/103-lineage-final ecef9150e + contract + tests). Each piece builds in
its own worktree on a branch from that sha and must leave the other pieces' files untouched. The interfaces below are frozen: a piece
that needs more adds it only to its own files and tells the integrator.

HARD rules: no Mac builds (tests run through vt-test.sh runner 1 or hz-test.sh); never touch ~/.murage; never pkill by pattern; no em
dashes; none of the three words the house rules ban; no Co-Authored-By; both typechecks (`tsc -p tsconfig.json`, `tsc -p tsconfig.server.json`).

## Shared types (frozen)

```ts
// server/result-egress.ts (piece A owns the file; B and C import)
export type LineVerdictState = "shown" | "withheld" | "checking";
export interface EgressMessage { id: string; text?: string; copyOf?: EgressOrigin; withheldFromBots?: boolean | "forgotten" | "checking" }
export interface ResultEgressDeps {
  message; authorize; messageSourceForgotten; messageMadeWithMemory; ownUnsharedWork;            // unchanged
  copyOriginWithheld: (copy: EgressOrigin) => boolean | { withheld: boolean; unproven: boolean }; // true = withheld
  capturedMessageWithheld: (threadId, messageId) => boolean | { withheld: boolean; unproven: boolean };
  partitionAllowed: (workerBotId, threadId, messageIds) => boolean | LineVerdictState;            // false = withheld
  linesShown?: (threadId, messageIds, notOwnerAudience) => boolean | LineVerdictState;
  doorShown?: (readerBotId, threadId, messageIds, notOwnerAudience) => boolean | LineVerdictState;
  withheldLine?: string;   // index.ts: `[${ROOM_REPLY_WITHHELD}]`
  checkingLine?: string;   // index.ts: `[${ROOM_REPLY_CHECKING}]`; default status("checking")
}
export type ReleasedResult =
  | { kind: "text"; text: ReleasedText; copyOf?: EgressOrigin }
  | { kind: "withheld"; line: MurageStatus }
  | { kind: "checking"; line: MurageStatus; held?: { text: ReleasedText; copyOf: EgressOrigin } } // held only when !notOwnerAudience and the origin names ids
  | { kind: "refused"; line: MurageStatus; code: string } | { kind: "status" } | { kind: "gone" };
export type ReleasedAskReply = ... | { ok: true; text: MurageStatus; withheld: true; checking: true };
// precedence on the walk: withheld > checking > shown. Exceptions, walk limits, unproven, "checking" flags = checking; a cycle = withheld.

// server/murage-status.ts (piece A): new key `checking` -> `[${ROOM_REPLY_CHECKING}]`, kept (KEPT: checking: {}), bot visible.

// server/bot-read.ts (piece A)
export function storedRowsVerdict(db, viewer, threadId, ids, options?: BotRowsOptions): LineVerdictState;
export function doorEgress(db): (readerBotId, threadId, messageIds, notOwnerAudience) => LineVerdictState;

// server/memory/replay-lineage.ts (piece A)
export function copyOriginVerdict(allowance, copy: EgressOrigin): { withheld: boolean; unproven: boolean };

// server/handoff-boundary.ts (piece A owns this helper; piece B owns the finalizer and shared delivery in the same file: coordinate by region)
export function receiptResultShown(released: ReleasedResult, receipt: { copyOf?: EgressOrigin; ended?: Outbound }): { result: Outbound; reason?: string };

// server/delegations.ts (piece B)
export interface DelegationReceipt { ...; held?: { messageId: string; since: number; judgedAt?: number } }
export const HELD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function heldReceipts(): DelegationReceipt[];                    // least recently judged first, never judged before judged
export function settleHeldReceipt(id: string, patch: { judgedAt?: number; held?: null; result?: Outbound; copyOf?: EgressOrigin }): void; // saves the file
// recordDelegationReceipt accepts `held` and a `reply` of the held shape; a held receipt is never replaced by a later non-held outcome, never pruned while held
// and younger than HELD_MAX_AGE_MS; _loadPending reads `held` back.

// server/handoff-reply.ts (piece B)
export type OwedReply = { text: string } | { text: string; held: { copyOf: EgressOrigin } } | { line: string; ok: boolean };
export function owedReplyOf(input: { ok; reply; targetName; failureName; stopped; held?: EgressOrigin }): OwedReply;
// appendHandoffReply: a held owed reply writes the row with withheldFromBots: "checking", copyOf, from = the worker, under the stable id.
// FinalizeDelegationWatchPorts.owedReply gains the optional `held` input field (the test passes it through).

// server/held-replies.ts (piece B, new)
export interface HeldReplyPorts {
  store: Pick<Store, "patchMessage" | "messageById" | "botByThread" | "groupByThread" | "bot">;
  release: (receipt: DelegationReceipt) => ReleasedResult;              // index.ts: releaseStoredResult at receipt.copyOf, owner audience
  delivered: (receipt: DelegationReceipt, messageId: string) => void;    // index.ts: markTaskContextExternallyUpdated / markGroupUnread
  complete: (receipt: DelegationReceipt, outcome: "shown" | "withheld" | "stale") => void; // index.ts: completeRoomAsk + afterRoomCompletion when receipt.requestId
}
export function settleHeldReplies(ports: HeldReplyPorts, options?: { limit?: number; now?: number; cooldownMs?: number }): { judged: number; shown: number; withheld: number; checking: number; stale: number; dropped: number };
export function kickHeldReplies(): void;   // debounced sweep; index.ts installs the ports with configureHeldReplies(ports)
export function configureHeldReplies(ports: HeldReplyPorts | undefined): void;

// server/memory/memory-revocation.ts (piece B): export function onRevocationIdle(hook: (() => void) | null): void  (called when the runner has no more work)

// server/frozen-replies.ts (piece C, new)
export interface FrozenReplyPorts {
  store: Store; db: () => DatabaseSync; rows: RowSink;
  ownerThread: (threadId: string) => boolean;                                 // index.ts: isWorkspaceOwner(threadHumanPrincipal(threadId))
  release: (origin: EgressOrigin, worker: string, sourceThreadId: string, fromBotId: string) => ReleasedResult;
  hold: (input: { handoffId: string; sourceThreadId: string; messageId: string; toBotId: string; toBotName: string; copyOf: EgressOrigin }) => void; // index.ts: recordDelegationReceipt held
}
export function restoredReplyId(handoffId: string): string;                  // `dres-<id>-restored`
export function recoverFrozenRepliesSlice(ports: FrozenReplyPorts, options?: { rowsPerSlice?: number; cursorFile?: string }): { more: boolean; scanned: number; restored: number; held: number; left: number };
```

## Piece A: the three-state gate, the door, the tool lines (C1, C2, C6, R1, R10)

Owns: server/result-egress.ts, server/bot-read.ts (storedRowsVerdict, doorEgress), server/memory/replay-lineage.ts (copyOriginVerdict),
server/murage-status.ts (checking key), server/handoff-boundary.ts regions: checkDelegationRoute's receipt switch (via receiptResultShown),
continuationOutcome, askBotRoute (answer.checking: the checking line, mirror with no copyOf), runDeliverCardResult (checking: the room
checking status line under the card's stable line id, no mirror, no summary); server/handoff-replay.ts, server/card-summary.ts,
server/project-notes.ts (checking = left out), server/index.ts resultEgressDeps wiring (copyOriginVerdict, capturedMessageVerdict,
checkingLine) and the external-delivery and replay sites that already render "checking" (no change expected; verify).
Tests: server/result-egress-checking.test.ts (all), existing server/result-egress*.test.ts, server/bot-read.test.ts, server/handoff-r9.test.ts,
server/memory/writetime-readers.test.ts, server/lineage-r3.test.ts.

## Piece B: the hold and the settle (C3, C4, R2 to R5, R9, R11)

Owns: server/delegations.ts (receipt held field, heldReceipts, settleHeldReceipt, prune and replace rules, _loadPending), server/handoff-reply.ts,
server/handoff-boundary.ts regions: runFinalizeDelegationWatch (checking + held: write the row flagged "checking" with copyOf and from, receipt
held, owed reply held, NO completeRoomAsk while held; checking without held: the checking line as the withheld path does today) and
runDeliverSharedResult (same, receipt id = request id); server/held-replies.ts (new), server/memory/memory-revocation.ts (onRevocationIdle),
server/index.ts: configureHeldReplies ports, kick on onRevocationIdle, on cert ready (upgrade-background writetime job), onLineageThreadWarmed,
at listen, and a 30 s unref timer while holds exist; settleCheckingNotes skips rows with copyOf; src/components/ChatView.tsx: the owner's note
under a bot row with withheldFromBots ("Bots will see this reply once earlier memory is checked." / "...it used something you deleted or
changed." / forgotten), same words as GroupView, plus "This check did not finish" after HELD_MAX_AGE_MS by the row's age.
Tests: server/delegation-hold.test.ts (all), existing server/delegations*.test.ts, server/handoff-r9.test.ts, server/room-delegation-wait-api.test.ts,
server/external-context-delivery.test.ts, src/components/ChatView.test.ts.

## Piece C: the boot recovery (C5, R3, R6, R7, R8)

Owns: server/frozen-replies.ts (new), server/index.ts: the boot slice loop after listen (setImmediate chain, rowsPerSlice 200, yields between
slices, once per file by the cursor file `frozen-replies-recovery.json` in DATA_DIR with {rowid, done}), ports wired as the interface says.
Matching (R6): `dres-` ids, no copyOf, 1.0.2 plain rows whose text ends with the fixed line and 1.0.3 rows with kept status replied_to_task
whose reply is the fixed line; plus (S24) `dres-` rows with copyOf flagged "checking" with no receipt -> ports.hold. Provenance (R7): from.botId
is the worker; prompt `dlg-<id>` (pending-delegations-schema.ts delegationTurnKey) stored in one of the worker's conversations; first bot text
row after it carries a turnId; originals = store.turnReplyOriginals(thread, turnId). Destination owner only (ports.ownerThread). Restore (R8):
append `dres-<id>-restored` (role bot, from worker, copyOf, text = `@Name replied to the delegated task:\n\n<words>` through writeBotRow with
status replied_to_task), unread on the owner's bot; checking -> flagged "checking" + ports.hold; withheld/gone/refused/no provenance -> left.
Tests: server/frozen-replies.test.ts (all).

## Integration (Fable)

Merge order A, B, C onto fix/103-reply-withheld; run the three new test files, the lineage shards and the comms e2e on runner 1 or Hetzner;
both typechecks; ONE Astra build review; report with the head sha.
