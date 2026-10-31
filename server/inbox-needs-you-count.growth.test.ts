// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NEEDS YOU COUNT, 1.0.12: GROWTH GATES G1, G1k, G2 to G5 (docs/designs/NEEDS-YOU-COUNT-1012.md section 3).
//
// Opt in (NYC_GROWTH=1): these build fixtures of up to 240k rows and time
// thousands of calls, so they run in a build host lane container, never on a
// laptop and never in the default suite. The same file runs on the 1.0.10 tree
// (no correction there) to record the baseline: NYC_GROWTH_OUT names the JSON
// written, NYC_GROWTH_BASELINE the baseline JSON the "+ N ms" limits read.
// Protocol for every timing: 20 warm-up calls, 200 timed, p95 (p50 recorded).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { InboxQuery } from "../shared/inbox.ts";
import * as inbox from "./inbox.ts";
import * as oracle from "./inbox.base-reference.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const { initializeInbox, listInbox, listInboxCached, owedThreadsCached } = inbox;
/** Present on the 1.0.12 tree only; the baseline run on 1.0.10 skips what needs it. */
const jsFilter = (inbox as unknown as Record<string, unknown>).inboxRunsOnCardsInScope as ((db: DatabaseSync, access: inbox.InboxAccess, now: number) => number) | undefined;
const corrected = typeof jsFilter === "function";

const NOW = 1_800_000_000_000, HOUR = 3_600_000;
const CARD_THREADS = 200;
const CORRECTION_SQL = `SELECT thread_id, live, snoozed_until, COUNT(*) AS n
  FROM inbox_items INDEXED BY inbox_items_v_decisions_4
  WHERE expired=0 AND decision=1 AND kind='routine.run' AND status IN ('waiting','needs-you')
  GROUP BY thread_id, live, snoozed_until`;
const results: Record<string, unknown> = { tree: corrected ? "1.0.12" : "1.0.10" };
const baseline: Record<string, { p50: number; p95: number }> = process.env.NYC_GROWTH_BASELINE && existsSync(process.env.NYC_GROWTH_BASELINE)
  ? JSON.parse(readFileSync(process.env.NYC_GROWTH_BASELINE, "utf8")) as Record<string, { p50: number; p95: number }> : {};

const roots: string[] = [], databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } } for (const root of roots.splice(0)) removeTempDirSync(root); });
afterAll(() => { if (process.env.NYC_GROWTH_OUT) writeFileSync(process.env.NYC_GROWTH_OUT, JSON.stringify(results, null, 1)); });

function fileDb(): DatabaseSync {
  const root = mkdtempSync(join(tmpdir(), "murage-nyc-growth-")); roots.push(root);
  const db = new DatabaseSync(join(root, "messages.db")); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000;");
  initializeMessageTables(db);
  initializeInbox(db);
  return db;
}
// node:sqlite binds a JS number as REAL, and REAL % gives 7.0: without these casts a thread id reads 'c7.0' and no audience holds it.
const seq = (sql: string) => `WITH RECURSIVE n(i) AS (SELECT CAST(?1 AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < ?2) ${sql}`;
const ins = "INSERT INTO messages(thread_id,id,at,role,kind,text,json)";
/** Unrelated chat history (not Inbox items): the hotpath-r6 scale. */
const filler = (db: DatabaseSync, from: number, to: number) => db.prepare(seq(`${ins}
  SELECT 'other' || (i / 100), 'f' || i, CAST(?3 AS INTEGER) + i, 'user', 'text', 'line ' || i, json_object('id','f' || i,'at',CAST(?3 AS INTEGER) + i,'role','user','kind','text','text','line ' || i) FROM n`)).run(from, to - 1, NOW - 10_000_000);
/** Open cards over CARD_THREADS conversations, half approvals and half questions. */
const cards = (db: DatabaseSync, from: number, to: number, at0 = NOW - 5_000_000) => db.prepare(seq(`${ins}
  SELECT 'c' || (i % ${CARD_THREADS}), 'card' || i, CAST(?3 AS INTEGER) + i, 'bot', 'options', NULL,
    json_object('id','card' || i,'at',CAST(?3 AS INTEGER) + i,'role','bot','kind','options','card',json_object('requestId','req' || i,'title','Approve ' || i,'options',json_array('Allow','Deny'),'tool',CASE WHEN i % 2 THEN 'Bash' END)) FROM n`)).run(from, to - 1, at0);
