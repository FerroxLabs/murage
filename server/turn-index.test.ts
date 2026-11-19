// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L4B-M2 (designs/L4B-M2-REDESIGN-1018.md, BF-1 to BF-7): one turn's rows come from the expression index messages_turn. A read costs that turn's rows,
// never the thread's history, and it is exact for any writer. The index is built before the server serves and has no fallback read. A death is a real
// process death (testing/turn-index-child.ts). Full scans here are the test's own oracle. message-tables and message-db are namespace imports so that
// on a base without the index T-SCALE-1 and T-PLAN-1 are red on what they measure, not on a missing import.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "./contracts.ts";
import { prepareThreadSync, isPrepared } from "./branch-store.ts";
import { LINE_BOT_EMPTY, LINE_TEXT, verifyDerivedRows } from "./branch-index.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, setUpgradeReporterForTest } from "./database.ts";
import { DEV_TURN_SPAN, downgradeTurnIndexTo117, removeDevTurnSpan } from "./installation-app-schema-downgrade.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { lineClassesOf } from "./line-classes.ts";
import * as Optional from "./memory/optional-index.ts";
import { memoryUpgradeReporter } from "./memory/upgrade-status.ts";
import * as Mdb from "./message-db.ts";
import * as Tables from "./message-tables.ts";
import { Store, type Message } from "./store.ts";
import { backupFixture, rawAgeHost, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

vi.setConfig({ testTimeout: 180_000 });
const T = Tables as unknown as { TURN_EXPR: string; TURN_INDEX: string; TURN_INDEX_DDL: string };
const M = Mdb as unknown as { TURN_ROWS_SQL: string; TURN_INDEX_NOT_READY: string; turnRows: (t: string, u: string) => Message[]; turnTextRows: (t: string, u: string, c?: readonly number[]) => Message[] };
const CHILD = join(dirname(fileURLToPath(import.meta.url)), "testing", "turn-index-child.ts");
const INDEX = "messages_turn";
const FILE = () => join(DATA_DIR, "messages.db");
const THREAD = "thread-a";
let written = 0;

function raw(): DatabaseSync {
  const db = new DatabaseSync(FILE());
  db.exec("PRAGMA busy_timeout=20000");
  return db;
}
const message = (id: string, turnId: string | undefined, over: Partial<Message> = {}) => ({ id, at: 1, role: "bot", kind: "text", text: `line ${id}`, ...(turnId ? { turnId } : {}), ...over });
function put(db: DatabaseSync, threadId: string, id: string, turnId: string | undefined, over: Partial<Message> = {}): void {
  const m = message(id, turnId, over);
  // no seq column named: a file an older build wrote does not have it
  db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(threadId, id, m.at, m.role, m.kind, m.text ?? null, JSON.stringify(m));
}
function history(db: DatabaseSync, threadId: string, rows: number, turnOf: (i: number) => string | undefined = i => `later-${i}`): void {
  db.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < rows; i++) put(db, threadId, `h${++written}`, turnOf(i));
  db.exec("COMMIT");
}
const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);
function oracle(db: DatabaseSync, threadId: string, turnId: string): Message[] {
  return (db.prepare("SELECT json FROM messages NOT INDEXED WHERE thread_id = ? ORDER BY rowid").all(threadId) as Array<{ json: string }>)
    .map(row => JSON.parse(row.json) as Message).filter(row => row.turnId === turnId);
}
const hasIndex = (db: DatabaseSync) => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(INDEX) !== undefined;
function dropOnFile(): void { closeDatabase(); const db = raw(); db.exec(`DROP INDEX IF EXISTS ${INDEX}`); db.close(); }
function expectExact(db: DatabaseSync, threadId: string, turnId: string): void {
  const want = oracle(db, threadId, turnId);
  expect(ids(M.turnRows(threadId, turnId))).toEqual(ids(want));
  expect(ids(M.turnTextRows(threadId, turnId))).toEqual(ids(want.filter(row => lineClassesOf(row).includes(LINE_TEXT))));
}
function child(scenario: string, args: string[] = [], over: NodeJS.ProcessEnv = {}, dataDir = DATA_DIR) {
  closeDatabase();
  const env: NodeJS.ProcessEnv = { HOME: homedir(), USERPROFILE: homedir(), MURAGE_DATA_DIR: dataDir, MURAGE_TEST_ENV_SCRUBBED: "1", ...over };
  for (const key of ["PATH", "SystemRoot", "MURAGE_ENGINE_EXCLUSION_PATH"]) if (process.env[key]) env[key] = process.env[key];
  return spawnSync(process.execPath, [CHILD, scenario, ...args], { cwd: join(dirname(CHILD), "..", ".."), env, encoding: "utf8", timeout: 120_000 });
}
const parsed = (run: { stdout: string; stderr: string; status: number | null }) => {
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout.trim().split("\n").pop()!) as { rows?: string[]; text?: string[]; error?: string; prepared: boolean; queued: number };
};
/** The SQL each API runs against messages or line, captured from the open connection: io-budget.ts wraps `prepare` on the instance when the
 * database opens, so a spy on the prototype after that sees nothing. */
function captured<R>(run: () => R): { result: R; sql: string[] } {
  const sql: string[] = [];
  const connection = database();
  const real = connection.prepare;
  const spy = vi.spyOn(connection, "prepare").mockImplementation((text: string) => { sql.push(text); return real.call(connection, text); });
  try { return { result: run(), sql: sql.filter(text => /\b(messages|line)\b/.test(text)) }; } finally { spy.mockRestore(); }
}
const planOf = (db: DatabaseSync, sql: string, params: unknown[]) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as string[])) as Array<{ detail: string }>).map(row => row.detail);
const parses = <R>(run: () => R) => {
  const spy = vi.spyOn(JSON, "parse");
  try { const result = run(); return { result, count: spy.mock.calls.length }; } finally { spy.mockRestore(); }
};

