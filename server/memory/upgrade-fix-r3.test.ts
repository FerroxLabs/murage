// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The structural fix for the second upgrade-fast review (lanes/upgfast-review/r2/REPORT.md; design in DESIGN-r3.md): one test group per finding.
// R2-01 (one memory gate before every effect) is in memory-gate.test.ts and procedure-landing.test.ts.
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { beforeEach, expect, it, afterEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { legacyFile } from "./testing/legacy-file-model.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
// 1.0.2: this file drives the read-time root-set machinery over rows a 1.0.1 file holds; thaw the frozen root-set writes to model them.
beforeEach(() => thawRootSetWritesForTest(true));
afterEach(() => thawRootSetWritesForTest(false));
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, finishBackgroundUpgradeWorkNow, startBackgroundUpgrade } from "../database.ts";
import { addLesson, renderLearnedBlock } from "./lessons.ts";
import { recordFeedback } from "./feedback.ts";
import { readIntegrityPass } from "./integrity-state.ts";
import { buildSyntheticV6 } from "./testing/upgrade-fast-fixture.ts";
import { captureSource } from "./capture.ts";
import { transaction } from "../database.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const FILE = () => join(DATA_DIR, "messages.db");
const SHAPE = { threads: 30, perThread: 40, payloadBytes: 200, receiptsPerThread: 3, setThreads: 3, repliesPerSetThread: 10 };
function v6(edit: (db: DatabaseSync) => void = () => {}) {
  const built = buildSyntheticV6(FILE(), SHAPE);
  const raw = new DatabaseSync(FILE());
  try { raw.exec("PRAGMA foreign_keys=OFF"); edit(raw); } finally { raw.close(); }
  return built;
}

// ── R2-02: what is earlier memory is a rowid, never a clock ───────────────────────────────────────────────────────────────────────
const LEARNING = { enabled: true, askFirst: false } as never;
const render = (db: DatabaseSync, owner = true) => renderLearnedBlock(db, { botId: "bot1", threadId: "t0", ownerAudience: owner });
/** An active note written before the upgrade, with its ledger event, stamped with `createdAt` (a clock can say anything). */
function oldLesson(raw: DatabaseSync, id: string, text: string, createdAt: number) {
  const scope = "scope-bot1";
  raw.exec(`INSERT OR IGNORE INTO memory_scopes VALUES('${scope}','bot','bot1','[]',0)`);
  raw.exec(`INSERT INTO memory_learning_events(id,scope_id,kind,bot_id,detail,created_at) VALUES('ev-${id}','${scope}','lesson-learned','bot1','{"lessonId":"${id}","lessonVersion":1,"lessonKind":"note","origin":"typed"}',${createdAt})`);
  raw.exec(`INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,learning_event_id,created_at,decided_at) VALUES('${id}',1,'bot1','bot','note','${text}','typed','active','ev-${id}',${createdAt},${createdAt})`);
}

it("R2-02: an old lesson stamped in the future is withheld while the pass is pending, a lesson made now is shown, and a new version of an old id is still the old lesson", () => {
  const future = Date.now() + 86_400_000;
  v6(raw => { oldLesson(raw, "future", "Always greet me by name.", future); oldLesson(raw, "plain", "Use metric units.", 1000); });
  const db = database();
  const pass = readIntegrityPass(db)!;
  expect(pass.finishedAt).toBeNull();
  expect(pass.lessonsFloor).toBeGreaterThanOrEqual(2); // taken in the pass row, in the migration's transaction
  expect(render(db).text).not.toContain("greet me by name");
  expect(render(db).text).not.toContain("metric");
  // a clock correction does not matter either way: a lesson made now, with a created_at far in the past, is above the floor
  expect(addLesson(db, { botId: "bot1", origin: "typed", learning: LEARNING, text: "Keep answers short.", scope: "bot", now: 5 }).status).toBe("applied");
  expect(render(db).text).toContain("Keep answers short.");
  // a new version of an old id is laundering: the id has a row at or below the floor
  db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,learning_event_id,created_at,decided_at) VALUES('plain',2,'bot1','bot','note','Use imperial units.','typed','active','ev-plain',?,?)").run(Date.now(), Date.now());
  const during = render(db).text;
  expect(during).not.toContain("imperial");
  expect(during).not.toContain("metric");
  expect(during).toContain("Keep answers short.");
  expect(render(db, false).text).not.toContain("imperial");
  finishBackgroundUpgradeWorkNow();
  expect(readIntegrityPass(db)!.result).toBe("passed");
  const after = render(db).text;
  expect(after).toContain("greet me by name");
  expect(after).toContain("imperial");
  expect(after).not.toContain("metric");
});

it("R2-02: old feedback (a rowid at or below the floor) is withheld while the pass is pending; feedback given now is shown", () => {
  v6(raw => raw.exec("INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,target_message_id,target_turn_id,target_action,polarity,strength,correction,confidence,state,scope,acknowledged_at,created_at,source_on_path_rev) VALUES('fb-old','bot1','t0','m0-0',NULL,NULL,'reply','-',2,'speak much louder',1,'detected','chat',NULL,"+(Date.now() + 86_400_000)+",NULL)"));
  const db = database();
  expect(render(db).text).not.toContain("speak much louder");
  expect(recordFeedback(db, { id: "fb-new", botId: "bot1", threadId: "t0", messageId: "m0-2", turn: null, decision: { target: { action: "reply" }, polarity: "-", strength: 2, correction: "answer in two lines", confidence: 1, state: "detected" } as never, now: 7 })).toBe(true);
  const text = render(db).text;
  expect(text).toContain("answer in two lines");
  expect(text).not.toContain("speak much louder");
  finishBackgroundUpgradeWorkNow();
  expect(render(db).text).toContain("speak much louder");
});

