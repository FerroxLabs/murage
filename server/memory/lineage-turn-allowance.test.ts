// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 (extreme scale, lineage-cold): ONE lineage allowance per turn.
//
// The server opens it around the whole turn setup (index.ts startTurn): the quoted old reply, the copied external replies, recall, the
// continuation checks and the replay window all draw on it, however many entry points they come through and across awaits, and it ends when the
// turn is dispatched (markDirectTurnDispatching), after which a check the running engine asks starts an allowance of its own. Each of the entry
// points (retainedSessionInvalid, continuationMemoryRevoked, buildMemoryBundle, the replay filters) joins an allowance already in force instead of
// starting another, so successive checks do not replenish it (Astra's lineage-cold review r1, finding 1).
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { retainedSessionInvalid } from "./dispatch.ts";
import { setMemoryMode } from "./repository.ts";
import { forgetKeptLineageForTest, newTurnLineageBudget, releaseTurnLineage, turnLineageHit, withTurnLineage } from "./replay-lineage.ts";

const thread = "allow-direct", driver = "drv", session = "sess";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

/** A retained session of `receipts` receipts (one lineage row), which a check of the session reads at a cost the allowance counts. */
function sessionOf(receipts: number): void {
  setMemoryMode("active");
  const db = database();
  db.exec("BEGIN");
  const add = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]','[]',0,0,0,'delivered',9)");
  for (let index = 0; index < receipts; index++) add.run(`rc${index}`, thread, driver, session);
  db.exec("COMMIT");
  closeDatabase(); forgetKeptLineageForTest(); database();
}
const check = (): { invalid: boolean; reason?: string } => { const why: { reason?: string } = {}; return { invalid: retainedSessionInvalid(thread, driver, session, why), reason: why.reason }; };

it("successive checks of one turn draw on the one allowance: each pays from what the last left, and the one that cannot pay is unproven", () => {
  sessionOf(480); // reading its receipts costs 30 nodes a check
  const turn = newTurnLineageBudget(70);
  const results = withTurnLineage(turn, () => [check(), check(), check()]);
  // the first two are not the allowance's concern (they stop at the session having no lineage row), but they spent from it
  expect(turn.spent, "every check paid from the same allowance").toBeGreaterThanOrEqual(60);
  expect(turn.hit, "the third found it empty").toBe(true);
  expect(results[2]!.reason).toBe("lineage-warming");
  // the same three checks without a turn around them each have an allowance of their own and none of them runs short
  forgetKeptLineageForTest();
  const alone = [check(), check(), check()];
  expect(alone.map(result => result.reason)).not.toContain("lineage-warming");
});

it("the allowance follows the turn across awaits", async () => {
  sessionOf(480);
  const turn = newTurnLineageBudget(70);
  const reasons: Array<string | undefined> = [];
  await withTurnLineage(turn, async () => {
    reasons.push(check().reason);
    await Promise.resolve();
    reasons.push(check().reason);
    await new Promise(resolve => setTimeout(resolve, 5));
    reasons.push(check().reason);
    expect(turnLineageHit()).toBe(true);
  });
  expect(reasons[2]).toBe("lineage-warming");
  expect(turn.spent).toBeGreaterThanOrEqual(60);
});

it("when the turn is dispatched its allowance ends: a check the running engine asks starts one of its own", () => {
  sessionOf(480);
  const turn = newTurnLineageBudget(70);
  withTurnLineage(turn, () => {
    check(); check();
    releaseTurnLineage();
    const spentAtDispatch = turn.spent;
    const later = [check(), check(), check()];
    expect(turn.spent, "nothing more was taken from the turn's allowance").toBe(spentAtDispatch);
    expect(later.map(result => result.reason)).not.toContain("lineage-warming");
    expect(turnLineageHit(), "and the hit of the setup is not the engine's").toBe(false);
  });
});

it("index.ts opens the allowance around the whole turn setup, closes it at dispatch, and quotes an old reply inside it", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");
  expect(source).toMatch(/async function startTurn\([\s\S]{0,1200}return withTurnLineage\(newTurnLineageBudget\(\), \(\) => startTurnAdmitting\(\.\.\.args\)\);/);
  expect(source).toMatch(/function markDirectTurnDispatching\([\s\S]{0,700}releaseTurnLineage\(\);/);
  expect(source).toMatch(/function replyForPrompt\([\s\S]{0,500}withTurnLineage\(newTurnLineageBudget\(\), \(\) => capturedMessageWithheld\(/);
  // every entry point joins an allowance in force rather than starting another
  for (const file of ["bundle.ts", "disclosures.ts", "dispatch.ts"]) expect(readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8")).toContain("withTurnLineage(newTurnLineageBudget()");
});
