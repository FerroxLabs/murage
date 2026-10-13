// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The event log's background jobs (harness/event-log.ts), Fable review r1:
// a forgotten message leaves a log of any size without stalling the main loop
// or losing its place on a crash; a rotation never discards a session line
// that was not copied; the prune follows files, not names, starts without the
// Electron health probe, and replaces a file in a short step; deletion reads a
// log of any size; Windows renames are tolerated; the budget sweep runs off
// the publish path.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EVENTS_DIR, ensureDirs } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { ConversationDeletions } from "../conversation-deletion.ts";
import { readThreadEvents } from "../thread-events.ts";
import { EventBus } from "./bus.ts";
import * as log from "./event-log.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const L = log as any;
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-eventlog-jobs-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); rmSync(scratch, { recursive: true, force: true }); });
let counter = 0;
const fresh = (name: string) => { const dir = join(scratch, `${name}-${++counter}`); mkdirSync(dir, { recursive: true }); return dir; };
const defaults = { ...log.eventLogLimits };
const io = L.eventLogIo ? { ...L.eventLogIo } : undefined;
afterEach(async () => {
  Object.assign(log.eventLogLimits, defaults);
  if (io) Object.assign(L.eventLogIo, io);
  await L.eventLogJobsSettled?.();
  L.resetEventLogJobsForTests?.();
  log.setEventLogBudgetReady(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let seq = 0;
const ev = (threadId: string, over: Record<string, unknown>): RuntimeEvent => ({
  eventId: `e${++seq}`, provider: "fake", providerInstanceId: "inst-1", threadId, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0, seq)).toISOString(), ...over,
}) as unknown as RuntimeEvent;
const line = (event: RuntimeEvent) => JSON.stringify(event) + "\n";
const size = (path: string) => { try { return statSync(path).size; } catch { return 0; } };

function messagesDb(dir: string) {
  const db = new DatabaseSync(join(dir, "messages.db"));
  openDatabases.push(db);
  db.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  return db;
}

/** The forget's own transaction (memory/forget.ts runs the hook inside one). */
function forgetInTransaction(db: DatabaseSync, messageIds: string[]) {
  db.exec("BEGIN IMMEDIATE");
  try { L.recordEventLogForget(db, messageIds); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** The longest stretch the main loop went without running a timer. */
function loopProbe() {
  let last = performance.now(), max = 0;
  const timer = setInterval(() => { const now = performance.now(); max = Math.max(max, now - last); last = now; }, 1);
  return { stop() { clearInterval(timer); return max; } };
}

/** True when `needle` appears anywhere in the file, read in chunks (the file may be far over the string limit). */
async function fileContains(path: string, needle: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const want = Buffer.from(needle);
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    let position = 0, carry = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) return false;
      position += bytesRead;
      const data = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      if (data.includes(want)) return true;
      carry = data.subarray(Math.max(0, data.length - want.length));
    }
  } finally { await handle.close(); }
}

const SECRET = "my sister's new address is 14 Elm Street";