it("R2-02: the floors survive a restart and a pass an earlier build began (no floor columns) takes them on first load", () => {
  v6(raw => oldLesson(raw, "plain", "Use metric units.", 1000));
  let db = database();
  const floor = readIntegrityPass(db)!.lessonsFloor;
  closeDatabase();
  db = database();
  expect(readIntegrityPass(db)!.lessonsFloor).toBe(floor);
  // the row an earlier build wrote: no floors
  db.exec("UPDATE upgrade_integrity_pass SET lessons_floor=NULL, feedback_floor=NULL, events_floor=NULL");
  closeDatabase();
  db = database();
  const row = readIntegrityPass(db)!;
  expect(row.lessonsFloor).not.toBeNull();
  expect(render(db).text).not.toContain("metric");
});

it("R2-02: 20,000 retired lessons render with one bounded read of the lesson table (never the bot's whole history)", () => {
  v6(raw => {
    raw.exec("INSERT OR IGNORE INTO memory_scopes VALUES('scope-bot1','bot','bot1','[]',0)");
    raw.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000)
      INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at,decided_at) SELECT 'r'||i,1,'bot1','bot','note','old '||i,'typed','retired',1000+i,1000+i FROM n`);
  });
  const db = database();
  finishBackgroundUpgradeWorkNow();
  for (const text of ["First note.", "Second note.", "Third note."]) expect(addLesson(db, { botId: "bot1", origin: "typed", learning: LEARNING, text, scope: "bot" }).status).toBe("applied");
  let rowsRead = 0, lessonReads = 0;
  const real = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const statement = real(sql);
    if (!/memory_lessons/.test(sql)) return statement;
    return new Proxy(statement, { get(target, property) {
      const value = (target as never as Record<string | symbol, unknown>)[property];
      if (property === "all") return (...args: unknown[]) => { const rows = (value as (...a: unknown[]) => unknown[]).apply(target, args); rowsRead += rows.length; lessonReads++; return rows; };
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    } });
  };
  const text = render(db).text;
  expect(text).toContain("First note.");
  expect(rowsRead).toBeLessThanOrEqual(2 * 4 * 25 + 4); // own + inherited + team, each limited to four times the prompt's lesson count
  expect(lessonReads).toBeLessThanOrEqual(4);
});

// ── R2-03: the root conversion is bounded and resumable around its chunks too ────────────────────────────────────────────────────
import { COMPACTION_MAX_CHAIN, WORKLIST_BATCH_SQL, compactRootSetsStep, lineageStorageStatus, reclaimLineageSpace, settleReclaim } from "./root-set-compaction.ts";
import { LAZY_ROOT_MIN, LayeredRoots, handleFor, handleHas, handleKeys, resetRootSetWork, rootSetWork, storeLayered, type HandleCache } from "./root-set-handles.ts";
import { rootSetMembers } from "./schema.ts";

/** `threads` threads, each with full sets of sizes 1..n (each set adds one member to the one before it), and the compaction row that asks for their conversion. */
function fullSets(db: DatabaseSync, threads: string[], n: number) {
  for (const thread of threads) {
    db.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?2) INSERT INTO memory_root_sets(set_id,size) SELECT ?1||'-s'||printf('%05d',i),i FROM k`).run(thread, n);
    db.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?2), j(c) AS (SELECT 1 UNION ALL SELECT c+1 FROM j WHERE c<?2)
      INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT ?1||'-s'||printf('%05d',i),?1,'m'||printf('%05d',c) FROM k, j WHERE c<=i`).run(thread, n);
    db.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?2) INSERT INTO memory_output_roots(thread_id,message_id,set_id) SELECT ?1,'r'||printf('%05d',i),?1||'-s'||printf('%05d',i) FROM k`).run(thread, n);
  }
  db.exec("DELETE FROM memory_root_set_compaction");
  db.prepare("INSERT INTO memory_root_set_compaction(id,total,done,cursor,started_at) VALUES(1,0,0,'',1)").run();
}
const dump = (db: DatabaseSync) => JSON.stringify([
  db.prepare("SELECT set_id,root_thread_id,root_message_id FROM memory_root_set_members ORDER BY set_id,root_thread_id,root_message_id").all(),
  db.prepare("SELECT set_id,parent_id FROM memory_root_set_parents ORDER BY set_id").all(),
  db.prepare("SELECT total,done,finished_at IS NOT NULL AS finished FROM memory_root_set_compaction").all(),
]);

