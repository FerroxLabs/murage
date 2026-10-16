// The derived transcript tables of an upgraded database are filled resumably and
// in bounded chunks: the open-card index as one pass, and every thread's branch
// index, line index, turn_first and message_image thread by thread, in slices that
// never hold the event loop for more than a bounded amount of work.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ioBudget } from "./io-budget.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { branchOracle, threadKey } from "./branch-index.ts";
import { BACKFILL_UPGRADE_RECHECK_MS, BACKFILL_UPGRADE_YIELD_MAX_MS, holdTranscriptBackfillUntil, readIndexState, runTranscriptBackfill, turnFirstRowid } from "./transcript-backfill.ts";

const put = (db: DatabaseSync, thread: string, id: string, parentId: string | null, extra: object = {}) =>
  db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, ?, 1, 'bot', ?, 'x', ?)").run(
    thread, id, (extra as { kind?: string }).kind ?? "text", JSON.stringify({ id, parentId, role: "bot", kind: "text", at: 1, ...extra }),
  );
const insert = (db: DatabaseSync, id: string, parentId: string | null, extra: object = {}) =>
  db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "t", id, 1, "bot", (extra as { kind?: string }).kind ?? "text", "x", JSON.stringify({ id, parentId, role: "bot", kind: "text", at: 1, ...extra }),
  );
const openCard = (requestId: string) => ({ kind: "options", card: { title: "May I?", options: [], requestId, tool: "Bash" } });
/** A database as an older release left it: transcript rows, none of the derived tables. */
const upgraded = (db: DatabaseSync) => { db.exec("DELETE FROM open_card; DELETE FROM turn_first; DELETE FROM message_image; DELETE FROM thread_key; DELETE FROM seg; DELETE FROM msg_branch; DELETE FROM line; DELETE FROM fill_pending; DELETE FROM transcript_index_state;"); };

/** A handle whose Nth INSERT into `table` throws, as a full disk would. */
function failingOn(db: DatabaseSync, table: string, nth: number): DatabaseSync {
  let seen = 0;
  return new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      if (key !== "prepare") return (value as (...a: unknown[]) => unknown).bind(target);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes(`INTO ${table}`)) return statement;
        return new Proxy(statement, {
          get(s, k) {
            const inner = Reflect.get(s, k) as unknown;
            if (typeof inner !== "function") return inner;
            if (k !== "run") return (inner as (...a: unknown[]) => unknown).bind(s);
            return (...args: unknown[]) => { if (++seen === nth) throw new Error("disk full"); return (inner as (...a: unknown[]) => unknown).apply(s, args); };
          },
        });
      };
    },
  }) as DatabaseSync;
}

describe("open-card backfill is resumable", () => {
  it("R3: a failure on the second insert is not swallowed and the rerun finishes the index (2/2)", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    insert(db, "c1", null, openCard("r1"));
    insert(db, "c2", "c1", openCard("r2"));
    upgraded(db);
    expect(() => initializeMessageTables(failingOn(db, "open_card", 2))).toThrow("disk full");
    // not marked complete by the failed pass
    expect(readIndexState(db, "open_card").done).toBe(0);
    initializeMessageTables(db);
    expect(db.prepare("SELECT id FROM open_card ORDER BY id").all().map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(readIndexState(db, "open_card").done).toBe(1);
  });

  it("R3: a row with damaged JSON is skipped and counted apart; the rest are indexed", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    insert(db, "c1", null, openCard("r1"));
    db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES ('t','bad',1,'bot','options','x','{not json')").run();
    insert(db, "c2", "c1", openCard("r2"));
    upgraded(db);
    initializeMessageTables(db);
    expect(db.prepare("SELECT id FROM open_card ORDER BY id").all().map((r) => r.id)).toEqual(["c1", "c2"]);
    const state = readIndexState(db, "open_card");
    expect(state).toMatchObject({ done: 1, skipped: 1 });
  });
});


const rowid = (db: DatabaseSync, thread: string, id: string) => Number((db.prepare("SELECT rowid AS r FROM messages WHERE thread_id = ? AND id = ?").get(thread, id) as { r: number }).r);
const always = { admit: () => ({ admitted: true as const, forced: false }) };

