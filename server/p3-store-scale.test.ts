import { appendFixtureMessage } from './testing/approval-card.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Release 1.0.2 scale notes P3-7, P3-10, P3-11 and P3-15: the per-turn roster
// writes are deferred and compact, no client's page stretches to an old card,
// a many-thread first screen shares one budget of long-way card reads, and an
// export holds one page at a time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { atomicWriteCount, flushCoalesced, hasPendingCoalesced } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { database } from "./database.ts";
import { openRequestCardsStatus, withLongWayBudget } from "./message-db.ts";
import { Store } from "./store.ts";
import { jsonDocument, jsonElementFor, streamThreadExport } from "./thread-export.ts";
import { transcriptPage } from "./transcript-page.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { windowsNightly } from "./testing/windows-hosted.ts";
import { refillThread } from "./testing/bounded-reads.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const BOTS = () => join(DATA_DIR, "bots.json");
const card = (requestId: string) => ({ role: "bot", kind: "options", text: "May I?", card: { title: "May I?", options: [], requestId, tool: "Bash" } }) as never;

describe("P3-7: per-turn roster writes", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));

  it("a turn's cursor, dispatch marker and usage cost no immediate bots.json write; they coalesce into one and survive a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    flushCoalesced();
    const before = atomicWriteCount(BOTS());
    for (let turn = 0; turn < 20; turn++) {
      store.markTaskDispatched(bot.id, bot.threadId, turn % 2 ? "codex" : "claude");
      store.setResumeCursor(bot.id, "claude", `sess-${turn}`, bot.threadId);
      store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 5, costUsd: null }, `turn-${turn}`);
    }
    expect(atomicWriteCount(BOTS())).toBe(before);
    // MAIN RULING 1115-DIGEST-ADOPTED S2; server/store.ts:6075: task sidecars commit directly.
    expect(hasPendingCoalesced(BOTS())).toBe(false);
    flushCoalesced();
    // MAIN RULING 1115-DIGEST-ADOPTED S2; server/store.ts:6075: flushing adds no roster write.
    expect(atomicWriteCount(BOTS())).toBe(before);
    const reloaded = new Store(selection);
    const task = reloaded.taskByThread(bot.id, bot.threadId)!;
    expect(task.resumeCursors.claude).toBe("sess-19");
    expect(task.usage).toMatchObject({ input: 200, output: 100, turns: 20 });
    expect(task.lastInstanceId).toBe("codex");
  });

  it("an unflushed restart still reads the newest state (the load flushes first), and the file is compact", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "claude", "sess-x", bot.threadId);
    expect(new Store(selection).taskByThread(bot.id, bot.threadId)!.resumeCursors.claude).toBe("sess-x");
    flushCoalesced();
    const text = readFileSync(BOTS(), "utf8");
    expect(text).not.toContain("\n");
    expect(JSON.parse(text)).toBeInstanceOf(Array);
  });
});

