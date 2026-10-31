// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fix round for the fifth upgrade-ui review (lanes/upgui-review/r5/REPORT.md, design r6): every proof checks both ends, large-set proofs outlive the cache and a
// restart, sweeps are bounded on both sides, and the start no longer reads old cards. The outbox/scheduler tests are in server/procedure-landing.test.ts and the
// client test is in src/state/open-cards.test.ts.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, finishBackgroundUpgradeWorkNow } from "../database.ts";
import { Store } from "../store.ts";
import { dismissStalePeerCards, type ApprovalBus } from "../peer-approval.ts";
import { dismissStaleHostConsentCards } from "../host-computer-consent.ts";
import { insertMessage, messagesHighWater, openToolCardPlans, readMessage } from "../message-db.ts";
import { ensureOpenCardIndex } from "../transcript-backfill.ts";
import { advanceMemoryShapeMarks } from "./schema.ts";
import { readExact } from "./bounded-read.ts";
import { LAZY_ROOT_MIN, LayeredRoots, handleFor, resetRootSetWork, rootSetWork } from "./root-set-handles.ts";
import { advanceRootSetProofs, forgetKeptLineageForTest, outputRootsBad, rootSetProofsPending } from "./replay-lineage.ts";
import { COLLECT_EXAMINE_SETS, collectRootSetsSlice, WORKLIST_BATCH_SQL } from "./root-set-compaction.ts";
import { ensureRootSetWorklist } from "./upgrade-app-tables.ts";
import { buildSyntheticV6 } from "./testing/upgrade-fast-fixture.ts";
import { sessionLookup } from "./deny-read.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

// ── 1. root-set proofs read both ends ────────────────────────────────────────────────────────────────────────────────────────────────
function bigSet(db: DatabaseSync, id: string, declared: number, actual: number, thread = "th") {
  db.prepare("INSERT INTO memory_root_sets(set_id,size) VALUES(?,?)").run(id, declared);
  db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?3) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT ?1,?2,'m'||printf('%07d',i) FROM k").run(id, thread, actual);
}
const rootsOf = (db: DatabaseSync, id: string) => { const roots = new LayeredRoots(); roots.absorb(handleFor(db, new Map(), id)!); return { roots, over: false }; };

it("r6-1: readExact asks for one row more than declared and reports both missing and excess", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t(i INTEGER PRIMARY KEY)");
  db.exec("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<20001) INSERT INTO t SELECT i FROM k");
  const stmt = db.prepare("SELECT i FROM t ORDER BY i LIMIT ?");
  expect(readExact(stmt, [], 20_001)).toMatchObject({ missing: 0, excess: false });
  expect(readExact(stmt, [], 20_001).rows).toHaveLength(20_001);
  const excess = readExact(stmt, [], 20_000);
  expect(excess.excess).toBe(true);
  expect(excess.rows).toHaveLength(20_000); // the extra row proves excess and is not returned
  expect(readExact(stmt, [], 20_002)).toMatchObject({ missing: 1, excess: false });
});

/** A turn's look at a large set: never a walk. Unproven, it says "checking"; the recovery scheduler then builds the proof in 4,000-member passes. */
function turnCheck(db: DatabaseSync, id: string): { bad: boolean; reason?: string } {
  const why: { reason?: string } = {};
  return { bad: outputRootsBad(LineageAllowance.tool(), rootsOf(db, id), why), ...why };
}
function backgroundPasses(limit = 20): { passes: number; members: number[] } {
  const members: number[] = [];
  while (rootSetProofsPending() && members.length < limit) members.push(advanceRootSetProofs(4_000).members);
  return { passes: members.length, members };
}
it("r6-1 (r8): a large set is proven only in the background, reading both ends: 20,002 rows or 20,000 rows under 20,001 declared are never proven; exactly 20,001 is", () => {
  const db = database();
  expect(LAZY_ROOT_MIN).toBe(20_000);
  for (const [id, actual] of [["extra", 20_002], ["short", 20_000]] as const) {
    forgetKeptLineageForTest(); // the other set's renewed request is not counted here
    bigSet(db, id, 20_001, actual);
    expect(turnCheck(db, id)).toEqual({ bad: true, reason: "checking" });
    resetRootSetWork();
    backgroundPasses();
    expect(rootSetWork().rows).toBeLessThanOrEqual(20_002 + 8); // 20,001 declared and the one row that proves an excess, nothing more
    expect(turnCheck(db, id)).toEqual({ bad: true, reason: "checking" }); // still not proven
  }
  forgetKeptLineageForTest();
  bigSet(db, "exact", 20_001, 20_001);
  expect(turnCheck(db, "exact")).toEqual({ bad: true, reason: "checking" });
  expect(backgroundPasses().passes).toBe(Math.ceil(20_001 / 4_000));
  expect(turnCheck(db, "exact")).toEqual({ bad: false });
});

