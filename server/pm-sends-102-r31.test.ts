// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
import { released } from "./testing/released.ts";
// Round 31: Astra r30c's three P1s, each in the exact scenario Astra reproduced. Each test fails on 98e34e2de.
//  1  an automatic retry of an earlier Send again (resend:true) runs a stopped message: owner sends and the channel queue. Each press now carries its own
//     action token and the stop token its chip showed; a stopped row runs only for a press made after its Stop
//  2  crash recovery of a DIRECT owner-conversation hand-off (no room request) writes the reply into the source conversation exactly once, and its row goes
//     only after that line has committed
//  3  a receipt that owes a reply never expires: Murage closed for 49 hours, the next start delivers the reply once and the request ends done, not failed
//  4  (RC2 integration) a queued hand-off whose start fails before the engine is handed the turn leaves its "could not start" chip again, owner and room origin
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainChannelMessages, queueChannelMessage } from "./channel-queue.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import * as delegations from "./delegations.ts";
import { _resetPending, FINALIZER_WRITES, onDelegationReceipt, onOwedHandoffReply, queueDelegation, reconcileStartedDelegations, type DelegationReceipt } from "./delegations.ts";
import { dispatchHandoff } from "./handoff-dispatch.ts";
import { appendHandoffReply, owedReplyOf, replayOwedReply } from "./handoff-reply.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { completeRequest, isTerminalRoomRequestState, roomRequest } from "./room-requests.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import { pendingItem, sendStore } from "./send-store.ts";
import { drainSteeredMessages, type SteerStore } from "./steer-queue.ts";
import { Store, type BotRecord, type Message } from "./store.ts";
import { ownerWorld, type OwnerWorld } from "./testing/handoff-worlds.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const quietly = async <T>(run: () => T | Promise<T>): Promise<T> => { const error = console.error; console.error = () => {}; try { return await run(); } finally { console.error = error; } };

// ── 1 ─────────────────────────────────────────────────────────────────────────────────
describe("1. an automatic retry of an earlier Send again never runs a stopped message", () => {
  const dirs: string[] = [];
  const handles: DatabaseSync[] = [];
  let file = "";
  const start = () => { const db = new DatabaseSync(file); handles.push(db); sendStore.reset(); sendStore.use(() => db); };
  beforeEach(() => { const dir = mkdtempSync(join(tmpdir(), "r31-stop-")); dirs.push(dir); file = join(dir, "messages.db"); start(); });
  afterEach(() => { sendStore.reset(); for (const h of handles.splice(0)) { try { h.close(); } catch { /* closed */ } } for (const d of dirs.splice(0)) removeTempDirSync(d); });

  /** A request as the delivery client posts it: an automatic retry replays exactly the press it repeats (its resend, its action token, its stop token). */
  type Press = { resend: true; actionId: string; stopGen?: string };
  interface Queue { thread: string; send(sendId: string, press?: Press): void; drain(): void; runs: string[] }
  const TEXT = "summarize the report";
  function botQueue(): Queue {
    const lines: Message[] = [];
    const runs: string[] = [];
    const bot = { id: "bot-1", threadId: "t1", busy: false } as unknown as BotRecord;
    const store: SteerStore = {
      bot: () => bot,
      appendMessage: (_threadId, message, stableId) => { const full = { id: stableId ?? `m${lines.length + 1}`, at: 1, ...message } as Message; lines.push(full); return full; },
      messagesFor: () => lines,
      patchMessage: () => null,
    };
    return {
      thread: "t1", runs,
      send: (sendId, press) => { expect(sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", text: TEXT, sendId, fingerprint: sendFingerprint(TEXT), status: "queued", ...press }).kind).not.toBe("conflict"); },
      drain: () => drainSteeredMessages(store, (_bot, _thread, prompt) => { runs.push(prompt); }),
    };
  }
  function roomQueue(): Queue {
    const runs: string[] = [];
    return {
      thread: "g-thread", runs,
      send: (sendId, press) => { queueChannelMessage("g1", "g-thread", TEXT, { sendId, ...press }); },
      drain: () => drainChannelMessages(() => false, (input) => { runs.push(input.text); return { messageId: `line-${runs.length}` }; }),
    };
  }
  for (const [name, make] of [["owner sends", botQueue], ["channel queue", roomQueue]] as const) {
    it(`${name}: Send again, its acknowledgement lost, Stop, restart, the client's automatic retry: zero runs until a fresh Send again, then exactly one`, () => {
      const q = make();
      q.send("s1");
      const [refused] = sendStore.pending(q.thread);
      sendStore.refuse(refused!.seq);                                              // the bot or room could not start it: a chip
      const first: Press = { resend: true, actionId: "press-1" };                  // Send again on the chip (no Stop yet: no stop token)
      q.send("s1", first);                                                         // accepted and waiting; its acknowledgement is lost
      expect(sendStore.pending(q.thread).map((row) => row.status)).toEqual(["queued"]);
      expect(sendStore.markStopped(q.thread)).toBe(1);                             // the owner pressed Stop
      start();                                                                     // Murage restarts
      sendStore.recover();
      q.drain();
      q.send("s1", first);                                                         // the delivery client's automatic retry of the first press
      q.drain();
      q.send("s1", first);                                                         // and again
      q.drain();
      expect(q.runs).toEqual([]);
      const held = sendStore.pending(q.thread);
      expect(held.map((row) => row.status)).toEqual(["refused"]);
      const chip = pendingItem(held[0]!);
      expect(chip.stopGen).toBeTruthy();                                           // the held chip shows the Stop's token
      q.send("s1", { resend: true, actionId: "press-2", stopGen: "a-guess" });     // a token that is not this Stop's runs nothing
      q.drain();
      expect(q.runs).toEqual([]);
      const second: Press = { resend: true, actionId: "press-2", stopGen: chip.stopGen! };
      q.send("s1", second);                                                        // a fresh Send again, pressed after the Stop
      q.drain();
      q.drain();
      q.send("s1", first);                                                         // late retries of either press change nothing
      q.send("s1", second);
      q.drain();
      expect(q.runs).toEqual([TEXT]);
    });
  }
});

// ── 2 and 3 ───────────────────────────────────────────────────────────────────────────
const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); };
const HOURS = 60 * 60 * 1000;

