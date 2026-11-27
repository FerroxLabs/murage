// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: lane I (designs/memv2-I/KILLSUITE.md "Open, registration, wake and lane I transactions": the I2..I5 begin, precommit,
// rollback and publish rows; evidence plan design-1022-memv2-I-evidence row 2b "a forced child-kill case per lane-I row, fixed
// allocation row -> (seed, cut)"). FORCED below is generated from testing/killsuite-plan.ts (disposition "forced"), so a row credited
// there without a case here, or a case whose child never reached its cut, fails.
// Each case: the fixture of migration-v2-kill.test.ts in small (a standing forget for M2, a legacy journal under a ready view for M3,
// dead versions' terms for M4, settled turns' jobs for M5), an uninterrupted reference run to the end, then the same fixture (same id
// stream) driven by the same driver to the row's task, where ONE batch runs in a child process (testing/memv2-kill-child.ts: production
// open, the real runner slice on the real steps) that parks at the row's own statement of database.ts transaction() and is killed by
// its exact PID with SIGKILL. The recovered file is read through a raw reader before anything opens it and held to the row's invariant;
// then the restart goes through the REAL runner start (startMigrationV2 on the wake bus, no harness slice) and must run the task's next
// batch on the new handle; then the driver runs to the end, which must equal the reference run row for row. The full P-suite judge is
// not run at these cuts: on a recovered file it needs an owner turn that prepares a recall view and commits (H2/H3's committed judge
// child, seat memv2-I-fable); what these cases judge is each row's own durable invariant, the real restart and the exact end state.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { drainRevokeMarkerBounded, INLINE_REVOCATION, revokeDrainMigrationStep, runRevocationJobsNow, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { LAP_DELAY_MS, M6_MARKER_ID, MIGRATION_TASKS, MIGRATION_TOPIC, STALL_MAX_MS, type MigrationTask, migrationV2Finished, openRetentionLap, readMarker, RETENTION_LAP_TOPIC, registerMigrationStep, resetMigrationV2ForTests, retentionLapDue, runMigrationSlice, startMigrationV2 } from "./migration-v2.ts";
import { deadlineOf, raise, setWakeCommitTapForTest } from "./wake.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { prepareRecallContextSync, RECALL_DEAD_TERMS_ROWS, RECALL_FLUSH_ROWS } from "./recall-view.ts";
import { setRetentionPageForTests } from "./retention-v2.ts";
import { collectSessionChecksSlice } from "./session-proof-schema.ts";
import { forcedCuts } from "./testing/killsuite-plan.ts";
import { type ChildReport, type ChildSpec, contentOf, type ForcedKind, IDS, markersOf, OPENED, PARKED, useIdStream } from "./testing/memv2-kill-ids.ts";
import { judge, resetPreviewClock, viewRoster } from "./testing/memv2-psuite-kill.ts";
import { captureTurn, FIXTURE_BOT, fixtureRoster, importNotebookText } from "./testing/memv2-retention-fixture.ts";

const DAY = 24 * 60 * 60 * 1000;
let T0 = Date.parse("2027-03-01T00:00:00Z");
const FORCED = forcedCuts();
let forgotten: { id: string; version: number };

/** The kill fixture in small, deterministic per seed (the id stream makes the killed leg and its reference compare exactly). */
function buildFixture(seed: number): void {
  resetPreviewClock(); IDS.seed = seed; IDS.n = 0; IDS.inProbe = false; IDS.trace = [];
  T0 += 30 * DAY; vi.setSystemTime(T0);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(fixtureRoster); const db = database(); db.exec("UPDATE memory_meta SET mode='active'");
  // M5: settled turns' jobs, old enough to be retention work
  for (let n = 0; n < 6; n++) { vi.setSystemTime(T0 + n * DAY); captureTurn(n); }
  // M3: a legacy journal of more than two trim ranges under a ready view
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO memory_recall_changes(kind,object_id,version) SELECT 'record','legacy-journal-'||i,1 FROM n`).run(2 * RECALL_FLUSH_ROWS + 1 + seed);
  const text = (edit: string) => Array.from({ length: 5 }, (_, i) => `Fixture note ${i} kept ${edit}: ${"durable fixture words ".repeat(46)}`);
  importNotebookText(text("as first written")); importNotebookText(text("after the owner edited it"));
  reconcileMemoryRoster(viewRoster); prepareRecallContextSync(FIXTURE_BOT, "thread-a", viewRoster);
  // M2: the owner forgets a live record; its revoke is left standing for lane C's own runner (the harness drives it, below)
  const live = db.prepare("SELECT id,version FROM memory_records WHERE state='active' ORDER BY rowid").get()!;
  forgotten = { id: String(live.id), version: Number(live.version) };
  const inline = INLINE_REVOCATION.ms; INLINE_REVOCATION.ms = 0;
  try { forgetMemory(ownerMemoryTicket(), { kind: "record", id: forgotten.id }); } finally { INLINE_REVOCATION.ms = inline; }
  // lane C's runner (woken by the forget) is driven only by the harness, as in migration-v2-kill.test.ts (row 4b)
  stopMemoryRevocation();
  prepareRecallContextSync(FIXTURE_BOT, "thread-a", viewRoster);
  // M4: dead versions' terms, more than two batches on the first one
  const view = db.prepare("SELECT view_id,generation FROM memory_recall_views WHERE state='ready' LIMIT 1").get()!;
  const dead = db.prepare("SELECT id,version FROM memory_records WHERE state NOT IN ('active','candidate') ORDER BY rowid").all();
  dead.forEach((row, k) => db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO memory_recall_view_terms SELECT ?,?,'legacy'||i,i,?,? FROM n`).run(k ? 3 : 2 * RECALL_DEAD_TERMS_ROWS + 7, view.view_id, view.generation, row.id, row.version));
  // (an hour short of 12 days: the youngest turn's job stays young while the overlap case below lets fake time run a few minutes)
  vi.setSystemTime(T0 + 12 * DAY - 60 * 60 * 1000);
}

