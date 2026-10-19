// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 (extreme scale, lineage-cold): the allowance is a value, owned by the work, never looked up.
//
// A turn (index.ts startTurn) creates ONE LineageAllowance and passes it to everything that checks lineage: the quoted old reply, the copied
// external replies, working context, recall, the continuation check, the replay window and the output roots. Every reader takes it as a
// REQUIRED parameter, so a reader that is given none does not compile; spending on a closed allowance stops the read with the limit error,
// so a check that ran after the turn's setup (or outside any turn) is refused, never free. Successive checks do not replenish it.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { retainedSessionInvalid } from "./dispatch.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { chainStore } from "./schema.ts";
import { shownLinesRoots } from "../steer-lineage.ts";
import { capturedMessageWithheld, forgetKeptLineageForTest, isLineageLimit, replayExclusions, replayRowsRead, resetReplayRowsRead, TURN_LINEAGE_NODES } from "./replay-lineage.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { writerAllowance } from "./replay-lineage.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const thread = "allow-direct", driver = "drv", session = "sess";
const here = dirname(fileURLToPath(import.meta.url));

// closeDatabase stops the WAL checkpointer without waiting; one still alive when the data dir is deleted and rebuilt removes the NEW file's -wal/-shm
// by path (or leaves the directory non-empty for the delete), so every close that precedes a delete awaits it.
beforeEach(async () => { closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

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
const check = (allowance: LineageAllowance): { invalid: boolean; reason?: string } => {
  const why: { reason?: string } = {};
  return { invalid: retainedSessionInvalid(allowance, thread, driver, session, why), reason: why.reason };
};

it("successive checks of one turn draw on the one allowance: each pays from what the last left, and the one that cannot pay is unproven", () => {
  sessionOf(480); // reading its receipts costs 30 nodes a check
  const turn = LineageAllowance.turn(70);
  const results = [check(turn), check(turn), check(turn)];
  // the first two are not the allowance's concern (they stop at the session having no lineage row), but they spent from it
  expect(turn.spent, "every check paid from the same allowance").toBeGreaterThanOrEqual(60);
  expect(turn.hit, "the third found it empty").toBe(true);
  expect(results[2]!.reason).toBe("lineage-warming");
  // the same three checks, each with an allowance of its own, none of them runs short
  forgetKeptLineageForTest();
  const alone = [check(LineageAllowance.turn(70)), check(LineageAllowance.turn(70)), check(LineageAllowance.turn(70))];
  expect(alone.map(result => result.reason)).not.toContain("lineage-warming");
});

it("the allowance follows the turn across awaits", async () => {
  sessionOf(480);
  const turn = LineageAllowance.turn(70);
  const reasons: Array<string | undefined> = [];
  reasons.push(check(turn).reason);
  await Promise.resolve();
  reasons.push(check(turn).reason);
  await new Promise(resolve => setTimeout(resolve, 5));
  reasons.push(check(turn).reason);
  expect(turn.hit).toBe(true);
  expect(reasons[2]).toBe("lineage-warming");
  expect(turn.spent).toBeGreaterThanOrEqual(60);
});

it("a closed allowance is refused, never free: a check made after the turn's setup is unproven and reads nothing", () => {
  sessionOf(480);
  const turn = LineageAllowance.turn(1_000_000);
  expect(check(turn).reason).not.toBe("lineage-warming");
  turn.close();
  const spentAtClose = turn.spent;
  const later = check(turn);
  expect(later.invalid).toBe(true);
  expect(later.reason).toBe("lineage-warming");
  expect(turn.spent, "nothing more was taken from the closed allowance").toBe(spentAtClose);
  expect(() => turn.spendNodes(thread, 1)).toThrow("MEMORY_REPLAY_LIMIT");
  expect(() => turn.spendRows(thread, 1)).toThrow("MEMORY_REPLAY_LIMIT");
  expect(() => turn.rowRoom(thread, 1)).toThrow("MEMORY_REPLAY_LIMIT");
  // a reply is withheld (unproven) against a closed allowance, whatever the history holds
  expect(capturedMessageWithheld(turn, thread, "any-reply")).toBe(true);
  expect(replayExclusions(turn, thread, [{ id: "any-reply", role: "bot" }], null, { failClosed: true }).has("any-reply")).toBe(true);
  try { turn.spendNodes(thread, 1); } catch (error) { expect(isLineageLimit(error)).toBe(true); }
});

it("there is no unlimited allowance: a writer's allowance names its reason and is bounded by what a set at the root ceiling costs", () => {
  const writer = writerAllowance("writer: test");
  expect(writer.scope).toBe("writer");
  expect(writer.reason).toBe("writer: test");
  expect(Number.isFinite(writer.room())).toBe(true);
  expect(() => writer.spendNodes(thread, writer.room() + 1)).toThrow("MEMORY_REPLAY_LIMIT");
  expect(writer.hit).toBe(true);
  for (const made of [LineageAllowance.turn(), LineageAllowance.room(), LineageAllowance.tool(), LineageAllowance.steer(), LineageAllowance.warm(5)]) expect(Number.isFinite(made.room())).toBe(true);
  expect("unmetered" in LineageAllowance).toBe(false);
});

it("a reader called with no allowance does not compile", () => {
  const never = false as boolean;
  if (never) {
    // @ts-expect-error the allowance is a required parameter
    capturedMessageWithheld(thread, "reply");
    // @ts-expect-error the allowance is a required parameter
    replayExclusions(thread, [], null);
    // @ts-expect-error the allowance is a required parameter
    retainedSessionInvalid(thread, driver, session);
  }
  expect(never).toBe(false);
});

it("the turn creates its allowance, threads it to the engine send, and closes it after the output roots; the ambient allowance is gone", () => {
  const server = join(here, "..");
  const source = readFileSync(join(server, "index.ts"), "utf8");
  expect(source).toMatch(/async function startTurn\([\s\S]{0,1800}const allowance = LineageAllowance\.turn\(\);\s*return startTurnAdmitting\(allowance, \.\.\.args\);/);
  // closed when the task ends, and when a start that failed after admission gives the thread back (admitted-turn.ts)
  expect(source).toMatch(/\}\)\(\)\.finally\(\(\) => allowance\.close\(\)\);\s*\}, \(error, phase\) => \{ allowance\.close\(\); giveBackAdmittedTurn\(run, bot\.id, threadId, admitted, phase, error, opts\?\.onDispatchError\); \}\);\s*return userMessage;/);
  expect(source).toMatch(/endLineage\(\);[\s\S]{0,400}allowance\.close\(\);/);
  expect(source).toMatch(/function replyForPrompt\([\s\S]{0,700}capturedMessageVerdict\(LineageAllowance\.tool\(\), threadId, target\.id\)/);
  // a member's turn in a room owns one allowance for its setup too
  expect(source).toMatch(/async function runGroupMemberTurn\([\s\S]{0,3500}const allowance = LineageAllowance\.room\(\);/);
  expect(source).toMatch(/roomTranscriptForTurn\(allowance,threadId/);
  // nothing ambient is left: no store, no wrapper, no phase marker
  const files: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(path); } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) files.push(path); } };
  walk(server);
  for (const file of files) {
    // root-set-reclaim.ts names an owner-activity gate method liveTurn() (is an owner turn running); it is not the ambient turn store
    if (/[\\/]memory[\\/]root-set-reclaim\.ts$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    expect(text, file).not.toMatch(/withTurnLineage|releaseTurnLineage|turnStore|liveTurn\(|turnLineageHit|newTurnLineageBudget|AsyncLocalStorage<TurnLineage/);
  }
  // every whole-read writer says why (grep-able)
  const replay = readFileSync(join(server, "memory", "replay-lineage.ts"), "utf8");
  expect([...replay.matchAll(/LineageAllowance\.unmetered\("([^"]+)"\)/g)].map(match => match[1]).every(reason => reason!.startsWith("writer: "))).toBe(true);
});

// ---- the finding of the second review: working context quoting an old reply of a cold task B --------------------------------------------

/** Task B's history: `n` sound replies, each resting on the one before it (its receipt cites the previous reply), as the review built it. */
function coldTaskB(n: number): string {
  const taskB = "task-b";
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: taskB }], groups: [] });
  const db = database(), scope = ensureScope("conversation", taskB), write = chainStore(db);
  db.exec("BEGIN");
  const addSource = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:b','settled',NULL,'active')");
  const addMessage = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const addReceipt = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]',?,?,0,0,0,'delivered',9)");
  for (let index = 0; index < n; index++) { addSource.run(`message:${taskB}:r${index}`, scope, taskB, `r${index}`); addMessage.run(taskB, `r${index}`, index, "bot", "text", `reply ${index}`, "{}"); }
  for (let index = 0; index < n; index++) addReceipt.run(`rc${index}`, taskB, driver, session, JSON.stringify(index ? [{ id: `message:${taskB}:r${index - 1}`, revision: 1 }] : []), JSON.stringify([`r${index}`]));
  let parent: string | null = null;
  const pointer = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  for (let index = 0; index < n; index++) { parent = write(parent, index, [`${taskB}\u0000r${index}`]); pointer.run(taskB, `r${index}`, parent); }
  db.prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES('memory-lineage-backfill-v3',?,'system','lineage-backfill',0,'granted',?)").run(scope, JSON.stringify({ done: true }));
  db.exec("COMMIT");
  closeDatabase(); forgetKeptLineageForTest(); database();
  return taskB;
}

