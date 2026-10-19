// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Round 29, bug A (Sean): a message the owner left waiting when they pressed Stop is never run on its own by a restart. It is held as a chip (Send again /
// Dismiss, the "may not have reached the bot" copy). Stop-then-steer inside a running session works as before. Bug B: a held message keeps the time it was
// typed, through the restart and through Send again. Each test fails on 28ff1c01e.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendFingerprint } from "./send-idempotency.ts";
import { pendingItem, sendStore } from "./send-store.ts";
import { drainSteeredMessages, type SteerStore } from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
const handles: DatabaseSync[] = [];
let file = "";
/** One process's connection to the conversation database (a new one is a restart). */
const start = () => { const db = new DatabaseSync(file); handles.push(db); sendStore.reset(); sendStore.use(() => db); };
beforeEach(() => { const dir = mkdtempSync(join(tmpdir(), "r29-stop-")); dirs.push(dir); file = join(dir, "messages.db"); start(); });
afterEach(() => { sendStore.reset(); for (const h of handles.splice(0)) { try { h.close(); } catch { /* closed */ } } for (const d of dirs.splice(0)) removeTempDirSync(d); });

function idleBot(): SteerStore & { lines: Message[]; runs: string[] } {
  const lines: Message[] = [];
  const runs: string[] = [];
  const bot = { id: "bot-1", threadId: "t1", busy: false } as unknown as BotRecord;
  return {
    lines, runs,
    bot: () => bot,
    appendMessage: (_threadId, message, stableId) => { const full = { id: stableId ?? `m${lines.length + 1}`, at: 1, ...message } as Message; lines.push(full); return full; },
    messagesFor: () => lines,
    patchMessage: () => null,
  };
}
const drain = (store: ReturnType<typeof idleBot>) => drainSteeredMessages(store, (_bot, _thread, prompt) => { store.runs.push(prompt); });
const TYPED = 1_700_000_000_000;
/** A message sent to the busy bot: it waits, typed at `at`. */
const waiting = (text: string, sendId: string, at = TYPED) => sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", text, sendId, fingerprint: sendFingerprint(text), status: "queued", now: at });

describe("bug A: a stopped conversation's waiting messages are held by a restart", () => {
  it("stop, then restart: nothing runs, the row is held (Send again / Dismiss, the not-sure copy) at its typed time; Send again runs it once", () => {
    waiting("summarize the report", "s1");
    sendStore.markStopped("t1");                                                       // the owner pressed Stop
    start();                                                                           // Murage restarts before the bot settled
    sendStore.recover();
    const bot = idleBot();
    drain(bot);
    expect(bot.runs).toEqual([]);
    const [held] = sendStore.pending("t1");
    expect(held).toMatchObject({ status: "refused", notice: "notConfirmed", text: "summarize the report", createdAt: TYPED });
    expect(pendingItem(held!)).toMatchObject({ state: "refused", notice: "notConfirmed", at: TYPED });
    // Send again: the same send, by the owner's explicit press (a fresh action token, and the stop token the held chip shows: round 31)
    const again = sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", text: "summarize the report", sendId: "s1", fingerprint: sendFingerprint("summarize the report"), status: "queued", resend: true, actionId: "press-1", stopGen: pendingItem(held!).stopGen!, now: TYPED + 60_000 });
    expect(again.kind).toBe("new");
    expect(again.row.createdAt).toBe(TYPED);                                           // bug B: still the time it was typed
    drain(bot);
    drain(bot);
    expect(bot.runs).toEqual(["summarize the report"]);
  });
  it("stop, then restart, then Dismiss: the held row is dropped and never runs", () => {
    waiting("draft the email", "s2");
    sendStore.markStopped("t1");
    start();
    sendStore.recover();
    const [held] = sendStore.pending("t1");
    expect(sendStore.cancel("bot-1", held!.queueId)?.status).toBe("cancelled");
    const bot = idleBot();
    drain(bot);
    expect(bot.runs).toEqual([]);
    expect(sendStore.pending("t1")).toEqual([]);
  });
  it("stop, then a steer in the same session: the waiting message and the steer run, as before", () => {
    waiting("first", "s3");
    sendStore.markStopped("t1");
    waiting("actually, do this instead", "s4", TYPED + 1);                             // typed after Stop
    const bot = idleBot();
    drain(bot);                                                                        // the stopped turn settled: the queue runs
    expect(bot.runs).toEqual(["first\nactually, do this instead"]);
  });
  it("a message typed after Stop is not held by a restart", () => {
    waiting("old", "s5");
    sendStore.markStopped("t1");
    waiting("new", "s6", TYPED + 1);
    start();
    sendStore.recover();
    expect(sendStore.pending("t1").map((row) => [row.text, row.status])).toEqual([["old", "refused"], ["new", "queued"]]);
  });
});
