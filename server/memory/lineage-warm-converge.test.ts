// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 (extreme scale, lineage-cold): the warmer converges, and what it calls warm is warm.
//
// - a retained session of 10,000 sound receipts, all listing one reply (Astra's lineage-cold review r1, finding 3), is proven a page of
//   receipts at a time, each page kept on top of the last, so slices too small to hold the whole session still get there; afterwards the turn
//   is cheap, not hit, and its verdict is the unbounded check's;
// - a turn that is short of room never shows the line: it withholds it (hit) or answers as the unbounded check does, and it gets further
//   each time;
// - lineageWarmIdle() is true only when every reply and session the warmer walked has a kept verdict; what cannot be kept is parked and counted;
// - one million messages with one early lineage pointer: every call of the warmer stays near its deadline, and yields to the owner between
//   pages; the discovery of threads is paged too;
// - successive sessions after a cold start: the first turn resets the old session for warming, the warmer finishes, the next session stays.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
// 1.0.2: this file drives the read-time root-set machinery over rows a 1.0.1 file holds; thaw the frozen root-set writes to model them.
beforeEach(() => thawRootSetWritesForTest(true));
afterEach(() => thawRootSetWritesForTest(false));
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { retainedSessionInvalid } from "./dispatch.ts";
import { bumpLineageWarm, kickLineageWarm, lineageWarmIdle, lineageWarmParked, lineageWarmStep, resetLineageWarmForTest, setLineageWarmSlicesForTest } from "./lineage-warm.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { stampFreshSession } from "./testing/writetime-fixture.ts";
import {
  capturedMessageWithheld, forgetKeptLineageForTest, keptVerdictCount, lineageUnkeptReasons, outputRootsFor, recordSessionRoots, replayExclusions, sessionLineageBad,
  setReplayNodeBudgetForTest, setTurnLineageNodesForTest,
} from "./replay-lineage.ts";

const thread = "conv-direct", driver = "drv", session = "sess";

beforeEach(() => { resetLineageWarmForTest(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { setReplayNodeBudgetForTest(null); setTurnLineageNodesForTest(null); setLineageWarmSlicesForTest(null, null); });

/** An upgrade restart: the file stays, nothing kept in memory does. */
function restart(): void { closeDatabase(); forgetKeptLineageForTest(); resetLineageWarmForTest(); database(); }
function warmToCompletion(limit = 100_000): number {
  kickLineageWarm();
  let steps = 0;
  while (lineageWarmStep(25)) { if (++steps > limit) throw new Error("the warmer did not finish"); }
  return steps;
}
/** One turn's check of the lines, on its own allowance. */
function turn(ids: readonly string[]): { excluded: string[]; hit: boolean; spent: number } {
  const budget = LineageAllowance.turn();
  const excluded = [...replayExclusions(budget, thread, ids.map(id => ({ id, role: "bot" })), null, { failClosed: true })].sort();
  return { excluded, hit: budget.hit, spent: budget.spent };
}
const reference = (ids: readonly string[]): string[] => {
  setReplayNodeBudgetForTest(1_000_000_000);
  try { return [...replayExclusions(LineageAllowance.tool(1_000_000_000), thread, ids.map(id => ({ id, role: "bot" })), null, { failClosed: true })].sort(); } finally { setReplayNodeBudgetForTest(null); }
};

/** One session of `receipts` sound receipts with identical empty cited lists, every one listing the single reply `r0`. */
function longSession(receipts: number): void {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), scope = ensureScope("conversation", thread);
  db.exec("BEGIN");
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')").run(`message:${thread}:r0`, scope, thread, "r0");
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, "r0", 0, "bot", "text", "reply", "{}");
  const add = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]','[\"r0\"]',0,0,0,'delivered',9)");
  for (let index = 0; index < receipts; index++) add.run(`rc${index}`, thread, driver, session);
  // a session this build started carries a lineage row (an empty set), or it would be reset as one that predates lineage
  recordSessionRoots(thread, driver, session, outputRootsFor(LineageAllowance.tool(1_000_000_000), []));
  stampFreshSession(db, thread, driver, session); // stamped as a 1.0.3 fresh start leaves it (S6 rule 26)
  db.exec("COMMIT");
  restart();
}