/** A finished hand-off whose process dies after its receipt reached disk and before its final commit, then the restarts that follow. The writer and listener
 * are the server's (index.ts onOwedHandoffReply and onDelegationReceipt): the line through replayOwedReply, the request ended pointing at it. */
async function crashedHandoff(w: OwnerWorld, reply: string) {
  const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "find the number", depth: 0 }, 2).id!;
  await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
  const owed = owedReplyOf({ ok: true, reply, targetName: "Helper", failureName: "", stopped: false });
  const finalizing = new Set([id]);
  const listen = (store: Parameters<typeof replayOwedReply>[0]) => {
    onOwedHandoffReply((receipt) => finalizing.has(receipt.id) ? FINALIZER_WRITES : replayOwedReply(store, receipt));
    onDelegationReceipt((receipt: DelegationReceipt, delivered) => {
      if (finalizing.has(receipt.id)) return;
      const row = roomRequest(database(), receipt.id);
      if (!row || isTerminalRoomRequestState(row.state)) return;
      completeRequest(database(), row.id, { state: receipt.status === "done" ? "done" : "failed", now: Date.now(), resultMessageId: delivered?.id ?? null });
    });
  };
  listen(w.store);
  const receipt = { id, sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done" as const, result: released(reply), lineage: true, requestId: id, reply: owed };
  await quietly(() => {
    expect(() => delegations.finishHandoff(receipt, () => {
      appendHandoffReply(w.store, { handoffId: id, sourceThreadId: w.from.threadId, owed, targetBotId: w.target.id, targetName: "Helper", askRequestId: id });
      throw new Error("the process died");
    })).toThrow(/the process died/);
  });
  expect(delegations.findDelegationReceipt(id)?.reply).toEqual(owed);              // the receipt on disk still owes the line
  const restart = () => {
    delegations._simulateRestart(); closeDatabase(); delegations._loadPending(); finalizing.clear();
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const view = { appendMessage: store.appendMessage.bind(store), bot: (botId: string) => w.store.bot(botId), botByThread: (threadId: string) => w.store.botByThread(threadId), groupByThread: () => undefined };
    listen(view as never);
    reconcileStartedDelegations();
    return store;
  };
  const lines = (store: Store) => store.messagesFor(w.from.threadId).filter((message) => (message.text ?? "").includes(reply));
  const row = () => database().prepare("SELECT 1 AS x FROM pending_delegations WHERE id=?").get(id);
  return { id, restart, lines, row };
}