describe("P3-10: no client's page stretches to an old card", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));

  it("a phone page stays at the cap with a stale card 1,200 rows back, and paging back reaches the card", () => {
    const seed = new Store(selection);
    const bot = seed.createBot();
    const old = appendFixtureMessage(seed, bot.threadId, card("req-old"));
    for (let i = 0; i < 1200; i++) seed.appendMessage(bot.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `line ${i}` });
    const store = new Store(selection);
    const page = transcriptPage(store, bot.threadId, 100, false);
    expect(page.messages.length).toBe(500);
    expect(page.hasMore).toBe(true);
    let oldest = page.messages[0]!.id;
    let found = page.messages.some((m) => m.id === old.id);
    for (let hops = 0; !found && hops < 10; hops++) {
      const older = store.messagePage(bot.threadId, 100, oldest)!;
      found = older.messages.some((m) => m.id === old.id);
      oldest = older.messages[0]!.id;
    }
    expect(found).toBe(true);
  });

  it("the page is flat: a card 3,000 rows back costs the same page as one 600 back", windowsNightly(), () => {
    const sizes: number[] = [];
    for (const rows of [600, 3000]) {
      removeTempDirSync(DATA_DIR);
      const seed = new Store(selection);
      const bot = seed.createBot();
      appendFixtureMessage(seed, bot.threadId, card("req-old"));
      // Populate retained history in one fixture transaction rather than
      // synthesizing thousands of live sends without yielding to the WAL worker.
      const db = database(), leaf = seed.activeLeaf(bot.threadId);
      db.prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
        INSERT INTO messages(thread_id,id,at,role,kind,text,json)
        SELECT ?, 'fixture-line-'||v, 1700000000000+v, 'user', 'text', 'l'||(v-1),
          json_object('id','fixture-line-'||v,'at',1700000000000+v,'role','user','kind','text','text','l'||(v-1),
            'parentId',CASE WHEN v=1 THEN ? ELSE 'fixture-line-'||(v-1) END) FROM n`).run(rows, bot.threadId, leaf);
      db.prepare("UPDATE thread_state SET active_leaf_id=? WHERE thread_id=?").run(`fixture-line-${rows}`, bot.threadId);
      refillThread(db, bot.threadId);
      sizes.push(transcriptPage(new Store(selection), bot.threadId, 100, false).messages.length);
    }
    expect(sizes).toEqual([500, 500]);
  });

  it("a card within the cap is still inside the page", () => {
    const seed = new Store(selection);
    const bot = seed.createBot();
    const near = appendFixtureMessage(seed, bot.threadId, card("req-near"));
    for (let i = 0; i < 250; i++) seed.appendMessage(bot.threadId, { role: "user", kind: "text", text: `l${i}` });
    const page = transcriptPage(new Store(selection), bot.threadId, 100, false);
    expect(page.messages.length).toBe(251);
    expect(page.messages.some((m) => m.id === near.id)).toBe(true);
  });
});

describe("P3-11: long-way card reads share one budget", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));

  it("threads past the budget are reported incomplete and unread; read on their own they find their card", () => {
    const store = new Store(selection);
    const threads: string[] = [];
    for (let b = 0; b < 12; b++) {
      const bot = store.createBot();
      appendFixtureMessage(store, bot.threadId, card(`req-${b}`));
      for (let i = 0; i < 29; i++) store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `l${i}` });
      threads.push(bot.threadId);
    }
    // an upgraded database whose card index is not built yet
    database().prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES ('open_card', 0, 0, 0)").run();
    const inBudget = withLongWayBudget(80, () => threads.map((id) => openRequestCardsStatus(id, 5)));
    expect(inBudget.slice(0, 2).map((s) => s.cards.length)).toEqual([1, 1]);
    expect(inBudget.slice(2).every((s) => s.cards.length === 0 && s.incomplete)).toBe(true);
    const alone = threads.map((id) => openRequestCardsStatus(id, 5));
    expect(alone.every((s) => s.cards.length === 1 && !s.incomplete)).toBe(true);
  });
});

describe("P3-15: export reads one page at a time", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));

  function seeded(rows: number) {
    const seed = new Store(selection);
    const bot = seed.createBot();
    for (let i = 0; i < rows; i++) seed.appendMessage(bot.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `line ${i}` });
    return { bot, ids: seed.messagesFor(bot.threadId).map((m) => m.id) };
  }

  it("pages come oldest first, none larger than the page size, and an unloaded thread stays out of memory", () => {
    const { bot, ids } = seeded(1050);
    const store = new Store(selection);
    const reader = store.branchExportReader(bot.threadId, 100);
    const got: string[] = [];
    let largest = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const slice = reader.next(5);
      largest = Math.max(largest, slice.messages.length);
      got.push(...slice.messages.map((m) => m.id));
      if (slice.done) break;
    }
    expect(got).toEqual(ids);
    expect(largest).toBeLessThanOrEqual(100);
    expect((store as unknown as { threads: Map<string, unknown> }).threads.has(bot.threadId)).toBe(false);
  });

  it("the streamed JSON is byte for byte the one-shot document, for an empty, a one-page and a many-page thread", async () => {
    for (const rows of [0, 7, 450]) {
      removeTempDirSync(DATA_DIR);
      const { bot, ids } = seeded(rows);
      const store = new Store(selection);
      const writes: string[] = [];
      const res = { destroyed: false, writableEnded: false, writeHead() {}, write(chunk: string) { writes.push(chunk); return true; }, end() { (res as { writableEnded: boolean }).writableEnded = true; }, on() {}, off() {} };
      const ok = await streamThreadExport({ res: res as never, reader: store.branchExportReader(bot.threadId, 100), format: "json", name: "T", threadId: bot.threadId, filename: "t", who: () => "w", activityLine: () => "" });
      expect(ok).toBe(true);
      const messages = new Store(selection).messagesFor(bot.threadId);
      expect(messages.map((m) => m.id)).toEqual(ids);
      const { head, tail } = jsonDocument("T", bot.threadId, messages.map(jsonElementFor));
      expect(writes.join("")).toBe(head + messages.map((m) => "    " + jsonElementFor(m)).join(",\n") + tail);
      expect(JSON.parse(writes.join("")).messages).toHaveLength(messages.length);
    }
  });
});
