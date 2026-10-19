// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// REPLY-WITHHELD-CONTRACT C3, C4, R2 to R5, R9, R11 (lanes/release103/REPLY-WITHHELD-CONTRACT.md): a delegated reply the gate reads as
// checking is HELD, never written as withheld: the owner's conversation gets the words flagged "checking" (the owner reads them, bots read
// the checking line), the receipt keeps the hold, and the hold is judged again at the originals until it settles as shown or withheld.
// Cases S1 (the two-researcher repro), S2, S4, S8, S14, S16, S17, S18, S19, S22, S23, S25.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundaryStore } from "./boundary-ports.ts";
import { botRows, botViewer, doorEgress } from "./bot-read.ts";
import { configureBotEgress, RowSink } from "./bot-egress.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { _loadPending, findDelegationReceipt, FINALIZER_WRITES, heldReceipts, onDelegationReceipt, onOwedHandoffReply, recordDelegationReceipt, HELD_MAX_AGE_MS, type DelegationReceipt } from "./delegations.ts";
import { runDeliverSharedResult, runFinalizeDelegationWatch, type FinalizeDelegationWatchPorts } from "./handoff-boundary.ts";
import { handoffReplyId, owedReplyOf, replayOwedReply } from "./handoff-reply.ts";
import { settleHeldReplies, type HeldReplyPorts } from "./held-replies.ts";
import { closeMessageDb } from "./message-db.ts";
import { denyLookup } from "./memory/deny-read.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { addTurnParents, closeTurnLineage, openTurnLineage } from "./memory/lineage-write.ts";
import { drainRevokeMarker, INLINE_REVOCATION } from "./memory/memory-revocation.ts";
import { capturedMessageVerdict, copyOriginVerdict } from "./memory/replay-lineage.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { WritetimeFixture } from "./memory/testing/writetime-fixture.ts";
import { configureStatusRoster, outboundWords, type Outbound } from "./murage-status.ts";
import { configureResultEgress, releaseStoredResult, writetimeLinesShown, type ResultEgressDeps } from "./result-egress.ts";
import { WorkerText } from "./released-text.ts";
import { finishRequestTurn, insertRoomRequest, roomRequest } from "./room-requests.ts";
import { ROOM_REPLY_CHECKING, ROOM_REPLY_WITHHELD } from "./room-context.ts";
import { Store, type BotRecord, type Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const WORDS_A = "RBA cash rate 3.60 percent, last changed 2026-02-18, rba.gov.au (RESEARCHER_A_WORDS)";
const WORDS_B = "Independent check: 3.60 percent since 18 February 2026 (RESEARCHER_B_WORDS)";
const WITHHELD = `[${ROOM_REPLY_WITHHELD}]`;
const CHECKING = `[${ROOM_REPLY_CHECKING}]`;
let inlineMs: number;

beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  inlineMs = INLINE_REVOCATION.ms;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  _loadPending();
});
afterEach(() => {
  INLINE_REVOCATION.ms = inlineMs;
  onOwedHandoffReply(undefined); onDelegationReceipt(undefined);
  configureResultEgress(undefined); configureBotEgress(undefined); configureStatusRoster(undefined);
  closeMessageDb(); closeDatabase(); vi.restoreAllMocks(); vi.useRealTimers();
});

