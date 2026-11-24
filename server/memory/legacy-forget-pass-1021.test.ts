// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: producer of the deny keys of a Forget an OLDER build queued = legacy-forget-keys.ts writeLegacyForgetKeys, called by
// database.ts at every open (lane cause10-v2-legacy, MAIN-RULING 2026-11-21T15:42Z). Producer of the keys of a Forget made by this build
// = forget.ts (cause10-redesign-opus, FORGET-ATOMIC.md). Readers = import.ts and deny-read.ts, unchanged. Job runner = memory-revocation.ts,
// unchanged in what it does (it only finds the keys already there).
// 1.0.20 and 1.0.21 (f6ae52c670) wrote the deny keys of the newest 64 evidence rows or revisions in the Forget's commit and left the rest
// to the job. On the owner's profile the runner does not drain (about 2,376 queued jobs), so a copy imported before such a Forget stays
// recallable. These witnesses open the profile again (the first open on the new build) and never run a job.
// Real paths: the owner's import and the tracked sync as those builds ran them, the real Forget, the real open (database.ts), the real
// reader verdict (deny-read.ts memoryLookup, readable.ts writetimeRecordRefusal). Runs unchanged on f6ae52c670 and on the cause10-v2 tip.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import * as importer from "./import.ts";
import { commitMemoryImport, previewMemoryImport, syncTrackedMemoryImports } from "./import.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import * as revokeBudget from "./revoke-budget.ts";
import { memoryLookup } from "./deny-read.ts";
import { FORGET_INLINE_ROWS, forgetMemory } from "./forget.ts";
import { writetimeRecordRefusal } from "./readable.ts";
import { INLINE_REVOCATION, runRevocationJobsNow, stopMemoryRevocation } from "./memory-revocation.ts";
import { backup, DatabaseSync } from "node:sqlite";
import { mergeDestinationMemoryDeletions } from "./restore.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";

type PassStats = { jobs: number; commits: number; keys: number; ms: number };
type Pass = { jobsPerCommit: number; step: null | ((at: string, jobRow: string | null) => void); last: PassStats | null };
/** The pass's switches (absent on the base trees: nothing runs there, which is the hole). */
async function passOf(): Promise<{ pass: Pass | null; queueSql: string | null }> {
  const file = "./legacy-forget-keys" + ".ts";
  try { const module = await import(/* @vite-ignore */ file) as { LEGACY_FORGET_PASS: Pass; LEGACY_FORGET_JOBS: string }; return { pass: module.LEGACY_FORGET_PASS, queueSql: module.LEGACY_FORGET_JOBS }; }
  catch { return { pass: null, queueSql: null }; }
}
const chunkDiff = (importer as { IMPORT_CHUNK_DIFF?: { keep: boolean } }).IMPORT_CHUNK_DIFF;

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
  revokeBudget.resetRevokeWriteBudget();
  (importer as { resetMemoryImportPreviews?: () => void }).resetMemoryImportPreviews?.();
  // the import as 1.0.20 and 1.0.21 ran it: a version and a handle at every notebook revision (the switch exists from cause10 on)
  if (chunkDiff) chunkDiff.keep = false;
});
const inlineMs = INLINE_REVOCATION.ms;
afterEach(async () => {
  INLINE_REVOCATION.ms = inlineMs; if (chunkDiff) chunkDiff.keep = true;
  const { pass } = await passOf(); if (pass) { pass.step = null; pass.jobsPerCommit = 256; }
  closeDatabase();
});
/** The field state: the Forget's inline job slice is wall-clock (8 ms) and a busy machine spends it before the first step. */
const busy = () => { INLINE_REVOCATION.ms = 0; };

