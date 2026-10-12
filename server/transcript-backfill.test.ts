// Lane E round 3 (1.0.2 scale): the derived transcript tables of an upgraded
// database are filled resumably and in bounded chunks, and the first open of a
// very long thread does bounded work.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ioBudget } from "./io-budget.ts";
import { initializeMessageTables } from "./message-tables.ts";
import {
  BACKGROUND_WALK_STEPS,
  OPEN_PATH_WALK_STEPS,
  indexTurnFirstChunk,
  readIndexState,
  resolveCardBranch,
  runTranscriptBackfill,
  turnFirstRowid,
  walkStats,
  walkThreadChunk,
} from "./transcript-backfill.ts";

const insert = (db: DatabaseSync, id: string, parentId: string | null, extra: object = {}) =>
  db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "t", id, 1, "bot", (extra as { kind?: string }).kind ?? "text", "x", JSON.stringify({ id, parentId, role: "bot", kind: "text", at: 1, ...extra }),
  );
const openCard = (requestId: string) => ({ kind: "options", card: { title: "May I?", options: [], requestId, tool: "Bash" } });
/** A database as an older release left it: transcript rows, none of the derived tables. */
const upgraded = (db: DatabaseSync) => { db.exec("DELETE FROM open_card; DELETE FROM turn_first; DELETE FROM card_branch; DELETE FROM branch_walk; DELETE FROM transcript_index_state;"); };

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

describe("turn_first backfill and lookup", () => {
  it("R3: chunks carry the true first row, keep going after a restart, and fix a too-late entry", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    insert(db, "a", null, { turnId: "T" });
    insert(db, "b", "a", { turnId: "T" });
    insert(db, "c", "b", { turnId: "U" });
    upgraded(db);
    // an entry a writer left too late for a turn that began earlier
    db.prepare("INSERT INTO turn_first VALUES ('t','T',2)").run();
    expect(indexTurnFirstChunk(db, 2)).toBe(true);
    expect(readIndexState(db, "turn_first")).toMatchObject({ done: 0, cursor: 2 });
    expect(indexTurnFirstChunk(db, 2)).toBe(false);
    expect(db.prepare("SELECT turn_id, first_rowid FROM turn_first ORDER BY turn_id").all()).toEqual([
      { turn_id: "T", first_rowid: 1 },
      { turn_id: "U", first_rowid: 3 },
    ]);
  });

  it("R3: the long lookup for a turn from before the table runs once and is kept", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    for (let i = 0; i < 50; i++) insert(db, `m${i}`, i ? `m${i - 1}` : null, i >= 40 ? { turnId: "T" } : {});
    upgraded(db);
    const scans = () => spy.mock.calls.filter(([sql]) => String(sql).includes("ORDER BY rowid") && String(sql).includes("json FROM messages WHERE thread_id = ?")).length;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare");
    walkStats.parentReads = 0;
    try {
      expect(turnFirstRowid(db, "t", "T", "m49")).toBe(41);
      expect(scans()).toBe(0);
      const reads = walkStats.parentReads;
      expect(turnFirstRowid(db, "t", "T", "m49")).toBe(41);
      expect(walkStats.parentReads).toBe(reads); // kept: no second walk
    } finally { spy.mockRestore(); }
    expect(db.prepare("SELECT first_rowid FROM turn_first WHERE turn_id = 'T'").get()).toEqual({ first_rowid: 41 });
  });
});