it("a session of 10,000 sound receipts listing one reply: after the warmer, the turn is not hit, costs little and allows the reply, as the unbounded check does", () => {
  database();
  longSession(10_000);
  expect(reference(["r0"])).toEqual([]);
  restart();
  warmToCompletion();
  expect(lineageWarmIdle(), `parked ${lineageWarmParked()}: ${lineageUnkeptReasons().join("; ")}`).toBe(true);
  expect(lineageWarmParked()).toBe(0);
  expect(keptVerdictCount()).toBeGreaterThan(0);
  const warm = turn(["r0"]);
  expect(warm.excluded).toEqual([]);
  expect(warm.hit).toBe(false);
  console.log(`LONG-SESSION 10,000 receipts, warm turn spent ${warm.spent} nodes`);
  expect(warm.spent).toBeLessThan(1_000);
  // and the session's receipts are proven: with no allowance at all the check answers from what is kept
  expect(sessionLineageBad(LineageAllowance.turn(0), thread, driver, session, null)).toBe(false);
}, 600_000);

/** One session of `receipts` identical sound receipts, each listing its own reply; only the newest reply exists as a message. */
function ownReplySession(receipts: number): string {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), scope = ensureScope("conversation", thread), last = `r${receipts - 1}`;
  db.exec("BEGIN");
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')").run(`message:${thread}:${last}`, scope, thread, last);
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, last, 0, "bot", "text", "reply", "{}");
  const add = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]',?,0,0,0,'delivered',9)");
  // the file's lineage repair ran in an earlier version (it would find ten thousand outputs and no roots, and withhold the reply: the marker says it is done)
  db.prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES('memory-lineage-backfill-v3',?,'system','lineage-backfill',0,'granted',?)").run(scope, JSON.stringify({ done: true }));
  for (let index = 0; index < receipts; index++) add.run(`rc${index}`, thread, driver, session, JSON.stringify([`r${index}`]));
  recordSessionRoots(thread, driver, session, outputRootsFor(LineageAllowance.tool(1_000_000_000), []));
  stampFreshSession(db, thread, driver, session); // stamped as a 1.0.3 fresh start leaves it (S6 rule 26)
  db.exec("COMMIT");
  restart();
  return last;
}

it("slices too small to hold the 10,000 receipts at once still get there: the receipts are proven a page at a time and each page is kept", () => {
  database();
  const last = ownReplySession(10_000);
  expect(reference([last])).toEqual([]);
  restart();
  // the newest reply first: its session is proven from the first receipt, in one jump no slice can pay for whole
  setLineageWarmSlicesForTest(80, 80);
  kickLineageWarm();
  let steps = 0;
  while (lineageWarmStep(0)) { if (++steps > 100_000) throw new Error("the warmer did not finish"); }
  expect(lineageWarmIdle(), `converged (parked ${lineageWarmParked()}: ${lineageUnkeptReasons().join("; ")})`).toBe(true);
  expect(lineageWarmParked()).toBe(0);
  expect(steps, "in many small steps").toBeGreaterThan(5);
  const warm = turn([last]);
  expect(warm).toMatchObject({ excluded: [], hit: false });
  expect(warm.spent).toBeLessThan(80);
}, 600_000);

it("a turn short of room never shows the line, and each turn gets further than the last until the answer is the unbounded one", () => {
  database();
  const last = ownReplySession(10_000);
  expect(reference([last])).toEqual([]);
  restart();
  setTurnLineageNodesForTest(100);
  let hits = 0, previous = keptVerdictCount(), last2 = turn([last]);
  while (last2.hit && hits < 200) {
    // withheld while unproven: never allowed before it is proven
    expect(last2.excluded, `turn ${hits} was short of room`).toEqual([last]);
    hits++;
    const now = keptVerdictCount();
    expect(now, `turn ${hits - 1} got further`).toBeGreaterThan(previous);
    previous = now;
    last2 = turn([last]);
  }
  console.log(`LONG-SESSION 10,000 receipts, allowance 100: ${hits} short turns, then ${JSON.stringify(last2)}`);
  expect(hits, "it took more than one turn").toBeGreaterThan(2);
  expect(hits, "and it converged").toBeLessThan(200);
  expect(last2.excluded).toEqual([]);
  expect(last2.hit).toBe(false);
}, 600_000);

