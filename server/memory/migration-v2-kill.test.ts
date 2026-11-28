// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: lane I (MEMORY-V2-DESIGN section 5, GAP-CHECK 33b). A kill at every step boundary of M2 to M5 followed by a restart
// reaches the same end state as an uninterrupted run, and the never-deleted rows are untouched at every kill point (50 seeds).
// The fixture gives M3 and M4 real multi-batch work (a legacy journal of more than two trim ranges under a ready view; dead versions'
// terms of more than two batches on one version); M2's batch is a probe of lane C's own durable revoke runner (it writes nothing): the
// owner's forget is left standing, and lane C's bounded runner drains it between slices, so kills land while M2 is unfinished.
// The steps are the REAL ones: M2 lane C's revokeDrainMigrationStep, M3/M4 lane A's recallJournalTrimStep/recallDeadTermsStep,
// M5 lane I's retention. M6 is lane H's self-contained lap (not driven by this runner): the harness runs H's collectSessionChecksSlice,
// which writes H's marker; nothing is pre-installed. Kill points per batch: inside the step's transaction after its work (a throw),
// at the cursor write itself (a TEMP trigger RAISE(ABORT) on the marker row), after the COMMIT (process state dropped), and after
// the COMMIT with the file closed and reopened (every fifth one). r7: also INSIDE lane C's own drain transaction while M2 waits (M2:drain,
// a TEMP trigger RAISE(ABORT) on its first write, then a restart), at lane H's marker write (M6:marker, then a restart) and as a caught
// statement abort of that write (M6:fault: no marker stands, the lap runs again); every M6
// kill point reopens the file. The journal must keep every row a ready view has not applied (journalHeld), at every kill point and at the end.
// The P-suite judge (testing/memv2-psuite-kill.ts: P1-W, P1-W2, P2-W, P3-W, P4, P5-W, V5-OWN, each through its production entry point)
// runs at EVERY kill point, on the database as the kill left it, as an in-transaction probe; at every cut made by a REAL crash (a child
// killed by PID) and at the end of every seed the owner-turn checks (P1-W, P1-W2, P2-W, P3-W) are ALSO judged COMMITTED: a fresh process
// on a backup copy of the cut takes the turn twice with no transaction open (testing/memv2-judge-child.ts), each verdict a hard line. Each check returns its own verdict and is asserted on its own line
// (soft), ahead of the never-deleted digest, so one finding never keeps another check from being reached; the test then ends at that
// kill point. PLAN below is generated from the KILLSUITE.md rows the harness drives; every such row must have been hit and judged.
// RED on f6ae52c670: the runner (migration-v2.ts) does not exist.
import { spawn } from "node:child_process";
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database as productionDatabase, databaseGeneration } from "../database.ts";
import { rawConnection } from "../io-budget.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { harnessSites, WRITER_ALLOWLIST } from "./testing/killsuite-plan.ts";
import { type ChildReport, type ChildSpec, contentOf, DRAIN_TABLES, IDS, markersOf, OPENED, PARKED, useIdStream } from "./testing/memv2-kill-ids.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { INLINE_REVOCATION, runRevocationJobsNow, stopMemoryRevocation } from "./memory-revocation.ts";
import { collectSessionChecksSlice } from "./session-proof-schema.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { m5Step, M6_MARKER_ID, MIGRATION_TASKS, readMarker, type MigrationStep, type MigrationTask, migrationV2Finished, registerMigrationStep, resetMigrationV2ForTests, runMigrationSlice } from "./migration-v2.ts";
import { revokeDrainMigrationStep } from "./memory-revocation.ts";
import { prepareRecallContextSync, RECALL_DEAD_TERMS_ROWS, RECALL_FLUSH_ROWS, recallDeadTermsStep, recallJournalTrimStep } from "./recall-view.ts";
import { setRetentionPageForTests } from "./retention-v2.ts";
import { setWakeCommitTapForTest } from "./wake.ts";
import { captureTurn, FIXTURE_BOT, fixtureRoster, importNotebookText, importTopicText, protectedDigest } from "./testing/memv2-retention-fixture.ts";
import { CONTROL_TOPIC, importNow, judge, JUDGED, type JudgeReport, type JudgeSpec, P_REACHED, pBaseline, type PBaseline, PCLOCK, type PSubjects, pSuiteIsolated, type PTurn, type PVerdict, receiptNow, resetPreviewClock, RETIRED_LINES, RETIRED_TOPIC, shownReceipt, viewRoster } from "./testing/memv2-psuite-kill.ts";

// (FABLE d070b56610 H4, KILLSUITE "Restart equality": reproducible IDs) the product's ids come from a per-fixture stream
// (testing/memv2-kill-ids.ts), so the killed run and its no-kill twin compare exactly.
const DAY = 24 * 60 * 60 * 1000, SEEDS = 50;
// Each fixture build starts 30 days after the last: import previews are process state, kept 10 minutes and limited in number.
let T0 = Date.parse("2026-09-01T00:00:00Z");
const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
class Killed extends Error {}
const DEFAULT: Record<MigrationTask, MigrationStep> = { M2: revokeDrainMigrationStep, M3: recallJournalTrimStep, M4: recallDeadTermsStep, M5: m5Step };
const CURSOR_KILL = "killed at the cursor write";
/** A kill at the cursor write: the marker row's INSERT or UPDATE aborts after the step's work ran in the same transaction. */
// the cut instruments write TEMP objects only (triggers, a fired table): each arming is its own logged unit "arm"
function armCursorKill(db: DatabaseSync, on: boolean): void { inUnit("arm", () => armCursorKillRun(db, on)); }
/** (HARNESS-DESIGN C2) the cut instruments are TEMP DDL on the handle's raw, untapped exec: a harness statement never reaches the commit
 *  tap, and a main-file write made through it is a finding of the WAL guard (walUnseen), never credited. */
const TEMP_ONLY = /^\s*(?:(?:CREATE TEMP (?:TRIGGER|TABLE) |DROP (?:TRIGGER|TABLE) IF EXISTS temp\.)[^;]*(?:;\s*|$))+$/is;
function tempExec(db: DatabaseSync, sql: string): void {
  if (!TEMP_ONLY.test(sql.replace(/BEGIN[^]*?END/g, "BEGIN END"))) { unattributed.push(`harness raw statement that is not TEMP DDL: ${sql.slice(0, 80)}`); return; }
  // (FABLE 5c4ada4123 H-B) a TEMP trigger body runs inside the production statement that fires it: each body statement is a SELECT (a RAISE,
  // a harness function the statement guard watches) or writes a temp.* table, never main
  const body = [...sql.matchAll(/\bBEGIN\b([^]*?)\bEND\b/g)].flatMap(m => sqlStatements(m[1]!)).filter(part => part.trim() && !/^\s*SELECT\b/i.test(part) && !TEMP_PART.test(part));
  expect(body, `harness TEMP trigger body writes main (refused at the arm, before it can fire): ${sql.slice(0, 60)}`).toEqual([]);
  rawConnection(db)!.exec(sql);
}
function armCursorKillRun(db: DatabaseSync, on: boolean): void {
  tempExec(db, "DROP TRIGGER IF EXISTS temp.memv2_kill_i; DROP TRIGGER IF EXISTS temp.memv2_kill_u");
  if (!on) return;
  for (const [name, event] of [["memv2_kill_i", "INSERT"], ["memv2_kill_u", "UPDATE"]])
    tempExec(db, `CREATE TEMP TRIGGER ${name} BEFORE ${event} ON main.memory_scope_bindings WHEN NEW.id LIKE 'memory-v2:%' BEGIN SELECT RAISE(ABORT,'${CURSOR_KILL}'); END`);
}