beforeEach(async () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(async () => { vi.restoreAllMocks(); setUpgradeReporterForTest(null); closeDatabase(); });

describe("exact and bounded", () => {
  it("T-EXACT-1: every turn of a 20,000 row thread equals the full parse, through both readers", async () => {
    const db = database();
    history(db, THREAD, 20_000, i => (i % 7 === 0 ? undefined : `t${i % 200}`));
    for (let i = 0; i < 200; i++) expectExact(db, THREAD, `t${i}`);
    expect(M.turnRows(THREAD, "no-such-turn")).toEqual([]);
    expect(M.turnRows("no-such-thread", "t1")).toEqual([]);
  });

  for (const [name, api] of [["T-PLAN-1 turnRows", (t: string, u: string) => M.turnRows(t, u)], ["T-PLAN-2 turnTextRows", (t: string, u: string) => M.turnTextRows(t, u, [LINE_TEXT, LINE_BOT_EMPTY])]] as const) {
    it(`${name}: the SQL it really runs searches messages_turn on thread and turn; no scan, no line, no sort, with few or many rows, before and after ANALYZE`, async () => {
      const db = database();
      history(db, THREAD, 50, () => "few");
      history(db, THREAD, 5_000, i => `later-${i % 20}`);
      history(db, "thread-b", 2_000, () => "few");
      prepareThreadSync(THREAD);
      for (const turn of ["few", "later-1", "absent"]) {
        for (const analyzed of [false, true]) {
          if (analyzed) db.exec("ANALYZE");
          const { sql } = captured(() => api(THREAD, turn));
          expect(sql.length, sql.join("\n")).toBe(1);
          const plan = planOf(db, sql[0]!, [THREAD, turn]);
          expect(plan.length, plan.join("\n")).toBe(1);
          expect(plan[0]).toMatch(/^SEARCH messages USING INDEX messages_turn \(thread_id=\? AND <expr>=\?\)$/);
          expect(plan.join("\n")).not.toMatch(/\bSCAN\b|\bline\b|TEMP B-TREE|CORRELATED/);
        }
      }
      // the guard against a drifted constant: the plain form does not reach the index
      const plain = planOf(db, "SELECT json FROM messages WHERE thread_id = ? AND json_extract(json,'$.turnId') = ? ORDER BY rowid", [THREAD, "few"]);
      expect(plain.join("\n")).not.toContain(INDEX);
    });
  }

  it("T-SCALE-1: the parses of one old turn's read do not grow from 1,000 to 20,000 later rows, for either reader, even with several classes", async () => {
    const db = database();
    history(db, THREAD, 5, () => "old");
    history(db, THREAD, 1_000);
    const before = oracle(db, THREAD, "old");
    const small = parses(() => ids(M.turnRows(THREAD, "old")));
    const smallText = parses(() => ids(M.turnTextRows(THREAD, "old", [LINE_TEXT, LINE_BOT_EMPTY])));
    history(db, THREAD, 19_000);
    const large = parses(() => ids(M.turnRows(THREAD, "old")));
    const largeText = parses(() => ids(M.turnTextRows(THREAD, "old", [LINE_TEXT, LINE_BOT_EMPTY])));
    expect(small.result).toEqual(ids(before));
    expect(large.result).toEqual(ids(before));
    expect(largeText.result).toEqual(ids(before));
    expect(large.count).toBe(small.count);
    expect(largeText.count).toBe(smallText.count);
    expect(large.count).toBeLessThanOrEqual(before.length);
  });

  it("T-READY-2: with no turn_first and no line rows, a raw new turn and a raw move below the old first row are read, at 1,000 and 20,000 later rows", async () => {
    const db = database();
    history(db, THREAD, 3, () => "low");
    put(db, THREAD, "moved", "other");
    history(db, THREAD, 3, () => "turn-r");
    prepareThreadSync(THREAD);
    db.exec("DELETE FROM turn_first; DELETE FROM line");
    put(db, THREAD, "fresh", "turn-new");
    db.prepare("UPDATE messages SET json = json_set(json,'$.turnId','turn-r') WHERE id = 'moved'").run();
    for (const later of [1_000, 19_000]) {
      history(db, THREAD, later);
      expectExact(db, THREAD, "turn-r");
      expectExact(db, THREAD, "turn-new");
      expect(ids(M.turnRows(THREAD, "turn-r"))[0]).toBe("moved");
      expect(parses(() => M.turnRows(THREAD, "turn-new")).count).toBe(1);
      expect(parses(() => M.turnTextRows(THREAD, "turn-new")).count).toBe(1);
    }
  });
});

describe("any writer", () => {
  it("T-RAW-1: a raw json_set gives a row a turn and it is read; a raw json_remove takes it away; a damaged row writes and has no entry", async () => {
    const db = database();
    history(db, THREAD, 3, () => "turn-1");
    put(db, THREAD, "later", undefined);
    db.prepare("UPDATE messages SET json = json_set(json,'$.turnId','turn-1') WHERE id = 'later'").run();
    expect(ids(M.turnRows(THREAD, "turn-1"))).toContain("later");
    db.prepare("UPDATE messages SET json = json_remove(json,'$.turnId') WHERE id = 'later'").run();
    expect(ids(M.turnRows(THREAD, "turn-1"))).not.toContain("later");
    expectExact(db, THREAD, "turn-1");
    // a non-text turn id is in the index and the decoded check drops it
    db.prepare("UPDATE messages SET json = json_set(json,'$.turnId',7) WHERE id = 'later'").run();
    expect(M.turnRows(THREAD, "7")).toEqual([]);
  });

  it("T-RAW-CLASS-1: classes come from the row's current JSON, stale line rows or not; two classes, repeated classes, no classes and the default", async () => {
    const db = database();
    put(db, THREAD, "t1", "turn-c");
    put(db, THREAD, "a1", "turn-c", { kind: "activity", text: undefined, tool: { name: "Bash" } } as Partial<Message>);
    put(db, THREAD, "t2", "turn-c");
    prepareThreadSync(THREAD);
    expect(isPrepared(THREAD)).toBe(true);
    put(db, THREAD, "t3", "turn-c");
    db.prepare("UPDATE messages SET kind = 'text', text = 'now text', json = json_set(json,'$.kind','text','$.text','now text') WHERE id = 'a1'").run();
    db.prepare("UPDATE messages SET kind = 'activity', text = NULL, json = json_remove(json_set(json,'$.kind','activity'),'$.text') WHERE id = 't2'").run();
    expect(ids(M.turnTextRows(THREAD, "turn-c"))).toEqual(["t1", "a1", "t3"]);
    expect(ids(M.turnTextRows(THREAD, "turn-c", [LINE_TEXT, LINE_TEXT]))).toEqual(["t1", "t1", "a1", "a1", "t3", "t3"]);
    expect(M.turnTextRows(THREAD, "turn-c", [])).toEqual([]);
    expectExact(db, THREAD, "turn-c");
    // a row in two classes comes once per class asked for, adjacent, in row order
    put(db, THREAD, "two", "turn-d", { role: "bot", text: "shown", copyOf: { threadId: "x", messageId: "y" } } as unknown as Partial<Message>);
    const [first] = oracle(db, THREAD, "turn-d");
    const classes = lineClassesOf(first!);
    expect(classes.length).toBeGreaterThan(1);
    expect(ids(M.turnTextRows(THREAD, "turn-d", classes))).toEqual(classes.map(() => "two"));
    // the activity rows between replies are parsed, which is the turn's own cost
    expect(parses(() => M.turnTextRows(THREAD, "turn-c")).count).toBe(oracle(db, THREAD, "turn-c").length);
  });

  it("T-OLD-2: an older build's raw writes on a file that still has the index are read, and the database check accepts it", async () => {
    const db = database();
    history(db, THREAD, 2, () => "turn-o");
    closeDatabase();
    const older = raw();
    put(older, THREAD, "older-write", "turn-o");
    older.prepare("UPDATE messages SET json = json_set(json,'$.turnId','turn-o2') WHERE id = 'older-write'").run();
    expect((older.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    older.close();
    const again = database();
    expect(ids(M.turnRows(THREAD, "turn-o2"))).toEqual(["older-write"]);
    expectExact(again, THREAD, "turn-o");
  });

  it("T-CONC-1: interleaved writers, in one thread and in two: a read sees committed rows only and never another turn's", async () => {
    const db = database();
    const a = raw(), b = raw();
    try {
      put(a, THREAD, "a1", "turn-a");
      a.exec("BEGIN IMMEDIATE");
      put(a, THREAD, "a2", "turn-a");
      expect(ids(M.turnRows(THREAD, "turn-a"))).toEqual(["a1"]);
      a.exec("COMMIT");
      expect(ids(M.turnRows(THREAD, "turn-a"))).toEqual(["a1", "a2"]);
      b.exec("BEGIN IMMEDIATE");
      put(b, THREAD, "b1", "turn-b");
      put(b, "thread-b", "x1", "turn-a");
      expect(ids(M.turnRows(THREAD, "turn-a"))).toEqual(["a1", "a2"]);
      expect(M.turnRows("thread-b", "turn-a")).toEqual([]);
      b.exec("COMMIT");
      a.exec("BEGIN IMMEDIATE");
      put(a, THREAD, "a3", "turn-a");
      a.exec("COMMIT");
      expect(ids(M.turnRows(THREAD, "turn-a"))).toEqual(["a1", "a2", "a3"]);
      expect(ids(M.turnRows(THREAD, "turn-b"))).toEqual(["b1"]);
      expect(ids(M.turnRows("thread-b", "turn-a"))).toEqual(["x1"]);
      expectExact(db, THREAD, "turn-a");
    } finally { a.close(); b.close(); }
  });

  it("T-VACUUM-1: gaps, stale line rows and a VACUUM change nothing", async () => {
    const db = database();
    history(db, THREAD, 400, i => `v${i % 4}`);
    prepareThreadSync(THREAD);
    db.exec(`DELETE FROM messages WHERE rowid % 3 = 0`);
    const before = oracle(db, THREAD, "v1");
    db.exec("VACUUM");
    expect(ids(M.turnRows(THREAD, "v1"))).toEqual(ids(before));
    expectExact(db, THREAD, "v1");
    expect(hasIndex(db)).toBe(true);
  });
});

describe("no derived table in the way", () => {
  it("T-WIPE-1: a read before and during the refill after verifyDerivedRows wipes the derived rows is exact", async () => {
    const db = database();
    history(db, THREAD, 60, i => `w${i % 3}`);
    prepareThreadSync(THREAD);
    // a line row that names another thread's message is what makes the check wipe
    put(db, "thread-b", "foreign", "w0");
    const foreign = (db.prepare("SELECT rowid AS r FROM messages WHERE id = 'foreign'").get() as { r: number }).r;
    db.prepare("INSERT OR REPLACE INTO line(key, cls, mrow) SELECT key, ?, ? FROM thread_key WHERE thread_id = ?").run(LINE_TEXT, foreign, THREAD);
    expect(verifyDerivedRows(db)).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM turn_first").get() as { n: number }).n).toBe(0);
    expect(isPrepared(THREAD)).toBe(false);
    expectExact(db, THREAD, "w1");
    expect(isPrepared(THREAD)).toBe(false);
    prepareThreadSync(THREAD);
    expectExact(db, THREAD, "w1");
  });

  it("T-GATE-1: an unprepared thread reads the same with VITEST set and unset, and the read queues no fill; with no index, the same error", async () => {
    const db = database();
    history(db, THREAD, 12, () => "turn-g");
    const want = ids(oracle(db, THREAD, "turn-g"));
    closeDatabase();
    const scrubbed = { VITEST: undefined };
    const runs = [parsed(child("read", [THREAD, "turn-g"], { VITEST: "1" })), parsed(child("read", [THREAD, "turn-g"], scrubbed))];
    for (const run of runs) { expect(run.rows).toEqual(want); expect(run.text).toEqual(want); expect(run.prepared).toBe(false); expect(run.queued).toBe(0); }
    const gone = [parsed(child("read-without-index", [THREAD, "turn-g"], { VITEST: "1" })), parsed(child("read-without-index", [THREAD, "turn-g"], scrubbed))];
    for (const run of gone) { expect(run.error).toBe(M.TURN_INDEX_NOT_READY); expect(run.rows).toBeUndefined(); expect(run.queued).toBe(0); }
  });
});

describe("the index is a start-up dependency", () => {
  const sabotage = () => {
    const entry = Optional.OPTIONAL_INDEXES.find(index => index.name === INDEX)!;
    const sql = entry.sql;
    entry.sql = "CREATE INDEX messages_turn ON no_such_table(x)";
    return () => { entry.sql = sql; };
  };
  const reporter = (events: string[]) => setUpgradeReporterForTest(((dataDir: string, name: (path: string) => string) => {
    const real = memoryUpgradeReporter(dataDir, name);
    return { ...real,
      blocking: (...args: Parameters<typeof real.blocking>) => { events.push("beat-start"); const beat = real.blocking(...args); return { ...beat, end: () => { events.push("beat-end"); beat.end(); } }; },
      blocked: (error: unknown) => { events.push("blocked"); real.blocked(error); },
      done: () => { events.push("done"); real.done(); } };
  }) as typeof memoryUpgradeReporter);
  const tagged = () => {
    const lines: string[] = [];
    const real = console.log;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { const text = args.join(" "); if (text.startsWith("[turn-index]")) lines.push(text); else real(...args); });
    return lines;
  };

  it("T-READY-1: a build that fails stops the launch on the blocked note; no fallback; the next good start is exact", async () => {
    const db = database();
    history(db, THREAD, 5, () => "turn-r");
    const want = ids(oracle(db, THREAD, "turn-r"));
    dropOnFile();
    const events: string[] = [];
    reporter(events);
    const restore = sabotage();
    try {
      expect(() => database()).toThrow();
      expect(events).toContain("blocked");
      expect(events).not.toContain("done");
    } finally { restore(); }
    setUpgradeReporterForTest(null);
    database();
    expect(ids(M.turnRows(THREAD, "turn-r"))).toEqual(want);
  });

  it("T-READY-1 lock at start-up: a writer holding the lock when the build comes stops the open on the blocked note; the next open is exact", async () => {
    const db = database();
    history(db, THREAD, 5, () => "turn-l");
    const want = ids(oracle(db, THREAD, "turn-l"));
    dropOnFile();
    const events: string[] = [];
    reporter(events);
    const entry = Optional.OPTIONAL_INDEXES.find(index => index.name === INDEX)!;
    const sql = entry.sql;
    const holder = raw();
    // the lock is taken at the build itself, so every earlier step of the open has already written
    Object.defineProperty(entry, "sql", { configurable: true, get() { holder.exec("BEGIN IMMEDIATE"); return sql; } });
    try {
      expect(() => database()).toThrow(/locked/);
      expect(events).toContain("blocked");
      expect(events).not.toContain("done");
    } finally {
      Object.defineProperty(entry, "sql", { configurable: true, writable: true, enumerable: true, value: sql });
      if (holder.isTransaction) holder.exec("ROLLBACK");
      holder.close();
    }
    setUpgradeReporterForTest(null);
    database();
    expect(ids(M.turnRows(THREAD, "turn-l"))).toEqual(want);
  });

  it("T-READY-1 launch: a real server on a file whose index cannot be built exits without serving; the file is unharmed", async () => {
    const db = database();
    history(db, THREAD, 3, () => "turn-x");
    closeDatabase();
    const broken = raw();
    broken.exec(`DROP INDEX ${INDEX}; CREATE TABLE ${INDEX}(x)`);
    broken.close();
    const port = await freePortBlock([0, 1]);
    const home = join(DATA_DIR, "launch-home");
    mkdirSync(home, { recursive: true });
    const server = spawn(process.execPath, [join(dirname(CHILD), "..", "index.ts")], {
      cwd: join(dirname(CHILD), "..", ".."),
      env: { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: DATA_DIR, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_TEST_ENV_SCRUBBED: "1", ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.MURAGE_ENGINE_EXCLUSION_PATH ? { MURAGE_ENGINE_EXCLUSION_PATH: process.env.MURAGE_ENGINE_EXCLUSION_PATH } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let said = "";
    server.stdout.on("data", chunk => (said += chunk));
    server.stderr.on("data", chunk => (said += chunk));
    const exited = new Promise<number | null>(resolve => server.once("exit", code => resolve(code)));
    let served = false;
    const asking = setInterval(() => { void fetch(`http://127.0.0.1:${port}/api/bots`).then(reply => { if (reply.status === 200) served = true; }).catch(() => {}); }, 100);
    try {
      const code = await Promise.race([exited, new Promise<"running">(resolve => setTimeout(() => resolve("running"), 90_000))]);
      expect(code, said).not.toBe("running");
      expect(code, said).not.toBe(0);
    } finally { clearInterval(asking); server.kill("SIGKILL"); await exited; }
    expect(served, said).toBe(false);
    expect(said).toMatch(/\[turn-index\] index build ms=\d+ ok=0/);
    const check = raw();
    expect((check.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(3);
    check.close();
  });

  it("T-READY-1 lock: another connection holding the write lock makes a required build fail, tagged, and it builds once the lock is gone", async () => {
    database();
    dropOnFile();
    const db = new DatabaseSync(FILE()), holder = new DatabaseSync(FILE());
    const lines = tagged();
    try {
      db.exec("PRAGMA busy_timeout=0");
      holder.exec("BEGIN IMMEDIATE");
      expect(() => Optional.buildPreListenIndexes(db, { log: false })).toThrow(/locked/);
      expect(lines.filter(line => line.includes("ok=0"))).toHaveLength(1);
      holder.exec("ROLLBACK");
      expect(Optional.buildPreListenIndexes(db, { log: false })).toContain(INDEX);
      expect(lines.filter(line => line.includes("ok=1"))).toHaveLength(1);
    } finally { holder.close(); db.close(); }
  });

  it("T-READY-1 open file: the index gone under a running server: both readers throw the error, read no messages and mark nothing", async () => {
    const db = database();
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }) as ModelSelection);
    const threadId = store.createBot({ name: "Readers" }).threadId;
    store.appendMessage(threadId, { role: "bot", kind: "activity", turnId: "turn-m", tool: { name: "Bash" } });
    (store as unknown as { threads: Map<string, unknown> }).threads.delete(threadId);
    db.exec(`DROP INDEX ${INDEX}`);
    for (const read of [() => M.turnRows(threadId, "turn-m"), () => M.turnRows(threadId, "absent"), () => M.turnTextRows(threadId, "turn-m"), () => M.turnTextRows(threadId, "turn-m", [])]) {
      const seen = captured(() => { try { read(); return "no throw"; } catch (error) { return (error as { code?: string }).code; } });
      expect(seen.result).toBe(M.TURN_INDEX_NOT_READY);
      expect(seen.sql.filter(sql => /\bFROM messages\b/.test(sql))).toEqual([]);
    }
    expect(() => store.markTurnToolsUnrecorded(threadId, "turn-m")).toThrow(expect.objectContaining({ code: M.TURN_INDEX_NOT_READY }));
    expect(oracle(db, threadId, "turn-m")[0]!.tool?.unrecorded).toBeUndefined();
  });

  it("T-RESTART-1: a ready file builds nothing; with the index gone, a later open builds it, tagged ok=1, and the reads are exact", async () => {
    const db = database();
    history(db, THREAD, 4, () => "turn-s");
    const lines = tagged();
    expect(Optional.optionalIndexReady(db, INDEX)).toBe(true);
    expect(captured(() => Optional.buildPreListenIndexes(db, { log: false })).result).toEqual([]);
    expect(lines).toEqual([]);
    closeDatabase();
    const again = database();
    expect(lines).toEqual([]);
    expectExact(again, THREAD, "turn-s");
    again.exec(`DROP INDEX ${INDEX}`);
    expect(Optional.buildPreListenIndexes(again, { log: false })).toContain(INDEX);
    expect(lines.filter(line => /^\[turn-index\] index build ms=\d+ ok=1$/.test(line))).toHaveLength(1);
    dropOnFile();
    const third = database();
    expect(lines.filter(line => line.includes("ok=1"))).toHaveLength(2);
    expectExact(third, THREAD, "turn-s");
  });

  it("T-BOOT-OBS-1: on an ordinary launch with the index missing the note goes up before the build and comes down after; with a failure too, one ok=0", async () => {
    database();
    dropOnFile();
    const order: string[] = [];
    const lines = tagged();
    reporter(order);
    database();
    expect(lines.filter(line => line.includes("ok=1"))).toHaveLength(1);
    expect(order).toEqual(["beat-start", "beat-end", "done"]);
    // an ordinary launch with nothing due puts up no note
    closeDatabase();
    order.length = 0;
    database();
    expect(order).toEqual(["done"]);
    // the failure: heartbeat cleaned up, one ok=0, blocked, never done
    dropOnFile();
    order.length = 0; lines.length = 0;
    const restore = sabotage();
    try { expect(() => database()).toThrow(); } finally { restore(); }
    expect(order).toEqual(["beat-start", "beat-end", "blocked"]);
    expect(lines.filter(line => line.includes("ok=0"))).toHaveLength(1);
  });

  it("T-BOOT-OBS-1 migrating: the note covers the eager indexes and the turn index", async () => {
    database();
    closeDatabase();
    // the public downgrade leaves an older memory schema and no index, so the next open really migrates
    expect(await downgradeInstallationMemorySchema(DATA_DIR, 12)).toMatchObject({ to: 12 });
    const order: string[] = [];
    const lines = tagged();
    reporter(order);
    database();
    expect(lines.filter(line => line.includes("ok=1"))).toHaveLength(1);
    expect(order.lastIndexOf("beat-start")).toBeLessThan(order.lastIndexOf("beat-end"));
    expect(order.at(-1)).toBe("done");
  });

  it("T-CRASH-1: a death with the build uncommitted, and a death during it: absent or complete, and the next start finishes it first", async () => {
    const db = database();
    history(db, THREAD, 60_000, i => `c${i % 50}`);
    dropOnFile();
    const uncommitted = child("die-in-uncommitted-build");
    expect(uncommitted.status, uncommitted.stderr).not.toBe(0);
    let check = raw();
    expect(hasIndex(check)).toBe(false);
    check.close();
    const again = database();
    expect(hasIndex(again)).toBe(true);
    expectExact(again, THREAD, "c1");
    dropOnFile();
    return new Promise<void>((resolve, reject) => {
      const env = { HOME: homedir(), USERPROFILE: homedir(), MURAGE_DATA_DIR: DATA_DIR, MURAGE_TEST_ENV_SCRUBBED: "1", PATH: process.env.PATH };
      const running = spawn(process.execPath, [CHILD, "die-during-build"], { cwd: join(dirname(CHILD), "..", ".."), env, stdio: ["ignore", "pipe", "inherit"] });
      running.stdout.once("data", () => running.kill("SIGKILL"));
      running.once("error", reject);
      running.once("exit", () => {
        try {
          check = raw();
          expect((check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
          check.close();
          const next = database();
          expect(hasIndex(next)).toBe(true);
          expectExact(next, THREAD, "c1");
          resolve();
        } catch (error) { reject(error); }
      });
    });
  });

  it("T-CRASH-2: a death mid-turn with WAL frames and an open transaction: exactly the committed rows, and only their tools are marked", async () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }) as ModelSelection);
    const threadId = store.createBot({ name: "Crash" }).threadId;
    store.appendMessage(threadId, { role: "bot", kind: "activity", turnId: "sibling", tool: { name: "Bash" } });
    const died = child("die-mid-turn", [threadId, "turn-x"]);
    expect(died.status, died.stderr).not.toBe(0);
    const db = database();
    expect(ids(M.turnRows(threadId, "turn-x"))).toEqual(["c1", "c2", "c3"]);
    const next = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }) as ModelSelection);
    expect(next.markTurnToolsUnrecorded(threadId, "turn-x")).toBe(3);
    expect(oracle(db, threadId, "turn-x").every(row => row.tool?.unrecorded === true)).toBe(true);
    expect(oracle(db, threadId, "sibling")[0]!.tool?.unrecorded).toBeUndefined();
    expect(next.markTurnToolsUnrecorded(threadId, "turn-x")).toBe(0);
  });
});

