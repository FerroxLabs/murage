// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// REPLY-WITHHELD-CONTRACT C5, R3, R6, R7, R8 (lanes/release103/REPLY-WITHHELD-CONTRACT.md): replies that 1.0.2 and earlier 1.0.3 builds froze
// as "Reply withheld: it used something you deleted or changed" are found at boot, their worker's words proven through the hand-off's own
// prompt row and turn, judged again through the gate, and restored beside the frozen row (the frozen Murage row stays classified). Bounded
// slices with a cursor, idempotent, never into a conversation that is not the owner's. Cases S10, S11, S20, S21, S24.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RowSink, configureBotEgress } from "./bot-egress.ts";
import { doorEgress } from "./bot-read.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { _loadPending, findDelegationReceipt, heldReceipts } from "./delegations.ts";
import { recoverFrozenRepliesSlice, restoredReplyId, type FrozenReplyPorts } from "./frozen-replies.ts";
import { retireHeldRow, type HeldRetirePorts, type RetiredHold } from "./held-replies.ts";
import { handoffReplyId } from "./handoff-reply.ts";
import { humanTask, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, threadHumanPrincipal, isWorkspaceOwner } from "./human-principals.ts";
import { closeMessageDb } from "./message-db.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { addTurnParents, closeTurnLineage, openTurnLineage } from "./memory/lineage-write.ts";
import { drainRevokeMarker, INLINE_REVOCATION } from "./memory/memory-revocation.ts";
import { capturedMessageVerdict, copyOriginVerdict } from "./memory/replay-lineage.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { murageLine } from "./murage-line.ts";
import { configureStatusRoster } from "./murage-status.ts";
import { delegationTurnKey } from "./pending-delegations-schema.ts";
import { configureResultEgress, releaseStoredResult, writetimeLinesShown, type ResultEgressDeps } from "./result-egress.ts";
import { ROOM_REPLY_WITHHELD } from "./room-context.ts";
import { Store, type BotRecord, type Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const WORDS = "RBA cash rate 3.60 percent, last changed 2026-02-18 (FROZEN_WORKER_WORDS)";
const FROZEN = `[${ROOM_REPLY_WITHHELD}]`;
const NO_ANSWER = "(no answer: that memory is still being checked, try again later)";
let inlineMs: number;

beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  inlineMs = INLINE_REVOCATION.ms;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  _loadPending();
});
afterEach(() => {
  INLINE_REVOCATION.ms = inlineMs;
  configureResultEgress(undefined); configureBotEgress(undefined); configureStatusRoster(undefined);
  closeMessageDb(); closeDatabase(); vi.restoreAllMocks();
});

