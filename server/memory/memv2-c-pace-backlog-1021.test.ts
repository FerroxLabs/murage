// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: lane C (MEMORY V2 revoke engine), slice pace. G-BACKLOG (design section 7) and migration task M2 (section 5): the standing revoke
// queue of the owner's file, AS IT IS (no fold, no cap change), drains to empty within 10 simulated idle minutes and, with a turn every
// 10 s, within 45. The mix is the measured one: 2,247 inherit/mark, 112 bulk/mark, 12 bulk/flow, 4 thread/mark, 1 line/mark, 0 flips (the
// fixture builder is mem-f3-revoke-queue-1021's seedBacklog; the bulks open their `*` rows through the real bulk API).
// The OS counter is the macOS one, injected (the whole process's bytes, 8 MB more at every read), and the clock is a fake wall clock.
// What this does NOT model: the Mac's storage, fan-out per job (each job here holds one line), and other connections' writes.
// Namespace imports on purpose (the file also runs on the product base, where some exports do not exist).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refsLookup } from "./deny-read.ts";
import { PENDING_ALL_SCOPES, PENDING_ALL_THREADS } from "./lineage-types.ts";
import * as runner from "./memory-revocation.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import * as budget from "./revoke-budget.ts";
import * as commit from "./revoke-commit.ts";
import * as marker from "./revoke-marker.ts";
import { assertSendFence } from "./send-fence.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

const OWNER = "zz-owner", MIB = 1024 * 1024;
const SHAPE = { inherit: 2247, thread: 4, line: 1, bulkMark: 112, bulkFlow: 12 }, BACKLOG = 2376;
let f: WritetimeFixture, head = 0;
beforeEach(() => { budget.resetRevokeWriteBudget(); runner.resetMemoryRevocationStats(); f = new WritetimeFixture().cert(true); });
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); runner.stopMemoryRevocation(); f.close();
  budget.setRevokeBudgetClock(); budget.resetRevokeWriteBudget(); runner.resetMemoryRevocationStats();
  Object.assign(budget.revokePaceTestHooks, { osUnknown: false, platform: null, osBlocks: null });
});

const count = (sql: string, ...args: Array<string | number>) => Number(Object.values(f.db.prepare(sql).get(...args) ?? { n: NaN })[0]);
const activeJobs = () => count("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing')");
const pendingRows = () => count("SELECT count(*) AS n FROM memory_deny_pending") + count("SELECT count(*) AS n FROM memory_deny_pending_scope");
const lineVerdict = (thread: string) => refsLookup(f.db, [{ kind: "line", threadId: thread, messageId: "reply" }], CONTENT).state;
const refused = (): string | null => {
  const built = buildPrompt(undefined, [promptPart("[Delegated by @Sender] Re-sending the report", [{ kind: "prefix", threadId: OWNER, headLsn: head }])]);
  try { assertSendFence(built, CONTENT, f.db); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
};
function lineJob(id: number, kind: "line" | "thread"): void {
  f.reply(`line-${id}`, "reply", id * 10).job(id, id * 10 + 1).pending(`line-${id}`, 1, id);
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='mark',kind=? WHERE revoke_id=?").run(kind, id);
  marker.enqueueNode(f.db, id, { kind: "line", threadId: `line-${id}`, lsn: id * 10 });
}
function seedBacklog(): void {
  f.db.exec("PRAGMA journal_mode=WAL"); // as the app's file: a drain commit is measured by its log frames
  f.db.exec("BEGIN");
  let id = 0;
  // an inherit job as revoke-commit.ts inheritMarks leaves it: the child line's deny row, its frontier node, its hold on its own thread
  for (let i = 0; i < SHAPE.inherit; i++) {
    id++;
    const thread = `line-${id}`, lsn = id * 10;
    f.reply(thread, "reply", lsn).denyLine(thread, lsn, id).pending(thread, lsn, id);
    f.db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'inherit',?,?,?,'mark','','active')").run(id, JSON.stringify({ kind: "inherit", cause: "inherit" }), lsn, lsn + 1);
    marker.enqueueNode(f.db, id, { kind: "line", threadId: thread, lsn });
  }
  for (let i = 0; i < SHAPE.thread; i++) lineJob(++id, "thread");
  for (let i = 0; i < SHAPE.line; i++) lineJob(++id, "line");
  f.db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run((id + 1) * 10);
  for (let i = 0; i < SHAPE.bulkMark + SHAPE.bulkFlow; i++) {
    const thread = `bulk-${i}`, lsn = count("SELECT next FROM memory_lsn WHERE id=1");
    f.owner(thread, "u", lsn).reply(thread, "reply", lsn + 1, { turnLsn: lsn });
    const bulk = commit.openBulkRevoke(f.db, "seed", false);
    commit.commitRevoke(f.db, { kind: "line", threadId: thread, messageIds: ["reply"], cause: "forget" }, { inline: false, into: bulk });
    commit.activateBulkRevoke(f.db, bulk);
    // the first 112 are past their flow phase, as the owner's were; the last 12 stay in flow (they hold `*` windows)
    if (i < SHAPE.bulkMark) for (let n = 0; n < 1000 && String(f.db.prepare("SELECT phase FROM memory_revoke_jobs WHERE revoke_id=?").get(bulk)!.phase) === "flow"; n++) marker.markerSlice(f.db, 1, Number.POSITIVE_INFINITY, null, 1, { only: bulk });
  }
  head = count("SELECT next FROM memory_lsn WHERE id=1") + 10;
  f.reply(OWNER, "delegated", head, { turnLsn: 10 });
  f.db.exec("COMMIT");
}
/** P4, observed where it happens: every delete of a pending row is logged by a TEMP trigger on the runner's own connection with what the
 * file held AT THAT STATEMENT (the job row's phase is saved only at the end of a step, so the frontier is what is read). A legal delete is
 * one of the three proof sites, and each has the same durable precondition: the certified end of flow deletes a `*` row once the revoke
 * has no flow node left (seq < 0); the tidy and closeWaitedPending delete once it has no frontier node at all (every mark written). */