describe("downgrade, older builds, cleanup", () => {
  const prepareForDowngrade = () => { const db = database(); history(db, THREAD, 6, () => "turn-d"); closeDatabase(); };

  it("T-DOWN-1 and T-OLD-1: the public entry drops it at 12 and at 10, already-there too; the database check accepts the result; an older build's raw writes land", async () => {
    prepareForDowngrade();
    expect(await downgradeInstallationMemorySchema(DATA_DIR, 12)).toMatchObject({ to: 12 });
    let db = raw();
    expect(hasIndex(db)).toBe(false);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.close();
    // already at the target, with the index back by hand: an early return in the memory step must not skip it
    db = raw(); db.exec(T.TURN_INDEX_DDL); db.close();
    expect(await downgradeInstallationMemorySchema(DATA_DIR, 12)).toMatchObject({ to: 12 });
    db = raw(); expect(hasIndex(db)).toBe(false); db.close();
    expect(await downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ to: 10 });
    db = raw(); db.exec(T.TURN_INDEX_DDL); db.close();
    expect(await downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ to: 10 });
    db = raw();
    expect(hasIndex(db)).toBe(false);
    put(db, THREAD, "older-1", "turn-d");
    put(db, THREAD, "older-2", "turn-e");
    expect((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id IN ('older-1','older-2')").get() as { n: number }).n).toBe(2);
    db.close();
  });

  it("T-DOWN-1 rebuild: rows written while the index was gone are read after the next 1.0.18 start", async () => {
    prepareForDowngrade();
    expect(await downgradeInstallationMemorySchema(DATA_DIR, 12)).toMatchObject({ to: 12 });
    const older = raw();
    put(older, THREAD, "older-1", "turn-d");
    put(older, THREAD, "older-2", "turn-e");
    older.close();
    const db = database();
    expect(hasIndex(db)).toBe(true);
    expect(ids(M.turnRows(THREAD, "turn-d")).at(-1)).toBe("older-1");
    expect(ids(M.turnRows(THREAD, "turn-e"))).toEqual(["older-2"]);
    expectExact(db, THREAD, "turn-d");
  });

  it("T-DOWN-1 failure: a failed step rolls back and the failure reaches the caller; repeating the helper is harmless", async () => {
    prepareForDowngrade();
    await expect(downgradeInstallationMemorySchema(DATA_DIR, 12, { turnIndexBeforeEnd: () => { throw new Error("injected"); } })).rejects.toThrow(/injected/);
    const db = raw();
    expect(hasIndex(db)).toBe(true);
    downgradeTurnIndexTo117(db);
    downgradeTurnIndexTo117(db);
    expect(hasIndex(db)).toBe(false);
    db.close();
  });

  it("T-CLEANUP-1: a 136524a79 development file loses the span objects at open, twice over; turn_first data survives and reads are exact", async () => {
    const db = database();
    history(db, THREAD, 5, () => "turn-k");
    prepareThreadSync(THREAD);
    const firstRows = (db.prepare("SELECT COUNT(*) AS n FROM turn_first").get() as { n: number }).n;
    closeDatabase();
    const dev = raw();
    dev.exec(`ALTER TABLE turn_first ADD COLUMN ${DEV_TURN_SPAN.column} INTEGER`);
    dev.exec("CREATE TRIGGER turn_last_msg AFTER INSERT ON messages WHEN json_extract(NEW.json,'$.turnId') IS NOT NULL BEGIN SELECT 1; END");
    dev.exec("CREATE TRIGGER turn_last_fill AFTER INSERT ON turn_first WHEN NEW.last_rowid IS NULL BEGIN SELECT 1; END");
    for (const name of DEV_TURN_SPAN.state) dev.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES (?, 1, 5, 0)").run(name);
    dev.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES ('keep_me', 1, 5, 0)").run();
    dev.close();
    for (let open = 0; open < 2; open++) {
      const opened = database();
      expect((opened.prepare("SELECT name FROM sqlite_schema WHERE name IN ('turn_last_msg','turn_last_fill')").all())).toEqual([]);
      expect((opened.prepare("PRAGMA table_info(turn_first)").all() as Array<{ name: string }>).map(row => row.name)).not.toContain(DEV_TURN_SPAN.column);
      expect(opened.prepare("SELECT name FROM transcript_index_state WHERE name IN ('turn_last_floor','turn_last')").all()).toEqual([]);
      expect(opened.prepare("SELECT name FROM transcript_index_state WHERE name = 'keep_me'").get()).toBeTruthy();
      expect((opened.prepare("SELECT COUNT(*) AS n FROM turn_first").get() as { n: number }).n).toBe(firstRows);
      expectExact(opened, THREAD, "turn-k");
      expect(removeDevTurnSpan(opened)).toBe(false);
      closeDatabase();
    }
  });
});

