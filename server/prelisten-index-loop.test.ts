// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 T1: the one-time index build before listen must not repeat at every start. A start that ended during the build (the shell's stop at
// its start-up limit, a quit, a crash) kept nothing, so the next start began the same build again; on a large history no start ever served.
// The witnesses use a real file, a real server process, a real SIGKILL and the shell's own reader of the start-up note.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMemoryUpgradeStatus, isOneTimeIndexNote, readMemoryUpgradeStatus } from "../electron/memory-upgrade-status.mjs";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, setUpgradeReporterForTest } from "./database.ts";
import * as Optional from "./memory/optional-index.ts";
import { setReadTimeJudgeRetired } from "./memory/root-set-reclaim.ts";
import * as Mdb from "./message-db.ts";
import * as Tables from "./message-tables.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

vi.setConfig({ testTimeout: 900_000 });
const HERE = dirname(fileURLToPath(import.meta.url));
const DYING_CHILD = join(HERE, "testing", "prelisten-loop-child.ts");
const READ_CHILD = join(HERE, "testing", "turn-index-child.ts");
const INDEX = "messages_turn";
const MARKER = `prelisten-build:${INDEX}`;
const FILE = () => join(DATA_DIR, "messages.db");
const T = Tables as unknown as { TURN_INDEX_DDL: string; TURN_INDEX_PREVIOUS_DDL: string; TURN_INDEX_PRELISTEN_MAX_BYTES?: number };
const M = Mdb as unknown as { TURN_INDEX_NOT_READY: string; turnRows: (t: string, u: string) => Message[] };
const CURRENT = T.TURN_INDEX_DDL.replace(" IF NOT EXISTS", "");
/** Absent on a tree without the fix: read as "not left until after listen", so such a tree fails on what it does, not on a missing name. */
const leftUntilAfterListen = (db: DatabaseSync) => (Optional as unknown as { preListenIndexDeferred?: (db: DatabaseSync, name: string) => boolean }).preListenIndexDeferred?.(db, INDEX) ?? false;

function raw(): DatabaseSync {
  const db = new DatabaseSync(FILE());
  db.exec("PRAGMA busy_timeout=20000");
  return db;
}
const definition = (db: DatabaseSync) => (db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(INDEX) as { sql: string } | undefined)?.sql ?? null;
const marker = (db: DatabaseSync) => db.prepare("SELECT 1 FROM transcript_index_state WHERE name=?").get(MARKER) !== undefined;
const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);
function oracle(db: DatabaseSync, threadId: string, turnId: string): Message[] {
  return (db.prepare("SELECT json FROM messages NOT INDEXED WHERE thread_id = ? ORDER BY rowid").all(threadId) as Array<{ json: string }>)
    .map(row => JSON.parse(row.json) as Message).filter(row => row.turnId === turnId);
}
/** The SQL a read really runs against messages (io-budget.ts wraps `prepare` on the instance at open, so the spy goes on the instance). */
function captured<R>(run: () => R): { result: R; sql: string[] } {
  const sql: string[] = [];
  const connection = database();
  const real = connection.prepare;
  const spy = vi.spyOn(connection, "prepare").mockImplementation((text: string) => { sql.push(text); return real.call(connection, text); });
  try { return { result: run(), sql: sql.filter(text => /\bFROM messages\b/.test(text)) }; } finally { spy.mockRestore(); }
}

/** A history shaped like an owner's: several conversations, turns of a prompt, tool calls with their output and a reply, text with quotes,
 * backslashes and newlines, and rows with no turn. `bytes` is the least the file must hold. Returns turns to check. */