const line = (i: number, word = "ledger") => `Line ${String(i).padStart(4, "0")}: ${word} notes the owner keeps here`.padEnd(63, ".") + "\n";
const body = (count: number) => Array.from({ length: count }, (_, i) => line(i));
let path = "";
const ticket = () => ownerMemoryTicket();
function seed(text: string) {
  path = join(ensureWorkspace("a"), "MEMORY.md");
  writeFileSync(path, text);
  commitMemoryImport(ticket(), previewMemoryImport(ticket(), [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
}
function routineWrites(text: string) {
  writeFileSync(path, text);
  database().exec("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.checkedAt',0) WHERE subject_id='notebook-link'");
  return syncTrackedMemoryImports(roster);
}
function topicFile(name: string, text: string) {
  const dir = join(ensureWorkspace("a"), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}
const importTopic = (name: string) => commitMemoryImport(ticket(), previewMemoryImport(ticket(), [{ kind: "bot", botId: "a", topic: name }], roster).previewId, roster, false);
type Row = Record<string, unknown>;
const all = (sql: string, ...args: Array<string | number>) => database().prepare(sql).all(...args) as Row[];
const count = (sql: string, ...args: Array<string | number>) => Number((database().prepare(sql).get(...args) as { n: number }).n);
const sourceIdOf = (file: string) => String((database().prepare("SELECT id FROM memory_sources WHERE kind='legacy-import' ORDER BY rowid LIMIT 1 OFFSET ?").get(file === "MEMORY.md" ? 0 : 1) as Row).id);
const revisionOf = (id: string) => Number((database().prepare("SELECT revision FROM memory_sources WHERE id=?").get(id) as Row).revision);
/** What recall asks of a copy (as forget-atomic-1021.test.ts): "withheld" is a definite refusal; "checking" is only the revoke's
 * pending window, which its marker walk closes on its own clock whatever the job has written, after which the copy reads shown. */
function copyState(copyId: string): string[] {
  const chunk = all("SELECT id,version FROM memory_records WHERE id LIKE ? ORDER BY id,version DESC LIMIT 1", `${copyId}:chunk:%`)[0]!;
  const source = memoryLookup(database(), [{ kind: "source", id: copyId, version: revisionOf(copyId) }], { audience: null }).values().next().value!.state;
  const evidence = all("SELECT source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=? AND record_version=?", String(chunk.id), Number(chunk.version))
    .map(row => ({ sourceId: String(row.source_id), revision: Number(row.source_revision), startByte: Number(row.start_byte), endByte: Number(row.end_byte) }));
  let record: string;
  try { record = writetimeRecordRefusal(database(), { kind: "record", id: String(chunk.id), version: Number(chunk.version) }, evidence) ? "withheld" : "shown"; }
  catch (error) { if (String(error).includes("MEMORY_REPLAY_LIMIT")) record = "checking"; else throw error; }
  return [source, record];
}
const JOBS = "subject_type='system' AND subject_id='memory-revocation' AND state IN ('granted','revoked')";
const jobsOwed = () => count(`SELECT count(*) AS n FROM memory_scope_bindings WHERE ${JOBS}`);
const jobs = () => all(`SELECT id,intent FROM memory_scope_bindings WHERE ${JOBS} ORDER BY rowid`).map(row => ({ row: String(row.id), job: JSON.parse(String(row.intent)) as Record<string, any> }));
/** A notebook changed 70 times by the routine: 71 revisions, and 71 versions of each unchanged chunk with a handle each. */
function longNotebook(): { first: string; id: string } {
  const lines = body(330), first = lines.join("");
  seed(first);
  const text = [...lines];
  for (let i = 0; i < 70; i++) { text.push(line(330 + i, "routine")); routineWrites(text.join("")); }
  const id = sourceIdOf("MEMORY.md");
  expect(revisionOf(id)).toBe(71);
  expect(count("SELECT count(*) AS n FROM memory_evidence WHERE record_id=?", `${id}:chunk:0`)).toBe(71);
  return { first, id };
}
const garden = () => body(40).map((_, i) => line(i, "garden")).join("");
/** The notebook revisions whose contents carry an import key in the notebook's scope. */
const keyedRevisions = (id: string) => all(`SELECT v.revision AS r FROM memory_source_versions v JOIN memory_sources s ON s.id=v.source_id WHERE v.source_id=?
  AND EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='import' AND t.target_id=s.scope_id AND t.content_hash=v.content_hash) ORDER BY v.revision`, id).map(row => Number(row.r));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** What every receipt and retained session is compared with (deny-read.ts "watermark", session-proof.ts "writetime-watermark"). */
const watermark = () => { const row = database().prepare("SELECT deletion_epoch AS e,policy_revision AS p FROM memory_meta WHERE id=1").get() as { e: number; p: number }; return [Number(row.e), Number(row.p)]; };

/** The profile as the shipped builds leave it after the Forgets above: the keys of what each job still owes are not written, and the
 * job row has the shipped shape. On f6ae52c670 this changes NOTHING (the real Forget already left exactly that; the assertions after
 * it hold there untouched). On the cause10-v2 trees the Forget of this build wrote every key in its commit (FORGET-ATOMIC), so a queued
 * Forget of an older build cannot be made by calling it: the keys the job's own cursor says are owed are taken out again, and the two
 * fields only this lineage writes (`record.keys`, `record.span`) with them. What is owed is read from the job row, never restated here. */
function asShipped(): void {
  const db = database();
  for (const { row, job } of jobs()) {
    if (job.record?.id && job.phases.includes("supporting") && job.record.after) {
      const owed = `FROM memory_evidence e WHERE e.record_id=?1 AND (e.record_version,e.source_id,e.source_revision,e.start_byte)<(?2,?3,?4,?5)`;
      const args = [String(job.record.id), ...job.record.after] as Array<string | number>;
      db.prepare(`DELETE FROM memory_tombstones WHERE target_type='import' AND content_hash IN (SELECT v.content_hash ${owed.replace("WHERE", "JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision WHERE")})`).run(...args);
      db.prepare(`DELETE FROM memory_tombstones WHERE target_type='source' AND reason='forgotten-supporting-source' AND (target_id,revision) IN (SELECT e.source_id,e.source_revision ${owed})`).run(...args);
      db.prepare("UPDATE memory_scope_bindings SET intent=json_remove(intent,'$.record.keys','$.record.span') WHERE id=?").run(row);
    }
    if (job.imports?.id && job.phases.includes("imports")) {
      // the shipped commit took the newest FORGET_INLINE_ROWS revisions and left every one below the last of them to the job
      const below = Number((db.prepare("SELECT revision FROM memory_source_versions WHERE source_id=? ORDER BY revision DESC LIMIT 1 OFFSET ?").get(String(job.imports.id), FORGET_INLINE_ROWS - 1) as Row).revision);
      db.prepare(`DELETE FROM memory_tombstones WHERE target_type='import' AND content_hash IN (SELECT content_hash FROM memory_source_versions WHERE source_id=? AND revision<?)`).run(String(job.imports.id), below);
      // (cause10 v2 r3: a source Forget of this build marks its job `imports.keys`; the shipped builds wrote no such field)
      db.prepare("UPDATE memory_scope_bindings SET intent=json_remove(json_set(intent,'$.imports.below',?),'$.imports.keys') WHERE id=?").run(below, row);
    }
  }
}
/** The first open of the profile on this build: the process that queued the Forget is gone, the file is opened again. No job runs. */
const openAgain = () => { closeDatabase(); database(); };

it("L1 a record Forget an older build left queued (more than 64 versions): at the next open a copy imported before it is unrecallable and its words unimportable, before any job runs and with the job row lost", () => {
  const { first, id } = longNotebook();
  topicFile("copy.md", first);
  expect(importTopic("copy.md").imported).toBe(1);
  const copy = sourceIdOf("copy.md");
  expect(copyState(copy)).toEqual(["shown", "shown"]);
  busy();
  forgetMemory(ticket(), { kind: "record", id: `${id}:chunk:0` });
  asShipped();
  // the shipped shape (true on f6ae52c670 with asShipped changing nothing): the job owes the supporting phase from a cursor, carries no
  // `keys`, and only the newest 64 revisions' contents are keyed
  const [queued] = jobs();
  expect(queued!.job.phases[0]).toBe("supporting");
  expect(queued!.job.record.after).toHaveLength(4);
  expect(queued!.job.record.keys).toBeUndefined();
  expect(keyedRevisions(id)).toEqual(range(8, 71));
  const [epoch, policy] = watermark();
  openAgain();
  // no job ran: the row is still queued, at the same cursor
  expect(jobs().map(entry => [entry.job.phases[0], entry.job.record.after])).toEqual([["supporting", queued!.job.record.after]]);
  expect(copyState(copy)).toEqual(["withheld", "withheld"]);
  expect(keyedRevisions(id)).toEqual(range(1, 71));
  // the copy read shown since the older build's commit: a receipt or retained session made meanwhile carries that time's watermark,
  // and the watermark has moved (once: one Forget took effect), so each is judged again; the keys written carry the new epoch
  expect(watermark()).toEqual([epoch! + 1, policy! + 1]);
  expect(count("SELECT count(*) AS n FROM memory_tombstones WHERE epoch=?", epoch! + 1)).toBe(71 + 7);
  // and nothing rests on the job row from here on (a restore of an older backup carries the keys, never a pending job)
  database().exec("DELETE FROM memory_scope_bindings WHERE subject_id='memory-revocation'");
  expect(copyState(copy)).toEqual(["withheld", "withheld"]);
  topicFile("again.md", first);
  expect(() => importTopic("again.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  // only what was forgotten: other words import
  topicFile("other.md", garden());
  expect(importTopic("other.md").imported).toBe(1);
});

it("L2 a source Forget an older build left queued (more than 64 revisions): at the next open a copy from before is unrecallable, every revision is keyed, and the same words are refused", () => {
  const { first, id } = longNotebook();
  topicFile("copy.md", first);
  expect(importTopic("copy.md").imported).toBe(1);
  const copy = sourceIdOf("copy.md");
  expect(copyState(copy)).toEqual(["shown", "shown"]);
  busy();
  forgetMemory(ticket(), { kind: "source", id });
  asShipped();
  const [queued] = jobs();
  expect(queued!.job.phases[0]).toBe("imports");
  expect(queued!.job.imports.below).toBe(8);
  expect(keyedRevisions(id)).toEqual(range(8, 71));
  const [epoch, policy] = watermark();
  openAgain();
  expect(watermark()).toEqual([epoch! + 1, policy! + 1]);
  expect(jobsOwed()).toBe(1);
  expect(jobs()[0]!.job.phases[0]).toBe("imports");
  expect(copyState(copy)).toEqual(["withheld", "withheld"]);
  expect(keyedRevisions(id)).toEqual(range(1, 71));
  database().exec("DELETE FROM memory_scope_bindings WHERE subject_id='memory-revocation'");
  expect(copyState(copy)).toEqual(["withheld", "withheld"]);
  topicFile("again.md", first);
  expect(() => importTopic("again.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  topicFile("other.md", garden());
  expect(importTopic("other.md").imported).toBe(1);
});

/** Everything the pass may write, without the two values that differ by run (a key's random id, its clock): every deny key with its
 * multiplicity (a key written twice by a resumed pass would show), every job row, the held lines. */
function state(): string {
  return JSON.stringify({
    keys: all("SELECT target_type,target_id,revision,content_hash,epoch,reason FROM memory_tombstones ORDER BY target_type,target_id,revision,content_hash,reason,epoch"),
    jobs: all(`SELECT id,state,intent FROM memory_scope_bindings WHERE ${JOBS} ORDER BY id`),
    holds: all("SELECT thread_id,position FROM turn_source_holds ORDER BY thread_id,position"),
    meta: all("SELECT deletion_epoch,policy_revision FROM memory_meta"),
  });
}
const FILES = ["messages.db", "messages.db-wal"];

it("L3 the pass is killed at every step (the files as a kill leaves them): every restart reaches the same state as the uninterrupted pass, no key twice, and a later open writes nothing", async () => {
  const { id } = longNotebook();
  busy();
  // three queued Forgets of an older build: two chunks of the notebook, then the notebook itself
  forgetMemory(ticket(), { kind: "record", id: `${id}:chunk:0` }); asShipped();
  forgetMemory(ticket(), { kind: "record", id: `${id}:chunk:1` }); asShipped();
  forgetMemory(ticket(), { kind: "source", id }); asShipped();
  expect(jobs().map(entry => entry.job.phases[0])).toEqual(["supporting", "supporting", "imports"]);
  expect(keyedRevisions(id)).toEqual(range(8, 71));
  const { pass } = await passOf();
  // a kill is the file and its log as they are on disk at that instant: copied at every step of the pass, one job to a commit
  const images: string[] = [];
  if (pass) {
    pass.jobsPerCommit = 1;
    pass.step = at => {
      const dir = join(DATA_DIR, `killed-${images.length}-${at}`);
      mkdirSync(dir);
      for (const file of FILES) if (existsSync(join(DATA_DIR, file))) copyFileSync(join(DATA_DIR, file), join(dir, file));
      images.push(dir);
    };
  }
  openAgain();
  if (pass) pass.step = null;
  // (on a tree without the pass there is no step and no key: the hole)
  expect(keyedRevisions(id)).toEqual(range(1, 71));
  // 3 jobs, each: begun, keys written, row marked, committed
  expect(images.map(dir => dir.replace(/.*killed-\d+-/, ""))).toEqual(Array.from({ length: 3 }, () => ["begin", "keys", "marked", "commit"]).flat());
  const whole = state();
  expect(pass!.last).toMatchObject({ jobs: 3, commits: 3 });
  // an open after the pass: nothing is found, nothing is written
  openAgain();
  expect(pass!.last).toMatchObject({ jobs: 0, commits: 0, keys: 0 });
  expect(state()).toBe(whole);
  const progress: number[] = [];
  for (const dir of images) {
    closeDatabase();
    for (const file of [...FILES, "messages.db-shm"]) rmSync(join(DATA_DIR, file), { force: true });
    for (const file of FILES) if (existsSync(join(dir, file))) copyFileSync(join(dir, file), join(DATA_DIR, file));
    database();
    progress.push(pass!.last!.jobs);
    expect(state(), dir).toBe(whole);
  }
  // each image held the commits before it and nothing of the step it was killed in: the restart did exactly the jobs left
  expect(progress).toEqual([3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 0]);
}, 240_000);

it("L4 a queue the size of the owner's (2,376 queued jobs, every one a Forget of an older build that owes 7 revisions): one read of the queue by its index, a bounded number of commits, and the next open reads the queue and writes nothing", async () => {
  const { id } = longNotebook();
  busy();
  forgetMemory(ticket(), { kind: "record", id: `${id}:chunk:0` }); asShipped();
  const [queued] = jobs();
  // the same queued Forget 2,376 times over (each row its own job id), between 2,376 jobs that are no Forget (a records revocation)
  const QUEUE = 2376, db = database();
  db.exec("BEGIN");
  const clone = db.prepare("INSERT INTO memory_scope_bindings SELECT 'memory-revocation:'||?1,scope_id,subject_type,subject_id,revision,state,json_set(intent,'$.id',?1) FROM memory_scope_bindings WHERE id=?2");
  const other = db.prepare("INSERT INTO memory_scope_bindings SELECT 'memory-revocation:'||?1,scope_id,subject_type,subject_id,revision,state,?2 FROM memory_scope_bindings WHERE id=?3");
  for (let i = 1; i < QUEUE; i++) clone.run(`legacy-${i}`, queued!.row);
  for (let i = 0; i < QUEUE; i++) other.run(`refs-${i}`, JSON.stringify({ v: 2, id: `refs-${i}`, phases: ["refs", "done"], c: null, via: 0, cause: "archive" }), queued!.row);
  db.exec("COMMIT");
  expect(jobsOwed()).toBe(2 * QUEUE);
  const before = count("SELECT count(*) AS n FROM memory_tombstones");
  const { pass, queueSql } = await passOf();
  const t0 = performance.now();
  openAgain();
  const openMs = performance.now() - t0;
  expect(keyedRevisions(id)).toEqual(range(1, 71));
  expect(pass!.last).toMatchObject({ jobs: QUEUE, commits: Math.ceil(QUEUE / 256) });
  // what it wrote: per job the import key of each of the record's 71 revisions; the 7 source keys owed are written once (unique)
  expect(count("SELECT count(*) AS n FROM memory_tombstones") - before).toBe(QUEUE * 71 + 7);
  // (the pass's own figure also counts the rows the source keys' triggers wrote)
  expect(pass!.last!.keys).toBeGreaterThanOrEqual(QUEUE * 71 + 7);
  expect(pass!.last!.keys).toBeLessThanOrEqual(QUEUE * 71 + 2 * 7);
  console.log(`LEGACY-PASS-BOUND jobs=${QUEUE} (+${QUEUE} other) keys=${pass!.last!.keys} commits=${pass!.last!.commits} pass=${Math.round(pass!.last!.ms)}ms open=${Math.round(openMs)}ms`);
  // generous for a loaded shared box; the figure measured is in the line above
  expect(pass!.last!.ms).toBeLessThan(60_000);
  // the queue is read through the job rows' index, never a scan of the bindings table
  const plan = all(`EXPLAIN QUERY PLAN ${queueSql}`).map(row => String(row.detail)).join(" | ");
  expect(plan).toContain("memory_bindings_subject");
  expect(plan).not.toMatch(/SCAN (memory_scope_bindings|b)\b/);
  // every job is still queued (the pass runs none), none is a Forget that owes a key, and the next open finds that with one read
  expect(jobsOwed()).toBe(2 * QUEUE);
  const t1 = performance.now();
  openAgain();
  console.log(`LEGACY-PASS-BOUND second open: pass=${pass!.last!.ms.toFixed(1)}ms open=${Math.round(performance.now() - t1)}ms`);
  expect(pass!.last).toMatchObject({ jobs: 0, commits: 0, keys: 0 });
}, 240_000);

it("L5 the runner afterwards: the queued jobs the open keyed run to their end as before (a source's imports phase, its late-copy window and hold; a record's supporting phase), and write no key again", () => {
  const { first, id } = longNotebook();
  busy();
  forgetMemory(ticket(), { kind: "source", id }); asShipped();
  // the older build's window: revision 1 is not keyed until its job runs, so the same words under another topic are admitted
  topicFile("late.md", first);
  expect(importTopic("late.md").imported).toBe(1);
  const late = sourceIdOf("late.md");
  forgetMemory(ticket(), { kind: "record", id: `${id}:chunk:0` }); asShipped();
  expect(jobs().map(entry => entry.job.phases[0])).toEqual(["imports", "supporting"]);
  expect(keyedRevisions(id)).toEqual(range(8, 71));
  openAgain();
  const keyed = jobs();
  // each row says its keys are written, and keeps everything else it had (cursor, late-copy mark, scope)
  expect(keyed.map(entry => [entry.job.imports?.keys ?? null, entry.job.record?.keys ?? null])).toEqual([[true, null], [null, true]]);
  expect(keyed[0]!.job.imports).toMatchObject({ id, below: 1 });
  expect(typeof keyed[0]!.job.imports.mark).toBe("number");
  expect(typeof keyed[0]!.job.imports.scope).toBe("string");
  expect(keyed[1]!.job.record.after).toHaveLength(4);
  // the late copy is refused at the open, by the key; it is not ended yet (that is the job's)
  expect(copyState(late)).toEqual(["withheld", "withheld"]);
  expect(String((database().prepare("SELECT state FROM memory_sources WHERE id=?").get(late) as Row).state)).not.toBe("deleted");
  const keys = count("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='import'");
  INLINE_REVOCATION.ms = inlineMs;
  runRevocationJobsNow(database());
  expect(jobsOwed()).toBe(0);
  // the imports phase found no key left to write and the supporting phase skips a key that is there
  expect(count("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='import'")).toBe(keys);
  expect(keyedRevisions(id)).toEqual(range(1, 71));
  // the source job's late-copy window step ended the late copy, as on the older build
  expect(String((database().prepare("SELECT state FROM memory_sources WHERE id=?").get(late) as Row).state)).toBe("deleted");
  expect(count("SELECT count(*) AS n FROM memory_tombstones WHERE target_type='source' AND target_id=? AND revision IS NULL", late)).toBe(1);
  expect(copyState(late)).toEqual(["withheld", "withheld"]);
  topicFile("again.md", first);
  expect(() => importTopic("again.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
}, 240_000);

// cause10 v2 r4 (ASTRA cbea3962df High, restore.ts:197): the installation restore carries the live file's deny keys onto the backup it
// restores, never its job rows. L1/L2 open the profile writable first (the pass keys the Forget there); here the restore comes BEFORE any
// writable open of this build (a read-only start, or the restore is the first thing done after the upgrade). A backup from before the
// Forget holds no job of it, so a key the older build left to the job was lost with the row, for good: the restore keys first
// (legacy-forget-keys.ts completeLegacyForgetsBeforeRestore, called by mergeDestinationMemoryDeletions before it reads the ledger).
/** The live file as on disk, read on its own read-only connection: the notebook revisions keyed and the queued jobs that owe keys. */
function liveFile(): { keys: number; owed: string[] } {
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  try {
    const keys = Number((db.prepare(`SELECT count(DISTINCT v.revision) AS n FROM memory_source_versions v JOIN memory_sources s ON s.id=v.source_id
      WHERE s.id=(SELECT id FROM memory_sources WHERE kind='legacy-import' ORDER BY rowid LIMIT 1)
      AND EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.target_type='import' AND t.target_id=s.scope_id AND t.content_hash=v.content_hash)`).get() as Row).n);
    const owed = (db.prepare(`SELECT id FROM memory_scope_bindings WHERE ${JOBS} AND (json_extract(intent,'$.record.keys') IS NULL AND json_extract(intent,'$.imports.keys') IS NULL) ORDER BY rowid`).all() as Row[]).map(row => String(row.id));
    return { keys, owed };
  } finally { db.close(); }
}
const candidateDir = () => { const dir = join(DATA_DIR, "restore-candidate"); mkdirSync(dir, { recursive: true }); return dir; };
/** The live file's ledger merged onto the backup (the call installation-restore.ts makes), the result restored in place (SQLite's
 * backup: connections of this process outlive closeDatabase, so a removed and copied file is not what the next open reads). */
async function restoreInPlace(candidate: string): Promise<void> {
  const merged = mergeDestinationMemoryDeletions(DATA_DIR, candidate);
  expect(merged.history).toBe("destination-ledger-preserved");
  const restored = new DatabaseSync(join(candidate, "messages.db"));
  try { await backup(restored, join(DATA_DIR, "messages.db")); } finally { restored.close(); }
  // the restore leaves memory paused; the owner turns it back on
  database().exec("UPDATE memory_meta SET mode='active'");
}

for (const kind of ["record", "source"] as const) it(`L6 (${kind}) a ${kind} Forget an older build left queued, then a backup from before it restored before any writable open of this build: the restored profile refuses the copy from before and its words, with no job of the Forget in it`, async () => {
  const { first, id } = longNotebook();
  topicFile("copy.md", first);
  expect(importTopic("copy.md").imported).toBe(1);
  const copy = sourceIdOf("copy.md");
  expect(copyState(copy)).toEqual(["shown", "shown"]);
  const candidate = candidateDir();
  await backup(database(), join(candidate, "messages.db"));
  busy();
  forgetMemory(ticket(), kind === "record" ? { kind: "record", id: `${id}:chunk:0` } : { kind: "source", id });
  asShipped();
  // the older build's state: one queued job that still owes the keys of revisions 1 to 7, which only its row names
  const [queued] = jobs();
  expect(jobs()).toHaveLength(1);
  expect(kind === "record" ? queued!.job.record.keys : queued!.job.imports.keys).toBeUndefined();
  expect(keyedRevisions(id)).toEqual(range(8, 71));
  // the process stops before the job runs (its runner would otherwise take a turn at the first await below); no open of this build
  // writes the file before the restore: on disk the job is queued unkeyed, revisions 1 to 7 unkeyed
  stopMemoryRevocation(); closeDatabase(); await stopWalMaintenance();
  expect(liveFile()).toEqual({ keys: 64, owed: [queued!.row] });
  await restoreInPlace(candidate);
  // the open read the restored file: no job of the Forget (the backup predates it), so what refuses below was carried by the merge
  expect(jobs().filter(entry => entry.row === queued!.row)).toEqual([]);
  expect(keyedRevisions(id)).toEqual(range(1, 71));
  expect(copyState(copy)).toEqual(["withheld", "withheld"]);
  topicFile("again.md", first);
  expect(() => importTopic("again.md")).toThrow("MEMORY_IMPORT_FORGOTTEN");
  // only what was forgotten: other words import
  topicFile("other.md", garden());
  expect(importTopic("other.md").imported).toBe(1);
}, 240_000);

it("L7 a restore that cannot finish keying an older build's queued Forget is refused with a clear error, before the backup is written, and the live file keeps the job for the next open", async () => {
  const { id } = longNotebook();
  const candidate = candidateDir();
  await backup(database(), join(candidate, "messages.db"));
  busy();
  forgetMemory(ticket(), { kind: "record", id: `${id}:chunk:0` });
  asShipped();
  const [queued] = jobs();
  stopMemoryRevocation(); closeDatabase(); await stopWalMaintenance();
  expect(liveFile()).toEqual({ keys: 64, owed: [queued!.row] });
  const ledgerOf = () => {
    const db = new DatabaseSync(join(candidate, "messages.db"), { readOnly: true });
    try { return JSON.stringify([db.prepare("SELECT count(*) AS n FROM memory_tombstones").get(), db.prepare("SELECT mode,deletion_epoch,policy_revision FROM memory_meta").get()]); }
    finally { db.close(); }
  };
  const before = ledgerOf();
  const { pass } = await passOf();
  // the pass fails on its first write (a full disk, a locked file)
  if (pass) pass.step = at => { if (at === "begin") throw new Error("disk I/O error"); };
  expect(() => mergeDestinationMemoryDeletions(DATA_DIR, candidate)).toThrow("RESTORE_LEGACY_FORGET_INCOMPLETE");
  if (pass) pass.step = null;
  // nothing of the backup was written
  expect(ledgerOf()).toBe(before);
  // the live file is as the older build left it (the pass rolled back): the next open keys it
  expect(liveFile()).toEqual({ keys: 64, owed: [queued!.row] });
  database();
  expect(jobs()).toHaveLength(1);
  expect(keyedRevisions(id)).toEqual(range(1, 71));
}, 240_000);