describe("backup and restore", () => {
  it("T-BACKUP-1: the database check takes a file with the index under this text or without it, and refuses any other definition", async () => {
    const f = backupFixture();
    try {
      expect(hasIndex(f.db)).toBe(false);
      expect(() => inspectInstallationDatabase(f.db)).not.toThrow();
      f.db.exec(T.TURN_INDEX_DDL);
      expect(() => inspectInstallationDatabase(f.db)).not.toThrow();
      f.db.exec(`DROP INDEX ${INDEX}`);
      f.db.exec(`CREATE INDEX ${INDEX} ON messages(thread_id, json_extract(json,'$.turnId'))`);
      expect(() => inspectInstallationDatabase(f.db)).toThrow(expect.objectContaining({ code: "DATABASE_SCHEMA_UNSUPPORTED" }));
    } finally { f.db.close(); removeTempDirSync(f.parent); }
  });

  it.skipIf(!rawAgeHost)("T-BACKUP-1 real API: a file holding the allowed index name with another expression is refused by the real backup", { timeout: 180_000 }, async () => {
    const f = backupFixture(), keys = testAgeKeys();
    try {
      f.db.exec(`CREATE INDEX ${INDEX} ON messages(thread_id, json_extract(json,'$.turnId'))`);
      f.db.close();
      const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
      await expect(writeEncryptedInstallationBackup(f.data, join(f.parent, "refused.age"), { ...keys, selection })).rejects.toMatchObject({ code: "DATABASE_SCHEMA_UNSUPPORTED" });
    } finally { try { f.db.close(); } catch { /* closed above */ } removeTempDirSync(f.parent); }
  });

  for (const withIndex of [true, false]) {
    it.skipIf(!rawAgeHost)(`T-RESTORE-1: a real encrypted backup ${withIndex ? "with" : "without"} the index restores; the next start has it and reads are exact`, { timeout: 180_000 }, async () => {
      const f = backupFixture(), keys = testAgeKeys();
      try {
        put(f.db, THREAD, "r1", "turn-z");
        put(f.db, THREAD, "r2", "turn-z");
        // An older connection may write a legacy pending card. This build's
        // live approval guard correctly forbids manufacturing one on f.db.
        f.db.close();
        const legacy=new DatabaseSync(join(f.data,"messages.db"));
        // Restore preparation must still rewrite this older writer's JSON.
        put(legacy, THREAD, "r3", "turn-z", { kind: "options", card: { requestId: "req-1", title: "Waiting", options: ["Allow"] } } as unknown as Partial<Message>);
        if (withIndex) legacy.exec(T.TURN_INDEX_DDL);
        legacy.close();
        const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
        const archive = join(f.parent, "backup.age");
        const written = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
        const target = join(f.parent, "restored");
        const restored = await restoreEncryptedInstallationNew(target, archive, written.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
        expect(restored.status).toBe("restored-review-required");
        const check = new DatabaseSync(join(target, "messages.db"));
        expect(hasIndex(check)).toBe(withIndex);
        // the rewrite really happened, and the index (when it came in the archive) follows it
        const rewritten = JSON.parse((check.prepare("SELECT json FROM messages WHERE id = 'r3'").get() as { json: string }).json) as { card: { answered?: string } };
        expect(rewritten.card.answered).toBe("Expired after restore");
        check.close();
        const run = parsed(child("read", [THREAD, "turn-z"], { VITEST: "1" }, target));
        expect(run.rows).toEqual(["r1", "r2", "r3"]);
        const after = new DatabaseSync(join(target, "messages.db"));
        expect(hasIndex(after)).toBe(true);
        expect(ids(oracle(after, THREAD, "turn-z"))).toEqual(run.rows);
        expect(run.text).toEqual(ids(oracle(after, THREAD, "turn-z").filter(row => lineClassesOf(row).includes(LINE_TEXT))));
        after.close();
      } finally { try { f.db.close(); } catch { /* closed above */ } removeTempDirSync(f.parent); }
    });
  }
});

describe("write cost", () => {
  it("T-WRITE-1: the index adds under 2x at 200 B and under 1.5x at 1 MB, inserts and updates, best of 3", { tags: ["perf-budget"] }, async () => {
    const measure = (indexed: boolean, bytes: number, rows: number) => {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec("CREATE TABLE messages (thread_id TEXT, id TEXT, json TEXT)");
        if (indexed) db.exec(T.TURN_INDEX_DDL);
        const json = JSON.stringify({ turnId: "t", text: "x".repeat(bytes) });
        const began = performance.now();
        for (let i = 0; i < rows; i++) db.prepare("INSERT INTO messages VALUES ('a', ?, ?)").run(String(i), json);
        for (let i = 0; i < rows; i++) db.prepare("UPDATE messages SET json = json_set(json,'$.subtitle','s') WHERE rowid = ?").run(i + 1);
        return performance.now() - began;
      } finally { db.close(); }
    };
    const best = (indexed: boolean, bytes: number, rows: number) => Math.min(...[0, 1, 2].map(() => measure(indexed, bytes, rows)));
    expect(best(true, 200, 2_000) / best(false, 200, 2_000)).toBeLessThan(2);
    expect(best(true, 1_000_000, 20) / best(false, 1_000_000, 20)).toBeLessThan(1.5);
  });
});

