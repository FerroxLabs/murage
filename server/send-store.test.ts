// The send record is the one source of truth for an acknowledged message: these
// pin the round-3 review findings (steer-visible) against it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { SendStore, sendStore, ThreadAdmission, initializeOwnerSends, pendingItem, sendNoticeLine, type RecoveryIo, type SendRow } from "./send-store.ts";
import { createHash } from "node:crypto";
import { drainSteeredMessages, queueSteeredMessage, queuedSteeredMessage, cancelSteeredMessage, queuedSteerCount, type SteerStore } from "./steer-queue.ts";
import { cancelChannelMessage, channelQueueThreads, drainChannelMessages, queueChannelMessage, queuedChannelMessage } from "./channel-queue.ts";
import { reconcileLateSteer } from "./steer-late.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import type { BotRecord, Message } from "./store.ts";

const dirs: string[] = [];
const handles: DatabaseSync[] = [];
/** A file database; each call to `open()` is one process's own connection. */
function fileDb(): { file: string; open: () => () => DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "send-store-"));
  dirs.push(dir);
  const file = join(dir, "messages.db");
  return { file, open: () => { const db = new DatabaseSync(file); handles.push(db); return () => db; } };
}
afterEach(() => { for (const h of handles.splice(0)) { try { h.close(); } catch { /* closed */ } } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); sendStore.reset(); });
beforeEach(() => sendStore.reset());

const fp = (text: string) => sendFingerprint(text);
const accept = (store: SendStore, text: string, sendId?: string, over: Record<string, unknown> = {}) =>
  store.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", text, fingerprint: fp(text), ...(sendId ? { sendId } : {}), ...over });

/** The transcript as recovery sees it: a list of lines, and a receipt that appends the line and its notice. */
type Line = { id: string; sendId?: string; queueId?: string; text?: string; notice?: string };
function transcriptIo(lines: Line[], failOn?: "notice"): RecoveryIo & { written: Line[] } {
  return {
    written: lines,
    lines: () => lines,
    appendReceipt: (row: SendRow, lineId: string) => {
      lines.push({ id: lineId, ...(row.sendId ? { sendId: row.sendId } : {}), queueId: row.queueId, text: row.text });
      if (failOn === "notice") throw new Error("disk full");
      lines.push({ id: `notice-${lines.length}`, notice: sendNoticeLine("notConfirmed").tool.name });
    },
  };
}

function idleStore(): SteerStore & { lines: Message[]; busy: boolean } {
  const lines: Message[] = [];
  const bot = { id: "bot-1", threadId: "t1", busy: false } as unknown as BotRecord;
  const api = {
    lines,
    busy: false,
    bot: () => { (bot as { busy: boolean }).busy = api.busy; return bot; },
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at">, stableId?: string) => {
      const full = { id: stableId ?? `m${lines.length + 1}`, at: 1, ...message } as Message;
      lines.push(full);
      void threadId;
      return full;
    },
    messagesFor: () => lines,
    patchMessage: () => null,
  };
  return api as unknown as SteerStore & { lines: Message[]; busy: boolean };
}

