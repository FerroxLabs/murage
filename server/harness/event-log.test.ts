// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The event log within its budget (harness/event-log.ts): streamed replies
// cost the same as their completed text, each thread and the folder stay
// capped, a deleted conversation leaves no file, forgotten text leaves the
// log, the upgrade prune brings old folders to the same rules and resumes,
// and every reader of events/ still finds what it needs.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { EVENTS_DIR, ensureDirs } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { ConversationDeletions, runConversationDeletion } from "../conversation-deletion.ts";
import { readThreadEvents } from "../thread-events.ts";
import { EventBus } from "./bus.ts";
import {
  enforceEventLogBudget, eventLogIo, eventLogJobsSettled, eventLogLimits, eventLogPruneDone, forgottenTextsAll, forgottenTextsFor, pruneEventLogs, recordEventLogForget, resetEventLogJobsForTests,
  runEventLogForgets, setEventLogBudgetReady, threadSessionLines,
} from "./event-log.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-eventlog-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); rmSync(scratch, { recursive: true, force: true }); });
let counter = 0;
const fresh = (name: string) => { const dir = join(scratch, `${name}-${++counter}`); mkdirSync(dir, { recursive: true }); return dir; };
const defaults = { ...eventLogLimits };
afterEach(async () => { Object.assign(eventLogLimits, defaults); await eventLogJobsSettled(); resetEventLogJobsForTests(); setEventLogBudgetReady(false); });

let seq = 0;
const ev = (threadId: string, over: Record<string, unknown>): RuntimeEvent => ({
  eventId: `e${++seq}`, provider: "fake", providerInstanceId: "inst-1", threadId, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0, seq)).toISOString(), ...over,
}) as unknown as RuntimeEvent;
const line = (event: RuntimeEvent) => JSON.stringify(event) + "\n";
const size = (path: string) => { try { return statSync(path).size; } catch { return 0; } };

/** One streamed reply: `chunks` deltas and progress ticks, then the completed text. */
function streamReply(bus: EventBus, threadId: string, text: string, chunks: number, turnId = `turn-${++seq}`) {
  bus.publish(ev(threadId, { type: "turn.started", turnId }));
  const step = Math.ceil(text.length / chunks);
  for (let i = 0; i < chunks; i++) {
    bus.publish(ev(threadId, { type: "content.delta", turnId, streamKind: "assistant_text", delta: text.slice(i * step, (i + 1) * step) || "." }));
    bus.publish(ev(threadId, { type: "item.updated", turnId, itemId: "r1", itemType: "reasoning", tokens: i }));
  }
  bus.publish(ev(threadId, { type: "item.completed", turnId, itemId: "a1", itemType: "assistant_text", text }));
  bus.publish(ev(threadId, { type: "turn.completed", turnId, ok: true }));
}

