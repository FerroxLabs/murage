// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Round 30, stopped messages (Astra r29c P1 and bug A for rooms). Both queues, the bot's owner sends and a room's channel queue, behave the same:
//  - a message waiting when the owner pressed Stop is held by a restart (Send again / Dismiss) and never runs on its own;
//  - an automatic retry of its id (its acknowledgement was lost) gets the held row back and never runs it: zero runs until Send again, then exactly one;
//  - Stop then a steer inside the same session still runs, as before.
// Each test fails on 7f28cf52b.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainChannelMessages, queueChannelMessage } from "./channel-queue.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import { sendStore } from "./send-store.ts";
import { drainSteeredMessages, type SteerStore } from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";

const dirs: string[] = [];
const handles: DatabaseSync[] = [];
let file = "";
/** One process's connection to the conversation database (a new one is a restart). */
const start = () => { const db = new DatabaseSync(file); handles.push(db); sendStore.reset(); sendStore.use(() => db); };
beforeEach(() => { const dir = mkdtempSync(join(tmpdir(), "r30-stop-")); dirs.push(dir); file = join(dir, "messages.db"); start(); });
afterEach(() => { sendStore.reset(); for (const h of handles.splice(0)) { try { h.close(); } catch { /* closed */ } } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The two queues, driven the way the server drives them: accept (the HTTP send and its retries), run what may start, Dismiss. */
interface Queue { name: string; thread: string; send(text: string, sendId: string, resend?: boolean): void; drain(): void; runs: string[]; dismiss(): void }
/** The owner's Send again on the chip as it is now: a fresh action token, and the stop token the held chip shows (round 31). */
const press = (thread: string) => { const chip = sendStore.pending(thread)[0]; return { resend: true as const, actionId: `press-${Math.random()}`, ...(chip?.stopGen ? { stopGen: chip.stopGen } : {}) }; };
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
    name: "owner sends", thread: "t1", runs,
    send: (text, sendId, resend) => { const accepted = sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", text, sendId, fingerprint: sendFingerprint(text), status: "queued", ...(resend ? press("t1") : {}) }); expect(accepted.kind).not.toBe("conflict"); },
    drain: () => drainSteeredMessages(store, (_bot, _thread, prompt) => { runs.push(prompt); }),
    dismiss: () => { const [held] = sendStore.pending("t1"); expect(sendStore.cancel("bot-1", held!.queueId)?.status).toBe("cancelled"); },
  };
}
function roomQueue(): Queue {
  const runs: string[] = [];
  return {
    name: "channel queue", thread: "g-thread", runs,
    send: (text, sendId, resend) => { queueChannelMessage("g1", "g-thread", text, { sendId, ...(resend ? press("g-thread") : {}) }); },
    drain: () => drainChannelMessages(() => false, (input) => { runs.push(input.text); return { messageId: `line-${runs.length}` }; }),
    dismiss: () => { const [held] = sendStore.pending("g-thread"); expect(sendStore.cancel("g1", held!.queueId)?.status).toBe("cancelled"); },
  };
}

for (const make of [botQueue, roomQueue]) {
  describe(`${make().name}: a stopped message waits for the owner`, () => {
    it("Astra r29c P1: stop, restart, then the same-id automatic retry (no resend): zero runs; Send again: exactly one", () => {
      const q = make();
      q.send("summarize the report", "s1");                                   // waiting; its acknowledgement is lost, the client will retry
      sendStore.markStopped(q.thread);                                         // the owner pressed Stop
      start();                                                                 // Murage restarts
      sendStore.recover();
      q.drain();
      expect(q.runs).toEqual([]);
      q.send("summarize the report", "s1");                                    // the outstanding retry of the same id arrives
      q.drain();
      q.send("summarize the report", "s1");                                    // and again
      q.drain();
      expect(q.runs).toEqual([]);
      expect(sendStore.pending(q.thread).map((row) => [row.text, row.status])).toEqual([["summarize the report", "refused"]]);
      q.send("summarize the report", "s1", true);                              // Send again: the owner's explicit press (after the Stop: it presents the chip's stop token)
      q.drain();
      q.drain();
      q.send("summarize the report", "s1");                                    // a late retry after it ran changes nothing
      q.drain();
      expect(q.runs).toEqual(["summarize the report"]);
    });
    it("stop, restart, Dismiss: dropped, and a later retry of its id does not bring it back", () => {
      const q = make();
      q.send("draft the email", "s2");
      sendStore.markStopped(q.thread);
      start();
      sendStore.recover();
      q.dismiss();
      q.drain();
      expect(q.runs).toEqual([]);
      expect(sendStore.pending(q.thread)).toEqual([]);
    });
    it("stop, then more words in the same session: what waits still runs (stop then steer)", () => {
      const q = make();
      q.send("first", "s3");
      sendStore.markStopped(q.thread);
      q.send("first", "s3");                                                   // a retry inside the session is the same waiting row
      q.drain();
      expect(q.runs.join("\n")).toContain("first");
      expect(q.runs).toHaveLength(1);
    });
  });
}
