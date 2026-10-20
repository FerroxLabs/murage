// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// REPLY-WITHHELD-CONTRACT C1, C2, C6, R1, R10 (lanes/release103/REPLY-WITHHELD-CONTRACT.md): the result gate tells shown, withheld and
// checking apart. Only a real mark produces "Reply withheld: it used something you deleted or changed"; every unknown (a pending revoke
// window, a thread whose lineage is not ready, a line with no lineage row, an unreadable deny table, an unproven check, an exception on the
// walk) produces the checking line, and nothing of the reply reaches a bot either way. Cases S0, S3, S5, S6, S7, S9, S12, S13, S15, S26.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { doorEgress, storedRowsVerdict, botViewer } from "./bot-read.ts";
import { configureBotEgress } from "./bot-egress.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { receiptResultShown } from "./handoff-boundary.ts";
import { closeMessageDb } from "./message-db.ts";
import { denyLookup } from "./memory/deny-read.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { addTurnParents, closeTurnLineage, openTurnLineage } from "./memory/lineage-write.ts";
import { drainRevokeMarker, INLINE_REVOCATION } from "./memory/memory-revocation.ts";
import { capturedMessageVerdict, copyOriginVerdict } from "./memory/replay-lineage.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { WritetimeFixture } from "./memory/testing/writetime-fixture.ts";
import { configureStatusRoster, outboundWords } from "./murage-status.ts";
import { configureResultEgress, releaseAskReply, releaseStoredResult, writetimeLinesShown, type ResultEgressDeps } from "./result-egress.ts";
import { WorkerText } from "./released-text.ts";
import { ROOM_REPLY_CHECKING, ROOM_REPLY_WITHHELD } from "./room-context.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const WORDS = "RBA cash rate 3.60 percent since 2026-02-18 (DELEGATED_WORDS_77)";
const WITHHELD = `[${ROOM_REPLY_WITHHELD}]`;
const CHECKING = `[${ROOM_REPLY_CHECKING}]`;
let inlineMs: number;

beforeEach(() => {
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  inlineMs = INLINE_REVOCATION.ms;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  INLINE_REVOCATION.ms = inlineMs;
  configureResultEgress(undefined); configureBotEgress(undefined); configureStatusRoster(undefined);
  closeMessageDb(); closeDatabase(); vi.restoreAllMocks();
});

/** The gate as index.ts wires it: the write-time lookup, the door and the verdict-carrying copy and capture checks. */
function world() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const leader = store.createBot({ name: "Leader", section: "Research" }, { seedMessages: false });
  const worker = store.createBot({ name: "Researcher A", section: "Research" }, { seedMessages: false });
  const deps: ResultEgressDeps = {
    message: (thread, id) => store.messageById(thread, id), authorize: () => ({ ok: true }),
    copyOriginWithheld: copy => copyOriginVerdict(LineageAllowance.tool(), copy),
    capturedMessageWithheld: (thread, id) => capturedMessageVerdict(LineageAllowance.tool(), thread, id),
    messageSourceForgotten: () => false, messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => true,
    withheldLine: WITHHELD, checkingLine: CHECKING,
    linesShown: writetimeLinesShown(database), doorShown: doorEgress(database),
  };
  configureResultEgress(deps);
  configureStatusRoster(name => store.bots.some(bot => bot.name === name));
  /** The worker's reply, written inside its own turn, so it has a lineage row like any reply a delegated turn writes. */
  const reply = (text = WORDS, parents: Parameters<typeof addTurnParents>[1] = [], midTurn?: () => void) => {
    const turn = openTurnLineage(database(), { threadId: worker.threadId, turnId: `turn-${Math.random().toString(36).slice(2)}` });
    if (parents.length) addTurnParents(turn, parents);
    midTurn?.();
    const message = store.appendMessage(worker.threadId, { role: "bot", kind: "text", text });
    closeTurnLineage(turn);
    return message;
  };
  const release = (messageId: string, notOwnerAudience = false) => releaseStoredResult({ requestId: "owner-ask", origin: { threadId: worker.threadId, messageIds: [messageId] } },
    worker.id, leader.threadId, { fromBotId: leader.id }, notOwnerAudience, new WorkerText(WORDS), deps);
  const verdictOf = (messageId: string) => denyLookup(database(), { threadId: worker.threadId, lines: [{ messageId, author: "generated" }] }, { audience: { owner: true, scopeIds: [] } }, { ownerOwnChat: true }).get(messageId);
  return { store, leader, worker, deps, reply, release, verdictOf };
}