describe("first open of an upgraded 100k-row thread", () => {
  afterEach(() => { walkStats.parentReads = 0; });

  function bigThread(rows: number) {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    db.exec("BEGIN");
    insert(db, "m0", null);
    insert(db, "old", "m0", openCard("r-old"));
    let parent = "old";
    for (let i = 1; i < rows; i++) { insert(db, `m${i}`, parent); parent = `m${i}`; }
    db.exec("COMMIT");
    db.prepare("INSERT INTO thread_state(thread_id, active_leaf_id) VALUES ('t', ?)").run(parent);
    upgraded(db);
    initializeMessageTables(db); // indexes the one card
    return { db, leaf: parent };
  }

  it("R3: the open does a bounded number of parent reads, saves its progress, and the background finishes it in bounded chunks", async () => {
    const { db, leaf } = bigThread(100_000);
    const cards = [{ id: "old", rowid: 2 }];
    const started = performance.now();
    walkStats.parentReads = 0;
    const first = resolveCardBranch(db, "t", leaf, cards, OPEN_PATH_WALK_STEPS);
    const took = performance.now() - started;
    expect(walkStats.parentReads).toBeLessThanOrEqual(OPEN_PATH_WALK_STEPS);
    expect(took).toBeLessThan(100);
    // not settled yet: reported pending, nothing false stored as an answer
    expect(first.pending).toEqual(["old"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_branch").get()).toEqual({ n: 0 });
    // the progress is kept: the next open continues from it, not from the head
    const saved = db.prepare("SELECT cursor_id, pos FROM branch_walk WHERE thread_id = 't'").get() as { cursor_id: string; pos: number };
    expect(saved.pos).toBeGreaterThan(99_000);
    walkStats.parentReads = 0;
    resolveCardBranch(db, "t", leaf, cards, OPEN_PATH_WALK_STEPS);
    expect(walkStats.parentReads).toBeLessThanOrEqual(OPEN_PATH_WALK_STEPS);
    expect((db.prepare("SELECT pos FROM branch_walk WHERE thread_id = 't'").get() as { pos: number }).pos).toBeLessThan(saved.pos - 200);

    // background: every chunk is bounded, and it ends with the answer stored
    let chunks = 0;
    let worst = 0;
    for (;;) {
      const before = walkStats.parentReads;
      const more = walkThreadChunk(db, "t");
      worst = Math.max(worst, walkStats.parentReads - before);
      chunks++;
      if (!more) break;
    }
    expect(worst).toBeLessThanOrEqual(BACKGROUND_WALK_STEPS);
    expect(chunks).toBeGreaterThan(50);
    expect(db.prepare("SELECT leaf_id, on_branch FROM card_branch WHERE card_id = 'old'").get()).toEqual({ leaf_id: leaf, on_branch: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM branch_walk").get()).toEqual({ n: 0 });
    // and from then on an open reads no parent links at all
    walkStats.parentReads = 0;
    expect(resolveCardBranch(db, "t", leaf, cards, OPEN_PATH_WALK_STEPS)).toEqual({ onBranch: new Set(["old"]), pending: [] });
    expect(walkStats.parentReads).toBe(0);
  }, 60_000);

  it("the background pass yields the event loop between chunks and ends the work", async () => {
    const { db } = bigThread(5_000);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    await runTranscriptBackfill(db);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    expect(readIndexState(db, "turn_first").done).toBe(1);
    expect(db.prepare("SELECT on_branch FROM card_branch WHERE card_id = 'old'").get()).toEqual({ on_branch: 1 });
  });

  it("a card on a branch the person left is settled as off-branch, not shown forever", () => {
    const { db } = bigThread(50);
    insert(db, "fork", "m0"); // a sibling branch from before the card
    db.prepare("UPDATE thread_state SET active_leaf_id = 'fork' WHERE thread_id = 't'").run();
    const r = resolveCardBranch(db, "t", "fork", [{ id: "old", rowid: 2 }], OPEN_PATH_WALK_STEPS);
    expect(r).toEqual({ onBranch: new Set(), pending: [] });
    expect(db.prepare("SELECT on_branch FROM card_branch WHERE card_id = 'old'").get()).toEqual({ on_branch: 0 });
  });
});

// ---- round 5: late ancestors, O(1) state, yielding, busy retry, turn lookup ----

const put = (db: DatabaseSync, thread: string, id: string, parentId: string | null, extra: object = {}) =>
  db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, ?, 1, 'bot', ?, 'x', ?)").run(
    thread, id, (extra as { kind?: string }).kind ?? "text", JSON.stringify({ id, parentId, role: "bot", kind: "text", at: 1, ...extra }),
  );

describe("R5-1: ancestry is the parent links, not storage order", () => {
  it("a card stored after its descendants is still found on the branch", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    put(db, "t", "m1", "card");        // rowid 1, parent stored later
    put(db, "t", "m2", "m1");          // rowid 2
    put(db, "t", "card", null, openCard("r1")); // rowid 3: a spliced-in ancestor
    const r = resolveCardBranch(db, "t", "m2", [{ id: "card", rowid: 3 }], OPEN_PATH_WALK_STEPS);
    expect(r).toEqual({ onBranch: new Set(["card"]), pending: [] });
    expect(db.prepare("SELECT on_branch FROM card_branch WHERE card_id = 'card'").get()).toEqual({ on_branch: 1 });
  });

  it("a loop in the parent links ends the walk (off-branch), without depending on rowids", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    put(db, "t", "a", "c");
    put(db, "t", "b", "a");
    put(db, "t", "c", "b");            // a -> c -> b -> a
    put(db, "t", "card", null, openCard("r1"));
    const r = resolveCardBranch(db, "t", "a", [{ id: "card", rowid: 4 }], 10_000);
    expect(r).toEqual({ onBranch: new Set(), pending: [] });
  });
});