/** Runs on cards, spread over `threads` conversations, newer than every card. */
const runs = (db: DatabaseSync, from: number, to: number, threads: number, at0 = NOW - 1_000_000) => db.prepare(seq(`${ins}
  SELECT 'r' || (i % CAST(?4 AS INTEGER)), 'run' || i, CAST(?3 AS INTEGER) + i, 'bot', 'routine.run', NULL,
    json_object('id','run' || i,'at',CAST(?3 AS INTEGER) + i,'role','bot','kind','routine.run','routineRun',json_object('runId','run' || i,'routineId','rt' || (i % 20),'routineName','Routine ' || (i % 20),'status',CASE WHEN i % 3 THEN 'waiting' ELSE 'needs-you' END,'summary','Waiting on you ' || i)) FROM n`)).run(from, to - 1, at0, Math.max(1, threads));
/** History that must add nothing to the walk: finished runs, answered cards, expired cards. */
const history = (db: DatabaseSync, kind: "completed" | "resolved" | "expired", from: number, to: number) => {
  const at0 = NOW - 9_000_000;
  if (kind === "completed") return db.prepare(seq(`${ins} SELECT 'h' || (i % 300), 'hd' || i, CAST(?3 AS INTEGER) + i, 'bot', 'routine.run', NULL,
    json_object('id','hd' || i,'at',CAST(?3 AS INTEGER) + i,'role','bot','kind','routine.run','routineRun',json_object('runId','hd' || i,'routineId','rt' || (i % 20),'routineName','Routine ' || (i % 20),'status',CASE WHEN i % 4 THEN 'completed' ELSE 'failed' END,'summary','Done ' || i,'error','x')) FROM n`)).run(from, to - 1, at0);
  return db.prepare(seq(`${ins} SELECT 'h' || (i % 300), 'h${kind[0]}' || i, CAST(?3 AS INTEGER) + i, 'bot', 'options', NULL,
    json_object('id','h${kind[0]}' || i,'at',CAST(?3 AS INTEGER) + i,'role','bot','kind','options','card',json_object('requestId','h${kind[0]}' || i,'title','Old','options',json_array('Allow','Deny'),${kind === "resolved" ? "'answered','Allow'" : "'expired',1"})) FROM n`)).run(from, to - 1, at0);
};
const threadsOf = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ threadId: `${prefix}${i}`, label: `${prefix} ${i}` }));
const ownerOf = (runThreads: number): inbox.InboxAccess => ({ owner: true, threads: [...threadsOf("c", CARD_THREADS), ...threadsOf("r", runThreads), ...threadsOf("h", 300)] });
const companionOf = (runThreads: number): inbox.InboxAccess => ({ owner: true, threads: [...threadsOf("c", CARD_THREADS / 10), ...threadsOf("r", Math.max(1, Math.floor(runThreads / 10)))] });