function world() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const leader = store.createBot({ name: "Team Leader", section: "Research" }, { seedMessages: false });
  const a = store.createBot({ name: "Researcher A", section: "Research" }, { seedMessages: false });
  const b = store.createBot({ name: "Researcher B", section: "Research" }, { seedMessages: false });
  const deps: ResultEgressDeps = {
    message: (thread, id) => store.messageById(thread, id), authorize: () => ({ ok: true }),
    copyOriginWithheld: copy => copyOriginVerdict(LineageAllowance.tool(), copy),
    capturedMessageWithheld: (thread, id) => capturedMessageVerdict(LineageAllowance.tool(), thread, id),
    messageSourceForgotten: () => false, messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => true,
    withheldLine: WITHHELD, checkingLine: CHECKING, linesShown: writetimeLinesShown(database), doorShown: doorEgress(database),
  };
  configureResultEgress(deps);
  configureStatusRoster(name => store.bots.some(bot => bot.name === name));
  const finalizing = new Set<string>();
  onOwedHandoffReply(receipt => finalizing.has(receipt.id) ? FINALIZER_WRITES : replayOwedReply(store, receipt));
  const delegationWatch: FinalizeDelegationWatchPorts["delegationWatch"] = new Map();
  const marked = vi.fn<(bot: BotRecord, threadId: string, messageId: string) => void>();
  const completeRoomAsk = vi.fn<FinalizeDelegationWatchPorts["completeRoomAsk"]>(() => undefined);
  const comms = { reply: vi.fn(() => undefined), activity: vi.fn(), clearFinishing: vi.fn(), murageLine: vi.fn() };
  const ports: FinalizeDelegationWatchPorts = {
    comms: comms as never, delegationSource: threadId => threadId === leader.threadId ? { kind: "bot", bot: leader } : null, delegationWatch,
    finalizingDelegations: finalizing, handoffRequestId: () => undefined, markTaskContextExternallyUpdated: marked, completeRoomAsk,
    afterRoomCompletion: () => undefined, owedReply: input => owedReplyOf({ ok: input.ok, reply: input.reply ? outboundWords(input.reply) : "", targetName: input.targetName, failureName: outboundWords(input.failureName), stopped: input.stopped, ...(input.held ? { held: input.held } : {}) }),
    store: boundaryStore(store), rows: new RowSink(store),
  };
  /** A researcher's reply written inside its own turn (its lineage row carries the turn and its parents). */
  const begin = (bot: BotRecord, parents: Parameters<typeof addTurnParents>[1] = []) => {
    const turn = openTurnLineage(database(), { threadId: bot.threadId, turnId: `turn-${bot.id}-${Math.random().toString(36).slice(2)}` });
    if (parents.length) addTurnParents(turn, parents);
    return (text: string) => {
      const message = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text });
      closeTurnLineage(turn);
      return message;
    };
  };
  const reply = (bot: BotRecord, text: string, parents: Parameters<typeof addTurnParents>[1] = []) => begin(bot, parents)(text);
  /** A reply whose turn began before a revoke the owner commits mid-turn (its prompt was built first): the reply is in the revoke's window. */
  const heldReply = (bot: BotRecord, text: string, parents: Parameters<typeof addTurnParents>[1] = []) => {
    const write = begin(bot, parents);
    openPendingWindow();
    return write(text);
  };
  /** The leader's hand-off to `bot` finishing with `message` as its reply (the finalizer, as the turn engine calls it). */
  const finish = (bot: BotRecord, message: Message, taskId: string, extra: Partial<{ requestId: string }> = {}) => {
    delegationWatch.set(bot.threadId, { toBotId: bot.id, toBotName: bot.name, taskId, sourceThreadId: leader.threadId, ...extra });
    return runFinalizeDelegationWatch(ports, bot.threadId, true, { text: new WorkerText(message.text ?? ""), present: true }, undefined, false, { threadId: bot.threadId, messageIds: [message.id] });
  };
  const settlePorts = (): HeldReplyPorts & { delivered: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> } => {
    const delivered = vi.fn(), complete = vi.fn();
    return {
      store, delivered, complete,
      release: receipt => releaseStoredResult({ origin: receipt.copyOf!, ...(receipt.requestId ? { requestId: receipt.requestId } : {}) }, receipt.toBotId, receipt.sourceThreadId,
        { fromBotId: store.botByThread(receipt.sourceThreadId)?.id ?? "" }, receipt.notOwnerAudience === true),
    };
  };
  const row = (taskId: string) => store.messageById(leader.threadId, handoffReplyId(taskId));
  /** What the leader bot reads of its own conversation row through the door. */
  const botReads = (message: Message) => botRows(database(), botViewer(leader.id), leader.threadId, [message], { audience: { owner: true, scopeIds: [] }, ownerOwnChat: true }).map(r => r.text).join("\n");
  const verdictOf = (bot: BotRecord, messageId: string) => denyLookup(database(), { threadId: bot.threadId, lines: [{ messageId, author: "generated" }] }, { audience: { owner: true, scopeIds: [] } }, { ownerOwnChat: true }).get(messageId);
  return { store, leader, a, b, deps, ports, marked, completeRoomAsk, comms, begin, reply, heldReply, finish, settlePorts, row, botReads, verdictOf };
}

