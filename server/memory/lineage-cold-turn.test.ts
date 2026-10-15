// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 (extreme scale, lineage-cold): the first turn after a start, on a long session whose replies each rest on the one before it.
//
// The verdicts a turn needs are kept in memory only, so after an upgrade restart the first prime turn judged the whole history on the
// turn path (the scale rig: more than 600 s). A turn now spends a fixed allowance on lineage work (LineageAllowance) and withholds what it
// cannot prove; the warmer (lineage-warm.ts) judges the history while the app is idle, so the turn after it is cheap again. Work is pinned
// in statements run through the SQL layer (no clock), as lineage-turn-scale.test.ts does.
//
// The data is the rig's shape: each reply's receipt cites the previous reply as a source and the replies' root sets are a chain. The output
// lists are the legacy ones (every receipt of the session lists every reply written after it) in the cost test, and the current ones (a
// reply is listed on its own receipt) where answers are compared with the unbounded check.
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { chainStore } from "./schema.ts";
import { retainedSessionInvalid } from "./dispatch.ts";
import { lineageWarmIdle, lineageWarmStep, kickLineageWarm, resetLineageWarmForTest } from "./lineage-warm.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import {
  capturedMessageWithheld, forgetKeptLineageForTest, keptVerdictCount, outputRootsBad, replayExclusions, replayLimitWithheld, resetReplayRowsRead, sessionLineageBad,
  sessionOutputRoots, setReplayNodeBudgetForTest, setTurnLineageNodesForTest,
} from "./replay-lineage.ts";

const thread = "cold-direct", driver = "drv", session = "sess";
const key = (reply: number) => `${thread}\u0000r${reply}`;
const source = (reply: number) => `message:${thread}:r${reply}`;
/** The statement budget of a turn on any length of session (the figure is the contract, not what the code happens to spend): a cold first
 * turn, the turn after the warmer, and a turn that judges again what a forget dropped (its three entry points each spend their own allowance). */
const TURN_STATEMENT_CAP = 600, WARM_STATEMENT_CAP = 100, FORGET_STATEMENT_CAP = 1_800;

beforeEach(() => { resetLineageWarmForTest(); closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { setReplayNodeBudgetForTest(null); setTurnLineageNodesForTest(null); });

const tally = { rows: 0, statements: 0 };
const realPrepare = DatabaseSync.prototype.prepare;
beforeAll(() => {
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = realPrepare.call(this, sql);
    const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    const get = statement.get.bind(statement), all = statement.all.bind(statement), run = statement.run.bind(statement);
    own.get = (...args) => { tally.statements++; const row = (get as (...a: unknown[]) => unknown)(...args); if (row) tally.rows++; return row; };
    own.all = (...args) => { tally.statements++; const rows = (all as (...a: unknown[]) => unknown[])(...args); tally.rows += rows.length; return rows; };
    own.run = (...args) => { tally.statements++; return (run as (...a: unknown[]) => unknown)(...args); };
    return statement;
  } as typeof realPrepare;
});
afterAll(() => { DatabaseSync.prototype.prepare = realPrepare; });
function sqlWork<T>(run: () => T): { value: T; rows: number; statements: number } {
  const before = { ...tally };
  const value = run();
  return { value, rows: tally.rows - before.rows, statements: tally.statements - before.statements };
}