describe("R5-2: walk state is constant size", () => {
  it("20,000 answered cards on the way leave a few bytes of state and a one-link resume reads one link", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    db.exec("BEGIN");
    put(db, "t", "old", null, openCard("r-old"));
    let parent = "old";
    for (let i = 0; i < 20_000; i++) {
      const id = `a${i}`;
      put(db, "t", id, parent, { kind: "options", card: { title: "May I?", options: [], requestId: `q${i}`, answered: true } });
      parent = id;
    }
    db.exec("COMMIT");
    const cards = [{ id: "old", rowid: 1 }];
    let r = resolveCardBranch(db, "t", parent, cards, 5_000);
    expect(r.pending).toEqual(["old"]);
    const stateSize = () => String((db.prepare("SELECT found FROM branch_walk WHERE thread_id = 't'").get() as { found: string }).found).length;
    expect(stateSize()).toBeLessThan(100);
    r = resolveCardBranch(db, "t", parent, cards, 5_000);
    expect(stateSize()).toBeLessThan(100);
    walkStats.parentReads = 0;
    r = resolveCardBranch(db, "t", parent, cards, 1);
    expect(walkStats.parentReads).toBe(1);
    expect(stateSize()).toBeLessThan(100);
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_branch").get()).toEqual({ n: 0 }); // answered cards are not tracked
    r = resolveCardBranch(db, "t", parent, cards, 10_000);
    expect(r).toEqual({ onBranch: new Set(["old"]), pending: [] });
  }, 60_000);
});

describe("R5-3: the background yields after every chunk", () => {
  it("100 threads x 900 rows never run more than 1,000 reads between turns of the event loop", async () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    db.exec("BEGIN");
    for (let t = 0; t < 100; t++) {
      put(db, `th${t}`, "c", null, openCard(`r${t}`));
      for (let i = 1; i < 900; i++) put(db, `th${t}`, `m${i}`, i === 1 ? "c" : `m${i - 1}`);
    }
    db.exec("COMMIT");
    upgraded(db);
    initializeMessageTables(db);
    walkStats.parentReads = 0;
    let last = 0;
    let worst = 0;
    let finished = false;
    const watch = () => { worst = Math.max(worst, walkStats.parentReads - last); last = walkStats.parentReads; if (!finished) setImmediate(watch); };
    setImmediate(watch);
    await runTranscriptBackfill(db);
    finished = true;
    await new Promise((resolve) => setImmediate(resolve));
    expect(worst).toBeLessThanOrEqual(1_000);
    expect(walkStats.parentReads).toBeGreaterThanOrEqual(90_000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_branch WHERE on_branch = 1").get()).toEqual({ n: 100 });
  }, 120_000);
});

