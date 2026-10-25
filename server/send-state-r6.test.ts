// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One test per transition of the state table at the top of send-store.ts. The invariant under test:
// an accepted owner send's words are kept until a transcript line holds them or the owner dismisses it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendStore, pendingItem, type SendRow } from "./send-store.ts";
import { drainSteeredMessages, queueSteeredMessage, type SteerStore } from "./steer-queue.ts";
import { queueChannelMessage, drainChannelMessages, cancelChannelMessage } from "./channel-queue.ts";
import { reconcileLateSteer } from "./steer-late.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import type { BotRecord, Message } from "./store.ts";

beforeEach(() => sendStore.reset());
afterEach(() => sendStore.reset());

const WORDS = "R6_WORDS the person typed";
const accept = (sendId: string, over: Record<string, unknown> = {}) =>
  sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", sendId, text: WORDS, fingerprint: sendFingerprint(WORDS), ...over }).row;
const text = (seq: number) => sendStore.bySeq(seq)!.text;
const bot = (busy = false) => ({ id: "bot-1", threadId: "t1", busy, name: "b" }) as unknown as BotRecord;
function steerStore(opts: { bots?: BotRecord[]; failAppend?: boolean } = {}): SteerStore & { lines: Message[] } {
  const lines: Message[] = [];
  const bots = opts.bots ?? [bot()];
  const api = {
    lines,
    bot: (id: string) => bots.find((b) => b.id === id) ?? null,
    appendMessage: (_t: string, message: Record<string, unknown>, id?: string) => {
      if (opts.failAppend) throw new Error("disk full");
      const full = { id: id ?? `m${lines.length}`, at: 0, ...message } as unknown as Message;
      lines.push(full);
      return full;
    },
    patchMessage: () => null,
  };
  return api as unknown as SteerStore & { lines: Message[] };
}

