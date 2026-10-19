// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fix round for the eighth upgrade-ui review (lanes/upgui-review/r8/REPORT.md and FABLE-REPORT.md). The replay honours the large-set rule (a reply resting
// on an unproven large set is left out, not walked, so a "checking" reset is not rebuilt on every turn); the first check after a start reads no large
// chained set; a proof in progress is never evicted for room; a proof slice counts nested work, hands back within its time and runs only when no owner
// turn waits; no background slice reads a history-sized list in one go; the background upgrade waits while the I/O budget holds it back; and a file a
// preview wrote with the proof table restores, upgrades and downgrades.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { initializeMessageTables } from "../message-tables.ts";
import { inspectInstallationDatabase } from "../installation-database-snapshot.ts";
import { startRecoveryScheduler } from "../recovery-scheduler.ts";
import { retainedSessionInvalid } from "./dispatch.ts";
import { advanceRootSetProofs, capturedMessageWithheld, forgetKeptLineageForTest, keptVerdictCount, replayExclusions, rootSetProofsPending, setRootSetCeilingForTest, setVerdictLimitForTest, type ReplayAudience } from "./replay-lineage.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { resetRootSetWork, rootSetWork } from "./root-set-handles.ts";
import { setMemoryMode } from "./repository.ts";
import { UPGRADE_DERIVED_TABLES, legacyReplyRootsSteps, rebuildOutputIndexSlice } from "./schema.ts";
import { stepIntegrityPass } from "./integrity-pass.ts";
import { beginIntegrityPass, integrityHoldOf, readIntegrityPass } from "./integrity-state.ts";
import { startBackgroundUpgradeWork } from "./upgrade-background.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const fresh = () => { closeDatabase(); forgetKeptLineageForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); };
beforeEach(fresh);
afterEach(() => { setRootSetCeilingForTest(null); setVerdictLimitForTest(null); });

/** Rows handed back by `get` and `all`, counted at the SQL layer (the connection is opened after the wrapper is in place). */
const tally = { rows: 0 };
const realPrepare = DatabaseSync.prototype.prepare;
beforeAll(() => {
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = realPrepare.call(this, sql);
    const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    const get = statement.get.bind(statement), all = statement.all.bind(statement);
    own.get = (...args) => { const row = (get as (...a: unknown[]) => unknown)(...args); if (row) tally.rows++; return row; };
    own.all = (...args) => { const rows = (all as (...a: unknown[]) => unknown[])(...args); tally.rows += rows.length; return rows; };
    return statement;
  } as typeof realPrepare;
});
afterAll(() => { DatabaseSync.prototype.prepare = realPrepare; });

/** A stored set of `size` members: `extra` first, then plain members `<thread>`/`<prefix>NNNNNNN`. */
function bigSet(db: DatabaseSync, id: string, size: number, extra: Array<[string, string]> = [], thread = "th", prefix = "m") {
  db.prepare("INSERT INTO memory_root_sets(set_id,size) VALUES(?,?)").run(id, size);
  db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?2) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT ?1,?3,?4||printf('%07d',i) FROM k").run(id, size - extra.length, thread, prefix);
  for (const [t, m] of extra) db.prepare("INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) VALUES(?,?,?)").run(id, t, m);
}
/** A chained set: `parent` (of `parentSize` members) plus `added` members of its own. */
function chainedSet(db: DatabaseSync, id: string, parent: string, parentSize: number, added: number) {
  db.prepare("INSERT INTO memory_root_sets(set_id,size) VALUES(?,?)").run(id, parentSize + added);
  db.prepare("INSERT INTO memory_root_set_parents(set_id,parent_id) VALUES(?,?)").run(id, parent);
  db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<?2) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT ?1,'tc','a'||printf('%07d',i) FROM k").run(id, added);
}
const retain = (db: DatabaseSync, setId: string) => db.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES('C','d','sess',?)").run(setId);
const sessionCheck = () => { const why: { reason?: string } = {}; const bad = retainedSessionInvalid(LineageAllowance.turn(1e9), "C", "d", "sess", why); return { bad, reason: why.reason }; };
function passes(limit = 400, budget = 4_000): number[] {
  const members: number[] = [];
  while (rootSetProofsPending() && members.length < limit) members.push(advanceRootSetProofs(budget).members);
  return members;
}
const reply = [{ id: "reply-1", role: "bot" }];
/** The table the 1.0.2 previews kept large-set proofs in (r6 to r7). */
const LEGACY_ROOT_SET_PROOFS_TABLE = "upgrade_root_set_proofs";

