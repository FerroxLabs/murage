// SPDX-License-Identifier: AGPL-3.0-or-later
// Extreme scale: an Inbox answer costs what is on screen, never the history.
//
// The same recent activity (a fortnight of routine runs, owed approvals and a
// provider failure) sits on top of 100 conversations x 500 messages and on top
// of 6,000 conversations x 500 messages (3M rows, about the 48 GB rig). Every
// item of every age is listed and counted (the lists hold far more at 6,000),
// but the statements run and the rows they return must be identical, no
// statement may scan the projection or the messages, and no cold load may hold
// the thread for more than 50 ms. Counts come from kept counters, so the only
// thing that grows is one counter row per permitted conversation.
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { fillInboxProjection, initializeInbox, listInbox, listInboxCached, owedThreads, type InboxAccess } from "./inbox.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";

const PER_THREAD = 500, OLD_RUNS_PER_THREAD = 20;
const NOW = 1_790_000_000_000, DAY = 24 * 60 * 60 * 1000;
const databases: DatabaseSync[] = [];
afterAll(() => { for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } } });

/** `threads` conversations of history older than the window, then the same recent set every time. */
function seed(threads: number) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;");
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  // History, generated inside SQLite: 480 owner lines and 20 finished routine
  // runs per conversation, all between 30 and 395 days old.
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i < ?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json)
    SELECT 't' || (i / ${PER_THREAD}), 'h' || i, ? - 30*${DAY} - (i % 1000) * 31536000,
      CASE WHEN i % ${PER_THREAD} < ${OLD_RUNS_PER_THREAD} THEN 'bot' ELSE 'user' END,
      CASE WHEN i % ${PER_THREAD} < ${OLD_RUNS_PER_THREAD} THEN 'routine.run' ELSE 'text' END,
      CASE WHEN i % ${PER_THREAD} < ${OLD_RUNS_PER_THREAD} THEN NULL ELSE 'line ' || i END,
      CASE WHEN i % ${PER_THREAD} < ${OLD_RUNS_PER_THREAD}
        THEN json_object('id','h' || i,'role','bot','kind','routine.run','routineRun',json_object('runId','old' || i,'routineId','r' || (i % 7),'routineName','Routine ' || (i % 7),'status',CASE WHEN i % 3 = 0 THEN 'failed' ELSE 'completed' END,'summary','Found things','error','boom'))
        ELSE json_object('id','h' || i,'role','user','kind','text','text','line ' || i) END
    FROM n`).run(threads * PER_THREAD - 1, NOW);
  // The first fill reads the history once (after listen, in the server).
  initializeInbox(db);
  fillInboxProjection(db);
  // Recent activity arrives through ordinary writes; the triggers project it.
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const put = (thread: string, id: string, at: number, kind: string, body: Record<string, unknown>) =>
    insert.run(thread, id, at, "bot", kind, null, JSON.stringify({ id, at, role: "bot", kind, ...body }));
  for (let i = 0; i < 30; i++) put(`t${i % 5}`, `run${i}`, NOW - i * 6 * 60 * 60 * 1000, "routine.run", { routineRun: { runId: `run${i}`, routineId: `r${i % 3}`, routineName: `Daily ${i % 3}`, status: i % 4 === 0 ? "failed" : "completed", summary: `Result ${i}`, error: "401 unauthorized" } });
  for (let i = 0; i < 5; i++) put(`t${i}`, `card${i}`, NOW - i * DAY, "options", { card: { requestId: `req${i}`, title: "Command", options: ["Allow", "Deny"], tool: i % 2 ? "Bash" : undefined } });
  for (let i = 0; i < 3; i++) put(`t${i}`, `fail${i}`, NOW - i * 60_000, "activity", { tool: { name: "Provider", ok: false, providerError: { httpStatus: 503 } } });
  return db;
}

function access(threads: number): InboxAccess {
  return { owner: true, threads: Array.from({ length: threads }, (_, i) => ({ threadId: `t${i}`, label: `Bot ${i}`, botId: `b${i}` })) };
}

/** Every statement an answer runs, with the rows it returned. */
function recording(db: DatabaseSync) {
  const runs: Array<{ sql: string; rows: number }> = [];
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql);
    for (const method of ["get", "all", "run"] as const) {
      const original = statement[method].bind(statement) as (...a: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        const out = original(...args);
        runs.push({ sql, rows: Array.isArray(out) ? out.length : out === undefined ? 0 : 1 });
        return out;
      };
    }
    return statement;
  };
  return { runs, plan: (sql: string) => (prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(row => row.detail) };
}

const VIEWS = ["decisions", "all", "routines", "to-read", "results", "approvals", "connections"] as const;

describe("Inbox at 100 and 6,000 conversations x 500 messages", () => {
  const small = seed(100), large = seed(6_000);

  it("projects every item of every age, and lists and counts it", () => {
    for (const [db, threads] of [[small, 100], [large, 6_000]] as const) {
      expect((db.prepare("SELECT COUNT(*) AS n FROM inbox_raw").get() as { n: number }).n).toBe(threads * OLD_RUNS_PER_THREAD + 38);
      // an old run with an empty summary is not an item, as in base
      const items = (db.prepare("SELECT COUNT(*) AS n FROM inbox_items").get() as { n: number }).n;
      expect(listInbox(db, { view: "all" }, access(threads), NOW).total).toBe(items);
      expect(items).toBeGreaterThan(threads * 10);
    }
  });

  it("runs the same statements, over the same index ranges, returning the same rows", () => {
    const decisions: string[] = [], traces: string[] = [], toRead: number[] = [];
    for (const [db, threads] of [[small, 100], [large, 6_000]] as const) {
      const recorder = recording(db);
      const pages = VIEWS.map(view => listInbox(db, { view, pageSize: 100 }, access(threads), NOW));
      const owed = [...owedThreads(db, access(threads))].sort();
      // what is owed is recent at both sizes, so that list and its badges are
      // identical too (to-read is not: every old failed run is news)
      const { items, total, approvals, questions, connections, questionThreads, restore } = pages[0];
      decisions.push(JSON.stringify({ decisions: { items, total, decisions: pages[0].decisions, approvals, questions, connections, questionThreads, restore }, owed }));
      toRead.push(pages[0].toRead);
      traces.push(JSON.stringify(recorder.runs));
      for (const { sql } of recorder.runs) {
        // never a table scan of the projection or of the messages: index searches only
        const plan = recorder.plan(sql).join("\n");
        expect(plan, `${plan}\n---\n${sql.slice(-200)}`).not.toMatch(/SCAN (inbox_raw|messages|inbox_keys|inbox_counts)\b/);
        // a list is walked down its own index, in its order, and stops at the page
        expect(plan, sql).not.toMatch(/SCAN inbox_items\b(?! USING)/);
        expect(plan, sql).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
      }
      console.log(`[scale] ${threads} conversations: statements=${recorder.runs.length} rows=${recorder.runs.reduce((n, run) => n + run.rows, 0)}`);
    }
    expect(traces[1]).toBe(traces[0]);
    expect(decisions[1]).toBe(decisions[0]);
    expect(toRead[1]).toBeGreaterThan(toRead[0] * 50);
    expect(JSON.parse(decisions[0]).decisions.decisions).toBeGreaterThan(0);
  });

  it("never holds the thread for more than 50 ms on a cold load at 6,000 conversations", () => {
    const scope = access(6_000);
    listInboxCached(large, { view: "decisions" }, scope, NOW); // compile the statements once
    const times: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (const view of VIEWS) {
        bumpMessagesVersion(); // as after any new card or run: nothing held
        const started = performance.now();
        listInboxCached(large, { view }, scope, NOW);
        times.push(performance.now() - started);
      }
    }
    console.log(`[scale] cold loads at 6,000: max=${Math.max(...times).toFixed(1)} ms`);
    expect(Math.max(...times)).toBeLessThanOrEqual(50);
  });

  it("takes a new run into the projection as it is written, with no rebuild", () => {
    const before = (large.prepare("SELECT COUNT(*) AS n FROM inbox_raw").get() as { n: number }).n;
    large.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)")
      .run("t7", "late", NOW, "bot", "options", null, JSON.stringify({ id: "late", at: NOW, role: "bot", kind: "options", card: { requestId: "late", title: "Command", options: ["Allow"], tool: "Bash" } }));
    expect((large.prepare("SELECT COUNT(*) AS n FROM inbox_raw").get() as { n: number }).n).toBe(before + 1);
    const page = listInbox(large, { view: "approvals" }, access(6_000), NOW);
    expect(page.items.some(item => item.link.messageId === "late")).toBe(true);
    // answered in place: the same row now reads as resolved, and is owed no more
    large.prepare("UPDATE messages SET json=? WHERE thread_id='t7' AND id='late'")
      .run(JSON.stringify({ id: "late", at: NOW, role: "bot", kind: "options", card: { requestId: "late", title: "Command", options: ["Allow"], tool: "Bash", answered: "Allow" } }));
    expect([...owedThreads(large, access(6_000))]).not.toContain("t7");
    large.prepare("DELETE FROM messages WHERE thread_id='t7' AND id='late'").run();
    expect((large.prepare("SELECT COUNT(*) AS n FROM inbox_raw").get() as { n: number }).n).toBe(before);
    expect(large.prepare("SELECT 1 FROM inbox_keys WHERE source_key LIKE '[\"t7\",\"options\"%'").get()).toBeUndefined();
  });
}, 600_000);
