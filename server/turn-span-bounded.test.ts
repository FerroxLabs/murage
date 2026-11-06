// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L4B-PHONE-TURNSTATE (Astra Medium): a read of one OLDER turn (the phone's turn-state of an earlier send, index.ts askTurnState; the
// failed-turn and empty-turn lines and the unrecorded-tool mark at turn end) reads that turn's own span (turn_first's first and last
// rows, turn-last.ts), never every row written since the turn began. Measured on a real messages.db through the store: the same
// statements, the same rows and the same JSON parses whether 1,000 or 20,000 rows of other turns were written after the turn.
// History is appended by a writer that knows nothing of turn_first (an earlier build's raw INSERT): the triggers keep the bound.
import { expectSameReads, measureReads, type Reads } from "./testing/bounded-reads.ts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { prepareThread } from "./branch-store.ts";
import { closeDatabase, database } from "./database.ts";
import { updateMessage } from "./message-db.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { walkMessagesChunk } from "./message-walker.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { Store, type Message } from "./store.ts";
import { turnProducedSomething, turnWroteText, wantsEmptyTurnLine } from "./failed-turn-line.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
type Loaded = { threads: Map<string, { messages: Message[] }> };
const FILE = () => join(DATA_DIR, "messages.db");
const SIZES = [1_000, 20_000] as const;
let store: Store;
let written = 0;

function raw(): DatabaseSync {
  const db = new DatabaseSync(FILE());
  db.exec("PRAGMA busy_timeout=20000");
  return db;
}

/** Rows a writer that knows nothing of turn_first appends (an earlier build): plain INSERTs into messages, numbered as the thread is. */
function appendRaw(threadId: string, rows: number, turnOf: (i: number) => string = (i) => `later-${i}`): void {
  const db = raw();
  try {
    let seq = (db.prepare("SELECT MAX(seq) AS n FROM messages WHERE thread_id = ?").get(threadId) as { n: number | null }).n;
    const insert = db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < rows; i++) {
      const id = `raw-${++written}`, at = Date.now(), text = `later ${i}`;
      insert.run(threadId, id, at, "bot", "text", text, JSON.stringify({ id, at, role: "bot", kind: "text", text, turnId: turnOf(i) }), seq === null ? null : ++seq);
    }
    db.exec("COMMIT");
  } finally { db.close(); }
}

/** A turn as the fold writes it: the owner's line, an open tool row, an empty finished reply. */
function writeTurn(threadId: string, turnId: string): void {
  store.appendMessage(threadId, { role: "user", kind: "text", text: "what is on today", turnId });
  store.appendMessage(threadId, { role: "bot", kind: "activity", turnId, tool: { name: "Bash" } });
  store.appendMessage(threadId, { role: "bot", kind: "text", text: "  ", turnId });
}

async function newThread(name: string): Promise<string> {
  const threadId = store.createBot({ name }).threadId;
  store.messagesFor(threadId);
  await prepareThread(threadId);
  for (let i = 0; i < 10; i++) store.appendMessage(threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `earlier ${i}`, ...(i % 2 ? { turnId: `old-${i}` } : {}) });
  return threadId;
}

/** The statements bound to the thread, and the JSON parses, while `run` executes. */
async function measured<T>(threadId: string, run: () => T): Promise<{ result: T; reads: Reads; parsed: number }> {
  let parsed = 0;
  database(); // the file is open before the count starts: opening it runs its own sample of the derived rows, which is not the read under test
  const { result, reads } = await measureReads(threadId, FILE(), () => {
    const spy = vi.spyOn(JSON, "parse");
    try { return run(); } finally { parsed = spy.mock.calls.length; spy.mockRestore(); }
  });
  return { result, reads, parsed };
}

const shape = (rows: Message[]) => rows.map((row) => [row.role, row.kind, row.turnId]);

