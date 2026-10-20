// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// No holds on hand-offs (lanes/release103/NOHOLD-DELEGATION.md): a delegation result the gate reads as checking is never held. The asking
// bot's final answer is the no-answer line; the request completes and the asker is woken exactly once through the normal path, and the
// worker's words reach no receipt, replay record, frozen row, wake payload or routine answer record. One test per path the earlier Astra
// reports showed (replay, frozen retry, dropped hold, poll while checking, expired, nested continuation, failed wake save, shared hand-off
// from a direct chat), a scan of every store, and the clean path.
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundaryStore } from "./boundary-ports.ts";
import { botRows, botViewer, doorEgress } from "./bot-read.ts";
import { configureBotEgress, RowSink } from "./bot-egress.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { AskerWakes, type AskerWakeIntent, type AskerWakeSnapshot } from "./asker-wake.ts";
import { _loadPending, findDelegationReceipt, FINALIZER_WRITES, heldReceipts, onDelegationReceipt, onOwedHandoffReply, recordDelegationReceipt, HELD_MAX_AGE_MS } from "./delegations.ts";
import { decodeHandoffReceipt, noAnswerReceipt } from "./event-limit.ts";
import { formatHandoff } from "./handoff-outcome.ts";
import { storedAnswerText } from "./handoff-replay.ts";
import { askBotRoute, checkDelegationRoute, continuationOutcome, delegateBotRoute, runDeliverSharedResult, sharedResultReturned, runFinalizeDelegationWatch, type AskerWakePort, type CheckDelegationRouteContext, type FinalizeDelegationWatchPorts } from "./handoff-boundary.ts";
import { handoffReplyId, owedReplyOf, replayOwedReply } from "./handoff-reply.ts";
import { retireHeldReplies, type HeldRetirePorts, type RetiredHold } from "./held-replies.ts";
import { closeMessageDb } from "./message-db.ts";
import { denyLookup } from "./memory/deny-read.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { addTurnParents, closeTurnLineage, openTurnLineage } from "./memory/lineage-write.ts";
import { drainRevokeMarker, INLINE_REVOCATION } from "./memory/memory-revocation.ts";
import { capturedMessageVerdict, copyOriginVerdict } from "./memory/replay-lineage.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { botName, configureStatusRoster, outboundWords, status, type Outbound } from "./murage-status.ts";
import { configureResultEgress, writetimeLinesShown, type ResultEgressDeps } from "./result-egress.ts";
import { WorkerText } from "./released-text.ts";
import { released } from "./testing/released.ts";
import { finishRequestTurn, insertRoomRequest, roomRequest, type RoomRequest } from "./room-requests.ts";
import { ROOM_REPLY_CHECKING, ROOM_REPLY_WITHHELD } from "./room-context.ts";
import { Store, type BotRecord, type Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

/** The peer edge's authorization (host-words.ts) is let through only while a route test below runs; every other test sees the real one. */
const allowPeers = vi.hoisted(() => ({ on: false }));
vi.mock("./host-words.ts", async (original) => {
  const real = await original<typeof import("./host-words.ts")>();
  return { ...real, authorizeStatus: (...args: Parameters<typeof real.authorizeStatus>) => allowPeers.on ? { ok: true } as never : real.authorizeStatus(...args) };
});

const WORDS_A = "RBA cash rate 3.60 percent, last changed 2026-02-18, rba.gov.au (RESEARCHER_A_WORDS)";
const WORDS_B = "Independent check: 3.60 percent since 18 February 2026 (RESEARCHER_B_WORDS)";
const WITHHELD = `[${ROOM_REPLY_WITHHELD}]`;
const CHECKING = `[${ROOM_REPLY_CHECKING}]`;
const NO_ANSWER = "(no answer: that memory is still being checked, try again later)";
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
    afterRoomCompletion: () => undefined, owedReply: input => owedReplyOf({ ok: input.ok, reply: input.reply ? outboundWords(input.reply) : "", targetName: input.targetName, failureName: outboundWords(input.failureName), stopped: input.stopped }),
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
  /** The asker wakes as index.ts wires them (askerWakePort): a returned result is delivered to the task's registered intent, once. */
  const saved = new Map<string, AskerWakeSnapshot>();
  let failWrites = false;
  const wakes = new AskerWakes((_bot, threadId, snapshot) => { if (failWrites) throw new Error("disk full"); if (snapshot) saved.set(threadId, JSON.parse(JSON.stringify(snapshot))); else saved.delete(threadId); });
  const wakeCalls: string[] = [];
  const askerWake: AskerWakePort = {
    register: (taskId, asker) => wakes.register(taskId, asker as AskerWakeIntent),
    consume: taskId => wakes.consume(taskId),
    returned: (taskId, threadId, result) => { if (wakes.deliver(taskId, result)) wakeCalls.push(`${taskId}:${result.messageId}`); return wakes.durable(threadId); },
  };
  ports.askerWake = askerWake;
  const asked = (taskId: string) => askerWake.register(taskId, { botId: leader.id, threadId: leader.threadId, depth: 0, notOwnerAudience: false, unattended: false });
  /** The retirement's ports as index.ts wires them: a direct asker is woken once at the row, a room request is completed (recorded here). */
  const retirePorts = (): HeldRetirePorts & { completed: Array<[string, string | undefined]> } => {
    const completed: Array<[string, string | undefined]> = [];
    return { store, completed, complete: (hold: RetiredHold, messageId) => {
      completed.push([hold.id, messageId]);
      if (!hold.requestId && messageId) askerWake.returned(hold.id, hold.sourceThreadId, { toBotId: hold.toBotId, toBotName: hold.toBotName, ok: true, messageId });
    } };
  };
  /** check_delegation / wait_delegation as the leader calls it: the body it is sent. */
  const check = async (taskId: string) => {
    const sent: Array<{ status: number; body: { status?: string; result?: string } }> = [];
    configureBotEgress((_res, code, body) => { sent.push({ status: code, body: body as never }); });
    await checkDelegationRoute({
      askerWake, connectorThread: () => ({ bot: leader, group: undefined }), delegationMatch: ["", taskId] as unknown as RegExpMatchArray,
      internalClaim: { botId: leader.id, threadId: leader.threadId, generation: "g", depth: 0, kind: "handoff", skillAuthoring: false, expiresAt: Date.now() + 60_000 },
      requireActiveInternal: () => undefined, res: {} as never, resultEgressDeps: deps, store: boundaryStore(store),
      taskResolutionDeps: { receipt: (id: string) => findDelegationReceipt(id), pending: () => null, request: () => null, requestSourceThread: () => null, delivered: "delivered", watches: () => [] },
      url: new URL(`http://127.0.0.1/api/internal/delegations/${taskId}?fromBotId=${leader.id}&fromThreadId=${leader.threadId}&wait_ms=0`),
    } as unknown as CheckDelegationRouteContext);
    configureBotEgress(undefined);
    expect(sent).toHaveLength(1);
    return sent[0].body;
  };
  const row = (taskId: string) => store.messageById(leader.threadId, handoffReplyId(taskId));
  /** What the leader bot reads of its own conversation row through the door. */
  const botReads = (message: Message) => botRows(database(), botViewer(leader.id), leader.threadId, [message], { audience: { owner: true, scopeIds: [] }, ownerOwnChat: true }).map(r => r.text).join("\n");
  const verdictOf = (bot: BotRecord, messageId: string) => denyLookup(database(), { threadId: bot.threadId, lines: [{ messageId, author: "generated" }] }, { audience: { owner: true, scopeIds: [] } }, { ownerOwnChat: true }).get(messageId);
  return { store, leader, a, b, deps, ports, marked, completeRoomAsk, comms, begin, reply, heldReply, finish, row, botReads, verdictOf, wakes, wakeCalls, asked, saved,
    failWrites: (on: boolean) => { failWrites = on; }, retirePorts, check };
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

/** What a bot can be handed from every store this lane names: the receipts file, the asker wakes kept on disk, the frozen-replies cursor, the
 * event answer records, and every row of the leader's conversation as stored. The worker's own conversation is the owner's and keeps the words. */
function storesText(w: ReturnType<typeof world>, extra: string[] = []): string {
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (!/\.(db|sqlite)(-wal|-shm)?$/.test(name)) files.push(path); } };
  walk(DATA_DIR);
  const leaderRows = w.store.messagesFor(w.leader.threadId).map(m => JSON.stringify(m));
  return [...files.map(file => readFileSync(file, "utf8")), JSON.stringify([...w.saved]), ...leaderRows, ...extra].join("\n");
}

