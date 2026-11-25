// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// cause7-1021 (a): on a busy profile the deletion retry never settled. Many deleted conversations were owed on ONE engine home that the
// owner's own CLI keeps open all day, and Murage's log wrote "the engine history is still open by the same program" 90 times in 35
// minutes, with a whole attempt (pause, hold, Murage's idle sessions closed) several times a minute. Three causes, one witness each:
//   W1  the retry probe's fingerprint named every other program's process by pid. The owner's CLI starts a helper under its own program
//       for every tool call, so the fingerprint changed at nearly every look, and a full attempt ran at every look of every deletion.
//   W2  the "still open" line was once per DELETION and holder set: thirty deletions on one home wrote thirty lines a round.
//   W3  the whole try a held home gets "every sixth try (an hour)" was counted per home over every deletion's tries, so with many
//       deletions it came every few seconds, each one pausing the background runs and holding the engine's new turns.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { probeDeletionHomes } from "./engine-closed.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { BOT, buildFixture, THREAD } from "./testing/engine-history-fixtures.ts";
import { proc, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-delete-loop-1021-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
let counter = 0;
const fresh = (name: string) => { const dir = join(scratch, `${name}-${++counter}`); mkdirSync(dir, { recursive: true }); return dir; };
const touch = (file: string, text = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const THREADS = [THREAD, "7b0d3c52-6f1e-4c0a-9d42-51a6e8f0c311", "c1a94e07-2b5d-4f38-8e6a-0d7f3b925a44"];
const MARKER_TEXT = "private-words-7731";
const STILL_OPEN = "the engine history is still open by the same program";
const fileHas = (file: string, text: string) => [file, `${file}-wal`].some((name) => existsSync(name) && readFileSync(name).includes(text));
const stillOpenLines = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter((call) => String(call[0]).includes(STILL_OPEN)).length;

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); });
afterEach(() => {
  fake.restore(); vi.restoreAllMocks();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

/** Deleted conversations' Fuigo search rows (one per thread), with the engine's own reader mid-read so no attempt can finish the home. */
function setup(threads: string[]) {
  const data = fresh("data"), fuigoHome = fresh("fuigo");
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  db.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  const index = join(fuigoHome, "sessions", "session_search.sqlite");
  mkdirSync(path.dirname(index), { recursive: true });
  const seeded = new DatabaseSync(index);
  seeded.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_docs (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS session_docs_fts USING fts5(title, content, content='session_docs', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS session_docs_ai AFTER INSERT ON session_docs BEGIN
      INSERT INTO session_docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
    CREATE TRIGGER IF NOT EXISTS session_docs_ad AFTER DELETE ON session_docs BEGIN
      INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content); END;`);
  threads.forEach((thread, n) => {
    const desk = join(data, "workspaces", BOT, "threads", thread);
    touch(join(desk, "a.md"));
    seeded.prepare("INSERT INTO session_docs(session_id, cwd, updated_at, title, content, content_hash) VALUES (?,?,?,?,?,?)").run(`gone-${n}`, desk, 1, "t", MARKER_TEXT, "h");
  });
  seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seeded.close();
  const reader = new DatabaseSync(index);
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM session_docs").get();
  const release = () => { try { reader.exec("COMMIT"); reader.close(); } catch { /* closed */ } };
  return { data, fuigoHome, db, index, release };
}

it("W1: the owner's program starting a new helper process at every look does not re-run the attempt; the deletion still finishes once it closes", async () => {
  const { data, fuigoHome, db, index, release } = setup([THREAD]);
  const warn = vi.spyOn(console, "warn");
  // the owner's own program in a terminal (not Murage's child), open the whole time
  const closeOwner = fake.openEngine("fuigo");
  // and a helper it starts for each tool call: the same program, not under Murage, a new pid at every look
  let call = 0;
  const helper = proc("/usr/local/bin/fuigo", ["fuigo"], 9300);
  fake.processes.push(helper);
  fake.onProcesses = () => { helper.pid = 9300 + (++call); };
  let attempts = 0, probes = 0;
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: [50, 50, 50, 50, 50, 50], openRetryMs: 50, openLooksMax: 1000,
    pauseBackgroundRuns: async () => { attempts++; return () => {}; },
    holdHomes: async () => ({ release: () => {}, skipped: [] }),
    probeHomes: (homes) => { probes++; return probeDeletionHomes(homes, join(data, "native")); },
  });
  try {
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
    expect(attempts).toBe(1);
    await vi.waitFor(() => expect(probes).toBeGreaterThanOrEqual(12), { timeout: 5_000 });
    expect(attempts, "another program holds the home the whole time: looks only, whatever its pids are").toBe(1);
    expect(stillOpenLines(warn), "one line for the home, not one per new pid").toBeLessThanOrEqual(1);
    expect(deletions.pending()).toHaveLength(1);
    expect(fileHas(index, MARKER_TEXT)).toBe(true);
    // the owner closes the program: the next look reads the home as not open, plans and finishes
    closeOwner(); fake.processes.splice(fake.processes.indexOf(helper), 1); fake.onProcesses = undefined; release();
    await vi.waitFor(() => expect(deletions.pending()).toEqual([]), { timeout: 5_000 });
    expect(attempts).toBe(2);
    expect(fileHas(index, MARKER_TEXT)).toBe(false);
  } finally { deletions.dispose(); release(); }
});

it("W2: several deletions owed on one home held by the same program write the 'still open' line once, not once each", async () => {
  const { data, fuigoHome, db, release } = setup(THREADS);
  const warn = vi.spyOn(console, "warn");
  fake.openEngine("fuigo"); // the owner's own program, never closed in this test
  let probes = 0;
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: [40, 40, 40, 40, 40, 40], openRetryMs: 40, openLooksMax: 1000,
    holdHomes: async () => ({ release: () => {}, skipped: [] }),
    probeHomes: (homes) => { probes++; return probeDeletionHomes(homes, join(data, "native")); },
  });
  try {
    for (const thread of THREADS) await runConversationDeletion(deletions, { threadIds: [thread], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
    expect(deletions.pending()).toHaveLength(THREADS.length);
    // every deletion has had its looks (each look is one probe; the attempts' own holdersOf calls are counted too)
    await vi.waitFor(() => expect(probes).toBeGreaterThanOrEqual(THREADS.length * 8), { timeout: 8_000 });
    expect(stillOpenLines(warn), "one line for the home and its holder, whichever deletion looked first").toBe(1);
    expect(deletions.pending()).toHaveLength(THREADS.length);
  } finally { deletions.dispose(); release(); }
});

class InlineWorker extends EventEmitter {
  threadId = 7;
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.emit("message", { type: "result", result: runEngineHistoryJob(message) })); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}

/** Three deletions owed on one Claude home that the owner's own CLI keeps open; the worker runs inline so it sees the same processes. */
function heldClaudeHome(fullTryMs?: number, timers?: { retryDelaysMs: number[]; openRetryMs: number; probe: true }) {
  const fx = buildFixture("claude", scratch);
  const home = fx.homes[0]!.home;
  engineHistoryTestHooks.createWorker = () => new InlineWorker() as unknown as Worker;
  const data = join(fx.root, "data");
  for (const thread of THREADS.slice(1)) touch(join(data, "workspaces", BOT, "threads", thread, "a.md"));
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  const item = proc("/opt/tools/claude/versions/2.1.308", ["claude"], 7600);
  fake.processes.push(item);
  fake.environments.set(item.pid, { HOME: scratch, CLAUDE_CONFIG_DIR: home });
  const events: string[] = [];
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: timers?.retryDelaysMs ?? [], ...(fullTryMs !== undefined ? { fullTryMs } : {}),
    ...(timers ? { openRetryMs: timers.openRetryMs, probeHomes: (homes: Array<{ engine: string; home: string }>) => probeDeletionHomes(homes, join(data, "native")) } : {}),
    pauseBackgroundRuns: async (engines) => { events.push(`pause ${engines.join(",")}`); return () => {}; },
    holdHomes: async (homes) => { events.push(`hold ${homes.length}`); return { release: () => {}, skipped: [] }; },
  });
  return { fx, deletions, events };
}
/** The first attempt of each deletion, then `rounds` scheduled attempts of each (finish, as the retry timer calls it: not a press). */
async function attemptsOnOneHome(w: ReturnType<typeof heldClaudeHome>, rounds: number): Promise<number> {
  let tries = 0;
  for (const thread of THREADS) { await runConversationDeletion(w.deletions, { threadIds: [thread], engineHomes: w.fx.homes }, () => true); tries++; }
  expect(w.deletions.pending()).toHaveLength(THREADS.length);
  for (let round = 0; round < rounds; round++) for (const entry of w.deletions.pending()) { await w.deletions.finish(entry); tries++; }
  return tries;
}

it("W3: with several deletions owed on one held home, the whole try (pause, hold) comes once an hour for the home, not every sixth try of any of them", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const w = heldClaudeHome();
  try {
    expect(await attemptsOnOneHome(w, 5)).toBe(18); // three deletions, six tries each: inside one minute here, an hour apart for real
    // base: tries 6, 12 and 18 were whole attempts (three holds, three pauses)
    expect(w.events.filter((event) => event.startsWith("hold")), "the home's one whole try of the hour is still made").toEqual(["hold 1"]);
    expect(w.events.filter((event) => event.startsWith("pause"))).toEqual(["pause claude"]);
    expect(w.deletions.pending()).toHaveLength(THREADS.length);
    // "Try again now" is the owner asking: a due whole try is not held back by the hour
    await w.deletions.retryNow();
    expect(w.events.filter((event) => event.startsWith("hold")).length).toBe(2);
  } finally { w.deletions.dispose(); }
});

it("W3 control: with no time floor the count rule alone gives the whole try at every sixth try of the home (what 1.0.21 did)", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const w = heldClaudeHome(0);
  try {
    expect(await attemptsOnOneHome(w, 5)).toBe(18);
    expect(w.events.filter((event) => event.startsWith("hold"))).toEqual(["hold 1", "hold 1", "hold 1"]);
  } finally { w.deletions.dispose(); }
});

it("W4: ONE deletion on a held home still gets its whole try after the hour of looks (looks count as tries), not after six forced attempts", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // real retry timers and the real probe: the holder never changes, so every look is a look and only OPEN_LOOKS_MAX forces an attempt
  const w = heldClaudeHome(undefined, { retryDelaysMs: [20, 20, 20, 20], openRetryMs: 20, probe: true });
  try {
    await runConversationDeletion(w.deletions, { threadIds: [THREAD], engineHomes: w.fx.homes }, () => true);
    expect(w.events.filter((event) => event.startsWith("hold")), "the first attempt skips the held home").toEqual([]);
    const finish = vi.spyOn(w.deletions, "finish");
    await vi.waitFor(() => expect(w.events.filter((event) => event.startsWith("hold")).length).toBeGreaterThanOrEqual(1), { timeout: 8_000 });
    // without the looks counted the whole try needs six attempts, each after OPEN_LOOKS_MAX looks (seven hours at the real pace)
    expect(finish.mock.calls.length, "the first attempt the looks force is the whole try").toBe(1);
    expect(w.deletions.pending()).toHaveLength(1);
  } finally { w.deletions.dispose(); }
});