/** A handle whose first `times` matching calls throw SQLITE_BUSY. */
function busyOn(db: DatabaseSync, match: (sql: string) => boolean, times: number, via: "exec" | "get"): DatabaseSync {
  let left = times;
  const busy = () => Object.assign(new Error("database is locked"), { errcode: 5 });
  return new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== "function") return value;
      if (key === "exec" && via === "exec") return (sql: string) => { if (match(sql) && left-- > 0) throw busy(); return target.exec(sql); };
      if (key === "prepare" && via === "get") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!match(sql)) return statement;
          return new Proxy(statement, { get(s, k) { const inner = Reflect.get(s, k) as unknown; if (typeof inner !== "function") return inner; if (k === "get") return (...a: unknown[]) => { if (left-- > 0) throw busy(); return (inner as (...x: unknown[]) => unknown).apply(s, a); }; return (inner as (...x: unknown[]) => unknown).bind(s); } });
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as DatabaseSync;
}

describe("R5-4: a lock is retried from saved progress", () => {
  function twoCards() {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    put(db, "t", "c1", null, openCard("r1"));
    for (let i = 1; i < 30; i++) put(db, "t", `m${i}`, i === 1 ? "c1" : `m${i - 1}`);
    upgraded(db);
    initializeMessageTables(db);
    return db;
  }

  it("a busy transaction waits with growing backoff and the loop itself carries on to the end", async () => {
    const db = twoCards();
    const waits: number[] = [];
    const flaky = busyOn(db, (sql) => sql === "BEGIN IMMEDIATE", 3, "exec");
    await runTranscriptBackfill(flaky, () => true, { sleep: async (ms) => { waits.push(ms); }, retryBaseMs: 10, retryMaxMs: 1_000 });
    expect(waits.slice(0, 3)).toEqual([10, 20, 40]);
    expect(readIndexState(db, "turn_first").done).toBe(1);
    expect(db.prepare("SELECT on_branch FROM card_branch WHERE card_id = 'c1'").get()).toEqual({ on_branch: 1 });
  });

  it("a lock while reading a parent link is never taken for the end of the branch", () => {
    const db = twoCards();
    const flaky = busyOn(db, (sql) => sql.includes("FROM messages WHERE thread_id = ? AND id = ?"), 1, "get");
    expect(() => resolveCardBranch(flaky, "t", "m29", [{ id: "c1", rowid: 1 }], OPEN_PATH_WALK_STEPS)).toThrow("database is locked");
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_branch").get()).toEqual({ n: 0 });
    expect(resolveCardBranch(flaky, "t", "m29", [{ id: "c1", rowid: 1 }], OPEN_PATH_WALK_STEPS)).toEqual({ onBranch: new Set(["c1"]), pending: [] });
  });

  it("the background takes a short lock wait and puts the handle's wait back", async () => {
    const db = twoCards();
    db.exec("PRAGMA busy_timeout=1000");
    await runTranscriptBackfill(db);
    expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(1000);
  });
});

describe("R5-4: the legacy turn lookup scales with the turn, not the thread", () => {
  it("a 20,000-row thread whose turn is at the end reads about the turn's length and keeps the answer", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    db.exec("BEGIN");
    for (let i = 0; i < 20_000; i++) put(db, "t", `m${i}`, i ? `m${i - 1}` : null, i >= 19_990 ? { turnId: "T" } : {});
    db.exec("COMMIT");
    upgraded(db);
    walkStats.parentReads = 0;
    expect(turnFirstRowid(db, "t", "T", "m19999")).toBe(19_991);
    expect(walkStats.parentReads).toBeLessThanOrEqual(10 + 64 + 2);
    expect(db.prepare("SELECT first_rowid FROM turn_first WHERE turn_id = 'T'").get()).toEqual({ first_rowid: 19_991 });
  });
});