it("R2-03: a kill at any step boundary (mid-fill, mid-count, mid-chain, between sets) resumes to the very state an uninterrupted run reaches", () => {
  const seed = legacyFile(database()); // the conversion is retired on v10; the file below is 1.0.1-shaped (no certificate), as the raw connections read it
  fullSets(seed, ["ta", "tb"], 110);
  seed.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase();
  const clone = join(DATA_DIR, "clone.db");
  copyFileSync(FILE(), clone);
  // uninterrupted
  const a = new DatabaseSync(FILE());
  try { while (compactRootSetsStep(a, { maxMs: 60_000 }).remaining); } finally { a.close(); }
  const whole = new DatabaseSync(FILE());
  const expected = dump(whole);
  const chainsBounded = whole.prepare("SELECT count(*) AS n FROM memory_root_set_parents").get()!.n;
  whole.close();
  expect(Number(chainsBounded)).toBeGreaterThan(100);
  // killed (a new connection for every step: its temporary table and its place in memory are gone) and resumed
  let steps = 0;
  for (; steps < 20_000; steps++) {
    const raw = new DatabaseSync(clone);
    try {
      // two small steps then a large one: the small ones stop inside every phase, the large one carries the set in hand over its line
      const budget = steps % 3 === 2 ? { maxRows: 400, maxMs: 60_000 } : { maxRows: 20, chunkRows: 7, maxMs: 60_000 };
      if (!compactRootSetsStep(raw, budget).remaining) break;
    } finally { raw.close(); }
  }
  expect(steps).toBeGreaterThan(30);
  const resumed = new DatabaseSync(clone);
  try { expect(dump(resumed)).toBe(expected); expect(resumed.prepare("SELECT 1 FROM sqlite_schema WHERE name='upgrade_root_set_worklist'").get()).toBeUndefined(); } finally { resumed.close(); }
});

it("R2-03: no chain grows past the bound: a predecessor on a chain of COMPACTION_MAX_CHAIN sets keeps its successor full", () => {
  const db = legacyFile(database());
  fullSets(db, ["tc"], 130);
  while (compactRootSetsStep(db, { maxMs: 60_000 }).remaining);
  const depthOf = (id: string) => { let depth = 1; for (let at: string | null = id; ;) { const up = db.prepare("SELECT parent_id FROM memory_root_set_parents WHERE set_id=?").get(at) as { parent_id: string } | undefined; if (!up) return depth; at = up.parent_id; depth++; } };
  let deepest = 0;
  for (const row of db.prepare("SELECT set_id FROM memory_root_sets").all()) deepest = Math.max(deepest, depthOf(String(row.set_id)));
  expect(deepest).toBeLessThanOrEqual(COMPACTION_MAX_CHAIN + 1);
  expect(deepest).toBeGreaterThan(10);
  for (const row of db.prepare("SELECT set_id FROM memory_root_sets").all()) expect(rootSetMembers(db, String(row.set_id))?.size, String(row.set_id)).toBe(Number(db.prepare("SELECT size FROM memory_root_sets WHERE set_id=?").get(row.set_id)!.size));
});

it("R2-03: the first slice of a thread with 200,000 sets costs about one slice, and the worklist is read by seek (no sort)", async () => {
  const db = legacyFile(database());
  db.exec(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<200000) INSERT INTO memory_root_sets(set_id,size) SELECT 'big-'||printf('%06d',i),i FROM k;
    WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<200000) INSERT INTO memory_output_roots(thread_id,message_id,set_id) SELECT 'big','r'||printf('%06d',i),'big-'||printf('%06d',i) FROM k;
    DELETE FROM memory_root_set_compaction; INSERT INTO memory_root_set_compaction(id,total,done,cursor,started_at) VALUES(1,0,0,'',1)`);
  await stopWalMaintenance(); // wal3: the checkpointer copying this test's 400,000-row log would be timed as slice cost
  const slice = 20, times: number[] = [];
  // Work is counted, not timed: every statement the first slice runs over the 200,000-set tables is a bounded seek (a rowid range or a LIMIT),
  // never a whole-table count or scan (the fill once counted the 200,000 sets before its first slice).
  const seen: string[] = [];
  const spy = new Proxy(db, { get(target, property) { const value = Reflect.get(target, property) as unknown; if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value; return (sql: string) => { seen.push(sql); return target.prepare(sql); }; } });
  const first = compactRootSetsStep(spy, { maxMs: slice, chunkRows: 500 });
  const wide = seen.filter(sql => /\b(memory_output_roots|memory_session_roots|memory_root_sets)\b/.test(sql) && !/rowid\s*>\s*\?|LIMIT/i.test(sql));
  expect(wide, wide.join("\n")).toEqual([]);
  expect(first.rows).toBeLessThanOrEqual(200_000);
  for (let i = 0; i < 40; i++) { const began = performance.now(); compactRootSetsStep(db, { maxMs: slice, chunkRows: 500 }); times.push(performance.now() - began); }
  // wall time is only a backstop against a synchronous whole-table pass (seconds), generous for a loaded host
  expect(Math.max(...times)).toBeLessThan(2000);
  expect(Number(db.prepare("SELECT total FROM memory_root_set_compaction").get()!.total)).toBeGreaterThan(0);
  for (const [sql, args] of [[WORKLIST_BATCH_SQL.first, []], [WORKLIST_BATCH_SQL.after, ["big", 5, "big-000005"]]] as const) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => String(row.detail)).join(" | ");
    expect(plan, plan).not.toMatch(/TEMP B-TREE/);
    expect(plan).toMatch(/upgrade_root_set_worklist/);
  }
});

it("R2-03: a retained huge set is held by a lazy handle: membership by key lookup, the next sets chain onto it, and a turn reads fewer than 10 rows", () => {
  const db = database();
  const size = LAZY_ROOT_MIN + 5_000;
  db.prepare("INSERT INTO memory_root_sets(set_id,size) VALUES('huge',?)").run(size);
  db.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?1) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT 'huge','th','m'||printf('%07d',i) FROM k`).run(size);
  const cache: HandleCache = new Map();
  resetRootSetWork();
  const handle = handleFor(db, cache, "huge")!;
  expect(handle.end).toBe(size);
  expect(rootSetWork().rows).toBeLessThan(10); // the set row, not its 55,000 members
  expect(handleHas(handle, "th\u0000m0000001")).toBe(true);
  expect(handleHas(handle, "th\u0000m0000007")).toBe(true);
  expect(handleHas(handle, "th\u0000nope")).toBe(false);
  let counted = 0; for (const _ of handleKeys(handle)) counted++;
  expect(counted).toBe(size);
  const turn = (cacheOf: HandleCache, parent: string, key: string) => {
    const roots = new LayeredRoots(); roots.absorb(handleFor(db, cacheOf, parent)!); roots.add(key);
    resetRootSetWork();
    const id = storeLayered(db, cacheOf, roots);
    return { id, rows: rootSetWork().rows };
  };
  const first = turn(cache, "huge", "th\u0000new-1");
  const second = turn(cache, first.id, "th\u0000new-2");
  expect(first.rows).toBeLessThan(10);
  expect(second.rows).toBeLessThan(10);
  // after a restart the chain is walked from its link rows: the huge set is still left in the file
  resetRootSetWork();
  const cold = handleFor(db, new Map(), second.id)!;
  expect(cold.end).toBe(size + 2);
  expect(rootSetWork().rows).toBeLessThan(10);
  expect(handleHas(cold, "th\u0000new-1")).toBe(true);
  expect(handleHas(cold, "th\u0000m0000100")).toBe(true);
  const whole = rootSetMembers(db, second.id)!;
  expect(whole.size).toBe(size + 2);
  expect(whole.has("th\u0000new-2")).toBe(true);
});