/** A session of `n` replies written to the file, as an upgrade finds it. */
function build(n: number, legacy = false): void {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), scope = ensureScope("conversation", thread), write = chainStore(db);
  db.exec("BEGIN");
  const addSource = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')");
  const addMessage = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const addReceipt = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]',?,?,0,0,0,'delivered',9)");
  for (let index = 0; index < n; index++) {
    addSource.run(source(index), scope, thread, `r${index}`);
    addMessage.run(thread, `r${index}`, index, "bot", "text", `reply ${index}`, "{}");
  }
  for (let index = 0; index < n; index++) {
    // the receipt of reply `index` cites the reply before it, and lists its own reply (legacy: every reply from its own on)
    const outputs = legacy ? Array.from({ length: n - index }, (_, at) => `r${index + at}`) : [`r${index}`];
    addReceipt.run(`rc${index}`, thread, driver, session, JSON.stringify(index ? [{ id: source(index - 1), revision: 1 }] : []), JSON.stringify(outputs));
  }
  let parent: string | null = null;
  const pointer = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  const sets: string[] = [];
  for (let index = 0; index < n; index++) { parent = write(parent, index, [key(index)]); sets.push(parent); pointer.run(thread, `r${index}`, parent); }
  db.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES(?,?,?,?)").run(thread, driver, session, sets[n - 1]!);
  // the file's lineage repair ran in an earlier version (it would widen the legacy replies' sets: the marker says it is done)
  db.prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES('memory-lineage-backfill-v3',?,'system','lineage-backfill',0,'granted',?)").run(scope, JSON.stringify({ done: true }));
  db.exec("COMMIT");
}
/** An upgrade restart: the file stays, nothing kept in memory does. */
function restart(): void { closeDatabase(); forgetKeptLineageForTest(); resetLineageWarmForTest(); database(); }

const windowOf = (n: number) => Array.from({ length: Math.min(100, n) }, (_, back) => ({ id: `r${n - 1 - back}`, role: "bot" }));
/** What a turn asks about the long session: recall's verdicts for the newest replies, the continuation check, the replay window. */
function turnOf(n: number): { recall: boolean[]; continuation: boolean; excluded: string[] } {
  // (recall is one call: its three checks share the allowance)
  const recall = [n - 1, n - 2, n - 3].map(index => capturedMessageWithheld(LineageAllowance.turn(), thread, `r${index}`));
  const checking = LineageAllowance.turn();
  const continuation = sessionLineageBad(checking, thread, driver, session, null, new Set()) || outputRootsBad(checking, sessionOutputRoots(checking, thread, driver, session));
  const excluded = [...replayExclusions(LineageAllowance.turn(), thread, windowOf(n), null, { failClosed: true })].sort();
  return { recall, continuation, excluded };
}
function warmToCompletion(limit = 20_000): number {
  kickLineageWarm();
  let steps = 0;
  while (lineageWarmStep(25)) { if (++steps > limit) throw new Error("the warmer did not finish"); }
  return steps;
}

for (const legacy of [true, false]) it(`a cold first turn costs the same statements on 300 and on 1,500 replies, below the cap, and shows no line it did not prove (${legacy ? "legacy" : "current"} output lists)`, () => {
  const measured: Record<number, { statements: number; excluded: number }> = {};
  for (const n of [300, 1_500]) {
    closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
    database();
    build(n, legacy);
    // a deep root is forgotten: the unbounded check withholds every reply built on it, so a turn that cannot finish must withhold them too
    database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(source(5));
    restart();
    const spent = sqlWork(() => turnOf(n));
    measured[n] = { statements: spent.statements, excluded: spent.value.excluded.length };
    expect(spent.value.excluded.length, `the window of ${n} replies rests on a forgotten root`).toBe(Math.min(100, n));
    expect(spent.value.recall.every(Boolean), "recall drops the hit").toBe(true);
    expect(spent.value.continuation, "the session is not kept").toBe(true);
    expect(spent.statements, `cold turn on ${n} replies`).toBeLessThan(TURN_STATEMENT_CAP);
  }
  console.log(`LINEAGE-COLD ${legacy ? "legacy" : "current"} 300=${JSON.stringify(measured[300])} 1500=${JSON.stringify(measured[1_500])}`);
  expect(measured[1_500]!.statements).toBeLessThanOrEqual(measured[300]!.statements * 1.3);
}, 900_000);