it("r6-1 (r8): four large sets are each proven once in the background; twelve checks later no member is iterated; after a restart nothing is trusted and nothing is walked", () => {
  const db = database();
  for (let i = 0; i < 4; i++) { bigSet(db, `c${i}`, 20_001, 20_001, `th${i}`); expect(turnCheck(db, `c${i}`).reason).toBe("checking"); }
  resetRootSetWork();
  backgroundPasses(40);
  expect(rootSetWork().members).toBe(4 * 20_001); // each member of each set once
  for (let check = 0; check < 12; check++) {
    resetRootSetWork();
    expect(turnCheck(db, `c${check % 4}`)).toEqual({ bad: false });
    expect(rootSetWork().members).toBe(0);
  }
  forgetKeptLineageForTest(); // a restart: nothing in memory
  for (let check = 0; check < 8; check++) {
    resetRootSetWork();
    expect(turnCheck(db, `c${check % 4}`)).toEqual({ bad: true, reason: "checking" });
    expect(rootSetWork().members).toBe(0);
  }
});

it("r6-1 (r8): the background proof takes ceil(n/4,000) passes, each member once; a forget ends it, and the next turn walks nothing", () => {
  const db = database();
  bigSet(db, "s", 20_001, 20_001);
  expect(turnCheck(db, "s").reason).toBe("checking");
  const { passes, members } = backgroundPasses();
  expect(members.every((n) => n <= 4_000)).toBe(true);
  expect(members.reduce((a, b) => a + b, 0)).toBe(20_001); // every member exactly once
  expect(passes).toBe(6);
  expect(turnCheck(db, "s")).toEqual({ bad: false });
  // a forget (the deletion epoch moves) ends every kept verdict; the next turn does not walk the set, it asks for the proof again
  db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1");
  resetRootSetWork();
  expect(turnCheck(db, "s")).toEqual({ bad: true, reason: "checking" });
  expect(rootSetWork().members).toBe(0);
});

// ── 4. bounded queries ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A sweep query must be a seek or a primary-key/rowid range: no scan of a table that is not cut short by a LIMIT in key order, and no sort. */
function assertBoundedSweep(db: DatabaseSync, sql: string, args: Array<string | number>) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => String(row.detail));
  for (const detail of plan) {
    expect(detail, `${sql}\n${plan.join("\n")}`).not.toMatch(/USE TEMP B-TREE/);
    if (/^SCAN /.test(detail) && !/USING (COVERING )?INDEX|VIRTUAL TABLE/.test(detail) && !/\bLIMIT\b/i.test(sql)) expect.fail(`unbounded scan: ${detail}\n${sql}`);
  }
}
const SWEEP_QUERIES: Array<[string, string, Array<string | number>]> = [
  ["worklist first", WORKLIST_BATCH_SQL.first, []],
  ["worklist after", WORKLIST_BATCH_SQL.after, ["t", 5, "s"]],
  ["collect cursor update", "UPDATE memory_scope_bindings SET intent=?2 WHERE id=?1", ["root-set-collect-cursor", "{}"]],
  ["outbox range", "SELECT id,intent FROM memory_scope_bindings WHERE id>? AND id<? ORDER BY id LIMIT ?", ["procedure-outbox:", "procedure-outbox;", 20]],
  ["shape tail, scopes", "SELECT 1 FROM memory_scopes WHERE rowid>? AND rowid<=? AND json_type(audience)!=? LIMIT 1", [0, 10, "array"]],
  ["shape tail, records", "SELECT 1 FROM memory_records WHERE rowid>? AND rowid<=? AND assertion NOT IN ('a') LIMIT 1", [0, 10]],
  ["card sweep range", "SELECT thread_id,json FROM messages m WHERE m.rowid>? AND m.rowid<=? AND m.kind='options' AND json_extract(m.json,'$.card.tool') IN (?)", [0, 10, "ask_bot"]],
  ["dead-card point read", "SELECT json FROM messages WHERE thread_id=? AND id=?", ["t", "m"]],
];
it("r6-4: assertBoundedSweep over every registered sweep query", () => {
  const db = database();
  ensureRootSetWorklist(db);
  for (const [, sql, args] of SWEEP_QUERIES) assertBoundedSweep(db, sql, args);
  const plans = openToolCardPlans();
  expect(plans.indexed.join(" | ")).toMatch(/SCAN c\b/); // the open-card list itself (one row per open card), then a primary-key seek of each message
expect(plans.indexed.join(" | ")).toMatch(/SEARCH m USING/);
  expect(plans.indexed.join(" | ")).not.toMatch(/SCAN m\b|SCAN messages/);
  expect(plans.range.join(" | ")).toMatch(/SEARCH m? ?(messages)? ?USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)|rowid>\?/);
});

