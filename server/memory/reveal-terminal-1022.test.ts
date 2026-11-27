// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: lane q1022-idleburn-opus owns these witnesses; reveal-capture.ts owns the receipts, the scan and the sweep; index.ts owns the idle
// lane that drives them (pendingBotRevealJobs then captureBotReveals, index.ts onIdleConsolidation lane 0, and onCompletedSource).
//
// 1.0.22 idle burn (HIDDEN-COST-fable C3): reveal receipts parked on a verdict a retry cannot change (`reveal-source-ineligible`,
// learning switched off) were re-written as `pending` on every retry, forever (stores with 25,164 and 80k of them), and the sweep stayed
// due about once a second even with learning off. Each visit here is what the idle lane runs: the scan, then the capture of what it handed
// out. A row write is counted by a temp trigger on the receipt table (the upsert's UPDATE and any INSERT).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { captureWork } from "./chunks.ts";
import { writeBotIdentity } from "./identity.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { readMemoryLearning, updateMemoryLearning } from "./learning-policy.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import * as reveal from "./reveal-capture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "moss", threadId: "private", tasks: [] as Array<{ threadId: string }> }], groups: [] as never[] };
const signal = () => new AbortController().signal;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); reveal.resetRevealScan(); });
afterEach(() => { vi.useRealTimers(); });

let counter = 0;
/** `count` completed capture jobs of eligible bot replies, each with a pending reveal receipt parked on `reason`, due now. */
function parked(count: number, reason: string, due: number): string[] {
  const db = database(), scope = ensureScope("bot", "moss"), ids: string[] = [];
  db.exec("BEGIN");
  const source = db.prepare("INSERT INTO memory_sources VALUES(?,?,'private',?,NULL,1,?,'text','assistant','settled',NULL,'active')");
  const version = db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)");
  const job = db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,retry_at,attempts,lease_until,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','complete',0,0,0,0,0)");
  const receipt = db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','reveal-capture',0,'granted',?)");
  for (let i = 0; i < count; i++, counter++) {
    source.run(`fixture-s${counter}`, scope, `fixture-m${counter}`, `h${counter}`);
    version.run(`fixture-s${counter}`, `h${counter}`, JSON.stringify({ text: `fixture reply ${counter}` }));
    job.run(`fixture-j${counter}`, `fixture-s${counter}`);
    receipt.run(`reveal-capture:fixture-j${counter}`, scope, JSON.stringify({ cursor: "", status: "pending", retryAt: due, reason, attempts: 1 }));
    ids.push(`fixture-j${counter}`);
  }
  db.exec("COMMIT");
  return ids;
}
/** Every write to a reveal receipt row from here on, by job id. */
function countWrites() {
  const db = database();
  db.exec("CREATE TEMP TABLE IF NOT EXISTS fixture_writes(id TEXT)");
  db.exec("CREATE TEMP TRIGGER IF NOT EXISTS fixture_rw_u AFTER UPDATE ON main.memory_scope_bindings WHEN new.subject_id='reveal-capture' BEGIN INSERT INTO fixture_writes VALUES(new.id); END");
  db.exec("CREATE TEMP TRIGGER IF NOT EXISTS fixture_rw_i AFTER INSERT ON main.memory_scope_bindings WHEN new.subject_id='reveal-capture' BEGIN INSERT INTO fixture_writes VALUES(new.id); END");
  return {
    total: () => Number(db.prepare("SELECT count(*) AS n FROM temp.fixture_writes").get()!.n),
    most: () => Number(db.prepare("SELECT coalesce(max(n),0) AS n FROM (SELECT count(*) AS n FROM temp.fixture_writes GROUP BY id)").get()!.n),
  };
}
/** The idle lane once a second for `seconds` (index.ts lane 0): what it hands out is captured. `roster` may throw (authority unavailable). */
async function idleLane(from: number, seconds: number, rosterOf: () => typeof roster = () => roster) {
  const handed: string[] = [];
  for (let s = 0; s < seconds; s++) {
    vi.setSystemTime(from + s * 1000);
    const [job] = reveal.pendingBotRevealJobs(1);
    if (job) { handed.push(job); await reveal.captureBotReveals(job, rosterOf, null, signal()); }
  }
  return handed;
}
const learningOff = () => { const db = database(); updateMemoryLearning(db, { automaticFacts: false }, readMemoryLearning(db).revision); };

it("W-REVEAL-OFF 25,000 parked receipts with learning switched off: ten idle minutes rewrite no receipt row (the sweep is not run)", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const T0 = Date.now();
  parked(25_000, "reveal-learning-disabled-or-cancelled", T0 - 1);
  learningOff();
  const writes = countWrites();
  const handed = await idleLane(T0, 600);
  console.log(`[W-REVEAL-OFF] handed ${handed.length}, receipt writes ${writes.total()}`);
  // base: the sweep hands one out every second and its capture re-writes it pending (600 writes in ten minutes)
  expect({ writes: writes.total(), handed: handed.length }).toEqual({ writes: 0, handed: 0 });
}, 120_000);

