// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// DELETE-LOOP-1020 (hunt 1020q T6): a deleted conversation whose engine history Murage's OWN engine process holds never finished, and the
// log said "the engine history is still open by the same program" every ~77 s all day (442 lines in one owner log). The retry probe
// (engine-closed.ts probeDeletionHomes, the one server/index.ts wires) counted Murage's own engine processes as holders, unlike the
// attempt's own gate (foreignEngineHolders): a warm session of Murage's own made every look "held by the same program", so the attempt
// whose hold closes that session never ran; a new own turn process changed the fingerprint, so a full attempt ran at every look; and
// every attempt re-armed the log line. Now Murage's own process tree is never a reason to skip, the fingerprint is the other programs
// only, and the line is written once per deletion per holder set.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { probeDeletionHomes } from "./engine-closed.ts";
import { proc, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-delete-own-engine-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
let counter = 0;
const fresh = (name: string) => { const dir = join(scratch, `${name}-${++counter}`); mkdirSync(dir, { recursive: true }); return dir; };
const touch = (file: string, text = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const BOT = "f25024c1-a18e-4251-acf1-0c1713d9b6d9";
const THREAD = "2e9018ee-1f45-46be-8ed1-7a02fc022807";
const MARKER_TEXT = "private-words-5517";
const STILL_OPEN = "the engine history is still open by the same program";
const fileHas = (file: string, text: string) => [file, `${file}-wal`].some((name) => existsSync(name) && readFileSync(name).includes(text));

let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); });
afterEach(() => { fake.restore(); vi.restoreAllMocks(); });

/** A deleted conversation's Fuigo search row, with the engine's own reader mid-read so the first attempt cannot finish the home. */
function setup() {
  const data = fresh("data"), fuigoHome = fresh("fuigo");
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  db.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  const desk = join(data, "workspaces", BOT, "threads", THREAD);
  touch(join(desk, "a.md"));
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
  seeded.prepare("INSERT INTO session_docs(session_id, cwd, updated_at, title, content, content_hash) VALUES (?,?,?,?,?,?)").run("gone-1", desk, 1, "t", MARKER_TEXT, "h");
  seeded.exec("PRAGMA wal_checkpoint(TRUNCATE)"); seeded.close();
  const reader = new DatabaseSync(index);
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM session_docs").get();
  const release = () => { try { reader.exec("COMMIT"); reader.close(); } catch { /* closed */ } };
  return { data, fuigoHome, db, index, release };
}
const stillOpenLines = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter((call) => String(call[0]).includes(STILL_OPEN)).length;

it("fail-before: a home held only by Murage's own warm engine is attempted (its hold closes the engine) and finishes once, with no 'still open' line", async () => {
  const { data, fuigoHome, db, index, release } = setup();
  const warn = vi.spyOn(console, "warn");
  // Murage's own engine session on the home (a child of this process), idle between turns: the same pid at every look
  const closeWarm = fake.openEngine("fuigo", process.pid);
  let attempts = 0, holds = 0;
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: [100, 100, 100, 100, 100, 100], openRetryMs: 100, openLooksMax: 1000,
    pauseBackgroundRuns: async () => { attempts++; return () => {}; },
    // the server's hold (registry.holdInstances): an idle warm process of Murage's own on the home is closed before the plan
    holdHomes: async () => { holds++; if (holds > 1) closeWarm(); return { release: () => {}, skipped: [] }; },
    probeHomes: (homes) => probeDeletionHomes(homes, join(data, "native")),
  });
  try {
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
    expect(report.failed).toEqual([index]);
    expect(attempts).toBe(1);
    release(); // the engine's read ended; only Murage's own idle session is left on the home
    await vi.waitFor(() => expect(deletions.pending(), "the next retry plans (Murage's own engine is no reason to skip) and finishes").toEqual([]), { timeout: 5_000 });
    expect(attempts).toBe(2);
    expect(fileHas(index, MARKER_TEXT)).toBe(false);
    expect(stillOpenLines(warn), "Murage's own process is never 'the same program' of that line").toBe(0);
  } finally { deletions.dispose(); release(); closeWarm(); }
});

it("fail-before: new own-turn processes beside another program that keeps the home open do not re-run the attempt at every look", async () => {
  const { data, fuigoHome, db, release } = setup();
  vi.spyOn(console, "warn");
  // the owner's own Fuigo in a terminal (not Murage's child): the same program the whole time
  fake.openEngine("fuigo");
  // and Murage's own turns on the engine: a new process (a new pid) at every look
  let turn = 0;
  const ownTurn = { ...proc("/usr/local/bin/fuigo", ["fuigo"], 9100), ppid: process.pid };
  fake.processes.push(ownTurn);
  fake.onProcesses = () => { ownTurn.pid = 9100 + (++turn); };
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
    await vi.waitFor(() => expect(probes).toBeGreaterThanOrEqual(10), { timeout: 5_000 });
    expect(attempts, "the other program never changed: looks only, no plan, no pause of the background runs").toBe(1);
    expect(deletions.pending()).toHaveLength(1);
  } finally { deletions.dispose(); release(); }
});

it("fail-before: the 'still open' line is written once per deletion while the same program holds the home, across the attempts the looks force", async () => {
  const { data, fuigoHome, db, release } = setup();
  const warn = vi.spyOn(console, "warn");
  fake.openEngine("fuigo"); // the owner's own program, never closed in this test
  let attempts = 0;
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: [30, 30, 30, 30, 30, 30], openRetryMs: 30, openLooksMax: 2,
    pauseBackgroundRuns: async () => { attempts++; return () => {}; },
    holdHomes: async () => ({ release: () => {}, skipped: [] }),
    probeHomes: (homes) => probeDeletionHomes(homes, join(data, "native")),
  });
  try {
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: [{ engine: "fuigo", home: fuigoHome }] }, () => true);
    // every third look runs the attempt anyway (openLooksMax 2) and it fails again: four attempts, each followed by looks
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(4), { timeout: 10_000 });
    expect(stillOpenLines(warn), "one line, not one per attempt").toBe(1);
    expect(deletions.pending()).toHaveLength(1);
  } finally { deletions.dispose(); release(); }
});