/** A policy bump with its marker held back, as a fresh install has it while the team it just created is talking. */
function openPendingWindow() {
  INLINE_REVOCATION.ms = 0;
  // the owner regenerated a reply in some other conversation: the revoke opens an install-wide window (every generated line written after it
  // reads "checking") until the marker has walked it, and the marker yields to the live turns of the delegation
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const other = store.bots.find(bot => bot.name === "Elsewhere") ?? store.createBot({ name: "Elsewhere", section: "Other" }, { seedMessages: false });
  const line = store.appendMessage(other.threadId, { role: "bot", kind: "text", text: "an earlier answer the owner regenerated" });
  commitRevoke(database(), { kind: "line", threadId: other.threadId, messageIds: [line.id], cause: "regenerate" });
}

it("S0: a fresh reply with no marks is released with its words and its copy link", () => {
  const { reply, release, worker } = world();
  const message = reply();
  const released = release(message.id);
  expect(released.kind).toBe("text");
  if (released.kind === "text") { expect(outboundWords(released.text)).toBe(WORDS); expect(released.copyOf).toEqual({ threadId: worker.threadId, messageIds: [message.id] }); }
});

it("S1 at the gate: a reply written inside a pending revoke window reads checking, with the words held for the owner, never withheld", () => {
  const { reply, release, verdictOf, worker } = world();
  // the owner's action lands while the worker's turn runs (its prompt was built first): the reply is in the revoke's window
  const message = reply(WORDS, [], openPendingWindow);
  expect(verdictOf(message.id)).toEqual({ state: "checking", reason: "pending" });
  const released = release(message.id);
  expect(released.kind).toBe("checking");
  if (released.kind === "checking") {
    expect(outboundWords(released.line)).toBe(CHECKING);
    expect(released.held && outboundWords(released.held.text)).toBe(WORDS);
    expect(released.held?.copyOf).toEqual({ threadId: worker.threadId, messageIds: [message.id] });
  }
  drainRevokeMarker(database());
  expect(verdictOf(message.id)).toEqual({ state: "shown" });
  expect(release(message.id).kind).toBe("text");
});

it("S3: a reply whose source the owner forgot is withheld at once, with the deleted-or-changed line", () => {
  const { store, leader, reply, release } = world();
  const source = store.appendMessage(leader.threadId, { role: "user", kind: "text", text: "my private plan" });
  const message = reply(WORDS, [{ kind: "line", threadId: leader.threadId, messageId: source.id }]);
  expect(release(message.id).kind).toBe("text");
  commitRevoke(database(), { kind: "line", threadId: leader.threadId, messageIds: [source.id], cause: "forget" });
  expect(drainRevokeMarker(database()).pending).toBe(false);
  const released = release(message.id);
  expect(released.kind).toBe("withheld");
  if (released.kind === "withheld") expect(outboundWords(released.line)).toBe(WITHHELD);
});

it("S4 at the gate: a reply judged while the lineage certificate is not ready reads checking, and shown once it is", () => {
  const { reply, release } = world();
  const message = reply();
  const f = new WritetimeFixture(database());
  f.cert(false);
  const held = release(message.id);
  expect(held.kind).toBe("checking");
  f.cert(true);
  expect(release(message.id).kind).toBe("text");
});

it("S5: a generated row with no lineage row reads checking (never deleted-or-changed)", () => {
  const { reply, release } = world();
  reply(); // an earlier reply keeps line lineage live on this file
  const message = reply();
  // a line write whose lineage savepoint failed leaves the message with no row (lineage-write.ts lineageRow: "a write that fails leaves no row")
  expect(database().prepare("DELETE FROM memory_line_lineage WHERE message_id=?").run(message.id).changes).toBe(1);
  const released = release(message.id);
  expect(released.kind).toBe("checking");
  if (released.kind === "checking") expect(outboundWords(released.line)).toBe(CHECKING);
});

it("S6: a not-owner audience gets the checking line and no words to hold", () => {
  const { reply, release } = world();
  // the owner's action lands while the worker's turn runs (its prompt was built first): the reply is in the revoke's window
  const message = reply(WORDS, [], openPendingWindow);
  const released = release(message.id, true);
  expect(released.kind).toBe("checking");
  if (released.kind === "checking") { expect(released.held).toBeUndefined(); expect(outboundWords(released.line)).toBe(CHECKING); }
});

it("S7: a deny table the lookup cannot read makes the reply checking, not withheld", () => {
  const { reply, release } = world();
  const message = reply();
  database().exec("ALTER TABLE memory_deny_pending RENAME TO memory_deny_pending_gone");
  try {
    const released = release(message.id);
    expect(released.kind).toBe("checking");
  } finally { database().exec("ALTER TABLE memory_deny_pending_gone RENAME TO memory_deny_pending"); }
});