/** An install-wide pending window is open while the delegation runs: a revoke committed with a root (a line, a memory record, a receipt) marks
 * every generated line written after it "checking" until the marker has walked it (revoke-commit.ts markPending), and the marker yields to the
 * live turns of the delegation itself. A policy root alone moves only the watermark (revoke-commit.ts, the policy branch) and opens no window. */
function openPendingWindow() {
  INLINE_REVOCATION.ms = 0;
  // the owner regenerated a reply in some other conversation: the revoke opens an install-wide window (every generated line written after it
  // reads "checking") until the marker has walked it, and the marker yields to the live turns of the delegation
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const other = store.bots.find(bot => bot.name === "Elsewhere") ?? store.createBot({ name: "Elsewhere", section: "Other" }, { seedMessages: false });
  const line = store.appendMessage(other.threadId, { role: "bot", kind: "text", text: "an earlier answer the owner regenerated" });
  commitRevoke(database(), { kind: "line", threadId: other.threadId, messageIds: [line.id], cause: "regenerate" });
}

it("S1: a revoke committed while two researchers are mid-turn (their prompts built first); both replies are held, then arrive visible once the check settles", () => {
  const w = world();
  const writeA = w.begin(w.a), writeB = w.begin(w.b);
  openPendingWindow();
  const replyA = writeA(WORDS_A), replyB = writeB(WORDS_B);
  expect(w.verdictOf(w.a, replyA.id)).toEqual({ state: "checking", reason: "pending" });
  expect(w.finish(w.a, replyA, "task-a")).toBe(true);
  expect(w.finish(w.b, replyB, "task-b")).toBe(true);
  for (const [taskId, words, bot, original] of [["task-a", WORDS_A, w.a, replyA], ["task-b", WORDS_B, w.b, replyB]] as const) {
    const held = w.row(taskId)!;
    // the owner reads the words, flagged as still being checked; never the deleted-or-changed line
    expect(held.text).toContain(words);
    expect(held.text).not.toContain(ROOM_REPLY_WITHHELD);
    expect(held.withheldFromBots).toBe("checking");
    expect(held.copyOf).toEqual({ threadId: bot.threadId, messageIds: [original.id] });
    expect(held.from?.botId).toBe(bot.id);
    // a bot reads none of the words
    expect(w.botReads(held)).not.toContain(words);
    const receipt = findDelegationReceipt(taskId)!;
    expect(receipt.status).toBe("done");
    expect(receipt.held?.messageId).toBe(held.id);
    expect(receipt.copyOf).toEqual(held.copyOf);
    expect(receipt.result).not.toContain(ROOM_REPLY_WITHHELD);
  }
  expect(heldReceipts().map(r => r.id).sort()).toEqual(["task-a", "task-b"]);
  // the leader was not told a reply arrived yet: nothing to read but the checking line
  expect(w.marked).not.toHaveBeenCalled();
  // the marker drains the policy revoke: the check settles, both replies are shown and the leader is woken as a reply arrival wakes it
  expect(drainRevokeMarker(database()).pending).toBe(false);
  const settle = w.settlePorts();
  const outcome = settleHeldReplies(settle);
  expect(outcome).toMatchObject({ judged: 2, shown: 2, withheld: 0, checking: 0 });
  for (const [taskId, words] of [["task-a", WORDS_A], ["task-b", WORDS_B]] as const) {
    const shown = w.row(taskId)!;
    expect(shown.withheldFromBots).toBeUndefined();
    expect(shown.text).toContain(words);
    expect(w.botReads(shown)).toContain(words);
    expect(findDelegationReceipt(taskId)!.held).toBeUndefined();
    expect(settle.delivered).toHaveBeenCalledWith(expect.objectContaining({ id: taskId }), shown.id);
  }
  expect(heldReceipts()).toEqual([]);
  // the fresh replies had their lineage rows all along: no-lineage was never the reason
  expect(w.verdictOf(w.a, replyA.id)).toEqual({ state: "shown" });
});