it("a thread the warmer parks is not reported warm: idle holds only when every reply has a kept verdict", () => {
  database();
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), scope = ensureScope("conversation", thread);
  // a ring of replies each of whose receipts cites the next: a cycle no verdict can be kept through
  const n = 12;
  db.exec("BEGIN");
  for (let index = 0; index < n; index++) {
    db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')").run(`message:${thread}:r${index}`, scope, thread, `r${index}`);
    db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, `r${index}`, index, "bot", "text", `reply ${index}`, "{}");
  }
  for (let index = 0; index < n; index++) {
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,NULL,'[]',?,?,0,0,0,'delivered',9)")
      .run(`rc${index}`, thread, driver, JSON.stringify([{ id: `message:${thread}:r${(index + 1) % n}`, revision: 1 }]), JSON.stringify([`r${index}`]));
  }
  db.exec("COMMIT");
  const ids = Array.from({ length: n }, (_, index) => `r${index}`);
  const unbounded = reference(ids);
  restart();
  warmToCompletion();
  if (lineageWarmIdle()) {
    // idle means every verdict is kept: with no allowance at all each line is answered as the unbounded check answers it
    for (const id of ids) {
      const withheld = capturedMessageWithheld(LineageAllowance.turn(0), thread, id);
      expect(withheld, `idle, so ${id} is a lookup`).toBe(unbounded.includes(id));
    }
  } else expect(lineageWarmParked(), "not idle, so something is parked and counted").toBeGreaterThan(0);
});

it("one million messages and one early lineage pointer: every call stays near its deadline, yields to the owner, and the pointer's reply is warmed", () => {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), scope = ensureScope("conversation", thread);
  for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='messages' AND sql IS NOT NULL AND name<>'messages_thread'").all()) db.exec(`DROP INDEX ${String(row.name)}`);
  // (the bulk load is not what is measured: the triggers of this throwaway file's messages are dropped for it)
  for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='messages'").all()) db.exec(`DROP TRIGGER ${String(row.name)}`);
  db.exec("BEGIN");
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')").run(`message:${thread}:m3`, scope, thread, "m3");
  db.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000000)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT '${thread}','m'||n,n,'user','text','x','{}' FROM seq`);
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('rc3',?,?,NULL,'[]','[]','[\"m3\"]',0,0,0,'delivered',9)").run(thread, driver);
  db.exec("COMMIT");
  restart();
  kickLineageWarm();
  // the owner is waiting: one step and back
  const eager = performance.now();
  expect(lineageWarmStep(50, () => true)).toBe(true);
  expect(performance.now() - eager, "a call that yields does one step").toBeLessThan(40);
  let calls = 0, longest = 0;
  for (;;) {
    const started = performance.now();
    const more = lineageWarmStep(50);
    longest = Math.max(longest, performance.now() - started);
    calls++;
    if (!more) break;
    if (calls > 5_000) throw new Error("the warmer did not finish");
  }
  console.log(`MESSAGE-SCAN 1,000,000 messages: ${calls} calls, longest ${longest.toFixed(1)} ms`);
  expect(longest, "every call stays near its 50 ms deadline").toBeLessThan(100);
  expect(calls, "the scan was paged").toBeGreaterThan(5);
  expect(lineageWarmIdle()).toBe(true);
  expect(capturedMessageWithheld(LineageAllowance.turn(0), thread, "m3"), "the pointer's reply was warmed").toBe(false);
}, 900_000);

it("successive sessions after a cold start: the long session is reset once for warming, the warmer finishes, and the next sessions stay", () => {
  database();
  longSession(3_000);
  // (the session's own receipts: 3,000, under the 4,096 a retained session may hold)
  // cold: the session cannot be proven within one turn's allowance
  setTurnLineageNodesForTest(100);
  const first: { reason?: string } = {};
  expect(retainedSessionInvalid(LineageAllowance.turn(), thread, driver, session, first)).toBe(true);
  expect(first.reason).toBe("lineage-warming");
  // the turn's thread is wanted first, and the idle loop finishes it
  bumpLineageWarm(thread);
  setTurnLineageNodesForTest(null);
  warmToCompletion();
  expect(lineageWarmIdle()).toBe(true);
  const second: { reason?: string } = {};
  expect(retainedSessionInvalid(LineageAllowance.tool(), thread, driver, session, second), `reason ${second.reason}`).toBe(false);
  // a session the reset started is short and stays, turn after turn
  const db = database();
  recordSessionRoots(thread, driver, "fresh", outputRootsFor(LineageAllowance.tool(1_000_000_000), []));
  stampFreshSession(db, thread, driver, "fresh"); // the reset's fresh start stamps its row (S6 rule 26)
  for (let index = 0; index < 30; index++) {
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]','[]',0,0,0,'delivered',9)").run(`n${index}`, thread, driver, "fresh");
    const why: { reason?: string } = {};
    expect(retainedSessionInvalid(LineageAllowance.tool(), thread, driver, "fresh", why), `turn ${index}: ${why.reason}`).toBe(false);
  }
}, 600_000);