it("a cold first turn on sound history withholds what it cannot prove, shows nothing the unbounded check would withhold, and the warmer then finishes", () => {
  // (the unbounded check is the reference, so the session is one it can finish: 300 sound chained replies, a window of 100)
  const n = 300;
  database();
  build(n);
  restart();
  // the reference: the unbounded cold answer. It allows the window, and nothing in it ran out of a budget: an empty answer is the answer,
  // not an exhausted one (the receipts it visits are counted once each, not once per visit)
  setReplayNodeBudgetForTest(1_000_000_000);
  const ranOutBefore = replayLimitWithheld();
  const reference = [...replayExclusions(LineageAllowance.tool(1_000_000_000), thread, windowOf(n), null, { failClosed: true })].sort();
  setReplayNodeBudgetForTest(null);
  expect(replayLimitWithheld(), "the reference ran out of no budget").toBe(ranOutBefore);
  expect(reference).toEqual([]);
  restart();
  const cold = turnOf(n);
  for (const id of cold.excluded) expect(windowOf(n).some(line => line.id === id)).toBe(true);
  // unproven lines are withheld, never shown: what the cold turn lets through is a subset of what the unbounded check lets through
  expect(windowOf(n).filter(line => !cold.excluded.includes(line.id)).length).toBeLessThanOrEqual(windowOf(n).length - reference.length);
  const steps = warmToCompletion();
  expect(steps).toBeGreaterThan(0);
  expect(lineageWarmIdle()).toBe(true);
  const warm = sqlWork(() => turnOf(n));
  expect(warm.value).toEqual({ recall: [false, false, false], continuation: false, excluded: reference });
  expect(warm.statements, "the turn after the warmer").toBeLessThan(WARM_STATEMENT_CAP);
  // forgetting a deep root withholds the line on the next turn, within the same cap
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(source(5));
  const after = sqlWork(() => turnOf(n));
  expect(after.value.excluded.length).toBe(windowOf(n).length);
  expect(after.value.recall.every(Boolean)).toBe(true);
  expect(after.statements, "the turn after a forget").toBeLessThan(FORGET_STATEMENT_CAP);
}, 900_000);

it("a warmed 1,500-reply session answers the next turn within the warm cap, and a forgotten deep root is still honoured", () => {
  const n = 1_500;
  database();
  build(n);
  restart();
  // cold: the retained session is reset until the thread is warm, and the reason says so
  const why: { reason?: string } = {};
  expect(retainedSessionInvalid(LineageAllowance.tool(), thread, driver, session, why)).toBe(true);
  expect(why.reason).toBe("lineage-warming");
  warmToCompletion();
  const warmWhy: { reason?: string } = {};
  expect(retainedSessionInvalid(LineageAllowance.tool(), thread, driver, session, warmWhy), `a warm session stays (${warmWhy.reason})`).toBe(false);
  const warm = sqlWork(() => turnOf(n));
  expect(warm.value.excluded).toEqual([]);
  expect(warm.value.continuation).toBe(false);
  expect(warm.statements, "the turn after the warmer").toBeLessThan(WARM_STATEMENT_CAP);
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(source(5));
  const after = sqlWork(() => turnOf(n));
  expect(after.value.excluded.length).toBe(100);
  expect(after.statements).toBeLessThan(FORGET_STATEMENT_CAP);
}, 900_000);

it("a check that runs out of its allowance keeps what it finished: the next one gets further, and the one after the last reads far less", () => {
  const n = 40;
  database();
  build(n);
  restart();
  // an allowance a little short of what the window needs (about 1,100 nodes, content lookups included): the first check proves part of it
  setTurnLineageNodesForTest(1_060);
  const ask = () => { resetReplayRowsRead(); const turnAllowance = LineageAllowance.turn(); const spent = sqlWork(() => ({ excluded: replayExclusions(turnAllowance, thread, windowOf(n), null, { failClosed: true }).size, hit: turnAllowance.hit })); return { ...spent, kept: keptVerdictCount() }; };
  const first = ask();
  expect(first.value.excluded, "the first check could not prove the window").toBeGreaterThan(0);
  expect(first.value.hit).toBe(true);
  expect(first.kept, "but it kept what it proved").toBeGreaterThan(0);
  let last = first, rounds = 1;
  while (last.value.excluded > 0 && rounds < 20) { const before = last.kept; last = ask(); rounds++; expect(last.kept, "each check gets further").toBeGreaterThan(before - 1); }
  expect(last.value.excluded, "and it converges").toBe(0);
  const settled = ask();
  expect(settled.value.excluded).toBe(0);
  expect(settled.rows, "the check after the last reads far less than the first").toBeLessThan(first.rows / 2);
}, 900_000);
