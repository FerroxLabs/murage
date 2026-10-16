// SPDX-License-Identifier: AGPL-3.0-or-later
// The Inbox projection's first fill is bounded three ways, and survives being
// killed at any step:
//  1. a slice costs what is in the slice, never what is in the database (the
//     planner must use the rowid range, not walk every bot message);
//  2. a slice is sized by measured time AND bytes with a hard cap, so a stretch
//     of large rows after a stretch of small ones cannot hold the loop;
//  3. initialization is atomic and the fill resumes from its durable cursor,
//     whatever step was interrupted.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { INBOX_FILL_SQL, fillInboxProjection, initializeInbox, inboxProjectionReady, inboxProjectionSlice, listInbox, startInboxProjectionFill } from "./inbox.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const databases: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});
const open = (path = ":memory:") => { const db = new DatabaseSync(path); databases.push(db); return db; };
const plan = (db: DatabaseSync, sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 100, 65_536) as Array<{ detail: string }>).map(row => row.detail).join("\n");
const access = { owner: true, threads: Array.from({ length: 40 }, (_, i) => ({ threadId: `t${i}`, label: `Bot ${i}` })) };

/** Half bot chat lines, half user lines, across `conversations`; one in `cardEvery` bot rows is an owed approval card. */
function bulk(db: DatabaseSync, total: number, conversations: number, cardEvery = 0) {
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 't' || (i % CAST(? AS INTEGER)), 'm' || i, 1700000000000 + i, CASE WHEN i % 2 THEN 'bot' ELSE 'user' END, k, 'line ' || i,
      CASE WHEN k = 'options' THEN json_object('id','m' || i,'at',1700000000000 + i,'role','bot','kind','options','card',json_object('requestId','req' || i,'title','Command','options',json_array('Allow','Deny'),'tool','Bash'))
        ELSE json_object('id','m' || i,'at',1700000000000 + i,'role',CASE WHEN i % 2 THEN 'bot' ELSE 'user' END,'kind','text','text','line ' || i) END
    FROM (SELECT i, CASE WHEN ? > 0 AND i % 2 AND i % (2 * ?) = 1 THEN 'options' ELSE 'text' END AS k FROM n)`).run(total, conversations, cardEvery, cardEvery || 1);
}
const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

function sliceCosts(total: number, conversations: number, slices = 21) {
  const db = open();
  initializeMessageTables(db);
  bulk(db, total, conversations);
  initializeInbox(db);
  // start in the middle of the history, where the walk of every bot row would be longest
  db.prepare("UPDATE inbox_projection_state SET cursor=? WHERE name='inbox'").run(Math.floor(total / 2));
  const times: number[] = [];
  for (let i = 0; i < slices; i++) {
    const started = performance.now();
    inboxProjectionSlice(db, { rows: 500 });
    times.push(performance.now() - started);
  }
  return { db, median: median(times) };
}

describe("a fill slice costs the slice, not the history", () => {
  it("addresses the rowid range, never the (role, kind) index", () => {
    const db = open();
    initializeMessageTables(db);
    initializeInbox(db);
    for (const sql of [INBOX_FILL_SQL.raw, INBOX_FILL_SQL.marks]) {
      const detail = plan(db, sql);
      expect(detail).toMatch(/SEARCH m USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
      expect(detail).not.toMatch(/messages_inbox/);
      expect(detail).not.toMatch(/SCAN m/);
    }
  });

  it("is the same cost at 100 and at 6,000 conversations and at 30k and 600k messages", () => {
    const small = sliceCosts(30_000, 100), large = sliceCosts(600_000, 6_000);
    console.log(`[fill-cost] median 500-row slice: 30k msgs/100 convs=${small.median.toFixed(2)} ms, 600k msgs/6,000 convs=${large.median.toFixed(2)} ms`);
    // generous: the old plan walked every bot row, ~20x apart at this size
    expect(large.median).toBeLessThan(small.median * 3 + 3);
  }, 120_000);
});

/** A disk that takes `msPerMiB` per MiB of message JSON read by the fill's insert. */
function slowDisk(db: DatabaseSync, msPerMiB: number): DatabaseSync {
  const burn = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* a slow read */ } };
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith("INSERT OR IGNORE INTO inbox_raw")) return statement;
        return new Proxy(statement, {
          get(inner, name) {
            if (name === "run") {
              return (from: number, to: number, budget: number) => {
                // only the rows the budget admits are read by the fill (the others are deferred)
                const { bytes } = target.prepare("SELECT COALESCE(SUM(length(json)),0) AS bytes FROM messages WHERE rowid>? AND rowid<=? AND octet_length(json)+256<=?").get(from, to, budget) as { bytes: number };
                burn(bytes / 1048576 * msPerMiB);
                return inner.run(from, to, budget);
              };
            }
            const member = Reflect.get(inner, name) as unknown;
            return typeof member === "function" ? member.bind(inner) : member;
          },
        });
      };
    },
  });
}

describe("a slice never holds the loop", () => {
  it("stays under 50 ms on a slow disk when large rows follow small ones", async () => {
    const db = open();
    initializeMessageTables(db);
    bulk(db, 30_000, 40);
    // a stretch of tool failures with large output after the chat lines
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO messages(thread_id,id,at,role,kind,text,json)
      SELECT 't' || (i % 40), 'big' || i, 1800000000000 + i, 'bot', 'activity', NULL,
        json_object('id','big' || i,'at',1800000000000 + i,'role','bot','kind','activity','tool',json_object('name','run','ok',json('false'),'providerError',json_object('httpStatus',500,'provider','x'),'output',replace(hex(zeroblob(6000)),'0','x')))
      FROM n`).run(1_500);
    initializeInbox(db);
    const fill = startInboxProjectionFill(slowDisk(db, 60));
    expect(await fill.done).toEqual({ filled: true });
    console.log(`[slow-disk] slices=${fill.stats.slices} max=${fill.stats.maxSliceMs.toFixed(1)} ms`);
    expect(fill.stats.maxSliceMs).toBeLessThan(50);
    expect(inboxProjectionReady(db)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM inbox_raw").get() as { n: number }).n).toBe(1_500);
    expect((db.prepare("SELECT COUNT(*) AS n FROM setup_marks WHERE kind='refusal'").get() as { n: number }).n).toBe(1_500);
  }, 120_000);

  it("always makes progress however large the first row is, and never admits more than the budget", () => {
    const db = open();
    initializeMessageTables(db);
    bulk(db, 1_000, 10);
    initializeInbox(db);
    expect(inboxProjectionSlice(db, { rows: 10_000, weight: 1 })).toMatchObject({ finished: false, rows: 1 });
    const second = inboxProjectionSlice(db, { rows: 10_000, weight: 50_000 });
    expect(second.rows).toBeGreaterThan(1);
    expect(second.rows).toBeLessThan(250);
  });
});