describe("acceptance is one committed row", () => {
  it("a repeated sendId returns the row it already has and never makes a second one", () => {
    const first = accept(sendStore, "hello", "send-aaaaaaaaaaaaaaaa");
    const again = accept(sendStore, "hello", "send-aaaaaaaaaaaaaaaa");
    expect(first.kind).toBe("new");
    expect(again.kind).toBe("existing");
    expect(again.row.seq).toBe(first.row.seq);
    expect(accept(sendStore, "different", "send-aaaaaaaaaaaaaaaa").kind).toBe("conflict");
  });

  it("when the row cannot be written, accept throws and nothing exists to submit", () => {
    const db = new DatabaseSync(":memory:");
    initializeOwnerSends(db);
    const store = new SendStore(() => db);
    db.exec("PRAGMA query_only=ON");
    expect(() => accept(store, "never recorded", "send-bbbbbbbbbbbbbbbb")).toThrow();
    db.exec("PRAGMA query_only=OFF");
    expect(store.bySendId("t1", "send-bbbbbbbbbbbbbbbb")).toBeUndefined();
    expect(store.pending("t1")).toEqual([]);
  });

  it("a queue write that fails is an error, not an acknowledgement, and the words stay recorded", () => {
    const db = new DatabaseSync(":memory:");
    sendStore.use(() => db);
    const { row } = accept(sendStore, "keep me", "send-cccccccccccccccc");
    db.exec("PRAGMA query_only=ON");
    expect(() => queueSteeredMessage("bot-1", "t1", "keep me", { rowSeq: row.seq })).toThrow();
    db.exec("PRAGMA query_only=OFF");
    // nothing was acknowledged as queued; the row still holds the words
    expect(queuedSteerCount("t1")).toBe(0);
    const kept = sendStore.bySeq(row.seq)!;
    expect(kept.status).toBe("sending");
    expect(kept.text).toBe("keep me");
  });

  it("a 1.0.1 database (transcript tables only) migrates in place and its transcript is untouched", () => {
    const { open } = fileDb();
    const old = open()();
    initializeMessageTables(old);
    old.prepare("INSERT INTO messages (thread_id,id,at,role,kind,text,json) VALUES ('t1','m1',1,'user','text','old words','{}')").run();
    sendStore.use(() => old);
    const out = accept(sendStore, "new words", "send-dddddddddddddddd");
    expect(out.kind).toBe("new");
    expect((old.prepare("SELECT text FROM messages WHERE id='m1'").get() as { text: string }).text).toBe("old words");
    expect((old.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(1);
  });
});

describe("order: a message waits behind any earlier unresolved message", () => {
  it("B, accepted while A is still deciding, is held behind A's unconfirmed steer, and a late refusal puts A back AHEAD of B", () => {
    const a = accept(sendStore, "A", "send-aaaaaaaaaaaaaaa1").row;
    const b = accept(sendStore, "B", "send-bbbbbbbbbbbbbbb1").row;
    expect(b.seq).toBeGreaterThan(a.seq);
    // A: the steer came back uncertain; the row is the barrier (no timer anywhere)
    sendStore.markDispatched(a.seq);
    sendStore.settle(a.seq, "unconfirmed", "m-a");
    sendStore.holdForLateAnswer(a.seq);
    expect(sendStore.blockedByEarlier("t1", b.seq)).toBe(true);
    queueSteeredMessage("bot-1", "t1", "B", { rowSeq: b.seq });
    // B is waiting but may not start while A can still be refused
    expect(sendStore.drainable("t1", "bot")).toEqual([]);
    // the engine refuses A late: it goes back in place, ahead of B
    reconcileLateSteer({
      botExists: () => true, patchMessage: () => null,
      delivered: (seq, id) => sendStore.settle(seq, "delivered", id),
      passedByLater: (t, seq) => sendStore.hasPassed(t, seq),
      requeue: (seq, id) => sendStore.queue(seq, id),
      fail: (seq) => sendStore.settle(seq, "failed"),
      release: (seq) => sendStore.releaseLateAnswer(seq),
      drain: () => {},
    }, { botId: "bot-1", threadId: "t1", seq: a.seq, messageId: "m-a" }, "rejected");
    expect(sendStore.drainable("t1", "bot").map((r) => r.text)).toEqual(["A", "B"]);
  });

  it("there is no timeout: a barrier outlives any wait, only the turn ending (or the answer) releases it", () => {
    vi.useFakeTimers();
    try {
      const a = accept(sendStore, "A", "send-aaaaaaaaaaaaaaa2").row;
      const b = accept(sendStore, "B", "send-bbbbbbbbbbbbbbb2").row;
      sendStore.settle(a.seq, "unconfirmed", "m-a");
      sendStore.holdForLateAnswer(a.seq);
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(sendStore.blockedByEarlier("t1", b.seq)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("a late refusal after a LATER message already went to the engine is failed, never queued behind it", () => {
    const a = accept(sendStore, "A", "send-aaaaaaaaaaaaaaa3").row;
    const b = accept(sendStore, "B", "send-bbbbbbbbbbbbbbb3").row;
    sendStore.settle(a.seq, "unconfirmed", "m-a");
    sendStore.holdForLateAnswer(a.seq);
    queueSteeredMessage("bot-1", "t1", "B", { rowSeq: b.seq });
    // the turn ended; the drain releases A's hold and runs B
    const store = idleStore();
    drainSteeredMessages(store, () => {});
    expect(store.lines.map((l) => l.text)).toEqual(["B"]);
    const outcome: string[] = [];
    reconcileLateSteer({
      botExists: () => true, patchMessage: () => null,
      delivered: () => outcome.push("delivered"),
      passedByLater: (t, seq) => sendStore.hasPassed(t, seq),
      requeue: () => outcome.push("requeue"),
      fail: (seq) => { sendStore.settle(seq, "failed"); outcome.push("fail"); },
      release: () => {}, drain: () => {},
    }, { botId: "bot-1", threadId: "t1", seq: a.seq, messageId: "m-a" }, "rejected");
    expect(outcome).toEqual(["fail"]);
    expect(sendStore.bySeq(a.seq)!.status).toBe("failed");
    // and the same send id is retryable as a fresh row
    expect(accept(sendStore, "A", "send-aaaaaaaaaaaaaaa3").kind).toBe("new");
  });

  it("ThreadAdmission runs one thread's sends strictly in order", async () => {
    const admission = new ThreadAdmission();
    const seen: string[] = [];
    const slow = admission.run("t1", async () => { await new Promise((r) => setTimeout(r, 20)); seen.push("A"); });
    const fast = admission.run("t1", async () => { seen.push("B"); });
    await Promise.all([slow, fast]);
    expect(seen).toEqual(["A", "B"]);
  });
});

describe("restart: the rows are read, nothing is sent twice", () => {
  it("a crash after the dispatched marker and before the engine's answer shows the message as unconfirmed and never resends it", () => {
    const { open } = fileDb();
    const first = new SendStore(open());
    const row = accept(first, "maybe sent", "send-eeeeeeeeeeeeeeee").row;
    first.markDispatched(row.seq);
    // ---- the app dies here; a new run opens the same file ----
    const second = new SendStore(open());
    const recovered = second.recover();
    expect(recovered.unresolved.map((r) => r.text)).toEqual(["maybe sent"]);
    expect(recovered.requeued).toEqual([]);
    second.completeUnresolved(recovered.unresolved, transcriptIo([]));
    expect(second.bySeq(row.seq)!.status).toBe("unconfirmed");
    expect(second.drainable("t1", "bot")).toEqual([]);
    // the same send id comes back: the one row, no second dispatch
    const again = accept(second, "maybe sent", "send-eeeeeeeeeeeeeeee");
    expect(again.kind).toBe("existing");
    expect(again.row.seq).toBe(row.seq);
  });

  it("rows that never reached the engine resume in their original order, once", () => {
    const { open } = fileDb();
    const first = new SendStore(open());
    accept(first, "one", "send-ffffffffffffff01");
    const two = accept(first, "two", "send-ffffffffffffff02").row;
    first.queue(two.seq);
    accept(first, "three", "send-ffffffffffffff03");
    const second = new SendStore(open());
    expect(second.recover().requeued.map((r) => r.text)).toEqual(["one", "three"]);
    sendStore.use(open());
    const store = idleStore();
    const run = vi.fn();
    drainSteeredMessages(store, run);
    drainSteeredMessages(store, run);
    expect(store.lines.map((l) => l.text)).toEqual(["one", "two", "three"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("drain is dispatch-once: the marker is committed before the line is appended", () => {
    const db = new DatabaseSync(":memory:");
    sendStore.use(() => db);
    const row = accept(sendStore, "once", "send-gggggggggggggggg").row;
    queueSteeredMessage("bot-1", "t1", "once", { rowSeq: row.seq });
    const store = idleStore();
    const appendedWhen: boolean[] = [];
    const real = store.appendMessage;
    store.appendMessage = (t, m, id) => { appendedWhen.push(sendStore.bySeq(row.seq)!.dispatched); return real(t, m, id); };
    drainSteeredMessages(store, () => {});
    expect(appendedWhen).toEqual([true]);
    drainSteeredMessages(store, () => {});
    expect(store.lines).toHaveLength(1);
  });

  it("a cancelled send stays cancelled after 600 other sends (no record cap)", () => {
    const row = accept(sendStore, "cancel me", "send-hhhhhhhhhhhhhhhh").row;
    queueSteeredMessage("bot-1", "t1", "cancel me", { rowSeq: row.seq });
    expect(cancelSteeredMessage("bot-1", row.queueId)).toBe(true);
    for (let i = 0; i < 600; i++) {
      const other = accept(sendStore, `other ${i}`, `send-other-${String(i).padStart(10, "0")}`).row;
      sendStore.settle(other.seq, "started", `m${i}`);
    }
    const retry = accept(sendStore, "cancel me", "send-hhhhhhhhhhhhhhhh");
    expect(retry.kind).toBe("existing");
    expect(retry.row.status).toBe("cancelled");
    expect(queuedSteeredMessage("bot-1", "t1", "send-hhhhhhhhhhhhhhhh")).toBeNull();
  });

  it("a definitive refusal is recorded as failed (not released): the same id can be tried again as a new row", () => {
    const row = accept(sendStore, "try again", "send-iiiiiiiiiiiiiiii").row;
    sendStore.settle(row.seq, "failed");
    const retry = accept(sendStore, "try again", "send-iiiiiiiiiiiiiiii");
    expect(retry.kind).toBe("new");
    expect(retry.row.seq).toBeGreaterThanOrEqual(row.seq);
  });
});

describe("rooms use the same rows, with or without the durable room queue", () => {
  it("a busy room's fallback queue survives a restart, dedupes on the send id and runs once", () => {
    const { open } = fileDb();
    sendStore.use(open());
    const first = queueChannelMessage("g1", "gt1", "room words", { sendId: "send-jjjjjjjjjjjjjjjj", mode: "chat" });
    expect(queuedChannelMessage("g1", "gt1", "send-jjjjjjjjjjjjjjjj")?.id).toBe(first.id);
    // ---- restart: a new run reads the same file ----
    sendStore.reset();
    sendStore.use(open());
    sendStore.recover();
    expect(channelQueueThreads()).toEqual(["gt1"]);
    expect(queueChannelMessage("g1", "gt1", "room words", { sendId: "send-jjjjjjjjjjjjjjjj", mode: "chat" }).id).toBe(first.id);
    const run = vi.fn(() => ({ messageId: "line-j" }));
    drainChannelMessages(() => true, run);
    expect(run).not.toHaveBeenCalled();
    drainChannelMessages(() => false, run);
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: first.id, text: "room words", groupId: "g1" }));
  });

  it("a cancelled room send answers cancelled to a retry", () => {
    const queued = queueChannelMessage("g1", "gt2", "drop", { sendId: "send-kkkkkkkkkkkkkkkk" });
    expect(cancelChannelMessage("g1", queued.id)).toBe(true);
    expect(queueChannelMessage("g1", "gt2", "drop", { sendId: "send-kkkkkkkkkkkkkkkk" }).status).toBe("cancelled");
  });

  it("a room queue that cannot be written refuses instead of holding the send in memory", () => {
    const db = new DatabaseSync(":memory:");
    sendStore.use(() => db);
    initializeOwnerSends(db);
    db.exec("PRAGMA query_only=ON");
    expect(() => queueChannelMessage("g1", "gt3", "lost?", { sendId: "send-llllllllllllllll" })).toThrow();
    db.exec("PRAGMA query_only=OFF");
    expect(channelQueueThreads()).toEqual([]);
  });
});

describe("what the client is shown", () => {
  it("a row being sent and a row waiting are both visible, in order", () => {
    const a = accept(sendStore, "now", "send-mmmmmmmmmmmmmmm1").row;
    const b = accept(sendStore, "later", "send-mmmmmmmmmmmmmmm2").row;
    sendStore.queue(b.seq);
    expect(sendStore.pending("t1").map(pendingItem)).toEqual([
      { queueId: "sending:send-mmmmmmmmmmmmmmm1", sendId: "send-mmmmmmmmmmmmmmm1", text: "now", state: "sending" },
      { queueId: b.queueId, sendId: "send-mmmmmmmmmmmmmmm2", text: "later", state: "queued" },
    ]);
    void a;
  });
});

describe("round 5: a transition and its visible effect are committed together", () => {
  it("1. a dispatched row and an unconfirmed row with no line each get their line and notice in one transaction, on every start", () => {
    const { open } = fileDb();
    const first = new SendStore(open());
    const a = accept(first, "was in flight", "send-r5a-aaaaaaaaaaaa").row;
    first.markDispatched(a.seq);
    // an unconfirmed row that an earlier build left without its line (the crash window of round 4)
    const b = accept(first, "left hidden", "send-r5a-bbbbbbbbbbbb").row;
    first.markDispatched(b.seq);
    first.settle(b.seq, "unconfirmed");
    expect(first.bySeq(b.seq)!.messageId).toBeNull();

    const second = new SendStore(open());
    const io = transcriptIo([]);
    const done = second.completeUnresolved(second.recover().unresolved, io);
    expect(done.recorded).toBe(2);
    expect(io.written.filter((l) => l.text).map((l) => l.text)).toEqual(["was in flight", "left hidden"]);
    expect(io.written.filter((l) => l.notice)).toHaveLength(2);
    for (const seq of [a.seq, b.seq]) {
      const row = second.bySeq(seq)!;
      expect(row.status).toBe("unconfirmed");
      expect(row.notice).toBe("notConfirmed");
      expect(io.written.some((l) => l.id === row.messageId)).toBe(true);
      expect(row.text).toBe("");
    }
    // the next start finds the lines and writes nothing more
    const third = new SendStore(open());
    expect(third.completeUnresolved(third.recover().unresolved, io)).toEqual({ started: 0, recorded: 0 });
    expect(io.written).toHaveLength(4);
  });

  it("1. a failure while writing the receipt leaves the row as it was, so the next start completes it (never an unconfirmed row with no line)", () => {
    const { open } = fileDb();
    const first = new SendStore(open());
    const row = accept(first, "crash window", "send-r5a-cccccccccccc").row;
    first.markDispatched(row.seq);
    const second = new SendStore(open());
    const broken = transcriptIo([], "notice");
    expect(second.completeUnresolved(second.recover().unresolved, broken).recorded).toBe(0);
    expect(second.bySeq(row.seq)!.status).toBe("dispatched");
    expect(second.bySeq(row.seq)!.text).toBe("crash window");
    const third = new SendStore(open());
    const io = transcriptIo([]);
    expect(third.completeUnresolved(third.recover().unresolved, io).recorded).toBe(1);
    expect(third.bySeq(row.seq)!.status).toBe("unconfirmed");
  });

  it("1. a dispatched row whose line is in the transcript becomes started, not a second line", () => {
    const { open } = fileDb();
    const first = new SendStore(open());
    const row = accept(first, "landed", "send-r5a-dddddddddddd").row;
    first.markDispatched(row.seq);
    const second = new SendStore(open());
    const io = transcriptIo([{ id: "line-9", sendId: "send-r5a-dddddddddddd" }]);
    expect(second.completeUnresolved(second.recover().unresolved, io)).toEqual({ started: 1, recorded: 0 });
    expect(second.bySeq(row.seq)).toMatchObject({ status: "started", messageId: "line-9", text: "" });
  });

  it("2. started and delivered need the line they became; a room message the room could not start is refused, keeps its words and is shown", () => {
    const row = accept(sendStore, "needs a line", "send-r5b-aaaaaaaaaaaa").row;
    expect(() => sendStore.settle(row.seq, "started")).toThrow(/transcript line/);
    expect(() => sendStore.settle(row.seq, "delivered")).toThrow(/transcript line/);
    expect(sendStore.bySeq(row.seq)!.status).toBe("sending");

    const queued = queueChannelMessage("g-r5", "gt-r5", "cannot start", { sendId: "send-r5b-bbbbbbbbbbbb", mode: "chat", responderBotId: "gone" });
    drainChannelMessages(() => false, () => ({ refused: true }));
    const kept = sendStore.byQueueId("g-r5", queued.id)!;
    expect(kept).toMatchObject({ status: "refused", notice: "refused", text: "cannot start" });
    expect(sendStore.pending("gt-r5").map(pendingItem)).toEqual([
      { queueId: queued.id, sendId: "send-r5b-bbbbbbbbbbbb", text: "cannot start", state: "refused", notice: "refused", mode: "chat", responderId: "gone" },
    ]);
    // it does not hold the line, and it is not drained again
    expect(sendStore.drainable("gt-r5", "group")).toEqual([]);
    const run = vi.fn(() => ({ messageId: "x" }));
    drainChannelMessages(() => false, run);
    expect(run).not.toHaveBeenCalled();
    // a run that throws is the same refusal
    const thrown = queueChannelMessage("g-r5", "gt-r5b", "throws", { sendId: "send-r5b-cccccccccccc" });
    drainChannelMessages(() => false, () => { throw new Error("room closed"); });
    expect(sendStore.byQueueId("g-r5", thrown.id)).toMatchObject({ status: "refused", text: "throws" });
    // Send again: the same id is a NEW attempt; Dismiss: cancelled, words dropped
    const again = queueChannelMessage("g-r5", "gt-r5", "cannot start", { sendId: "send-r5b-bbbbbbbbbbbb", mode: "chat", responderBotId: "gone" });
    expect(again.id).not.toBe(queued.id);
    expect(again.status).toBe("queued");
    expect(cancelChannelMessage("g-r5", thrown.id)).toBe(true);
    expect(sendStore.byQueueId("g-r5", thrown.id)).toMatchObject({ status: "cancelled", text: "" });
  });

  it("2. a drained room message settles started with its line, and its words and prompt are dropped", () => {
    const queued = queueChannelMessage("g-r5c", "gt-r5c", "runs", { sendId: "send-r5c-aaaaaaaaaaaa" });
    drainChannelMessages(() => false, () => ({ messageId: "line-runs" }));
    expect(sendStore.byQueueId("g-r5c", queued.id)).toMatchObject({ status: "started", messageId: "line-runs", text: "", prompt: null });
  });

  it("settleWithLine rolls the row back when the line cannot be written", () => {
    const { open } = fileDb();
    const store = new SendStore(open());
    const row = accept(store, "atomic", "send-r5d-aaaaaaaaaaaa").row;
    store.markDispatched(row.seq);
    expect(() => store.settleWithLine(row.seq, "unconfirmed", "line-x", () => { throw new Error("thread gone"); }, "notConfirmed")).toThrow(/thread gone/);
    expect(store.bySeq(row.seq)).toMatchObject({ status: "dispatched", text: "atomic", messageId: null });
    const written = store.settleWithLine(row.seq, "delivered", "line-y", () => ({ id: "actual-line" }));
    expect(written.id).toBe("actual-line");
    expect(store.bySeq(row.seq)).toMatchObject({ status: "delivered", messageId: "actual-line" });
  });

  it("7. the fingerprint is a hash, terminal rows drop words and quoted prompt, and a hashed fingerprint still detects a conflicting retry", () => {
    const secret = "my secret plan for the quarter";
    const row = accept(sendStore, secret, "send-r5e-aaaaaaaaaaaa", { prompt: `> quoted\n${secret}` }).row;
    expect(row.fingerprint).toBe(createHash("sha256").update(fp(secret)).digest("hex"));
    expect(row.fingerprint).not.toContain("secret");
    expect(accept(sendStore, secret, "send-r5e-aaaaaaaaaaaa").kind).toBe("existing");
    expect(accept(sendStore, "something else", "send-r5e-aaaaaaaaaaaa").kind).toBe("conflict");
    for (const status of ["started", "delivered", "failed", "cancelled"] as const) {
      const r = accept(sendStore, secret, `send-r5e-${status}-0000000`, { prompt: `> quoted ${secret}` }).row;
      sendStore.settle(r.seq, status, status === "cancelled" ? undefined : "line-1");
      expect(sendStore.bySeq(r.seq)).toMatchObject({ text: "", prompt: null });
    }
    // an unconfirmed steer may still be put back in line, so it keeps its words until it is answered or the turn ends
    const u = accept(sendStore, secret, "send-r5e-unconfirmed-000", { prompt: `> quoted ${secret}` }).row;
    sendStore.holdForLateAnswer(u.seq);
    sendStore.settle(u.seq, "unconfirmed", "line-u");
    expect(sendStore.bySeq(u.seq)).toMatchObject({ text: secret, prompt: `> quoted ${secret}` });
    sendStore.releaseThreadLate("t1");
    expect(sendStore.bySeq(u.seq)).toMatchObject({ text: "", prompt: null });
    // a row with no line yet is never scrubbed: its words are all that is left of it
    const n = accept(sendStore, secret, "send-r5e-noline-0000000").row;
    sendStore.settle(n.seq, "unconfirmed");
    sendStore.scrub(n.seq);
    expect(sendStore.bySeq(n.seq)!.text).toBe(secret);
  });

  it("7. pruning runs by age and by row count, never touches live, refused or receipt-less rows, and uses the indexes", async () => {
    const rows: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = accept(sendStore, `old ${i}`, `send-r5f-${String(i).padStart(12, "0")}`).row;
      sendStore.settle(r.seq, "started", `line-${i}`);
      rows.push(r.seq);
    }
    const live = accept(sendStore, "live", "send-r5f-live00000000").row;
    const hidden = accept(sendStore, "no receipt yet", "send-r5f-hidden000000").row;
    sendStore.markDispatched(hidden.seq);
    sendStore.settle(hidden.seq, "unconfirmed");
    const q = queueChannelMessage("g-r5f", "gt-r5f", "refused", { sendId: "send-r5f-refused00000" });
    drainChannelMessages(() => false, () => ({ refused: true }));
    // count cap: keep the newest 5 finished rows
    expect(await sendStore.pruneResolved(1e12, Date.now(), 5)).toBe(7);
    expect(rows.filter((seq) => sendStore.bySeq(seq))).toHaveLength(5);
    // age: everything finished and old goes
    expect(await sendStore.pruneResolved(0, Date.now() + 1000, 5000)).toBe(5);
    expect(sendStore.bySeq(live.seq)).toBeDefined();
    expect(sendStore.bySeq(hidden.seq)!.text).toBe("no receipt yet");
    expect(sendStore.byQueueId("g-r5f", q.id)!.status).toBe("refused");
    // the enumerations the drain and the chips run start from the status, not from history
    const db = new DatabaseSync(":memory:");
    initializeOwnerSends(db);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='owner_sends'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["owner_sends_status", "owner_sends_age", "owner_sends_open"]));
    const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    expect(plan("SELECT DISTINCT thread_id FROM owner_sends WHERE status='queued'")).toMatch(/owner_sends_status/);
    expect(plan("SELECT DISTINCT thread_id FROM owner_sends WHERE status IN ('sending','dispatched','queued','refused')")).toMatch(/owner_sends_status/);
    expect(plan("DELETE FROM owner_sends WHERE status IN ('started') AND updated_at<1")).toMatch(/owner_sends_age/);
  });

  it("7. a table made before the notice column was added is upgraded in place", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE owner_sends (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('bot','group')), owner_id TEXT NOT NULL, thread_id TEXT NOT NULL, send_id TEXT, queue_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, text TEXT, prompt TEXT, reply_to_id TEXT, origin TEXT, mode TEXT, responder_id TEXT, existing_message_id TEXT, message_id TEXT, status TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    initializeOwnerSends(db);
    const columns = (db.prepare("PRAGMA table_info(owner_sends)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain("notice");
    initializeOwnerSends(db);
  });

  it("8. the notice is stored as a code, never as a sentence", () => {
    const row = accept(sendStore, "late", "send-r5g-aaaaaaaaaaaa").row;
    sendStore.settle(row.seq, "failed", undefined, "lateRefused");
    expect(sendStore.bySeq(row.seq)!.notice).toBe("lateRefused");
    expect(sendNoticeLine("lateRefused")).toEqual({ role: "bot", kind: "activity", tool: { name: "send-notice:lateRefused", ok: false, notice: true } });
  });
});
