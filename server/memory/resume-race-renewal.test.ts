// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 resume race after a restart (RESUME-RACE-DESIGN.md Part A).
//
// The first resumed turn after a restart judges its session cold. A slow recall can spend the turn's whole lineage time (TURN_LINEAGE_MS)
// in its timed reads; the after-recall check then cannot finish ("lineage-warming") and the session resets, which is right (fail closed).
// The rebuild that follows (the replay re-filter and the memory block) ran on the SAME spent allowance, so it withheld every line it could
// not pay for and hydrated no evidence: the bot forgot the conversation. The turn now renews its allowance ONCE at the reset decision.
//
// The race is made deterministic: the time budget is the real 50 ms (setLineageTimeBudgetForTest) and the first record read of the recall
// (readable.ts readRecord, inside the allowance's timed section) is held 100 ms through the DatabaseSync.prototype.prepare wrapper that
// lineage-cold-turn.test.ts uses. The sequence below is index.ts's after-recall path, step for step.
import { mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { forgetKeptLineageForTest, thawRootSetWritesForTest } from "./replay-lineage.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { saveMemoryCandidate } from "./authority.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { captureBranchChange, captureSource } from "./capture.ts";
import { captureWork } from "./chunks.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { filterDirectReplay, resetSessionHolds } from "./disclosures.ts";
import { buildMemoryBundleAfterReset, MemoryDispatchReceipt, resumedSessionInvalidAfterRecall } from "./dispatch.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { LineageAllowance, setLineageTimeBudgetForTest } from "./lineage-allowance.ts";
import { resetLineageWarmForTest } from "./lineage-warm.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { stampFreshSession } from "./testing/writetime-fixture.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
// this test models a 1.0.1-shaped session (legacy root-set rows) for the read-time judge, as resume-after-recall.test.ts does
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => thawRootSetWritesForTest(false));

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
const registry = new InternalCapabilities();
const empty = { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } };
function access() {
  registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}

/** Holds the first record read (readable.ts RECORD_SQL) once armed: the slow recall of a cold first turn, made exact. */
const slow = { armed: false, held: 0 };
const realPrepare = DatabaseSync.prototype.prepare;
beforeAll(() => {
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = realPrepare.call(this, sql);
    if (!/^SELECT \* FROM memory_records WHERE id=\? AND version=\?/.test(sql)) return statement;
    const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    const get = statement.get.bind(statement);
    own.get = (...args) => {
      if (slow.armed) { slow.armed = false; slow.held++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
      return (get as (...a: unknown[]) => unknown)(...args);
    };
    return statement;
  } as typeof realPrepare;
});
afterAll(() => { DatabaseSync.prototype.prepare = realPrepare; });
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active"); reconcileMemoryRoster(roster);
  slow.armed = false; slow.held = 0;
});
afterEach(() => { setLineageTimeBudgetForTest(undefined); slow.armed = false; });

/** The conversation as a restart finds it: the owner's line u1 (the thread's checkpoint rests on it), and the bot's reply-1, made in
 * session s1 from a record resting on thread "older"'s message m1. */