describe("forgetting a message (P1-1)", () => {
  it("removes its text from a 600 MiB log in a background job whose main-loop slices stay under 50 ms", async () => {
    const dir = fresh("forget-big");
    const t = "big-forget-thread";
    // one 4 MiB block of ordinary lines with the forgotten turn's lines in it, written 150 times
    const filler = line(ev(t, { type: "item.completed", itemType: "tool", itemId: "t", ok: true, result: "x".repeat(4000) }));
    const gone = line(ev(t, { type: "item.completed", itemType: "assistant_text", turnId: "gone-turn", text: SECRET }));
    const quoted = line(ev(t, { type: "runtime.error", message: `quoted later: ${SECRET}` }));
    let text = gone + quoted;
    while (Buffer.byteLength(text) + filler.length < 4 * 1024 * 1024) text += filler;
    const block = Buffer.from(text);
    const path = join(dir, `${t}.ndjson`);
    const out = await open(path, "w");
    for (let i = 0; i < 150; i++) await out.write(block);
    await out.close();
    const before = size(path);
    expect(before).toBeGreaterThan(0x1fffffe8);
    const db = messagesDb(fresh("forget-big-db"));
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(t, "m-gone", 1, "bot", "text", SECRET, JSON.stringify({ turnId: "gone-turn" }));
    const probe = loopProbe();
    forgetInTransaction(db, ["m-gone"]);
    await L.runEventLogForgets({ dir, database: () => db });
    const worst = probe.stop();
    await L.eventLogJobsSettled();
    expect(await fileContains(path, "14 Elm Street")).toBe(false);
    expect(size(path)).toBe(before - 150 * (Buffer.byteLength(gone) + Buffer.byteLength(quoted)));
    expect(await fileContains(path, "\"result\":\"xxxx")).toBe(true);
    expect(readdirSync(dir).filter(n => n.endsWith(".tmp"))).toEqual([]);
    expect(L.eventLogForgetPending(t)).toBe(false);
    expect(worst).toBeLessThan(50);
  }, 300_000);

  it("the Inspector serves none of the thread's lines until the rewrite has finished", async () => {
    rmSync(EVENTS_DIR, { recursive: true, force: true }); ensureDirs();
    const t = "inspect-forget";
    writeFileSync(join(EVENTS_DIR, `${t}.ndjson`), [
      ev(t, { type: "item.completed", itemType: "assistant_text", turnId: "keep-turn", text: "unrelated reply" }),
      ev(t, { type: "item.completed", itemType: "assistant_text", turnId: "gone-turn", text: SECRET }),
    ].map(line).join(""));
    const db = messagesDb(fresh("inspect-db"));
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(t, "m-gone", 1, "bot", "text", SECRET, JSON.stringify({ turnId: "gone-turn" }));
    forgetInTransaction(db, ["m-gone"]);
    const read = () => readThreadEvents({ eventsDir: EVENTS_DIR, nativeDir: join(EVENTS_DIR, "no-native"), threadId: t });
    const during = read();
    expect(during.entries).toEqual([]);
    expect(JSON.stringify(during)).not.toContain("Elm Street");
    await L.runEventLogForgets({ dir: EVENTS_DIR, database: () => db });
    const after = read();
    expect(after.entries.map(e => (e.data as { text?: string }).text)).toEqual(["unrelated reply"]);
  });

  it("a forget interrupted by a crash resumes at the next start, and a failed rewrite stays pending, is reported and retried", async () => {
    const dir = fresh("forget-crash");
    const t = "crash-forget";
    writeFileSync(join(dir, `${t}.ndjson`), line(ev(t, { type: "item.completed", itemType: "assistant_text", turnId: "gone-turn", text: SECRET })) + line(ev(t, { type: "turn.completed", turnId: "kept", ok: true })));
    writeFileSync(join(dir, `${t}.previous.ndjson`), line(ev(t, { type: "runtime.error", message: `quoted: ${SECRET}` })));
    const db = messagesDb(fresh("crash-db"));
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(t, "m-gone", 1, "bot", "text", SECRET, JSON.stringify({ turnId: "gone-turn" }));
    // the forget commits; the process dies before its background job ran
    forgetInTransaction(db, ["m-gone"]);
    L.resetEventLogJobsForTests();
    expect(L.eventLogForgetPending(t)).toBe(false);
    // the next start: the first rename fails once (a disk error), and is not swallowed
    let failures = 0;
    L.eventLogIo.rename = (from: string, to: string) => { if (failures++ === 0) throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" }); renameSync(from, to); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    L.startEventLogForgets({ dir, database: () => db, retryMs: 20 });
    // gated from the moment the start has read the record
    expect(L.eventLogForgetPending(t)).toBe(true);
    await vi.waitFor(() => expect(L.eventLogForgetPending(t)).toBe(false), { timeout: 10_000, interval: 10 });
    await L.eventLogJobsSettled();
    expect(failures).toBeGreaterThan(1);
    expect(warn.mock.calls.map(c => String(c[0])).join("\n")).toMatch(/EIO/);
    const all = readdirSync(dir).filter(n => n.startsWith(t)).map(n => readFileSync(join(dir, n), "utf8")).join("");
    expect(all).not.toContain("Elm Street");
    expect(all).toContain("\"kept\"");
    expect(readdirSync(dir).filter(n => n.endsWith(".tmp"))).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM event_log_forgets").get()).toEqual({ n: 0 });
  });
});

describe("rotation (P1-2 and Windows)", () => {
  beforeEach(() => { rmSync(EVENTS_DIR, { recursive: true, force: true }); ensureDirs(); });

  it("never discards a pre-upgrade file whose session lines were not copied (Fable's scenario)", async () => {
    eventLogLimits().threadBytes = 32 * 1024;
    const t = "2e9018ee-1f45-46be-8ed1-7a02fc022801";
    // the pre-upgrade log: every session since the conversation began, far over the cap
    let old = "";
    for (let s = 0; s < 5; s++) {
      old += line(ev(t, { type: "session.started", sessionId: `old-session-${s}`, providerInstanceId: "inst-claude" }));
      for (let i = 0; i < 40; i++) old += line(ev(t, { type: "content.delta", streamKind: "assistant_text", delta: "chunk ".repeat(100) }));
    }
    writeFileSync(join(EVENTS_DIR, `${t}.ndjson`), old);
    // the prune has not visited the thread; the owner's long turn writes large tool results
    const bus = new EventBus();
    for (let i = 0; i < 300; i++) {
      bus.publish(ev(t, { type: "item.completed", itemType: "tool", itemId: `t${i}`, ok: true, result: "r".repeat(1000) }));
      if (i % 50 === 0) await L.eventLogJobsSettled?.();
    }
    await L.eventLogJobsSettled?.();
    bus.publish(ev(t, { type: "session.started", sessionId: "new-session", providerInstanceId: "inst-claude" }));
    // the old file did go in the end: the thread is back within two capped files
    expect(readFileSync(join(EVENTS_DIR, `${t}.previous.ndjson`), "utf8")).not.toContain("old-session");
    const db = messagesDb(fresh("rotation-db"));
    const deletions = new ConversationDeletions({ dataDir: dirname(EVENTS_DIR), database: () => db });
    const planning = { threadIds: [t], instanceKind: () => "claudeAgent" };
    const entry = deletions.begin(planning, await deletions.collectLogSessions(planning.threadIds, planning));
    deletions.abandon(entry);
    expect([...(entry.engineSessions?.claude ?? [])].sort()).toEqual(["new-session", "old-session-0", "old-session-1", "old-session-2", "old-session-3", "old-session-4"]);
  });

  it("a rotation Windows refuses (EBUSY, EPERM) is retried, then tolerated: the event is written and the next one rotates", () => {
    eventLogLimits().threadBytes = 4 * 1024;
    log.setEventLogBudgetReady(true);
    const t = "win-rotate";
    const bus = new EventBus();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    L.eventLogIo.platform = "win32";
    // a transient refusal: the retry gets through
    L.eventLogIo.rename = (from: string, to: string) => { if (attempts++ < 2) throw Object.assign(new Error("EPERM"), { code: "EPERM" }); renameSync(from, to); };
    for (let i = 0; i < 12; i++) bus.publish(ev(t, { type: "item.completed", itemType: "tool", itemId: `a${i}`, ok: true, result: "x".repeat(500) }));
    expect(existsSync(join(EVENTS_DIR, `${t}.previous.ndjson`))).toBe(true);
    // a file held open for longer: the event is still written, the log grows past the cap for a while
    L.eventLogIo.rename = () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); };
    const before = size(join(EVENTS_DIR, `${t}.ndjson`));
    for (let i = 0; i < 12; i++) bus.publish(ev(t, { type: "item.completed", itemType: "tool", itemId: `b${i}`, ok: true, result: "x".repeat(500) }));
    expect(errors).not.toHaveBeenCalled();
    expect(size(join(EVENTS_DIR, `${t}.ndjson`))).toBeGreaterThan(before);
    expect(readFileSync(join(EVENTS_DIR, `${t}.ndjson`), "utf8")).toContain("\"b11\"");
    // the handle is gone: the next event rotates
    L.eventLogIo.rename = renameSync;
    bus.publish(ev(t, { type: "item.completed", itemType: "tool", itemId: "c0", ok: true, result: "x" }));
    expect(readFileSync(join(EVENTS_DIR, `${t}.previous.ndjson`), "utf8")).toContain("\"b11\"");
    expect(size(join(EVENTS_DIR, `${t}.ndjson`))).toBeLessThan(4 * 1024);
  });
});