it("S1b: a revoke committed before the worker's prompt is built leaves its reply outside the window: shown at finalize, no hold", () => {
  const w = world();
  // the owner's action lands first (an upgrade's receipt flips, a roster or permission change): its install-wide window is open and the
  // marker has not walked it while the delegation runs
  openPendingWindow();
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id='*'").get()!.n)).toBeGreaterThan(0);
  const replyA = w.reply(w.a, WORDS_A);
  // the reply's turn began after the commit: the revoke's walk never reaches it, and its window does not hold it
  expect(w.verdictOf(w.a, replyA.id)).toEqual({ state: "shown" });
  expect(w.finish(w.a, replyA, "task-a")).toBe(true);
  const row = w.row("task-a")!;
  expect(row.text).toContain(WORDS_A);
  expect(row.withheldFromBots).toBeUndefined();
  expect(w.botReads(row)).toContain(WORDS_A);
  expect(findDelegationReceipt("task-a")!.held).toBeUndefined();
  expect(heldReceipts()).toEqual([]);
});

it("S2: a held reply that really used a line the owner then forgot settles as withheld, with the deleted-or-changed line", () => {
  const w = world();
  const plan = w.store.appendMessage(w.leader.threadId, { role: "user", kind: "text", text: "the owner's private plan" });
  const replyA = w.heldReply(w.a, WORDS_A, [{ kind: "line", threadId: w.leader.threadId, messageId: plan.id }]);
  w.finish(w.a, replyA, "task-a");
  expect(w.row("task-a")!.withheldFromBots).toBe("checking");
  commitRevoke(database(), { kind: "line", threadId: w.leader.threadId, messageIds: [plan.id], cause: "forget" });
  expect(drainRevokeMarker(database()).pending).toBe(false);
  const settle = w.settlePorts();
  expect(settleHeldReplies(settle)).toMatchObject({ judged: 1, withheld: 1 });
  const row = w.row("task-a")!;
  expect(row.withheldFromBots).toBe(true);
  expect(w.botReads(row)).not.toContain(WORDS_A);
  const receipt = findDelegationReceipt("task-a")!;
  expect(receipt.held).toBeUndefined();
  expect(receipt.result).toBe(WITHHELD);
  expect(settle.delivered).not.toHaveBeenCalled();
});

it("S4: during an upgrade's lineage check (certificate not ready) a delegated reply is held, and shown once the certificate is ready", () => {
  const w = world();
  const f = new WritetimeFixture(database());
  const replyA = w.reply(w.a, WORDS_A);
  f.cert(false);
  w.finish(w.a, replyA, "task-a");
  expect(w.row("task-a")!.withheldFromBots).toBe("checking");
  f.cert(true);
  expect(settleHeldReplies(w.settlePorts())).toMatchObject({ shown: 1 });
  expect(w.row("task-a")!.withheldFromBots).toBeUndefined();
});

it("S8: a hold survives a restart: the receipt comes back from disk still held and settles", () => {
  const w = world();
  w.finish(w.a, w.heldReply(w.a, WORDS_A), "task-a");
  expect(heldReceipts()).toHaveLength(1);
  _loadPending(); // the receipts file is read again, as a start reads it
  const reloaded = findDelegationReceipt("task-a")!;
  expect(reloaded.held?.messageId).toBe(handoffReplyId("task-a"));
  expect(heldReceipts()).toHaveLength(1);
  drainRevokeMarker(database());
  expect(settleHeldReplies(w.settlePorts())).toMatchObject({ shown: 1 });
  expect(w.row("task-a")!.withheldFromBots).toBeUndefined();
});