let m2Waits = 0;
/** The driver of migration-v2-kill.test.ts: after a slice, lane C's bounded revoke turn while M2 waits, and one slice of lane H's lap. */
function others(outcome: { more: boolean; stalled?: string }): boolean {
  const db = database();
  if (outcome.stalled === "M2") { if (++m2Waits % 4 === 0) runRevocationJobsNow(db); else drainRevokeMarkerBounded(db, { rows: 1, ms: Number.POSITIVE_INFINITY }); }
  collectSessionChecksSlice(db, Date.now());
  return outcome.more || outcome.stalled !== undefined || !db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id=?").get(M6_MARKER_ID);
}
const upcoming = () => MIGRATION_TASKS.find(task => !readMarker(database(), task)?.done);
const m2Drained = () => revokeDrainMigrationStep(database(), null, 0).done;
function endState(db: DatabaseSync) {
  return {
    journal: db.prepare("SELECT sequence,kind,object_id,version FROM memory_recall_changes ORDER BY sequence").all(),
    floor: db.prepare("SELECT projection_floor FROM memory_recall_epoch").all(),
    views: db.prepare("SELECT view_id,state,watermark FROM memory_recall_views ORDER BY view_id,generation").all(),
    jobs: db.prepare("SELECT source_id,source_revision,stage,status FROM memory_jobs ORDER BY 1,2,3").all(),
    terms: Number(db.prepare("SELECT count(*) AS n FROM memory_recall_view_terms").get()!.n),
    revokes: db.prepare("SELECT revoke_id,phase,state FROM memory_revoke_jobs ORDER BY 1").all(),
    // every marker's cursor exactly, its times relative to the fixture's start (each build starts 30 days after the last); `at`, the
    // wall-clock time M5's pass ran, is the only field left out
    markers: db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE id LIKE 'memory-v2:%' ORDER BY id").all().map(row => {
      const intent = JSON.parse(String(row.intent)) as { cursor?: Record<string, unknown> | null };
      if (intent.cursor && typeof intent.cursor === "object") {
        const { at: _at, ...cursor } = intent.cursor;
        if (typeof cursor.young === "number") cursor.young -= T0;
        intent.cursor = cursor;
      }
      return `${String(row.id)} ${JSON.stringify(intent)}`;
    }),
    finished: migrationV2Finished(db),
  };
}
function rawRead<T>(read: (raw: DatabaseSync) => T): T {
  const raw = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  raw.exec("PRAGMA busy_timeout=15000");
  try { return read(raw); } finally { raw.close(); }
}
const recovered = () => rawRead(raw => ({ markers: markersOf(raw), content: contentOf(raw) }));

const CHILD = fileURLToPath(new URL("./testing/memv2-kill-child.ts", import.meta.url));
/** KILLSUITE crash protocol steps 3 to 5 (the r11 protocol of migration-v2-kill.test.ts childKill): spawn, let the production open
 * finish, read the pre-cut snapshot, let the child go on, wait for its one PARKED line, SIGKILL by exact PID, await the exit. */
