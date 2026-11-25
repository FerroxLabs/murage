// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: q1022-idlequiet-opus owns these witnesses and the one decision point (io-budget.ts idleQuiet); io-budget.ts (scperf-p1) owns
// the idle verdict and the write gate; memory-revocation.ts, recall-view.ts and jobs.ts/worker-controller.ts own the writers that obey it;
// MAIN owns the ruling.
// MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS: while the server is idle (the existing idle-minute judgement in io-budget.ts), NO background
// memory work writes messages.db: memory-capture publish/relief, recall view build/reclaim, non-closing revocation tidy and lease heartbeats
// of deferred jobs all PAUSE and resume on the next active minute under the existing caps. ONLY closing work (an owner forget/revoke) runs.
// Each row drives the real writer on the real database; the idle verdict is the only input set by the test (the owner's idle state
// through setIsIdle, or the ledger's answer for the runner, as the existing revocation witnesses do). The oracle is the database itself:
// the WAL index (mxFrame and salt) and the WAL file size for messages.db, or the connection's total_changes() for the runner's own file.
//   CAPTURE  jobs.ts publishMemoryWork + heartbeatMemoryJob under the capture source (worker-controller.ts deliver/beat), write gate
//   RECALL   recall-view.ts prepareRosterRecallViews (the background warming queue: scheduleContextQueue)
//   TIDY     memory-revocation.ts wakeMemoryRevocation, a revoke in phase tidy with no pending row (non-closing)
//   PRIVACY  memory-revocation.ts wakeMemoryRevocation, an owner's revoke with a pending row (closing): completes while idle
import { mkdirSync, statSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ioBudget, isBgDeferred } from "../io-budget.ts";
import { walIndexReader } from "../io-written.ts";
import { appendMessage } from "../message-db.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { refsLookup } from "./deny-read.ts";
import { claimMemoryJob, heartbeatMemoryJob, publishMemoryWork, resetMemoryClaimCursor } from "./jobs.ts";
import * as runner from "./memory-revocation.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { noteRevokeClosing, resetRevokeWriteBudget, setRevokeBudgetClock } from "./revoke-budget.ts";
import * as marker from "./revoke-marker.ts";
import * as views from "./recall-view.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";
import type { MemoryWork } from "./worker-protocol.ts";

const loopTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const mainFile = () => String(database().prepare("PRAGMA database_list").all().find(row => row.name === "main")!.file);
/** What messages.db holds in its log: committed frames (mxFrame, salt) and the file's size (frames written past the last commit, too). */
function walMark(): { mxFrame: number; salt: string; size: number } {
  const file = mainFile(), read = walIndexReader(file);
  try { const mark = read(); return { mxFrame: mark?.mxFrame ?? -1, salt: mark?.salt ?? "unreadable", size: statSync(`${file}-wal`).size }; } finally { read.close(); }
}

let f: WritetimeFixture | null = null;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  resetMemoryClaimCursor(); resetRevokeWriteBudget();
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers(); ioBudget.setIsIdle(() => false);
  runner.stopMemoryRevocation(); noteRevokeClosing(false); setRevokeBudgetClock(); resetRevokeWriteBudget();
  views.stopRecallViewMaintenance();
  f?.close(); f = null; closeDatabase();
});