describe("send state table: every transition keeps the words until a line or the owner's dismissal", () => {
  it("sending, queued and dispatched hold the words", () => {
    const a = accept("send-r6-sending-00000001");
    expect(text(a.seq)).toBe(WORDS);
    sendStore.queue(a.seq);
    expect(text(a.seq)).toBe(WORDS);
    sendStore.markDispatchedMany([a.seq]);
    expect(sendStore.bySeq(a.seq)).toMatchObject({ status: "dispatched", text: WORDS });
  });

  it("an accepted refused row (a room request the room closed) is a chip with the words and a localized notice", () => {
    const row = sendStore.accept({ kind: "group", ownerId: "g1", threadId: "gt1", sendId: "send-r6-roomrefused-0001", text: WORDS, status: "refused", notice: "refused", fingerprint: sendFingerprint(WORDS, undefined, "chat", undefined), mode: "chat" }).row;
    expect(row).toMatchObject({ status: "refused", notice: "refused", text: WORDS });
    expect(pendingItem(row)).toMatchObject({ state: "refused", text: WORDS, notice: "refused", sendId: "send-r6-roomrefused-0001" });
    expect(sendStore.pending("gt1").map((r) => r.seq)).toEqual([row.seq]);
  });

  it("dispatched -> refused keeps the words, and recover() leaves a refused row alone", () => {
    const a = accept("send-r6-refused-00000001");
    sendStore.markDispatched(a.seq);
    sendStore.refuse(a.seq);
    expect(sendStore.bySeq(a.seq)).toMatchObject({ status: "refused", text: WORDS, dispatched: false });
    const { requeued, unresolved } = sendStore.recover();
    expect([...requeued, ...unresolved]).toHaveLength(0);
    expect(sendStore.pending("t1").map((r) => r.status)).toEqual(["refused"]);
    expect(sendStore.pendingThreads()).toEqual(["t1"]);
  });

  it("dispatched -> failed with no transcript line keeps the words; with the line it clears them", () => {
    const a = accept("send-r6-failed-000000001");
    sendStore.markDispatched(a.seq);
    sendStore.settle(a.seq, "failed");
    expect(text(a.seq)).toBe(WORDS);
    const b = accept("send-r6-failedline-0001");
    sendStore.settle(b.seq, "failed", "line-b", "lateRefused");
    expect(text(b.seq)).toBe("");
  });

  it("the owner's dismissal (refused -> cancelled) is the only thing that clears a refused row", () => {
    const a = accept("send-r6-dismiss-00000001");
    sendStore.refuse(a.seq);
    expect(sendStore.cancel("bot-1", a.queueId)).not.toBeNull();
    expect(sendStore.bySeq(a.seq)).toMatchObject({ status: "cancelled", text: "" });
  });

  it("a bot drain whose transcript append fails keeps the words as a refused row (pending and after a restart)", () => {
    const queued = queueSteeredMessage("bot-1", "t1", WORDS, { sendId: "send-r6-append-0000001" });
    const store = steerStore({ failAppend: true });
    drainSteeredMessages(store, () => {});
    const row = sendStore.byQueueId("bot-1", queued.id)!;
    expect(row).toMatchObject({ status: "refused", text: WORDS });
    expect(pendingItem(row)).toMatchObject({ state: "refused", text: WORDS });
    expect(sendStore.recover().unresolved).toHaveLength(0);
    expect(sendStore.bySeq(row.seq)).toMatchObject({ status: "refused", text: WORDS });
    expect(store.lines).toHaveLength(0);
  });

  it("a deleted bot's waiting words are kept as refused, never cleared by the system", () => {
    const queued = queueSteeredMessage("bot-1", "t1", WORDS, { sendId: "send-r6-botgone-0000001" });
    drainSteeredMessages(steerStore({ bots: [] }), () => {});
    expect(sendStore.byQueueId("bot-1", queued.id)).toMatchObject({ status: "refused", text: WORDS });
  });

  it("a room drain that cannot start the message keeps it as a refused chip", () => {
    const q = queueChannelMessage("g1", "gt1", WORDS, { sendId: "send-r6-roomdrain-000001" });
    drainChannelMessages(() => false, () => ({ refused: true }));
    expect(sendStore.byQueueId("g1", q.id)).toMatchObject({ status: "refused", text: WORDS });
    expect(cancelChannelMessage("g1", q.id)).toBe(true);
  });

  it("unconfirmed keeps the words while a late answer can still arrive; a late refusal that was passed clears them only with the line", () => {
    const a = accept("send-r6-late-00000000001");
    sendStore.markDispatched(a.seq);
    sendStore.holdForLateAnswer(a.seq);
    sendStore.settle(a.seq, "unconfirmed", "line-a");
    expect(text(a.seq)).toBe(WORDS);
    const calls: Array<[number, string, string]> = [];
    reconcileLateSteer({
      botExists: () => true, patchMessage: () => null, delivered: () => {}, passedByLater: () => true, requeue: () => {},
      fail: (seq, threadId, messageId) => { calls.push([seq, threadId, messageId]); sendStore.settle(seq, "failed", messageId, "lateRefused"); },
      release: (seq) => sendStore.releaseLateAnswer(seq), drain: () => {},
    }, { botId: "bot-1", threadId: "t1", seq: a.seq, messageId: "line-a" }, "rejected");
    expect(calls).toEqual([[a.seq, "t1", "line-a"]]);
    expect(sendStore.bySeq(a.seq)).toMatchObject({ status: "failed", text: "" });
  });

  it("send again: the replacement attempt (same sendId) replaces the refused row in the same transaction it is accepted", () => {
    const old = accept("send-r6-again-00000001");
    sendStore.refuse(old.seq);
    const again = sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", sendId: "send-r6-again-00000001", text: WORDS, fingerprint: sendFingerprint(WORDS) });
    expect(again.kind).toBe("new");
    expect(sendStore.byQueueId("bot-1", old.queueId)).toBeUndefined();
    expect(sendStore.bySendId("t1", "send-r6-again-00000001")).toMatchObject({ status: "sending", text: WORDS });
  });

  it("retire() is a separate step the caller takes only after the replacement lands; until then the chip stays", () => {
    const old = accept("send-r6-retire-0000001");
    sendStore.refuse(old.seq);
    expect(sendStore.bySeq(old.seq)).toMatchObject({ status: "refused", text: WORDS });
    sendStore.retire(old.seq);
    expect(sendStore.bySeq(old.seq)).toBeUndefined();
  });
});

