// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Round 32: Astra r31c P1. A row stopped by a build before the stop token existed (dev builds like 98e34e2de) has stop_gen NULL after the migration; its held
// chip then carried no token and every fresh Send again was refused, for good. Now every stopped row gets a token minted on open, so ONE fresh press runs it
// exactly once and a stale automatic resend runs nothing. Fails on cf0af59d9.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainChannelMessages, queueChannelMessage } from "./channel-queue.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import { pendingItem, sendStore } from "./send-store.ts";
import { drainSteeredMessages, type SteerStore } from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";

const TEXT = "summarize the report";

describe("a stopped row from a build without the stop token is not stuck", () => {
  const dirs: string[] = [];
  const handles: DatabaseSync[] = [];
  let file = "";
  const start = () => { const db = new DatabaseSync(file); handles.push(db); sendStore.reset(); sendStore.use(() => db); };
  beforeEach(() => { const dir = mkdtempSync(join(tmpdir(), "r32-")); dirs.push(dir); file = join(dir, "messages.db"); });
  afterEach(() => { sendStore.reset(); for (const h of handles.splice(0)) { try { h.close(); } catch { /* closed */ } } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  /** Build the row through the real store, Stop it, then take the table back to the 98e34e2de schema: stopped, but no stop_gen and no action_id. */
  const seed = (q: Queue, status: string) => {
    start();
    q.send();
    if (status === "refused") sendStore.refuse(sendStore.pending(q.thread)[0]!.seq);
    expect(sendStore.markStopped(q.thread)).toBe(status === "refused" ? 0 : 1);
    if (status === "refused") sendStore.pending(q.thread);
    const raw = new DatabaseSync(file);
    if (status === "refused") raw.exec("UPDATE owner_sends SET stopped=1");
    raw.exec("ALTER TABLE owner_sends DROP COLUMN stop_gen; ALTER TABLE owner_sends DROP COLUMN action_id;");
    raw.close();
  };

  interface Queue { thread: string; send(press?: { resend: true; actionId: string; stopGen?: string }): void; drain(): void; runs: string[] }
  function botQueue(): Queue {
    const lines: Message[] = []; const runs: string[] = [];
    const bot = { id: "bot-1", threadId: "t1", busy: false } as unknown as BotRecord;
    const store: SteerStore = {
      bot: () => bot,
      appendMessage: (_t, message, stableId) => { const full = { id: stableId ?? `m${lines.length + 1}`, at: 1, ...message } as Message; lines.push(full); return full; },
      messagesFor: () => lines, patchMessage: () => null,
    };
    return {
      thread: "t1", runs,
      send: (press) => { sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t1", text: TEXT, sendId: "s1", fingerprint: sendFingerprint(TEXT), status: "queued", ...press }); },
      drain: () => drainSteeredMessages(store, (_b, _t, prompt) => { runs.push(prompt); }),
    };
  }
  function roomQueue(): Queue {
    const runs: string[] = [];
    return {
      thread: "g-thread", runs,
      send: (press) => { queueChannelMessage("g1", "g-thread", TEXT, { sendId: "s1", ...press }); },
      drain: () => drainChannelMessages(() => false, (input) => { runs.push(input.text); return { messageId: `line-${runs.length}` }; }),
    };
  }
  for (const [name, make] of [["owner sends", botQueue], ["channel queue", roomQueue]] as const) {
    for (const status of ["queued", "refused"]) {
      it(`${name}, stopped row (${status}) from the old schema: three restarts hold it, a stale resend runs nothing, one fresh press runs it once`, () => {
        const q = make();
        seed(q, status);
        for (let i = 0; i < 3; i++) { start(); sendStore.recover(); q.drain(); }
        expect(q.runs).toEqual([]);
        const held = sendStore.pending(q.thread);
        expect(held.map((row) => row.status)).toEqual(["refused"]);
        const chip = pendingItem(held[0]!);
        expect(chip.stopGen).toBeTruthy();                                  // the chip carries a minted token
        q.send({ resend: true, actionId: "stale-1" });                      // an automatic resend with no token
        q.send({ resend: true, actionId: "stale-2", stopGen: "a-guess" });
        q.drain();
        expect(q.runs).toEqual([]);
        start(); sendStore.recover();                                       // another restart: the token is stable
        expect(pendingItem(sendStore.pending(q.thread)[0]!).stopGen).toBe(chip.stopGen);
        const press = { resend: true as const, actionId: "press-1", stopGen: chip.stopGen! };
        q.send(press); q.drain(); q.drain();
        q.send(press); q.send({ resend: true, actionId: "stale-1" }); q.drain();
        expect(q.runs).toEqual([TEXT]);
      });
    }
  }
});