it("CAPTURE: on an idle minute a leased capture's publish and its lease heartbeat write 0 bytes to messages.db, and the publish lands on the next active minute", async () => {
  setMemoryMode("capture");
  appendMessage("thread", { id: "line-0", at: 1, role: "user", kind: "text", text: "Durable evidence, line 0: the owner said something worth keeping." });
  await stopWalMaintenance();
  // an active minute: the capture is claimed (leased) as the controller's tick claims it
  ioBudget.setIsIdle(() => false);
  const work = ioBudget.withSource("memory-capture", () => claimMemoryJob("idle-quiet-worker")) as MemoryWork | null;
  expect(work, "setup: the owner line owes a capture and it was leased on an active minute").not.toBeNull();
  const result = { id: work!.id, leaseGeneration: work!.leaseGeneration, status: "complete" as const, nextCursor: work!.totalBytes, chunks: [{ text: work!.text, startByte: 0, endByte: Buffer.byteLength(work!.text) }] };
  const status = () => String(database().prepare("SELECT status FROM memory_jobs WHERE id=?").get(work!.id)!.status);
  // the owner goes away: the next minute is judged idle, with its idle allowance unspent (the setup's writes were the minute before)
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 60_000 - (Date.now() % 60_000)) + 1_000));
  ioBudget.setIsIdle(() => true);
  expect(ioBudget.admissionIdle(), "setup: the minute is judged idle").toBe(true);
  const before = walMark();
  const outcome = (run: () => unknown) => { try { run(); return "wrote"; } catch (error) { return isBgDeferred(error) ? "deferred" : `threw ${String(error)}`; } };
  const publish = outcome(() => ioBudget.withSource("memory-capture", () => publishMemoryWork(work!, "idle-quiet-worker", result)));
  const beat = outcome(() => ioBudget.withSource("memory-capture", () => heartbeatMemoryJob(work!, "idle-quiet-worker")));
  // the helper's start asks the ledger for its boot ticket under the capture source (worker-controller.ts spawn): none on an idle minute
  const boot = ioBudget.withSource("memory-capture", () => ioBudget.admit("BG", 64 * 1024));
  if (boot) ioBudget.settle(boot, 0);
  expect({ publish, beat, helperBoot: boot === null ? "refused" : "admitted", wal: walMark(), status: status() }, "an idle minute: the capture's publish, its heartbeat and the helper's start pause (0 frames, 0 bytes in the log)")
    .toEqual({ publish: "deferred", beat: "deferred", helperBoot: "refused", wal: before, status: "leased" });
  // the next active minute: the same publication lands under the existing caps
  ioBudget.setIsIdle(() => false);
  expect(outcome(() => ioBudget.withSource("memory-capture", () => publishMemoryWork(work!, "idle-quiet-worker", result))), "the publish resumes on the next active minute").toBe("wrote");
  expect(status(), "the capture is published").toBe("complete");
}, 120_000);

/** A reader with its own thread: the roster the background warming queue builds views for. */
const roster = (): MemoryRoster => ({ memoryRosterRevision: 1, bots: [{ id: "reader", threadId: "reader-thread" }], groups: [] });
it("RECALL: on an idle minute the background recall build writes 0 bytes to messages.db, and builds on the next active minute", async () => {
  setMemoryMode("active");
  const r = roster();
  reconcileMemoryRoster(r);
  await stopWalMaintenance();
  const viewsBuilt = () => Number(database().prepare("SELECT count(*) AS n FROM memory_recall_views").get()!.n);
  vi.spyOn(ioBudget, "nextAdmissionMs").mockReturnValue(50);
  ioBudget.setIsIdle(() => true);
  expect(ioBudget.admissionIdle(), "setup: the minute is judged idle").toBe(true);
  const built0 = viewsBuilt();
  views.prepareRosterRecallViews(r);
  // the roster's contexts are queued (the enumeration itself); from here only the background build could write
  for (let i = 0; i < 20; i++) { await loopTurn(); await new Promise(resolve => setTimeout(resolve, 5)); }
  const before = walMark();
  for (let i = 0; i < 60; i++) { await loopTurn(); await new Promise(resolve => setTimeout(resolve, 5)); }
  expect({ wal: walMark(), views: viewsBuilt() }, "an idle minute: no recall view is built (0 frames, 0 bytes in the log)").toEqual({ wal: before, views: built0 });
  ioBudget.setIsIdle(() => false);
  await views.waitForRecallConstructionIdleForTest(r);
  for (let i = 0; i < 400 && viewsBuilt() === built0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(viewsBuilt(), "the build resumes on the next active minute").toBeGreaterThan(built0);
}, 60_000);
/** The ledger as the runner reads it (io-budget.ts admissionIdle, the verdict idleQuiet reads), as revoke-idle-room witnesses set it. */
function ledgerIdle(idle: () => boolean): void {
  vi.spyOn(ioBudget, "admissionIdle").mockImplementation(idle);
  vi.spyOn(ioBudget, "nextAdmissionMs").mockReturnValue(37_000);
}
async function advance(ms: number, step = 250): Promise<void> {
  await loopTurn();
  for (let left = ms; left > 0; left -= step) { await vi.advanceTimersByTimeAsync(Math.min(step, left)); await loopTurn(); }
}
function revokeFixture(): WritetimeFixture {
  let now = 1_000_000; setRevokeBudgetClock(() => now += 0);
  const fx = new WritetimeFixture().cert(true);
  fx.reply("line-1", "reply", 10).job(1, 11);
  return fx;
}

it("TIDY: on an idle minute the revocation runner's non-closing tidy writes nothing, and resumes on the next active minute", async () => {
  f = revokeFixture();
  // a revoke whose walk wrote every mark: phase tidy, no pending row (no reader is held under it: not closing work)
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='tidy' WHERE revoke_id=1").run();
  let idle = true; ledgerIdle(() => idle);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); setRevokeBudgetClock();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const changes = () => Number(f!.db.prepare("SELECT total_changes() AS n").get()!.n);
  const job = () => f!.db.prepare("SELECT phase,state FROM memory_revoke_jobs WHERE revoke_id=1").get() ?? null;
  const before = changes(), jobBefore = job();
  runner.wakeMemoryRevocation(() => f!.db, { busy: () => false });
  await advance(3 * 60_000);
  expect({ changes: changes() - before, job: job() }, "three idle minutes: the tidy writes no row").toEqual({ changes: 0, job: jobBefore });
  idle = false;
  await advance(2 * 60_000);
  expect(changes() - before, "the tidy resumes on the next active minute").toBeGreaterThan(0);
}, 60_000);