/** Throws on the `at`th database call (exec, or run/get/all of a prepared statement), once. */
function dyingAt(db: DatabaseSync, at: number) {
  const state = { calls: 0, died: false };
  const tick = () => { if (++state.calls === at) { state.died = true; throw new Error(`killed at step ${at}`); } };
  const proxy = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === "exec") return (sql: string) => { tick(); return target.exec(sql); };
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(inner, name) {
            const member = Reflect.get(inner, name) as unknown;
            if (name === "run" || name === "get" || name === "all") return (...args: unknown[]) => { tick(); return (member as (...a: unknown[]) => unknown).apply(inner, args); };
            return typeof member === "function" ? member.bind(inner) : member;
          },
        });
      };
    },
  });
  return { proxy, state };
}

function installation() {
  const dir = mkdtempSync(join(tmpdir(), "murage-inbox-resume-")); dirs.push(dir);
  const path = join(dir, "messages.db");
  const seed = new DatabaseSync(path);
  initializeMessageTables(seed);
  bulk(seed, 2_000, 40, 10);
  seed.close();
  return path;
}
const owed = (db: DatabaseSync) => listInbox(db, { view: "decisions" }, access);

describe("initialization and the fill survive being killed at any step", () => {
  it("finishes the Inbox whichever step of initialization is interrupted", () => {
    const path = installation();
    const reference = open(path);
    initializeInbox(reference);
    fillInboxProjection(reference);
    const expected = owed(reference).total;
    expect(expected).toBeGreaterThan(0);
    reference.close();
    // an upgrade of the same history, killed at step `at`, then restarted
    let killed = 0;
    for (let at = 1; at <= 400; at++) {
      const target = installation();
      const first = open(target);
      const { proxy, state } = dyingAt(first, at);
      try { initializeInbox(proxy); } catch { /* the process died here */ }
      if (state.died) killed++;
      first.close();
      const restarted = open(target);
      initializeInbox(restarted);
      fillInboxProjection(restarted);
      expect(inboxProjectionReady(restarted), `ready after a kill at step ${at}`).toBe(true);
      expect(owed(restarted).total, `items after a kill at step ${at}`).toBe(expected);
      if (!state.died) break;
    }
    expect(killed).toBeGreaterThan(5);
  }, 240_000);

  it("finishes whichever step of a fill slice is interrupted, resuming from the cursor", () => {
    const path = installation();
    const reference = open(path);
    initializeInbox(reference);
    fillInboxProjection(reference);
    const expected = owed(reference).total;
    const expectedMarks = (reference.prepare("SELECT COUNT(*) AS n FROM setup_marks").get() as { n: number }).n;
    reference.close();
    for (let at = 1; at <= 40; at++) {
      const target = installation();
      const first = open(target);
      initializeInbox(first);
      inboxProjectionSlice(first, { rows: 700 });
      const { proxy, state } = dyingAt(first, at);
      try { inboxProjectionSlice(proxy, { rows: 700 }); } catch { /* the process died here */ }
      first.close();
      const restarted = open(target);
      initializeInbox(restarted);
      fillInboxProjection(restarted);
      expect(inboxProjectionReady(restarted), `ready after a kill at step ${at}`).toBe(true);
      expect(owed(restarted).total, `items after a kill at step ${at}`).toBe(expected);
      expect((restarted.prepare("SELECT COUNT(*) AS n FROM setup_marks").get() as { n: number }).n).toBe(expectedMarks);
      if (!state.died) break;
    }
  }, 240_000);

  it("repairs a database a former build left with its layout marker but no fill marker", () => {
    const db = open();
    initializeMessageTables(db);
    bulk(db, 2_000, 40, 10);
    initializeInbox(db);
    db.prepare("DELETE FROM inbox_projection_state WHERE name='inbox'").run();
    // the stranded state: layout recognised, nothing to advance
    expect(inboxProjectionReady(db)).toBe(false);
    initializeInbox(db);
    expect(db.prepare("SELECT done, cursor FROM inbox_projection_state WHERE name='inbox'").get()).toEqual({ done: 0, cursor: 0 });
    fillInboxProjection(db);
    expect(inboxProjectionReady(db)).toBe(true);
    expect(owed(db).total).toBeGreaterThan(0);
    // and a fill step finds a missing marker by itself, without a restart
    const other = open();
    initializeMessageTables(other);
    bulk(other, 500, 10, 10);
    initializeInbox(other);
    other.prepare("DELETE FROM inbox_projection_state WHERE name='inbox'").run();
    fillInboxProjection(other);
    expect(inboxProjectionReady(other)).toBe(true);
  });
});