function world() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const leader = store.createBot({ name: "Team Leader", section: "Research" }, { seedMessages: false });
  const a = store.createBot({ name: "Researcher A", section: "Research" }, { seedMessages: false });
  const deps: ResultEgressDeps = {
    message: (thread, id) => store.messageById(thread, id), authorize: () => ({ ok: true }),
    copyOriginWithheld: copy => copyOriginVerdict(LineageAllowance.tool(), copy),
    capturedMessageWithheld: (thread, id) => capturedMessageVerdict(LineageAllowance.tool(), thread, id),
    messageSourceForgotten: () => false, messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => true,
    withheldLine: FROZEN, checkingLine: "[checking]", linesShown: writetimeLinesShown(database), doorShown: doorEgress(database),
  };
  configureResultEgress(deps);
  configureStatusRoster(name => store.bots.some(bot => bot.name === name));
  const restored = vi.fn();
  /** The retirement as index.ts wires it: the row rewritten as the no-answer row, then the completion (recorded here). */
  const completed: Array<[string, string | undefined]> = [];
  const retirePorts: HeldRetirePorts = { store, complete: (hold, messageId) => { completed.push([hold.id, messageId]); } };
  const retire = vi.fn((hold: RetiredHold, messageId: string) => { retirePorts.complete(hold, retireHeldRow(retirePorts, hold, messageId)); });
  const ports: FrozenReplyPorts = {
    store, db: database, rows: new RowSink(store), retire, restored,
    ownerThread: threadId => isWorkspaceOwner(threadHumanPrincipal(threadId)),
    release: (origin, worker, sourceThreadId, fromBotId, requestId, text) => releaseStoredResult({ origin, ...(requestId ? { requestId } : {}) }, worker, sourceThreadId, { fromBotId }, false, text),
  };
  const cursorFile = join(DATA_DIR, "frozen-replies-recovery.json");
  const recoverAll = (rowsPerSlice = 100) => {
    const totals = { slices: 0, scanned: 0, restored: 0, retired: 0, left: 0 };
    for (let i = 0; i < 10_000; i++) {
      const step = recoverFrozenRepliesSlice(ports, { rowsPerSlice, cursorFile });
      totals.slices++; totals.scanned += step.scanned; totals.restored += step.restored; totals.retired += step.retired; totals.left += step.left;
      if (!step.more) break;
    }
    return totals;
  };
  /** The hand-off's prompt row dlg-<id>, written as the dispatcher writes it: only in the transaction that starts its queue row (handoff-stamp.ts).
   * The queue row is removed afterwards, as a finished hand-off's is. */
  const promptRow = (bot: BotRecord, handoffId: string, sourceThreadId: string, text: string) => {
    const db = database();
    db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, turn_key) VALUES(?,?,?,?,?,?,?,?)")
      .run(handoffId, sourceThreadId, bot.id, leader.id, "fresh", null, JSON.stringify({ message: text, depth: 0, attempts: 0 }), delegationTurnKey(handoffId));
    const prompt = store.appendMessage(bot.threadId, { role: "user", kind: "text", text, handoffFrom: sourceThreadId }, delegationTurnKey(handoffId),
      () => { db.prepare("UPDATE pending_delegations SET phase='started' WHERE id=?").run(handoffId); });
    db.prepare("DELETE FROM pending_delegations WHERE id=?").run(handoffId);
    return prompt;
  };
  /** The worker's hand-off turn as a 1.0.2 build stored it: the prompt row dlg-<id> with its hand-off link, then the turn's own reply. */
  const workerTurn = (bot: BotRecord, handoffId: string, sourceThreadId: string, words = WORDS, midTurn?: () => void) => {
    const prompt = promptRow(bot, handoffId, sourceThreadId, "What is the RBA cash rate?");
    const turnId = `turn-${handoffId}`;
    const turn = openTurnLineage(database(), { threadId: bot.threadId, turnId });
    midTurn?.();
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: words, turnId });
    closeTurnLineage(turn);
    return { prompt, reply };
  };
  /** The frozen row a 1.0.3 finalizer wrote (Murage's kept status) or a 1.0.2 one (plain words), with no copy link. */
  const frozenRow = (threadId: string, bot: BotRecord, handoffId: string, shape: "status" | "plain") => {
    const text = `@${bot.name} replied to the delegated task:\n\n${FROZEN}`;
    const base: Omit<Message, "id" | "at"> = { role: "bot", kind: "text", text, inboundKind: "action", from: { botId: bot.id, name: bot.name, color: bot.color } };
    const row = shape === "status" ? murageLine({ ...base, murage: { kind: "status", status: { key: "replied_to_task", data: { name: bot.name, reply: FROZEN } } } } as never) : base;
    return store.appendMessage(threadId, row, handoffReplyId(handoffId));
  };
  return { store, leader, a, deps, ports, retire, completed, restored, recoverAll, promptRow, workerTurn, frozenRow, cursorFile };
}

it("S10: a frozen reply whose worker turn is still stored comes back beside the frozen row, with its words and copy link, in both row shapes", () => {
  const w = world();
  for (const [handoffId, shape] of [["h-status", "status"], ["h-plain", "plain"]] as const) {
    w.workerTurn(w.a, handoffId, w.leader.threadId);
    w.frozenRow(w.leader.threadId, w.a, handoffId, shape);
  }
  const totals = w.recoverAll();
  expect(totals).toMatchObject({ restored: 2, retired: 0, left: 0 });
  for (const handoffId of ["h-status", "h-plain"]) {
    const frozen = w.store.messageById(w.leader.threadId, handoffReplyId(handoffId))!;
    expect(frozen.text).toContain(FROZEN); // the frozen row stays as it was (classification is sticky)
    const restored = w.store.messageById(w.leader.threadId, restoredReplyId(handoffId))!;
    expect(restored.role).toBe("bot");
    expect(restored.from?.botId).toBe(w.a.id);
    expect(restored.text).toContain(WORDS);
    expect(restored.text).not.toContain(ROOM_REPLY_WITHHELD);
    expect(restored.copyOf?.threadId).toBe(w.a.threadId);
    expect(restored.withheldFromBots).toBeUndefined();
    expect(restored.at).toBeGreaterThanOrEqual(frozen.at);
    // the receipt follows (C5): the hand-off's receipt gets the words and the copy link back
    expect(w.restored).toHaveBeenCalledWith(handoffId, expect.objectContaining({ copyOf: expect.objectContaining({ threadId: w.a.threadId }) }));
  }
  expect(w.store.bot(w.leader.id)!.unread).toBe(true);
  // run again: nothing restored twice
  expect(w.recoverAll()).toMatchObject({ restored: 0, retired: 0 });
  expect(w.store.messagesFor(w.leader.threadId).filter(m => m.id === restoredReplyId("h-status"))).toHaveLength(1);
});