it("S14: a hold that never settles stays held (no words reach a bot) and is settled finally as checking after HELD_MAX_AGE_MS", () => {
  const w = world();
  w.finish(w.a, w.heldReply(w.a, WORDS_A), "task-a");
  const settle = w.settlePorts();
  // every pass while the window stays open: still checking, judged again only after the cooldown
  expect(settleHeldReplies(settle, { now: Date.now() })).toMatchObject({ judged: 1, checking: 1 });
  expect(settleHeldReplies(settle, { now: Date.now() })).toMatchObject({ judged: 0 });
  expect(settleHeldReplies(settle, { now: Date.now() + 31_000 })).toMatchObject({ judged: 1, checking: 1 });
  expect(w.row("task-a")!.withheldFromBots).toBe("checking");
  // a day later with the window still open: the hold ends as checking, the row keeps its flag, the request (if any) completes with the checking line
  const outcome = settleHeldReplies(settle, { now: Date.now() + HELD_MAX_AGE_MS + 1 });
  expect(outcome).toMatchObject({ judged: 1, stale: 1 });
  expect(w.row("task-a")!.withheldFromBots).toBe("checking");
  expect(w.botReads(w.row("task-a")!)).not.toContain(WORDS_A);
  expect(findDelegationReceipt("task-a")!.held).toBeUndefined();
  expect(settle.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "task-a" }), "stale");
  expect(heldReceipts()).toEqual([]);
});

it("C4 for a copy chain whose proof is still being built (Astra delta Medium 6): held, never deleted or changed, and it ends as checking after HELD_MAX_AGE_MS", () => {
  const w = world();
  // the originals rest on a root set the recovery scheduler has not proven yet: the copy-origin check answers unproven
  w.deps.copyOriginWithheld = () => ({ withheld: true, unproven: true });
  w.finish(w.a, w.reply(w.a, WORDS_A), "task-u");
  expect(w.row("task-u")!.withheldFromBots).toBe("checking");
  expect(w.row("task-u")!.text).toContain(WORDS_A); // the owner reads the words with the note
  expect(w.botReads(w.row("task-u")!)).not.toContain(WORDS_A);
  expect(w.botReads(w.row("task-u")!)).not.toContain(WITHHELD);
  expect(findDelegationReceipt("task-u")!.held?.messageId).toBe(w.row("task-u")!.id);
  const settle = w.settlePorts();
  expect(settleHeldReplies(settle, { now: Date.now() })).toMatchObject({ judged: 1, checking: 1 });
  const outcome = settleHeldReplies(settle, { now: Date.now() + HELD_MAX_AGE_MS + 1 });
  expect(outcome).toMatchObject({ judged: 1, stale: 1 });
  expect(w.row("task-u")!.withheldFromBots).toBe("checking");
  expect(w.botReads(w.row("task-u")!)).not.toContain(WORDS_A);
  expect(JSON.stringify(findDelegationReceipt("task-u")!.result)).not.toContain(ROOM_REPLY_WITHHELD);
  expect(heldReceipts()).toEqual([]);
});

it("S16: a receipt that reached disk before the hold's commit replays its owed reply as a held row, never as a shown one", () => {
  const w = world();
  const replyA = w.reply(w.a, WORDS_A);
  const copyOf = { threadId: w.a.threadId, messageIds: [replyA.id] };
  const id = handoffReplyId("task-crash");
  expect(w.store.messageById(w.leader.threadId, id)).toBeUndefined();
  recordDelegationReceipt({ id: "task-crash", sourceThreadId: w.leader.threadId, toBotId: w.a.id, toBotName: w.a.name, status: "done", copyOf, lineage: true,
    held: { messageId: id, since: Date.now() }, reply: { text: WORDS_A, held: { copyOf } } });
  const written = w.store.messageById(w.leader.threadId, id)!;
  expect(written.withheldFromBots).toBe("checking");
  expect(written.copyOf).toEqual(copyOf);
  expect(written.text).toContain(WORDS_A);
  expect(written.from?.botId).toBe(w.a.id);
  expect(findDelegationReceipt("task-crash")!.held?.messageId).toBe(id);
  // a second replay of the same receipt writes nothing twice
  expect(replayOwedReply(w.store, findDelegationReceipt("task-crash")!)?.id).toBe(id);
  expect(w.store.messagesFor(w.leader.threadId).filter(m => m.id === id)).toHaveLength(1);
});

