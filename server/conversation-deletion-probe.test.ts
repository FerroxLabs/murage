// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SELF-OVERLOAD-105 item 2: a deletion whose engine history stays held by the same program is not planned again every 10 minutes (a
// worker-thread plan, a pause of the background runs and a log line per home each time, all day against a terminal the owner keeps open);
// a process-list probe looks, and the attempt runs only once the holders change or go.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it, vi } from "vitest";
import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-delete-probe-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
let counter = 0;
const fresh = (name: string) => { const dir = join(scratch, `${name}-${++counter}`); mkdirSync(dir, { recursive: true }); return dir; };
const touch = (file: string, text = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const BOT = "f25024c1-a18e-4251-acf1-0c1713d9b6d9";
const THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";
const MARKER_TEXT = "private-words-8841";
const fileHas = (file: string, text: string) => [file, `${file}-wal`].some((name) => existsSync(name) && readFileSync(name).includes(text));
function messagesDb(dir: string) {
  const db = new DatabaseSync(join(dir, "messages.db"));
  openDatabases.push(db);
  db.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  return db;
}
function fuigoSearchIndex(file: string, rows: Array<{ id: string; cwd: string; title: string; content: string }>): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_docs (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS session_docs_fts USING fts5(title, content, content='session_docs', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS session_docs_ai AFTER INSERT ON session_docs BEGIN
      INSERT INTO session_docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
    CREATE TRIGGER IF NOT EXISTS session_docs_ad AFTER DELETE ON session_docs BEGIN
      INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content); END;`);
  const insert = db.prepare("INSERT INTO session_docs(session_id, cwd, updated_at, title, content, content_hash) VALUES (?,?,?,?,?,?)");
  for (const row of rows) insert.run(row.id, row.cwd, 1, row.title, row.content, "h");
  return db;
}

it("fail-before: a home held by the same program is looked at, not planned again; the attempt runs once the holders change", async () => {
  const data = fresh("data"), fuigoHome = fresh("fuigo"), db = messagesDb(data);
  const desk = join(data, "workspaces", BOT, "threads", THREAD);
  touch(join(desk, "a.md"));
  const index = join(fuigoHome, "sessions", "session_search.sqlite");
  const seeded = fuigoSearchIndex(index, [{ id: "gone-1", cwd: desk, title: "t", content: MARKER_TEXT }, { id: "kept-1", cwd: "/w/x", title: "k", content: "keep" }]);
  seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seeded.close();
  const reader = new DatabaseSync(index); // the engine's own connection, mid-read: the first attempt cannot finish the home
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM session_docs").get();
  let attempts = 0, probes = 0;
  let holders = "4242:fuigo";
  let open = true;
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: [100, 100, 100, 100, 100, 100], openRetryMs: 100, openLooksMax: 1000,
    pauseBackgroundRuns: async () => { attempts++; return () => {}; },
    probeHomes: (homes) => { probes++; return homes.map((home) => ({ key: `${home.engine}\0${home.home}`, open, holders })); },
  });
  try {
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
    expect(report.failed).toEqual([index]);
    expect(deletions.pending()).toHaveLength(1);
    expect(attempts).toBe(1);
    // a second: with the flat schedule of 1.0.4 that is about ten more attempts; now only probes, and the one attempt stands
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    expect(probes).toBeGreaterThanOrEqual(3);
    expect(attempts, "no attempt while the same program holds the home").toBe(1);
    expect(fileHas(index, MARKER_TEXT)).toBe(true);
    // the holders changed (the owner closed the terminal; the engine's read ended): the next look plans and finishes
    reader.exec("COMMIT"); reader.close();
    open = false; holders = "";
    await vi.waitFor(() => expect(deletions.pending()).toEqual([]), { timeout: 10_000 });
    expect(attempts).toBe(2);
    expect(fileHas(index, MARKER_TEXT)).toBe(false);
  } finally { deletions.dispose(); try { reader.close(); } catch { /* closed */ } }
});

it("without a probe the schedule is unchanged (the attempt runs on every retry)", async () => {
  const data = fresh("data"), fuigoHome = fresh("fuigo"), db = messagesDb(data);
  const desk = join(data, "workspaces", BOT, "threads", THREAD);
  touch(join(desk, "a.md"));
  const index = join(fuigoHome, "sessions", "session_search.sqlite");
  const seeded = fuigoSearchIndex(index, [{ id: "gone-1", cwd: desk, title: "t", content: MARKER_TEXT }]);
  seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seeded.close();
  const reader = new DatabaseSync(index);
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM session_docs").get();
  let attempts = 0;
  const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [100, 100, 100, 100, 100, 100], pauseBackgroundRuns: async () => { attempts++; return () => {}; } });
  try {
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
  } finally { deletions.dispose(); reader.exec("COMMIT"); reader.close(); }
});

it("fail-before: a deletion that keeps losing to Murage's own running turn holds longer each attempt (250 ms, 1 s, 4 s, 15 s, 60 s, 4 min), so it ends", async () => {
  const data = fresh("data"), fuigoHome = fresh("fuigo"), db = messagesDb(data);
  const desk = join(data, "workspaces", BOT, "threads", THREAD);
  touch(join(desk, "a.md"));
  const index = join(fuigoHome, "sessions", "session_search.sqlite");
  const seeded = fuigoSearchIndex(index, [{ id: "gone-1", cwd: desk, title: "t", content: MARKER_TEXT }]);
  seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seeded.close();
  const waits: number[] = [];
  let busy = true;
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: [50, 50, 50, 50, 50, 50], openRetryMs: 50,
    // the running turn outlasts every wait while `busy`: the home is skipped (engine-running) and the deletion stays owed
    holdHomes: async (homes, waitMs) => { waits.push(waitMs ?? -1); return { release: () => {}, skipped: busy ? homes : [] }; },
  });
  try {
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
    await vi.waitFor(() => expect(waits.length).toBeGreaterThanOrEqual(5), { timeout: 10_000 });
    expect(waits.slice(0, 5)).toEqual([250, 1_000, 4_000, 15_000, 60_000]);
    busy = false; // the turn ended inside the wait: the hold succeeds and the deletion finishes
    await vi.waitFor(() => expect(deletions.pending()).toEqual([]), { timeout: 10_000 });
    expect(fileHas(index, MARKER_TEXT)).toBe(false);
  } finally { deletions.dispose(); }
});

it("after OPEN_LOOKS_MAX unchanged looks the attempt runs anyway (the worker judges the home itself)", async () => {
  const data = fresh("data"), fuigoHome = fresh("fuigo"), db = messagesDb(data);
  const desk = join(data, "workspaces", BOT, "threads", THREAD);
  touch(join(desk, "a.md"));
  const index = join(fuigoHome, "sessions", "session_search.sqlite");
  const seeded = fuigoSearchIndex(index, [{ id: "gone-1", cwd: desk, title: "t", content: MARKER_TEXT }]);
  seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seeded.close();
  const reader = new DatabaseSync(index);
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM session_docs").get();
  let attempts = 0, probes = 0;
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: [50, 50, 50, 50, 50, 50], openRetryMs: 50, openLooksMax: 3,
    pauseBackgroundRuns: async () => { attempts++; return () => {}; },
    probeHomes: (homes) => { probes++; return homes.map((home) => ({ key: `${home.engine}\0${home.home}`, open: true, holders: "4242:fuigo" })); },
  });
  try {
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
    expect(attempts).toBe(1);
    // three unchanged looks skip; the fourth runs the attempt although the probe still says "same holders"
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(probes).toBeGreaterThanOrEqual(4);
  } finally { deletions.dispose(); reader.exec("COMMIT"); reader.close(); }
});
