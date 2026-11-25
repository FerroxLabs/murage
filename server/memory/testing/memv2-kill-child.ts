// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Test helper for lane I's migration kill harness (owner: lane I): the CHILD PROCESS of KILLSUITE "Generator and crash protocol" steps
// 3 to 5. It opens the private profile through the production open (database()), runs ONE real unit of migration work (a runner slice,
// one bounded turn of lane C's marker drain, or one slice of lane H's lap) and, at the armed cut, reports one line and PARKS on the
// production path itself: inside the step's open transaction (work), inside the marker row's own INSERT/UPDATE statement (cursor,
// marker), inside the drain's Nth row write (drain), or the moment the batch's own COMMIT statement returned, before anything the
// transaction runs after it (publication, wake raises) and before the slice returns (commit). The harness then kills
// this exact PID with SIGKILL; nothing here ever closes the handle, rolls back or exits on its own at a cut. No tap writes a row.
import { readSync, writeSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { type ChildReport, type ChildSpec, contentOf, DRAIN_TABLES, IDS, markersOf, OPENED, PARKED, useIdStream } from "./memv2-kill-ids.ts";

const given = JSON.parse(process.env.MEMV2_KILL_CHILD ?? "null") as ChildSpec | null;
if (!given) throw new Error("memv2-kill-child: no MEMV2_KILL_CHILD spec");
const spec: ChildSpec = given;
// the fixture's clock (the harness holds its own Date at the same instant) and its id stream, before any product module loads
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args: unknown[]) { if (args.length) super(...(args as [number])); else super(spec.now); }
  static override now() { return spec.now; }
} as unknown as DateConstructor;
IDS.seed = spec.seed; IDS.n = spec.ids; useIdStream(true);
(globalThis as { __memv2MutantArmed?: boolean }).__memv2MutantArmed = spec.armed;

const { database } = await import("../../database.ts");
const { MIGRATION_TASKS, m5Step, M6_MARKER_ID, openRetentionLap, readMarker, registerMigrationStep, runMigrationSlice } = await import("../migration-v2.ts");
const { afterCommit } = await import("../../tx-scope.ts");
const { drainRevokeMarkerBounded, revokeDrainMigrationStep } = await import("../memory-revocation.ts");
const { recallDeadTermsStep, recallJournalTrimStep } = await import("../recall-view.ts");
const { setRetentionPageForTests } = await import("../retention-v2.ts");
const { collectSessionChecksSlice } = await import("../session-proof-schema.ts");

const { onWakeInstall } = await import("../wake.ts");

let handle: DatabaseSync | null = null, started = 0, ranTask: string | null = null;
const changes = (h: DatabaseSync) => Number(h.prepare("SELECT total_changes() AS n").get()!.n);
/** Reports the cut and never returns: the process stays exactly where it is (open transaction, open statement) until it is killed.
 * `stack` = the lane C / H / I production frames the cut was reached through. */
