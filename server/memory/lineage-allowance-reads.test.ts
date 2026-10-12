// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 (extreme scale, lineage-cold): the reads of a turn's checks are paid for from the turn's allowance, measured in ROWS READ and not in
// statements. A read that cannot be paid for is not made: it returns unproven (withheld), never an uncharged scan.
//
// - a retained session's root-set chain (sessionOutputRoots, called by the continuation checks): with no allowance left a cold chain of 300,
//   1,500 or 12,000 sets reads the same, constant, number of rows; with a small one it is read page by page and a later call goes on from
//   where the last stopped, so the total follows the chain and no single call follows more than its allowance;
// - the receipts of a retained session (retainedSessionInvalid): never more rows than the allowance can pay for, however long the session;
// - the kept receipt groups of a thread are brought up to date without a scan of the thread's receipts.
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { retainedSessionInvalid } from "./dispatch.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { resetRootSetWork, rootSetWork } from "./root-set-handles.ts";
import {
  forgetKeptLineageForTest, newTurnLineageBudget, replayExclusions, ROWS_PER_NODE, sessionOutputRoots, setTurnLineageNodesForTest, turnLineageHit, withTurnLineage,
  type TurnLineageBudget,
} from "./replay-lineage.ts";
import { chainStore } from "./schema.ts";

const thread = "reads-direct", driver = "drv", session = "sess";
const key = (index: number) => `${thread}\u0000r${index}`;

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { setTurnLineageNodesForTest(null); });

const tally = { rows: 0, statements: 0, sql: [] as string[] };
const realPrepare = DatabaseSync.prototype.prepare;
beforeAll(() => {
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = realPrepare.call(this, sql);
    const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    const get = statement.get.bind(statement), all = statement.all.bind(statement);
    own.get = (...args) => { tally.statements++; tally.sql.push(sql); const row = (get as (...a: unknown[]) => unknown)(...args); if (row) tally.rows++; return row; };
    own.all = (...args) => { tally.statements++; tally.sql.push(sql); const rows = (all as (...a: unknown[]) => unknown[])(...args); tally.rows += rows.length; return rows; };
    return statement;
  } as typeof realPrepare;
});
afterAll(() => { DatabaseSync.prototype.prepare = realPrepare; });
function measured<T>(run: () => T): { value: T; rows: number; sql: string[] } {
  const before = { rows: tally.rows, at: tally.sql.length };
  const value = run();
  return { value, rows: tally.rows - before.rows, sql: tally.sql.slice(before.at) };
}
const allowance = (nodes: number): TurnLineageBudget => newTurnLineageBudget(nodes);

/** A session whose root set is a chain of `n` sets, each adding one root. */
function chain(n: number): void {
  setMemoryMode("active");
  const db = database(), write = chainStore(db);
  db.exec("BEGIN");
  let parent: string | null = null;
  for (let index = 0; index < n; index++) parent = write(parent, index, [key(index)]);
  db.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES(?,?,?,?)").run(thread, driver, session, parent);
  db.exec("COMMIT");
  closeDatabase(); forgetKeptLineageForTest(); database();
}

it("a cold root chain read with no allowance left reads a constant number of rows, whether it holds 300, 1,500 or 12,000 sets, and is unproven", () => {
  const measuredRows: Record<number, { rows: number; chain: number }> = {};
  for (const n of [300, 1_500, 12_000]) {
    closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
    database();
    chain(n);
    resetRootSetWork();
    const spent = measured(() => withTurnLineage(allowance(0), () => ({ roots: sessionOutputRoots(thread, driver, session, { metered: true }), hit: turnLineageHit() })));
    expect(spent.value.roots.over).toBe(true);
    expect(spent.value.roots.unproven).toBe(true);
    expect(spent.value.hit, "the turn knows it ran out").toBe(true);
    measuredRows[n] = { rows: spent.rows, chain: rootSetWork().rows };
    // not one row of the chain: the session's own row, the set's size and the stamps the kept state is checked against
    expect(measuredRows[n]!.chain).toBe(0);
    expect(spent.rows).toBeLessThanOrEqual(8);
  }
  console.log(`ROOT-CHAIN zero allowance: 300=${JSON.stringify(measuredRows[300])} 1500=${JSON.stringify(measuredRows[1_500])} 12000=${JSON.stringify(measuredRows[12_000])}`);
  expect(measuredRows[1_500]!.rows).toBe(measuredRows[300]!.rows);
  expect(measuredRows[12_000]!.rows).toBe(measuredRows[300]!.rows);
}, 300_000);