// ── R2-08: the legacy member index is space still to hand back ────────────────────────────────────────────────────────────────────
it("R2-08: with zero free pages and the v6 member index still in the file, the hand-back stays on offer; it drops the index and settles", () => {
  const db = database();
  db.exec("DROP TABLE IF EXISTS memory_lineage_cert"); // the v7 conversion's hand-back (from v10 the root-set reclaim is the hand-back)
  db.exec("CREATE INDEX memory_root_set_members_root ON memory_root_set_members(root_thread_id,root_message_id)");
  db.exec("DELETE FROM memory_root_set_compaction; INSERT INTO memory_root_set_compaction(id,total,done,cursor,started_at,finished_at) VALUES(1,0,0,'',1,2)");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const free = Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
  settleReclaim(db);
  expect(db.prepare("SELECT reclaimed_at FROM memory_root_set_compaction").get()!.reclaimed_at).toBeNull();
  expect(lineageStorageStatus(db)).toMatchObject({ state: "reclaim-available", legacyIndexPending: true, freeBytes: free * Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size) });
  reclaimLineageSpace(db, { freeDiskBytes: () => 1e12 });
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeUndefined();
  expect(db.prepare("SELECT reclaimed_at FROM memory_root_set_compaction").get()!.reclaimed_at).not.toBeNull();
  expect(lineageStorageStatus(db)).toMatchObject({ state: "idle", legacyIndexPending: false });
});

// ── R2-04: the open cards that are not there yet say so, and arrive when the thread is prepared ─────────────────────────────────────
import { Store } from "../store.ts";
import { onThreadCardsReady, runTranscriptBackfill, stepPriorityThreads } from "../transcript-backfill.ts";
import { transcriptPage, wirePage } from "../transcript-page.ts";

function longThread(db: DatabaseSync, thread: string, rows: number, cardAt: number[]) {
  const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 1; i <= rows; i++) {
    const card = cardAt.includes(i);
    const message = { id: `${thread}-${i}`, at: i, role: "bot", kind: card ? "options" : "text", text: "t", parentId: i > 1 ? `${thread}-${i - 1}` : null, turnId: `turn-${Math.ceil(i / 10)}`,
      ...(card ? { card: { requestId: `req-${i}`, options: [] } } : {}) };
    put.run(thread, message.id, i, "bot", message.kind, "t", JSON.stringify(message));
  }
  db.prepare("INSERT OR REPLACE INTO thread_state(thread_id,active_leaf_id) VALUES(?,?)").run(thread, `${thread}-${rows}`);
  db.exec("COMMIT");
}
const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