// ── Astra r8 #1: the replay applies the large-set rule ─────────────────────────────────────────────────────────────────────────────
it("r9 (Astra r8 #1): a replay never walks an unproven large set: the reply is left out on every turn, the proof is asked for once, and the reply replays once proven", () => {
  setMemoryMode("active");
  const db = database();
  bigSet(db, "big", 20_001);
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES('C','reply-1','big')").run();
  const walked: number[] = [], left: boolean[] = [];
  for (let turn = 0; turn < 3; turn++) {
    resetRootSetWork();
    left.push(replayExclusions(LineageAllowance.tool(1e9), "C", reply, null).has("reply-1"));
    walked.push(rootSetWork().members);
  }
  console.log(`R9-REPLAY walked=${JSON.stringify(walked)}`);
  expect(left).toEqual([true, true, true]); // not proven is not shown, and the replacement session does not carry the set
  expect(walked).toEqual([0, 0, 0]); // never walked by the turn
  expect(rootSetProofsPending()).toBe(1);
  expect(passes().reduce((a, b) => a + b, 0)).toBe(20_001);
  resetRootSetWork();
  expect(replayExclusions(LineageAllowance.tool(1e9), "C", reply, null).has("reply-1")).toBe(false);
  expect(rootSetWork().members).toBe(0);
});

it("r9 (Astra r8 #1): a reader's replay of a reply resting on an unproven large set leaves it out, walks nothing, and replays it once that reader's proof is built", () => {
  setMemoryMode("active");
  const db = database();
  bigSet(db, "big", 20_001);
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES('C','reply-1','big')").run();
  const reader: ReplayAudience = { policyRevision: 0, deletionEpoch: 0, revoked: () => false, cacheKey: "reader-1" };
  resetRootSetWork();
  expect(replayExclusions(LineageAllowance.tool(1e9), "C", reply, reader).has("reply-1")).toBe(true);
  expect(rootSetWork().members).toBe(0);
  resetRootSetWork();
  expect(replayExclusions(LineageAllowance.tool(1e9), "C", reply, reader).has("reply-1")).toBe(true);
  expect(rootSetWork().members).toBe(0);
  expect(rootSetProofsPending()).toBe(1);
  passes();
  resetRootSetWork();
  expect(replayExclusions(LineageAllowance.tool(1e9), "C", reply, reader).has("reply-1")).toBe(false);
  expect(rootSetWork().members).toBe(0);
});

// ── Astra r8 #2: the first check after a start reads no large chained set ─────────────────────────────────────────────────────────
it("r9 (Astra r8 #2): the first check of a session resting on a large chained set reads a handful of rows at 20,001 and 200,000 added members, then the proof holds", { timeout: 300_000 }, () => {
  const seen: Array<{ check: { bad: boolean; reason?: string }; rows: number; sqlRows: number }> = [];
  for (const n of [20_001, 200_000]) {
    fresh();
    setRootSetCeilingForTest(250_000);
    const db = database();
    bigSet(db, "parent", 1);
    chainedSet(db, "child", "parent", 1, n);
    retain(db, "child");
    resetRootSetWork();
    const before = tally.rows;
    const check = sessionCheck();
    seen.push({ check, rows: rootSetWork().rows, sqlRows: tally.rows - before });
    if (n === 20_001) {
      passes();
      resetRootSetWork();
      expect(sessionCheck()).toEqual({ bad: false, reason: undefined }); // the lazily read child proves, both ends checked
      expect(rootSetWork().members).toBe(0);
    }
  }
  console.log(`R9-COLD ${JSON.stringify(seen)}`);
  for (const run of seen) { expect(run.check).toEqual({ bad: true, reason: "checking" }); expect(run.rows).toBeLessThan(20); }
  expect(seen[1]!.sqlRows).toBe(seen[0]!.sqlRows);
});