it("r6-4: the shape tail with a cap of 4 reads four rowids; an invalid row far past them does not fail the slice", () => {
  database().prepare("INSERT OR IGNORE INTO memory_scopes VALUES('s-ws','workspace','ws','[]',0)").run();
  closeDatabase();
  const db = database();
  const mark = () => Number((JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-shape-check'").get()?.intent)) as { marks: Record<string, number> }).marks["memory_scopes.audience"]);
  const start = mark();
  db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<10010) INSERT INTO memory_scopes SELECT 'x'||i,'bot','o'||i,CASE WHEN i=10002 THEN '{}' ELSE '[]' END,0 FROM k").run();
  expect(advanceMemoryShapeMarks(db, 4)).toBe(true); // before: the unbounded read saw row 10,002 and failed this slice
  expect(mark()).toBe(start + 4);
});

it("r6-4: collecting 50 small sets resolves the cursor's scope without a single look at the scopes, and a write is a primary-key update", () => {
  const db = database();
  db.prepare("INSERT INTO memory_scopes VALUES('s-ws','workspace','ws','[]',0)").run();
  db.prepare("INSERT INTO memory_scope_bindings VALUES('memory-roster-policy','s-ws','system','roster',0,'granted','{}')").run();
  db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<20000) INSERT INTO memory_scopes SELECT 'c'||i,'conversation','conv'||i,'[]',0 FROM k").run();
  for (let i = 0; i < 50; i++) db.prepare("INSERT INTO memory_root_sets(set_id,size) VALUES(?,1)").run(`set${String(i).padStart(3, "0")}`);
  const seen: string[] = [];
  const real = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { seen.push(sql); return real(sql); };
  try { for (let i = 0; i < 50; i++) collectRootSetsSlice(db, { examine: 1 }); } finally { delete (db as unknown as Record<string, unknown>).prepare; }
  expect(COLLECT_EXAMINE_SETS).toBeGreaterThan(1);
  expect(seen.filter((sql) => /FROM memory_scopes (ORDER|WHERE)/.test(sql)).slice(0, 2)).toEqual([]);
  expect(seen.filter((sql) => /memory_scope_bindings/.test(sql) && /UPDATE|INSERT/.test(sql)).length).toBeGreaterThan(0); // the cursor was written, each time without a scope lookup
});

// ── 3. point mutations, and the start no longer reads old cards ───────────────────────────────────────────────────────────────────
const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
function rowsReadBy(db: DatabaseSync) {
  let rows = 0;
  const real = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => new Proxy(real(sql), { get(target, property) {
    const value = (target as never as Record<string | symbol, unknown>)[property];
    if (property === "all") return (...args: unknown[]) => { const out = (value as (...a: unknown[]) => unknown[]).apply(target, args); rows += out.length; return out; };
    if (property === "get") return (...args: unknown[]) => { const out = (value as (...a: unknown[]) => unknown).apply(target, args); if (out) rows += 1; return out; };
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  } });
  return { rows: () => rows, stop: () => { delete (db as unknown as Record<string, unknown>).prepare; } };
}
/** `rows` text messages in `thread` and one open card per entry of `cards` (tool, request id), written directly. */
function history(db: DatabaseSync, thread: string, rows: number, cards: Array<[string, string]>) {
  const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 1; i <= rows; i++) {
    const message = { id: `${thread}-${i}`, at: i, role: "bot", kind: "text", text: "t", parentId: i > 1 ? `${thread}-${i - 1}` : null };
    put.run(thread, message.id, i, "bot", "text", "t", JSON.stringify(message));
  }
  db.exec("COMMIT");
  // the cards go through the writer, so the open-card list is kept the way the app keeps it
  cards.forEach(([tool, requestId], index) => {
    const at = rows + 1 + index;
    insertMessage(thread, { id: `${thread}-card-${index}`, at, role: "bot", kind: "options", text: "ask", parentId: `${thread}-${rows}`, card: { title: "c", subtitle: "s", options: ["Allow", "Deny"], requestId, tool } } as never);
  });
  db.prepare("INSERT OR REPLACE INTO thread_state(thread_id,active_leaf_id) VALUES(?,?)").run(thread, `${thread}-${rows}`);
}
const loaded = (store: Store, thread: string) => (store as unknown as { threads: Map<string, unknown> }).threads.has(thread);