// The cheaper partial predicate is only a candidate filter. SQLite's guarded
// JSON expression remains authoritative for raw writers and escaped keys.
it("turn candidate filter preserves escaped keys and ignores lexical false positives", async () => {
 const db=database();
 const insert=db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('escaped',?,1,'bot','text','fixture',?)");
 const base={id:"row",at:1,role:"bot",kind:"text",text:"fixture",turnId:"target"};
 const ordinary=JSON.stringify(base);
 insert.run("ordinary",ordinary.replace('"row"','"ordinary"'));
 insert.run("escaped",ordinary.replace('"row"','"escaped"').replace('"turnId"','"turn\\u0049d"'));
 insert.run("false-positive",JSON.stringify({...base,id:"false-positive",turnId:undefined,text:'quoted "turnId" is prose'}));
 insert.run("backslash",JSON.stringify({...base,id:"backslash",turnId:undefined,text:"line\nline"}));
 expect(ids(M.turnRows("escaped","target"))).toEqual(["ordinary","escaped"]);
 expectExact(db,"escaped","target");
});

it.each(Tables.TURN_INDEX_PREVIOUS_DDLS)("replaces the prior partial turn index atomically before listen and accepts its archives (%#)", previous => {
  const db = database();
  put(db, "migration", "before", "target");
  db.exec(`DROP INDEX ${INDEX}`);
  db.exec(previous);
  expect(() => inspectInstallationDatabase(db)).not.toThrow();
  expect(Optional.preListenIndexMissing(db)).toBe(true);
  Optional.buildPreListenIndexes(db, { log: false });
  expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(INDEX)?.sql).toBe(T.TURN_INDEX_DDL.replace(" IF NOT EXISTS", ""));
  expect(ids(M.turnRows("migration", "target"))).toEqual(["before"]);
  expect(Optional.preListenIndexMissing(db)).toBe(false);
});