function measure(name: string, fn: () => unknown, warm = 20, timed = 200) {
  for (let i = 0; i < warm; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < timed; i++) { const t = performance.now(); fn(); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  const stat = { p50: times[Math.floor(timed * 0.5)], p95: times[Math.floor(timed * 0.95)] };
  results[name] = stat;
  return stat;
}
/** A gate over an empty audience proves nothing: the fixture's rows must be in the scope that is timed. */
const inScope = (db: DatabaseSync, access: inbox.InboxAccess, atLeast: number) =>
  expect(listInbox(db, { view: "decisions", includeSnoozed: true }, access, NOW).total + 0, "fixture rows are in this audience").toBeGreaterThanOrEqual(atLeast);
const correctionRead = (db: DatabaseSync) => db.prepare(CORRECTION_SQL).all();
const population = (db: DatabaseSync) => ({
  walked: Number((db.prepare("SELECT COUNT(*) AS n FROM inbox_items INDEXED BY inbox_items_v_decisions_4 WHERE expired=0 AND decision=1").get() as { n: number }).n),
  owedOpen: Number((db.prepare("SELECT COALESCE(SUM(owed_open),0) AS n FROM inbox_counts").get() as { n: number }).n),
});
/** A cache miss on purpose: what the first poll after a write pays. */
const miss = <T>(fn: () => T) => () => { bumpMessagesVersion(); return fn(); };
const withinBaseline = (name: string, plusMs: number) => {
  if (!corrected) return; // the 1.0.10 run is the one that writes the baseline
  // No baseline is a failed gate, never a passed one: nothing would have been compared.
  const base = baseline[name];
  expect(Number.isFinite(base?.p95), `${name}: no baseline p95 in NYC_GROWTH_BASELINE (${process.env.NYC_GROWTH_BASELINE ?? "unset"})`).toBe(true);
  expect.soft((results[name] as { p95: number }).p95, `${name} vs 1.0.10 ${base.p95.toFixed(3)} ms + ${plusMs} ms`).toBeLessThanOrEqual(base.p95 + plusMs);
};
/** The answer fields the oracle computes the same way. */
const shape = (page: ReturnType<typeof listInbox>) => ({ total: page.total, decisions: page.decisions, approvals: page.approvals, questions: page.questions, connections: page.connections, ids: page.items.map(item => item.id) });

describe.runIf(process.env.NYC_GROWTH === "1")("Needs you count growth gates", () => {
  it("G1: the correction read is linear in owed rows and small at real sizes (k = 50)", () => {
    const limits: Record<number, number> = { 2_000: 1, 10_000: 5, 40_000: 20 };
    for (const owed of [500, 2_000, 10_000, 40_000]) {
      const db = fileDb();
      filler(db, 0, 200_000);
      cards(db, 0, owed - 50);
      runs(db, 0, 50, 10);
      expect(population(db).walked).toBe(owed);
      const stat = measure(`G1.read.${owed}`, () => correctionRead(db));
      if (limits[owed] !== undefined) expect(stat.p95, `G1 p95 at ${owed}`).toBeLessThanOrEqual(limits[owed]);
      db.close();
    }
  }, 900_000);

  it("G1k: grouping, the cached filter and page skipping stay small as runs on cards grow", () => {
    const readLimit: Record<number, number> = { 500: 2, 2_000: 5, 10_000: 25 };
    const filterLimit: Record<number, number> = { 2_000: 0.5, 10_000: 2 };
    const pagePlus: Record<number, number> = { 500: 1, 2_000: 5, 10_000: 25 };
    for (const k of [50, 500, 2_000, 10_000]) {
      const db = fileDb();
      const groups = Math.max(1, Math.floor(k / 5));
      cards(db, 0, 2_000);
      runs(db, 0, k, groups);
      // a third snoozed (several distinct times, so more groups), a tenth cleared
      db.prepare(`INSERT INTO inbox_item_state(source_key,snoozed_until) SELECT source_key, ? + (CAST(substr(message_id,4) AS INTEGER) % 7) * 1000 FROM inbox_items WHERE kind='routine.run' AND CAST(substr(message_id,4) AS INTEGER) % 3 = 0`).run(NOW + HOUR);
      db.prepare(`INSERT INTO inbox_item_state(source_key,cleared_at) SELECT source_key, ? FROM inbox_items WHERE kind='routine.run' AND CAST(substr(message_id,4) AS INTEGER) % 10 = 1 ON CONFLICT(source_key) DO UPDATE SET cleared_at=excluded.cleared_at`).run(NOW);
      bumpMessagesVersion();
      const owner = ownerOf(groups), companion = companionOf(groups);
      inScope(db, owner, 2_000);
      inScope(db, companion, 1);
      const groupCount = (db.prepare(`SELECT COUNT(*) AS n FROM (${CORRECTION_SQL})`).get() as { n: number }).n;
      results[`G1k.groups.${k}`] = groupCount;
      expect(groupCount).toBeGreaterThanOrEqual(Math.min(k, groups));
      const read = measure(`G1k.read.${k}`, () => correctionRead(db));
      if (readLimit[k] !== undefined) expect.soft(read.p95, `G1k read p95 at k=${k}`).toBeLessThanOrEqual(readLimit[k]);
      if (jsFilter) {
        jsFilter(db, owner, NOW); // fill the shared read once
        const own = measure(`G1k.filter.owner.${k}`, () => jsFilter(db, owner, NOW));
        const comp = measure(`G1k.filter.companion.${k}`, () => jsFilter(db, companion, NOW));
        if (filterLimit[k] !== undefined) { expect.soft(own.p95).toBeLessThanOrEqual(filterLimit[k]); expect.soft(comp.p95).toBeLessThanOrEqual(filterLimit[k]); }
      }
      for (const view of ["decisions", "questions"] as const) {
        for (const includeSnoozed of [false, true]) {
          const name = `G1k.page.${view}.${includeSnoozed ? "v" : "l"}.${k}`;
          measure(name, miss(() => listInboxCached(db, { view, pageSize: 25, includeSnoozed }, owner, NOW)));
          if (pagePlus[k] !== undefined) withinBaseline(name, pagePlus[k]);
          // every answer equals the oracle (which reads the messages table each call: checked where it is quick)
          if (corrected && k <= 500) expect(shape(listInbox(db, { view, pageSize: 25, includeSnoozed }, owner, NOW))).toEqual(shape(oracle.listInbox(db, { view, pageSize: 25, includeSnoozed }, owner, NOW)));
        }
      }
      // no run on a card is ever on these pages (all k sit before the first card in index order)
      if (corrected) for (const view of ["decisions", "questions"] as const) expect(listInbox(db, { view, pageSize: 25, includeSnoozed: true }, owner, NOW).items.every(item => item.kind !== "routine")).toBe(true);
      db.close();
    }
  }, 1_800_000);

  it("G2: history adds nothing to the walk (OWED_ALL fixed at 2,000)", () => {
    const db = fileDb();
    filler(db, 0, 200_000);
    cards(db, 0, 1_950);
    runs(db, 0, 50, 10);
    const before = population(db);
    expect(before.walked).toBe(before.owedOpen);
    expect(before.walked).toBe(2_000);
    const timeBefore = measure("G2.read.before", () => correctionRead(db));
    // diagnostic only (not a gate): the index walk alone, no table lookups, before and after
    const walkOnly = () => db.prepare("SELECT COUNT(*) FROM inbox_items INDEXED BY inbox_items_v_decisions_4 WHERE expired=0 AND decision=1").get();
    measure("G2.walkOnly.before", walkOnly);
    history(db, "completed", 0, 50_000);
    history(db, "resolved", 0, 50_000);
    history(db, "expired", 0, 20_000);
    history(db, "completed", 50_000, 55_000);
    db.prepare("INSERT INTO inbox_item_state(source_key,cleared_at) SELECT source_key, ? FROM inbox_items WHERE kind='routine.run' AND message_id LIKE 'hd%' AND CAST(substr(message_id,3) AS INTEGER) BETWEEN 50000 AND 54999").run(NOW);
    const after = population(db);
    results["G2.population"] = { before, after };
    expect(after).toEqual(before);
    measure("G2.walkOnly.after", walkOnly);
    results["G2.inboxItems.after"] = (db.prepare("SELECT COUNT(*) AS n FROM inbox_items").get() as { n: number }).n;
    const timeAfter = measure("G2.read.after", () => correctionRead(db));
    // G2 TIMING IS REPORT-ONLY. MurageMain ruled the 1.24x result (0.280 to 0.347 ms, limit 1.2x)
    // waived, 2026-10-30, design section 7: the index walk stays flat at 0.054 ms, so walked entries
    // do not grow with history, which is what this gate is for. Rows looked up per entry cost a little
    // more as inbox_items grows. The population check above stays binding; the 1.2x limit stays stated.
    results["G2.timing"] = { limit: 1.2, ratio: timeAfter.p95 / timeBefore.p95, reportOnly: true, ruling: "NEEDS-YOU-COUNT-1012 section 7" };
  }, 900_000);

  it.runIf(corrected)("G3: one shared read per version, whatever the scope, view or page; every answer equals the oracle", () => {
    const raw = fileDb();
    cards(raw, 0, 1_950);
    runs(raw, 0, 50, 10);
    const owner = ownerOf(10);
    inScope(raw, owner, 1_950);
    inScope(raw, companionOf(10), 195);
    // 10 scopes: the owner, the companion (1,800 of 2,000 owed rows outside it) and 8 slices
    const scopes: inbox.InboxAccess[] = [owner, companionOf(10), ...Array.from({ length: 8 }, (_, s) => ({ owner: true, threads: owner.threads.filter((_, i) => i % 8 === s) }))];
    let reads = 0;
    const db = new Proxy(raw, { get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => { if (sql.includes("inbox_items_v_decisions_4") && sql.includes("GROUP BY thread_id, live, snoozed_until")) reads++; return target.prepare(sql); };
    } });
    raw.prepare(`${ins} VALUES('c0','write',?, 'bot','text',NULL,json_object('id','write','at',?,'role','bot','kind','text','text','one write'))`).run(NOW, NOW);
    bumpMessagesVersion();
    const views = ["decisions", "questions", "all", "routines"] as const;
    for (const access of scopes) for (const view of views) for (const page of [0, 1, 2]) {
      const query: InboxQuery = { view, page, pageSize: 20 };
      expect(shape(listInboxCached(db, query, access, NOW))).toEqual(shape(oracle.listInbox(raw, query, access, NOW)));
    }
    for (const access of scopes) owedThreadsCached(db, access);
    results["G3.reads"] = reads;
    expect(reads).toBe(1);
  }, 900_000);

  it.runIf(corrected)("G4: repeated invalidation costs one read per write", () => {
    const raw = fileDb();
    cards(raw, 0, 1_950);
    runs(raw, 0, 50, 10);
    const owner = ownerOf(10), companion = companionOf(10);
    inScope(raw, owner, 1_950);
    inScope(raw, companion, 195);
    let reads = 0, spent = 0;
    const db = new Proxy(raw, { get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("GROUP BY thread_id, live, snoozed_until")) return statement;
        return { all: (...args: never[]) => { reads++; const t = performance.now(); const out = statement.all(...args); spent += performance.now() - t; return out; } };
      };
    } });
    const append = raw.prepare(`${ins} VALUES('c1',?,?,'user','text',NULL,json_object('id',?,'at',?,'role','user','kind','text','text','hi'))`);
    for (let round = 0; round < 1_000; round++) {
      append.run(`w${round}`, NOW + round, `w${round}`, NOW + round);
      bumpMessagesVersion();
      listInboxCached(db, { view: "decisions" }, owner, NOW);
      listInboxCached(db, { view: "decisions" }, companion, NOW);
      listInboxCached(db, { view: "decisions", pageSize: 5 }, owner, NOW); // the tray
      owedThreadsCached(db, owner);
    }
    results["G4"] = { reads, spentMs: spent };
    expect(reads).toBe(1_000);
    const g1 = results["G1.read.2000"] as { p95: number } | undefined;
    if (g1) expect(spent).toBeLessThanOrEqual(1_000 * g1.p95 * 1.1);
  }, 900_000);

  it("G5: the poll, the page and the sweep stay as fast as 1.0.10 (OWED_ALL 2,000)", () => {
    const db = fileDb();
    filler(db, 0, 200_000);
    cards(db, 0, 1_950);
    runs(db, 0, 50, 10);
    const owner = ownerOf(10);
    inScope(db, owner, 1_950);
    measure("G5.decisions.miss", miss(() => listInboxCached(db, { view: "decisions" }, owner, NOW)));
    measure("G5.questions.page0", miss(() => listInboxCached(db, { view: "questions", page: 0, pageSize: 20 }, owner, NOW)));
    measure("G5.questions.page40", miss(() => listInboxCached(db, { view: "questions", page: 40, pageSize: 20 }, owner, NOW)));
    measure("G5.owedThreads.miss", miss(() => owedThreadsCached(db, owner)));
    const q0 = listInbox(db, { view: "questions", page: 0, pageSize: 20 }, owner, NOW);
    results["G5.questions.total"] = q0.total;
    results["G5.diagnostic"] = { preparing: q0.preparing === true, questionsBadge: q0.questions, decisionsBadge: q0.decisions,
      lQuestions: (db.prepare("SELECT COALESCE(SUM(l_questions),0) AS n FROM inbox_counts").get() as { n: number }).n,
      items: (db.prepare("SELECT segment, COUNT(*) AS n FROM inbox_items GROUP BY segment").all() as Array<{ segment: string; n: number }>) };
    expect(listInbox(db, { view: "questions", page: 40, pageSize: 20 }, owner, NOW).items.length, `questions total ${q0.total}`).toBeGreaterThan(0);
    for (const name of ["G5.decisions.miss", "G5.questions.page0", "G5.questions.page40", "G5.owedThreads.miss"]) withinBaseline(name, 1);
  }, 900_000);
});