const DRAIN_KILL = "killed inside the revoke drain";
const tableExists = (db: DatabaseSync, table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
function drainState(db: DatabaseSync): Record<string, string[]> {
  return Object.fromEntries(DRAIN_TABLES.filter(t => tableExists(db, t)).map(t => [t, db.prepare(`SELECT * FROM ${t}`).all().map(row => JSON.stringify(row)).sort()]));
}
let drainWrites = 0, drainKillAt = 0;
/** A kill INSIDE lane C's own revoke drain transaction (drainRevokeMarkerBounded / runRevocationJobsNow): every row written to a drain table
 * is counted by a JS function (its count survives the rollback); the `at`-th row write (at >= 2, so at least one earlier row of the same
 * transaction was really written) aborts, the drain rolls its transaction back and rethrows. at = 0 disarms. */
function armDrainKill(db: DatabaseSync, at: number): void { inUnit("arm", () => armDrainKillRun(db, at)); }
function armDrainKillRun(db: DatabaseSync, at: number): void {
  const tables = DRAIN_TABLES.filter(t => tableExists(db, t)), events = ["INSERT", "UPDATE", "DELETE"];
  for (const t of tables) for (const e of events) tempExec(db, `DROP TRIGGER IF EXISTS temp.memv2_dk_${t}_${e}`);
  if (!at) return;
  drainWrites = 0; drainKillAt = at;
  // a row written outside an explicit transaction is committed at once: the count starts over (only writes of the open transaction count)
  db.function("memv2_drain_write", () => { if (!db.isTransaction) { drainWrites = 0; return 0; } return ++drainWrites >= drainKillAt ? 1 : 0; });
  for (const t of tables) for (const e of events)
    tempExec(db, `CREATE TEMP TRIGGER memv2_dk_${t}_${e} AFTER ${e} ON main.${t} WHEN memv2_drain_write()=1 BEGIN SELECT RAISE(ABORT,'${"killed inside the revoke drain"}'); END`);
}
/** A kill at lane H's M6 marker write (session-proof-schema.ts lapMarkerWrite): the write is lost (RAISE(IGNORE): the row is not written,
 * as if the process died at it) and the attempt is logged in a TEMP table, so a slice that never reaches the marker write logs nothing.
 * The restart after it must run the lap again. Returns how many marker writes were attempted (and lost) while armed. */
function armM6Kill(db: DatabaseSync, on: boolean): number { return inUnit("arm", () => armM6KillRun(db, on)); }
function armM6KillRun(db: DatabaseSync, on: boolean): number {
  const fired = db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='memv2_m6_fired'").get() ? Number(db.prepare("SELECT count(*) AS n FROM temp.memv2_m6_fired").get()!.n) : 0;
  tempExec(db, "DROP TRIGGER IF EXISTS temp.memv2_m6_kill_i; DROP TRIGGER IF EXISTS temp.memv2_m6_kill_u; DROP TABLE IF EXISTS temp.memv2_m6_fired");
  if (!on) return fired;
  tempExec(db, "CREATE TEMP TABLE memv2_m6_fired(at INTEGER)");
  for (const [name, event] of [["memv2_m6_kill_i", "INSERT"], ["memv2_m6_kill_u", "UPDATE"]])
    tempExec(db, `CREATE TEMP TRIGGER ${name} BEFORE ${event} ON main.memory_scope_bindings WHEN NEW.id='${M6_MARKER_ID}' BEGIN INSERT INTO temp.memv2_m6_fired VALUES(1); SELECT RAISE(IGNORE); END`);
  return 0;
}
/** A FAULT at lane H's M6 marker write (KILLSUITE H-lap-marker "also force statement abort before commit"; evidence plan row 3, "M6
 * cleanup fault"): the marker row's upsert statement fails with a real SQLite error (RAISE(ABORT)) the FIRST time it is attempted while
 * armed; a later attempt goes through. H catches the failure (session-proof-schema.ts lapMarkerWrite). Every attempt is counted by a JS
 * function (the count survives the statement's abort). Returns nothing; `m6Attempts` is the count. */
let m6Attempts = 0;
function armM6Fault(db: DatabaseSync, on: boolean): void {
  tempExec(db, "DROP TRIGGER IF EXISTS temp.memv2_m6_fault_i; DROP TRIGGER IF EXISTS temp.memv2_m6_fault_u");
  if (!on) return;
  m6Attempts = 0;
  db.function("memv2_m6_fault", () => (m6Attempts++ === 0 ? 1 : 0));
  for (const [name, event] of [["memv2_m6_fault_i", "INSERT"], ["memv2_m6_fault_u", "UPDATE"]])
    tempExec(db, `CREATE TEMP TRIGGER ${name} BEFORE ${event} ON main.memory_scope_bindings WHEN NEW.id='${M6_MARKER_ID}' AND memv2_m6_fault()=1 BEGIN SELECT RAISE(ABORT,'faulted at the M6 marker write'); END`);
}

/** KILLSUITE "Generator and crash protocol" steps 3 to 5: the real crash. The harness closes its own handle, spawns a CHILD PROCESS
 * (testing/memv2-kill-child.ts) on the same private profile, and the child runs one real unit of migration work until it PARKS at the
 * armed cut on the production path (inside the step's open transaction, inside the marker row's upsert statement, inside the drain's
 * Nth row write, or right after the slice's COMMIT). The harness then kills that exact PID with SIGKILL (no disposal, no rollback, no
 * close runs in the child), awaits its exit, and only then opens the file again: a fresh handle on what the dead writer left (the
 * recovered snapshot). The receipt (pid, signal, cut, whether a transaction was open, rows written) is asserted at every kill. */
const CHILD = fileURLToPath(new URL("./testing/memv2-kill-child.ts", import.meta.url));
interface ChildKill extends ChildReport { signal: string | null; code: number | null; spawned: number }
async function childKill(kind: ChildSpec["kind"], seed: number, opened: () => void, drainAt = 0): Promise<ChildKill> {
  closeDb();
  const spec: ChildSpec = { kind, now: Date.now(), seed, ids: IDS.n, drainAt, armed: Boolean((globalThis as { __memv2MutantArmed?: boolean }).__memv2MutantArmed), retentionPage: 2 };
  const child = spawn(process.execPath, [CHILD], { env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR, MEMV2_KILL_CHILD: JSON.stringify(spec) }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  /** The child's one line starting with `mark` (complete, newline-ended), or null when the child ended without writing it. */
  const line = <T,>(mark: string) => new Promise<T | null>(resolve => {
    const look = () => { const found = out.split("\n").find(l => l.startsWith(mark) && out.includes(`${l}\n`)); if (found) resolve(JSON.parse(found.slice(mark.length)) as T); };
    child.stdout.on("data", look); look(); void exited.then(() => resolve(null));
  });
  child.stdout.on("data", chunk => { out += String(chunk); });
  child.stderr.on("data", chunk => { err += String(chunk); });
  const ended = async (when: string) => new Error(`kill child ended ${when} (${kind}): ${JSON.stringify(await exited)} ${err.slice(-3000)} ${out.slice(-500)}`);
  // the child's production open is done: what the cut is held to is read now, on the harness's own connection, then the child goes on
  // (a drain cut may land inside the open itself: then the child parks before it reports its open, and the cut is held to what the
  // harness read before the spawn)
  const parked = line<ChildReport>(PARKED), open = await Promise.race([line<{ pid: number; ids: number }>(OPENED), parked.then(() => null)]);
  let report: ChildReport | null = null;
  try {
    if (open) { IDS.n = open.ids; inUnit("cut-baseline", opened); closeDb(); child.stdin.write("go\n"); }
    report = await parked;
  } finally {
    // the one kill: by exact PID, also when the harness itself failed above (no child is ever left parked)
    if (child.exitCode === null && child.signalCode === null) process.kill(child.pid!, "SIGKILL");
  }
  const end = await exited;
  // the child ended on its own before any cut: a fault of the run, never a kill
  if (!report) throw await ended("before its cut");
  IDS.n = report.ids;
  return { ...report, ...end, spawned: child.pid! };
}
/** What a child kill must show to count: the parked PID is the spawned one and it died of SIGKILL, never by exiting. */
const killReceipt = (kill: ChildKill) => [kill.pid === kill.spawned, kill.signal, kill.code];
const KILLED_BY_PID = [true, "SIGKILL", null];
/** The cuts driven through a child kill: each seed is allocated two of them (every cut several times over the seeds); a commit kill is
 * also the restart from that committed boundary on a new handle (the *-reopen rows). */
const CHILD_CUTS = ["M2:work", "M2:cursor", "M2:commit", "M3:work", "M3:cursor", "M3:commit", "M4:work", "M4:cursor", "M4:commit", "M5:work", "M5:cursor", "M5:commit", "M2:drain", "M6:marker"];
// (MAIN-RULING memI-scope H7) every seed also cuts INSIDE lane C's drain: the in-process drain kill cannot land in C's runner pass
// (runRevocationJobsNow outside a transaction writes each row in autocommit, so the armed count starts over at every row), which left
// the child cut on 7 seeds of 50 as the only deep drain kills; the floor below asserts one per seed
const childCutsOf = (seed: number) => new Set([CHILD_CUTS[seed % CHILD_CUTS.length]!, CHILD_CUTS[(seed + 7) % CHILD_CUTS.length]!, "M2:drain"]);
const creditOf = (cut: string) => cut.endsWith(":commit") ? [cut, cut.replace(":commit", ":reopen")] : [cut];

// (C1/C2 in process) F: the fixture build is the one phase whose harness writes are allowed; it runs with the tap held, and only before the
// seed's kill phase (a fixture write after a kill point began would be a harness writer the tap never judged: a finding)
let killPhase = false;
async function buildFixture(seed: number) {
  if (killPhase) unattributed.push(`fixture build inside the kill phase of seed ${seed}`);
  fixtureHeld = true;
  try { await inUnitAsync("fixture", () => buildFixtureRun(seed)); } finally { fixtureHeld = false; walSeen = walStamp(); }
}
async function buildFixtureRun(seed: number) {
  armMutants(false); m2Waits = 0; resetPreviewClock(); IDS.seed = seed; IDS.n = 0; IDS.inProbe = false; IDS.trace = [];
  T0 += 30 * DAY; vi.setSystemTime(T0);
  closeDb(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(fixtureRoster); const db = database(); db.exec("UPDATE memory_meta SET mode='active'");
  const next = rng(seed + 1), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  const turns = 4 + Math.floor(next() * 12);
  for (let n = 0; n < turns; n++) { vi.setSystemTime(T0 + Math.floor(next() * 10) * DAY); captureTurn(n); }
  for (const row of db.prepare("SELECT rowid AS r FROM memory_jobs WHERE status='pending'").all())
    db.prepare("UPDATE memory_jobs SET status=? WHERE rowid=?").run(["complete", "failed", "pending"][Math.floor(next() * 3)], Number(row.r));
  // M3 real work: an existing profile's long journal (rows an older build applied and never trimmed), more than two trim ranges,
  // then a ready view built on top of it, so every one of those rows is at or below the view's watermark.
  const legacy = 2 * RECALL_FLUSH_ROWS + 1 + Math.floor(next() * 2000);
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO memory_recall_changes(kind,object_id,version) SELECT 'record','legacy-journal-'||i,1 FROM n`).run(legacy);
  // M4 real work: notebook records, then an edit of every line, so each first version is superseded by the real import path.
  // about 1 KiB a line, so the notebook spans several 2 KiB chunks: several records, each superseded by the edit
  const lines = 4 + Math.floor(next() * 4), text = (edit: string) => Array.from({ length: lines }, (_, i) => `Fixture note ${i} kept ${edit}: ${"durable fixture words ".repeat(46)}`);
  importNotebookText(text("as first written")); importNotebookText(text("after the owner edited it"));
  // a second notebook file (its own source): the live record P1's control reads
  const sourceIds = () => db.prepare("SELECT id FROM memory_sources").all().map(row => String(row.id));
  const recordsOf = (source: string) => db.prepare("SELECT DISTINCT r.id,r.version FROM memory_records r JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE e.source_id=? AND r.state='active'")
    .all(source).map(row => ({ id: String(row.id), version: Number(row.version) }));
  importTopicText(CONTROL_TOPIC, ["A control note the owner keeps, from a second notebook file."]);
  // a third notebook file the owner later forgets as a whole (P3-W: its import tombstone; P1-W: its records)
  const known = new Set(sourceIds());
  importTopicText(RETIRED_TOPIC, RETIRED_LINES);
  const retiredSource = sourceIds().filter(id => !known.has(id));
  expect(retiredSource).toHaveLength(1);
  // a ready recall view needs a roster revision (the fixture roster has none: imports and turns do not read it)
  reconcileMemoryRoster(viewRoster); prepareRecallContextSync(FIXTURE_BOT, "thread-a", viewRoster);
  // P1: the owner forgets one live notebook record (its revoke work drained, as the runner would). The rows the judge reads for it
  // (tombstone, deny marks, pending rows, record state) are in the never-deleted digest checked at every kill point; the live judge
  // itself runs at the end of each killed run (it needs a freshly prepared view, which would write between kill points).
  const live = db.prepare("SELECT id,version,text FROM memory_records WHERE state='active' ORDER BY rowid").all();
  const retired = recordsOf(retiredSource[0]!);
  expect(retired.length).toBeGreaterThan(0);
  forgotten = { id: String(live[0]!.id), version: Number(live[0]!.version) };
  // P2-W: a turn is shown the record before the forget (the real recall builds its frame, prepared and delivered; the turn then
  // reads the record with the memory tool, noted on its lookup receipt)
  const words = String(live[0]!.text).split(":")[0]!, receipt = await shownReceipt(words, forgotten);
  subjects = { forgotten, retired, receipt: receipt.bundleId };
  // The judge is not a no-op: before the forgets the same calls answer the other way (served, shown, current, admitted).
  expect({ p1: [judge(forgotten), ...retired.map(judge)], shown: receipt.records.includes(forgotten.id), p2: [receiptNow(receipt.bundleId), receiptNow(`${receipt.bundleId}:lookup`)], p3: importNow(RETIRED_TOPIC, RETIRED_LINES) },
    "before the forgets").toEqual({ p1: ["served", ...retired.map(() => "served")], shown: true, p2: ["current", "current"], p3: "admitted" });
  // the owner forgets the whole third file (its revoke walked inline, as a small forget is)
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: retiredSource[0]! });
  // The revoke is NOT drained here (ASTRA r3 H2): M2 meets it standing and the harness drains it with lane C's own bounded runner
  // between slices, so kills land while M2 is still unfinished.
  // (INLINE_REVOCATION.ms = 0: the commit walks nothing inline, as for a forget too large for its 8 ms; the walk is the runner's)
  const inline = INLINE_REVOCATION.ms; INLINE_REVOCATION.ms = 0;
  try { forgetMemory(ownerMemoryTicket(), { kind: "record", id: String(live[0]!.id) }); } finally { INLINE_REVOCATION.ms = inline; }
  // (row 4b, the writer row 4a named on seed 27) the forgets woke lane C's own revoke runner (forget.ts wakeMemoryRevocation), which then
  // ticks from its own wake pump (memory-revocation.ts onRunnerWake -> tick -> tickOnce) whenever the harness yields to the event loop,
  // by wall-clock time: the harness owns that writer and drives it only through revokeOnce (a logged unit). Any later restart of it is
  // still caught by the write attribution at the next kill point.
  stopMemoryRevocation();
  // the forget moved the epoch: the view is built after it, so M3 has a ready view over the legacy journal
  prepareRecallContextSync(FIXTURE_BOT, "thread-a", viewRoster);
  // An older build kept the terms of a version once it died (the A5 read filter hides them): the first dead version holds more than
  // two batches' worth, so M4 continues it from the same cursor; the others a few rows each.
  const view = db.prepare("SELECT view_id,generation FROM memory_recall_views WHERE state='ready' LIMIT 1").get();
  if (!view) throw new Error("fixture: no ready recall view");
  const dead = db.prepare("SELECT id,version FROM memory_records WHERE state NOT IN ('active','candidate') ORDER BY rowid").all();
  dead.forEach((row, k) => db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO memory_recall_view_terms SELECT ?,?,'legacy'||i,i,?,? FROM n`).run(k ? 3 : 2 * RECALL_DEAD_TERMS_ROWS + 7, view.view_id, view.generation, row.id, row.version));
  // M6 is NOT pre-installed (ASTRA r3 H2): lane H's own lap (collectSessionChecksSlice) writes its marker while the harness drives it
  expect(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id=?").get(M6_MARKER_ID)).toBeUndefined();
  void scope;
  vi.setSystemTime(T0 + 12 * DAY);
  built = { n: IDS.n, trace: IDS.trace }; IDS.trace = [];
}
/** The id draws of the fixture build just made (how many, and which module drew each). */
let built: { n: number; trace: string[] } = { n: 0, trace: [] };

let forgotten: { id: string; version: number }, subjects: PSubjects;
/** One driver step: a runner slice; while M2 waits on the standing revoke, one bounded slice of lane C's revoke runner (its own
 * transactions, as its wake does in the app); and one slice of lane H's M6 lap. "More" until the runner and H's marker are done. */
let m2Waits = 0, m2WaitsTotal = 0;
function revokeOnce(outcome: { more: boolean; stalled?: string }): void { inUnit("revoke", () => revokeOnceRun(outcome)); }
function revokeOnceRun(outcome: { more: boolean; stalled?: string }): void {
  const db = database();
  // lane C's runner: every fourth wait one pass of its production runner (runRevocationJobsNow, WRITER_ALLOWLIST owner C); the waits in
  // between are slices where C's tick has not come round, so M2 waits several slices with kills landing between them. (HARNESS-DESIGN C1/C2)
  // the harness never calls the drain itself: drainRevokeMarkerBounded called from here is the ADD-WRITER plant, a finding at A-ATTR.
  if (outcome.stalled === "M2") {
    m2WaitsTotal++;
    if (++m2Waits % 4 === 0) runRevocationJobsNow(db);
  }
}
const m6Open = () => !database().prepare("SELECT 1 FROM memory_scope_bindings WHERE id=?").get(M6_MARKER_ID);
const moreAfter = (outcome: { more: boolean; stalled?: string }) => outcome.more || outcome.stalled !== undefined || m6Open();
function othersOnce(outcome: { more: boolean; stalled?: string }): boolean {
  revokeOnce(outcome); inUnit("m6-slice", () => collectSessionChecksSlice(database(), Date.now()));
  return moreAfter(outcome);
}
/** The whole P-suite as an isolated probe of the committed prefix (testing/memv2-psuite-kill.ts pSuiteIsolated): it must leave ZERO
 * writes behind. The probe runs inside a transaction, so the code under it takes its in-transaction branches: it is an extra check at
 * every random-walk boundary and is credited with no row. The judge a row is credited with is the COMMITTED one (committedJudge below:
 * a fresh process on a backup copy of the cut). `probeLeft` is what a probe changed in the file (total row count and newest rowid of
 * every table of main, the journal's sequence counter): asserted empty at every probe, so a probe that committed anything is a finding
 * at its own line. */
const fileStamp = (db: DatabaseSync) => JSON.stringify([
  ...(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name").all()).map(t => {
    try { const r = db.prepare(`SELECT count(*) AS n, max(rowid) AS m FROM "${String(t.name)}"`).get()!; return [t.name, r.n, r.m]; } catch { return [t.name, Number(db.prepare(`SELECT count(*) AS n FROM "${String(t.name)}"`).get()!.n)]; }
  }),
  db.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name").all(), db.prepare("SELECT * FROM memory_recall_epoch").all(), db.prepare("SELECT view_id,generation,state,watermark FROM memory_recall_views ORDER BY 1,2").all(),
]);
/** KILLSUITE crash protocol step 5 (Observe): the recovered snapshot of the profile, read through a DISTINCT raw read-only connection
 * to the file (not the production open, which may run a new worker's own work), before the harness opens anything else: every table's
 * row count and newest rowid, the sequence counters, the recall epoch and watermarks (fileStamp), the runner's marker rows and the full
 * content of every table (contentOf: an in-place UPDATE is seen too). */
function rawRead<T>(read: (raw: DatabaseSync) => T): T {
  const raw = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  // (the dead writer's locks go with its process; the reader waits for that instead of failing on a busy file)
  raw.exec("PRAGMA busy_timeout=15000");
  try { return read(raw); } finally { raw.close(); }
}
const recovered = (): { stamp: string; markers: string; content: string } => rawRead(raw => ({ stamp: fileStamp(raw), markers: markersOf(raw), content: contentOf(raw) }));
let probes = 0;
function probe(before: PBaseline, where: string): PVerdict {
  const db = database(), stamp = fileStamp(db);
  IDS.inProbe = true;
  let verdict: PVerdict;
  try { verdict = inUnit("judge", () => pSuiteIsolated(subjects, before)); } finally { IDS.inProbe = false; }
  probes++;
  expect(fileStamp(database()) === stamp ? [] : [`the judge probe left writes ${where}`], `probe isolation ${where}`).toEqual([]);
  return verdict;
}
/** The COMMITTED judge of a kill point (evidence plan row 5; FABLE/OPUS H2a): an owner turn as a live one runs it, with no transaction
 * open around it, in a FRESH PROCESS on a page-exact copy of the cut. The harness's own handle is closed (no writer is left: every kill
 * child is dead by now), the file is copied with SQLite's online backup through a raw read-only connection and the rest of the profile
 * (the notebook files) with cpSync, into a new private directory; testing/memv2-judge-child.ts starts with that directory as its data
 * directory, opens it through the production open and takes the turn twice (cold, warm). The original gets zero probe writes: its
 * full content (contentOf) is read before and after through the raw reader and returned for the caller's own assertion. */
const JUDGE_CHILD = fileURLToPath(new URL("./testing/memv2-judge-child.ts", import.meta.url));
interface Committed extends JudgeReport { code: number | null; spawned: number; copy: string; untouched: boolean }
let committedJudges = 0;
async function committedJudge(seed: number): Promise<Committed> {
  closeDb();
  const before = rawRead(contentOf), copy = mkdtempSync(join(tmpdir(), "memv2-judge-"));
  try {
    const source = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try { await backup(source, join(copy, "messages.db")); } finally { source.close(); }
    for (const name of readdirSync(DATA_DIR)) if (!name.startsWith("messages.db")) cpSync(join(DATA_DIR, name), join(copy, name), { recursive: true });
    const spec: JudgeSpec = { now: Date.now(), seed, subjects };
    const child = spawn(process.execPath, [JUDGE_CHILD], { env: { ...process.env, MURAGE_DATA_DIR: copy, MEMV2_JUDGE_CHILD: JSON.stringify(spec) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += String(chunk); }); child.stderr.on("data", chunk => { err += String(chunk); });
    const code = await new Promise<number | null>(resolve => child.once("close", resolve));
    const line = out.split("\n").find(l => l.startsWith(JUDGED));
    // the judge child ended without its verdict: a fault of the run (never a verdict)
    if (code !== 0 || !line) throw new Error(`judge child ended without a verdict: code ${code} ${err.slice(-3000)} ${out.slice(-500)}`);
    committedJudges++;
    return { ...(JSON.parse(line.slice(JUDGED.length)) as JudgeReport), code, spawned: child.pid!, copy, untouched: rawRead(contentOf) === before };
  } finally { removeTempDirSync(copy); }
}
/** What a committed owner turn must answer at any kill point (the forget's own verdicts; the other live records may be withheld only
 * while the forget's window is still walked, which the caller holds on its own line). */
const turnOf = (t: PTurn) => ({ p1: [t.p1.forgotten, t.p1.retired], p1w2: t.p1w2, p2: [t.p2.refused, t.p2.reasons.filter(reason => !FORGET_REASONS.includes(reason))], p3: t.p3 });
const TURN_HELD = { p1: ["MEMORY_RECORD_UNAVAILABLE", ["MEMORY_RECORD_UNAVAILABLE"]], p1w2: [], p2: [["MEMORY_CONTEXT_REVOKED"], []], p3: { same: "MEMORY_IMPORT_FORGOTTEN", appended: "MEMORY_IMPORT_FORGOTTEN", control: "admitted" } };
let lastOutcome: unknown;
/** The uninterrupted reference run (the no-kill twin): the same ordered inputs and no probe (a probe writes nothing, so the twin needs none). */
const driveOnce = async () => {
  const outcome = (lastOutcome = inUnit("slice", () => runMigrationSlice({ budgetMs: 0 }))) as { more: boolean; stalled?: string };
  return othersOnce(outcome);
};
const stuck = () => JSON.stringify({ lastOutcome, m2: revokeDrainMigrationStep(database(), null, 0), m6: Boolean(database().prepare("SELECT 1 FROM memory_scope_bindings WHERE id=?").get(M6_MARKER_ID)),
  jobs: database().prepare("SELECT state,count(*) AS n FROM memory_revoke_jobs GROUP BY state").all() });

const deadTerms = (db: DatabaseSync) => Number(db.prepare(`SELECT count(*) AS n FROM memory_recall_view_terms t JOIN memory_records r
  ON r.id=t.record_id AND r.version=t.version WHERE r.state NOT IN ('active','candidate')`).get()!.n);
const legacyJournal = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM memory_recall_changes WHERE object_id LIKE 'legacy-journal-%'").get()!.n);

// (ASTRA/FABLE/OPUS d070b56610 H3) The journal is compared EXACTLY: every row's sequence, kind, object id and version, in order, with the
// persisted projection_floor and every view's state and watermark (ids are reproducible per seed, IDS above; the probe writes nothing).
const journalOf = (db: DatabaseSync) => db.prepare("SELECT sequence,kind,object_id,version FROM memory_recall_changes ORDER BY sequence").all().map(r => `${Number(r.sequence)}|${String(r.kind)}|${String(r.object_id)}|${Number(r.version)}`);
const journalMarks = (db: DatabaseSync) => ({ floor: Number(db.prepare("SELECT projection_floor AS f FROM memory_recall_epoch WHERE id=1").get()?.f ?? 0),
  views: db.prepare("SELECT view_id,state,watermark FROM memory_recall_views ORDER BY view_id,generation").all().map(r => `${String(r.view_id)}|${String(r.state)}|${Number(r.watermark)}`) });
/** The journal rows no trim may take (recall-view.ts trimRecallJournalPage deletes only a prefix at or below the lowest ready watermark,
 * and never the newest row): above that watermark the journal is gap-free up to its newest row, and it is never empty once written.
 * Journal loss (a row a ready view has not applied yet, or an emptied journal) is a finding even where the two runs' journals stay one
 * the tail of the other. */
interface JournalCut { rows: Array<{ sequence: number; kind: string; object_id: string; version: number }>; low: number }
/** The journal of THIS file just before a cut: every row exactly, and the lowest ready watermark (trimRecallJournalPage's bound). */
function journalBefore(db: DatabaseSync): JournalCut {
  const rows = db.prepare("SELECT sequence,kind,object_id,version FROM memory_recall_changes ORDER BY sequence").all() as JournalCut["rows"];
  const low = Number(db.prepare(`SELECT min(v.watermark) AS w FROM memory_recall_views v JOIN memory_recall_epoch e ON e.id=1
    WHERE v.state='ready' AND v.watermark>=e.projection_floor`).get()?.w ?? 0);
  return { rows, low };
}
/** The same file after the cut, row for row against `pre` (exact sequence, kind, object id, version): a row may be gone only if it was at
 * or below the pre-cut ready watermark, is not the newest row left, and is at or below the persisted projection_floor (the trim records
 * how far it took). Any rewritten row, lost unapplied row, lost newest row or removal the floor does not cover is a finding. */
function journalKept(pre: JournalCut, db: DatabaseSync): string[] {
  const now = new Map((db.prepare("SELECT sequence,kind,object_id,version FROM memory_recall_changes").all() as JournalCut["rows"]).map(r => [Number(r.sequence), r]));
  const floor = Number(db.prepare("SELECT projection_floor AS f FROM memory_recall_epoch WHERE id=1").get()?.f ?? 0), top = Math.max(0, ...now.keys());
  const out: string[] = [];
  for (const r of pre.rows) {
    const n = now.get(Number(r.sequence));
    if (n) { if (n.kind !== r.kind || n.object_id !== r.object_id || Number(n.version) !== Number(r.version)) out.push(`rewritten ${r.sequence}`); continue; }
    if (Number(r.sequence) > pre.low) out.push(`lost unapplied ${r.sequence} (pre-cut low ${pre.low})`);
    else if (Number(r.sequence) >= top) out.push(`lost newest ${r.sequence}`);
    else if (Number(r.sequence) > floor) out.push(`removed ${r.sequence} above projection_floor ${floor}`);
  }
  return out.length > 3 ? [...out.slice(0, 3), `... ${out.length} findings`] : out;
}
function journalHeld(db: DatabaseSync) {
  const newest = Number(db.prepare("SELECT max(sequence) AS s FROM memory_recall_changes").get()?.s ?? 0);
  const low = Number(db.prepare(`SELECT min(v.watermark) AS w FROM memory_recall_views v JOIN memory_recall_epoch e ON e.id=1
    WHERE v.state='ready' AND v.watermark>=e.projection_floor`).get()?.w ?? 0);
  const held = Number(db.prepare("SELECT count(*) AS n FROM memory_recall_changes WHERE sequence>?").get(Math.min(low, newest))!.n);
  return { unappliedMissing: newest - Math.min(low, newest) - held, rows: newest > 0 };
}

function endState(db: DatabaseSync) {
  return {
    jobs: db.prepare("SELECT source_id,source_revision,stage,status FROM memory_jobs ORDER BY 1,2,3").all(),
    journal: journalOf(db), journalMarks: journalMarks(db), legacyJournal: legacyJournal(db), deadTerms: deadTerms(db),
    // Each ready view's CURRENT generation must hold exactly the twin's live terms (r11: the probes write nothing, so the view
    // identities and watermarks are compared exactly too, journalMarks above): per (term, record version) its row count,
    // the record named by its text and version (ids are random per build). One distinct content for all ready views.
    liveTerms: [...new Set((db.prepare("SELECT view_id,generation FROM memory_recall_views WHERE state='ready'").all()).map(view => JSON.stringify(
      db.prepare(`SELECT t.term,r.text,t.version,count(*) AS n FROM memory_recall_view_terms t JOIN memory_records r ON r.id=t.record_id AND r.version=t.version
        WHERE t.view_id=? AND t.generation=? AND r.state IN ('active','candidate') GROUP BY 1,2,3 ORDER BY 1,2,3`).all(view.view_id, view.generation))))].sort(),
    markers: db.prepare("SELECT id,json_extract(intent,'$.done') AS done FROM memory_scope_bindings WHERE id LIKE 'memory-v2:%' ORDER BY id").all(),
    finished: migrationV2Finished(db),
  };
}

// (FABLE/OPUS H4, evidence plan row 4a) WRITE ATTRIBUTION. Every write the harness's own handle commits (each transaction end and each
// autocommitted write, reported by the wake bus's commit seam on the committing stack) must belong to a unit the harness started: its
// stack holds a frame of this file (synchronously, or as the async caller of a helper the harness awaits). A commit with no such frame
// was made by a background writer (a wake subscriber run from the event loop, a timer, a microtask) between two harness steps, in an
// amount that depends on wall-clock time: exactly what can make a killed run and its twin end apart. It is recorded with its production
// frames and asserted empty at every kill point and at the end of every seed, so the writer is named at the line that fails.
const TRACE = process.env.MEMV2_KILL_TRACE === "1";
let traceJobs = "";
let unattributed: string[] = [], searchCommits = 0;
// (own Opus review r14 H2, evidence plan row 4a "the harness names each unit it starts") NAMED UNITS. A frame of this file on the
// committing stack is not enough: a harness line that calls a writer outside the reviewed schedule (the plan's ADD-WRITER, an un-logged
// drainRevokeMarkerBounded between two kill points) has that frame too. So every harness commit must also fall inside a unit the harness
// named (`inUnit`), and each unit is logged in order (`unitLog`, the input log row 4c replays). A harness commit with no unit open is a
// finding at the same assertion, named by the harness line that made it.
let unit: string | null = null, unitLog: string[] = [], unitCommits = 0;
// (C2) a unit is a log entry, never a licence: the WAL guard runs at every unit's entry and exit, so a main write the tap never saw (a raw or
// second-connection write) is a finding at the next boundary, before a production commit could stamp it as seen
function inUnit<T>(name: string, run: () => T): T {
  const outer = unit; walUnseen(); unit = outer ? `${outer}/${name}` : name; if (!outer) unitLog.push(name);
  try { return run(); } finally { walUnseen(); unit = outer; }
}
async function inUnitAsync<T>(name: string, run: () => Promise<T>): Promise<T> {
  const outer = unit; walUnseen(); unit = outer ? `${outer}/${name}` : name; if (!outer) unitLog.push(name);
  try { return await run(); } finally { if (!fixtureHeld) walUnseen(); unit = outer; }
}
// (HARNESS-DESIGN C2, closes ASTRA d7b1e5336a / MAIN 20:20:02Z) ATTRIBUTION = PRODUCTION FRAME ONLY. A unit name licenses nothing: there is
// no "harness" and no "any" entry. Each commit's structured V8 callsites (function name + file, never a regex over stack text) are walked
// outward from the bus frame (wake.ts ended); io-budget.ts and wake.ts frames are the bus. The FIRST frame that is either a harness frame
// (this file, any *.test.ts, anything under testing/) or a WRITER_ALLOWLIST row (killsuite-plan.ts) decides: a harness frame first = the
// harness wrote = finding; an allowlist row first = credited to that production writer. A commit that reaches neither is an unlisted
// writer = finding. The fixture build (F) runs before the leg's first kill point with the tap held (fixtureHeld), the one place a harness
// write is allowed; a fixture build after a kill point is itself a finding.
type Frame = { file: string; fn: string; line: number };
const HARNESS_FILE = /(?:\.test\.ts$|[\\/]testing[\\/])/;
const BUS_FILE = /[\\/]server[\\/](?:io-budget\.ts|memory[\\/]wake\.ts)$/;
function callsites(): Frame[] {
  const prep = Error.prepareStackTrace, limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 200; Error.prepareStackTrace = (_error, sites) => sites;
  try {
    const sites = (new Error() as unknown as { stack: NodeJS.CallSite[] }).stack;
    return sites.map(site => ({ file: String(site.getFileName() ?? "").replace(/^file:\/\//, "").replace(/\?.*$/, ""), fn: site.getFunctionName() ?? site.getMethodName() ?? "", line: site.getLineNumber() ?? 0 }));
  } finally { Error.prepareStackTrace = prep; Error.stackTraceLimit = limit; }
}
const allowRow = (frame: Frame) => WRITER_ALLOWLIST.find(row => frame.file.endsWith(`/server/${row.file}`) && row.fns.includes(frame.fn));
const where = (frame: Frame) => `${frame.file.replace(/^.*[\\/]server[\\/]/, "server/")}:${frame.fn || "<anon>"}:${frame.line}`;
/** The writer a commit is credited to, or the finding it is. Exported shape for the C2 inventory and the plants. */
function attribute(frames: Frame[]): { credit: string } | { finding: string } {
  const ended = frames.findIndex(frame => BUS_FILE.test(frame.file) && /wake\.ts$/.test(frame.file));
  if (ended < 0) return { finding: `no bus frame: ${frames.slice(0, 4).map(where).join(" < ")}` };
  let gated: Frame | null = null, gate: string[] = [];
  for (const frame of frames.slice(ended + 1)) {
    if (!frame.file || frame.file.startsWith("node:") || BUS_FILE.test(frame.file)) continue;
    if (HARNESS_FILE.test(frame.file) && STATEMENT_GUARD.has(frame.fn)) continue; // the statement guard's own observation frames
    if (HARNESS_FILE.test(frame.file)) return { finding: `harness writer ${where(frame)}${gated ? ` (through ${where(gated)})` : ""}` };
    const row = allowRow(frame);
    if (row?.under) { if (!gated) { gated = frame; gate = row.under; } continue; }
    if (row) {
      if (gated && !gate.includes(frame.fn)) return { finding: `gated writer ${where(gated)} reached under ${where(frame)}, not under ${gate.join("/")}` };
      return { credit: `${row.file}:${frame.fn}` };
    }
  }
  return { finding: `unlisted production writer ${frames.slice(ended + 1).filter(f => /[\\/]server[\\/]/.test(f.file) && !BUS_FILE.test(f.file)).slice(0, 4).map(where).join(" < ")}` };
}
let fixtureHeld = false;
const credited = new Map<string, number>();
// (C2, a raw-handle write) the WAL guard: the main file's wal-index header (mxFrame, nPage, frame checksum, salts: bytes 16..40 of -shm)
// changes on every commit to the main database and on nothing else (a checkpoint moves nBackfill, outside these bytes; TEMP lives in
// another file). The tap stamps it at every commit it sees; a change it never saw (a harness statement on the raw, untapped exec, or any
// other path around the bus) is a finding at the same attribution assertion.
let walPath = "", walSeen = "", walGen = -1;
function walStamp(): string {
  if (!walPath) return "";
  let fd = -1;
  try { fd = openSync(walPath, "r"); const head = Buffer.alloc(48); readSync(fd, head, 0, 48, 0); return head.subarray(16, 40).toString("hex"); }
  catch { return "none"; } finally { if (fd >= 0) closeSync(fd); }
}
function walRebase(db: DatabaseSync): void {
  const file = String((db.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find(row => row.name === "main")?.file ?? "");
  walPath = file ? `${file}-shm` : ""; walSeen = walStamp(); walGen = databaseGeneration();
}
function walUnseen(): void {
  if (walGen !== databaseGeneration()) return; // the handle is closed or another open made a new one: rebased by the next database()
  const now = walStamp();
  if (now !== walSeen) { unattributed.push(`main database changed with no commit seen by the tap (wal-index ${walSeen.slice(0, 16)} -> ${now.slice(0, 16)})`); walSeen = now; }
}
/** The harness's handle: a production open (the file was closed by a kill or a restart) is credited to database.ts database (allowlist);
 *  a new handle rebases the WAL guard. */
function database(): DatabaseSync {
  const outer = unit, before = databaseGeneration(); unit = outer ?? "open";
  try { const db = productionDatabase(); if (databaseGeneration() !== walGen) walRebase(db); guardStatements(db); return db; }
  finally { unit = outer; if (!outer && databaseGeneration() !== before) unitLog.push("open"); }
}
// (C3 statement time, FABLE 5c4ada4123 H-B/H-C) observation only, the native statement runs unchanged. (H-C) Before a statement that
// starts outside a transaction (a BEGIN, an autocommit), the WAL guard runs: a raw untapped main write is a finding before a later
// production commit can move the stamp past it. (H-B) A main-DB write statement whose innermost caller is a harness frame is a finding
// when it runs, so a harness write inside a production transaction (a step wrapper, a harness db.function callback) is never credited
// to that transaction's writer at its commit. TEMP statements are the harness's and the bus's own scratch and are not main writes.
const MAIN_WRITE = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX|ANALYZE)\b|^\s*WITH\b[\s\S]*\)\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i, TEMP_PART = /^\s*(?:CREATE\s+(?:TEMP|TEMPORARY)\b|(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|DROP\s+(?:TABLE|TRIGGER|VIEW|INDEX)(?:\s+IF\s+EXISTS)?)\s+temp\.)/i;
// (Astra 05a05bdab6 pass 2 / own Opus) the verb is read after a tokenizer, not off the raw text: comments become a space and a ";" splits
// only outside a string, quoted name or comment, so a write behind a leading comment (or a comment holding a ";") is still a write.
// A PRAGMA is a write unless it is a plain read or a connection setting (fail closed: an unknown PRAGMA with a value counts as a write).
const PRAGMA_RE = /^\s*PRAGMA\s+(?:("?)(\w+)\1\s*\.\s*)?(\w+)\s*([=(])?/i;
// read-only PRAGMAs that take an argument, connection-only settings (never a page of the file), and bare PRAGMAs that run work on the file
const PRAGMA_READ_ARG = new Set(["table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo", "foreign_key_list", "foreign_key_check", "integrity_check", "quick_check"]);
const PRAGMA_CONNECTION = new Set(["busy_timeout", "cache_size", "temp_store"]);
const PRAGMA_RUNS = new Set(["optimize", "incremental_vacuum", "wal_checkpoint", "shrink_memory"]);
function sqlStatements(sql: string): string[] {
  const out: string[] = []; let cur = "", k = 0;
  while (k < sql.length) {
    const c = sql[k], two = sql.slice(k, k + 2);
    if (two === "--") { const end = sql.indexOf("\n", k); k = end < 0 ? sql.length : end + 1; cur += " "; continue; }
    if (two === "/*") { const end = sql.indexOf("*/", k + 2); k = end < 0 ? sql.length : end + 2; cur += " "; continue; }
    const close = c === "'" ? "'" : c === '"' ? '"' : c === "`" ? "`" : c === "[" ? "]" : "";
    if (close) { const end = sql.indexOf(close, k + 1); const stop = end < 0 ? sql.length : end + 1; cur += sql.slice(k, stop); k = stop; continue; }
    if (c === ";") { out.push(cur); cur = ""; k++; continue; }
    cur += c; k++;
  }
  out.push(cur);
  return out;
}
function writesMain(part: string): boolean {
  const pragma = PRAGMA_RE.exec(part);
  if (pragma) {
    if (pragma[2] && /^temp$/i.test(pragma[2])) return false;
    const name = pragma[3].toLowerCase(), value = pragma[4];
    if (!value) return PRAGMA_RUNS.has(name);
    if (value === "(") return PRAGMA_RUNS.has(name) || !PRAGMA_READ_ARG.has(name);
    return !PRAGMA_CONNECTION.has(name);
  }
  return MAIN_WRITE.test(part) && !TEMP_PART.test(part);
}
const writeVerdicts = new Map<string, boolean>();
function statementWritesMain(sql: string): boolean {
  let verdict = writeVerdicts.get(sql);
  if (verdict === undefined) { verdict = sqlStatements(sql).some(writesMain); writeVerdicts.set(sql, verdict); }
  return verdict;
}
const STATEMENT_GUARD = new Set(["callsites", "memv2StatementGuard", "memv2GuardedExec", "memv2GuardedPrepare", "memv2GuardedCall"]);
const guardedHandles = new WeakSet<object>(), guardedStatements = new WeakSet<object>();
// the one reviewed raw harness write: the M6 tail check drops the marker in its own raw transaction and always rolls it back (:~935)
let rawRollbackProbe = false;
function memv2StatementGuard(db: DatabaseSync, sql: string): void {
  if (fixtureHeld || rawRollbackProbe) return;
  if (!db.isTransaction) walUnseen();
  if (!statementWritesMain(sql)) return;
  const caller = callsites().find(frame => frame.file && !frame.file.startsWith("node:") && !BUS_FILE.test(frame.file) && !(HARNESS_FILE.test(frame.file) && STATEMENT_GUARD.has(frame.fn)));
  if (caller && HARNESS_FILE.test(caller.file)) unattributed.push(`${unit ? `unit ${unit}: ` : ""}harness statement ${where(caller)} wrote main${db.isTransaction ? " inside an open transaction" : ""}: ${sql.slice(0, 60)}`);
}
function guardStatements(db: DatabaseSync): void {
  if (guardedHandles.has(db)) return;
  guardedHandles.add(db);
  const handle = db as unknown as { exec(sql: string): unknown; prepare(sql: string, ...rest: unknown[]): object }, exec = handle.exec, prepare = handle.prepare;
  guardMethods(db, handle, exec, prepare);
  // (own Opus H1) the handle's raw, un-instrumented exec/prepare (io-budget.ts rawConnection) is guarded too: a raw harness write inside
  // an open production transaction skips the WAL guard (db.isTransaction) and would be credited at the production COMMIT
  const raw = rawConnection(db) as unknown as { exec(sql: string): unknown; prepare(sql: string, ...rest: unknown[]): object } | undefined;
  if (raw) guardMethods(db, raw, raw.exec, raw.prepare);
}
function guardMethods(db: DatabaseSync, target: { exec(sql: string): unknown; prepare(sql: string, ...rest: unknown[]): object }, exec: (sql: string) => unknown, prepare: (sql: string, ...rest: unknown[]) => object): void {
  const self = target;
  target.exec = function memv2GuardedExec(sql: string) { memv2StatementGuard(db, sql); return exec.call(self, sql); };
  target.prepare = function memv2GuardedPrepare(sql: string, ...rest: unknown[]) {
    const statement = prepare.call(self, sql, ...rest) as Record<string, (...args: unknown[]) => unknown>;
    if (guardedStatements.has(statement)) return statement;
    guardedStatements.add(statement);
    for (const method of ["run", "get", "all", "iterate"]) {
      const original = statement[method];
      if (typeof original !== "function") continue;
      statement[method] = function memv2GuardedCall(...args: unknown[]) { memv2StatementGuard(db, sql); return original.apply(statement, args); };
    }
    return statement;
  };
}
/** Every harness close runs the WAL guard first: a main write the tap never saw is a finding before the handle (and its stamp) goes. */
function closeDb(): void { walUnseen(); closeDatabase(); }
function tapCommits(on: boolean): void {
  setWakeCommitTapForTest(on ? () => {
    const frames = callsites(), stampBefore = walSeen;
    walSeen = walStamp();
    // the bus reports every transaction end, a ROLLBACK and a TEMP-only statement included: only an end that moved the main file's wal-index
    // is a commit to the main database, and only that is attributed
    if (fixtureHeld || walSeen === stampBefore) return;
    if (TRACE) {
      const jobs = JSON.stringify(database().prepare("SELECT revoke_id,phase,state,cursor FROM memory_revoke_jobs ORDER BY 1").all());
      if (jobs !== traceJobs) { traceJobs = jobs; console.log(`TRACE-COMMIT jobs=${jobs.slice(0, 300)} ${frames.filter(f => /server[\\/]/.test(f.file)).slice(0, 12).map(where).join(" < ")}`); }
    }
    // (own Opus review r14) a subscriber dispatched by a pump, a deadline sweep or a timer is attributed on its own frames only: the
    // frames below the nearest bus dispatch are cut (today neither bus runs a subscriber inline; this keeps it so)
    const dispatch = frames.findIndex((f, k) => k > 0 && /(?:^|\.)(?:pump|run|runDue|sweepDeadlines|fireDeadlines|_onImmediate|_onTimeout)$/.test(f.fn) && /[\\/](?:wake|revoke-wake)\.ts$/.test(f.file));
    const verdict = attribute(dispatch < 0 ? frames : frames.slice(0, dispatch));
    if ("credit" in verdict) { unitCommits++; credited.set(verdict.credit, (credited.get(verdict.credit) ?? 0) + 1); if (/message-search-index/.test(verdict.credit)) searchCommits++; return; }
    unattributed.push(`${unit ? `unit ${unit}: ` : ""}${verdict.finding}`);
  } : null);
}
const takeUnattributed = (): string[] => { walUnseen(); const out = unattributed; unattributed = []; return out.length > 4 ? [...out.slice(0, 4), `... ${out.length} commits`] : out; };
/** Directed reproduction (plan row 4 "the base run"): MEMV2_KILL_YIELD=k lets k macrotasks and a real 50 ms pass at every kill point, so a
 * background writer that a wall-clock gap lets in commits there; MEMV2_KILL_SEEDS=a,b,... runs only those seeds. Both unset in the gate. */
const YIELD = Number(process.env.MEMV2_KILL_YIELD ?? 0);
const SEED_LIST = process.env.MEMV2_KILL_SEEDS ? process.env.MEMV2_KILL_SEEDS.split(",").map(Number) : null;
async function wallClockGap(): Promise<void> {
  if (!YIELD) return;
  for (let k = 0; k < YIELD; k++) await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setTimeout(resolve, 50));
}

/** Registers every step; `fault(task)` may throw AFTER the step did its work, inside the open transaction (a kill mid-batch). */
function register(fault: (task: string) => void) {
  for (const task of MIGRATION_TASKS) {
    const inner = DEFAULT[task];
    registerMigrationStep(task, (db, cursor, now) => { const result = inner(db, cursor, now); fault(task); return result; });
  }
}
/** Kills that landed inside an M2 batch while the forget's revoke was still standing (M2 is interrupted, not pre-drained). */
let m2Kills = 0, ranTask: string | null = null;
function killInside(task: string, abort: () => boolean): void {
  if (!abort()) return;
  if (task === "M2" && !revokeDrainMigrationStep(database(), null, 0).done) m2Kills++;
  throw new Killed();
}
function registerKills(abort: () => boolean) {
  for (const task of MIGRATION_TASKS) {
    const inner = DEFAULT[task];
    registerMigrationStep(task, (db, cursor, now) => { ranTask = task; const result = inner(db, cursor, now); killInside(task, abort); return result; });
  }
}

beforeEach(() => { unattributed = []; unit = null; unitLog = []; unitCommits = 0; tapCommits(true); useIdStream(true); vi.useFakeTimers({ toFake: ["Date"] }); PCLOCK.set = ms => { vi.setSystemTime(ms); }; resetMigrationV2ForTests(); setRetentionPageForTests(2); });
afterEach(() => { tapCommits(false); useIdStream(false); armMutants(false); vi.useRealTimers(); resetMigrationV2ForTests(); setRetentionPageForTests(); });

/** The kill kinds the harness drives (KILLSUITE rows by site: PLAN below). */
const KINDS = ["work", "cursor", "commit", "reopen"] as const;
type KillKind = typeof KINDS[number] | "stalled";
/** Why a receipt held from before a forget is refused: the revisions the forget moved (policy revision, deletion epoch: the global refusal, D5) and then the revoke its job writes on the receipt. */
const FORGET_REASONS = ["policy-revision", "deletion-epoch", "receipt-already-revoked"];
// (ASTRA/FABLE 9f2f7188ce H3) M2:drain = a kill inside lane C's own drain transaction; both M6 kinds are restarts (the file closed and
// reopened, so H's per-connection collector starts over): M6:marker kills H's marker write itself, M6:reopen follows a whole slice
// (MAIN board 2931/3000) PLAN is generated from designs/memv2-I/KILLSUITE.md: the rows testing/killsuite-plan.ts REVIEWED marks
// "inproc", grouped by the kill site that drives them (migration-v2-killsuite-inventory.test.ts fails on a missing, extra or duplicate row).
const PLAN = harnessSites();
/** Judged kinds no design row is credited with: a stalled batch (NO_PROGRESS rollback; O08's real-ROLLBACK proof is open), and M6:reopen
 *  (H-lap-reopen needs a reopen with the S3 marker present and seeded orphan debt; this harness reopens only before the marker exists). */
const JUDGED_NOT_CREDITED = /^(M[2-5]:stalled|M6:reopen|M6:fault)$/;
let drainKills = 0, drainDeep = 0;
const drainStacks = new Set<string>();
/** Product mutants (memv2-I-r7/mut/apply.py) act only once this is set: after the fixture and the uninterrupted reference run. */
const armMutants = (on: boolean) => { (globalThis as { __memv2MutantArmed?: boolean }).__memv2MutantArmed = on; };

// (Astra 05a05bdab6 pass 2) the statement guard's write classifier, row by row; the plants COMMENT and PRAGMA drive it through the real run
it("the statement guard reads a write behind a comment, a PRAGMA write and a VACUUM as main writes, and TEMP or read statements as not", () => {
  const rows: [string, boolean][] = [
    ["INSERT INTO main.t VALUES(1)", true], ["/* note */ INSERT INTO main.t VALUES(1)", true], ["-- note; more\nINSERT INTO main.t VALUES(1)", true],
    ["/* a ; b */ UPDATE memory_recall_changes SET x = 1", true], ["SELECT '/*'; DELETE FROM main.t; SELECT '*/'", true],
    ["PRAGMA user_version=5", true], ["PRAGMA main.application_id = 9", true], ["PRAGMA user_version(5)", true], ["PRAGMA wal_checkpoint(TRUNCATE)", true],
    ["PRAGMA optimize", true], ["VACUUM", true], ["REINDEX", true], ["ANALYZE", true], ["PRAGMA journal_mode=DELETE", true], ["PRAGMA foreign_keys=OFF", true],
    ["SELECT 1", false], ["SELECT ';INSERT INTO main.t VALUES(1)'", false], ["PRAGMA user_version", false], ["PRAGMA database_list", false],
    ["PRAGMA table_info(memory_scope_bindings)", false], ["PRAGMA busy_timeout=15000", false], ["PRAGMA temp.user_version=3", false],
    ["INSERT INTO temp.memv2_m6_fired VALUES(1)", false], ["/* x */ CREATE TEMP TABLE memv2_x(a)", false], ["DROP TRIGGER IF EXISTS temp.memv2_kill_i", false],
  ];
  expect(rows.filter(([sql, want]) => statementWritesMain(sql) !== want).map(([sql]) => sql), "statement classifier").toEqual([]);
});

it(`a kill at every batch boundary of M2..M5, then a restart, ends where an uninterrupted run ends, with the whole P-suite at every kill point (${SEEDS} seeds)`, async ({ task: self }) => {
  let seedsRun = 0, boundaries = 0, aborts = 0, cursorKills = 0, reopens = 0, strict = 0, windowsStanding = 0, jobsOpen = 0, m6Points = 0, m6MarkerKills = 0, m6Faults = 0;
  drainKills = 0; drainDeep = 0;
  const judged: Record<string, number> = {}, childKills: Record<string, number> = {}, childWrote: Record<string, number> = {}, committedAt: Record<string, number> = {};
  committedJudges = 0;
  let p5Shown = 0, committedHeld = 0, forcedCuts = 0;
  for (const key of Object.keys(P_REACHED) as Array<keyof typeof P_REACHED>) P_REACHED[key] = 0;
  probes = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    if (SEED_LIST && !SEED_LIST.includes(seed)) continue;
    seedsRun++; killPhase = false;
    await buildFixture(seed); register(() => {});
    // the uninterrupted run starts with real work in M3 (more than two trim ranges) and M4 (more than two batches of one version)
    expect(legacyJournal(database())).toBeGreaterThan(2 * RECALL_FLUSH_ROWS);
    expect(deadTerms(database())).toBeGreaterThan(2 * RECALL_DEAD_TERMS_ROWS);
    // M2 real work: the forget's revoke still has work when the runner starts
    expect(revokeDrainMigrationStep(database(), null, Date.now()).done).toBe(false);
    const waitsBefore = m2Waits;
    for (let i = 0; await driveOnce(); i++) if (i > 5000) throw new Error(`no end ${stuck()}`);
    expect(m2Waits - waitsBefore).toBeGreaterThan(0);
    const expected = endState(database()), referenceHeld = journalHeld(database());
    expect(expected.finished).toBe(true);
    expect([expected.legacyJournal, expected.deadTerms]).toEqual([0, 0]);

    const twinIds = [forgotten.id, subjects.receipt, built.n], twinTrace = built.trace;
    await buildFixture(seed); let protectedRows = protectedDigest();
    // the twin is built with the same ids (positive control of the reproducible id stream; a difference names the first draw that differs)
    const differs = built.trace.findIndex((caller, k) => caller !== twinTrace[k]);
    expect([forgotten.id, subjects.receipt, built.n], `reproducible ids seed ${seed}: first differing draw ${differs} (${twinTrace[differs]} / ${built.trace[differs]}) of ${twinTrace.length}/${built.trace.length}`).toEqual(twinIds);
    const next = rng(seed + 1000), childPending = childCutsOf(seed);
    let m6InSeed = 0;
    let abortNow = false;
    registerKills(() => { const now = abortNow; abortNow = false; return now; });
    killPhase = true;
    armMutants(true);
    /** One kill point: the whole P-suite on the database as the kill left it (an owner turn there), every verdict taken before any is
     * asserted, then the never-deleted rows (`digest`, taken before the judge ran) against `rows`. False = a finding: the run ends. */
    /** The COMMITTED judge's verdicts, each on its own hard line (the run ends at the first one that fails, at that line). */
    const holdCommitted = (c: Committed, where: string, credit: string[], ended = false): void => {
      const cAt = `committed judge ${where} ${JSON.stringify(c)}`, m4 = Boolean(readMarker(database(), "M4")?.done);
      // it ran where it was pointed (the copy, never the profile), ended on its own, and the profile's content did not move
      expect([c.pid === c.spawned, c.code, c.dataDir === c.copy, c.dataDir !== DATA_DIR, c.untouched], `the judge ran on its copy and left the cut untouched: ${cAt}`).toEqual([true, 0, true, true, true]);
      // branch evidence: no transaction at either turn's start or end, and the audience and authority stamps readable there (both are
      // undefined inside a transaction).
      expect([c.evidence.inTransaction, c.evidence.audienceStamp, c.evidence.authorityStamp], `the judge took a live turn's branches: ${cAt}`).toEqual([[false, false, false, false], [true, true, true, true], [true, true, true, true]]);
      // ... and between the two turns the connection's fleet applier ran on the wake bus, as in a live process (never inside a
      // transaction: recall-view.ts runRecallApplier -> applyRecallChanges): it holds an applied mark with a view as its member, and it
      // is what PROJECTED the cold turn's commits: the records that turn made stood in no view's rows after the turn and every one of
      // them stands in a view's rows once the applier ran (an applier that moves its mark and writes nothing is RED here)
      expect([c.evidence.fleet.applied, c.evidence.fleet.members >= 1, c.evidence.fleet.made >= 1, c.evidence.fleet.projectedBefore, c.evidence.fleet.projected === c.evidence.fleet.made], `the fleet applier ran between the two turns and projected the cold turn's commits: ${cAt}`).toEqual([true, true, true, 0, true]);
      // P1-W, P1-W2, P2-W, P3-W of the committed COLD turn
      const cold = turnOf(c.cold), warm = turnOf(c.warm);
      expect(cold.p1, `P1-W committed ${cAt}`).toEqual(TURN_HELD.p1);
      expect([cold.p1w2, m4 ? c.cold.p1w2terms : 0], `P1-W2 committed ${cAt}`).toEqual([TURN_HELD.p1w2, 0]);
      expect(cold.p2, `P2-W committed ${cAt}`).toEqual(TURN_HELD.p2);
      expect(cold.p3, `P3-W committed ${cAt}`).toEqual(TURN_HELD.p3);
      // the WARM turn (same connection, its view, stamps and caches now stored) answers as the cold one did
      expect([warm, c.warm.p1.served, m4 ? c.warm.p1w2terms : 0], `the warm turn answers as the cold one: ${cAt}`).toEqual([cold, c.cold.p1.served, 0]);
      // P5-shown, committed on the same copy: the owner's edit of a chunk a turn was shown makes a revoke job rooted at that chunk and
      // the turn's receipt that cites it (current before the edit) is refused; the edited chunk nothing was shown gets no job (the control:
      // an import that withdraws everything is RED). While the forget's window is still walked the new chunk may be withheld from the
      // turn, so nothing can be shown: that is reported as the withhold's own code, and never after the migration's end.
      if (c.shown.skipped === null) {
        p5Shown++;
        // the hold rows (held first: a standing window also withholds the frame receipt on the next line): the shown chunk's job stays
        // open for the runner (its state is on the next line), and its inline walk (a re-import has nothing to mark) left no
        // all-threads checking window standing, nor did the control's edit open one (a re-import that leaves every thread's recall
        // "checking" is RED: 1.0.21 cause5, revoke-commit.ts markInline)
        expect(c.shown.holds, `P5-shown committed, the hold rows ${cAt}`).toEqual({ shown: 0, other: 0 });
        // (the lookup receipt cites the chunk and is refused; the frame receipt is refused exactly when the recall put the chunk in it)
        expect([c.shown.imports, c.shown.before, c.shown.jobs, c.shown.jobStates, c.shown.after[1], c.shown.after[0] === (c.shown.frameCites ? "MEMORY_CONTEXT_REVOKED" : "current")], `P5-shown committed ${cAt}`).toEqual([["admitted", "admitted", "admitted", "admitted"], ["current", "current"], { shown: true, unshown: false }, ["active:mark"], "MEMORY_CONTEXT_REVOKED", true]);
      } else expect([ended, /^MEMORY_(REPLAY_LIMIT|EVIDENCE_UNAVAILABLE)$/.test(c.shown.skipped), c.shown.imports, c.shown.standing >= 1], `P5-shown not taken only while a window is still walked (one stands) ${cAt}`).toEqual([false, true, ["admitted", "admitted"], true]);
      // the migration over: every other live record is served by the committed turn (the control: a judge that refuses everything is RED)
      if (ended) expect(c.cold.p1.served, `P1-W committed, the control after the walk ${cAt}`).toEqual(["served"]);
      for (const site of credit) committedAt[site] = (committedAt[site] ?? 0) + 1;
      committedHeld++;
    };
    const judgeAt = async (site: string, where: string, before: PBaseline, digest: unknown, rows: unknown, journal: string[], forced?: { c: Committed; credit: string[] }): Promise<boolean> => {
      if (TRACE) console.log(`TRACE-JUDGE ${where} site ${site} jobs=${JSON.stringify(database().prepare("SELECT revoke_id,phase,state,cursor FROM memory_revoke_jobs ORDER BY 1").all()).slice(0, 300)}`);
      await wallClockGap();
      if (TRACE) console.log(`TRACE-AFTER-GAP jobs=${JSON.stringify(database().prepare("SELECT revoke_id,phase,state,cursor FROM memory_revoke_jobs ORDER BY 1").all()).slice(0, 300)}`);
      // row 4a: nothing but the harness's own units committed on this file since the last kill point
      // (hard: the run ends here, at the line that names the writer, before any verdict it could have moved is judged)
      expect(takeUnattributed(), `write attribution ${where} site ${site}`).toEqual([]);
      // a cut made by a REAL crash (a child killed by PID) was judged by the COMMITTED owner turn too, on a copy taken as the kill left it
      if (forced) holdCommitted(forced.c, `${where} site ${site}`, forced.credit);
      const v = probe(before, `${where} site ${site}`), walking = !revokeDrainMigrationStep(database(), null, 0).done, m4Done = Boolean(readMarker(database(), "M4")?.done);
      const at = `${where} site ${site} ${JSON.stringify({ ...v, walking, m4Done })}`;
      judged[site] = (judged[site] ?? 0) + 1;
      // P1-W: the forgotten record and the forgotten file's records are refused at EVERY kill point, and by the forget's own verdict
      // (record unavailable: the refusal a forget gives for good), never by a mark the walk may still lift and never "not known now".
      // While the forget's window is still walked (M2 not done) ANOTHER record may be withheld (replay limit, evidence unavailable).
      expect.soft([v.p1.forgotten, v.p1.retired], `P1-W ${at}`).toEqual(["MEMORY_RECORD_UNAVAILABLE", ["MEMORY_RECORD_UNAVAILABLE"]]);
      // once the walk is done every other live record is served (the control: a judge that refuses everything is RED)
      if (!walking) { strict++; expect.soft(v.p1.served, `P1-W after the walk ${at}`).toEqual(["served"]); }
      // P1-W2: the forgotten words are in no record text, and once M4 is done in no view term row either
      expect.soft([v.p1w2, m4Done ? v.p1w2terms : 0], `P1-W2 ${at}`).toEqual([[], 0]);
      // P2-W: the turn that was shown the record before the forget is refused, on both its receipts, for the forget's own reasons
      // (FORGET_REASONS), not for an incidental one
      expect.soft([v.p2.refused, v.p2.reasons.filter(reason => !FORGET_REASONS.includes(reason))], `P2-W ${at}`).toEqual([["MEMORY_CONTEXT_REVOKED"], []]);
      // P3-W: the forgotten file is not re-admitted, unchanged or appended; a file nobody forgot is
      expect.soft(v.p3, `P3-W ${at}`).toEqual({ same: "MEMORY_IMPORT_FORGOTTEN", appended: "MEMORY_IMPORT_FORGOTTEN", control: "admitted" });
      // P4: the slice closed no window and moved no started_lsn
      expect.soft(v.p4, `P4 ${at}`).toEqual([]);
      // P5-W: no open or queued revoke job was skipped, changed or dropped by the slice
      expect.soft(v.p5, `P5-W ${at}`).toEqual([]);
      // V5-OWN: no hold stands under a revoke that is done
      expect.soft(v.v5own, `V5-OWN ${at}`).toEqual([]);
      // the recall journal as the kill left it: every row a ready view has not applied, and the newest row, are still there
      // (taken right after the cut, before the judge's own turn wrote anything) exact rows of this file against its pre-cut journal
      expect.soft(journal, `journal kept ${at}`).toEqual([]);
      // the never-deleted rows, as the kill left them (taken before the judge ran)
      expect.soft(digest, `never-deleted rows ${where} site ${site}`).toEqual(rows);
      return self.result?.state !== "fail";
    };
    for (let i = 0; ; i++) {
      if (i > 20000) throw new Error("no end under kills");
      const roll = next();
      abortNow = roll < 0.25; // a kill inside this batch after its work, before its COMMIT
      armCursorKill(database(), roll >= 0.25 && roll < 0.4); // a kill at the cursor write of this batch
      // what P4 and P5 hold this slice to
      let before: PBaseline = pBaseline(), jPre = journalBefore(database());
      if (before.pending !== "[]") windowsStanding++;
      if (before.jobs !== "[]") jobsOpen++;
      let outcome: { more: boolean; stalled?: string }, kind: KillKind = "commit";
      let forcedJudge: { c: Committed; credit: string[] } | undefined;
      ranTask = null;
      // a cut allocated to this seed for the task about to run goes through the real crash: the slice runs in a child that is killed by PID
      const upcoming = MIGRATION_TASKS.find(task => !readMarker(database(), task)?.done);
      // (a fresh process's production open runs lane C's standing revoke work on its own, so the drain cut of a seed comes first: no
      // other child is opened while M2 waits until the drain cut was made)
      const want = upcoming === undefined || (upcoming === "M2" && childPending.has("M2:drain")) ? undefined : (["work", "cursor", "commit"] as const).find(k => childPending.has(`${upcoming}:${k}`));
      if (want) {
        abortNow = false; armCursorKill(database(), false);
        let pre = { stamp: "", markers: "", content: "" };
        // what the cut is held to is taken after the child's own production open (a new worker's open is its own committed work); the
        // pre-batch snapshot last, through the raw reader, with the harness's own handle closed
        const kill = await childKill(want, seed, () => { before = pBaseline(); jPre = journalBefore(database()); protectedRows = protectedDigest(); closeDb(); pre = recovered(); });
        // the recovered snapshot, read before the harness opens the file through the production open
        const post = recovered();
        const cut = `${kill.task}:${kill.kind}`;
        // the committed judge, on a copy of the file taken as the kill left it (before the harness opens it through the production open).
        // What it judges is that cut after ONE restart: the judge process's own production open runs first (a new worker's open-time
        // work, lane C's standing revoke work included), as it would for the first owner turn of a restarted app.
        forcedCuts++; forcedJudge = { c: await committedJudge(seed), credit: creditOf(cut) };
        expect.soft(killReceipt(kill), `child kill receipt seed ${seed} boundary ${i} ${cut}`).toEqual(KILLED_BY_PID);
        ranTask = kill.task; kind = kill.kind as KillKind; outcome = kill.outcome ?? { more: true };
        // work and cursor (a T cut): the child died inside the batch's open transaction, after the real step ran. The recovered file is
        // the pre-batch snapshot: no progress (the marker rows as before) and no durable work without it (every table's rows as before).
        if (kind === "work" || kind === "cursor") {
          expect.soft([kill.inTransaction, post.markers === pre.markers, post.stamp === pre.stamp, post.content === pre.content], `child died inside the open batch, nothing of it durable, seed ${seed} boundary ${i} ${cut} wrote ${kill.wrote}`).toEqual([true, true, true, true]);
          if (kind === "work") aborts++; else cursorKills++;
          if (kill.task) childWrote[kill.task] = (childWrote[kill.task] ?? 0) + kill.wrote;
        }
        // commit (a C cut, ASTRA c21dbca0b9): the child died the moment its batch's COMMIT returned, before publication. The recovered
        // file, read before any recovery, is exactly what the batch committed: its effects (full content as the child read it at the
        // cut) and its cursor (the recovered marker row of the task is the step's own answer, cursor and done) together ...
        if (kind === "commit") {
          const durable = rawRead(raw => { const m = kill.task ? readMarker(raw, kill.task as MigrationTask) : undefined; return m ? JSON.stringify({ cursor: m.cursor ?? null, done: m.done }) : undefined; });
          expect([kill.inTransaction, kill.committed?.markers === post.markers, kill.committed?.content === post.content, durable !== undefined && durable === kill.committed?.step, post.content !== pre.content], `child died at its COMMIT, batch effects and cursor durable together before recovery, seed ${seed} boundary ${i} ${cut} ${durable} / ${kill.committed?.step}`).toEqual([false, true, true, true, true]);
          // ... and the restart (the *-reopen rows): the production open on a fresh handle starts from exactly that committed resume point
          expect.soft(markersOf(database()), `fresh handle resumes from the committed cursor seed ${seed} boundary ${i} ${cut}`).toEqual(post.markers);
        }
        if (kill.task === "M2" && kind === "work" && !revokeDrainMigrationStep(database(), null, 0).done) m2Kills++;
        if (kill.kind === want) childPending.delete(cut);
        for (const site of creditOf(cut)) childKills[site] = (childKills[site] ?? 0) + 1;
      } else {
        try { outcome = inUnit("slice", () => runMigrationSlice({ budgetMs: 0 })); }
        catch (error) {
          if (error instanceof Killed) { aborts++; kind = "work"; }
          else if (error instanceof Error && error.message.includes(CURSOR_KILL)) { cursorKills++; kind = "cursor"; }
          else throw error;
          outcome = { more: true };
        }
      }
      abortNow = false; armCursorKill(database(), false);
      // (ASTRA/OPUS/FABLE 9f2f7188ce) a stalled batch is rolled back (NO_PROGRESS), not committed: it is judged as its own kind, never
      // counted as a commit kill site
      if (kind === "commit" && (outcome as { stalled?: string }).stalled !== undefined) kind = "stalled";
      // a kill after every committed batch: the runner's process state is gone; every fifth one also reopens the file
      boundaries++; resetMigrationV2ForTests(); registerKills(() => { const now = abortNow; abortNow = false; return now; });
      if (boundaries % 5 === 0) { closeDb(); reopens++; if (kind === "commit") kind = "reopen"; }
      const site = `${ranTask ?? "none"}:${kind}`;
      if (!await judgeAt(site, `seed ${seed} boundary ${i}`, before, protectedDigest(), protectedRows, journalKept(jPre, database()), forcedJudge)) return; // every check was reached; the run ends at the first kill point with a finding
      // then lane C's revoke runner takes its own turn; what it changes is its own (a closed window, a walked record), so the digest
      // and the baseline the next kill point is held to are taken again after it
      // While M2 waits, one in three of lane C's drain turns is killed INSIDE its transaction (a restart follows: process state gone, file
      // reopened): nothing it did may stand half-done, so P4/P5 hold it to the baseline taken before it and the never-deleted rows to theirs.
      // The kill lands on the 2nd..5th row the drain writes, so at least one row of the same transaction was really written before it;
      // the drain's own tables are then held row for row to their state before the drain (a commit instead of a rollback is RED there).
      // (only lane C's bounded marker drain turns, ONE transaction each: runRevocationJobsNow, every fourth wait, commits several, so a
      // row it committed before the kill is not a rollback failure)
      const drainKill = outcome.stalled === "M2" && (m2Waits + 1) % 4 !== 0 && next() < 0.9;
      let beforeDrain = pBaseline(), jPreD = journalBefore(database()), drainBefore = drainState(database());
      const drainAt = drainKill ? 2 + Math.floor(next() * 4) : 0;
      let killedDrain = false, drainRecovered: Record<string, string[]> | undefined;
      forcedJudge = undefined;
      if (drainKill && childPending.has("M2:drain")) {
        // the real crash inside lane C's drain: the same bounded marker drain turn, run by a child that is killed by PID at its
        // drainAt-th row write of the open transaction (the turn is counted as revokeOnce counts it)
        m2WaitsTotal++; m2Waits++;
        const kill = await childKill("drain", seed, () => { beforeDrain = pBaseline(); jPreD = journalBefore(database()); drainBefore = drainState(database()); protectedRows = protectedDigest(); }, 2);
        // the drain tables as the kill left them, read through the raw reader before anything opens the file (a fresh production open
        // runs lane C's standing revoke work itself, which could rewrite the same rows: FABLE/OPUS c21dbca0b9 H3)
        drainRecovered = rawRead(drainState);
        if (kill.kind === "drain") { forcedCuts++; forcedJudge = { c: await committedJudge(seed), credit: ["M2:drain"] }; }
        expect.soft(killReceipt(kill), `child kill receipt seed ${seed} boundary ${i} M2:drain`).toEqual(KILLED_BY_PID);
        if (kill.kind === "drain") {
          // the cut was reached through lane C's own revoke code (the production frames on the parked stack), inside its open transaction
          expect.soft([kill.inTransaction, (kill.drainWrites ?? 0) >= 2, kill.stack.some(frame => /@memory[\\/](memory-revocation|revoke-[\w-]+)\.ts$/.test(frame))], `child died inside the open drain seed ${seed} boundary ${i} ${JSON.stringify(kill.stack)}`).toEqual([true, true, true]);
          drainStacks.add(kill.stack.slice(0, 4).join(" < "));
          killedDrain = true; drainWrites = kill.drainWrites ?? 0; childPending.delete("M2:drain"); childKills["M2:drain"] = (childKills["M2:drain"] ?? 0) + 1;
        }
      } else {
        armDrainKill(database(), drainAt);
        try { revokeOnce(outcome); }
        catch (error) { if (!(drainKill && error instanceof Error && error.message.includes(DRAIN_KILL))) throw error; killedDrain = true; }
        finally { armDrainKill(database(), 0); }
      }
      if (killedDrain) {
        drainKills++; resetMigrationV2ForTests(); registerKills(() => { const now = abortNow; abortNow = false; return now; }); closeDb();
        drainDeep += drainWrites >= 2 ? 1 : 0;
        expect.soft(drainRecovered ?? drainState(database()), `M2 drain rolled back seed ${seed} boundary ${i} (killed at row write ${drainWrites})`).toEqual(drainBefore);
        if (!await judgeAt("M2:drain", `seed ${seed} boundary ${i} (inside lane C's drain)`, beforeDrain, protectedDigest(), protectedRows, journalKept(jPreD, database()), forcedJudge)) return;
      }
      protectedRows = protectedDigest();
      // M6, lane H's lap: one slice of it, then a restart at ITS boundary with the whole P-suite again; the first time each seed the
      // marker write itself is killed (H must not count its lap done: the marker is absent after the restart). Both kinds close and
      // reopen the file, so H's collector (kept per connection) starts over. Counted only while the lap is unfinished before the slice.
      if (m6Open()) {
        let beforeM6 = pBaseline(), jPre6 = journalBefore(database()); m6Points++;
        // per seed: the marker write is KILLED first (the write is lost), then it FAULTS (a statement abort H catches), then the lap
        // runs to its end after a restart
        const m6Kind = (["marker", "fault"] as const)[m6InSeed++] ?? "reopen";
        let fired = 0;
        forcedJudge = undefined;
        if (m6Kind === "marker" && childPending.has("M6:marker")) {
          // the real crash at lane H's marker upsert: H's slice runs in a child that is killed by PID inside that statement
          const kill = await childKill("marker", seed, () => { beforeM6 = pBaseline(); jPre6 = journalBefore(database()); protectedRows = protectedDigest(); });
          expect.soft([...killReceipt(kill), kill.kind], `child kill receipt seed ${seed} boundary ${i} M6:marker`).toEqual([...KILLED_BY_PID, "marker"]);
          if (kill.kind === "marker") { forcedCuts++; forcedJudge = { c: await committedJudge(seed), credit: ["M6:marker"] }; }
          // the recovered file (raw reader) has no marker row: the upsert the child died in is not durable
          expect.soft(recovered().markers.includes(M6_MARKER_ID), `M6 marker not durable after the child kill seed ${seed} boundary ${i}`).toBe(false);
          fired = kill.kind === "marker" ? 1 : 0; childPending.delete("M6:marker"); childKills["M6:marker"] = (childKills["M6:marker"] ?? 0) + 1;
        } else if (m6Kind === "fault") {
          // M6 cleanup fault: H's slice attempts its marker write once, the statement aborts, H catches it and the slice returns; the
          // failed write is not counted as a finished lap: no marker row stands (the restart below runs the lap again, and the seed
          // cannot end without the marker). A slice that never attempted the write, attempted it again, threw, or left a marker is RED.
          let returned = false;
          armM6Fault(database(), true);
          try { collectSessionChecksSlice(database(), Date.now()); returned = true; } catch { /* H must catch its own marker failure */ } finally { armM6Fault(database(), false); }
          expect([returned, m6Attempts, m6Open()], `M6 cleanup fault: the write was attempted once, H caught its failure, no marker stands, seed ${seed} boundary ${i}`).toEqual([true, 1, true]);
          // ... and in this SAME process (before the restart below): H holds the lap as done in memory only. More slices of the running
          // process, a lap step's pace later, write no marker: the durable credit is given by a marker write that succeeds, never later
          // from the in-memory flag (the restart is what runs the lap again).
          for (const later of [1_500, 3_000]) collectSessionChecksSlice(database(), Date.now() + later);
          expect(m6Open(), `M6 cleanup fault, the same process afterwards: no marker is written from the in-memory credit, seed ${seed} boundary ${i}`).toBe(true);
          m6Faults++;
        } else {
          armM6Kill(database(), m6Kind === "marker");
          try { inUnit("m6-slice", () => collectSessionChecksSlice(database(), Date.now())); } finally { fired = armM6Kill(database(), false); }
        }
        // the kill counts only when H's slice really attempted its marker write (logged by the trigger), and the write did not land
        if (m6Kind === "marker") { m6MarkerKills += Math.min(fired, 1); expect([fired > 0, m6Open()], `M6 marker kill seed ${seed}`).toEqual([true, true]); }
        resetMigrationV2ForTests(); registerKills(() => { const now = abortNow; abortNow = false; return now; }); closeDb();
        if (!await judgeAt(`M6:${m6Kind}`, `seed ${seed} boundary ${i} (after lane H's slice)`, beforeM6, protectedDigest(), protectedRows, journalKept(jPre6, database()), forcedJudge)) return;
        protectedRows = protectedDigest();
      }
      if (!moreAfter(outcome)) break;
    }
    // The end state of the killed run is its no-kill twin's, row for row, the journal included: the exact ordered rows (sequence, kind,
    // object id, version), the persisted projection_floor and every view's watermark. Nothing is relabelled, cut to a tail or left out.
    // (ASTRA/FABLE 9f2f7188ce H4) each run's journal must also hold every row its ready views have not applied and its newest row
    // every cut allocated to this seed was really reached by a child and killed there (an unreachable cut fails here)
    expect([...childPending], `child cuts never reached seed ${seed}`).toEqual([]);
    // after the killed and the faulted marker write, a later slice of a fresh collector ran the lap again and wrote the marker
    expect([m6InSeed >= 3, m6Open()], `M6 lap ran again after the kill and the fault and wrote its marker, seed ${seed}`).toEqual([true, false]);
    await wallClockGap();
    expect(takeUnattributed(), `write attribution end of seed ${seed}`).toEqual([]);
    const ended = endState(database());
    expect([journalHeld(database()), referenceHeld], `journal held seed ${seed}`).toEqual([{ unappliedMissing: 0, rows: true }, { unappliedMissing: 0, rows: true }]);
    expect(ended.journal, `journal exact seed ${seed}`).toEqual(expected.journal);
    expect(ended, `seed ${seed}`).toEqual(expected);
    // the end of the seed is judged by the committed owner turn as well (a fresh process on a copy of the finished file)
    holdCommitted(await committedJudge(seed), `end of seed ${seed}`, [], true);
    const end = probe(pBaseline(), `end of seed ${seed}`);
    expect([end.p1.forgotten, end.p1.retired, end.p1.served, [end.p1w2, end.p1w2terms], end.p2.refused, end.p2.reasons.filter(reason => !FORGET_REASONS.includes(reason)), end.p3], `P-suite after seed ${seed}`)
      .toEqual(["MEMORY_RECORD_UNAVAILABLE", ["MEMORY_RECORD_UNAVAILABLE"], ["served"], [[], 0], ["MEMORY_CONTEXT_REVOKED"], [], { same: "MEMORY_IMPORT_FORGOTTEN", appended: "MEMORY_IMPORT_FORGOTTEN", control: "admitted" }]);
    // M6 is lane H's lap: without its marker the migration is not reported finished. (C2) The harness writes nothing: the marker is dropped
    // inside a transaction on the raw, untapped exec and rolled back, so the main file never changes (the WAL guard holds it).
    const tail = database(), raw = rawConnection(tail)!;
    raw.exec("BEGIN");
    let finishedWithoutM6: boolean;
    rawRollbackProbe = true;
    try { raw.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run(M6_MARKER_ID); finishedWithoutM6 = migrationV2Finished(tail); }
    finally { raw.exec("ROLLBACK"); rawRollbackProbe = false; }
    // (ASTRA r15 pre-push) the seed's tail (the end-of-seed judge, the marker check) is held to the same attribution: nothing is left buffered
    expect(takeUnattributed(), `write attribution after the end of seed ${seed}`).toEqual([]);
    expect(finishedWithoutM6).toBe(false);
  }
  // a directed run of chosen seeds (MEMV2_KILL_SEEDS) is judged per seed only: the totals below are for the whole gate run (and a seed
  // list that matched no seed is a failure, never a pass)
  if (SEED_LIST) console.log(`ATTR-CREDITED ${JSON.stringify([...credited])}`);
  if (SEED_LIST) { expect(seedsRun, `seeds run of ${SEED_LIST.join(",")}`).toBeGreaterThan(0); return; }
  console.log(`GATE-MEASURE MIGRATION-KILL seeds=${SEEDS} boundaries=${boundaries} aborts=${aborts} cursorKills=${cursorKills} reopens=${reopens} m2Waits=${m2WaitsTotal} m2Kills=${m2Kills} strictP1=${strict} m6Points=${m6Points} m6MarkerKills=${m6MarkerKills} m6Faults=${m6Faults} drainKills=${drainKills} drainDeep=${drainDeep} windowsStanding=${windowsStanding} jobsOpen=${jobsOpen} pReached=${JSON.stringify(P_REACHED)} sites=${JSON.stringify(judged)} childKills=${JSON.stringify(childKills)} committedJudges=${committedJudges} p5Shown=${p5Shown} committedAt=${JSON.stringify(committedAt)} drainStacks=${JSON.stringify([...drainStacks])} searchCommits=${searchCommits} unitCommits=${unitCommits} units=${unitLog.length} credited=${JSON.stringify([...credited])}`);
  // the attribution tap really ran (an empty pass would make every write-attribution check vacuous)
  expect(unitCommits).toBeGreaterThan(SEEDS);
  expect(aborts).toBeGreaterThan(SEEDS);
  // kills landed in M2 while its revoke stood, and the strict P1 (after the walk) ran at kill points of every seed
  expect(m2Kills).toBeGreaterThan(SEEDS / 2);
  expect(strict).toBeGreaterThan(SEEDS);
  expect(cursorKills).toBeGreaterThan(SEEDS / 2);
  // kills landed inside lane C's drain, and H's marker write was killed once per seed (then the lap ran again after the restart)
  // (HARNESS-DESIGN C1, memv2-I-tests-r2) the harness's own one-row drainRevokeMarkerBounded calls (what made "> SEEDS / 2" reachable, 39 at
  // r14) are a harness writer and are gone. (MAIN-RULING memI-scope H7) the deep drain kills are the child kills INSIDE C's drain: a child
  // killed by PID at its 2nd row write of the open drain transaction (>= 2 rows really written), once on EVERY seed (childCutsOf), the
  // drain tables then held row for row to their state before it (M2 drain rolled back). Floor: one per seed, all deep.
  const drainFloor = SEEDS;
  expect([drainKills >= drainFloor, childKills["M2:drain"] === drainKills, drainDeep === drainKills, m6MarkerKills, m6Faults], `drain kills ${drainKills} (floor ${drainFloor}, child ${childKills["M2:drain"]}, deep ${drainDeep})`).toEqual([true, true, true, SEEDS, SEEDS]);
  // every P check ran to its end at every kill point: the runner's and lane H's (the end-of-seed judge adds one run a seed)
  const points = boundaries + m6Points + drainKills + SEEDS;
  expect(probes).toBe(points);
  expect(P_REACHED).toEqual({ "P1-W": points, "P1-W2": points, "P2-W": points, "P3-W": points, P4: points, "P5-W": points, "V5-OWN": points });
  // every planned row was hit and judged, and P4/P5 had standing windows and open jobs to hold the slices to
  // per design row: every row the plan credits to the harness was driven and judged, and the harness judged no kind the plan does not name
  expect([...PLAN].filter(([site]) => !judged[site]).flatMap(([, ids]) => ids)).toEqual([]);
  expect(Object.keys(judged).filter(site => !PLAN.has(site) && !JUDGED_NOT_CREDITED.test(site))).toEqual([]);
  // ... and every row the plan credits was cut by a REAL crash (a child process killed by PID at that cut), not only in process
  expect([...PLAN].filter(([site]) => !childKills[site]).flatMap(([, ids]) => ids)).toEqual([]);
  // the open batches the children died in had really written rows (M3 trim, M4 terms, M5 jobs; M2's step is a read-only probe)
  // ... and every such row's cut was judged by the COMMITTED owner turn (a fresh process on a copy of the cut), as was every seed's end:
  // one committed judge per child kill that reached its cut, plus one per seed
  expect([...PLAN].filter(([site]) => !committedAt[site]).flatMap(([, ids]) => ids), `rows with no committed judge ${JSON.stringify(committedAt)}`).toEqual([]);
  // exactly: one judge child per child kill that reached its cut plus one per seed's end, and every one of them was held to its lines
  expect([committedJudges, committedHeld, forcedCuts >= 2 * SEEDS], `committed judges ${committedJudges} held ${committedHeld} forced cuts ${forcedCuts}`).toEqual([forcedCuts + SEEDS, forcedCuts + SEEDS, true]);
  // P5-shown was taken at the end of every seed at least (and at every forced cut where the forget's walk was over)
  expect(p5Shown).toBeGreaterThanOrEqual(SEEDS);
  expect(["M3", "M4", "M5"].filter(task => !childWrote[task]), `child kills inside a batch that had written rows ${JSON.stringify(childWrote)}`).toEqual([]);
  expect([windowsStanding > SEEDS, jobsOpen > SEEDS]).toEqual([true, true]);
}, 1_800_000);