describe("event log writes", () => {
  beforeEach(() => { rmSync(EVENTS_DIR, { recursive: true, force: true }); ensureDirs(); });

  it("writes a streamed reply in flat, small bytes, however many chunks it streamed in", () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe(e => seen.push(e), { durable: false });
    const text = "The quarterly numbers are in and they look good. ".repeat(40);
    streamReply(bus, "flat-a", text, 20);
    streamReply(bus, "flat-b", text, 2_000);
    const a = size(join(EVENTS_DIR, "flat-a.ndjson")), b = size(join(EVENTS_DIR, "flat-b.ndjson"));
    // live delivery is unchanged: every chunk still reaches the listeners
    expect(seen.filter(e => e.type === "content.delta")).toHaveLength(2_020);
    // on disk the reply is its completed text plus three small events, whatever the stream did
    expect(Math.abs(a - b)).toBeLessThan(64);
    expect(b).toBeLessThan(text.length + 1_500);
    const types = readFileSync(join(EVENTS_DIR, "flat-b.ndjson"), "utf8").trim().split("\n").map(l => JSON.parse(l).type);
    expect(types).toEqual(["turn.started", "item.completed", "turn.completed"]);
  });

  it("keeps each thread within its cap with one rotation, and keeps every session line", () => {
    eventLogLimits.threadBytes = 32 * 1024;
    const bus = new EventBus();
    bus.publish(ev("capped", { type: "session.started", sessionId: "first-session" }));
    for (let i = 0; i < 400; i++) bus.publish(ev("capped", { type: "item.completed", itemType: "tool", itemId: `t${i}`, ok: true, result: "x".repeat(400) }));
    bus.publish(ev("capped", { type: "session.started", sessionId: "second-session" }));
    const names = readdirSync(EVENTS_DIR).filter(n => n.startsWith("capped")).sort();
    expect(names).toEqual(["capped.ndjson", "capped.previous.ndjson", "capped.sessions.ndjson"]);
    expect(size(join(EVENTS_DIR, "capped.ndjson"))).toBeLessThanOrEqual(32 * 1024);
    expect(size(join(EVENTS_DIR, "capped.previous.ndjson"))).toBeLessThanOrEqual(32 * 1024);
    // the first session line has rotated away from both log files; the sessions file still has it
    expect(readFileSync(join(EVENTS_DIR, "capped.previous.ndjson"), "utf8")).not.toContain("first-session");
    const sessions = readFileSync(join(EVENTS_DIR, "capped.sessions.ndjson"), "utf8");
    expect(sessions).toContain("first-session");
    expect(sessions).toContain("second-session");
  });

  it("summarizes a record over the per-record limit instead of writing it whole", () => {
    eventLogLimits.recordBytes = 4 * 1024;
    const bus = new EventBus();
    bus.publish(ev("huge", { type: "item.completed", itemType: "tool", itemId: "t1", ok: true, result: "y".repeat(50_000) }));
    const [logged] = readFileSync(join(EVENTS_DIR, "huge.ndjson"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(logged).toMatchObject({ type: "item.completed", itemType: "tool", ok: true, result: expect.stringContaining("too large") });
  });

  it("keeps the folder within its total budget and age, and never sweeps routine runs or sessions", async () => {
    eventLogLimits.threadBytes = 64 * 1024;
    eventLogLimits.maxBytes = 200 * 1024;
    eventLogLimits.sweepEveryBytes = 1;
    setEventLogBudgetReady(true);
    mkdirSync(join(EVENTS_DIR, "routine-runs"), { recursive: true });
    writeFileSync(join(EVENTS_DIR, "routine-runs", "r1.jsonl"), "z".repeat(300 * 1024));
    writeFileSync(join(EVENTS_DIR, "routines.json.pre-pin"), "{}");
    const old = join(EVENTS_DIR, "stale.ndjson");
    writeFileSync(old, line(ev("stale", { type: "turn.started" })));
    writeFileSync(join(EVENTS_DIR, "stale.sessions.ndjson"), line(ev("stale", { type: "session.started", sessionId: "s" })));
    const longAgo = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, longAgo, longAgo);
    const bus = new EventBus();
    for (let t = 0; t < 12; t++) for (let i = 0; i < 60; i++) {
      bus.publish(ev(`busy-${t}`, { type: "item.completed", itemType: "tool", itemId: `t${i}`, ok: true, result: "x".repeat(800) }));
      // the sweep runs in the background, never inside a publish
      if (i % 20 === 0) await eventLogJobsSettled();
    }
    await eventLogJobsSettled();
    const logs = readdirSync(EVENTS_DIR).filter(n => /^[\w-]+(\.previous)?\.ndjson$/.test(n));
    const total = logs.reduce((sum, n) => sum + size(join(EVENTS_DIR, n)), 0);
    expect(total).toBeLessThanOrEqual(200 * 1024 + 64 * 1024);
    expect(existsSync(join(EVENTS_DIR, "busy-11.ndjson"))).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(size(join(EVENTS_DIR, "routine-runs", "r1.jsonl"))).toBe(300 * 1024);
    expect(existsSync(join(EVENTS_DIR, "routines.json.pre-pin"))).toBe(true);
    expect(existsSync(join(EVENTS_DIR, "stale.sessions.ndjson"))).toBe(true);
    // the sweep on its own: under the budget once it runs, the file named to keep stays
    expect(await enforceEventLogBudget(EVENTS_DIR, { maxBytes: 0, keep: ["busy-11.ndjson"] })).toBeGreaterThan(0);
    expect(readdirSync(EVENTS_DIR).filter(n => /^[\w-]+(\.previous)?\.ndjson$/.test(n))).toEqual(["busy-11.ndjson"]);
  });

  it("the Inspector reads across a rotation", () => {
    eventLogLimits.threadBytes = 8 * 1024;
    const bus = new EventBus();
    for (let i = 0; i < 40; i++) bus.publish(ev("inspect", { type: "item.completed", itemType: "tool", itemId: `t${i}`, ok: true, result: "x".repeat(300) }));
    expect(existsSync(join(EVENTS_DIR, "inspect.previous.ndjson"))).toBe(true);
    const inCurrent = readFileSync(join(EVENTS_DIR, "inspect.ndjson"), "utf8").trim().split("\n").length;
    const page = readThreadEvents({ eventsDir: EVENTS_DIR, nativeDir: join(EVENTS_DIR, "no-native"), threadId: "inspect", limit: inCurrent + 3 });
    expect(page.entries).toHaveLength(inCurrent + 3);
    const ids = page.entries.map(e => (e.data as { itemId?: string }).itemId);
    expect(ids[ids.length - 1]).toBe("t39");
    expect(ids).toEqual([...ids].sort((a, b) => Number(a!.slice(1)) - Number(b!.slice(1))));
  });
});

const THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";
const OTHER = "9b0e3c1a-0000-4000-8000-000000000001";

function messagesDb(dir: string) {
  const db = new DatabaseSync(join(dir, "messages.db"));
  openDatabases.push(db);
  db.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  return db;
}

describe("deleting a conversation", () => {
  it("removes its event log, rotation, sessions file and any rewrite in flight, and a late event never brings it back", async () => {
    const data = fresh("data");
    const events = join(data, "events");
    mkdirSync(events, { recursive: true });
    for (const name of [`${THREAD}.ndjson`, `${THREAD}.previous.ndjson`, `${THREAD}.sessions.ndjson`, `${THREAD}.ndjson.123.0a1b2c3d-1111-4222-8333-444455556666.tmp`, `${OTHER}.ndjson`]) {
      writeFileSync(join(events, name), line(ev(THREAD, { type: "session.started", sessionId: "sess-from-log", providerInstanceId: "inst-claude" })));
    }
    const db = messagesDb(data);
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(THREAD, "m1", 1, "bot", "text", "hi", "{}");
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    // the deletion reader still finds the engine session through the sessions file
    const planning = { threadIds: [THREAD], instanceKind: () => "claudeAgent" };
    const entry = deletions.begin(planning, await deletions.collectLogSessions(planning.threadIds, planning));
    expect(entry.engineSessions?.claude).toContain("sess-from-log");
    deletions.abandon(entry);
    await runConversationDeletion(deletions, { threadIds: [THREAD] }, () => { db.prepare("DELETE FROM messages WHERE thread_id=?").run(THREAD); return true; });
    expect(readdirSync(events).filter(n => n.startsWith(THREAD))).toEqual([]);
    expect(existsSync(join(events, `${OTHER}.ndjson`))).toBe(true);
    // a turn winding down after the delete: delivered, never written
    rmSync(EVENTS_DIR, { recursive: true, force: true }); ensureDirs();
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe(e => seen.push(e), { durable: false });
    bus.publish(ev(THREAD, { type: "turn.completed", ok: true }));
    expect(seen).toHaveLength(1);
    expect(existsSync(join(EVENTS_DIR, `${THREAD}.ndjson`))).toBe(false);
  });
});

