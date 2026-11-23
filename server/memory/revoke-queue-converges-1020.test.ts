// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: revoke-marker (the walker) + revoke-budget (the paced drain). 1.0.20 fable-macmem.
// The field (final9, the owner's file): more than 1000 active revoke jobs, "settle outcome=budget ms=0 slices=1 activeJobs=>1000" on every
// owner turn and memory "checking" 17+ minutes after launch. The pace admits about one drain commit a minute, and the walker served one job
// per commit, so the queue needed one commit per job however little of the commit's allowance each used.
import { afterEach, beforeEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { refsLookup } from "./deny-read.ts";
import { lateBuildStep } from "./memory-revocation.ts";
import { assertSendFence } from "./send-fence.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { beginRevokeMeasure, budgetedMarkerSlice, endRevokeMeasure, resetRevokeWriteBudget, revokePaceNeed, revokePaceTestHooks, revokePaceWaitMs, revokeSliceNeed, revokeWriteWaitMs, setRevokeBudgetClock, REVOKE_PACE_COMMIT } from "./revoke-budget.ts";
import * as marker from "./revoke-marker.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

const JOBS = 1100, OWNER = "zz-owner", HEAD = 100 + JOBS * 4;
/** Drain commits the queue may take: a tenth of one per job. One commit per job (the field) needs at least JOBS. */
const COMMITS = JOBS / 10;
let f: WritetimeFixture, now = 0, head = HEAD;
beforeEach(() => {
  now = 1_000_000; head = HEAD;
  setRevokeBudgetClock(() => now);
  resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = false;
  f = new WritetimeFixture().cert(true);
});
afterEach(() => { f.close(); setRevokeBudgetClock(); resetRevokeWriteBudget(); revokePaceTestHooks.osUnknown = false; marker.MARKER_SLICE_JOBS && (marker.MARKER_SLICE_JOBS.max = 64); });

function seedQueue(): void {
  // every job is a small line revoke with its own thread's window; the owner's thread waits on the NEWEST one, the last the queue reaches
  f.db.exec("BEGIN");
  for (let j = 1; j <= JOBS; j++) f.reply(`th-${j}`, `m-${j}`, 10 + j * 2, { turnLsn: 9 + j * 2 }).job(j, 20 + JOBS * 2 + j).pending(`th-${j}`, 1, j);
  f.reply(OWNER, "delegated", head, { turnLsn: 10 }).pending(OWNER, 1, JOBS);
  f.db.exec("COMMIT");
}

const activeJobs = () => Number(f.db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing')").get()!.n);
const ownerPrompt = () => buildPrompt(undefined, [promptPart("[Delegated by @Sender] Re-sending the report", [{ kind: "prefix", threadId: OWNER, headLsn: head }])]);
const refused = (): string | null => { try { assertSendFence(ownerPrompt(), CONTENT, f.db); return null; } catch (error) { return error instanceof Error ? error.message : String(error); } };
/** One runner tick's transaction (memory-revocation.ts tick), in a minute whose pace is empty: the most the pace ever admits at once.
 * Rows and time are generous so the result does not depend on this machine's speed; the commit's write cap is the real one. */
function pacedCommit(rows = 4096, late: Parameters<typeof budgetedMarkerSlice>[3] = null, jump = 3 * 60_000): { moved: boolean | "budget"; changed: number } {
  now += jump; // by default past the pace's minute and the copy proof bound: every commit below starts from an empty pace
  revokePaceNeed(f.db);
  f.db.exec("BEGIN IMMEDIATE");
  const measure = beginRevokeMeasure(f.db), before = marker.totalChanges(f.db);
  try {
    const moved = budgetedMarkerSlice(f.db, rows, 30_000, late);
    const changed = marker.totalChanges(f.db) - before;
    f.db.exec("COMMIT"); endRevokeMeasure(f.db, measure, moved === true);
    return { moved, changed };
  } catch (error) { if (f.db.isTransaction) f.db.exec("ROLLBACK"); endRevokeMeasure(f.db, measure, false, false); throw error; }
}
function drain(commits: number): { used: number; most: number } {
  let used = 0, most = 0;
  while (used < commits && marker.markerWorkPending(f.db)) { const { changed } = pacedCommit(); used++; most = Math.max(most, changed); }
  return { used, most };
}

it(`a queue of ${JOBS} small revoke jobs clears in ${COMMITS} paced commits, each inside the commit cap, and the owner turn then reads its thread`, () => {
  seedQueue();
  expect(activeJobs()).toBe(JOBS);
  expect(refused()).toMatch(/MEMORY_/); // the owner's prompt is refused while its window is open
  const { used, most } = drain(COMMITS);
  console.log(`MACMEM commits=${used} left=${activeJobs()} mostChanges=${most}`);
  // no budget was raised: a commit changes at most the pace's commit cap plus the marker's step reserve (revoke-budget.ts)
  expect(most).toBeLessThanOrEqual(REVOKE_PACE_COMMIT.rows + marker.MARKER_STEP_RESERVE);
  expect(activeJobs()).toBe(0);
  expect(marker.markerWorkPending(f.db)).toBe(false);
  expect(refused()).toBeNull();
}, 120_000);

it("fail closed on the way: the owner prompt stays refused until its own revoke has finished", () => {
  seedQueue();
  let wasRefused = 0;
  for (let i = 0; i < COMMITS && marker.markerWorkPending(f.db); i++) {
    pacedCommit();
    const mine = f.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(JOBS)?.state;
    if (mine === "active") { expect(refused()).toMatch(/MEMORY_/); wasRefused++; }
  }
  expect(wasRefused).toBeGreaterThan(0);
  expect(refused()).toBeNull();
}, 120_000);

it("sensitivity: one job per commit (the behaviour before this change) leaves most of the queue open after the same commits", () => {
  seedQueue();
  expect(marker.MARKER_SLICE_JOBS).toBeDefined();
  marker.MARKER_SLICE_JOBS.max = 1;
  drain(COMMITS);
  expect(activeJobs()).toBeGreaterThanOrEqual(JOBS - COMMITS);
  expect(refused()).toMatch(/MEMORY_/);
}, 120_000);

it("builds at most one late page when a resumed revoke has a one-row allowance", () => {
  f.source("src", "s-room").record("rec-a", 1, "s-room", ["src"]).record("rec-b", 1, "s-room", ["src"]).job(1, 10);
  f.db.exec("DELETE FROM memory_evidence_by_source; UPDATE memory_late_build SET ready=0,cursor=NULL WHERE name='evidence'; UPDATE memory_revoke_jobs SET phase='mark'");
  marker.enqueueNode(f.db, 1, { kind: "source", id: "src" });
  expect(pacedCommit(3).moved).toBe(true);

  expect(pacedCommit(1, lateBuildStep).moved).toBe(true);
  expect(f.db.prepare("SELECT record_id FROM memory_evidence_by_source ORDER BY record_id").all()).toEqual([{ record_id: "rec-a" }]);
  expect(f.db.prepare("SELECT ready FROM memory_late_build WHERE name='evidence'").get()).toEqual({ ready: 0 });
  expect(activeJobs()).toBe(1);
});

function seedLineJob(id: number): void {
  const threadId = `line-${id}`;
  f.reply(threadId, "reply", id * 10).job(id, id * 10 + 1).pending(threadId, 1, id);
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='mark' WHERE revoke_id=?").run(id);
  marker.enqueueNode(f.db, id, { kind: "line", threadId, lsn: id * 10 });
}

it("the reader sees pending windows until the batched marks commit", () => {
  f.db.exec("PRAGMA journal_mode=WAL");
  seedLineJob(1);
  seedLineJob(2);
  const filename = String(f.db.prepare("PRAGMA database_list").get()!.file);
  const reader = new DatabaseSync(filename, { readOnly: true });
  const verdicts = () => [1, 2].map(id =>
    refsLookup(reader, [{ kind: "line", threadId: `line-${id}`, messageId: "reply" }], CONTENT).state);
  try {
    reader.exec("BEGIN");
    expect(verdicts()).toEqual(["checking", "checking"]);
    expect(pacedCommit().moved).toBe(true);
    expect(activeJobs()).toBe(0);
    expect(verdicts()).toEqual(["checking", "checking"]);
    reader.exec("COMMIT");
    expect(reader.prepare("SELECT count(*) AS n FROM memory_deny_pending").get()).toEqual({ n: 0 });
    expect(reader.prepare("SELECT revoke_id FROM memory_deny_line ORDER BY revoke_id").all()).toEqual([{ revoke_id: 1 }, { revoke_id: 2 }]);
    expect(verdicts()).toEqual(["withheld", "withheld"]);
  } finally {
    reader.close();
  }
});

it("a corrupt second job rolls back the first job and the next commit can serve another job", () => {
  seedLineJob(1);
  seedLineJob(2);
  seedLineJob(3);
  f.db.exec("UPDATE memory_revoke_frontier SET node='invalid' WHERE revoke_id=2");
  expect(() => pacedCommit()).toThrow("MEMORY_REVOKE_NODE_UNREADABLE");
  expect(f.db.prepare("SELECT revoke_id FROM memory_deny_line").all()).toEqual([]);
  expect(f.db.prepare("SELECT revoke_id FROM memory_deny_pending ORDER BY revoke_id").all()).toEqual([{ revoke_id: 1 }, { revoke_id: 2 }, { revoke_id: 3 }]);

  expect(pacedCommit().moved).toBe(true);
  expect(f.db.prepare("SELECT revoke_id FROM memory_deny_line").all()).toEqual([{ revoke_id: 3 }]);
  expect(f.db.prepare("SELECT revoke_id FROM memory_deny_pending ORDER BY revoke_id").all()).toEqual([{ revoke_id: 1 }, { revoke_id: 2 }]);
});

// 1.0.21 macmemfin: the owner's file as MAIN counted it (1,434 active jobs, all in mark). Every job here is a real line revoke already in
// mark with its line on the frontier, so each one writes its permanent mark before its window goes. The drain waits exactly what the runner's
// admission waits (memory-revocation.ts tick: revokePaceWaitMs, then revokeWriteWaitMs) and never jumps past it. What this does NOT model: the
// runner's 8 ms slices and live-turn trickle, real fan-out per job, and the Mac's storage; the bound is this fixture's, on the admission clock.
const MAC_JOBS = 1434;
/** The stated bound: the queue is settled within this much of the admission clock. */
const MAC_SETTLE_MS = 90 * 60_000;
function seedMacQueue(): void {
  head = 100 + MAC_JOBS * 20;
  f.db.exec("BEGIN");
  for (let id = 1; id <= MAC_JOBS; id++) {
    f.reply(`line-${id}`, "reply", id * 10).job(id, id * 10 + 1).pending(`line-${id}`, 1, id);
    marker.enqueueNode(f.db, id, { kind: "line", threadId: `line-${id}`, lsn: id * 10 });
  }
  f.db.exec("UPDATE memory_revoke_jobs SET phase='mark'");
  f.reply(OWNER, "delegated", head, { turnLsn: 10 }).pending(OWNER, 1, MAC_JOBS);
  f.db.exec("COMMIT");
}
/** One admitted commit on the admission clock (null: the clock ran out or nothing is left). */
function runnerCommit(start: number, untilMs: number): number | null {
  for (let step = 0; step < 200_000 && marker.markerWorkPending(f.db) && now - start < untilMs; step++) {
    const wait = Math.max(revokePaceWaitMs(revokePaceNeed(f.db)), revokeWriteWaitMs(revokeSliceNeed(f.db)));
    if (wait > 0) { now += wait; continue; }
    const { moved, changed } = pacedCommit(4096, null, 0);
    if (moved === true) return changed;
    now += 1000; // refused inside: look again in a second, as the copy poll does
  }
  return null;
}
function runnerDrain(untilMs: number, afterCommit?: () => void): { commits: number; elapsed: number; most: number } {
  const start = now;
  let commits = 0, most = 0;
  for (let changed = runnerCommit(start, untilMs); changed !== null; changed = runnerCommit(start, untilMs)) { commits++; most = Math.max(most, changed); afterCommit?.(); }
  return { commits, elapsed: now - start, most };
}

it(`the owner's file (${MAC_JOBS} active jobs in mark) settles within ${MAC_SETTLE_MS / 60_000} minutes of the admission clock, and only then does the owner turn read its thread`, () => {
  seedMacQueue();
  expect(activeJobs()).toBe(MAC_JOBS);
  expect(refused()).toMatch(/MEMORY_/);
  const { commits, elapsed, most } = runnerDrain(MAC_SETTLE_MS);
  console.log(`MACMEMFIN jobs=${MAC_JOBS} commits=${commits} minutes=${(elapsed / 60_000).toFixed(1)} left=${activeJobs()} mostChanges=${most}`);
  expect(most).toBeLessThanOrEqual(REVOKE_PACE_COMMIT.rows + marker.MARKER_STEP_RESERVE);
  expect(activeJobs()).toBe(0);
  expect(marker.markerWorkPending(f.db)).toBe(false);
  expect(elapsed).toBeLessThanOrEqual(MAC_SETTLE_MS);
  expect(f.db.prepare("SELECT count(*) AS n FROM memory_deny_pending").get()).toEqual({ n: 0 });
  expect(Number(f.db.prepare("SELECT count(DISTINCT revoke_id) AS n FROM memory_deny_line").get()!.n)).toBe(MAC_JOBS);
  expect(refused()).toBeNull();
}, 300_000);

it("the owner's file, privacy on the way: after every commit each revoked line reads checking while its job is active and withheld once it is marked, never shown", () => {
  seedMacQueue();
  // a finished job's row leaves the queue, so the active set is read and every one of the 1,434 lines is judged after every commit
  const stillActive = f.db.prepare("SELECT revoke_id AS id FROM memory_revoke_jobs WHERE state IN ('active','undoing')");
  // 1.0.21 MEMORY V2 (lane C): a commit may end after a job wrote its permanent mark and before the job left its mark phase (measured
  // here: 809 such readings over 42 commits, every one in phase 'mark'), so a job can be active with its mark already committed. Its
  // line then reads withheld, the stricter answer, exactly as the title says ("withheld once it is marked"); the test used to take
  // "active" for "not yet marked". The rule is now asserted on the mark itself: no mark -> checking (and the job must still be active, its window open);
  // marked -> withheld, whether or not its job row is still active; a finished job is always marked. Never shown, after every commit.
  const marked = f.db.prepare("SELECT 1 FROM memory_deny_line WHERE thread_id=? AND lsn=? AND revoke_id=?");
  const phaseOf = f.db.prepare("SELECT phase FROM memory_revoke_jobs WHERE revoke_id=?");
  let checking = 0, withheld = 0, ownerRefused = 0, markedActive = 0;
  const markedActivePhases = new Map<string, number>();
  const { commits } = runnerDrain(MAC_SETTLE_MS, () => {
    const activeIds = new Set((stillActive.all() as { id: number }[]).map(row => Number(row.id)));
    const mineActive = activeIds.has(MAC_JOBS);
    for (let id = 1; id <= MAC_JOBS; id++) {
      const active = activeIds.has(id);
      const verdict = refsLookup(f.db, [{ kind: "line", threadId: `line-${id}`, messageId: "reply" }], CONTENT).state;
      const hasMark = Boolean(marked.get(`line-${id}`, id * 10, id));
      expect(verdict).not.toBe("shown");
      if (!active) expect(hasMark).toBe(true);
      if (hasMark) { expect(verdict).toBe("withheld"); withheld++; } else { expect(active).toBe(true); expect(verdict).toBe("checking"); checking++; }
      if (active && hasMark) { markedActive++; const phase = String(phaseOf.get(id)?.phase); markedActivePhases.set(phase, (markedActivePhases.get(phase) ?? 0) + 1); }
    }
    // the owner waits on the newest revoke only: refused, by the memory fence, exactly while that one is active
    if (mineActive) { expect(refused()).toMatch(/MEMORY_/); ownerRefused++; } else expect(refused()).toBeNull();
  });
  console.log(`MACMEMFIN-PRIVACY commits=${commits} checking=${checking} withheld=${withheld} markedWhileActive=${markedActive} phases=${JSON.stringify([...markedActivePhases])}`);
  expect(commits).toBeGreaterThan(1);
  expect(checking).toBeGreaterThan(MAC_JOBS);
  expect(withheld).toBeGreaterThan(MAC_JOBS);
  expect(ownerRefused).toBeGreaterThan(0);
  expect(activeJobs()).toBe(0);
}, 300_000);

it("sensitivity, the owner's file: one job per commit leaves most of the queue checking after the same time", () => {
  marker.MARKER_SLICE_JOBS.max = 1;
  seedMacQueue();
  const { commits, elapsed } = runnerDrain(MAC_SETTLE_MS);
  console.log(`MACMEMFIN-BASE jobs=${MAC_JOBS} commits=${commits} minutes=${(elapsed / 60_000).toFixed(1)} left=${activeJobs()}`);
  expect(activeJobs()).toBeGreaterThan(MAC_JOBS / 2);
  expect(refused()).toMatch(/MEMORY_/);
}, 300_000);