it("S11: a frozen reply whose worker conversation is gone, or whose provenance cannot be proven, is left as it is and counted", () => {
  const w = world();
  // the worker's prompt row is not stored (its conversation was deleted): no provenance
  w.frozenRow(w.leader.threadId, w.a, "h-gone", "status");
  // the prompt is stored but the reply after it carries no turn id: ambiguous, left alone
  w.promptRow(w.a, "h-noturn", w.leader.threadId, "task");
  w.store.appendMessage(w.a.threadId, { role: "bot", kind: "text", text: "unrelated later output" });
  w.frozenRow(w.leader.threadId, w.a, "h-noturn", "plain");
  expect(w.recoverAll()).toMatchObject({ restored: 0, retired: 0, left: 2 });
  expect(w.store.messageById(w.leader.threadId, restoredReplyId("h-gone"))).toBeUndefined();
  expect(w.store.messageById(w.leader.threadId, restoredReplyId("h-noturn"))).toBeUndefined();
  expect(w.store.messagesFor(w.leader.threadId).some(m => m.text?.includes("unrelated later output"))).toBe(false);
});

it("S10b: a frozen reply whose originals now read withheld stays frozen; one that reads checking waits (nothing held, no words written) and is restored once the check finishes", () => {
  const w = world();
  const plan = w.store.appendMessage(w.leader.threadId, { role: "user", kind: "text", text: "private plan" });
  const turn = openTurnLineage(database(), { threadId: w.a.threadId, turnId: "turn-h-withheld" });
  w.promptRow(w.a, "h-withheld", w.leader.threadId, "task");
  addTurnParents(turn, [{ kind: "line", threadId: w.leader.threadId, messageId: plan.id }]);
  w.store.appendMessage(w.a.threadId, { role: "bot", kind: "text", text: WORDS, turnId: "turn-h-withheld" });
  closeTurnLineage(turn);
  w.frozenRow(w.leader.threadId, w.a, "h-withheld", "status");
  commitRevoke(database(), { kind: "line", threadId: w.leader.threadId, messageIds: [plan.id], cause: "forget" });
  drainRevokeMarker(database());
  // and one inside a pending window: the owner regenerates a reply elsewhere while the worker's turn runs (its prompt was built first)
  INLINE_REVOCATION.ms = 0;
  const other = w.store.createBot({ name: "Elsewhere", section: "Other" }, { seedMessages: false });
  const elsewhere = w.store.appendMessage(other.threadId, { role: "bot", kind: "text", text: "an earlier answer the owner regenerated" });
  w.workerTurn(w.a, "h-pending", w.leader.threadId, WORDS, () => { commitRevoke(database(), { kind: "line", threadId: other.threadId, messageIds: [elsewhere.id], cause: "regenerate" }); });
  w.frozenRow(w.leader.threadId, w.a, "h-pending", "status");
  // the withheld one is judged (left as the proper withheld line); the checking one stops the scan before it: nothing held, no words written
  const first = w.recoverAll();
  expect(first).toMatchObject({ restored: 0, retired: 0, left: 1 });
  expect(recoverFrozenRepliesSlice(w.ports, { cursorFile: w.cursorFile }).waiting).toBe(true);
  expect(w.store.messageById(w.leader.threadId, restoredReplyId("h-withheld"))).toBeUndefined();
  expect(w.store.messageById(w.leader.threadId, restoredReplyId("h-pending"))).toBeUndefined();
  expect(findDelegationReceipt("h-pending")).toBeNull();
  expect(heldReceipts()).toEqual([]);
  expect(w.store.messagesFor(w.leader.threadId).some(m => (m.text ?? "").includes("FROZEN_WORKER_WORDS"))).toBe(false);
  // frozen retry: once the check finishes, the next run restores the owner's reply with its words; it never stays stuck as the frozen line
  expect(drainRevokeMarker(database()).pending).toBe(false);
  expect(w.recoverAll()).toMatchObject({ restored: 1, retired: 0 });
  const restored = w.store.messageById(w.leader.threadId, restoredReplyId("h-pending"))!;
  expect(restored.text).toContain(WORDS);
  expect(restored.withheldFromBots).toBeUndefined();
  expect(w.store.messageById(w.leader.threadId, restoredReplyId("h-withheld"))).toBeUndefined();
  // a run after that finds nothing more to do
  rmSync(w.cursorFile, { force: true });
  expect(w.recoverAll()).toMatchObject({ restored: 0, retired: 0 });
});