async function childKill(kind: ForcedKind, seed: number, opened: () => void, unit?: "lap" | "due"): Promise<ChildReport & { signal: string | null; code: number | null; spawned: number }> {
  closeDatabase();
  // armed: a product mutant gated on __memv2MutantArmed acts only in this child, inside the unit under the cut (the reference run and the
  // harness's own driving are never mutated, so a mutant reaches the row's assertion instead of breaking the run before it)
  const spec: ChildSpec = { kind, now: Date.now(), seed, ids: IDS.n, drainAt: 0, armed: true, retentionPage: 2, ...(unit ? { unit } : {}) };
  const child = spawn(process.execPath, [CHILD], { env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR, MEMV2_KILL_CHILD: JSON.stringify(spec) }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  const line = <T,>(mark: string) => new Promise<T | null>(resolve => {
    const look = () => { const found = out.split("\n").find(l => l.startsWith(mark) && out.includes(`${l}\n`)); if (found) resolve(JSON.parse(found.slice(mark.length)) as T); };
    child.stdout.on("data", look); look(); void exited.then(() => resolve(null));
  });
  child.stdout.on("data", chunk => { out += String(chunk); });
  child.stderr.on("data", chunk => { err += String(chunk); });
  const parked = line<ChildReport>(PARKED), open = await Promise.race([line<{ ids: number }>(OPENED), parked.then(() => null)]);
  let report: ChildReport | null = null;
  try {
    if (open) { IDS.n = open.ids; opened(); closeDatabase(); child.stdin.write("go\n"); }
    report = await parked;
  } finally { if (child.exitCode === null && child.signalCode === null) process.kill(child.pid!, "SIGKILL"); }
  const end = await exited;
  if (!report) throw new Error(`kill child ended before its cut (${kind}): ${JSON.stringify(end)} ${err.slice(-3000)} ${out.slice(-500)}`);
  IDS.n = report.ids;
  return { ...report, ...end, spawned: child.pid! };
}

beforeEach(() => { useIdStream(true); vi.useFakeTimers({ toFake: ["Date"] }); resetMigrationV2ForTests(); setRetentionPageForTests(2); m2Waits = 0; });
afterEach(() => { useIdStream(false); vi.useRealTimers(); resetMigrationV2ForTests(); setRetentionPageForTests(); closeDatabase(); });

it("every forced row of the plan is one of this file's cuts (M2..M5 x begin/precommit/rollback/publish, the lap's begin/precommit/commit), each credited to one row", () => {
  expect([...FORCED.keys()].filter(cut => !/^(M[2-5]:(begin|precommit|rollback|publish)|M3:noprogress|lap:(begin|precommit|commit|due)|open:reopen|run:(stall|admission|jobs))$/.test(cut))).toEqual([]);
  expect([...FORCED].filter(([, ids]) => ids.length !== 1)).toEqual([]);
  expect(FORCED.size).toBeGreaterThan(0);
});

const seedOf = (cut: string) => [...FORCED.keys()].sort().indexOf(cut);
const BATCH_CUTS = [...FORCED.keys()].filter(cut => cut.startsWith("M")).sort(), LAP_CUTS = [...FORCED.keys()].filter(cut => cut.startsWith("lap:") && cut !== "lap:due").sort();
it.each(BATCH_CUTS)("forced child kill at %s: the recovered file holds the row's invariant and the real runner start resumes it", async cut => {
  const [task, kind] = cut.split(":") as [MigrationTask, ForcedKind], seed = seedOf(cut), row = FORCED.get(cut)![0]!;
  // the reference: the same fixture, run to the end without a kill
  buildFixture(seed);
  expect(m2Drained(), "M2 has real work (a standing revoke)").toBe(false);
  for (let i = 0; others(runMigrationSlice({ budgetMs: 0 })); i++) if (i > 5000) throw new Error("reference: no end");
  const expected = endState(database());
  expect(expected.finished).toBe(true);

  // the killed leg: the same driver up to the row's task. M2's batch commits only once the revoke is drained (precommit, publish); a
  // begin or rollback cut is at M2's first batch, the revoke standing.
  buildFixture(seed); m2Waits = 0;
  const atCut = () => upcoming() === task && (task !== "M2" || (kind === "precommit" || kind === "publish") === m2Drained());
  for (let i = 0; !atCut(); i++) {
    if (i > 5000) throw new Error(`killed leg: ${cut} never reached`);
    if (task === "M2" && upcoming() === "M2") { others({ more: true, stalled: "M2" }); continue; }
    others(runMigrationSlice({ budgetMs: 0 }));
  }
  let pre = { markers: "", content: "" };
  const kill = await childKill(kind, seed, () => { closeDatabase(); pre = recovered(); });
  const post = recovered();
  const at = `${row} ${cut} seed ${seed}`;
  // the cut is real: the parked PID is the spawned one, killed by SIGKILL, at the row's own statement of the row's task (a child that
  // ran its slice without reaching the cut reports what it did instead and is RED here)
  expect([kill.pid === kill.spawned, kill.signal, kill.code, kill.kind, kill.task], `child kill receipt ${at}`).toEqual([true, "SIGKILL", null, kind, task]);
  if (kind === "begin") {
    // F at the outer BEGIN: the batch holds the write lock and its step has not run; the recovered file is the pre-batch file exactly.
    // (no "wrote 0": the production open's own bookkeeping before the slice is counted by total_changes too, TEMP rows included)
    expect([kill.inTransaction, post.markers === pre.markers, post.content === pre.content], `begin: unentered batch leaves work and cursor unchanged ${at}`).toEqual([true, true, true]);
  }
  if (kind === "precommit") {
    // T just before COMMIT: the step and its marker write ran in the open transaction (rows written), none of it is durable
    expect([kill.inTransaction, kill.wrote > 0, post.markers === pre.markers, post.content === pre.content], `precommit: prior progress and rows survive, nothing of the batch ${at} wrote ${kill.wrote}`).toEqual([true, true, true, true]);
  }
  if (kind === "rollback") {
    // F after the actual ROLLBACK: the batch made no progress, so the runner threw NO_PROGRESS, database.ts ran ROLLBACK and the slice
    // returned stalled (BEGIN then ROLLBACK, zero COMMIT); then the process died. Nothing of it is durable: no marker, no reported commit.
    expect([kill.inTransaction, kill.outcome?.stalled, kill.statements, post.markers === pre.markers, post.content === pre.content], `rollback: prior state after the runner's real no-progress rollback ${at}`)
      .toEqual([false, task, ["BEGIN IMMEDIATE", "ROLLBACK"], true, true]);
  }
  if (kind === "noprogress") {
    // (O08) T before the no-progress exit: the held batch's marker upsert ran in the open transaction, the runner threw NO_PROGRESS and the
    // child died at the ROLLBACK it leads to (BEGIN only, no COMMIT): the recovered file is the pre-batch file, the same cursor
    expect([kill.inTransaction, kill.statements, post.markers === pre.markers, post.content === pre.content], `no-progress exit: same cursor, nothing committed ${at}`)
      .toEqual([true, ["BEGIN IMMEDIATE"], true, true]);
  }
  if (kind === "publish") {
    // F at the transaction-scope notification after COMMIT (this batch's own post-commit hook): the batch's effects and its cursor are
    // durable together, as the child read them at the cut, before the slice returns and before the bus drains its marked wakes
    const durable = rawRead(raw => { const m = readMarker(raw, task); return m ? JSON.stringify({ cursor: m.cursor ?? null, done: m.done }) : undefined; });
    expect([kill.inTransaction, kill.committed?.content === post.content, kill.committed?.markers === post.markers, durable === kill.committed?.step, post.content !== pre.content],
      `publish: committed batch and cursor durable before publication ${at}`).toEqual([false, true, true, true, true]);
  }
  // restart: the real runner start on a fresh handle (its wake subscriber and its own raise; no harness slice) must run the runner's
  // next batch there (the task's own, or the next task's when the cut was the task's last batch), so the marker rows move from the
  // recovered ones. (M2 with its revoke still standing first gets lane C's drain, as the driver gives it, so that batch can commit:
  // "the next run redoes the interrupted work".)
  if (task === "M2") for (let i = 0; !m2Drained(); i++) { if (i > 5000) throw new Error("revoke never drained"); others({ more: true, stalled: "M2" }); }
  const resumeFrom = markersOf(database());
  expect(MIGRATION_TASKS.every(t => readMarker(database(), t)?.done), `work is left for the restart ${at}`).toBe(false);
  resetMigrationV2ForTests();
  try {
    startMigrationV2();
    for (let waited = 0; waited < 5000 && markersOf(database()) === resumeFrom; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  } finally { resetMigrationV2ForTests(); }
  expect(markersOf(database()) !== resumeFrom, `the real runner start ran the next batch on the new handle ${at} (${resumeFrom})`).toBe(true);
  // and the run ends where the uninterrupted run ends
  for (let i = 0; others(runMigrationSlice({ budgetMs: 0 })); i++) if (i > 5000) throw new Error("killed leg: no end");
  expect(endState(database()), `end state ${at}`).toEqual(expected);
}, 240_000);

// (KILLSUITE R-lap-begin, R-lap-open, R-lap-commit) The steady-state retention lap: after the migration finished, fake time passes the
// lap's durable due time and ONE openRetentionLap transaction (M5 re-opened as a lap from the start of the job table) runs in the child,
// parked at its BEGIN (nothing started), just before its COMMIT (the lap-start marker written in the open transaction) or right after
// its COMMIT (before openRetentionLap returns and its caller raises the migration wake), and killed by PID. Then the real runner start
// on a fresh handle discovers the lap work by itself (the lost wake), and the lap ends where an uninterrupted lap ends.
const LAP_START = JSON.stringify({ cursor: { pass: "jobs", after: 0, lap: true }, done: false });
const lapDue = () => {
  for (let i = 0; others(runMigrationSlice({ budgetMs: 0 })); i++) if (i > 5000) throw new Error("no end");
  const due = retentionLapDue(database(), Date.now());
  if (due === undefined) throw new Error("fixture: no lap due");
  vi.setSystemTime(Math.max(due, Date.now()) + 1000);
};
it.each(LAP_CUTS)("forced child kill at %s: the retention lap's own transaction, then the real runner start discovers the lap", async cut => {
  const kind: ForcedKind = ({ "lap:begin": "begin", "lap:precommit": "precommit", "lap:commit": "publish" } as Record<string, ForcedKind>)[cut]!, seed = 200 + seedOf(cut), row = FORCED.get(cut)![0]!;
  buildFixture(seed); lapDue();
  expect(openRetentionLap(Date.now()), "the lap opens").toBe(true);
  for (let i = 0; others(runMigrationSlice({ budgetMs: 0 })); i++) if (i > 5000) throw new Error("reference lap: no end");
  const expected = endState(database());

  // R-lap-begin is cut BEFORE the lap is due (its row: "before due the finished marker is unchanged and no work starts"); the others after
  buildFixture(seed); m2Waits = 0;
  let due = 0;
  if (kind === "begin") {
    for (let i = 0; others(runMigrationSlice({ budgetMs: 0 })); i++) if (i > 5000) throw new Error("no end");
    due = retentionLapDue(database(), Date.now())!;
    expect(due > Date.now(), "the lap is not due yet").toBe(true);
  } else lapDue();
  const done = JSON.stringify(readMarker(database(), "M5"));
  let pre = { markers: "", content: "" };
  const kill = await childKill(kind, seed, () => { closeDatabase(); pre = recovered(); }, "lap");
  const post = recovered(), at = `${row} ${cut} seed ${seed}`;
  expect([kill.pid === kill.spawned, kill.signal, kill.code, kill.kind, kill.task], `child kill receipt ${at}`).toEqual([true, "SIGKILL", null, kind, "M5"]);
  if (kind === "begin") expect([kill.inTransaction, post.markers === pre.markers, post.content === pre.content], `lap begin: before due work starts nothing, finished marker unchanged ${at}`).toEqual([true, true, true]);
  if (kind === "precommit") {
    // the lap-start marker was written in the open transaction; the prior done marker persists, not an advanced lap cursor
    // (and the marker the open transaction wrote is the lap's start at the first page, not an advanced cursor)
    expect([kill.inTransaction, kill.wrote > 0, post.markers === pre.markers, post.content === pre.content, rawRead(raw => JSON.stringify(readMarker(raw, "M5"))), kill.committed?.step], `lap open: the prior done marker persists ${at}`)
      .toEqual([true, true, true, true, done, LAP_START]);
  }
  if (kind === "publish") {
    // the committed lap start: M5 re-opened at the first page, durable before any wake
    expect([kill.inTransaction, kill.committed?.content === post.content, rawRead(raw => JSON.stringify(readMarker(raw, "M5"))), kill.committed?.step], `lap commit: the lap-start cursor durable ${at}`)
      .toEqual([false, true, LAP_START, LAP_START]);
  }
  if (kind === "begin") {
    // before due: the real runner start on a fresh handle starts no lap (the finished marker stays) and arms the lap at its due time
    resetMigrationV2ForTests();
    try {
      startMigrationV2();
      for (let waited = 0; waited < 300; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
      // a stray wake of the lap's own topic before due (any fan-out may raise it): the lap's subscriber runs openRetentionLap, which
      // must start nothing before the durable due time
      raise(RETENTION_LAP_TOPIC);
      for (let waited = 0; waited < 300; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
      expect([JSON.stringify(readMarker(database(), "M5")), deadlineOf(RETENTION_LAP_TOPIC)], `before due no lap starts, its deadline armed ${at}`).toEqual([done, due]);
    } finally { resetMigrationV2ForTests(); }
    // then the lap comes due, as in the reference
    vi.setSystemTime(due + 1000);
  }
  // restart: the real runner start (no harness slice, no openRetentionLap call) finds the lap work: its migration slice, its lap deadline
  // armed from the durable due time and the lap's own subscriber; the M5 marker moves from the recovered one
  const resumeFrom = JSON.stringify(readMarker(database(), "M5"));
  resetMigrationV2ForTests();
  try {
    startMigrationV2();
    for (let waited = 0; waited < 5000 && JSON.stringify(readMarker(database(), "M5")) === resumeFrom; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  } finally { resetMigrationV2ForTests(); }
  expect(JSON.stringify(readMarker(database(), "M5")) !== resumeFrom, `the real runner start ran the lap on the new handle ${at} (${resumeFrom})`).toBe(true);
  for (let i = 0; others(runMigrationSlice({ budgetMs: 0 })); i++) if (i > 5000) throw new Error("killed lap: no end");
  expect(endState(database()), `lap end state ${at}`).toEqual(expected);
}, 240_000);

// (KILLSUITE R-lap-due) After the migration's pass, a settled turn's capture commits new jobs in a child that is killed by PID at once
// (before its jobs wake arms a deadline). Two hours later the real runner start on a fresh handle arms the lap at the time both inputs
// give, the durable post-pass write rule (the pass's own `at` + LAP_DELAY_MS) and the age rule: the same deadline the dead process
// would have computed, not one recomputed from the restart's present time.
it("forced child kill at lap:due: a post-pass job write's lap deadline survives the restart unchanged", async () => {
  const seed = 300, row = FORCED.get("lap:due")![0]!;
  // (the pass runs when every fixture job is past the 7-day age, so the post-pass write rule, not the age rule, sets the deadline)
  buildFixture(seed); vi.setSystemTime(T0 + 30 * DAY);
  for (let i = 0; others(runMigrationSlice({ budgetMs: 0 })); i++) if (i > 5000) throw new Error("no end");
  const cursor = readMarker(database(), "M5")?.cursor as { at?: number; young?: number; seen?: number } | undefined;
  expect([readMarker(database(), "M5")?.done, typeof cursor?.at, typeof cursor?.seen], "M5's pass finished with its inputs").toEqual([true, "number", "number"]);
  const kill = await childKill("fence", seed, () => {}, "due");
  expect([kill.pid === kill.spawned, kill.signal, kill.code, kill.kind, kill.inTransaction], `child kill receipt ${row}`).toEqual([true, "SIGKILL", null, "fence", false]);
  // the post-pass write is durable (the job table grew past the pass's `seen`)
  expect(rawRead(raw => Number(raw.prepare("SELECT max(rowid) AS m FROM memory_jobs").get()!.m)) > cursor!.seen!, `the post-pass job write committed ${row}`).toBe(true);
  const want = Math.min(cursor!.at! + LAP_DELAY_MS, cursor!.young === undefined ? Number.POSITIVE_INFINITY : cursor!.young + 7 * DAY);
  vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
  resetMigrationV2ForTests();
  let armed: number | undefined;
  try {
    startMigrationV2();
    for (let waited = 0; waited < 5000 && (armed = deadlineOf(RETENTION_LAP_TOPIC)) === undefined; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  } finally { resetMigrationV2ForTests(); }
  expect([armed, armed! > Date.now()], `the restart armed the lap at the durable due time ${row} (now ${Date.now()})`).toEqual([want, true]);
}, 240_000);

// (KILLSUITE O07, F at reopen registration; in process: the row is the writable REOPEN of a handle, so the cut is the close, not a child
// kill) The real runner, started, slices M2 while the forget's revoke stands, stalls, and arms its back-off deadline (fake time does not
// reach it: that wake is effectively dropped). The revoke is then drained offline (nothing raises the migration topic), and for a while
// nothing runs (the control). The file is closed and reopened: the reopen's install re-raises the runner, which finishes M2 on the new
// handle with no harness slice.
it("in-process forced case O07: a reopened writable handle re-raises the migration runner when its pending wake was dropped", async () => {
  const seed = 400, row = FORCED.get("open:reopen")![0]!;
  buildFixture(seed);
  expect(m2Drained(), "M2 has real work (a standing revoke)").toBe(false);
  let m2Calls = 0;
  resetMigrationV2ForTests();
  registerMigrationStep("M2", (tx, cursor, now) => { m2Calls++; return revokeDrainMigrationStep(tx, cursor, now); });
  const settle = async (ms: number) => { for (let waited = 0; waited < ms; waited += 10) await new Promise(resolve => setTimeout(resolve, 10)); };
  try {
    startMigrationV2();
    for (let waited = 0; waited < 5000 && m2Calls === 0; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    // (M2's first batch commits its pending cursor; the batches after it stall and roll back)
    expect([m2Calls > 0, readMarker(database(), "M2")?.done], `the started runner sliced M2 and stalled ${row}`).toEqual([true, false]);
    const m2Stalled = JSON.stringify(readMarker(database(), "M2"));
    for (let i = 0; !m2Drained(); i++) { if (i > 5000) throw new Error("revoke never drained"); others({ more: true, stalled: "M2" }); }
    const calls = m2Calls;
    await settle(300);
    expect([m2Calls, JSON.stringify(readMarker(database(), "M2"))], `control: nothing raises the runner while its wake is dropped ${row}`).toEqual([calls, m2Stalled]);
    closeDatabase();
    database();
    for (let waited = 0; waited < 5000 && !readMarker(database(), "M2")?.done; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    expect([m2Calls > calls, readMarker(database(), "M2")?.done], `the reopen re-raised the runner and it finished M2 on the new handle ${row}`).toEqual([true, true]);
  } finally { resetMigrationV2ForTests(); }
}, 240_000);

// (KILLSUITE O09, F after a stalled ROLLBACK; in process, through the real runner) The started runner meets M2 with the revoke standing:
// after its first batch (its pending cursor) the batches roll back and the runner arms a FINITE bounded retry. The hold then clears (lane C's drain) and
// once fake time reaches the retry the runner wakes again by itself and finishes M2; M3 never ran before M2 (strict order).
it("in-process forced case O09: a stalled batch arms a bounded retry that runs M2 once its hold clears", async () => {
  const seed = 410, row = FORCED.get("run:stall")![0]!;
  buildFixture(seed);
  expect(m2Drained(), "M2 has real work (a standing revoke)").toBe(false);
  let m2Calls = 0;
  // (ASTRA 4383c77075) the commit receipt of each M2 batch: commits made by the runner (a migration-v2.ts frame) are counted against the
  // batch that ran last; a batch that moved nothing (not done, cursor unchanged, no row written) is a stalled batch and must leave no commit
  const commitsOf: number[] = [], stalledCalls: number[] = [];
  resetMigrationV2ForTests();
  registerMigrationStep("M2", (tx, cursor, now) => {
    // stalled = what the runner calls no progress (migration-v2.ts :119-:121): not done, the cursor unchanged AND no row written
    const changes = () => Number((tx.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
    const call = ++m2Calls, wrote = changes(), result = revokeDrainMigrationStep(tx, cursor, now);
    commitsOf[call] = 0;
    if (!result.done && JSON.stringify(result.cursor ?? null) === JSON.stringify(cursor ?? null) && changes() === wrote) stalledCalls.push(call);
    return result;
  });
  // only the batch transaction's own commit counts (the runner's stalledOr frame on the committing stack), not another runner transaction;
  // and only a transaction end that moved the main file's wal-index (bytes 16..40 of -shm) is a commit: the bus reports a ROLLBACK too
  const shm = `${String((database().prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find(r => r.name === "main")!.file)}-shm`;
  const stamp = () => { const fd = openSync(shm, "r"); try { const b = Buffer.alloc(48); readSync(fd, b, 0, 48, 0); return b.subarray(16, 40).toString("hex"); } finally { closeSync(fd); } };
  let seen = stamp();
  setWakeCommitTapForTest(() => {
    const now = stamp(), moved = now !== seen; seen = now;
    if (!moved) return;
    const limit = Error.stackTraceLimit; Error.stackTraceLimit = 200; const stack = new Error().stack ?? ""; Error.stackTraceLimit = limit;
    if (m2Calls > 0 && /at stalledOr \(.*[\\/]memory[\\/]migration-v2\.ts:/.test(stack)) commitsOf[m2Calls] = (commitsOf[m2Calls] ?? 0) + 1;
  });
  // (C3 transaction outcome, FABLE 5c4ada4123 H-A) the wal-index stamp cannot tell a zero-frame COMMIT from a ROLLBACK, so record the
  // statement that actually ended each outer transaction on this handle, as production transaction() (database.ts) sends it, and whether
  // it returned: observation only, the native exec runs every statement unchanged
  const handle = database() as unknown as { exec(sql: string): unknown }, nativeExec = handle.exec;
  const ends: { call: number; end: string; ok: boolean; batch: boolean }[] = [];
  handle.exec = function (this: unknown, sql: string) {
    const end = /^\s*(COMMIT|ROLLBACK)\s*;?\s*$/i.exec(sql)?.[1]?.toUpperCase();
    if (!end) return nativeExec.call(handle, sql);
    const limit = Error.stackTraceLimit; Error.stackTraceLimit = 200; const stack = new Error().stack ?? ""; Error.stackTraceLimit = limit;
    const entry = { call: m2Calls, end, ok: false, batch: /at stalledOr \(.*[\\/]memory[\\/]migration-v2\.ts:/.test(stack) };
    ends.push(entry);
    const value = nativeExec.call(handle, sql); entry.ok = true; return value;
  };
  try {
    startMigrationV2();
    for (let waited = 0; waited < 5000 && (stalledCalls.length === 0 || deadlineOf(MIGRATION_TOPIC) === undefined); waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    // O09-NOCOMMIT: every stalled batch ended in a real, successful ROLLBACK and never a COMMIT; a batch that moved committed
    const endsOf = (call: number) => ends.filter(e => e.batch && e.call === call).map(e => `${e.end}:${e.ok}`);
    expect({ stalled: stalledCalls.length > 0, stalledEnds: stalledCalls.map(endsOf), progressCommitted: [...new Set(ends.filter(e => e.batch && !stalledCalls.includes(e.call)).map(e => e.call))].some(call => endsOf(call).includes("COMMIT:true")) },
      `O09-NOCOMMIT: each stalled M2 batch ended in ROLLBACK, not COMMIT ${row} (ends ${JSON.stringify(ends.slice(0, 12))})`).toEqual({ stalled: true, stalledEnds: stalledCalls.map(() => ["ROLLBACK:true"]), progressCommitted: true });
    const markerAtStall = JSON.stringify(readMarker(database(), "M2") ?? null);
    expect({ stalled: stalledCalls.length > 0, committed: stalledCalls.map(call => commitsOf[call]), progressCommitted: commitsOf.some((n, call) => n > 0 && !stalledCalls.includes(call)) },
      `O09: a stalled M2 batch emitted no commit receipt ${row} (calls ${m2Calls}, commits ${JSON.stringify(commitsOf)})`).toEqual({ stalled: true, committed: stalledCalls.map(() => 0), progressCommitted: true });
    const retry = deadlineOf(MIGRATION_TOPIC);
    // (M2's first batch commits its pending cursor; the batches after it stall and roll back)
    expect([m2Calls > 0, readMarker(database(), "M2")?.done, readMarker(database(), "M3"), retry !== undefined && retry > Date.now() && retry <= Date.now() + STALL_MAX_MS],
      `stalled: M2 not done, M3 not admitted, a finite retry armed ${row} (${retry})`).toEqual([true, false, undefined, true]);
    for (let i = 0; !m2Drained(); i++) { if (i > 5000) throw new Error("revoke never drained"); others({ more: true, stalled: "M2" }); }
    expect(JSON.stringify(readMarker(database(), "M2") ?? null), `O09: the marker did not move while the batch stood stalled ${row}`).toBe(markerAtStall);
    setWakeCommitTapForTest(null);
    vi.setSystemTime(retry! + 1);
    for (let waited = 0; waited < 8000 && !readMarker(database(), "M2")?.done; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    expect(readMarker(database(), "M2")?.done, `the bounded retry woke the runner and it finished M2 ${row}`).toBe(true);
  } finally { handle.exec = nativeExec; setWakeCommitTapForTest(null); resetMigrationV2ForTests(); }
}, 240_000);

// (KILLSUITE O10, F before task admission; in process, through the real runner) With M2..M4 finished and M5 left, the runner started with
// an owner turn live admits nothing (M5 waits while a turn is live) and arms its live retry; when the turn ends and the retry comes, M5 runs.
it("in-process forced case O10: M5 is not admitted while an owner turn is live, and runs once it ends", async () => {
  const seed = 420, row = FORCED.get("run:admission")![0]!;
  buildFixture(seed);
  for (let i = 0; upcoming() !== "M5"; i++) { if (i > 5000) throw new Error("M5 never reached"); others(runMigrationSlice({ budgetMs: 0 })); }
  const m5 = JSON.stringify(readMarker(database(), "M5") ?? null);
  let live = true;
  resetMigrationV2ForTests();
  try {
    startMigrationV2(() => live);
    for (let waited = 0; waited < 300; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    const retry = deadlineOf(MIGRATION_TOPIC);
    expect([JSON.stringify(readMarker(database(), "M5") ?? null), retry !== undefined && retry > Date.now()], `a live turn: M5 not admitted, a live retry armed ${row}`).toEqual([m5, true]);
    live = false; vi.setSystemTime(retry! + 1);
    for (let waited = 0; waited < 8000 && JSON.stringify(readMarker(database(), "M5") ?? null) === m5; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    expect(JSON.stringify(readMarker(database(), "M5") ?? null) !== m5, `the turn ended: M5 admitted ${row}`).toBe(true);
  } finally { resetMigrationV2ForTests(); }
}, 240_000);

// (KILLSUITE R-lap-subscribe, F; in process, through the real runner's jobs subscriber) After the migration finished with nothing due, a job
// write that ROLLS BACK arms no lap (its wake row went with it), and a committed one (a settled turn's capture) arms the lap's deadline at
// the durable post-pass time, through the real "jobs" wake, with no harness call of armLap.
it("in-process forced case R-lap-subscribe: a committed jobs wake arms a finite lap, a rolled-back job write does not", async () => {
  const seed = 430, row = FORCED.get("run:jobs")![0]!;
  buildFixture(seed); vi.setSystemTime(T0 + 30 * DAY);
  for (let i = 0; others(runMigrationSlice({ budgetMs: 0 })); i++) if (i > 5000) throw new Error("no end");
  const at = (readMarker(database(), "M5")?.cursor as { at?: number } | undefined)?.at;
  const jobsTop = () => Number(database().prepare("SELECT max(rowid) AS m FROM memory_jobs").get()!.m);
  const settle = async (ms: number) => { for (let waited = 0; waited < ms; waited += 10) await new Promise(resolve => setTimeout(resolve, 10)); };
  resetMigrationV2ForTests();
  try {
    startMigrationV2();
    await settle(200);
    const top = jobsTop();
    expect([typeof at, deadlineOf(RETENTION_LAP_TOPIC)], `finished, nothing due: no lap armed ${row}`).toEqual(["number", undefined]);
    // a job write that rolls back
    expect(() => transaction(() => { captureTurn(991); throw new Error("rolled back on purpose"); })).toThrow("rolled back on purpose");
    await settle(300);
    expect([jobsTop(), deadlineOf(RETENTION_LAP_TOPIC)], `a rolled-back job write arms no lap ${row}`).toEqual([top, undefined]);
    // a committed one
    captureTurn(992);
    for (let waited = 0; waited < 5000 && deadlineOf(RETENTION_LAP_TOPIC) === undefined; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    expect([jobsTop() > top, deadlineOf(RETENTION_LAP_TOPIC)], `a committed jobs wake armed the lap at the pass's at + LAP_DELAY_MS ${row}`).toEqual([true, at! + LAP_DELAY_MS]);
  } finally { resetMigrationV2ForTests(); }
}, 240_000);

// (KILLSUITE R-stub-off, F: the payload stub is switched off in this tree; an extra check, NOT crediting the row: this fixture has no
// version the stub pass would select (three revisions back, no evidence, no pending job), so turning the stub on changes nothing here) M5 is killed in a child inside its batch (just before its
// COMMIT), recovered, restarted through the real runner start and run to the end: every source version's payload and content hash is
// byte for byte what the fixture wrote (old enough versions exist, so a stub pass that ran would rewrite some).
it("forced child kill in M5 with the payload stub off: no payload byte changes across the crash, the restart and the end", async () => {
  const seed = 440, row = "R-stub-off (extra check, not credited)";
  // (30 days on: the notebook's superseded first versions are past the 7-day age, so a stub pass that ran would rewrite them)
  buildFixture(seed); vi.setSystemTime(T0 + 30 * DAY);
  const payloads = () => database().prepare("SELECT rowid AS r,hex(payload) AS p,content_hash AS h FROM memory_source_versions ORDER BY rowid").all().map(r => JSON.stringify(r));
  const before = payloads(), old = Number(database().prepare("SELECT count(*) AS n FROM memory_source_versions WHERE created_at<?").get(Date.now() - 7 * DAY)?.n ?? 0);
  for (let i = 0; upcoming() !== "M5"; i++) { if (i > 5000) throw new Error("M5 never reached"); others(runMigrationSlice({ budgetMs: 0 })); }
  const kill = await childKill("precommit", seed, () => {});
  expect([kill.signal, kill.kind, kill.task], `child kill receipt ${row}`).toEqual(["SIGKILL", "precommit", "M5"]);
  resetMigrationV2ForTests();
  try {
    startMigrationV2();
    const from = markersOf(database());
    for (let waited = 0; waited < 5000 && markersOf(database()) === from; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
  } finally { resetMigrationV2ForTests(); }
  for (let i = 0; others(runMigrationSlice({ budgetMs: 0 })); i++) if (i > 5000) throw new Error("no end");
  expect([old > 0, readMarker(database(), "M5")?.done, payloads()], `payload and content hash unchanged, old versions present ${row}`).toEqual([true, true, before]);
}, 240_000);

// (FABLE/OPUS 3350e31a9a H4: "stopping lane C's runner in the harness means the runner-tick-between-slices interleaving is witnessed
// nowhere") The production overlap itself: after the fixture's forget, lane C's own revoke runner (wakeMemoryRevocation, ticking from
// its wake deadline) and the migration runner (startMigrationV2, slicing from its wake) are both started as the app starts them after
// listen, and the harness runs NO unit: it only lets fake time pass. The log shows they really interleaved (M2 was admitted and waited
// while C's runner still had revoke work, C's runner then committed, M2 then finished); the run ends where the harness-driven reference
// run ends, row for row, and the forget holds. This is why the kill harness may drive C's runner as its own logged unit (row 4b): C's
// ticks between slices change WHEN the walk lands, never where the migration ends.
it("lane C's real revoke runner and the real migration runner overlapping on the wake bus end where the harness-driven run ends", async () => {
  const seed = 101;
  buildFixture(seed);
  for (let i = 0; others(runMigrationSlice({ budgetMs: 0 })); i++) if (i > 5000) throw new Error("reference: no end");
  const expected = endState(database());

  buildFixture(seed);
  expect(m2Drained(), "M2 has real work (a standing revoke)").toBe(false);
  const log: string[] = [];
  resetMigrationV2ForTests();
  registerMigrationStep("M2", (tx, cursor, now) => { const result = revokeDrainMigrationStep(tx, cursor, now); log.push(result.done ? "M2-done" : "M2-wait"); return result; });
  // every commit on the file: lane C's runner (its tick on the stack, no migration frame) or the migration runner
  setWakeCommitTapForTest(() => {
    const stack = new Error().stack ?? "";
    if (/[\\/]migration-v2\.ts:/.test(stack)) log.push("M");
    else if (/[\\/]memory-revocation\.ts:/.test(stack)) log.push("C");
  });
  let reached = false;
  try {
    wakeMemoryRevocation(() => database());
    startMigrationV2();
    for (let i = 0; i < 4000 && !(reached = MIGRATION_TASKS.every(task => readMarker(database(), task)?.done)); i++) {
      vi.setSystemTime(Date.now() + 250);
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  } finally { setWakeCommitTapForTest(null); stopMemoryRevocation(); resetMigrationV2ForTests(); }
  const firstWait = log.indexOf("M2-wait"), done = log.indexOf("M2-done");
  const cBetween = log.slice(firstWait + 1, done < 0 ? undefined : done).filter(e => e === "C").length;
  // the overlap happened: M2 admitted and waiting while C's runner had work, C's own commits after it, then M2 done; and it ended
  expect([reached, firstWait >= 0, cBetween > 0, done > firstWait], `overlap log ${log.slice(0, 40).join(" ")} (${log.length})`).toEqual([true, true, true, true]);
  expect(judge(forgotten), "P1-W after the overlap").toBe("MEMORY_RECORD_UNAVAILABLE");
  // lane H's lap (not part of either runner) as the driver runs it, then the end state is the reference's
  for (let i = 0; !database().prepare("SELECT 1 FROM memory_scope_bindings WHERE id=?").get(M6_MARKER_ID); i++) { if (i > 5000) throw new Error("M6: no end"); collectSessionChecksSlice(database(), Date.now()); }
  // The overlap may end with a LONGER kept journal prefix than the reference (observed: one row, the M3 cursor and projection_floor one
  // lower): M3's last batch trims only up to the lowest ready watermark and never the newest row (recall-view.ts trimRecallJournalPage),
  // and when lane C's runner lands its last journal row relative to that batch is wall-clock timing. Keeping a row is never loss, so it
  // is not a finding (evidence plan row 4 decision rule); losing one is. Held exactly: every reference row is kept unchanged, the extra
  // rows are only below the reference's first row, the floor is just below each run's first kept row, nothing a ready view has not
  // applied is gone, and every other part of the end state (views, jobs, terms, revokes, the other markers, finished) is equal.
  const ended = endState(database()), rowsOf = (state: typeof ended) => state.journal.map(r => JSON.stringify(r));
  const seq = (state: typeof ended) => state.journal.map(r => Number(r.sequence));
  const extra = ended.journal.filter(r => !rowsOf(expected).includes(JSON.stringify(r))).map(r => Number(r.sequence));
  const floorOf = (state: typeof ended) => Number((state.floor[0] as { projection_floor: number }).projection_floor);
  expect({ kept: rowsOf(expected).filter(r => !rowsOf(ended).includes(r)), extraAtMostOne: extra.length <= 1, extraBelow: extra.every(n => n < Math.min(...seq(expected))),
    floorBelowFirst: [floorOf(ended) === Math.min(...seq(ended)) - 1, floorOf(expected) === Math.min(...seq(expected)) - 1] },
    `overlap journal: the reference rows all kept, extra rows ${JSON.stringify(extra)} only a longer prefix`).toEqual({ kept: [], extraAtMostOne: true, extraBelow: true, floorBelowFirst: [true, true] });
  // nothing a ready view has not applied is gone (the kill suite's journalHeld): above the lowest ready watermark the journal is gap-free
  // up to its newest row
  const newest = Math.max(...seq(ended)), low = Number(database().prepare(`SELECT min(v.watermark) AS w FROM memory_recall_views v JOIN memory_recall_epoch e ON e.id=1
    WHERE v.state='ready' AND v.watermark>=e.projection_floor`).get()?.w ?? 0);
  expect(seq(ended).filter(n => n > Math.min(low, newest)).length, `overlap journal holds every row a ready view has not applied (low ${low})`).toBe(newest - Math.min(low, newest));
  expect(newest, "overlap journal keeps the newest row").toBe(Math.max(...seq(expected)));
  // the M3 marker is held too: with no extra row it is exactly the reference's; with the one tolerated row only its trim cursor may differ,
  // and only by standing lower (it kept more), never higher; every other field (done included) is equal
  const m3 = (state: typeof ended) => state.markers.find(m => m.startsWith("memory-v2:M3 ")) ?? "";
  const m3Json = (marker: string) => JSON.parse(marker.slice(marker.indexOf(" ") + 1)) as { cursor: { deleted: number } | null; done: boolean };
  const m3Rest = (marker: string) => ({ ...m3Json(marker), cursor: undefined });
  const m3Deleted = (marker: string) => Number(m3Json(marker).cursor?.deleted ?? NaN);
  // with the one tolerated row the trim cursor stands exactly that many rows lower (it deleted exactly the rows it kept less)
  expect([m3Rest(m3(ended)), m3Deleted(m3(expected)) - m3Deleted(m3(ended))],
    `overlap M3 marker (extra rows ${extra.length}): ${m3(ended)} vs ${m3(expected)}`).toEqual([m3Rest(m3(expected)), extra.length]);
  const rest = (state: typeof ended) => ({ ...state, journal: undefined, floor: undefined, markers: state.markers.filter(m => !m.startsWith("memory-v2:M3 ")) });
  expect(rest(ended), "overlap end state apart from the journal prefix and the M3 marker held above").toEqual(rest(expected));
  console.log(`OVERLAP-MEASURE seed=${seed} log=${log.length} cBetween=${cBetween} extraPrefixRows=${extra.length}`);
}, 240_000);