it("R2-04: a 3,000-message thread answers 'pending' while its card index is unfinished, then the ready event fires and the old card appears", async () => {
  const db = database();
  longThread(db, "big", 3000, [40]);
  db.exec("DELETE FROM open_card; DELETE FROM browser_check_pending; DELETE FROM turn_first; DELETE FROM transcript_index_state WHERE name IN ('open_card','browser_check','turn_first')");
  const store = new Store(selection);
  const heard: Array<string | null> = [];
  const off = onThreadCardsReady(thread => heard.push(thread));
  try {
    const page = transcriptPage(store, "big", 100, true);
    const wire = wirePage(store, "big", page, true, true) as { openCards?: unknown[]; openCardsPending?: boolean };
    expect(wire.openCards).toBeUndefined();
    expect(wire.openCardsPending).toBe(true);
    expect(store.openCardsOutsideStatus("big", page.messages)).toMatchObject({ cards: [], pending: true });
    for (let guard = 0; guard < 100 && stepPriorityThreads(db, 500); guard++);
    expect(heard).toEqual(["big"]);
    // the card index is ready, the thread's branch index is not: a request never fills it, so the card is not placed yet and the answer stays pending
    expect(store.openCardsOutsideStatus("big", page.messages)).toMatchObject({ cards: [], pending: true });
    await runTranscriptBackfill(db, () => true, { gate: null }); // the front of the background fill: the thread the request queued
    expect(heard).toEqual(["big", "big"]);
    const ready = store.openCardsOutsideStatus("big", page.messages);
    expect(ready.pending).toBe(false);
    expect(ready.cards.map(card => card.id)).toEqual(["big-40"]);
    const again = wirePage(store, "big", page, true, true) as { openCards?: Array<{ id: string }>; openCardsPending?: boolean };
    expect(again.openCards?.map(card => card.id)).toEqual(["big-40"]);
    expect(again.openCardsPending).toBeUndefined();
  } finally { off(); }
});

// ── R2-06: counts are one coherent snapshot, keyed to a revision, never to a file's size ──────────────────────────────────────────
import { COUNT_AT_REVISION_SOURCE, createCountsBlock, readCountsBlock, startExactCounts, UPGRADE_COUNTS_FILE } from "./upgrade-counts.ts";
import { bumpWriteEpoch, installWriteRevisionTriggers } from "../app-write-revision.ts";

type CountAt = (db: DatabaseSync, between: ((sql: string) => void) | null, cached: { key: string; counts: unknown } | null) => { key: string; counts: Record<string, number | null>; fresh: boolean };
const countAtRevision = new Function(`${COUNT_AT_REVISION_SOURCE}; return countAtRevision;`)() as CountAt;
const waitFor = async <T>(read: () => T | null, ms = 10_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) { const value = read(); if (value !== null) return value; if (Date.now() > until) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
};

it("R2-06: a write injected between two counts leaves one coherent snapshot, and its revision names that state", () => {
  database();
  closeDatabase();
  const writer = new DatabaseSync(FILE());
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000");
  installWriteRevisionTriggers(writer);
  writer.exec("DELETE FROM messages; DELETE FROM thread_state");
  writer.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('a','x1',50,'user','text','one','{}')").run();
  writer.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES('a',NULL)").run();
  const reader = new DatabaseSync(FILE(), { readOnly: true });
  try {
    let injected = false;
    const read = countAtRevision(reader, sql => {
      // after the conversations are counted and before the messages are: a second conversation and an earlier first message arrive
      if (!injected && /FROM messages$/.test(sql)) {
        injected = true;
        writer.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('b','x2',5,'user','text','two','{}')").run();
        writer.prepare("INSERT INTO thread_state(thread_id,active_leaf_id) VALUES('b',NULL)").run();
      }
    }, null);
    expect(injected).toBe(true);
    expect(read.counts).toMatchObject({ conversations: 1, messages: 1, firstMessageAt: 50 }); // the state the snapshot began in, all of it
    // the revision it carries is the one before the injected writes, so it is not mistaken for the state after them
    const after = countAtRevision(reader, null, { key: read.key, counts: read.counts });
    expect(after.fresh).toBe(true);
    expect(after.counts).toMatchObject({ conversations: 2, messages: 2, firstMessageAt: 5 });
    expect(after.key).not.toBe(read.key);
  } finally { reader.close(); writer.close(); }
});