it("S17: a later outcome for the same hand-off (a restart's interrupted receipt, a stop) never replaces a held receipt", () => {
  const w = world();
  w.finish(w.a, w.heldReply(w.a, WORDS_A), "task-a");
  recordDelegationReceipt({ id: "task-a", sourceThreadId: w.leader.threadId, toBotId: w.a.id, toBotName: w.a.name, status: "interrupted" as never, result: "restarted" as unknown as Outbound });
  const kept = findDelegationReceipt("task-a")!;
  expect(kept.status).toBe("done");
  expect(kept.held?.messageId).toBe(handoffReplyId("task-a"));
  expect(w.row("task-a")!.withheldFromBots).toBe("checking");
});

it("S18: the worker's conversation deleted while held: the hold settles as withheld, no words reach a bot", () => {
  const w = world();
  w.finish(w.a, w.heldReply(w.a, WORDS_A), "task-a");
  commitRevoke(database(), { kind: "thread", threadId: w.a.threadId, cause: "delete-conversation" });
  drainRevokeMarker(database());
  expect(settleHeldReplies(w.settlePorts())).toMatchObject({ judged: 1, withheld: 1 });
  const row = w.row("task-a")!;
  expect(row.withheldFromBots).toBe(true);
  expect(w.botReads(row)).not.toContain(WORDS_A);
  expect(findDelegationReceipt("task-a")!.result).toBe(WITHHELD);
});

it("S19: the leader's conversation deleted while held: the hold is dropped with nothing written", () => {
  const w = world();
  w.finish(w.a, w.heldReply(w.a, WORDS_A), "task-a");
  const gone = w.leader.threadId;
  w.store.deleteTask(w.leader.id, gone);
  expect(w.store.botByThread(gone)).toBeFalsy();
  drainRevokeMarker(database());
  const settle = w.settlePorts();
  expect(settleHeldReplies(settle)).toMatchObject({ judged: 1, dropped: 1 });
  expect(findDelegationReceipt("task-a")?.held).toBeUndefined();
  expect(settle.delivered).not.toHaveBeenCalled();
  expect(heldReceipts()).toEqual([]);
});