function writeHistory(db: DatabaseSync, bytes: number): Array<{ threadId: string; turnId: string }> {
  const insert = db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const output = (n: number) => Array.from({ length: 28 }, (_, i) => `src/app/module-${n % 97}/file-${i}.ts:${i * 7 + 1}:  const path = "C:\\\\Users\\\\owner\\\\work"; // "quoted" turnId ${n}\n`).join("");
  const checks: Array<{ threadId: string; turnId: string }> = [];
  let n = 0, at = 1_700_000_000_000, written = 0;
  const put = (threadId: string, m: Record<string, unknown>) => {
    const json = JSON.stringify(m);
    insert.run(threadId, String(m.id), Number(m.at), String(m.role), String(m.kind), typeof m.text === "string" ? m.text : null, json);
    written += json.length;
  };
  while (written < bytes) {
    db.exec("BEGIN IMMEDIATE");
    for (let batch = 0; batch < 400; batch++) {
      const threadId = `thread-${n % 23}`, turnId = `turn-${n}`;
      put(threadId, { id: `m${n}-u`, at: at++, role: "user", kind: "text", text: `please look at module ${n} and "fix" it\nthanks`, turnId });
      for (let tool = 0; tool < 3; tool++) put(threadId, { id: `m${n}-t${tool}`, at: at++, role: "bot", kind: "activity", turnId, tool: { name: tool === 1 ? "Edit" : "Bash", input: { command: `rg -n "turnId" src/app/module-${n % 97}` }, output: output(n + tool), status: "done" } });
      put(threadId, { id: `m${n}-r`, at: at++, role: "bot", kind: "text", text: `Done. I changed module ${n}.\n\n${output(n).slice(0, 900)}`, turnId });
      if (n % 5 === 0) put(threadId, { id: `m${n}-n`, at: at++, role: "system", kind: "notice", text: "a row no turn wrote" });
      if (n % 1777 === 3 || n === 0) checks.push({ threadId, turnId });
      n++;
    }
    db.exec("COMMIT");
  }
  checks.push({ threadId: `thread-${(n - 1) % 23}`, turnId: `turn-${n - 1}` });
  return checks;
}
function expectExact(checks: Array<{ threadId: string; turnId: string }>): void {
  const db = database();
  for (const { threadId, turnId } of checks) {
    const want = ids(oracle(db, threadId, turnId));
    expect(want.length, `${threadId} ${turnId}`).toBeGreaterThanOrEqual(5);
    expect(ids(M.turnRows(threadId, turnId)), `${threadId} ${turnId}`).toEqual(want);
  }
  expect(M.turnRows(checks[0]!.threadId, "no-such-turn")).toEqual([]);
}

const openGate = { ownerIdleMs: () => 3_600_000, liveTurn: () => false, typingHeld: () => false, routineDueWithin: () => false, healthAnswered: () => true, integrityPending: () => false, revocationWaiting: () => false };
/** The build after listen as the running server makes it: the idle sweep, one index per idle window, each on a worker thread with a connection of its own. */
async function buildAfterListen(db: DatabaseSync): Promise<string[]> {
  const built: string[] = [];
  for (let pass = 0; pass < 60 && definition(db) !== CURRENT; pass++) {
    Optional.resetOptionalIndexWindow();
    const name = await Optional.buildOptionalIndexesWhenIdle(db, openGate, { retryMs: 50 });
    if (name) built.push(name);
  }
  return built;
}

type Start = "served" | "stopped-in-the-index-step" | "exited" | "silent";
/** One launch of the real server on DATA_DIR, watched as the desktop shell watches it: the shell's own reader of the start-up note says when the
 * child is inside the one-time index step, and a start still inside it `capMs` later is stopped the shell's way (a kill with no close, then the
 * note removed: main.mjs startServerOn). The shell's limits are minutes; `capMs` is scaled to this file, on which the build takes far longer.
 * A start that serves is ended the same hard way, so every next start begins from whatever an unclean end left. */