it("S20: recovery over many frozen rows runs in bounded slices behind a cursor, and a second full run touches nothing", () => {
  const w = world();
  const total = 120;
  for (let i = 0; i < total; i++) {
    w.workerTurn(w.a, `h-${i}`, w.leader.threadId, `${WORDS} #${i}`);
    w.frozenRow(w.leader.threadId, w.a, `h-${i}`, i % 2 ? "status" : "plain");
  }
  const first = recoverFrozenRepliesSlice(w.ports, { rowsPerSlice: 25, cursorFile: w.cursorFile });
  expect(first.more).toBe(true);
  expect(first.scanned).toBeLessThanOrEqual(25);
  expect(existsSync(w.cursorFile)).toBe(true);
  const totals = w.recoverAll(25);
  expect(totals.restored + first.restored).toBe(total);
  expect(totals.slices).toBeGreaterThan(1);
  expect(w.recoverAll(25)).toMatchObject({ restored: 0, retired: 0, left: 0 });
  expect(w.store.messagesFor(w.leader.threadId).filter(m => m.id.endsWith("-restored"))).toHaveLength(total);
});

it("S21: a frozen reply in a conversation that is not the owner's is never restored", () => {
  const w = world();
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "TEAM", userId: "CONTACT" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  const person = resolveHumanBinding(binding);
  const personThread = humanTask(w.store, w.leader.id, person)!.threadId;
  expect(isWorkspaceOwner(threadHumanPrincipal(personThread))).toBe(false);
  w.workerTurn(w.a, "h-person", personThread);
  w.frozenRow(personThread, w.a, "h-person", "status");
  expect(w.recoverAll()).toMatchObject({ restored: 0, retired: 0, left: 1 });
  expect(w.store.messageById(personThread, restoredReplyId("h-person"))).toBeUndefined();
  expect(w.store.messagesFor(personThread).some(m => m.text?.includes("FROZEN_WORKER_WORDS"))).toBe(false);
});

it("S24: an earlier build's held row with no receipt is retired by the boot recovery: rewritten as the no-answer row, its asker completed once", () => {
  const w = world();
  const { reply } = w.workerTurn(w.a, "h-held", w.leader.threadId);
  const copyOf = { threadId: w.a.threadId, messageIds: [reply.id] };
  const row = w.store.appendMessage(w.leader.threadId, { role: "bot", kind: "text", text: `@${w.a.name} replied to the delegated task:\n\n${WORDS}`, inboundKind: "action",
    from: { botId: w.a.id, name: w.a.name, color: w.a.color }, copyOf, withheldFromBots: "checking" }, handoffReplyId("h-held"));
  expect(findDelegationReceipt("h-held")).toBeNull();
  expect(w.recoverAll()).toMatchObject({ restored: 0, retired: 1 });
  const retired = w.store.messageById(w.leader.threadId, row.id)!;
  expect(retired.text).toBe(NO_ANSWER);
  expect(retired.copyOf).toBeUndefined();
  expect(retired.withheldFromBots).toBeUndefined();
  expect(w.completed).toEqual([["h-held", row.id]]);
  expect(heldReceipts()).toEqual([]);
  // a reply an earlier recovery restored held, whose receipt was lost since: retired the same way under the restored row
  w.frozenRow(w.leader.threadId, w.a, "h-lost-receipt", "status");
  const { reply: reply2 } = w.workerTurn(w.a, "h-lost-receipt", w.leader.threadId);
  const copyOf2 = { threadId: w.a.threadId, messageIds: [reply2.id] };
  const restoredRow = w.store.appendMessage(w.leader.threadId, { role: "bot", kind: "text", text: `@${w.a.name} replied to the delegated task:\n\n${WORDS}`, inboundKind: "action",
    from: { botId: w.a.id, name: w.a.name, color: w.a.color }, copyOf: copyOf2, withheldFromBots: "checking" }, restoredReplyId("h-lost-receipt"));
  expect(w.recoverAll()).toMatchObject({ restored: 0, retired: 1 });
  expect(w.store.messageById(w.leader.threadId, restoredRow.id)!.text).toBe(NO_ANSWER);
  expect(w.completed).toEqual([["h-held", row.id], ["h-lost-receipt", restoredRow.id]]);
  expect(w.store.messagesFor(w.leader.threadId).some(m => (m.text ?? "").includes("FROZEN_WORKER_WORDS"))).toBe(false);
});