function eventLogLimits() { return log.eventLogLimits; }

describe("the upgrade prune (P2)", () => {
  it("follows files, not names: a .previous replaced by an unpruned rotation is pruned too", async () => {
    eventLogLimits().threadBytes = 1024 * 1024;
    const dir = fresh("prune-ino");
    const t = "rot-thread";
    const old = (label: string) => [
      ev(t, { type: "content.delta", streamKind: "assistant_text", delta: `${label} chunk` }),
      ev(t, { type: "item.completed", itemType: "assistant_text", turnId: `${label}-f`, text: "the forgotten words are here" }),
      ev(t, { type: "item.completed", itemType: "assistant_text", turnId: `${label}-k`, text: `${label} kept` }),
    ].map(line).join("");
    writeFileSync(join(dir, `${t}.previous.ndjson`), old("older"));
    writeFileSync(join(dir, `${t}.ndjson`), old("newer"));
    const ino = (name: string) => { try { return statSync(join(dir, name)).ino; } catch { return 0; } };
    const startPrevious = ino(`${t}.previous.ndjson`), startCurrent = ino(`${t}.ndjson`);
    let rotated = false;
    // a rotation lands while the prune runs: once the previous file has been rewritten and before the current one is
    const busy = () => {
      if (!rotated && ino(`${t}.previous.ndjson`) !== startPrevious && ino(`${t}.ndjson`) === startCurrent) { renameSync(join(dir, `${t}.ndjson`), join(dir, `${t}.previous.ndjson`)); rotated = true; }
      return false;
    };
    const forgotten = () => [{ threadId: t, text: "the forgotten words are here" }];
    let result = { done: false };
    for (let pass = 0; pass < 5 && !result.done; pass++) result = await log.pruneEventLogs({ dir, threadKnown: () => true, forgotten, busy, chunkBytes: 64, sliceMs: 0 });
    expect(result.done).toBe(true);
    expect(rotated).toBe(true);
    const previous = readFileSync(join(dir, `${t}.previous.ndjson`), "utf8");
    expect(previous).toContain("newer kept");
    expect(previous).not.toContain("forgotten words");
    expect(previous).not.toContain("content.delta");
  });

  it("starts two minutes after listen when nothing asks for /api/health (a headless run)", async () => {
    vi.useFakeTimers();
    const gate = L.eventLogPruneGate();
    let started = false;
    void gate.ready.then(() => { started = true; });
    gate.armFallback();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(true);
    // the health answer starts it at once, and only once
    const early = L.eventLogPruneGate();
    let n = 0;
    void early.ready.then(() => { n++; });
    early.armFallback();
    early.answered(); early.answered();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(n).toBe(1);
  });

  it("replaces a large file without holding the main loop over 50 ms", async () => {
    eventLogLimits().threadBytes = 192 * 1024 * 1024;
    const dir = fresh("prune-slice");
    const t = "slice-thread";
    const filler = line(ev(t, { type: "item.completed", itemType: "tool", itemId: "t", ok: true, result: "y".repeat(2000) }));
    const delta = line(ev(t, { type: "content.delta", streamKind: "assistant_text", delta: "chunk" }));
    let text = delta;
    while (Buffer.byteLength(text) + filler.length < 4 * 1024 * 1024) text += filler;
    const out = await open(join(dir, `${t}.ndjson`), "w");
    for (let i = 0; i < 52; i++) await out.write(text);
    await out.close();
    const probe = loopProbe();
    const result = await log.pruneEventLogs({ dir, threadKnown: () => true, forgotten: () => [], busy: () => false });
    const worst = probe.stop();
    expect(result.done).toBe(true);
    expect(size(join(dir, `${t}.ndjson`))).toBeLessThanOrEqual(192 * 1024 * 1024);
    expect(size(join(dir, `${t}.ndjson`))).toBeGreaterThan(180 * 1024 * 1024);
    expect(worst).toBeLessThan(50);
  }, 120_000);

  it("keeps every session it merges, not only the newest 512, in small lines", async () => {
    const dir = fresh("prune-sessions");
    const t = "many-sessions";
    let text = "";
    for (let s = 0; s < 700; s++) text += line(ev(t, { type: "session.started", sessionId: `s-${s}`, providerInstanceId: "inst-claude", model: "m", extra: "z".repeat(300) }));
    writeFileSync(join(dir, `${t}.ndjson`), text);
    await log.pruneEventLogs({ dir, threadKnown: () => true, forgotten: () => [], busy: () => false });
    const lines = readFileSync(join(dir, `${t}.sessions.ndjson`), "utf8").trim().split("\n");
    expect(new Set(lines.map(l => JSON.parse(l).sessionId)).size).toBe(700);
    expect(lines.every(l => l.length < 300)).toBe(true);
  });
});