it("a cold root chain is read page by page within the allowance, a later call goes on from where the last stopped, and a warm chain costs nothing", () => {
  const n = 12_000;
  chain(n);
  const pageBudget = 40; // nodes: 640 rows a call
  let calls = 0, total = 0, widest = 0, roots: ReturnType<typeof sessionOutputRoots> | undefined;
  resetRootSetWork();
  for (; calls < 400; calls++) {
    const spent = measured(() => withTurnLineage(allowance(pageBudget), () => sessionOutputRoots(thread, driver, session, { metered: true })));
    roots = spent.value;
    total += spent.rows; widest = Math.max(widest, spent.rows);
    if (!roots.over) break;
    expect(roots.unproven, "short of room, not past the ceiling").toBe(true);
  }
  expect(roots!.over).toBe(false);
  expect(roots!.roots.size).toBe(n);
  expect(widest, "no call read more than its allowance pays for (plus the session's own row)").toBeLessThanOrEqual(pageBudget * ROWS_PER_NODE + 8);
  // two rows a set (its link and its member), read once: the total follows the chain, not the number of calls
  expect(rootSetWork().rows).toBeLessThanOrEqual(2 * n + 2);
  expect(total).toBeLessThanOrEqual(2 * n + 6 * calls + 16);
  expect(calls, "it took several calls").toBeGreaterThan(5);
  console.log(`ROOT-CHAIN n=${n} page budget ${pageBudget}: ${calls + 1} calls, widest ${widest} rows, total ${total} rows, chain rows ${rootSetWork().rows}`);
  // warm: with no allowance the same set is answered from the kept handle
  const warm = measured(() => withTurnLineage(allowance(0), () => sessionOutputRoots(thread, driver, session, { metered: true })));
  expect(warm.value.over).toBe(false);
  expect(warm.rows).toBeLessThanOrEqual(8);
}, 300_000);

for (const receipts of [1_000, 4_000]) it(`the receipts of a retained session of ${receipts} are read no further than the allowance pays for (retainedSessionInvalid)`, () => {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), scope = ensureScope("conversation", thread);
  void scope;
  db.exec("BEGIN");
  const add = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]','[]',0,0,0,'delivered',9)");
  for (let index = 0; index < receipts; index++) add.run(`rc${index}`, thread, driver, session);
  db.exec("COMMIT");
  closeDatabase(); forgetKeptLineageForTest(); database();
  // none left: nothing is read at all, and the session is reset until the thread is warm
  const none: { reason?: string } = {};
  const zero = measured(() => withTurnLineage(allowance(0), () => retainedSessionInvalid(thread, driver, session, none)));
  expect(zero.value).toBe(true);
  expect(none.reason).toBe("lineage-warming");
  expect(zero.sql.filter(sql => sql.includes("FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?"))).toEqual([]);
  // a little: it reads what that pays for and one row more to learn there is more, and stops
  const some: { reason?: string } = {};
  const few = measured(() => withTurnLineage(allowance(10), () => retainedSessionInvalid(thread, driver, session, some)));
  expect(few.value).toBe(true);
  expect(some.reason).toBe("lineage-warming");
  expect(few.rows).toBeLessThanOrEqual(10 * ROWS_PER_NODE + 4);
  console.log(`SESSION-RECEIPTS ${receipts}: no allowance ${zero.rows} rows, 10 nodes ${few.rows} rows`);
}, 120_000);

it("the kept receipt groups of a thread are brought up to date by a look at the newest receipts of the table, never a scan of the thread's own", () => {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), scope = ensureScope("conversation", thread);
  db.exec("BEGIN");
  const addSource = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')");
  const addMessage = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const add = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]',?,?,0,0,0,'delivered',9)");
  const replies = 30, receipts = 600;
  for (let index = 0; index < replies; index++) { addSource.run(`message:${thread}:r${index}`, scope, thread, `r${index}`); addMessage.run(thread, `r${index}`, index, "bot", "text", `reply ${index}`, "{}"); }
  // every receipt lists every reply (a thread whose lists are the legacy ones): the pairs outnumber the receipts, so the thread's groups are judged
  const all = JSON.stringify(Array.from({ length: replies }, (_, index) => `r${index}`));
  for (let index = 0; index < receipts; index++) add.run(`rc${index}`, thread, driver, `s${index % 7}`, JSON.stringify([{ id: `message:${thread}:r${index % replies}`, revision: 1 }]), all);
  db.exec("COMMIT");
  closeDatabase(); forgetKeptLineageForTest(); database();
  const window = Array.from({ length: replies }, (_, index) => ({ id: `r${index}`, role: "bot" }));
  const ask = () => measured(() => withTurnLineage(newTurnLineageBudget(1_000_000), () => replayExclusions(thread, window, null, { failClosed: true })));
  ask(); // reads the thread's groups
  const again = ask(); // brings them up to date
  const probes = again.sql.filter(sql => /FROM memory_disclosures/.test(sql) && /thread_id=\?/.test(sql) && /count\(\*\)/.test(sql) && /max\(rowid\)/.test(sql));
  expect(probes, "no count and newest over the thread's receipts").toEqual([]);
  expect(again.sql.some(sql => sql === "SELECT max(rowid) AS top FROM memory_disclosures")).toBe(true);
  // a new receipt is read and merged; the others are not read again
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('rc-new',?,?,?,'[]','[]','[]',0,0,0,'delivered',9)").run(thread, driver, "s1");
  const merged = ask();
  expect(merged.sql.some(sql => /NOT INDEXED WHERE thread_id=\? AND rowid>\?/.test(sql)), "only the receipts written since are read").toBe(true);
  expect(merged.rows, "and the answer is cheap").toBeLessThan(again.rows + 40);
});