async function conversation(): Promise<{ checkpoint: { id: string; version: number } }> {
  const db = database();
  storeAnchorMessage(db, "chat", "u1", "Please keep the gate code handy.", "user", 1);
  captureSource(db, { id: "message:chat:u1", threadId: "chat", messageId: "u1", kind: "text", speaker: "owner", outcome: "recorded", text: "Please keep the gate code handy." });
  const work = claimMemoryJob("resume-race-fixture");
  if (!work) throw new Error("no capture job");
  publishMemoryWork(work, "resume-race-fixture", captureWork(work));
  const result = refreshMemoryCheckpoint(work.id);
  if (result.status !== "updated") throw new Error("no checkpoint published");
  const text = "The alarm code is 4812.";
  storeAnchorMessage(db, "older", "m1", text, "user", 2);
  captureSource(db, { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const turn = access();
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", turn);
  db.prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const receipt = new MemoryDispatchReceipt(await buildMemoryBundle("", turn, empty, { allowance: LineageAllowance.tool() }), turn, "engine");
  receipt.sessionStarted("s1");
  stampFreshSession(db, "chat", "engine", "s1");
  receipt.noteLookup([{ id: record, version: 1, evidence: [{ sourceId: "message:older:m1", revision: 1 }] }], turn);
  receipt.accepted();
  storeAnchorMessage(db, "chat", "reply-1", "Noted: the alarm code is 4812.", "bot", 3);
  receipt.output("reply-1");
  return { checkpoint: { id: result.checkpointId, version: result.version } };
}
/** A restart: the file stays, every verdict kept in memory goes. */
function restart(): void { closeDatabase(); forgetKeptLineageForTest(); resetLineageWarmForTest(); resetSessionHolds(); database(); }
const lines = [
  { id: "u1", role: "user", kind: "text", text: "Please keep the gate code handy." },
  { id: "reply-1", role: "bot", kind: "text", text: "Noted: the alarm code is 4812." },
  { id: "u2", role: "user", kind: "text", text: "What did we agree on?" },
];

/** The first resumed turn after the restart, as index.ts runs it: one turn allowance, a slow recall on it, the after-recall check, and
 * on reset (the cursor dropped) the memory block and the replay rebuilt on the same allowance, renewed at the reset. */
async function firstTurnAfterRestart() {
  setLineageTimeBudgetForTest(50);
  const allowance = LineageAllowance.turn();
  const turn = access();
  slow.armed = true;
  await buildMemoryBundle("what did we agree on", turn, empty, { allowance, excludeMessageIds: ["u2"] });
  const why: { reason?: string } = {};
  // the stamp moved since the dispatch check (the turn's own capture does), so the check runs whole
  const reset = resumedSessionInvalidAfterRecall(allowance, "chat", "engine", "s1", turn, undefined, why);
  // index.ts: the reset is decided, the allowance is renewed once, then the rebuild
  const renewed = reset ? (allowance as { renew?: () => boolean }).renew?.() ?? false : false;
  const bundle = await buildMemoryBundleAfterReset("what did we agree on", turn, empty, async () => {}, { allowance, excludeMessageIds: ["u2"] });
  const replay = filterDirectReplay(allowance, "chat", lines, turn, new Set(["u2"]));
  return { reset, reason: why.reason, renewed, bundle, replayed: replay.replayed.map(line => line.id), allowance };
}

it("the reset turn after a restart has the full replay and the memory block, though recall spent the turn's lineage time", async () => {
  const { checkpoint } = await conversation();
  restart();
  const turn = await firstTurnAfterRestart();
  expect(slow.held, "the recall's record read was held").toBe(1);
  // the cursor is still dropped: a check that could not finish proves nothing (fail closed)
  expect(turn.reset).toBe(true);
  expect(turn.reason).toBe("lineage-warming");
  // ...and the new session is given everything that is authorized
  expect(turn.replayed, "the full authorized replay").toEqual(["u1", "reply-1"]);
  expect(turn.bundle.recordVersions, "the memory block (the thread's checkpoint)").toContainEqual(checkpoint);
  expect(turn.bundle.text).toContain("gate code");
  expect(turn.renewed, "the reset renewed the allowance").toBe(true);
});

it("a real revoke stays out after the renewal: the renewed rebuild still withholds what rests on a retired source", async () => {
  const { checkpoint } = await conversation();
  restart();
  // thread "older"'s message leaves its branch: reply-1 rests on it
  captureBranchChange(database(), "older", null);
  expect(String(database().prepare("SELECT state FROM memory_sources WHERE id='message:older:m1'").get()!.state)).toBe("retired");
  const turn = await firstTurnAfterRestart();
  expect(turn.reset).toBe(true);
  expect(turn.replayed, "the revoked reply is not replayed, the rest is").toEqual(["u1"]);
  expect(JSON.stringify(turn.bundle.sourceVersions)).not.toContain("message:older:m1");
  expect(turn.bundle.text).not.toContain("4812");
  // the renewal funded the rebuild: the authorized memory block is there
  expect(turn.bundle.recordVersions).toContainEqual(checkpoint);
  expect(turn.renewed).toBe(true);
});

it("an allowance renews once: a second renewal, a closed allowance and a renewal inside a timed read are refused; everHit survives", () => {
  const allowance = LineageAllowance.turn(10);
  expect(() => allowance.spendNodes("t", 11)).toThrow("MEMORY_REPLAY_LIMIT");
  expect(allowance.hit).toBe(true);
  expect(allowance.renew()).toBe(true);
  expect(allowance.hit).toBe(false);
  expect(allowance.everHit, "the warmer's guaranteed slice still follows the first exhaustion").toBe(true);
  expect(allowance.room()).toBe(10);
  allowance.spendNodes("t", 10);
  expect(allowance.spentOut()).toBe(true);
  // a loop of resets cannot refill it
  expect(allowance.renew()).toBe(false);
  expect(allowance.spentOut()).toBe(true);
  expect(() => allowance.spendNodes("t", 1)).toThrow("MEMORY_REPLAY_LIMIT");
  // a closed allowance (setup over) is never reopened
  const closed = LineageAllowance.turn(10);
  closed.close();
  expect(closed.renew()).toBe(false);
  expect(closed.room()).toBe(0);
  // the time budget renews too, once
  setLineageTimeBudgetForTest(50);
  const timed = LineageAllowance.turn();
  timed.timed(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60));
  expect(timed.overTime()).toBe(true);
  expect(timed.timed(() => timed.renew()), "not inside a timed read").toBe(false);
  expect(timed.renew()).toBe(true);
  expect(timed.overTime()).toBe(false);
  timed.timed(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60));
  expect(timed.renew()).toBe(false);
  expect(timed.overTime()).toBe(true);
});

it("index.ts renews at each reset decision, right after the reset is noted, and nowhere else", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const sites = [
    "noteContinuationReset(threadId,instanceId,reason);",
    "noteContinuationReset(threadId,instanceId,`after-recall ${lateWhy.reason??\"check-failed\"}`);",
    "noteContinuationReset(threadId, instanceId, `memory-${memoryState().mode} ${offWhy.reason ?? \"check-failed\"}`);",
    "if(roomLastResort||sessionBad||(retained&&(retained.disclosed||outputRootsBad(allowance,retained.roots)))){",
  ];
  for (const site of sites) {
    const at = source.indexOf(site);
    expect(at, site).toBeGreaterThan(0);
    expect(source.slice(at, at + 420), site).toMatch(/allowance\.renew\(\)/);
  }
  expect(source.split("allowance.renew()").length - 1).toBe(4);
  // the after-recall reset redoes the replay filtered on the spent allowance
  expect(source).toContain("if(allowance.renew())replayStamp=undefined;");
  // the warmer's guaranteed slice follows any exhaustion of the turn, renewed or not
  expect(source).not.toContain("if (allowance.hit) guaranteeLineageWarmSlice();");
  expect(source.split("if (allowance.everHit) guaranteeLineageWarmSlice();").length - 1).toBe(2);
});