it("S9: wait_delegation and check_delegation answer a checking result with the no-answer line (never held, NOHOLD-DELEGATION.md), never withheld", () => {
  const { reply, release } = world();
  // the owner's action lands while the worker's turn runs (its prompt was built first): the reply is in the revoke's window
  const message = reply(WORDS, [], openPendingWindow);
  const released = release(message.id);
  const shown = receiptResultShown(released, { copyOf: { threadId: "t", messageIds: [message.id] } });
  expect(shown.reason).toBeUndefined();
  expect(outboundWords(shown.result)).toBe("(no answer: that memory is still being checked, try again later)");
  expect(outboundWords(shown.result)).not.toContain(WORDS);
  drainRevokeMarker(database());
  expect(outboundWords(receiptResultShown(release(message.id), {}).result)).toBe(WORDS);
});

it("S12: a walked row left flagged withheldFromBots \"checking\" on disk is judged live (no note, R2): shown when clean; one flagged true reads withheld", () => {
  const { store, worker, reply, release } = world();
  const message = reply();
  store.patchMessage(worker.threadId, message.id, { withheldFromBots: "checking" });
  expect(release(message.id).kind).toBe("text");
  store.patchMessage(worker.threadId, message.id, { withheldFromBots: true });
  expect(release(message.id).kind).toBe("withheld");
});

it("S13: the reader door answers the three states: shown, checking under a pending window, withheld on a mark", () => {
  const { leader, worker, reply } = world();
  const message = reply();
  const door = doorEgress(database);
  expect(door(leader.id, worker.threadId, [message.id], false)).toBe("shown");
  expect(storedRowsVerdict(database(), botViewer(leader.id), worker.threadId, [message.id], { audience: { owner: true, scopeIds: [] }, ownerOwnChat: true })).toBe("shown");
  // the owner's action lands while the worker's turn runs (its prompt was built first): the reply is in the revoke's window
  const later = reply(WORDS, [], openPendingWindow);
  expect(door(leader.id, worker.threadId, [later.id], false)).toBe("checking");
  // a real mark (the reply itself revoked, say regenerated) reads withheld once the marker has walked it; the owner's note alone is never the door's judge (rule 15b)
  commitRevoke(database(), { kind: "line", threadId: worker.threadId, messageIds: [message.id], cause: "regenerate" });
  drainRevokeMarker(database());
  expect(door(leader.id, worker.threadId, [message.id], false)).toBe("withheld");
});

it("S15: an ask inside a live turn gets the checking line for a checking reply, never withheld", () => {
  const { leader, worker, reply, deps } = world();
  // the owner's action lands while the worker's turn runs (its prompt was built first): the reply is in the revoke's window
  const message = reply(WORDS, [], openPendingWindow);
  const answer = releaseAskReply({ requestId: "owner-ask", origin: { threadId: worker.threadId, messageIds: [message.id] } }, worker.id, leader.threadId, { fromBotId: leader.id }, false, new WorkerText(WORDS), deps);
  expect(answer).toMatchObject({ ok: true, withheld: true, checking: true });
  if (answer.ok) expect(outboundWords(answer.text)).toBe(CHECKING);
});

it("S26: an exception inside the walk reads checking; a copy that cycles back to itself reads withheld", () => {
  const { store, leader, worker, reply, deps } = world();
  const message = reply();
  const throwing: ResultEgressDeps = { ...deps, capturedMessageWithheld: () => { throw new Error("lookup failed"); } };
  const errored = releaseStoredResult({ requestId: "owner-ask", origin: { threadId: worker.threadId, messageIds: [message.id] } }, worker.id, leader.threadId, { fromBotId: leader.id }, false, new WorkerText(WORDS), throwing);
  expect(errored.kind).toBe("checking");
  // a read that throws inside the walk itself is an unknown too, and the owner's own conversation still keeps the words (C3)
  const unreadable: ResultEgressDeps = { ...deps, message: () => { throw new Error("read failed"); } };
  const walkFailed = releaseStoredResult({ requestId: "owner-ask", origin: { threadId: worker.threadId, messageIds: [message.id] } }, worker.id, leader.threadId, { fromBotId: leader.id }, false, new WorkerText(WORDS), unreadable);
  expect(walkFailed.kind).toBe("checking");
  expect(walkFailed.kind === "checking" && walkFailed.held ? outboundWords(walkFailed.held.text) : "").toContain(WORDS);
  const copy = store.appendMessage(leader.threadId, { role: "bot", kind: "text", text: WORDS, copyOf: { threadId: worker.threadId, messageIds: [message.id] } });
  store.patchMessage(worker.threadId, message.id, { copyOf: { threadId: leader.threadId, messageIds: [copy.id] } });
  const cycled = releaseStoredResult({ requestId: "owner-ask", origin: { threadId: leader.threadId, messageIds: [copy.id] } }, worker.id, leader.threadId, { fromBotId: leader.id }, false, new WorkerText(WORDS), deps);
  expect(cycled.kind).toBe("withheld");
});