function watchCloses(): void {
  f.db.exec(`CREATE TEMP TABLE closes(revoke_id INTEGER, key TEXT, state TEXT, flow INTEGER, frontier INTEGER);
    CREATE TEMP TRIGGER closes_thread AFTER DELETE ON memory_deny_pending BEGIN
      INSERT INTO closes SELECT old.revoke_id, old.thread_id, (SELECT state FROM memory_revoke_jobs WHERE revoke_id=old.revoke_id), EXISTS (SELECT 1 FROM memory_revoke_frontier WHERE revoke_id=old.revoke_id AND seq<0),
        EXISTS (SELECT 1 FROM memory_revoke_frontier WHERE revoke_id=old.revoke_id); END;
    CREATE TEMP TRIGGER closes_scope AFTER DELETE ON memory_deny_pending_scope BEGIN
      INSERT INTO closes SELECT old.revoke_id, old.scope_id, (SELECT state FROM memory_revoke_jobs WHERE revoke_id=old.revoke_id), EXISTS (SELECT 1 FROM memory_revoke_frontier WHERE revoke_id=old.revoke_id AND seq<0),
        EXISTS (SELECT 1 FROM memory_revoke_frontier WHERE revoke_id=old.revoke_id); END;`);
}
const illegalCloses = () => count(`SELECT count(*) AS n FROM closes WHERE NOT (state='active' AND ((key IN (?1,?2) AND flow=0) OR frontier=0))`, PENDING_ALL_THREADS, PENDING_ALL_SCOPES);
function asMacWithBusyThreads(): void {
  let blocks = 0;
  Object.assign(budget.revokePaceTestHooks, { platform: "darwin", osBlocks: () => (blocks += 8 * MIB / 512) });
}
/** Log frames memory's drain commits wrote so far, in bytes: read from the log index around every runner and turn-drain commit
 * (revoke-budget.ts endRevokeMeasure; commits that changed rows). */
const frames = () => budget.revokeWriteMeter.measuredBytes;
type Run = { drainedAtSecond: number | null; maxMinuteBytes: number; neverShown: boolean; startedMoved: number; turnDrains: number };
/** Up to `minutes` of the fake wall clock with the real runner awake. `turnEvery`: a turn starts every that many seconds, is live for 3 s
 * and runs the send fence's own bounded drain at its start (as a real turn start does). */