describe("readers and the sweep (P2)", () => {
  beforeEach(() => { rmSync(EVENTS_DIR, { recursive: true, force: true }); ensureDirs(); });

  it("conversation deletion finds the sessions in a log over the string limit", async () => {
    const data = fresh("delete-big");
    const events = join(data, "events");
    mkdirSync(events, { recursive: true });
    const t = "2e9018ee-1f45-46be-8ed1-7a02fc022899";
    const path = join(events, `${t}.ndjson`);
    writeFileSync(path, line(ev(t, { type: "session.started", sessionId: "first-sess", providerInstanceId: "inst-claude" })));
    // a sparse 600 MiB stretch (a log written before the upgrade), then the newest session
    truncateSync(path, 600 * 1024 * 1024);
    appendFileSync(path, "\n" + line(ev(t, { type: "session.started", sessionId: "last-sess", providerInstanceId: "inst-claude" })));
    const db = messagesDb(data);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db });
    const planning = { threadIds: [t], instanceKind: () => "claudeAgent" };
    const entry = deletions.begin(planning, await deletions.collectLogSessions(planning.threadIds, planning));
    deletions.abandon(entry);
    expect([...(entry.engineSessions?.claude ?? [])].sort()).toEqual(["first-sess", "last-sess"]);
  }, 120_000);

  it("deletion's session lookup does the same work on a 2 GiB log as on a small one, and never holds the loop", async () => {
    const mk = (name: string, gib: number) => {
      const data = fresh(name);
      const events = join(data, "events");
      mkdirSync(events, { recursive: true });
      const t = `${name.length}9018ee-1f45-46be-8ed1-7a02fc022899`;
      const path = join(events, `${t}.ndjson`);
      writeFileSync(path, line(ev(t, { type: "session.started", sessionId: "first-sess", providerInstanceId: "inst-claude" })));
      if (gib) { truncateSync(path, gib * 1024 * 1024 * 1024); appendFileSync(path, "\n" + line(ev(t, { type: "session.started", sessionId: "last-sess", providerInstanceId: "inst-claude" }))); }
      return { data, t, deletions: new ConversationDeletions({ dataDir: data, database: () => messagesDb(data) }) };
    };
    const planning = (t: string) => ({ threadIds: [t], instanceKind: () => "claudeAgent" });
    const small = mk("small", 0), big = mk("big", 2);
    const bytes = { small: [] as number[], big: [] as number[] };
    // the first call over an old log reads it once, in short slices; the loop keeps ticking
    let last = performance.now(), worst = 0;
    const ticker = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 5);
    const firstSmall = await small.deletions.collectLogSessions([small.t], planning(small.t), { onBytes: n => bytes.small.push(n) });
    const firstBig = await big.deletions.collectLogSessions([big.t], planning(big.t), { onBytes: n => bytes.big.push(n) });
    clearInterval(ticker);
    expect(firstSmall.claude).toEqual(["first-sess"]);
    expect([...(firstBig.claude ?? [])].sort()).toEqual(["first-sess", "last-sess"]);
    expect(worst).toBeLessThan(50);
    // the sessions are now in the compact file: the same call costs the same on either log
    bytes.small.length = 0; bytes.big.length = 0;
    const again = await big.deletions.collectLogSessions([big.t], planning(big.t), { onBytes: n => bytes.big.push(n) });
    expect([...(again.claude ?? [])].sort()).toEqual(["first-sess", "last-sess"]);
    expect(bytes.big.reduce((a, b) => a + b, 0)).toBeLessThan(2048);
    await small.deletions.collectLogSessions([small.t], planning(small.t), { onBytes: n => bytes.small.push(n) });
    expect(bytes.small.reduce((a, b) => a + b, 0)).toBeLessThan(2048);
    // planning itself never scans: begin without the read refuses
    expect(() => big.deletions.begin(planning(big.t))).toThrow(/collectLogSessions/);
  }, 300_000);

  it("the budget sweep reads the folder off the publish path", async () => {
    eventLogLimits().sweepEveryBytes = 1;
    log.setEventLogBudgetReady(true);
    const stale = join(EVENTS_DIR, "stale-thread.ndjson");
    writeFileSync(stale, line(ev("stale-thread", { type: "turn.started" })));
    const longAgo = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, longAgo, longAgo);
    const bus = new EventBus();
    bus.publish(ev("sweep-live", { type: "turn.started" }));
    // the publish returned before the sweep touched the folder
    expect(existsSync(stale)).toBe(true);
    await L.eventLogJobsSettled();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(EVENTS_DIR, "sweep-live.ndjson"))).toBe(true);
  });
});