it("W-REVEAL-TERMINAL a verdict about the reply itself (its message is gone) settles its receipt for good: each parked receipt is written at most once, then never handed out again", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const T0 = Date.now();
  const ids = parked(40, "reveal-source-ineligible", T0 - 1);
  const writes = countWrites();
  await idleLane(T0, 1200);
  // base: the same verdict re-written pending at 1, 2, 4, 8, 16 minutes (five or more writes per row in twenty minutes)
  expect(writes.most(), `max writes per receipt row, total ${writes.total()}`).toBeLessThanOrEqual(1);
  const settled = database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?");
  expect(ids.map(id => JSON.parse(String(settled.get(`reveal-capture:${id}`)!.intent)))).toEqual(ids.map(() => expect.objectContaining({ status: "complete", reason: "reveal-source-gone" })));
  // and a restart (the in-memory backoff is gone) does not bring any of them back
  reveal.resetRevealScan();
  const after = writes.total();
  expect(await idleLane(T0 + 1_300_000, 120)).toEqual([]);
  expect(writes.total() - after).toBe(0);
}, 120_000);

it("W-REVEAL-UNCHANGED a transient reason that comes back unchanged is retried (not abandoned) but its row is not rewritten", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const T0 = Date.now();
  const [id] = parked(1, "reveal-authority-unavailable", T0 - 1);
  const writes = countWrites();
  const handed = await idleLane(T0, 1200, () => { throw new Error("fixture roster unavailable"); });
  // still retried with backoff (1, 2, 4, 8 minutes): not given up
  expect(handed.filter(job => job === id).length).toBeGreaterThanOrEqual(3);
  // base: one row rewrite per retry
  expect(writes.total()).toBe(0);
  const saved = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(`reveal-capture:${id}`)!.intent));
  expect(saved).toMatchObject({ status: "pending", reason: "reveal-authority-unavailable" });
}, 120_000);

it("W-REVEAL-STILL-CAPTURES learning on, an eligible reply is still captured; a reply finished while learning was off settles once and is not retried", async () => {
  const ticket = ownerMemoryTicket();
  writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "character-canon", key: "fixture-canon", expectedVersion: 0, text: "Moss once tended a fictional lighthouse.", basis: "fiction", audience: "owner-private" }, roster);
  appendMessage("private", { id: "reply", at: 1, role: "bot", kind: "text", text: "Moss once tended a fictional lighthouse.", turnId: "turn", turnTerminal: true });
  let work; while ((work = claimMemoryJob("fixture"))) publishMemoryWork(work, "fixture", captureWork(work));
  const job = String(database().prepare("SELECT id FROM memory_jobs WHERE source_id='message:private:reply'").get()!.id);
  expect(reveal.pendingBotRevealJobs()).toEqual([job]);
  expect(await reveal.captureBotReveals(job, () => roster, null, signal())).toMatchObject({ status: "partial", written: true });
  // a second reply while learning is off (onCompletedSource): one terminal write, then nothing is due for it
  learningOff();
  appendMessage("private", { id: "reply2", at: 2, role: "bot", kind: "text", text: "Moss once tended a fictional lighthouse.", turnId: "turn2", turnTerminal: true });
  while ((work = claimMemoryJob("fixture"))) publishMemoryWork(work, "fixture", captureWork(work));
  const second = String(database().prepare("SELECT id FROM memory_jobs WHERE source_id='message:private:reply2'").get()!.id);
  expect(await reveal.captureBotReveals(second, () => roster, null, signal())).toMatchObject({ status: "settled" });
  expect(JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(`reveal-capture:${second}`)!.intent))).toMatchObject({ status: "complete" });
  expect(await reveal.captureBotReveals(second, () => roster, null, signal())).toEqual({ status: "unchanged" });
});

it("W-REVEAL-MUTABLE an ineligibility a roster change can lift (a thread aliased by two bots) is not terminal: retried without a rewrite, captured once lifted", async () => {
  const ticket = ownerMemoryTicket();
  writeBotIdentity(ticket, { action: "identity-write", botId: "moss", kind: "character-canon", key: "fixture-canon", expectedVersion: 0, text: "Moss once tended a fictional lighthouse.", basis: "fiction", audience: "owner-private" }, roster);
  appendMessage("private", { id: "reply", at: 1, role: "bot", kind: "text", text: "Moss once tended a fictional lighthouse.", turnId: "turn", turnTerminal: true });
  let work; while ((work = claimMemoryJob("fixture"))) publishMemoryWork(work, "fixture", captureWork(work));
  const job = String(database().prepare("SELECT id FROM memory_jobs WHERE source_id='message:private:reply'").get()!.id);
  const aliased = { ...roster, bots: [...roster.bots, { id: "fixture-other", threadId: "private", tasks: [] }] };
  reconcileMemoryRoster(aliased);
  const writes = countWrites();
  for (let i = 0; i < 3; i++) expect(await reveal.captureBotReveals(job, () => aliased, null, signal())).toMatchObject({ status: "deferred", reason: "reveal-source-ineligible" });
  // base: one rewrite per retry (3); now the first verdict is written and the same verdict again is not
  expect(writes.total()).toBe(1);
  reconcileMemoryRoster(roster);
  // the alias is gone: the same job is captured (a terminal verdict here would have lost it for good)
  expect(await reveal.captureBotReveals(job, () => roster, null, signal())).toMatchObject({ status: "partial", written: true });
});