// ── Fable r8 #2: a proof in progress is never evicted for room ────────────────────────────────────────────────────────────────────
it("r9 (Fable r8 #2): turns that fill the verdict cache between proof slices do not evict the proof in progress: it finishes in ceil(n/4,000) slices, each member once", { timeout: 300_000 }, () => {
  setVerdictLimitForTest(10_000);
  const db = database();
  bigSet(db, "big", 20_001); retain(db, "big");
  expect(sessionCheck()).toEqual({ bad: true, reason: "checking" });
  const members: number[] = [];
  for (let slice = 0; slice < 20 && rootSetProofsPending(); slice++) {
    members.push(advanceRootSetProofs(4_000).members);
    // a cold turn in another conversation between two slices: a verdict per line, more than the cache holds
    for (let i = 0; i < 10_500; i++) capturedMessageWithheld(LineageAllowance.tool(1e9), "other", `line-${slice}-${i}`);
  }
  console.log(`R9-EVICT slices=${members.length} members=${JSON.stringify(members)} kept=${keptVerdictCount()}`);
  expect(rootSetProofsPending()).toBe(0);
  expect(members).toHaveLength(Math.ceil(20_001 / 4_000));
  expect(members.reduce((a, b) => a + b, 0)).toBe(20_001);
  expect(sessionCheck()).toEqual({ bad: false, reason: undefined });
});

// ── Astra r8 #3: nested work is budgeted, slices are time-boxed, the owner goes first ──────────────────────────────────────────
it("r9 (Astra r8 #3): a proof slice counts the members of sets nested under its members, never walks past its budget, and hands back within its time", { timeout: 600_000 }, () => {
  setMemoryMode("active");
  const db = database();
  // sixteen replies of C, each resting on its own 5,000-member set, inside a 20,001-member set C's session rests on
  const replies = Array.from({ length: 16 }, (_, i) => `r${String(i).padStart(2, "0")}`);
  for (const [i, id] of replies.entries()) {
    bigSet(db, `nested-${i}`, 5_000, [], `n${i}`, "x");
    db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES('C',?,?)").run(id, `nested-${i}`);
  }
  bigSet(db, "big", 20_001, replies.map(id => ["C", id] as [string, string]));
  retain(db, "big");
  expect(sessionCheck()).toEqual({ bad: true, reason: "checking" });
  const slices: Array<{ ms: number; walked: number; reported: number }> = [];
  for (let guard = 0; guard < 5_000 && rootSetProofsPending(); guard++) {
    resetRootSetWork();
    const started = performance.now();
    const step = advanceRootSetProofs(4_000, 50);
    slices.push({ ms: performance.now() - started, walked: rootSetWork().members, reported: step.members });
    // the first slice is where a walk of every nested set would land: checked at once
    if (guard === 0) { expect(slices[0]!.walked).toBeLessThanOrEqual(4_000); expect(slices[0]!.ms).toBeLessThan(150); }
  }
  const worst = slices.reduce((a, b) => ({ ms: Math.max(a.ms, b.ms), walked: Math.max(a.walked, b.walked), reported: Math.max(a.reported, b.reported) }), { ms: 0, walked: 0, reported: 0 });
  console.log(`R9-NESTED slices=${slices.length} worst=${JSON.stringify(worst)} first=${JSON.stringify(slices[0])}`);
  expect(rootSetProofsPending()).toBe(0);
  expect(worst.walked).toBeLessThanOrEqual(4_000);
  for (const slice of slices) expect(slice.reported).toBeGreaterThanOrEqual(slice.walked); // what was walked is what is charged
  const p95 = slices.map(slice => slice.ms).sort((a, b) => a - b)[Math.floor(slices.length * 0.95)]!;
  console.log(`R9-NESTED p95_ms=${p95.toFixed(1)}`);
  expect(p95).toBeLessThanOrEqual(50);
  expect(worst.ms).toBeLessThan(150); // the cap with room for a pause of a loaded test machine
  expect(sessionCheck()).toEqual({ bad: false, reason: undefined });
});