describe("2. crash recovery of a direct owner-conversation hand-off", () => {
  beforeEach(fresh);
  afterEach(() => { onDelegationReceipt(undefined); onOwedHandoffReply(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

  it("no room request: three restarts write the reply into the source conversation exactly once, and the row goes only with it", async () => {
    const w = ownerWorld();
    const h = await crashedHandoff(w, "The number is 42.");
    expect(roomRequest(database(), h.id)).toBeFalsy();                               // a direct hand-off: no room request behind it
    expect(h.row()).toBeTruthy();
    for (let i = 0; i < 3; i++) {
      const store = h.restart();
      expect(h.lines(store)).toHaveLength(1);
      expect(h.lines(store)[0]!.text).toBe("@Helper replied to the delegated task:\n\nThe number is 42.");
      expect(h.row()).toBeUndefined();
      expect(delegations.findDelegationReceipt(h.id)?.reply).toBeUndefined();      // delivered: the receipt owes nothing any more
    }
  });

  it("with no writer for the line, the row is not removed: it stays for the start that can write it", async () => {
    const w = ownerWorld();
    const h = await crashedHandoff(w, "Kept for later.");
    delegations._simulateRestart(); closeDatabase(); delegations._loadPending();
    onOwedHandoffReply(undefined);
    await quietly(() => reconcileStartedDelegations());
    expect(h.row()).toBeTruthy();
    expect(delegations.findDelegationReceipt(h.id)?.reply).toBeTruthy();
    const store = h.restart();
    expect(h.lines(store)).toHaveLength(1);
    expect(h.row()).toBeUndefined();
  });
});

describe("3. a receipt that owes a reply never expires", () => {
  beforeEach(fresh);
  afterEach(() => { vi.useRealTimers(); onDelegationReceipt(undefined); onOwedHandoffReply(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

  it("room-backed hand-off, Murage closed for 49 hours: the next start delivers the reply once, the request ends done, then the receipt may age out", async () => {
    const w = ownerWorld("room");
    const h = await crashedHandoff(w, "The total is 7.");
    expect(roomRequest(database(), h.id)!.state).toBe("running");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 49 * HOURS);                                       // closed for 49 hours (the receipt drawer keeps 48)
    for (let i = 0; i < 3; i++) {
      const store = h.restart();
      expect(h.lines(store)).toHaveLength(1);
      expect(roomRequest(database(), h.id)).toMatchObject({ state: "done", resultMessageId: h.lines(store)[0]!.id });
      expect(h.row()).toBeUndefined();
    }
    // delivered: from now on it is an ordinary receipt, past its retention
    expect(delegations.findDelegationReceipt(h.id)).toBeNull();
  });

  it("an owed receipt is not cut by the drawer's count either", async () => {
    const w = ownerWorld();
    const h = await crashedHandoff(w, "Counted out?");
    for (let i = 0; i < 150; i++) delegations.recordDelegationReceipt({ id: `other-${i}`, sourceThreadId: "elsewhere", toBotId: "x", toBotName: "X", status: "done", result: released("ok") });
    expect(delegations.findDelegationReceipt(h.id)?.reply).toBeTruthy();
    const store = h.restart();
    expect(h.lines(store)).toHaveLength(1);
  });
});

// ── 4 ─────────────────────────────────────────────────────────────────────────────────
describe("4. a queued hand-off that cannot start says so", () => {
  beforeEach(fresh);
  afterEach(() => { onDelegationReceipt(undefined); onOwedHandoffReply(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });
  for (const origin of ["owner", "room"] as const) {
    it(`${origin} origin: the engine refuses the start (no such engine): the could-not-start chip is asked for, with the reason, for this hand-off`, async () => {
      const w = ownerWorld(origin);
      w.knobs.failStart = "no such instance: missing-instance";
      const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "pick this up", depth: 0 }, 2).id!;
      await quietly(() => dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus }));
      expect(w.turns).toEqual([]);
      expect(w.couldNotStart.length).toBeGreaterThanOrEqual(1);
      expect(w.couldNotStart[0]).toMatchObject({ id, sourceThreadId: w.from.threadId, fromBotId: w.from.id, toBotId: w.target.id, shared: false });
      expect(w.couldNotStart[0]!.why).toContain("no such instance");
    });
  }
  it("a start the engine was handed (submitted) is not a could-not-start: it is held for the owner instead", async () => {
    const w = ownerWorld();
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "pick this up", depth: 0 }, 2).id!;
    w.knobs.submit.add(id);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(w.couldNotStart).toEqual([]);
  });
});