it("PRIVACY: an owner's revoke (closing work) completes while the owner is idle", async () => {
  f = revokeFixture();
  f.pending("line-1", 1, 1);
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='mark',kind='line' WHERE revoke_id=1").run();
  marker.enqueueNode(f.db, 1, { kind: "line", threadId: "line-1", lsn: 10 });
  ledgerIdle(() => true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); setRevokeBudgetClock();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const pending = () => Number(f!.db.prepare("SELECT count(*) AS n FROM memory_deny_pending WHERE revoke_id=1").get()!.n);
  const read = () => refsLookup(f!.db, [{ kind: "line", threadId: "line-1", messageId: "reply" }], CONTENT).state;
  expect(read(), "the revoked line is held from the owner's commit").not.toBe("shown");
  runner.wakeMemoryRevocation(() => f!.db, { busy: () => false });
  let doneAt = -1;
  for (let ms = 0; ms < 30 * 60_000; ms += ms < 10_000 ? 250 : 60_000) {
    if (pending() === 0) { doneAt = ms; break; }
    expect(read(), `the revoked line stays unreadable at ${ms} ms`).not.toBe("shown");
    await advance(ms < 10_000 ? 250 : 60_000, ms < 10_000 ? 4 : 250);
  }
  expect(read(), "after the revoke completes the line is unreadable").not.toBe("shown");
  expect({ completed: doneAt >= 0, withinBase: doneAt >= 0 && doneAt <= 250 }, `the owner's revoke completed while idle (doneAt ${doneAt} ms)`).toEqual({ completed: true, withinBase: true });
}, 300_000);