it("r9 (Astra r8 #3): no recovery pass runs while an owner turn waits or runs, or while the I/O budget holds background work back; the index build has a pass of its own", () => {
  let busy = true, defer = false;
  const calls: string[] = [];
  const scheduler = startRecoveryScheduler({
    db: () => database(), intervalMs: 3_600_000,
    outbox: () => { calls.push("outbox"); return { settled: 0, examined: 0, pending: 0, next: null }; },
    proofs: () => { calls.push("proofs"); return { members: 0, pending: 0 }; },
    upkeep: () => { calls.push("upkeep"); },
    busy: () => busy, defer: () => defer,
  });
  try {
    expect(scheduler.runNow().ran).toBe(false);
    busy = false; defer = true;
    expect(scheduler.runNow().ran).toBe(false);
    expect(calls).toEqual([]);
    defer = false;
    expect(scheduler.runNow()).toMatchObject({ ran: true, upkept: true });
    expect(calls).toEqual(["upkeep"]); // the one statement that cannot be cut runs alone
    scheduler.runNow();
    expect(calls).toEqual(["upkeep", "outbox", "proofs"]);
  } finally { scheduler.stop(); }
});

// ── Astra r8 #4: no history-sized operation inside a background slice ─────────────────────────────────────────────────────────────
function longReceipt(db: DatabaseSync, outputs: number) {
  db.exec("BEGIN");
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('b-long','t1','d','[]','[]',?,0,0,0,'delivered',1)")
    .run(JSON.stringify(Array.from({ length: outputs }, (_, i) => `reply-${String(i).padStart(7, "0")}`)));
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('a-short','t1','d','[]','[]','[\"s1\",\"s2\"]',0,0,0,'delivered',1)").run();
  db.exec("COMMIT");
  db.exec("BEGIN"); rebuildOutputIndexSlice(db, { lo: null, hi: null }); db.exec("COMMIT");
}
it("r9 (Astra r8 #4): one receipt of 20,000 or 200,000 outputs is proven in pieces: a slice costs the same at both sizes, and a missing index row is still found and rewritten", { timeout: 300_000 }, () => {
  const firstSlice: number[] = [], slices: number[] = [];
  for (const n of [20_000, 200_000]) {
    fresh();
    const db = database();
    longReceipt(db, n);
    beginIntegrityPass(db);
    stepIntegrityPass(db, { budgetMs: 0 }); // the short receipt before it
    let count = 0, first = 0;
    for (let guard = 0; guard < 10_000 && readIntegrityPass(db)!.phase === "output-index"; guard++) {
      const started = performance.now();
      stepIntegrityPass(db, { budgetMs: 0 });
      if (count++ === 0) first = performance.now() - started;
    }
    firstSlice.push(first); slices.push(count);
    expect(integrityHoldOf(readIntegrityPass(db))).toBeNull();
  }
  console.log(`R9-RECEIPT first_slice_ms=${JSON.stringify(firstSlice.map(ms => Number(ms.toFixed(1))))} slices=${JSON.stringify(slices)}`);
  expect(slices[0]!).toBeGreaterThan(1); // never the whole receipt in one statement
  expect(slices[1]!).toBeGreaterThan(slices[0]! * 5); // the work is spread, not done at once
  expect(firstSlice[1]!).toBeLessThan(Math.max(4 * firstSlice[0]!, 25));

  // a row of the long receipt's index is gone: the piecewise proof finds it, rewrites the receipt's rows from its JSON and passes
  fresh();
  const db = database();
  longReceipt(db, 20_000);
  db.prepare("DELETE FROM memory_disclosure_outputs WHERE bundle_id='b-long' AND message_id='reply-0012345'").run();
  beginIntegrityPass(db);
  for (let guard = 0; guard < 10_000 && readIntegrityPass(db)!.phase === "output-index"; guard++) stepIntegrityPass(db, { budgetMs: 0 });
  expect(integrityHoldOf(readIntegrityPass(db))).toBeNull();
  expect(readIntegrityPass(db)!.repaired).toBeGreaterThan(0);
  expect(db.prepare("SELECT 1 FROM memory_disclosure_outputs WHERE bundle_id='b-long' AND message_id='reply-0012345'").get()).toBeTruthy();
});

