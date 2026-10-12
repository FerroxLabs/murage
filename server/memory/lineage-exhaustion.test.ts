// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 (extreme scale, lineage-cold): running out of room is contained, and is told apart from a real withholding.
//
// - A check that cannot finish never throws out of failClosed: the cycle-disambiguation probe in the replay check is a read like any other and
//   can run out of the allowance; the lines it was about are withheld (Astra's lineage-cold review r1, finding 4: receipt rc2 citing r9 and rc8
//   citing r3 in the 12-reply legacy fixture, the second check throwing at an allowance a little past the first's). Swept over every allowance.
// - The unbounded reference really is unbounded (finding 6): 300 sound chained replies and a window of 100 are all allowed (it used to withhold
//   all 100: a session's receipts were judged at depth 0, which left nothing to bound the recursion down the conversation, so the walk overflowed
//   the stack at about 250 replies and the receipt allowance counted every repeated visit of the unfinished groups). The test tells
//   resource exhaustion (the counter of checks that ran out) from a withholding that is the answer.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { chainStore } from "./schema.ts";
import {
  forgetKeptLineageForTest, newTurnLineageBudget, REPLAY_RECEIPT_BUDGET, replayExclusions, replayLimitWithheld, setReplayNodeBudgetForTest, setTurnLineageNodesForTest, withTurnLineage,
} from "./replay-lineage.ts";

const thread = "exh-direct", driver = "drv", session = "sess";
const key = (reply: number) => `${thread}\u0000r${reply}`;
const source = (reply: number) => `message:${thread}:r${reply}`;

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { setReplayNodeBudgetForTest(null); setTurnLineageNodesForTest(null); });

/** `n` replies in one session, each receipt citing the reply before it; legacy output lists list every reply from the receipt's own on. */
function build(n: number, legacy: boolean): void {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), scope = ensureScope("conversation", thread), write = chainStore(db);
  db.exec("BEGIN");
  const addSource = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')");
  const addMessage = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const addReceipt = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]',?,?,0,0,0,'delivered',9)");
  for (let index = 0; index < n; index++) { addSource.run(source(index), scope, thread, `r${index}`); addMessage.run(thread, `r${index}`, index, "bot", "text", `reply ${index}`, "{}"); }
  for (let index = 0; index < n; index++) {
    const outputs = legacy ? Array.from({ length: n - index }, (_, at) => `r${index + at}`) : [`r${index}`];
    addReceipt.run(`rc${index}`, thread, driver, session, JSON.stringify(index ? [{ id: source(index - 1), revision: 1 }] : []), JSON.stringify(outputs));
  }
  let parent: string | null = null;
  const pointer = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  for (let index = 0; index < n; index++) { parent = write(parent, index, [key(index)]); pointer.run(thread, `r${index}`, parent); }
  db.prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES('memory-lineage-backfill-v3',?,'system','lineage-backfill',0,'granted',?)").run(scope, JSON.stringify({ done: true }));
  db.exec("COMMIT");
}
const lines = (from: number, to: number) => { const out: Array<{ id: string; role: string }> = []; for (let index = from; index >= to; index--) out.push({ id: `r${index}`, role: "bot" }); return out; };
const cold = (): void => { closeDatabase(); forgetKeptLineageForTest(); database(); };

it("a check that runs out in the cycle probe withholds the lines and never throws out of failClosed, at any allowance (rc2 -> r9, rc8 -> r3)", () => {
  database();
  build(12, true);
  const db = database();
  db.prepare("UPDATE memory_disclosures SET source_versions=? WHERE bundle_id='rc2'").run(JSON.stringify([{ id: source(9), revision: 1 }]));
  db.prepare("UPDATE memory_disclosures SET source_versions=? WHERE bundle_id='rc8'").run(JSON.stringify([{ id: source(3), revision: 1 }]));
  const windows = [lines(9, 0), lines(10, 0), lines(11, 0)];
  const unbounded = windows.map(window => {
    cold(); setReplayNodeBudgetForTest(1_000_000_000);
    try { return new Set(replayExclusions(thread, window, null, { failClosed: true })); } finally { setReplayNodeBudgetForTest(null); }
  });
  let swept = 0, exhausted = 0;
  for (let allowance = 10; allowance <= 900; allowance += 3) {
    windows.forEach((window, at) => {
      cold();
      const before = replayLimitWithheld();
      let result: Set<string> | undefined;
      expect(() => { result = withTurnLineage(newTurnLineageBudget(allowance), () => replayExclusions(thread, window, null, { failClosed: true })); }, `allowance ${allowance}, window ${at}`).not.toThrow();
      swept++;
      if (replayLimitWithheld() !== before) exhausted++;
      // withheld what the unbounded check withholds, however little room there was
      for (const id of unbounded[at]!) expect(result!.has(id), `allowance ${allowance}, window ${at}: ${id} is withheld by the unbounded check`).toBe(true);
    });
  }
  console.log(`CYCLE-FIXTURE swept ${swept} checks, ${exhausted} ran out of room, none threw`);
  expect(exhausted, "the sweep reached the exhausted paths").toBeGreaterThan(0);
  // and the same without a bound on the allowance still answers
  cold();
  expect(() => replayExclusions(thread, windows[1]!, null, { failClosed: true })).not.toThrow();
}, 600_000);

it("the unbounded reference allows a sound 300-reply chain: nothing in it ran out, and a forgotten deep root is still withheld as the answer", () => {
  database();
  build(300, false);
  cold();
  setReplayNodeBudgetForTest(1_000_000_000);
  const window = lines(299, 200);
  const before = replayLimitWithheld();
  const started = performance.now();
  const reference = [...replayExclusions(thread, window, null, { failClosed: true })];
  const took = performance.now() - started;
  setReplayNodeBudgetForTest(null);
  // (a session's receipts used to be judged at depth 0, so nothing bounded the recursion down a conversation: it overflowed the stack at about
  // 250 replies, minutes in, and the window was withheld. The depth is carried now and the walk hands over every HANDOFF_DEPTH replies.)
  expect(took, "the reference is a walk of the chain, not a stack overflow caught again and again").toBeLessThan(30_000);
  expect(replayLimitWithheld(), "no check ran out of a budget: an empty answer is the answer, not an exhausted one").toBe(before);
  expect(reference).toEqual([]);
  // a forgotten root deep in the chain: the same unbounded check withholds all 100, and nothing ran out for that either
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(source(5));
  cold();
  setReplayNodeBudgetForTest(1_000_000_000);
  const forgotten = replayExclusions(thread, window, null, { failClosed: true });
  setReplayNodeBudgetForTest(null);
  expect(forgotten.size).toBe(100);
  expect(replayLimitWithheld()).toBe(before);
  // the receipt allowance is a count of DISTINCT receipts, not of visits (the old count passed 65,536 on 300 receipts)
  expect(REPLAY_RECEIPT_BUDGET).toBe(65_536);
}, 300_000);