it("the first message of chat A quoting the newest reply of a cold task B: the lineage reads are charged to the turn (nodes > 0, at most the allowance) and the work does not follow B's history (r2: 0 charged, 141,853 to 1,047,941 rows)", async () => {
  const work: Record<number, { rows: number; spent: number; withheld: boolean; over: boolean }> = {};
  for (const n of [300, 600, 1_200]) {
    closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database();
    const taskB = coldTaskB(n);
    const turn = LineageAllowance.turn();
    resetReplayRowsRead();
    // working context: the reader of the quoted reply, then the output roots of the lines the turn shows
    const withheld = capturedMessageWithheld(turn, taskB, `r${n - 1}`);
    const roots = shownLinesRoots(turn, [{ threadId: taskB, id: `r${n - 1}`, role: "bot" }]);
    work[n] = { rows: replayRowsRead(), spent: turn.spent, withheld, over: roots.over };
    expect(turn.spent, `n=${n}: the reads are charged`).toBeGreaterThan(0);
    expect(turn.spent, `n=${n}: and no more than the allowance`).toBeLessThanOrEqual(TURN_LINEAGE_NODES);
    expect(withheld, `n=${n}: a reply that could not be proven is not shown`).toBe(true);
    expect(replayRowsRead(), `n=${n}: rows the checks read`).toBeLessThanOrEqual(TURN_LINEAGE_NODES * 16);
    // after the turn's setup the allowance is closed: whatever reads later is refused, never free
    turn.close();
    expect(capturedMessageWithheld(turn, taskB, `r${n - 2}`)).toBe(true);
    // the roots step takes the renderer's decision, never a second judgement: a line the prompt carried in words keeps its roots even
    // with the allowance closed (the line itself, judged when a reply resting on it is), and only a line the renderer showed as its
    // withheld line contributes none
    const shownLine = { threadId: taskB, id: `r${n - 2}`, role: "bot" };
    const kept = shownLinesRoots(turn, [shownLine]);
    expect(kept.over || kept.roots.size > 0, "a line in the prompt is never recorded as having no roots").toBe(true);
    expect(kept.roots.has(`${taskB}\u0000r${n - 2}`)).toBe(true);
    expect(shownLinesRoots(turn, [shownLine], { threadId: taskB, ids: new Set([`r${n - 2}`]) }).roots.size).toBe(0);
    expect(turn.spent, "nothing was taken after it closed").toBe(work[n]!.spent);
  }
  console.log(`COLD-TASK-B working context: 300=${JSON.stringify(work[300])} 600=${JSON.stringify(work[600])} 1200=${JSON.stringify(work[1_200])}`);
  // (the allowance, not the history, decides the work: 3,000 nodes at every length; the rows differ only by the receipt count probe, capped at the thread's 2,048)
  expect(work[1_200]!.rows, "flat in the length of B's history").toBeLessThanOrEqual(work[300]!.rows * 1.25);
  expect(work[1_200]!.spent).toBeLessThanOrEqual(work[300]!.spent * 1.1);
}, 300_000);