it("r9 (Astra r8 #4): the lineage walk pauses before it has read a heavy thread's outputs whole (200,000 outputs: the first pause comes after one stretch of rows)", () => {
  const db = database();
  db.prepare("WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<200000) INSERT INTO memory_disclosure_outputs(bundle_id,thread_id,message_id) SELECT 'b'||(i/1000),'T','o'||printf('%07d',i) FROM k").run();
  const before = tally.rows;
  const steps = legacyReplyRootsSteps(db, "T");
  const first = steps.next();
  console.log(`R9-WALK rows_before_first_pause=${tally.rows - before}`);
  expect(first).toEqual({ done: false, value: "pulse" });
  expect(tally.rows - before).toBeLessThan(10);
  steps.return(new Map());
});

// ── live storm A: the background upgrade consults the I/O budget ──────────────────────────────────────────────────────────────────
it("r9 (storm A): no background upgrade slice starts while the I/O budget holds it back, and each slice runs under its own I/O source", async () => {
  const db = database();
  beginIntegrityPass(db);
  let defer = true;
  const sources: number[] = [];
  const handle = startBackgroundUpgradeWork(db, { defer: () => defer, withSource: run => { sources.push(1); return run(); }, busyPauseMs: 5, pauseMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(handle.slices).toBe(0);
  defer = false;
  await handle.done;
  expect(handle.slices).toBeGreaterThan(0);
  expect(sources.length).toBe(handle.slices);
});

// ── Astra r8 #5: a file a preview wrote with the proof table ──────────────────────────────────────────────────────────────────────
it("r9 (Astra r8 #5): an archive of a preview file with the proof table (either shape) passes inspection; opening it drops the table; the downgrade drops it too", () => {
  const scratch = mkdtempSync(join(tmpdir(), "murage-r9-legacy-"));
  try {
    for (const shape of ["early", "late"] as const) {
      const db = new DatabaseSync(join(scratch, `${shape}.db`));
      initializeMessageTables(db);
      db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES (?,?,?,?,?,?,?)").run("t", "m", 1, "user", "text", "hi", JSON.stringify({ id: "m", at: 1, role: "user", kind: "text", text: "hi" }));
      db.exec("INSERT INTO thread_state VALUES ('t','m')");
      if (shape === "early") {
        db.exec(`CREATE TABLE ${LEGACY_ROOT_SET_PROOFS_TABLE}(\n  set_id TEXT PRIMARY KEY NOT NULL, size INTEGER NOT NULL, lineage_stamp TEXT NOT NULL, cursor INTEGER NOT NULL) WITHOUT ROWID`);
        db.exec(`ALTER TABLE ${LEGACY_ROOT_SET_PROOFS_TABLE} ADD COLUMN after_key TEXT NOT NULL DEFAULT ''`);
      } else db.exec(`CREATE TABLE IF NOT EXISTS ${LEGACY_ROOT_SET_PROOFS_TABLE}(\n  set_id TEXT PRIMARY KEY NOT NULL, size INTEGER NOT NULL, lineage_stamp TEXT NOT NULL, cursor INTEGER NOT NULL, after_key TEXT NOT NULL DEFAULT '') WITHOUT ROWID`);
      db.prepare(`INSERT INTO ${LEGACY_ROOT_SET_PROOFS_TABLE} VALUES('s',1,'stamp',0,'')`).run();
      expect(inspectInstallationDatabase(db)).toMatchObject({ messages: 1, threads: 1 });
      initializeMessageTables(db); // what every open runs
      expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(LEGACY_ROOT_SET_PROOFS_TABLE)).toBeUndefined();
      expect(inspectInstallationDatabase(db)).toMatchObject({ messages: 1, threads: 1 });
      db.close();
    }
  } finally { removeTempDirSync(scratch); }
  expect(UPGRADE_DERIVED_TABLES as readonly string[]).toContain(LEGACY_ROOT_SET_PROOFS_TABLE);
});