it("a direct hand-off whose reply reads checking is never held: the asker gets the no-answer line once, the words go nowhere a bot reads", async () => {
  const w = world();
  w.asked("task-a");
  const replyA = w.heldReply(w.a, WORDS_A);
  expect(w.verdictOf(w.a, replyA.id)).toEqual({ state: "checking", reason: "pending" });
  expect(w.finish(w.a, replyA, "task-a")).toBe(true);
  const row = w.row("task-a")!;
  expect(row.text).toBe(NO_ANSWER);
  expect(row.withheldFromBots).toBeUndefined();
  expect(row.copyOf).toBeUndefined();
  expect(w.botReads(row)).toBe(NO_ANSWER);
  const receipt = findDelegationReceipt("task-a")!;
  expect(receipt).toMatchObject({ status: "done", result: NO_ANSWER });
  expect(receipt.held).toBeUndefined();
  expect(receipt.copyOf).toBeUndefined();
  expect(heldReceipts()).toEqual([]);
  // completed and woken now, once, at the row: the leader learns a reply arrived as for any result
  expect(w.marked).toHaveBeenCalledTimes(1);
  expect(w.wakeCalls).toEqual([`task-a:${row.id}`]);
  // nothing mirrored carries the words (with a pair room, the checking line: see the shared hand-off below)
  const mirrored = (w.comms.reply.mock.calls as unknown[][]).map(call => outboundWords(call[1] as Outbound));
  expect(mirrored.join("\n")).not.toContain("RESEARCHER_A_WORDS");
  // final for the request: the check finishing later changes nothing a bot reads and wakes nobody again
  expect(drainRevokeMarker(database()).pending).toBe(false);
  expect((await w.check("task-a")).result).toBe(NO_ANSWER);
  expect(w.botReads(w.row("task-a")!)).toBe(NO_ANSWER);
  expect(w.wakeCalls).toHaveLength(1);
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("poll while checking: check_delegation reads the final no-answer line, consumes the one wake, and never later reads the words", async () => {
  const w = world();
  w.asked("task-p");
  w.finish(w.a, w.heldReply(w.a, WORDS_A), "task-p");
  // the wake is owed; the asker polls before it is claimed: it reads the no-answer line and is owed nothing more
  const polled = await w.check("task-p");
  expect(polled).toMatchObject({ status: "done", result: NO_ANSWER });
  expect(w.wakes.claim(w.leader.threadId)).toBeUndefined();
  drainRevokeMarker(database());
  expect((await w.check("task-p")).result).toBe(NO_ANSWER);
  expect(JSON.stringify(await w.check("task-p"))).not.toContain("RESEARCHER_A_WORDS");
});

it("failed wake save: registration reports it (the hand-off is then not acknowledged); a wake not yet on disk keeps the receipt's owed reply; never doubled", () => {
  const w = world();
  w.failWrites(true);
  expect(w.asked("task-f")).toBe(false);
  w.failWrites(false);
  expect(w.asked("task-f")).toBe(true);
  w.failWrites(true);
  w.finish(w.a, w.heldReply(w.a, WORDS_A), "task-f");
  const row = w.row("task-f")!;
  expect(w.wakeCalls).toEqual([`task-f:${row.id}`]);
  // the wake is not on disk yet: the receipt still owes its line, so a crash now is delivered again by the boot (deduped below)
  expect(findDelegationReceipt("task-f")!.reply).toEqual({ text: NO_ANSWER });
  // a second return of the same task (a receipt's recovery) is no second wake
  expect(w.wakes.deliver("task-f", { toBotId: w.a.id, toBotName: w.a.name, ok: true, messageId: row.id })).toBe(false);
  w.failWrites(false);
  expect(w.wakes.retryWrites()).toBe(true);
  const kept = w.saved.get(w.leader.threadId)!;
  expect(kept.wakes.flatMap(r => r.results.map(x => x.messageId))).toEqual([row.id]);
  expect(JSON.stringify(kept)).not.toContain("RESEARCHER_A_WORDS");
  expect(w.wakes.claim(w.leader.threadId)!.results.map(r => r.taskId)).toEqual(["task-f"]);
  // with the disk back, a clean finish releases the owed line at once
  w.asked("task-g");
  w.finish(w.a, w.heldReply(w.a, WORDS_B), "task-g");
  expect(findDelegationReceipt("task-g")!.reply).toBeUndefined();
});

it("a room hand-off whose reply reads checking completes its request at once, at the no-answer row", () => {
  const w = world();
  const request = insertRoomRequest(database(), {
    groupId: "g", verb: "ask", fromKind: "bot", fromBotId: w.leader.id, toBotId: w.a.id, targetThreadId: w.a.threadId, returnThreadId: w.leader.threadId, admissionKey: "ask:delegation:task-room", now: 1, state: "running",
    lineage: { rootThreadId: w.leader.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
  }).request;
  w.finish(w.a, w.heldReply(w.a, WORDS_A), "task-room", { requestId: request.id });
  expect(w.completeRoomAsk).toHaveBeenCalledTimes(1);
  expect(w.completeRoomAsk).toHaveBeenCalledWith(request.id, { state: "done", resultMessageId: handoffReplyId("task-room") });
  expect(w.row("task-room")!.text).toBe(NO_ANSWER);
  expect(findDelegationReceipt("task-room")).toMatchObject({ requestId: request.id, result: NO_ANSWER });
  expect(heldReceipts()).toEqual([]);
});

it("nested continuation (S waits on W1, W1 on W2): the request that delivers to each asker reads the no-answer line, never the words", () => {
  const w = world();
  const s = insertRoomRequest(database(), {
    groupId: "g", verb: "ask", fromKind: "bot", fromBotId: w.leader.id, toBotId: w.a.id, targetThreadId: w.a.threadId, returnThreadId: w.leader.threadId, returnBotId: w.leader.id, admissionKey: "ask:s", now: 1, state: "running",
    lineage: { rootThreadId: w.leader.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
  }).request;
  const w2 = insertRoomRequest(database(), { groupId: "g", verb: "ask", fromKind: "bot", fromBotId: w.a.id, toBotId: w.b.id, targetThreadId: w.b.threadId, parentId: s.id, admissionKey: "ask:w2", now: 2, state: "running" }).request;
  const replyB = w.heldReply(w.b, WORDS_B);
  const replyA = w.heldReply(w.a, WORDS_A);
  const store = boundaryStore(w.store);
  // W1, A's continuation, is woken with W2's result: an intermediate turn, its child's answer still being checked
  const forA = continuationOutcome({ store }, { toBotId: w.a.id, notOwnerAudience: false } as RoomRequest, w.a.threadId, { requestId: w2.id, state: "done", messageId: replyB.id } as never)!;
  expect(outboundWords(forA.answer!)).toBe(NO_ANSWER);
  // S delivers to the leader: the original asker reads the no-answer line for A's still-checking answer
  const forLeader = continuationOutcome({ store }, { toBotId: w.leader.id, notOwnerAudience: false } as RoomRequest, w.leader.threadId, { requestId: s.id, state: "done", messageId: replyA.id } as never)!;
  expect(outboundWords(forLeader.answer!)).toBe(NO_ANSWER);
  expect([forA, forLeader].map(o => outboundWords(o.answer!)).join("\n")).not.toMatch(/RESEARCHER_[AB]_WORDS/);
});

/** delegate_bot, and ask_bot to a busy teammate, from the leader's direct chat to a teammate shared with a team, driven through the real routes
 * (handoff-boundary.ts): the route's own admission registers the asker's wake (or not), the shared request it made runs and finishes, and its one
 * delivery wakes the asker through the real sharedResultReturned as index.ts wires it. Only the peer edge's authorization is let through here. */
async function sharedFromDirect(w: ReturnType<typeof world>, route: "delegate" | "askBusy", opts: { parentId?: string } = {}) {
  const lineage = { rootThreadId: w.leader.threadId, origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
  const sent: Array<{ status: number; body: Record<string, unknown> }> = [];
  configureBotEgress((_res, code, body) => { sent.push({ status: code, body: body as never }); });
  const charged: string[] = [];
  const settled: Array<[string | undefined, string]> = [];
  let queuedId: string | undefined;
  const bx = {
    MAX_COMMS_DEPTH: 4, ASK_BOT_TIMEOUT_MS: 60_000, askerWake: w.ports.askerWake, store: boundaryStore(w.store), rows: new RowSink(w.store),
    comms: { ...w.comms, queueDelegation: () => ({ result: "ok", id: queuedId = `task-${route}-${Math.random().toString(36).slice(2)}` }), dropQueuedDelegation: () => true },
    // the shared queue's request, as index.ts beginRoomAsk makes it for a teammate shared with a team (its id is the hand-off's)
    beginRoomAsk: (fromBotId: string, toBotId: string, fromThreadId: string, _message: string, admissionKey: string) => insertRoomRequest(database(), {
      id: admissionKey.slice("ask:delegation:".length), groupId: "g", verb: "ask", fromKind: "bot", fromBotId, toBotId, targetThreadId: w.a.threadId,
      returnThreadId: fromThreadId, admissionKey, now: 1, state: "queued", lineage, ...(opts.parentId ? { parentId: opts.parentId } : {}) }).request.id,
    settleRoomAsk: (id: string | undefined, outcome: { state: string }) => { settled.push([id, outcome.state]); },
    connectorThread: () => ({ bot: w.leader, group: undefined }), coordinationBudget: { advance: () => undefined }, coordinationHasCapacity: () => false,
    fullAccessSkipsPeerCard: () => false, internalCapabilities: { reserve: () => ({ commit: () => undefined, release: () => undefined }) },
    isUnattended: () => false, ownerSurfacesByThread: new Map(), resultEgressDeps: w.deps, roomAskDuplicate: () => null, roomAskKey: () => "k",
    roomAskParent: () => undefined, roomAskRefused: () => undefined, routinePeerSource: () => undefined, sourceExecutionAudience: () => undefined,
    sharedApprovedRequests: new Set<string>(), syncAskRequests: new Set<string>(), delegationWatch: new Map(), taskResolutionDeps: {},
    eventAction: async (_spec: unknown, run: (handle: unknown) => Promise<unknown>) => run({ charge: async () => { charged.push("charge"); }, record: () => undefined, unrun: () => { charged.push("unrun"); } }),
    internalClaim: { botId: w.leader.id, threadId: w.leader.threadId, generation: "g", depth: 0, kind: "handoff", skillAuthoring: false, expiresAt: Date.now() + 60_000 },
    internalOwner: {}, readInternalBody: async () => ({ fromBotId: w.leader.id, toBotId: w.a.id, fromThreadId: w.leader.threadId, message: "what is the cash rate?" }),
    requireActiveInternal: () => undefined, res: {},
  };
  allowPeers.on = true;
  try {
    if (route === "delegate") await delegateBotRoute(bx as unknown as Parameters<typeof delegateBotRoute>[0]);
    else await askBotRoute(bx as unknown as Parameters<typeof askBotRoute>[0]);
  } finally { allowPeers.on = false; configureBotEgress(undefined); }
  expect(sent).toHaveLength(1);
  const id = queuedId!;
  /** The worker's turn ends with `reply` and the request's one delivery runs (index.ts beginSharedRun's follow -> deliverSharedResult). */
  const complete = (reply: Message) => {
    finishRequestTurn(database(), id, { ok: true, now: 2, resultMessageId: reply.id });
    return deliver();
  };
  const returnedPorts = { askerWake: w.ports.askerWake!, wakes: w.wakes, delegationSource: w.ports.delegationSource, markTaskContextExternallyUpdated: w.marked, store: boundaryStore(w.store) };
  const deliver = () => runDeliverSharedResult({ store: boundaryStore(w.store), rows: new RowSink(w.store), comms: w.comms as never,
    returned: (req, messageId) => sharedResultReturned(returnedPorts, req, messageId) }, roomRequest(database(), id)!);
  return { id, body: sent[0].body, charged, settled, complete, deliver };
}

for (const route of ["delegate", "askBusy"] as const) {
  it(`${route === "delegate" ? "delegate_bot" : "ask_bot's busy fallback"} to a shared teammate from a direct chat: the wake is on disk at admission and a checking result wakes the asker once, with the no-answer line`, async () => {
    const w = world();
    const run = await sharedFromDirect(w, route);
    expect(run.body.taskId).toBe(run.id);
    expect(roomRequest(database(), run.id)!.parentId ?? null).toBeNull();
    // registered by the route before it acknowledged the hand-off, and kept on disk
    expect(w.wakes.intends(run.id)).toBe(true);
    expect(w.saved.has(w.leader.threadId)).toBe(true);
    run.complete(w.heldReply(w.a, WORDS_A));
    const rows = w.store.messagesFor(w.leader.threadId).filter(m => m.requestId === run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe(NO_ANSWER);
    expect(w.wakeCalls).toEqual([`${run.id}:${rows[0].id}`]);
    expect(w.marked).toHaveBeenCalledTimes(1);
    expect(roomRequest(database(), run.id)!.refusal ?? null).not.toBeNull();
    // a second delivery (the owed-delivery sweep, a boot replay) writes nothing new and wakes nobody again
    run.deliver();
    expect(w.wakeCalls).toHaveLength(1);
    expect(w.wakes.intends(run.id)).toBe(false);
    expect(w.store.messagesFor(w.leader.threadId).some(m => (m.text ?? "").includes(WORDS_A))).toBe(false);
  });

  it(`${route === "delegate" ? "delegate_bot" : "ask_bot's busy fallback"} to a shared teammate: a wake that cannot be written refuses the hand-off and cancels its request; a room's request registers nothing`, async () => {
    const w = world();
    w.failWrites(true);
    const lost = await sharedFromDirect(w, route);
    w.failWrites(false);
    expect(lost.body.taskId).toBeUndefined();
    expect(lost.body.error).toBeDefined();
    expect(lost.settled).toEqual([[lost.id, "cancelled"]]);
    expect(lost.charged).toContain("unrun");
    expect(w.wakes.intends(lost.id)).toBe(false);
    // a request inside a room's tree wakes its asker through the tree (room-requests.ts): nothing is registered at admission
    const parent = insertRoomRequest(database(), { groupId: "g", verb: "ask", fromKind: "owner", toBotId: w.leader.id, admissionKey: `root:${route}`, now: 1, state: "running",
      lineage: { rootThreadId: w.leader.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } }).request;
    const child = await sharedFromDirect(w, route, { parentId: parent.id });
    expect(child.body.taskId).toBe(child.id);
    expect(w.wakes.intends(child.id)).toBe(false);
    expect(w.wakeCalls).toEqual([]);
  });
}

it("a shared hand-off made from a direct chat is never held: the destination row and the receipt carry the no-answer line, the pair room the checking line", () => {
  const w = world();
  const request = insertRoomRequest(database(), {
    groupId: "g", verb: "ask", fromKind: "bot", fromBotId: w.leader.id, toBotId: w.a.id, targetThreadId: w.a.threadId, returnThreadId: w.leader.threadId, admissionKey: "ask:shared-1", now: 1, state: "running",
    lineage: { rootThreadId: w.leader.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
  }).request;
  const replyA = w.heldReply(w.a, WORDS_A);
  finishRequestTurn(database(), request.id, { ok: true, now: 2, resultMessageId: replyA.id });
  const finished = roomRequest(database(), request.id)!;
  // the asker's wake at the delivered row (index.ts sharedResultReturned): the first time not yet on disk, so the delivery stays owed
  const woken: string[] = [];
  let onDisk = false;
  const deliver = () => runDeliverSharedResult({ store: boundaryStore(w.store), rows: new RowSink(w.store), comms: w.comms as never,
    returned: (req, messageId) => { woken.push(`${req.id}:${messageId}`); return onDisk; } }, roomRequest(database(), request.id)!);
  expect(finished.state).toBe("done");
  deliver();
  expect(roomRequest(database(), request.id)!.refusal ?? null).toBeNull();
  const rows = w.store.messagesFor(w.leader.threadId).filter(m => m.requestId === request.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].text).toBe(NO_ANSWER);
  expect(rows[0].withheldFromBots).toBeUndefined();
  expect(w.botReads(rows[0])).toBe(NO_ANSWER);
  const receipt = findDelegationReceipt(request.id)!;
  expect(receipt).toMatchObject({ status: "done", result: NO_ANSWER });
  expect(receipt.held).toBeUndefined();
  expect(receipt.copyOf).toBeUndefined();
  expect((w.comms.reply.mock.calls as unknown[][]).map(call => outboundWords(call[1] as Outbound))).toEqual([CHECKING]);
  // the delivery asked again (the owed pass, after the check finished) writes nothing twice, keeps the no-answer (final) and never the words;
  // the wake is asked for at the same row (AskerWakes dedupes it) and, now on disk, the request is marked delivered
  drainRevokeMarker(database());
  onDisk = true;
  deliver();
  expect(w.store.messagesFor(w.leader.threadId).filter(m => m.requestId === request.id)).toHaveLength(1);
  expect(findDelegationReceipt(request.id)).toMatchObject({ result: NO_ANSWER });
  expect(woken).toEqual([`${request.id}:${rows[0].id}`, `${request.id}:${rows[0].id}`]);
  expect(roomRequest(database(), request.id)!.refusal).toBeTruthy();
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("replay: a repeat in the same event replays the no-answer (or withheld) line, never the originals read again", () => {
  const w = world();
  const replyA = w.heldReply(w.a, WORDS_A);
  const recorded = noAnswerReceipt("checking");
  expect(recorded).not.toContain(replyA.id);
  drainRevokeMarker(database());
  // the originals read shown now; the replay never asks for them
  const answerText = vi.fn(() => status("checking"));
  const decoded = decodeHandoffReceipt(recorded)!;
  for (const via of ["ask", "delegate"] as const) {
    const replayed = formatHandoff(decoded, via, { targetName: botName(w.a), resolvable: () => true, answerText }, false)!;
    const text = JSON.stringify(replayed.body);
    expect(text).toContain(NO_ANSWER);
    expect(text).not.toContain("RESEARCHER_A_WORDS");
  }
  expect(answerText).not.toHaveBeenCalled();
  expect(JSON.stringify(formatHandoff(decodeHandoffReceipt(noAnswerReceipt("withheld"))!, "ask", { targetName: botName(w.a), resolvable: () => true, answerText }, false)!.body)).toContain(WITHHELD);
  // an older answer record whose stored answer reads checking replays the no-answer line too
  const heldAgain = w.heldReply(w.a, WORDS_B);
  const replay = storedAnswerText({ ...w.deps, request: () => null, requestSourceThread: () => undefined }, { threadId: w.a.threadId, messageId: heldAgain.id }, { fromBotId: w.leader.id, toBotId: w.a.id, fromThreadId: w.leader.threadId }, false);
  expect(outboundWords(replay!)).toBe(NO_ANSWER);
});

it("expired: a hold an earlier build left past HELD_MAX_AGE_MS is retired at start as the no-answer result, its asker woken once, its words deleted", async () => {
  const w = world();
  const replyA = w.reply(w.a, WORDS_A);
  const copyOf = { threadId: w.a.threadId, messageIds: [replyA.id] };
  const id = handoffReplyId("task-old");
  w.asked("task-old");
  // what an earlier 1.0.3 build left: the words flagged "checking" in the leader's conversation, the receipt held with the words and the copy link
  w.store.appendMessage(w.leader.threadId, { role: "bot", kind: "text", text: `@${w.a.name} replied to the delegated task:\n\n${WORDS_A}`, inboundKind: "action",
    from: { botId: w.a.id, name: w.a.name, color: w.a.color }, copyOf, withheldFromBots: "checking" }, id);
  w.ports.finalizingDelegations.add("task-old");
  recordDelegationReceipt({ id: "task-old", sourceThreadId: w.leader.threadId, toBotId: w.a.id, toBotName: w.a.name, status: "done", result: released(WORDS_A, copyOf), copyOf, lineage: true,
    held: { messageId: id, since: Date.now() - HELD_MAX_AGE_MS - 1 } });
  w.ports.finalizingDelegations.delete("task-old");
  _loadPending(); // a start reads the receipts file again
  expect(heldReceipts()).toHaveLength(1);
  const ports = w.retirePorts();
  expect(retireHeldReplies(ports)).toBe(1);
  const row = w.row("task-old")!;
  expect(row.text).toBe(NO_ANSWER);
  expect(row.copyOf).toBeUndefined();
  expect(row.withheldFromBots).toBeUndefined();
  expect(w.botReads(row)).toBe(NO_ANSWER);
  const receipt = findDelegationReceipt("task-old")!;
  expect(receipt).toMatchObject({ status: "done", result: NO_ANSWER });
  expect(receipt.held).toBeUndefined();
  expect(receipt.copyOf).toBeUndefined();
  expect(ports.completed).toEqual([["task-old", id]]);
  expect(w.wakeCalls).toEqual([`task-old:${id}`]);
  // a second start finds nothing to retire and wakes nobody again; check_delegation reads the line
  expect(retireHeldReplies(ports)).toBe(0);
  expect(w.wakeCalls).toHaveLength(1);
  expect((await w.check("task-old")).result).toBe(NO_ANSWER);
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("dropped hold: a held receipt whose row never reached the conversation is retired with the no-answer row; its cached words never come back", async () => {
  const w = world();
  const replyA = w.reply(w.a, WORDS_A);
  const copyOf = { threadId: w.a.threadId, messageIds: [replyA.id] };
  w.ports.finalizingDelegations.add("task-lost");
  recordDelegationReceipt({ id: "task-lost", sourceThreadId: w.leader.threadId, toBotId: w.a.id, toBotName: w.a.name, status: "done", result: released(WORDS_A, copyOf), copyOf, lineage: true,
    held: { messageId: handoffReplyId("task-lost"), since: Date.now() }, reply: { text: WORDS_A, held: { copyOf } } });
  w.ports.finalizingDelegations.delete("task-lost");
  expect(w.row("task-lost")).toBeUndefined();
  expect(retireHeldReplies(w.retirePorts())).toBe(1);
  expect(w.row("task-lost")!.text).toBe(NO_ANSWER);
  const receipt = findDelegationReceipt("task-lost")!;
  expect(receipt.reply).toBeUndefined();
  expect(receipt.copyOf).toBeUndefined();
  // the original reads shown (it always did): the receipt still answers the line
  expect((await w.check("task-lost")).result).toBe(NO_ANSWER);
  // an earlier build's owed held reply replayed by any path writes the line, never the words
  const replayed = replayOwedReply(w.store, { id: "task-lost-2", sourceThreadId: w.leader.threadId, toBotId: w.a.id, toBotName: w.a.name, status: "done", finishedAt: Date.now(), reply: { text: WORDS_A, held: { copyOf } } } as never)!;
  expect(replayed.text).toBe(NO_ANSWER);
  expect(w.botReads(replayed)).toBe(NO_ANSWER);
  // the leader's conversation deleted: the hold is retired with nothing written
  const gone = w.store.createBot({ name: "Gone Leader", section: "Research" }, { seedMessages: false });
  recordDelegationReceipt({ id: "task-gone", sourceThreadId: gone.threadId, toBotId: w.a.id, toBotName: w.a.name, status: "done", copyOf, lineage: true, held: { messageId: handoffReplyId("task-gone"), since: Date.now() } });
  w.store.deleteTask(gone.id, gone.threadId);
  const ports = w.retirePorts();
  expect(retireHeldReplies(ports)).toBe(1);
  expect(ports.completed).toEqual([["task-gone", undefined]]);
  expect(findDelegationReceipt("task-gone")?.copyOf).toBeUndefined();
  expect(storesText(w)).not.toContain("RESEARCHER_A_WORDS");
});

it("scan: after every path above in one install, the held words are in no receipt, replay record, frozen file, wake or routine answer store", async () => {
  const w = world();
  const events: string[] = [];
  w.asked("scan-direct");
  w.finish(w.a, w.heldReply(w.a, WORDS_A), "scan-direct");
  await w.check("scan-direct");
  events.push(noAnswerReceipt("checking"));
  const request = insertRoomRequest(database(), {
    groupId: "g", verb: "ask", fromKind: "bot", fromBotId: w.leader.id, toBotId: w.b.id, targetThreadId: w.b.threadId, returnThreadId: w.leader.threadId, admissionKey: "ask:scan", now: 1, state: "running",
    lineage: { rootThreadId: w.leader.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
  }).request;
  finishRequestTurn(database(), request.id, { ok: true, now: 2, resultMessageId: w.heldReply(w.b, WORDS_B).id });
  runDeliverSharedResult({ store: boundaryStore(w.store), rows: new RowSink(w.store), comms: w.comms as never }, roomRequest(database(), request.id)!);
  drainRevokeMarker(database());
  const all = storesText(w, [...events, ...(w.comms.reply.mock.calls as unknown[][]).map(call => outboundWords(call[1] as Outbound))]);
  expect(all).not.toContain("RESEARCHER_A_WORDS");
  expect(all).not.toContain("RESEARCHER_B_WORDS");
  expect(all).toContain(NO_ANSWER);
});

it("a clean delegation still delivers its words normally: shown at finalize, no hold, woken once", async () => {
  const w = world();
  w.asked("task-clean");
  const replyA = w.reply(w.a, WORDS_A);
  expect(w.verdictOf(w.a, replyA.id)).toEqual({ state: "shown" });
  w.finish(w.a, replyA, "task-clean");
  const row = w.row("task-clean")!;
  expect(row.text).toContain(WORDS_A);
  expect(row.copyOf).toEqual({ threadId: w.a.threadId, messageIds: [replyA.id] });
  expect(w.botReads(row)).toContain(WORDS_A);
  expect(findDelegationReceipt("task-clean")!.held).toBeUndefined();
  expect(w.wakeCalls).toEqual([`task-clean:${row.id}`]);
  expect((await w.check("task-clean")).result).toBe(WORDS_A);
});

it("a revoke committed before the worker's prompt is built leaves its reply outside the window: shown at finalize, no hold", () => {
  const w = world();
  openPendingWindow();
  const replyA = w.reply(w.a, WORDS_A);
  expect(w.verdictOf(w.a, replyA.id)).toEqual({ state: "shown" });
  expect(w.finish(w.a, replyA, "task-a")).toBe(true);
  const row = w.row("task-a")!;
  expect(row.text).toContain(WORDS_A);
  expect(w.botReads(row)).toContain(WORDS_A);
  expect(heldReceipts()).toEqual([]);
});

it("a reply that really used a line the owner forgot is withheld at finalize with its own line, final, never held", () => {
  const w = world();
  w.asked("task-w");
  const plan = w.store.appendMessage(w.leader.threadId, { role: "user", kind: "text", text: "the owner's private plan" });
  const replyA = w.reply(w.a, WORDS_A, [{ kind: "line", threadId: w.leader.threadId, messageId: plan.id }]);
  commitRevoke(database(), { kind: "line", threadId: w.leader.threadId, messageIds: [plan.id], cause: "forget" });
  drainRevokeMarker(database());
  w.finish(w.a, replyA, "task-w");
  expect(findDelegationReceipt("task-w")).toMatchObject({ result: WITHHELD });
  expect(findDelegationReceipt("task-w")!.held).toBeUndefined();
  expect(w.botReads(w.row("task-w")!)).not.toContain(WORDS_A);
  expect(w.wakeCalls).toEqual([`task-w:${handoffReplyId("task-w")}`]);
});

it("the copy of this lane carries no em dash in the files it wrote, and none of the three words the house rules ban", () => {
  const written = ["server/held-replies.ts", "server/frozen-replies.ts", "server/handoff-reply.ts", "server/result-egress-checking.test.ts", "server/delegation-nohold.test.ts",
    "server/frozen-replies.test.ts", "lanes/release103/NOHOLD-DELEGATION.md", "lanes/release103/REPLY-WITHHELD-CONTRACT.md", "lanes/release103/REPLY-WITHHELD-SPLIT.md"];
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