it("a failed turn index replacement retains the prior index and every message", () => {
  const db = database();
  put(db, "migration", "kept", "target");
  db.exec(`DROP INDEX ${INDEX}`);
  db.exec(Tables.TURN_INDEX_PREVIOUS_DDL);
  const index = Optional.OPTIONAL_INDEXES.find(item => item.name === INDEX)!;
  const sql = index.sql;
  try {
    index.sql = "CREATE INDEX messages_turn ON missing_table(x)";
    expect(() => Optional.buildPreListenIndexes(db, { log: false })).toThrow();
    expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(INDEX)?.sql).toBe(Tables.TURN_INDEX_PREVIOUS_DDL);
    expect(ids(M.turnRows("migration", "target"))).toEqual(["kept"]);
  } finally { index.sql = sql; }
});


it("a malformed raw row remains writable and never gains a turn index entry", () => {
  // Isolate the turn index: unrelated app expression indexes have their own
  // JSON constraints. This checks this DDL's behavior for every raw writer.
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,json TEXT)");
    db.exec(T.TURN_INDEX_DDL);
    db.prepare("INSERT INTO messages VALUES('damaged','kept',?)").run(JSON.stringify(message("kept", "target")));
    db.prepare("UPDATE messages SET json=?").run('{"turnId":"target", broken');
    const read = db.prepare(`SELECT id FROM messages INDEXED BY ${INDEX} WHERE thread_id=? AND ${Tables.TURN_CANDIDATE} AND ${T.TURN_EXPR}=?`);
    expect(read.all("damaged", "target")).toEqual([]);
    db.prepare("UPDATE messages SET json=?").run(JSON.stringify(message("kept", "fixed")));
    expect(ids(read.all("damaged", "fixed") as Array<{id:string}>)).toEqual(["kept"]);
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  } finally { db.close(); }
});