it("r6-3: a point patch of a card in an unloaded 20,000-row thread reads one row and never loads the thread", () => {
  const db = database();
  const store = new Store(selection);
  const bot = store.createBot();
  const thread = store.createTask(bot.id, "Background", false)!.threadId; // a task thread is not read until it is opened
  history(db, thread, 20_000, [["ask_bot", "dead-1"]]);
  expect(loaded(store, thread)).toBe(false);
  const counter = rowsReadBy(db);
  let patched;
  try { patched = store.patchMessagePoint(thread, `${thread}-card-0`, { card: { title: "c", subtitle: "s", options: [], requestId: "dead-1", tool: "ask_bot", answered: "deny", dismissed: true } as never }); } finally { counter.stop(); }
  expect(patched?.card?.dismissed).toBe(true);
  expect(counter.rows()).toBeLessThanOrEqual(10); // the card's row, its index rows, the write's own bookkeeping: never the 20,000
  expect(loaded(store, thread)).toBe(false);
  expect(readMessage(thread, `${thread}-card-0`)?.card?.dismissed).toBe(true);
});

const busOf = (store: Store) => ({ store }) as unknown as ApprovalBus;
function staleCardRun(rows: number): { dismissed: number; read: number; hydrated: boolean } {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const db = database();
  const store = new Store(selection);
  const bot = store.createBot();
  const thread = store.createTask(bot.id, "Background", false)!.threadId;
  history(db, thread, rows, [["ask_bot", "d1"], ["delegate_bot", "d2"], ["local_computer_consent", "d3"]]);
  ensureOpenCardIndex(db);
  const counter = rowsReadBy(db);
  let dismissed = 0;
  try { dismissed = dismissStalePeerCards(busOf(store), "indexed") + dismissStaleHostConsentCards(busOf(store), "indexed"); } finally { counter.stop(); }
  return { dismissed, read: counter.rows(), hydrated: loaded(store, thread) };
}
it("r6-6: dismissing stale peer and consent cards at start reads only the open cards: the same at 20,000 and 200,000 messages, and no transcript is loaded", { timeout: 120_000 }, () => {
  const small = staleCardRun(20_000);
  const large = staleCardRun(200_000);
  expect(small.dismissed).toBe(3);
  expect(large.dismissed).toBe(3);
  expect(small.hydrated).toBe(false);
  expect(large.hydrated).toBe(false);
  expect(small.read).toBeLessThanOrEqual(40); // 3 open cards: their index rows, their messages, and each patch's own rows
  expect(large.read).toBeLessThanOrEqual(Math.ceil(small.read * 1.1));
  // idempotent: a second start finds nothing open
  expect(dismissStalePeerCards(busOf(new Store(selection)), "indexed")).toBe(0);
});

it("r6-6: while the open-card list is still being built, the start reads nothing; the sweep after listen finds the cards in bounded rowid slices", () => {
  const db = database();
  const store = new Store(selection);
  const bot = store.createBot();
  const thread = store.createTask(bot.id, "Background", false)!.threadId;
  history(db, thread, 3_000, [["ask_bot", "d1"], ["local_computer_consent", "d3"]]);
  db.exec("DELETE FROM open_card; DELETE FROM transcript_index_state WHERE name='open_card'");
  expect(dismissStalePeerCards(busOf(store), "indexed")).toBe(0); // nothing read before listen
  expect(loaded(store, thread)).toBe(false);
  const high = messagesHighWater();
  let dismissed = 0;
  for (let at = 0; at < high; at += 1_000) dismissed += dismissStalePeerCards(busOf(store), { after: at, upTo: Math.min(high, at + 1_000) }) + dismissStaleHostConsentCards(busOf(store), { after: at, upTo: Math.min(high, at + 1_000) });
  expect(dismissed).toBe(2);
  expect(loaded(store, thread)).toBe(false);
  expect(readMessage(thread, `${thread}-card-0`)?.card).toMatchObject({ answered: "unavailable", dismissed: true });
});