describe("forgetting a message", () => {
  it("drops every line holding its text from the thread's log, and keeps the rest", async () => {
    const dir = fresh("forget");
    const secret = "my sister's new address is 14 Elm Street";
    const t = "forget-thread";
    const body = [
      ev(t, { type: "turn.started", turnId: "keep-turn" }),
      ev(t, { type: "item.completed", itemType: "assistant_text", turnId: "keep-turn", text: "unrelated reply" }),
      ev(t, { type: "turn.started", turnId: "gone-turn" }),
      ev(t, { type: "item.started", itemType: "tool", turnId: "gone-turn", title: "write file", input: { content: secret } }),
      ev(t, { type: "item.completed", itemType: "assistant_text", turnId: "gone-turn", text: secret }),
      ev(t, { type: "runtime.error", message: `quoted later: ${secret}` }),
    ].map(line).join("");
    writeFileSync(join(dir, `${t}.ndjson`), body);
    writeFileSync(join(dir, `${t}.previous.ndjson`), line(ev(t, { type: "item.completed", itemType: "assistant_text", turnId: "older", text: secret })));
    const db = messagesDb(fresh("forget-db"));
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(t, "m-gone", 1, "bot", "text", secret, JSON.stringify({ turnId: "gone-turn" }));
    const items = forgottenTextsFor(db, ["m-gone"]);
    expect(items).toEqual([{ threadId: t, turnId: "gone-turn", text: secret }]);
    db.exec("BEGIN IMMEDIATE");
    expect(recordEventLogForget(db, ["m-gone"])).toEqual([t]);
    db.exec("COMMIT");
    expect(await runEventLogForgets({ dir, database: () => db })).toEqual({ threads: 1, failed: 0 });
    await eventLogJobsSettled();
    const all = readdirSync(dir).map(n => readFileSync(join(dir, n), "utf8")).join("");
    expect(all).not.toContain("14 Elm Street");
    expect(all).not.toContain("gone-turn");
    expect(all).toContain("unrelated reply");
    expect(readdirSync(dir).filter(n => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("the upgrade prune", () => {
  /** An old folder at a small scale: one thread's log is 97% streamed chunks and far over the cap, others hold forgotten
   * text, belong to deleted conversations, or are a routine run journal. */
  function oldFolder() {
    const dir = fresh("events");
    const big = "big-thread";
    let text = line(ev(big, { type: "session.started", sessionId: "s-oldest", providerInstanceId: "inst-claude" }));
    for (let turn = 0; turn < 60; turn++) {
      const turnId = `bt-${turn}`;
      text += line(ev(big, { type: "turn.started", turnId }));
      for (let i = 0; i < 120; i++) text += line(ev(big, { type: "content.delta", turnId, streamKind: "assistant_text", delta: "chunk ".repeat(8) }));
      for (let i = 0; i < 60; i++) text += line(ev(big, { type: "item.updated", turnId, itemType: "tool", tokens: i }));
      text += line(ev(big, { type: "item.completed", turnId, itemType: "assistant_text", text: `reply ${turn}` }));
    }
    writeFileSync(join(dir, `${big}.ndjson`), text);
    writeFileSync(join(dir, "forgot-thread.ndjson"), [
      ev("forgot-thread", { type: "item.completed", itemType: "assistant_text", turnId: "f1", text: "the forgotten words are here" }),
      ev("forgot-thread", { type: "item.completed", itemType: "assistant_text", turnId: "f2", text: "kept words" }),
    ].map(line).join(""));
    for (let i = 0; i < 4; i++) writeFileSync(join(dir, `deleted-${i}.ndjson`), line(ev(`deleted-${i}`, { type: "item.completed", itemType: "assistant_text", text: "left behind" })));
    writeFileSync(join(dir, "deleted-0.sessions.ndjson"), "{}\n");
    writeFileSync(join(dir, "big-thread.ndjson.99.0a1b2c3d-1111-4222-8333-444455556666.tmp"), "torn rewrite");
    mkdirSync(join(dir, "routine-runs"));
    writeFileSync(join(dir, "routine-runs", "r.jsonl"), "journal\n");
    const longAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    for (const name of readdirSync(dir)) if (name !== "routine-runs") utimesSync(join(dir, name), longAgo, longAgo);
    return { dir, bytes: Buffer.byteLength(text) };
  }
  const known = (threadId: string) => !threadId.startsWith("deleted-");
  const forgotten = () => [{ threadId: "forgot-thread", turnId: "f1", text: "the forgotten words are here" }];

  it("prunes old files to the new rules, removes deleted conversations' files, and resumes where it stopped", async () => {
    eventLogLimits.threadBytes = 16 * 1024;
    const { dir, bytes } = oldFolder();
    expect(bytes).toBeGreaterThan(40 * 16 * 1024);
    let busyAsked = 0;
    const options = { dir, threadKnown: known, forgotten, busy: () => { busyAsked++; return false; }, chunkBytes: 4 * 1024, sliceMs: 0 };
    const first = await pruneEventLogs({ ...options, stopAfter: 1 });
    expect(first.done).toBe(false);
    expect(eventLogPruneDone(dir)).toBe(false);
    expect(existsSync(join(dir, ".retention-progress.json"))).toBe(true);
    const second = await pruneEventLogs(options);
    expect(second.done).toBe(true);
    expect(first.files + second.files).toBe(2);
    expect(busyAsked).toBeGreaterThan(0);
    expect(eventLogPruneDone(dir)).toBe(true);
    expect(existsSync(join(dir, ".retention-progress.json"))).toBe(false);
    // the big file: capped, no streamed chunks or ticks, newest replies kept, its session line saved
    const big = readFileSync(join(dir, "big-thread.ndjson"), "utf8");
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(16 * 1024);
    expect(big).not.toContain("content.delta");
    expect(big).not.toContain("item.updated");
    expect(big).toContain("reply 59");
    expect(readFileSync(join(dir, "big-thread.sessions.ndjson"), "utf8")).toContain("s-oldest");
    // forgotten text out, the rest kept
    const forgot = readFileSync(join(dir, "forgot-thread.ndjson"), "utf8");
    expect(forgot).not.toContain("forgotten words");
    expect(forgot).toContain("kept words");
    // deleted conversations and torn rewrites gone, the routine journal untouched
    expect(readdirSync(dir).filter(n => n.startsWith("deleted-") || n.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(join(dir, "routine-runs", "r.jsonl"), "utf8")).toBe("journal\n");
    // a finished prune never runs again
    const third = await pruneEventLogs(options);
    expect(third).toMatchObject({ done: true, files: 0 });
  });

  it("takes in what the bus appended while it read, and waits while the owner is busy", async () => {
    eventLogLimits.threadBytes = 16 * 1024;
    const { dir } = oldFolder();
    let appended = false, busyTurns = 0;
    const busy = () => {
      if (!appended) {
        appended = true;
        appendFileSync(join(dir, "big-thread.ndjson"), line(ev("big-thread", { type: "item.completed", itemType: "assistant_text", text: "written during the prune" })));
      }
      // the owner's turn holds the prune for a moment
      return busyTurns++ < 1;
    };
    const result = await pruneEventLogs({ dir, threadKnown: known, forgotten, busy, chunkBytes: 4 * 1024, sliceMs: 0 });
    expect(result.done).toBe(true);
    expect(busyTurns).toBeGreaterThan(1);
    expect(readFileSync(join(dir, "big-thread.ndjson"), "utf8")).toContain("written during the prune");
  });

  it("finds messages forgotten before the upgrade", () => {
    const db = messagesDb(fresh("tomb"));
    db.exec("CREATE TABLE memory_sources(id TEXT, message_id TEXT); CREATE TABLE memory_tombstones(target_type TEXT, target_id TEXT)");
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("t1", "m1", 1, "user", "text", "forget me please", JSON.stringify({ turnId: "u1" }));
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("t1", "m2", 1, "user", "text", "keep me", "{}");
    db.exec("INSERT INTO memory_sources VALUES('s1','m1'),('s2','m2'); INSERT INTO memory_tombstones VALUES('source','s1'),('import','s2')");
    expect(forgottenTextsAll(db)).toEqual([{ threadId: "t1", turnId: "u1", text: "forget me please" }]);
  });
});

describe("a session line that missed the sessions file", () => {
  beforeEach(() => { rmSync(EVENTS_DIR, { recursive: true, force: true }); ensureDirs(); });
  const realAppend = eventLogIo.appendSession;
  afterEach(() => { eventLogIo.appendSession = realAppend; });
  const started = (threadId: string) => ev(threadId, { type: "session.started", sessionId: `sess-${threadId}` });
  const failOnce = () => { let failed = false; eventLogIo.appendSession = (path, data, options) => { if (!failed) { failed = true; throw new Error("ENOSPC"); } realAppend(path, data, options); }; };

  it("is retried and found by the next session read in the same process", async () => {
    const bus = new EventBus();
    failOnce();
    bus.publish(started("miss-a"));
    expect(existsSync(join(EVENTS_DIR, "miss-a.sessions.pending"))).toBe(true);
    const lines = await threadSessionLines(EVENTS_DIR, "miss-a");
    expect(lines.map(l => JSON.parse(l).sessionId)).toEqual(["sess-miss-a"]);
    expect(existsSync(join(EVENTS_DIR, "miss-a.sessions.pending"))).toBe(false);
  });

  it("is rescanned from the log after a restart, even when every file counts as covered", async () => {
    const bus = new EventBus();
    failOnce();
    bus.publish(started("miss-b"));
    resetEventLogJobsForTests(); // the restart: memory gone, only the files remain
    writeFileSync(join(EVENTS_DIR, ".retention-v1"), "");
    const lines = await threadSessionLines(EVENTS_DIR, "miss-b");
    expect(lines.map(l => JSON.parse(l).sessionId)).toEqual(["sess-miss-b"]);
    expect(existsSync(join(EVENTS_DIR, "miss-b.sessions.pending"))).toBe(false);
  });
});