describe("an older turn under later history", () => {
  const threads: string[] = [];
  beforeAll(async () => {
    removeTempDirSync(DATA_DIR);
    store = new Store(selection);
    for (const size of SIZES) {
      const threadId = await newThread(`History ${size}`);
      writeTurn(threadId, "turn-old");
      appendRaw(threadId, size);
      threads.push(threadId);
    }
  }, 300_000);

  it("askTurnState / failed-turn line (store.turnRowsBounded): the same reads and parses at 1,000 and 20,000 later rows", async () => {
    const runs = [];
    for (const threadId of threads) runs.push(await measured(threadId, () => store.turnRowsBounded(threadId, "turn-old")));
    for (const run of runs) expect(shape(run.result)).toEqual([["user", "text", "turn-old"], ["bot", "activity", "turn-old"], ["bot", "text", "turn-old"]]);
    // the rows parsed are the turn's own span, not the history written after it
    for (const run of runs) expect(run.parsed, "JSON parses: the turn's own span, not the history after it").toBeLessThan(20);
    expectSameReads(runs[0]!.reads, runs[1]!.reads);
    // the failed-turn and empty-turn lines decide the same at both sizes
    const outcomes = runs.map((run) => ({ produced: turnProducedSomething(run.result), wroteText: turnWroteText(run.result) }));
    expect(outcomes[1]).toEqual(outcomes[0]);
    const direct = { directOwnerTurn: true, replacementOwnsThread: false, delegated: false, routine: false, lateRedispatch: false, errorShown: false, failureRowShown: false };
    expect(wantsEmptyTurnLine({ ok: true, stopReason: "end_turn" }, { ...direct, produced: outcomes[1]!.produced })).toBe(wantsEmptyTurnLine({ ok: true, stopReason: "end_turn" }, { ...direct, produced: outcomes[0]!.produced }));
  });

  it("store.turnRows of an unloaded thread (mdb.turnRows): the same reads and parses at both sizes", async () => {
    const cache = (store as unknown as Loaded).threads;
    const runs = [];
    for (const threadId of threads) {
      const loaded = cache.get(threadId);
      cache.delete(threadId);
      try { runs.push(await measured(threadId, () => store.turnRows(threadId, "turn-old"))); }
      finally { if (loaded) cache.set(threadId, loaded); }
    }
    for (const run of runs) expect(run.result).toHaveLength(3);
    // (a first call in the process may parse a cached setting or two: the bound, not equality, is what holds)
    for (const run of runs) expect(run.parsed, "JSON parses: the turn's own span, not the history after it").toBeLessThan(20);
    expectSameReads(runs[0]!.reads, runs[1]!.reads);
  });

  it("turn end (markTurnToolsUnrecorded) of an older turn: marks its open tool row, with the same parses at both sizes", async () => {
    const runs = [];
    for (const threadId of threads) runs.push(await measured(threadId, () => store.markTurnToolsUnrecorded(threadId, "turn-old")));
    expect(runs.map((run) => run.result)).toEqual([1, 1]);
    for (const run of runs) expect(run.parsed, "JSON parses: the turn's own span, not the history after it").toBeLessThan(50);
    expect(runs[1]!.reads.scans).toEqual([]);
    for (const threadId of threads) expect(store.turnRowsBounded(threadId, "turn-old").find((row) => row.kind === "activity")?.tool).toMatchObject({ name: "Bash", unrecorded: true });
  });

  it("a row an earlier build appends to an older turn after the history still lands inside the turn's span (trigger)", async () => {
    const threadId = await newThread("Straddle");
    writeTurn(threadId, "turn-mid");
    appendRaw(threadId, 500);
    appendRaw(threadId, 1, () => "turn-mid");
    const rows = store.turnRowsBounded(threadId, "turn-mid");
    expect(shape(rows)).toEqual([["user", "text", "turn-mid"], ["bot", "activity", "turn-mid"], ["bot", "text", "turn-mid"], ["bot", "text", "turn-mid"]]);
    const db = raw();
    try {
      const newest = (db.prepare("SELECT MAX(rowid) AS n FROM messages WHERE thread_id = ?").get(threadId) as { n: number }).n;
      expect(db.prepare("SELECT last_rowid AS last FROM turn_first WHERE thread_id = ? AND turn_id = ?").get(threadId, "turn-mid")).toEqual({ last: newest });
    } finally { db.close(); }
  });

  it("the turn triggers never refuse a row with damaged JSON (or no usable turn id): it is written and names no turn", () => {
    // the transcript tables alone (message-tables.ts), so only the turn triggers see the insert (the Inbox projection's own
    // triggers are another matter and are not under test here)
    const db = new DatabaseSync(":memory:");
    try {
      initializeMessageTables(db);
      const insert = db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES ('t', ?, 1, 'bot', 'text', 'x', ?)");
      expect(() => insert.run("damaged-1", "{\"turnId\":\"t-x\", not json")).not.toThrow();
      expect(() => insert.run("damaged-2", JSON.stringify({ id: "damaged-2", turnId: "" }))).not.toThrow();
      expect(() => insert.run("damaged-3", JSON.stringify({ id: "damaged-3", turnId: 7 }))).not.toThrow();
      expect((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(3);
      expect(db.prepare("SELECT COUNT(*) AS n FROM turn_first").get()).toEqual({ n: 0 });
      // a sound row after them is filed with its span
      insert.run("sound-1", JSON.stringify({ id: "sound-1", turnId: "t-ok" }));
      expect(db.prepare("SELECT first_rowid AS first, last_rowid AS last FROM turn_first WHERE turn_id = 't-ok'").get()).toEqual({ first: 4, last: 4 });
    } finally { db.close(); }
  });

  it("a row patched to name a turn stays inside that turn's span (updateMessage)", async () => {
    const threadId = await newThread("Patched");
    writeTurn(threadId, "turn-patch");
    const plain = store.appendMessage(threadId, { role: "bot", kind: "text", text: "a line of no turn" });
    appendRaw(threadId, 5);
    updateMessage(threadId, { ...plain, turnId: "turn-patch" });
    expect(store.turnRowsBounded(threadId, "turn-patch").map((row) => row.id)).toContain(plain.id);
  });

  it("the replies of an older turn (turnTextRows): every one, and the same reads at both sizes", async () => {
    const cache = (store as unknown as Loaded).threads;
    const runs = [];
    for (const threadId of threads) {
      store.appendMessage(threadId, { role: "bot", kind: "text", text: "the answer", turnId: "turn-reply" });
      const id = store.turnRowsBounded(threadId, "turn-reply")[0]!.id;
      appendRaw(threadId, SIZES[runs.length]!);
      const loaded = cache.get(threadId);
      cache.delete(threadId);
      try { runs.push({ id, ...await measured(threadId, () => store.turnReplyOriginals(threadId, "turn-reply")) }); }
      finally { if (loaded) cache.set(threadId, loaded); }
    }
    for (const run of runs) expect(run.result).toEqual([run.id]);
    for (const run of runs) expect(run.parsed, "JSON parses: the turn's own span, not the history after it").toBeLessThan(20);
    expectSameReads(runs[0]!.reads, runs[1]!.reads);
  });
});

describe("a file from before the column (an earlier build wrote the turn)", () => {
  const threads: string[] = [];
  const longBefore: string[] = [];
  beforeAll(async () => {
    if (!store) { removeTempDirSync(DATA_DIR); store = new Store(selection); }
    for (const size of SIZES) {
      const threadId = await newThread(`Pre-upgrade ${size}`);
      writeTurn(threadId, "turn-pre");
      threads.push(threadId);
    }
    // an old turn with a long history after it, all of it from before the upgrade
    for (const size of SIZES) {
      const threadId = await newThread(`Long before ${size}`);
      writeTurn(threadId, "turn-long-before");
      appendRaw(threadId, size);
      longBefore.push(threadId);
    }
    // back to the 1.0.17 shape: no triggers, no column, no floor
    closeDatabase(); await stopWalMaintenance();
    const db = raw();
    try {
      db.exec("DROP TRIGGER IF EXISTS turn_last_msg; DROP TRIGGER IF EXISTS turn_last_fill; DELETE FROM transcript_index_state WHERE name = 'turn_last_floor'");
      if ((db.prepare("PRAGMA table_info(turn_first)").all() as Array<{ name: string }>).some((column) => column.name === "last_rowid")) db.exec("ALTER TABLE turn_first DROP COLUMN last_rowid");
    } finally { db.close(); }
    // the earlier build appends one more row to the turn, filing only its first row as that build's writer does
    for (const threadId of threads) appendRaw(threadId, 1, () => "turn-pre");
    const old = raw();
    try { for (const threadId of threads) old.prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) SELECT thread_id, 'turn-pre', MIN(rowid) FROM messages WHERE thread_id = ? AND json_extract(json, '$.turnId') = 'turn-pre' ON CONFLICT(thread_id, turn_id) DO UPDATE SET first_rowid = MIN(first_rowid, excluded.first_rowid)").run(threadId); }
    finally { old.close(); }
    // the next 1.0.18 open (any store read reopens the file), then the history written after the upgrade
    store.turnRowsBounded(threads[0]!, "turn-pre");
    SIZES.forEach((size, i) => appendRaw(threads[i]!, size));
  }, 300_000);

  it("a pre-upgrade turn (no last row kept) is read exactly, bounded by the upgrade point: the same reads and parses at both sizes", async () => {
    const runs = [];
    for (const threadId of threads) runs.push(await measured(threadId, () => store.turnRowsBounded(threadId, "turn-pre")));
    for (const run of runs) expect(shape(run.result)).toEqual([["user", "text", "turn-pre"], ["bot", "activity", "turn-pre"], ["bot", "text", "turn-pre"], ["bot", "text", "turn-pre"]]);
    for (const run of runs) expect(run.parsed, "JSON parses: bounded by the upgrade point, not the history after it").toBeLessThan(50);
    expectSameReads(runs[0]!.reads, runs[1]!.reads);
    const db = raw();
    try {
      // the pre-upgrade turn keeps no last row; the floor recorded at the upgrade bounds it
      for (const threadId of threads) expect(db.prepare("SELECT last_rowid AS last FROM turn_first WHERE thread_id = ? AND turn_id = ?").get(threadId, "turn-pre")).toEqual({ last: null });
      expect(db.prepare("SELECT done FROM transcript_index_state WHERE name = 'turn_last_floor'").get()).toEqual({ done: 1 });
    } finally { db.close(); }
  });

  it("a turn begun after the upgrade keeps its last row from the triggers", async () => {
    const threadId = threads[1]!;
    writeTurn(threadId, "turn-post");
    appendRaw(threadId, 2_000);
    const { result, parsed } = await measured(threadId, () => store.turnRowsBounded(threadId, "turn-post"));
    expect(result).toHaveLength(3);
    expect(parsed).toBeLessThan(20);
  });

  // last in this block: the walk files last rows for every turn of the file, and the tests above read a file it has not reached
  it("once the background walk has ended, a turn from before the upgrade costs its own span, however long the history that followed it before the upgrade", async () => {
    const db = raw();
    try { while (walkMessagesChunk(db, 5_000).more) { /* one window at a time, as the background job runs it */ } }
    finally { db.close(); }
    const runs = [];
    for (const threadId of longBefore) runs.push(await measured(threadId, () => store.turnRowsBounded(threadId, "turn-long-before")));
    for (const run of runs) expect(shape(run.result)).toEqual([["user", "text", "turn-long-before"], ["bot", "activity", "turn-long-before"], ["bot", "text", "turn-long-before"]]);
    for (const run of runs) expect(run.parsed, "JSON parses: the turn's own span, not the rows that followed it before the upgrade").toBeLessThan(20);
    expectSameReads(runs[0]!.reads, runs[1]!.reads);
    // and a turn that straddled the upgrade keeps every row it wrote
    for (const threadId of threads) expect(store.turnRowsBounded(threadId, "turn-pre")).toHaveLength(4);
  });
});