/** Waits for a fresh minute (its idle allowance unspent by the setup's writes) when fewer than `need` ms of this minute are left. */
async function freshMinute(need: number): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < need) await new Promise(resolve => setTimeout(resolve, left + 1_000));
}
it("W-GATE: on an idle minute the write gate (io-budget.ts instrumentDatabase, idleQuiet) refuses a background memory write the BG ticket does not cover (boot recovery asks BOOT_RECOVERY), 0 bytes to messages.db; it lands on the next active minute", async () => {
  database().exec("CREATE TABLE IF NOT EXISTS idle_gate_probe(x INTEGER)");
  await stopWalMaintenance();
  // a fresh minute: the probe's own setup writes were the minute before, so an idle BOOT_RECOVERY ticket would have its whole room
  await new Promise(resolve => setTimeout(resolve, 60_000 - (Date.now() % 60_000) + 1_000));
  ioBudget.setIsIdle(() => true);
  expect(ioBudget.admissionIdle(), "setup: the minute is judged idle").toBe(true);
  const rows = () => Number(database().prepare("SELECT count(*) AS n FROM idle_gate_probe").get()!.n);
  const outcome = (run: () => unknown) => { try { run(); return "wrote"; } catch (error) { return isBgDeferred(error) ? "deferred" : `threw ${String(error)}`; } };
  const write = () => ioBudget.withSource("memory-boot-recovery", () => database().prepare("INSERT INTO idle_gate_probe VALUES (1)").run());
  // the boot's claim is live, as on a booted server whose transcript pass is owed (database.ts:224 claimBootRecovery(() => !diskFloorRefusing())):
  // BOOT_RECOVERY admission has no idle clause of its own, so the write gate's idleQuiet line is the only thing that defers it below
  const claim = ioBudget as unknown as { bootRecoveryAllowed?: () => boolean };
  const prior = claim.bootRecoveryAllowed; claim.bootRecoveryAllowed = () => true;
  try {
    const before = walMark();
    const idle = outcome(write);
    expect({ idle, wal: walMark(), rows: rows() }, "an idle minute: the boot recovery's write is deferred by the write gate (0 frames, 0 bytes in the log)")
      .toEqual({ idle: "deferred", wal: before, rows: 0 });
    ioBudget.setIsIdle(() => false);
    expect([outcome(write), rows()], "the write lands on the next active minute").toEqual(["wrote", 1]);
  } finally { claim.bootRecoveryAllowed = prior; }
}, 120_000);