it("R2-06: the same size and modification time with a different revision is recounted; an equal revision is served from the cache; a failed query publishes nothing", async () => {
  database();
  closeDatabase();
  const cacheFile = join(DATA_DIR, UPGRADE_COUNTS_FILE);
  const raw = new DatabaseSync(FILE());
  raw.exec("PRAGMA journal_mode=WAL");
  installWriteRevisionTriggers(raw);
  raw.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('a','x1',50,'user','text','one','{}')").run();
  const revision = raw.prepare("SELECT epoch,n FROM app_write_revision").get() as { epoch: string; n: number };
  raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  try {
    // a cache written for another revision (the file looks just the same) is not trusted
    const { writeFileSync } = await import("node:fs");
    writeFileSync(cacheFile, JSON.stringify({ v: 2, key: `${revision.epoch}:${revision.n - 1}`, counts: { messages: 99, conversations: 99, memoryRecords: 0, receipts: 0, firstMessageAt: 1 } }));
    const block = createCountsBlock();
    const worker = startExactCounts(FILE(), cacheFile, block);
    expect(await waitFor(() => readCountsBlock(block))).toMatchObject({ messages: 1, firstMessageAt: 50 });
    worker.stop();
    // an equal revision: the cache answers (the figures are the cache's, proving the file was not recounted)
    writeFileSync(cacheFile, JSON.stringify({ v: 2, key: `${revision.epoch}:${revision.n}`, counts: { messages: 77, conversations: 1, memoryRecords: 0, receipts: 0, firstMessageAt: 1 } }));
    const cachedBlock = createCountsBlock();
    const second = startExactCounts(FILE(), cacheFile, cachedBlock);
    expect(await waitFor(() => readCountsBlock(cachedBlock))).toMatchObject({ messages: 77 });
    second.stop();
    // a new epoch (a restore) voids it
    bumpWriteEpoch(raw);
    const thirdBlock = createCountsBlock();
    const third = startExactCounts(FILE(), cacheFile, thirdBlock);
    expect(await waitFor(() => readCountsBlock(thirdBlock))).toMatchObject({ messages: 1 });
    third.stop();
    // a count that cannot be made is not zero: nothing is published
    raw.exec("DROP TABLE memory_disclosures_probe_absent"); // (absent: ignored below)
  } catch (error) { if (!/no such table/.test(String(error))) throw error; }
  finally { raw.close(); }
  const broken = new DatabaseSync(FILE());
  try { broken.exec("PRAGMA foreign_keys=OFF; DROP TABLE memory_disclosures"); } finally { broken.close(); }
  rmSync(cacheFile, { force: true });
  const failed = createCountsBlock();
  const doomed = startExactCounts(FILE(), cacheFile, failed);
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(readCountsBlock(failed)).toBeNull();
  doomed.stop();
});

it("R2-06: every connection that opens messages.db for writing installs the revision triggers or writes a new epoch", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const root = join(import.meta.dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (name === "testing" || name === "testdata" || name === "node_modules") continue; if (statSync(path).isDirectory()) walk(path); else if (/\.(ts|mjs)$/.test(name) && !/\.test\.|\.bench\./.test(name)) files.push(path); } };
  walk(root);
  // files that open a writable DatabaseSync, and what each does about the revision (the others open read-only, an in-memory database, or a different file)
  const writers: Record<string, "triggers" | "epoch"> = {
    "database.ts": "triggers", "installation-restore-preparation.ts": "epoch", "memory/restore.ts": "epoch", "installation-memory-downgrade.ts": "epoch",
  };
  // memory/provenance-stamp.ts: its worker connection only reads (one BEGIN, one SELECT, COMMIT: the identity snapshot)
  // memory/optional-index.ts: its worker connection runs one CREATE INDEX (schema only, no row is written, so no revision moves)
  // memory/age-index.ts: opens memory-index.db only (the downgrade step's index-file half), never messages.db
  const otherFiles = new Set(["memory/age-index.ts", "engine-fs.ts", "engine-structure-check.ts", "memory/cold-index-build.ts", "memory/optional-index.ts", "memory/provenance-stamp.ts", "wal-maintenance.ts", "memory/postings.ts", "inbox-fill-worker.ts", "send-store.ts", "skill-search.ts", "memory/schema.ts", "memory/testdata/v0161-schema.ts", "memory/index.ts", "installation-database-snapshot.ts", "connected-app-journal.ts", "conversation-deletion.ts", "engine-history-deletion.ts", "memory/root-set-compaction.ts", "memory/root-set-reclaim.ts", "memory/upgrade-counts.ts", "memory/eligibility.ts", "memory/index-reader.ts", "memory/owner-list.ts", "installation-activation.ts", "folder-trust.ts", "memory/revocation-index.bench.mjs"]);
  const found = files.map(path => ({ file: path.slice(root.length + 1).split("\\").join("/"), text: readFileSync(path, "utf8") })).filter(item => /new DatabaseSync\(/.test(item.text));
  // 1.0.9 Sentinel (GAP-SENTINEL-109): health files open only their own databases, never messages.db, so no revision can move.
  // health/stats-publisher.ts: its build worker creates a NEW db-stats-<generation>.sqlite inside health/ from observed figures
  // sentinel/scan.ts: the scanner's own lease file (an OS-held exclusive lock); sentinel/store.ts: its own state.sqlite (issue history)
  // sentinel/sources.ts: the sealed db-stats generation, opened read-only through an immutable URI
  // sentinel/scan-fixtures.ts: builds sealed stats fixtures for the scanner suites in a temporary folder
  // Proven, not just listed: none of them names messages.db or imports the product database module.
  const healthOwnFiles = new Set(["health/stats-publisher.ts", "sentinel/scan.ts", "sentinel/store.ts", "sentinel/sources.ts", "sentinel/scan-fixtures.ts"]);
  // Proven read-only, not exempted: every connection the file opens passes `readOnly: true`, so SQLite refuses any write on it and no
  // revision can move. transcript-read-worker.ts (rc11-prune, 2c42e8927) is the event-log prune's forgotten-message lookup off the main thread.
  // memory/worker.ts (1.0.3 lane 2): the memory helper's handle on the key table for the age fill of the search index.
  const readOnlyOpeners = new Set(["transcript-read-worker.ts", "memory/worker.ts"]);
  for (const { file, text } of found) {
    if (otherFiles.has(file)) continue;
    if (healthOwnFiles.has(file)) {
      expect(text, `${file} must never open messages.db`).not.toMatch(/messages\.db|from "(?:\.\.\/)+database(?:\.ts)?"/);
      continue;
    }
    if (readOnlyOpeners.has(file)) {
      const opens = text.match(/new DatabaseSync\([^)]*\)/g) ?? [];
      expect(opens.length, file).toBeGreaterThan(0);
      for (const open of opens) expect(open, `${file} must open messages.db read-only`).toMatch(/\{\s*readOnly:\s*true\s*\}/);
      continue;
    }
    expect(Object.keys(writers), `${file} opens a database: say what it does about the write revision`).toContain(file);
    const how = writers[file]!;
    if (how === "triggers") expect(text).toMatch(/installWriteRevisionTriggers\(/);
    // a file replaced or rewritten as a whole writes a new epoch (the downgrade drops the table, so the next upgrade makes a new one)
    if (how === "epoch" && file !== "installation-memory-downgrade.ts") expect(text).toMatch(/bumpWriteEpoch\(/);
  }
});