describe("the background pass prepares every thread", () => {
  it("fills the branch index, the line index, turn_first and message_image of an upgraded database, thread by thread", async () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    put(db, "a", "a1", null, { turnId: "t1" });
    put(db, "a", "a2", "a1", { turnId: "t1", text: "hello" });
    put(db, "a", "a3", "a2", { turnId: "t2", attachments: [{ kind: "image", path: "/x/one.png" }] });
    put(db, "a", "fork", "a1", { turnId: "t3" });
    put(db, "b", "b1", null, { role: "user", text: "look\n<attached-image path=\"/x/two.png\" />\n" });
    upgraded(db);
    await runTranscriptBackfill(db, () => true, { gate: always });
    expect(threadKey(db, "a")?.state).toBe(2);
    expect(threadKey(db, "b")?.state).toBe(2);
    const tk = threadKey(db, "a")!;
    const on = branchOracle(db, tk, rowid(db, "a", "a3"));
    expect([on(rowid(db, "a", "a1")), on(rowid(db, "a", "a2")), on(rowid(db, "a", "fork"))]).toEqual([true, true, false]);
    expect(turnFirstRowid(db, "a", "t1")).toBe(rowid(db, "a", "a1"));
    expect(db.prepare("SELECT thread_id, path, id FROM message_image ORDER BY path").all().map((r) => `${r.thread_id}:${r.path}:${r.id}`)).toEqual(["a:/x/one.png:a3", "b:/x/two.png:b1"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM line WHERE key = ? AND cls = 1").get(tk.key)).toEqual({ n: 4 });
  });

  it("100 threads x 900 rows are filled in slices: the event loop turns between them and never waits long on one", async () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    db.exec("BEGIN");
    for (let t = 0; t < 100; t++) for (let i = 0; i < 900; i++) put(db, `th${t}`, `m${i}`, i ? `m${i - 1}` : null);
    db.exec("COMMIT");
    upgraded(db);
    initializeMessageTables(db);
    let ticks = 0, worst = 0, last = performance.now(), finished = false;
    const watch = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; ticks++; if (!finished) setImmediate(watch); };
    setImmediate(watch);
    await runTranscriptBackfill(db, () => true, { gate: always });
    finished = true;
    await new Promise((resolve) => setImmediate(resolve));
    // at least one turn of the loop per thread (a slice, then a yield), and none waited a quarter of a second
    expect(ticks).toBeGreaterThanOrEqual(100);
    expect(worst).toBeLessThan(250);
    expect(db.prepare("SELECT COUNT(*) AS n FROM thread_key WHERE state = 2").get()).toEqual({ n: 100 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM msg_branch").get()).toEqual({ n: 90_000 });
  }, 120_000);
});

/** A handle whose first `times` BEGIN IMMEDIATEs throw SQLITE_BUSY. */
function busyBegin(db: DatabaseSync, from: number, to: number): DatabaseSync {
  let begins = 0;
  const busy = () => Object.assign(new Error("database is locked"), { errcode: 5 });
  return new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      if (key === "exec") return (sql: string) => { if (sql === "BEGIN IMMEDIATE" && ++begins >= from && begins <= to) throw busy(); return target.exec(sql); };
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as DatabaseSync;
}

function oneThread() {
  const db = new DatabaseSync(":memory:");
  initializeMessageTables(db);
  for (let i = 0; i < 30; i++) put(db, "t", `m${i}`, i ? `m${i - 1}` : null, { turnId: "t1" });
  upgraded(db);
  initializeMessageTables(db);
  return db;
}

describe("a lock is retried from saved progress", () => {
  it("a busy transaction waits with growing backoff and the loop itself carries on to the end", async () => {
    const db = oneThread();
    const waits: number[] = [];
    await runTranscriptBackfill(busyBegin(db, 1, 3), () => true, { gate: always, sleep: async (ms) => { waits.push(ms); }, retryBaseMs: 10, retryMaxMs: 1_000 });
    expect(waits.slice(0, 3)).toEqual([10, 20, 40]);
    expect(threadKey(db, "t")?.state).toBe(2);
    expect(turnFirstRowid(db, "t", "t1")).toBe(rowid(db, "t", "m0"));
  });

  it("the background takes a short lock wait and puts the handle's wait back", async () => {
    const db = oneThread();
    db.exec("PRAGMA busy_timeout=1000");
    await runTranscriptBackfill(db, () => true, { gate: always });
    expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(1000);
  });
});

describe("the I/O deferral window is waited out", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("a 120 s window with a 30 s sleep cap writes nothing inside it", async () => {
    const db = oneThread();
    let clock = 0;
    vi.spyOn(ioBudget, "deferredForMs").mockImplementation(() => Math.max(0, 120_000 - clock));
    const writes: number[] = [];
    const watched = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== "function") return value;
        if (key === "exec") return (sql: string) => { if (sql === "BEGIN IMMEDIATE") writes.push(clock); return target.exec(sql); };
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    }) as DatabaseSync;
    await runTranscriptBackfill(watched, () => true, { gate: always, sleep: async (ms) => { clock += ms; } });
    expect(writes.length).toBeGreaterThan(0);
    expect(Math.min(...writes)).toBeGreaterThanOrEqual(120_000);
  });
});