function park(report: Omit<ChildReport, "pid" | "ids" | "inTransaction" | "wrote" | "task" | "stack" | "committed">, committed?: ChildReport["committed"]): never {
  const h = handle!, stack = (new Error().stack ?? "").split("\n").map(l => /at (\S+) .*[\\/]server[\\/](memory[\\/][\w.-]+\.ts)/.exec(l)).filter(m => m && !m[2]!.includes("testing")).map(m => `${m![1]}@${m![2]}`).slice(0, 8);
  writeSync(1, `${PARKED}${JSON.stringify({ ...report, ...(committed ? { committed } : {}), task: ranTask, pid: process.pid, ids: IDS.n, inTransaction: h.isTransaction, wrote: changes(h) - started, stack } satisfies ChildReport)}\n`);
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (spec.kind === "drain") {
  // Inside lane C's own revoke work, wherever a fresh process runs it: armed at the wake install of the production open (before the
  // open's probes raise C's subscriber), so the open-time drain of a new worker is cut too. The Nth row write of an open transaction
  // parks (N >= 2: an earlier row of the same transaction was really written). The tap only counts; it writes nothing.
  let writes = 0;
  onWakeInstall(h => {
    handle = h; started = changes(h);
    h.function("memv2_child_drain_write", () => { if (!h.isTransaction) { writes = 0; return 0; } if (++writes >= spec.drainAt) park({ kind: "drain", drainWrites: writes }); return 0; });
    for (const t of DRAIN_TABLES) {
      if (!h.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(t)) continue;
      for (const e of ["INSERT", "UPDATE", "DELETE"]) h.exec(`CREATE TEMP TRIGGER IF NOT EXISTS memv2_child_dk_${t}_${e} AFTER ${e} ON main.${t} BEGIN SELECT memv2_child_drain_write(); END`);
    }
  });
}
const db: DatabaseSync = database();
handle = db;
setRetentionPageForTests(spec.retentionPage);
// The production open of a fresh process is done (whatever it runs on open is committed: it is the new worker's own work, not the
// unit under the cut). The harness is told, reads what the cut will be held to on its own reader connection, and answers on stdin.
writeSync(1, `${OPENED}${JSON.stringify({ pid: process.pid, ids: IDS.n })}\n`);
if (readSync(0, Buffer.alloc(16)) <= 0) throw new Error("memv2-kill-child: the harness went away");
started = changes(db);

if (spec.kind === "drain") {
  // not cut at the open: one bounded turn of lane C's marker drain, as its wake runs it
  drainRevokeMarkerBounded(db, { rows: 1, ms: Number.POSITIVE_INFINITY });
  park({ kind: "drain-miss" });
}
if (spec.kind === "marker") {
  // inside lane H's marker upsert statement (session-proof-schema.ts lapMarkerWrite): the row is not written yet
  db.function("memv2_child_marker", () => park({ kind: "marker" }));
  for (const e of ["INSERT", "UPDATE"]) db.exec(`CREATE TEMP TRIGGER memv2_child_m6_${e} BEFORE ${e} ON main.memory_scope_bindings WHEN NEW.id='${M6_MARKER_ID}' BEGIN SELECT memv2_child_marker(); END`);
  collectSessionChecksSlice(db, Date.now());
  park({ kind: "marker-miss" });
}
// one runner slice on the real steps (M2 lane C's probe, M3/M4 lane A's, M5 lane I's)
const REAL = { M2: revokeDrainMigrationStep, M3: recallJournalTrimStep, M4: recallDeadTermsStep, M5: m5Step } as const;
for (const task of MIGRATION_TASKS) {
  const inner = REAL[task];
  registerMigrationStep(task, (tx, cursor, now) => {
    ranTask = task;
    const result = inner(tx, cursor, now);
    // work: after the step's work, before its marker write, inside the batch's open transaction
    if (spec.kind === "work") park({ kind: "work" });
    return result;
  });
}
if (spec.kind === "cursor") {
  // cursor: inside the marker row's own upsert statement, after the step's work in the same open transaction
  db.function("memv2_child_cursor", () => park({ kind: "cursor" }));
  for (const e of ["INSERT", "UPDATE"]) db.exec(`CREATE TEMP TRIGGER memv2_child_cur_${e} BEFORE ${e} ON main.memory_scope_bindings WHEN NEW.id LIKE 'memory-v2:%' AND NEW.id<>'${M6_MARKER_ID}' BEGIN SELECT memv2_child_cursor(); END`);
}
if (spec.kind === "commit") {
  // commit: the batch's own COMMIT (database.ts transaction()) returned; the cut is there, before the transaction's scope end (its
  // publication) and before the slice returns. What this handle reads at that moment (every cursor and the full file content) is
  // reported, so the harness holds the recovered file to the batch's effects AND its cursor, read before any recovery opens it.
  // (the step's own answer, its cursor and done, is reported too: the harness holds the recovered marker row of the task to it)
  let step: string | undefined;
  for (const task of MIGRATION_TASKS) {
    const inner = REAL[task];
    registerMigrationStep(task, (tx, cursor, now) => { ranTask = task; const result = inner(tx, cursor, now); step = JSON.stringify({ cursor: result.cursor ?? null, done: result.done }); return result; });
  }
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    exec(sql);
    if (step !== undefined && /^\s*COMMIT\b/i.test(sql)) park({ kind: "commit" }, { markers: markersOf(db), content: contentOf(db), step });
  };
}
/** The transaction statements this process executed during the unit (BEGIN/COMMIT/ROLLBACK), reported with a forced cut. */
const statements: string[] = [];
if (spec.kind === "begin" || spec.kind === "precommit" || spec.kind === "rollback" || spec.kind === "publish" || spec.kind === "noprogress") {
  // (KILLSUITE I2..I5 begin/precommit/rollback/publish, forced cases of migration-v2-kill-forced.test.ts) the batch's own transaction
  // statements in database.ts transaction(): begin = BEGIN IMMEDIATE executed, the step not yet run (:605); precommit = the step and
  // the runner's marker write done, the batch's own COMMIT not yet executed (:620: the first COMMIT AFTER the marker write, so a COMMIT
  // that ran earlier inside the batch is not mistaken for it); rollback = a batch that made no progress (the step answers its prior
  // cursor: a held batch) went through the runner's own NO_PROGRESS rollback (migration-v2.ts :124 -> database.ts :621 -> stalledOr)
  // and the slice RETURNED stalled: the cut is after the whole rollback path, before anything else; publish = the batch committed and
  // its transaction scope runs its post-commit hooks (txScopeEnd(true), :620; this batch's own hook, registered inside it).
  // noprogress (KILLSUITE O08, T before the no-progress exit): the same held batch, cut inside its open transaction after the marker
  // upsert, at the ROLLBACK statement the runner's NO_PROGRESS throw leads to, before it executes.
  // The task a begin cut is in is the one the runner admits next (the first task whose marker is not done, nextTask's own order).
  // unit "lap" (KILLSUITE R-lap-begin/-open/-commit): the unit is openRetentionLap's own transaction (M5 re-opened as a lap), not a slice
  const lap = spec.unit === "lap";
  const admitted = lap ? "M5" : MIGRATION_TASKS.find(task => !readMarker(db, task)?.done) ?? null;
  if (lap) ranTask = "M5";
  let step: string | undefined, markerWritten = false;
  db.function("memv2_child_marker_seen", () => { markerWritten = true; return 0; });
  db.exec(`CREATE TEMP TRIGGER memv2_child_seen BEFORE INSERT ON main.memory_scope_bindings WHEN NEW.id LIKE 'memory-v2:%' AND NEW.id<>'${M6_MARKER_ID}' BEGIN SELECT memv2_child_marker_seen(); END`);
  for (const task of MIGRATION_TASKS) {
    const inner = REAL[task];
    registerMigrationStep(task, (tx, cursor, now) => {
      ranTask = task;
      // rollback: the step makes no progress (its prior cursor, not done, nothing written)
      const result = spec.kind === "rollback" || spec.kind === "noprogress" ? { cursor, done: false } : inner(tx, cursor, now);
      step = JSON.stringify({ cursor: result.cursor ?? null, done: result.done });
      if (spec.kind === "publish") afterCommit(() => park({ kind: "publish" }, { markers: markersOf(db), content: contentOf(db), step: step! }));
      return result;
    });
  }
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    const tx = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.exec(sql)?.[1]?.toUpperCase();
    // precommit: inside the open transaction, the runner's (or the lap's) marker written, at the COMMIT that follows it; what this
    // handle reads there (the marker it wrote, uncommitted) is reported
    if (spec.kind === "precommit" && markerWritten && tx === "COMMIT") park({ kind: "precommit", statements }, { markers: markersOf(db), content: contentOf(db), step: lap ? JSON.stringify(readMarker(db, "M5") ?? null) : step ?? "" });
    if (spec.kind === "noprogress" && markerWritten && tx === "ROLLBACK") park({ kind: "noprogress", statements });
    exec(sql);
    if (tx) statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" ").replace(/;$/, ""));
    // the lap's commit cut: its COMMIT returned, before openRetentionLap returns and its caller raises the migration wake
    if (spec.kind === "publish" && lap && tx === "COMMIT") park({ kind: "publish" }, { markers: markersOf(db), content: contentOf(db), step: JSON.stringify(readMarker(db, "M5") ?? null) });
    if (spec.kind === "begin" && tx === "BEGIN") { ranTask = admitted; park({ kind: "begin" }); }
  };
}
if (spec.unit === "due" && spec.kind === "fence") {
  // (KILLSUITE R-lap-due, F) after the migration's pass: a settled turn's capture commits new jobs (the post-pass write the lap's due
  // time counts), and the process dies at once, before its jobs wake arms any deadline (the wake drain is a later microtask)
  const { captureTurn } = await import("./memv2-retention-fixture.ts");
  captureTurn(990); ranTask = "M5";
  park({ kind: "fence" });
}
if (spec.unit === "lap") { const opened = openRetentionLap(Date.now()); park({ kind: "forced-miss", outcome: { more: opened } }); }
const outcome = runMigrationSlice({ budgetMs: 0 });
// rollback: the slice returned from the runner's no-progress rollback path (stalled); anything else is a miss, never the cut
if (spec.kind === "noprogress") park({ kind: "forced-miss", statements });
if (spec.kind === "rollback") park({ kind: outcome.stalled !== undefined ? "rollback" : "forced-miss", statements, outcome: { more: outcome.more, ...(outcome.stalled === undefined ? {} : { stalled: outcome.stalled }) } });
// stalled: the slice returned from its ROLLBACK (a batch that moved nothing never commits); nothing after it has run in this process
park({ kind: outcome.stalled !== undefined ? "stalled" : "commit", outcome: { more: outcome.more, ...(outcome.stalled === undefined ? {} : { stalled: outcome.stalled }) } });