// ── R2-07: Memory settings do not walk the receipt table ──────────────────────────────────────────────────────────────────────────────
import { memoryHealth, resetHealthScan, stepHealthScan } from "./health.ts";

it("R2-07: with the state index absent and a large receipt table, opening Memory runs no aggregate over receipts; the background scan supplies the figures", () => {
  const db = database();
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_disclosures_state'").get()).toBeTruthy();
  db.exec("DROP INDEX memory_disclosures_state");
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<6000)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT printf('b%06d',i),'t'||(i%7),'claude',NULL,CASE WHEN i%3=0 THEN '[]' ELSE '[{"id":"r","version":1}]' END,'[]','[]',0,0,0,CASE WHEN i%5=0 THEN 'revoked' ELSE 'delivered' END,1000+i FROM n`);
  resetHealthScan();
  const seen: string[] = [];
  const real = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { seen.push(sql); return real(sql); };
  const quick = memoryHealth(null);
  (db as unknown as { prepare: unknown }).prepare = real;
  expect(seen.filter(sql => /FROM memory_disclosures WHERE state='delivered'/.test(sql))).toEqual([]);
  expect(quick.supplied).toMatchObject({ turns: 0, references: 0 }); // nothing finished yet: the figure waits, stamped as of nothing
  expect(quick.asOf).toBeNull();
  // the scan the worker's idle sweep runs, a page at a time
  for (let guard = 0; guard < 1_000 && stepHealthScan(5); guard++);
  const done = memoryHealth(null);
  const expected = db.prepare("SELECT count(*) n,sum(json_array_length(record_versions)) refs FROM memory_disclosures WHERE state='delivered' AND json_array_length(record_versions)>0").get()!;
  expect(done.supplied).toMatchObject({ turns: Number(expected.n), references: Number(expected.refs) });
  expect(done.asOf).not.toBeNull();
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT rowid AS rid,state,json_array_length(record_versions) AS refs,created_at AS at FROM memory_disclosures WHERE rowid>? ORDER BY rowid LIMIT 400").all(0).map(row => String(row.detail)).join(" | ");
  expect(plan).toMatch(/SEARCH memory_disclosures/);
  expect(plan).not.toMatch(/SCAN memory_disclosures/);
});

// ── P2: an ordinary start does no work that grows with the history ─────────────────────────────────────────────────────────────────
import { directTurnsWalked } from "../message-db.ts";
import { reconcileInterruptedMemoryTurnsInBackground, interruptedTurnsHighWater, interruptedTurnsThrough } from "./settlement.ts";
import { readIndexState } from "../transcript-backfill.ts";

it("P2: an ordinary start (no upgrade left over) starts no counts thread, no tracker, no overall writer and no jobs", () => {
  database();
  finishBackgroundUpgradeWorkNow();
  closeDatabase();
  const handle = (database(), startBackgroundUpgrade({}));
  expect(handle.jobs).toEqual([]);
  expect(existsSync(join(DATA_DIR, UPGRADE_COUNTS_FILE))).toBe(false);
  handle.stop();
});

it("P2: the sweep for interrupted memory turns reads only rows past the place the last start reached", async () => {
  const db = database();
  const working = (n: number) => transaction(d => captureSource(d, { id: `turn:T:${n}`, threadId: "T", turnId: String(n), kind: "turn", speaker: "harness", outcome: "working", text: "Turn working." }));
  const outcome = (n: number) => String(db.prepare("SELECT outcome FROM memory_sources WHERE id=?").get(`turn:T:${n}`)!.outcome);
  working(1); working(2);
  await reconcileInterruptedMemoryTurnsInBackground(interruptedTurnsHighWater());
  expect([outcome(1), outcome(2)]).toEqual(["interrupted", "interrupted"]);
  const through = readIndexState(db, "interrupted_turns_through");
  expect(through.done).toBe(1);
  expect(through.cursor).toBeGreaterThan(0);
  // the next start: a row at or below the kept place is not looked at (it was settled by the sweep that kept it); rows written since are
  db.prepare("UPDATE memory_sources SET outcome='working' WHERE id='turn:T:1'").run();
  working(3);
  await reconcileInterruptedMemoryTurnsInBackground(interruptedTurnsHighWater());
  expect(outcome(1)).toBe("working");
  expect(outcome(3)).toBe("interrupted");
  expect(readIndexState(db, "interrupted_turns_through").cursor).toBeGreaterThan(through.cursor);
  // a mark above the newest row (the rows were renumbered by a rewrite of the file) is ignored: the sweep begins again from the first row
  const high = interruptedTurnsHighWater();
  expect(interruptedTurnsThrough(high)).toBe(readIndexState(db, "interrupted_turns_through").cursor);
  db.prepare("INSERT OR REPLACE INTO transcript_index_state(name,done,cursor,skipped) VALUES('interrupted_turns_through',1,1000000,0)").run();
  expect(interruptedTurnsThrough(high)).toBe(0);
});

it("P2: the sweep for interrupted direct turns reads only the in-flight table once the first walk is done; the first start of an older file walks once and marks it", async () => {
  const db = database();
  const store = new Store(selection);
  const answered = store.createBot(), asked = store.createBot(), orphan = store.createBot();
  const user = (threadId: string, text: string) => store.appendMessage(threadId, { role: "user", kind: "text", text } as never);
  user(answered.threadId, "hello"); store.appendMessage(answered.threadId, { role: "bot", kind: "text", text: "hi" } as never);
  user(asked.threadId, "are you there?");
  user(orphan.threadId, "anyone?");
  // the writers keep the table: only the thread whose visible end is the person's own message is in flight
  expect(db.prepare("SELECT thread_id FROM direct_turn_inflight ORDER BY thread_id").all().map(row => String(row.thread_id)).sort()).toEqual([asked.threadId, orphan.threadId].sort());
  // a row the table does not know (it predates the table) is found only by the one walk of an older file
  db.prepare("DELETE FROM direct_turn_inflight WHERE thread_id=?").run(orphan.threadId);
  expect(directTurnsWalked()).toBe(true); // a file that began empty needs no walk
  const note = "Interrupted by a restart";
  const later = Date.now() + 5_000;
  expect(await store.reconcileInterruptedDirectTurnsInBackground(note, later)).toBe(1);
  expect(store.messagesFor(asked.threadId).at(-1)).toMatchObject({ kind: "activity" });
  expect(store.messagesFor(orphan.threadId).at(-1)).toMatchObject({ role: "user" }); // not looked for: the table is the whole truth after the first walk
  expect(db.prepare("SELECT count(*) AS n FROM direct_turn_inflight WHERE thread_id=?").get(asked.threadId)!.n).toBe(0); // the marker answered it
  // the first start of an older file: no mark, so one walk over thread_state (in slices), which then marks itself done
  db.prepare("DELETE FROM transcript_index_state WHERE name='direct_turns_walk'").run();
  expect(directTurnsWalked()).toBe(false);
  expect(await store.reconcileInterruptedDirectTurnsInBackground(note, later, { rows: 1 })).toBe(1);
  expect(store.messagesFor(orphan.threadId).at(-1)).toMatchObject({ kind: "activity" });
  expect(directTurnsWalked()).toBe(true);
});

// ── P2: the shape marks keep up in the idle sweep; the hand-back waits for the pass ───────────────────────────────────────────────
import { advanceMemoryShapeMarks } from "./schema.ts";
import { setIntegrityFlags } from "./integrity-flags.ts";

it("P2: on an ordinary (non-migrating) open the shape marker is written, and the idle sweep moves it up behind the newest rows", () => {
  database().prepare("INSERT OR IGNORE INTO memory_scopes VALUES('s-ws','workspace','ws','[]',0)").run(); // (the marker rides on the workspace scope)
  closeDatabase();
  const again = database(); // an ordinary open writes (or confirms) the marker
  const before = Number((JSON.parse(String(again.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-shape-check'").get()?.intent)) as { marks: Record<string, number> }).marks["memory_scopes.audience"]);
  for (let i = 0; i < 5; i++) again.prepare("INSERT INTO memory_scopes VALUES(?, 'bot', ?, '[]', 0)").run(`s-extra-${i}`, `extra-${i}`);
  const newest = Number(again.prepare("SELECT max(rowid) AS n FROM memory_scopes").get()!.n);
  expect(newest).toBeGreaterThan(before);
  expect(advanceMemoryShapeMarks(again)).toBe(true);
  expect(Number((JSON.parse(String(again.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-shape-check'").get()?.intent)) as { marks: Record<string, number> }).marks["memory_scopes.audience"])).toBe(newest);
});

it("R2-03: the hand-back of space does nothing while the integrity pass is pending (a rewrite of the file renumbers the rowids its floors name)", () => {
  const db = database();
  db.exec("CREATE INDEX memory_root_set_members_root ON memory_root_set_members(root_thread_id,root_message_id)");
  db.exec("DELETE FROM memory_root_set_compaction; INSERT INTO memory_root_set_compaction(id,total,done,cursor,started_at,finished_at) VALUES(1,0,0,'',1,2)");
  setIntegrityFlags(db, { pending: true, lessonsFloor: 0, feedbackFloor: 0, eventsFloor: 0 });
  reclaimLineageSpace(db, { freeDiskBytes: () => 1e12 });
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeTruthy();
  expect(db.prepare("SELECT reclaimed_at FROM memory_root_set_compaction").get()!.reclaimed_at).toBeNull();
  setIntegrityFlags(db, { pending: false });
  reclaimLineageSpace(db, { freeDiskBytes: () => 1e12 });
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeUndefined();
});