it("W-TURN: the first turn after an idle stretch (index.ts turn.started -> noteForegroundActivity) runs the recall applier an idle minute paused, on that turn, not at the minute's end", async () => {
  setMemoryMode("active");
  const r = roster();
  reconcileMemoryRoster(r);
  await stopWalMaintenance();
  ioBudget.setIsIdle(() => false);
  views.prepareRosterRecallViews(r);
  await views.waitForRecallConstructionIdleForTest(r);
  views.startRecallViewMaintenance();
  const db = database(), mark = () => views.recallAppliedMarkForTest(db).applied ?? -1;
  for (let i = 0; i < 200 && views.recallAppliedMarkForTest(db).members.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(views.recallAppliedMarkForTest(db).members.length, "setup: the reader's view is maintained by the applier").toBeGreaterThan(0);
  await new Promise(resolve => setTimeout(resolve, 300));
  // at least 20 s of this minute left, so the minute's end (the paused applier's own deadline) cannot be what runs it below
  await freshMinute(25_000);
  ioBudget.setIsIdle(() => true);
  expect(ioBudget.admissionIdle(), "setup: the minute is judged idle").toBe(true);
  const applied0 = mark();
  // a change the view must apply: one journal row (as the record triggers write it), the applier woken as on any journal write
  db.prepare("INSERT INTO memory_recall_changes(kind,object_id,version) VALUES('record','idle-turn-probe',1)").run();
  const head = Number(db.prepare("SELECT coalesce(max(sequence),0) AS n FROM memory_recall_changes").get()!.n);
  expect(head, "setup: the journal has a row above the applied mark").toBeGreaterThan(applied0);
  const { raise } = await import("./wake.ts");
  raise("journal");
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(mark(), "an idle minute: the applier does not apply (paused to the next minute's look)").toBe(applied0);
  // the owner's turn starts: index.ts turn.started calls exactly this; the bot tables (isIdle) have not moved yet
  const startedAt = Date.now(), minuteEnd = (Math.floor(startedAt / 60_000) + 1) * 60_000;
  ioBudget.noteForegroundActivity();
  for (let i = 0; i < 300 && mark() < head; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect({ applied: mark() >= head, beforeMinuteEnd: Date.now() < minuteEnd - 10_000 }, `the first turn after idle runs the paused applier on that turn (${Date.now() - startedAt} ms after turn start)`)
    .toEqual({ applied: true, beforeMinuteEnd: true });
}, 120_000);

it("W-BOOT: boot recovery (database.ts startBackgroundUpgrade, the message-index transcript pass under claimBootRecovery) (its idle pause is W-GATE) with owner-turn-only activity (a turn each moment, none held between), finishes within one ACTIVE minute under the BG cap (MAIN-RULING 2026-11-25T07:09:02Z)", async () => {
  const { startBackgroundUpgrade } = await import("../database.ts");
  const { backgroundJobsPending } = await import("./upgrade-background.ts");
  const { ownerFirst } = await import("../owner-first.ts");
  const db = database();
  // a backlog of many walker slices (each slice ~50 ms): base's only path is one forced slice per BACKGROUND_DEFER_PROGRESS_MS (15 s)
  const put = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 1; i <= 6_000; i++) { const m = { id: `boot-${i}`, at: i, role: i % 2 ? "bot" : "user", kind: "text", text: `fixture line ${i}`, turnId: `turn-${Math.ceil(i / 10)}` }; put.run("boot-thread", m.id, i, m.role, m.kind, m.text, JSON.stringify(m)); }
  db.exec("COMMIT");
  // the transcript indexes left unfinished, as an upgrade from v1.0.20/21 or a crash leaves them: the walker (message-index) is owed
  db.exec("DELETE FROM open_card; DELETE FROM browser_check_pending; DELETE FROM turn_first; DELETE FROM transcript_index_state WHERE name IN ('open_card','browser_check','turn_first')");
  expect(backgroundJobsPending(db), "setup: the boot transcript pass is owed").toContain("message-index");
  await stopWalMaintenance();
  // at least 40 s of this minute left, so neither the minute's last 5 s nor its end decides the outcome below
  await freshMinute(45_000);
  const minute = Math.floor(Date.now() / 60_000);
  // the owner chats: every 100 ms a turn starts and ends (index.ts turn.started -> noteForegroundActivity), never held across a slice
  const turn = () => { const end = ownerFirst.beginOwnerTurn(); ioBudget.noteForegroundActivity(); end(); };
  // the owner has already chatted this minute when the pass starts (a turn started and ended: foregroundActivity, no turn held)
  turn();
  const turns = setInterval(() => { const end = ownerFirst.beginOwnerTurn(); ioBudget.noteForegroundActivity(); end(); if (noted.length < 5) noted.push(permitted()); }, 100);
  const errors: string[] = [];
  const permitted = () => (ioBudget as unknown as { bootRecoveryPermitted(): boolean }).bootRecoveryPermitted();
  const permittedAtStart = permitted();
  const sliceSeen: string[] = [], noted: boolean[] = [];
  const handle = startBackgroundUpgrade({ afterSlice: job => { sliceSeen.push(`${job}:${permitted()}:${ioBudget.currentSource()}`); }, onError: (job, error) => { errors.push(`${job}: ${isBgDeferred(error) ? "deferred" : String(error)}`); } });
  const slices = () => handle.slices;
  try {
    expect(ioBudget.admissionIdle(), "setup: an ACTIVE minute (the owner's turns)").toBe(false);
    const done = await Promise.race([handle.done.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 12_000))]);
    expect({ done, pending: backgroundJobsPending(db).includes("message-index"), sameMinute: Math.floor(Date.now() / 60_000) === minute },
      `owner-turn-only activity: the boot transcript pass (${slices()} slices) finishes within 12 s of the active minute it started in (base: refused all minute by foregroundActivity, one forced slice per 15 s)`)
      .toEqual({ done: true, pending: false, sameMinute: true });
  } finally { clearInterval(turns); handle.stop(); console.log(`[W-BOOT] permitted at start ${permittedAtStart}, slices ${handle.slices}, errors ${JSON.stringify(errors.slice(0, 5))}, slices seen ${JSON.stringify(sliceSeen.slice(0, 6))}, permitted after a turn ${JSON.stringify(noted)}`); }
}, 120_000);