it("S23: a shared delivery (team queue) holds a checking reply the same way and settles it", () => {
  const w = world();
  const request = insertRoomRequest(database(), {
    groupId: "g", verb: "ask", fromKind: "bot", fromBotId: w.leader.id, toBotId: w.a.id, targetThreadId: w.a.threadId, returnThreadId: w.leader.threadId, admissionKey: "ask:shared-1", now: 1, state: "running",
    lineage: { rootThreadId: w.leader.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
  }).request;
  const replyA = w.heldReply(w.a, WORDS_A);
  finishRequestTurn(database(), request.id, { ok: true, now: 2, resultMessageId: replyA.id });
  const finished = roomRequest(database(), request.id)!;
  expect(finished.state).toBe("done");
  runDeliverSharedResult({ store: boundaryStore(w.store), rows: new RowSink(w.store), comms: w.comms as never }, finished);
  const held = w.store.messagesFor(w.leader.threadId).find(m => m.requestId === request.id)!;
  expect(held.withheldFromBots).toBe("checking");
  expect(held.text).toContain(WORDS_A);
  expect(held.copyOf).toEqual({ threadId: w.a.threadId, messageIds: [replyA.id] });
  expect(w.botReads(held)).not.toContain(WORDS_A);
  const receipt = findDelegationReceipt(request.id)!;
  expect(receipt.held?.messageId).toBe(held.id);
  // the pair room was told the checking line, not the words
  const mirrored = (w.comms.reply.mock.calls as unknown[][]).map(call => outboundWords(call[1] as Outbound));
  expect(mirrored.some(text => text.includes(WORDS_A))).toBe(false);
  expect(receipt.reply).toBeUndefined(); // the row is in the conversation: the receipt owes nothing
  drainRevokeMarker(database());
  expect(settleHeldReplies(w.settlePorts())).toMatchObject({ shown: 1 });
  expect(w.store.messageById(w.leader.threadId, held.id)!.withheldFromBots).toBeUndefined();
  // a hold whose receipt reached disk with its owed reply but whose row never did (R3): the settle writes the held row from the receipt, then judges it
  // (the finalizer's own hook keeps the record from writing it here, as a process that died between the two would have)
  const copyOf = { threadId: w.a.threadId, messageIds: [replyA.id] };
  w.ports.finalizingDelegations.add("shared-lost");
  recordDelegationReceipt({ id: "shared-lost", sourceThreadId: w.leader.threadId, toBotId: w.a.id, toBotName: w.a.name, status: "done", copyOf, lineage: true,
    held: { messageId: handoffReplyId("shared-lost"), since: Date.now() }, reply: { text: WORDS_A, held: { copyOf } } });
  w.ports.finalizingDelegations.delete("shared-lost");
  expect(w.store.messageById(w.leader.threadId, handoffReplyId("shared-lost"))).toBeUndefined();
  const replayed = { ...w.settlePorts(), replay: (receipt: DelegationReceipt) => replayOwedReply(w.store, receipt) };
  expect(settleHeldReplies(replayed)).toMatchObject({ shown: 1, dropped: 0 });
  const written = w.store.messageById(w.leader.threadId, handoffReplyId("shared-lost"))!;
  expect(written.text).toContain(WORDS_A);
  expect(written.withheldFromBots).toBeUndefined();
  expect(findDelegationReceipt("shared-lost")!.reply).toBeUndefined();
});

it("S25: a room hand-off held at finalize completes its request only when the hold settles", () => {
  const w = world();
  const request = insertRoomRequest(database(), {
    groupId: "g", verb: "ask", fromKind: "bot", fromBotId: w.leader.id, toBotId: w.a.id, targetThreadId: w.a.threadId, returnThreadId: w.leader.threadId, admissionKey: "ask:delegation:task-room", now: 1, state: "running",
    lineage: { rootThreadId: w.leader.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
  }).request;
  w.finish(w.a, w.heldReply(w.a, WORDS_A), "task-room", { requestId: request.id });
  expect(w.completeRoomAsk).not.toHaveBeenCalled();
  expect(findDelegationReceipt("task-room")!.requestId).toBe(request.id);
  drainRevokeMarker(database());
  const settle = w.settlePorts();
  expect(settleHeldReplies(settle)).toMatchObject({ shown: 1 });
  // the completion is handed the receipt as it was held, so the request's result row is the held row (R5)
  expect(settle.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "task-room", requestId: request.id, held: expect.objectContaining({ messageId: handoffReplyId("task-room") }) }), "shown");
});

it("S22: the copy of this lane carries no em dash in the files it wrote, and none of the three words the house rules ban", () => {
  const written = ["server/held-replies.ts", "server/frozen-replies.ts", "server/result-egress-checking.test.ts", "server/delegation-hold.test.ts", "server/frozen-replies.test.ts",
    "lanes/release103/REPLY-WITHHELD-CONTRACT.md", "lanes/release103/REPLY-WITHHELD-SPLIT.md"];
  const emDash = String.fromCharCode(0x2014);
  // built from pieces that are not themselves one of the words, so this line passes its own check
  const banned = new RegExp(`\\b(${["un" + "sa" + "fe", "sa" + "fe" + "ty", "sa" + "fe"].join("|")})\\b`, "i");
  const offenders: string[] = [];
  for (const file of written) {
    let text = "";
    try { text = readFileSync(join(process.cwd(), file), "utf8"); } catch { continue; }
    if (text.includes(emDash)) offenders.push(`${file}: em dash`);
    for (const line of text.split("\n")) if (banned.test(line)) offenders.push(`${file}: ${line.trim().slice(0, 80)}`);
  }
  expect(offenders).toEqual([]);
});