describe("pruning only removes rows whose words are in the transcript or dismissed", () => {
  const ago = (seq: number, ms: number) => (sendStore as unknown as { db(): { prepare(s: string): { run(...a: unknown[]): unknown } } }).db().prepare("UPDATE owner_sends SET updated_at=? WHERE seq=?").run(Date.now() - ms, seq);
  const DAY = 24 * 60 * 60 * 1000;

  it("never removes non-terminal rows, refused rows, failed rows with words, or an unconfirmed row in lateOpen, however old", async () => {
    const keep: SendRow[] = [];
    const queued = accept("send-r6-p-queued000001"); sendStore.queue(queued.seq); keep.push(queued);
    const sending = accept("send-r6-p-sending00001"); keep.push(sending);
    const dispatched = accept("send-r6-p-dispatched01"); sendStore.markDispatched(dispatched.seq); keep.push(dispatched);
    const refused = accept("send-r6-p-refused00001"); sendStore.refuse(refused.seq); keep.push(refused);
    const failed = accept("send-r6-p-failed000001"); sendStore.settle(failed.seq, "failed"); keep.push(failed);
    const barrier = accept("send-r6-p-barrier00001"); sendStore.markDispatched(barrier.seq);
    sendStore.holdForLateAnswer(barrier.seq); sendStore.settle(barrier.seq, "unconfirmed", "line-barrier");
    // even if its words were cleared by a bug elsewhere, it is an ordering barrier while in lateOpen
    (sendStore as any).db().prepare("UPDATE owner_sends SET text='' WHERE seq=?").run(barrier.seq);
    keep.push(barrier);
    const noLine = accept("send-r6-p-noline000001"); sendStore.markDispatched(noLine.seq); sendStore.settle(noLine.seq, "unconfirmed"); keep.push(noLine);
    for (const row of keep) ago(row.seq, 400 * DAY);
    // 5,000+ newer terminal rows must not push the barrier out either
    for (let i = 0; i < 12; i++) { const r = accept(`send-r6-p-done${String(i).padStart(8, "0")}`); sendStore.settle(r.seq, "started", `line-${i}`); }
    expect(await sendStore.pruneResolved(30 * DAY, Date.now(), 3)).toBe(9);
    for (const row of keep) expect(sendStore.bySeq(row.seq), row.sendId ?? "").toBeDefined();
    expect(sendStore.blockedByEarlier("t1", 1e9)).toBe(true);
  });

  it("removes a started, delivered, dismissed, failed-with-line and scrubbed-unconfirmed row", async () => {
    const make = (n: string, settle: (seq: number) => void) => { const r = accept(`send-r6-gone-${n}0000000`); settle(r.seq); ago(r.seq, 400 * DAY); return r; };
    const rows = [
      make("a", (s) => sendStore.settle(s, "started", "l1")),
      make("b", (s) => sendStore.settle(s, "delivered", "l2")),
      make("c", (s) => { sendStore.refuse(s); sendStore.cancel("bot-1", sendStore.bySeq(s)!.queueId); }),
      make("d", (s) => sendStore.settle(s, "failed", "l3", "lateRefused")),
      make("e", (s) => { sendStore.settle(s, "unconfirmed", "l4"); sendStore.scrub(s); }),
    ];
    expect(await sendStore.pruneResolved(30 * DAY)).toBe(5);
    for (const r of rows) expect(sendStore.bySeq(r.seq)).toBeUndefined();
  });

  it("works in fixed-size batches and yields to the event loop between them", async () => {
    for (let i = 0; i < 25; i++) { const r = accept(`send-r6-b-${String(i).padStart(12, "0")}`); sendStore.settle(r.seq, "started", `l${i}`); ago(r.seq, 400 * DAY); }
    const order: string[] = [];
    setImmediate(() => order.push("tick"));
    const done = sendStore.pruneResolved(30 * DAY, Date.now(), 5000, 5).then((n) => { order.push("done"); return n; });
    expect(await done).toBe(25);
    expect(order).toEqual(["tick", "done"]);
  });

  it("the row cap deletes the oldest finished rows in batches, keeping the newest", async () => {
    const seqs: number[] = [];
    for (let i = 0; i < 20; i++) { const r = accept(`send-r6-c-${String(i).padStart(12, "0")}`); sendStore.settle(r.seq, "started", `l${i}`); ago(r.seq, (30 - i) * 60 * 1000); seqs.push(r.seq); }
    expect(await sendStore.pruneResolved(1e12, Date.now(), 6, 4)).toBe(14);
    expect(seqs.filter((s) => sendStore.bySeq(s))).toEqual(seqs.slice(-6));
  });
});

describe("the routes keep a refused chip until its replacement is accepted", () => {
  it("send again retires the old row only after startGroupTurn / insertRoomRequest succeed, and a failed room-queue start keeps the words", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.indexOf("const message = startGroupTurn(current.id, text, replyTo, sendId, channelMode");
    expect(start).toBeGreaterThan(0);
    expect(source.indexOf("retireReopened();", start)).toBeGreaterThan(start);
    expect(source.slice(source.indexOf("The earlier failed or refused attempt of this send id stays"), start)).not.toMatch(/retireReopened\(\);/);
    const queued = source.indexOf('verb: "owner_send",\n                fromKind: "owner",');
    expect(source.indexOf("retireReopened();", queued)).toBeGreaterThan(queued);
    // the dispatcher failure path keeps the words as a refused chip instead of an English line without them
    expect(source).toMatch(/\/\/ The words were accepted[^\n]*\n\s*\/\/[^\n]*\n\s*afterRoomCompletion\(completeRequest\(database\(\), request\.id, \{ state: "failed", now: Date\.now\(\), outcomeNote: "could not start", ending: status\("delegated_turn_could_not_start", \{ why: "setup" \}\) \}, roomCompletionHooks\)\);/);
    expect(source).not.toContain("Your queued message could not start:");
  });
});