describe("the background backfill yields to the owner's foreground work", () => {
  it("writes nothing while the owner-first gate defers it, then carries on once it admits", async () => {
    const db = oneThread();
    let busyFor = 3;
    const asked: string[] = [];
    const gate = { admit: (kind: string) => { asked.push(kind); return busyFor-- > 0 ? { admitted: false as const, reason: "owner-turn" as const, retryInMs: 500 } : { admitted: true as const, forced: false }; } };
    const writes: number[] = [];
    const waits: number[] = [];
    const watched = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== "function") return value;
        if (key === "exec") return (sql: string) => { if (sql === "BEGIN IMMEDIATE") writes.push(waits.length); return target.exec(sql); };
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    }) as DatabaseSync;
    await runTranscriptBackfill(watched, () => true, { gate, sleep: async (ms) => { waits.push(ms); } });
    expect(asked[0]).toBe("transcript-backfill");
    expect(waits.slice(0, 3)).toEqual([500, 500, 500]);
    expect(Math.min(...writes), "no chunk was written before the gate admitted").toBeGreaterThanOrEqual(3);
    expect(threadKey(db, "t")?.state).toBe(2);
  });
});

describe("rc13: the server holds the backfill's writes until the first health answer", () => {
  it("no chunk is written while the hold stands; once released the pass runs to the end", async () => {
    const db = oneThread();
    let release!: () => void;
    holdTranscriptBackfillUntil(new Promise<void>(resolve => { release = resolve; }));
    try {
      const changes = () => Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
      const before = changes();
      const run = runTranscriptBackfill(db, () => true, { gate: always });
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
      expect(changes()).toBe(before);
      expect(threadKey(db, "t")?.state).not.toBe(2);
      release();
      await run;
      expect(changes()).toBeGreaterThan(before);
      expect(threadKey(db, "t")?.state).toBe(2);
    } finally { holdTranscriptBackfillUntil(null); }
  });
});

describe("rc13 round 2: the backfill's own chunks yield to the history upgrade", () => {
  it("writes nothing while the upgrade runs, then runs to the end once it is over", async () => {
    const db = oneThread();
    let upgrading = true, sleeps = 0;
    const changes = () => Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
    const before = changes();
    const sleep = async (ms: number) => { sleeps++; expect(ms).toBe(BACKFILL_UPGRADE_RECHECK_MS); if (sleeps >= 3) upgrading = false; await new Promise(resolve => setImmediate(resolve)); };
    const run = runTranscriptBackfill(db, () => true, { gate: always, ready: null, sleep, upgradeRunning: () => { if (upgrading) expect(changes()).toBe(before); return upgrading; } });
    await run;
    expect(sleeps).toBe(3);
    expect(changes()).toBeGreaterThan(before);
    expect(threadKey(db, "t")?.state).toBe(2);
  });

  it("yields for at most BACKFILL_UPGRADE_YIELD_MAX_MS of one upgrade, then carries on", async () => {
    const db = oneThread();
    let clock = 0;
    const sleep = async (ms: number) => { clock += ms; await new Promise(resolve => setImmediate(resolve)); };
    await runTranscriptBackfill(db, () => true, { gate: always, ready: null, sleep, now: () => clock, upgradeRunning: () => true });
    expect(threadKey(db, "t")?.state).toBe(2);
    expect(clock).toBeGreaterThanOrEqual(BACKFILL_UPGRADE_YIELD_MAX_MS);
    expect(clock).toBeLessThan(BACKFILL_UPGRADE_YIELD_MAX_MS + 2 * BACKFILL_UPGRADE_RECHECK_MS);
  });
});

describe("rc13 round 2: the start's backfill hold is set before the database opens", () => {
  it("index.ts holds the backfill before its first statement that opens the database", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const hold = source.indexOf("holdTranscriptBackfillUntil(startupWritesReady())");
    const firstOpen = source.search(/\bdatabase\(\)/);
    const firstAwait = source.search(/^await /m);
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThan(firstOpen);
    // (a top-level await before the hold would let a chunk of a backfill started at an earlier open run first)
    expect(hold).toBeLessThan(firstAwait);
  });
});