describe("R6: no count on the request path (Brent cycle detection)", () => {
  afterEach(() => { walkStats.parentReads = 0; });

  it("a fresh walk of a 1,000,000-row thread reads at most 256 links and runs no COUNT", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999999)
      INSERT INTO messages(thread_id, id, at, role, kind, text, json)
      SELECT 't', 'm' || i, 1, 'bot', 'text', 'x',
        json_object('id', 'm' || i, 'parentId', CASE WHEN i = 0 THEN NULL ELSE 'm' || (i - 1) END, 'role', 'bot', 'kind', 'text', 'at', 1) FROM n`);
    const seen: string[] = [];
    const spy = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== "function") return value;
        if (key === "prepare") return (sql: string) => { seen.push(sql); return target.prepare(sql); };
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    }) as DatabaseSync;
    walkStats.parentReads = 0;
    const r = resolveCardBranch(spy, "t", "m999999", [{ id: "m0", rowid: 1 }], OPEN_PATH_WALK_STEPS);
    expect(r.pending).toEqual(["m0"]);
    expect(walkStats.parentReads).toBeLessThanOrEqual(256);
    expect(seen.filter((sql) => /count\s*\(/i.test(sql))).toEqual([]);
  }, 120_000);

  it("a loop is still found, across chunks, from the constant-size cursor", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    for (let i = 0; i < 50; i++) put(db, "t", `n${i}`, `n${(i + 1) % 50}`);
    put(db, "t", "card", null, openCard("r1"));
    let r = resolveCardBranch(db, "t", "n0", [{ id: "card", rowid: 51 }], 7);
    let rounds = 0;
    while (r.pending.length && rounds++ < 100) r = resolveCardBranch(db, "t", "n0", [{ id: "card", rowid: 51 }], 7);
    expect(r).toEqual({ onBranch: new Set(), pending: [] });
    expect(db.prepare("SELECT on_branch FROM card_branch WHERE card_id = 'card'").get()).toEqual({ on_branch: 0 });
  });
});

describe("R6: backoff counts each phase apart", () => {
  it("three locks in the walk phase give growing waits even though turn indexing succeeds in between", async () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    put(db, "t", "c1", null, openCard("r1"));
    for (let i = 1; i < 30; i++) put(db, "t", `m${i}`, i === 1 ? "c1" : `m${i - 1}`);
    upgraded(db);
    initializeMessageTables(db);
    let begins = 0;
    const busy = () => Object.assign(new Error("database is locked"), { errcode: 5 });
    const flaky = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== "function") return value;
        if (key === "exec") return (sql: string) => { if (sql === "BEGIN IMMEDIATE" && ++begins >= 2 && begins <= 4) throw busy(); return target.exec(sql); };
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    }) as DatabaseSync;
    const waits: number[] = [];
    await runTranscriptBackfill(flaky, () => true, { sleep: async (ms) => { waits.push(ms); }, retryBaseMs: 10, retryMaxMs: 1_000 });
    expect(waits.slice(0, 3)).toEqual([10, 20, 40]);
    expect(db.prepare("SELECT on_branch FROM card_branch WHERE card_id = 'c1'").get()).toEqual({ on_branch: 1 });
  });
});

describe("R6: the I/O deferral window is waited out", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("a 120 s window with a 30 s sleep cap writes nothing inside it", async () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    put(db, "t", "c1", null, openCard("r1"));
    for (let i = 1; i < 30; i++) put(db, "t", `m${i}`, i === 1 ? "c1" : `m${i - 1}`);
    upgraded(db);
    initializeMessageTables(db);
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
    await runTranscriptBackfill(watched, () => true, { sleep: async (ms) => { clock += ms; } });
    expect(writes.length).toBeGreaterThan(0);
    expect(Math.min(...writes)).toBeGreaterThanOrEqual(120_000);
  });
});

describe("S1: the background backfill yields to the owner's foreground work", () => {
  it("writes nothing while the owner-first gate defers it, then carries on once it admits", async () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    for (let i = 0; i < 30; i++) put(db, "t", `m${i}`, i ? `m${i - 1}` : null);
    upgraded(db);
    initializeMessageTables(db);
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
    expect(readIndexState(db, "turn_first").done).toBe(1);
  });
});