async function run(minutes: number, turnEvery: number | null): Promise<Run> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  budget.setRevokeBudgetClock(); // the wall clock, which is the fake one now
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const started = new Map<number, number>();
  for (const row of f.db.prepare("SELECT revoke_id,started_lsn FROM memory_revoke_jobs").all()) started.set(Number(row.revoke_id), Number(row.started_lsn));
  let live = false, drainedAtSecond: number | null = null, maxMinuteBytes = 0, minuteStart = 0, neverShown = true, turnDrains = 0;
  const ids = [...Array.from({ length: 40 }, (_, i) => 1 + i * 56), SHAPE.inherit];
  runner.wakeMemoryRevocation(() => f.db, { busy: () => live });
  for (let second = 0; second < minutes * 60; second++) {
    if (turnEvery) {
      const phase = second % turnEvery;
      if (phase === 5) { live = true; runner.drainRevokeMarkerBounded(f.db); turnDrains++; }
      if (phase === 8) live = false;
    }
    await vi.advanceTimersByTimeAsync(1000);
    if (second % 60 === 59) { maxMinuteBytes = Math.max(maxMinuteBytes, frames() - minuteStart); minuteStart = frames(); }
    if (second % 30 === 29) for (const id of ids) if (lineVerdict(`line-${id}`) === "shown") neverShown = false;
    if (drainedAtSecond === null && activeJobs() === 0) { drainedAtSecond = second + 1; break; }
  }
  maxMinuteBytes = Math.max(maxMinuteBytes, frames() - minuteStart);
  let startedMoved = 0;
  for (const row of f.db.prepare("SELECT revoke_id,started_lsn FROM memory_revoke_jobs").all()) if (started.has(Number(row.revoke_id)) && started.get(Number(row.revoke_id)) !== Number(row.started_lsn)) startedMoved++;
  runner.stopMemoryRevocation(); await runner.memoryRevocationIdle();
  vi.restoreAllMocks(); vi.useRealTimers();
  return { drainedAtSecond, maxMinuteBytes, neverShown, startedMoved, turnDrains };
}
function report(name: string, limitMinutes: number, got: Run): void {
  const stats = runner.memoryRevocationStats, share = stats.workMs / Math.max(1, stats.workMs + stats.pauseMs);
  console.log(`MEMV2C G-BACKLOG ${name} jobs=${BACKLOG} limitMinutes=${limitMinutes} drainedAtMinute=${got.drainedAtSecond === null ? "never" : (got.drainedAtSecond / 60).toFixed(2)} left=${activeJobs()} pendingLeft=${pendingRows()} maxMinuteFramesMiB=${(got.maxMinuteBytes / MIB).toFixed(2)} pacedMiB=${(budget.revokeWriteMeter.paceDated / MIB).toFixed(1)} ledgerChargedMiB=${(budget.revokeWriteMeter.charged / MIB).toFixed(1)} mainThreadShare=${(share * 100).toFixed(2)}% workMs=${Math.round(stats.workMs)} pauseMs=${Math.round(stats.pauseMs)} commits=${stats.slices} maxSliceMs=${stats.maxSliceMs.toFixed(1)} illegalCloses=${illegalCloses()} closes=${count("SELECT count(*) AS n FROM closes")} startedLsnMoved=${got.startedMoved} turnDrains=${got.turnDrains} budgetWaits=${stats.budgetWaits}`);
  expect(got.neverShown).toBe(true);                       // nothing under a window read before its walk was proven
  expect(got.drainedAtSecond).not.toBeNull();              // the queue is empty inside the limit
  expect(activeJobs()).toBe(0);
  expect(pendingRows()).toBe(0);
  expect(illegalCloses()).toBe(0);                         // P4: no pending row deleted outside the proof sites
  expect(count("SELECT count(*) AS n FROM closes")).toBeGreaterThan(BACKLOG - 1);
  expect(got.startedMoved).toBe(0);                        // P4: no started_lsn changed
  expect(got.maxMinuteBytes).toBeLessThanOrEqual(28 * MIB); // memory frames a minute
  expect(share).toBeLessThanOrEqual(0.25);                 // slice / pause accounting
  // privacy at the end: every inherit child keeps its mark, and a turn that holds nothing denied is not refused
  for (const id of [1, 1000, SHAPE.inherit]) expect(lineVerdict(`line-${id}`)).toBe("withheld");
  expect(refused()).toBeNull();
}

it("G-BACKLOG idle: the standing queue (2,376 jobs, the measured mix) is empty within 10 simulated idle minutes under the macOS counter", async () => {
  seedBacklog(); watchCloses(); asMacWithBusyThreads();
  expect(f.db.prepare("SELECT kind||'/'||phase AS k,count(*) AS n FROM memory_revoke_jobs WHERE state='active' GROUP BY 1 ORDER BY 2 DESC").all().map(row => `${row.k}=${row.n}`).join(" ")).toBe("inherit/mark=2247 bulk/mark=112 bulk/flow=12 thread/mark=4 line/mark=1");
  expect(refused()).toMatch(/MEMORY_/);
  report("idle", 10, await run(10, null));
}, 900_000);

it("G-BACKLOG with turns: a turn every 10 s (live 3 s, its own send-fence drain at its start): empty within 45 simulated minutes", async () => {
  seedBacklog(); watchCloses(); asMacWithBusyThreads();
  report("turns", 45, await run(45, 10));
}, 900_000);