it("r6-6: the start between the two marks reads no transcript, and the other boot work is not repeated", () => {
  const peer = readFileSync(join(import.meta.dirname, "..", "peer-approval.ts"), "utf8");
  const consent = readFileSync(join(import.meta.dirname, "..", "host-computer-consent.ts"), "utf8");
  for (const source of [peer.slice(peer.indexOf("export function dismissStaleToolCards")), consent.slice(consent.indexOf("export function dismissStaleHostConsentCards"))]) expect(source).not.toMatch(/messagesFor\(|patchMessage\(/);
  const index = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8");
  const wiring = index.slice(index.indexOf('startupMark("wiring.10671")'), index.indexOf("// T22 durable browser cards"));
  // (r8) one bounded page of the open-card list before listen, for both kinds of card at once
  expect(wiring).toContain("settleStaleCardPage(approvalBus, [stalePeerCardKind(), staleHostConsentCardKind()], null, STALE_CARD_PAGE,");
  expect(wiring).toContain('startupMark("wiring.staleCards")');
  expect(peer.slice(peer.indexOf("export function settleStaleCardPage"))).not.toMatch(/messagesFor\(|patchMessage\(/);
  const sweep = index.slice(index.indexOf("async function sweepCardsOfDeadRun"), index.indexOf("\n}\n", index.indexOf("async function sweepCardsOfDeadRun")));
  expect(sweep).toContain("dismissStalePeerCards(approvalBus, { after, upTo }, owned)");
  expect(sweep).toContain("store.patchMessagePoint(");
  expect(sweep).not.toMatch(/store\.patchMessage\(/);
});

// ── an on-disk upgraded file: a 1.0.1-shape file, upgraded and reopened ──────────────────────────────────────────────────────────
it("r6-* (r8): a 1.0.1-shape file on disk is upgraded and reopened; its dead peer card is in the open-card list, and a large-set proof is not trusted after the reopen", () => {
  buildSyntheticV6(join(DATA_DIR, "messages.db"), { threads: 3, perThread: 20, payloadBytes: 100, receiptsPerThread: 1, setThreads: 1, repliesPerSetThread: 3 });
  const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
  const card = { id: "dead-card", at: 9_999, role: "bot", kind: "options", text: "ask", parentId: null, card: { title: "c", subtitle: "s", options: ["Allow"], requestId: "gone", tool: "ask_bot" } };
  raw.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t0','dead-card',9999,'bot','options','ask',?)").run(JSON.stringify(card));
  raw.close();
  const first = database();
  finishBackgroundUpgradeWorkNow();
  bigSet(first, "big", 20_001, 20_001);
  // 1.0.2 S6 (DESIGN-WRITETIME 1, "Root sets: stop writing them"): the upgrade backfilled the file's lines, so the read-time judge is retired on it
  // (read-time-retired.ts) and a root set is read by nobody: there is no proof to trust or to lose at a restart. What a session rests on is its
  // write-time row, and a session with none reads "checking", never shown (sessionLookup).
  const unknownSession = { threadId: "th", driverInstance: "d", nativeSession: "s" };
  expect(turnCheck(first, "big")).toEqual({ bad: false });
  expect(sessionLookup(first, unknownSession, { audience: null })).toMatchObject({ state: "checking" });
  backgroundPasses();
  closeDatabase();
  const second = database(); // the second boot over the upgraded file
  resetRootSetWork();
  expect(turnCheck(second, "big")).toEqual({ bad: false });
  expect(sessionLookup(second, unknownSession, { audience: null })).toMatchObject({ state: "checking" }); // nothing unproven is shown after the restart either
  expect(rootSetWork().members).toBe(0);
  expect(Number(second.prepare("SELECT count(*) AS n FROM open_card WHERE id='dead-card'").get()!.n)).toBe(1);
  expect(Number(second.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='upgrade_root_set_proofs'").get()!.n)).toBe(0);
  expect(readMessage("t0", "dead-card")?.card?.requestId).toBe("gone");
});