async function launch(capMs: number): Promise<{ outcome: Start; said: string }> {
  const port = await freePortBlock([0, 1]);
  const home = join(DATA_DIR, "launch-home");
  mkdirSync(home, { recursive: true });
  const server = spawn(process.execPath, [join(HERE, "index.ts")], {
    cwd: join(HERE, ".."),
    env: { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: DATA_DIR, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_TEST_ENV_SCRUBBED: "1", ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.MURAGE_ENGINE_EXCLUSION_PATH ? { MURAGE_ENGINE_EXCLUSION_PATH: process.env.MURAGE_ENGINE_EXCLUSION_PATH } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  server.stdout.on("data", chunk => (said += chunk));
  server.stderr.on("data", chunk => (said += chunk));
  const exited = new Promise<void>(resolve => server.once("exit", () => resolve()));
  let outcome: Start | null = null;
  void exited.then(() => { outcome ??= "exited"; });
  let inStepSince: number | null = null;
  const began = Date.now();
  try {
    while (outcome === null) {
      if (Date.now() - began > 420_000) { outcome = "silent"; break; }
      const note = server.pid ? readMemoryUpgradeStatus(DATA_DIR, { pid: server.pid }) : null;
      if (isOneTimeIndexNote(note)) inStepSince ??= Date.now();
      if (inStepSince !== null && Date.now() - inStepSince >= capMs) { outcome ??= "stopped-in-the-index-step"; break; }
      const reply = await fetch(`http://127.0.0.1:${port}/api/bots`, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
      if (reply?.status === 200) { outcome ??= "served"; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally { server.kill("SIGKILL"); await exited; clearMemoryUpgradeStatus(DATA_DIR); }
  return { outcome: outcome!, said };
}

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setReadTimeJudgeRetired(true); });
afterEach(() => { vi.restoreAllMocks(); setUpgradeReporterForTest(null); setReadTimeJudgeRetired(false); closeDatabase(); });

describe("a large history is never rebuilt before listen at every start", () => {
  const LARGE = 200 * 1024 * 1024;

  it("T1-LOOP-1: a 1.0.18 file of 200 MB: three starts in a row serve, none sits in the one-time index step; turns read exactly through the 1.0.18 index, and the build after listen replaces it once", async () => {
    const checks = writeHistory(database(), LARGE);
    closeDatabase();
    // the file as 1.0.18 left it: the turn index under its prior definition
    const before = raw();
    before.exec(`DROP INDEX ${INDEX}`);
    before.exec(T.TURN_INDEX_PREVIOUS_DDL);
    before.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const rows = Number((before.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n);
    const size = Number((before.prepare("PRAGMA page_count").get() as { page_count: number }).page_count) * Number((before.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
    before.close();
    expect(size).toBeGreaterThan(LARGE);

    const outcomes: Start[] = [];
    let said = "";
    for (let start = 0; start < 3; start++) { const run = await launch(150); outcomes.push(run.outcome); said += `\n--- start ${start + 1}: ${run.outcome}\n${run.said.slice(-3000)}`; }
    expect(outcomes, said).toEqual(["served", "served", "served"]);

    // nothing was rebuilt under a start: the file still has the 1.0.18 index, whole, and every message
    const after = raw();
    expect(definition(after)).toBe(T.TURN_INDEX_PREVIOUS_DDL);
    expect(Number((after.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n)).toBe(rows);
    after.close();

    // this process opens it as a start does: left until after listen, and a turn is read through the 1.0.18 index, never through the thread
    const db = database();
    expect(leftUntilAfterListen(db)).toBe(true);
    const read = captured(() => expectExact(checks));
    expect(read.sql.filter(sql => sql.includes(`INDEXED BY ${INDEX}`)).length).toBeGreaterThan(0);
    expect(read.sql.filter(sql => /INDEXED BY messages_thread\b/.test(sql))).toEqual([]);

    // the build after listen (the idle sweep's worker) replaces it: the current definition, the same rows, the same reads
    const built = await buildAfterListen(db);
    expect(built).toContain(INDEX);
    expect(definition(db)).toBe(CURRENT);
    expectExact(checks);
    expect(Number((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n)).toBe(rows);

    // the next start has nothing to build and nothing left over; the real server serves again
    closeDatabase();
    const next = database();
    expect(leftUntilAfterListen(next)).toBe(false);
    expect(definition(next)).toBe(CURRENT);
    expectExact(checks);
    closeDatabase();
    expect((await launch(150)).outcome).toBe("served");
  });

  it("T1-LOOP-2: a 200 MB file with no turn index at all: the open does not build it, turns read exactly through their thread, and the build after listen lands it", async () => {
    const checks = writeHistory(database(), LARGE);
    closeDatabase();
    const before = raw();
    before.exec(`DROP INDEX ${INDEX}`);
    before.close();

    const db = database();
    expect(definition(db)).toBe(null);
    expect(leftUntilAfterListen(db)).toBe(true);
    const read = captured(() => expectExact(checks));
    expect(read.sql.filter(sql => /INDEXED BY messages_thread\b/.test(sql)).length).toBeGreaterThan(0);

    expect(await buildAfterListen(db)).toContain(INDEX);
    expect(definition(db)).toBe(CURRENT);
    const indexed = captured(() => expectExact(checks));
    expect(indexed.sql.filter(sql => /INDEXED BY messages_thread\b/.test(sql))).toEqual([]);
  });
});

describe("a start that died in the build is not repeated; a build that failed still stops the start", () => {
  function smallHistory(): Array<{ threadId: string; turnId: string }> {
    const checks = writeHistory(database(), 2 * 1024 * 1024);
    closeDatabase();
    const db = raw();
    db.exec(`DROP INDEX ${INDEX}`);
    db.close();
    return checks;
  }
  const env = (): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = { HOME: homedir(), USERPROFILE: homedir(), MURAGE_DATA_DIR: DATA_DIR, MURAGE_TEST_ENV_SCRUBBED: "1" };
    for (const key of ["PATH", "SystemRoot", "MURAGE_ENGINE_EXCLUSION_PATH"]) if (process.env[key]) out[key] = process.env[key];
    return out;
  };

  it("T1-LOOP-3: a small file whose start was killed in the build: the next start serves without building before listen, reads exactly, and the build after listen ends the state", async () => {
    const checks = smallHistory();
    const died = spawnSync(process.execPath, [DYING_CHILD], { cwd: join(HERE, ".."), env: env(), encoding: "utf8", timeout: 120_000 });
    expect(died.signal, died.stderr).toBe("SIGKILL");
    expect(died.stdout).not.toContain("NOT_REACHED");
    const left = raw();
    expect(definition(left)).toBe(null);
    left.close();

    // the next start: no build before listen (the file still has no index when the open returns), and it says so
    const db = database();
    expect(definition(db)).toBe(null);
    expect(leftUntilAfterListen(db)).toBe(true);
    expect(marker(db)).toBe(true);
    expectExact(checks);
    closeDatabase();

    // a real second process (the existing reader child): the same answer, no error
    const { threadId, turnId } = checks[0]!;
    const reader = spawnSync(process.execPath, [READ_CHILD, "read", threadId, turnId], { cwd: join(HERE, ".."), env: env(), encoding: "utf8", timeout: 120_000 });
    expect(reader.status, reader.stderr).toBe(0);
    const told = JSON.parse(reader.stdout.trim().split("\n").pop()!) as { rows?: string[]; error?: string };
    expect(told.error).toBeUndefined();
    const again = database();
    expect(told.rows).toEqual(ids(oracle(again, threadId, turnId)));
    expect(definition(again)).toBe(null);

    // the build after listen lands it; the start after that finds it, removes the marker and reads through the index
    expect(await buildAfterListen(again)).toContain(INDEX);
    closeDatabase();
    const done = database();
    expect(definition(done)).toBe(CURRENT);
    expect(marker(done)).toBe(false);
    expect(leftUntilAfterListen(done)).toBe(false);
    const read = captured(() => expectExact(checks));
    expect(read.sql.filter(sql => /INDEXED BY messages_thread\b/.test(sql))).toEqual([]);
  });

  it("T1-LOOP-4: a build that fails (an error, not a death) stops the start, leaves no marker, and the next good start builds before listen; an index gone in any other state is still the fault", async () => {
    const checks = smallHistory();
    const entry = Optional.OPTIONAL_INDEXES.find(index => index.name === INDEX)!;
    const sql = entry.sql;
    entry.sql = "CREATE INDEX messages_turn ON no_such_table(x)";
    try { expect(() => database()).toThrow(); } finally { entry.sql = sql; }
    closeDatabase();
    const failed = raw();
    expect(marker(failed)).toBe(false);
    expect(definition(failed)).toBe(null);
    failed.close();

    const db = database();
    expect(definition(db)).toBe(CURRENT);
    expect(leftUntilAfterListen(db)).toBe(false);
    expect(marker(db)).toBe(false);
    expectExact(checks);

    // dropped under the running process, which never declared it left until after listen: the reader refuses, and reads no message
    db.exec(`DROP INDEX ${INDEX}`);
    const { threadId, turnId } = checks[0]!;
    const seen = captured(() => { try { M.turnRows(threadId, turnId); return "read"; } catch (error) { return (error as { code?: string }).code; } });
    expect(seen.result).toBe(M.TURN_INDEX_NOT_READY);
    expect(seen.sql).toEqual([]);
  });
});
