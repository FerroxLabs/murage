// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// No SQL replacement/mocked revoke. Run only on an authorized isolated host.
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { captureThreadDeletion } from "./capture.ts";
import {
  addTarget, advanceRevocationJob, createRevocationJob, INLINE_REVOCATION, memoryRevocationIdle, memoryRevocationStats,
  resetMemoryRevocationStats, revocationWorkPending, stopMemoryRevocation,
  wakeMemoryRevocation, type RevocationJob,
} from "./memory-revocation.ts";
import { resetRevokeWriteBudget } from "./revoke-budget.ts";
import { ensureRevokeLateObjects, migrateMemorySchema } from "./schema.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { FIRST_LSN } from "./lineage-types.ts";

const roots: string[] = [], connections: DatabaseSync[] = [];
const THREAD = "revocation-rewalk-108-thread", SOURCE = "revocation-rewalk-108-source";
const scalar = (db: DatabaseSync, sql: string) => Number(Object.values(db.prepare(sql).get()!)[0]);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function open(file: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly });
  connections.push(db);
  if (!readOnly) db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0");
  return db;
}
function close(db: DatabaseSync): void {
  db.close();
  connections.splice(connections.indexOf(db), 1);
}
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = fn(); db.exec("COMMIT"); return value; }
  catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
}
afterEach(() => {
  stopMemoryRevocation();
  vi.restoreAllMocks();
  for (const db of connections.splice(0).reverse()) db.close();
  for (const root of roots.splice(0)) removeTempDirSync(root);
});

/** Only freshly generated data is a copy source. No ambient data-dir/snapshot path accepted. */
function fixture(records: number, indexed = true) {
  stopMemoryRevocation(); resetMemoryRevocationStats(); resetRevokeWriteBudget();
  const root = mkdtempSync(join(tmpdir(), "murage-revocation-108-")); roots.push(root);
  const pristine = join(root, "pristine"); mkdirSync(pristine);
  const seed = open(join(pristine, "messages.db"));
  migrateMemorySchema(seed, "active"); ensureRevokeLateObjects(seed);
  const fx = new WritetimeFixture(seed);
  transaction(seed, () => {
    if (records > 0) fx.source(SOURCE, "s-room", { thread: THREAD, message: "m" });
    for (let i = 0; i < records; i++) {
      const id = `record-${String(i).padStart(6, "0")}`;
      fx.record(id, 1, "s-room", [SOURCE]);
      // A second span reaches the same version again without any cursor failure.
      seed.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,4,7)").run(id, SOURCE);
    }
    seed.prepare("UPDATE memory_late_build SET ready=? WHERE name='evidence'").run(indexed ? 1 : 0);
    seed.exec("UPDATE memory_late_build SET ready=1 WHERE name='origins'");
  });
  seed.exec("PRAGMA wal_checkpoint(TRUNCATE)"); close(seed);
  const copy = join(root, "run"); cpSync(pristine, copy, { recursive: true, errorOnExist: true, force: false });
  const file = join(copy, "messages.db"), db = open(file);
  return { db, file };
}

type Snapshot = { rows: number; recordUpdates: number; dataVersion: number; walBytes: number; frames: number; walGeneration: string | null };
/** Test-only filesystem reads: fixture WAL header bytes 12..23 (checkpoint sequence and both salts).
 * Excluded by attachment-read-gate's .test.ts rule; no product filesystem reader is introduced. */
function walGeneration(file: string, walBytes: number): string | null {
  if (walBytes === 0) return null;
  const fd = openSync(`${file}-wal`, "r");
  try {
    const header = Buffer.alloc(12);
    if (readSync(fd, header, 0, header.length, 12) !== header.length) throw new Error("Short WAL header");
    return header.toString("hex");
  } finally { closeSync(fd); }
}
/** No checkpoint while measuring: WAL growth then counts appended page images, not NAND writes. */
function meter(db: DatabaseSync, file: string) {
  expect(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
  const observer = open(file, true), pageSize = scalar(db, "PRAGMA page_size");
  let recordUpdates = 0;
  let previous: Snapshot | undefined;
  db.function("revocation_108_count_update", () => { recordUpdates++; return 0; });
  db.exec(`CREATE TEMP TRIGGER revocation_108_updates AFTER UPDATE ON main.memory_records
    BEGIN SELECT revocation_108_count_update(); END`);
  const snapshot = (): Snapshot => {
    const walBytes = existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0;
    const frames = walBytes === 0 ? 0 : (walBytes - 32) / (pageSize + 24);
    if (!Number.isInteger(frames) || frames < 0) throw new Error("Unaligned WAL measurement");
    const current = { rows: scalar(db, "SELECT total_changes()"), recordUpdates,
      dataVersion: scalar(observer, "PRAGMA data_version"), walBytes, frames, walGeneration: walGeneration(file, walBytes) };
    if (previous) delta(previous, current); // Check every snapshot, including a window that began with an empty WAL.
    previous = current;
    return current;
  };
  return { snapshot, pageSize };
}
function delta(before: Snapshot, after: Snapshot) {
  if (after.walBytes < before.walBytes) throw new Error("WAL reset invalidates measurement");
  if (before.walGeneration !== null && after.walGeneration !== before.walGeneration)
    throw new Error("WAL checkpoint sequence/salts changed; window invalid");
  return { rows: after.rows - before.rows, recordUpdates: after.recordUpdates - before.recordUpdates,
    observedDataVersionDelta: after.dataVersion - before.dataVersion,
    walBytes: after.walBytes - before.walBytes, frames: after.frames - before.frames };
}
function expectNoWrites(change: ReturnType<typeof delta>): void {
  expect(change).toEqual({ rows: 0, recordUpdates: 0, observedDataVersionDelta: 0, walBytes: 0, frames: 0 });
}
function queueState(db: DatabaseSync) {
  return {
    pending: revocationWorkPending(db),
    // Synthetic IDs only. A future sanitized-snapshot adapter must redact identities.
    jobs: db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation' AND state='granted' ORDER BY id").all(),
    stats: { ...memoryRevocationStats },
  };
}
async function drain(db: DatabaseSync, timeoutMs = 20_000): Promise<void> {
  wakeMemoryRevocation(() => db);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      memoryRevocationIdle(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Revoke did not drain: ${JSON.stringify(queueState(db))}`)), timeoutMs); }),
    ]);
    expect(revocationWorkPending(db)).toBe(false);
  } finally { if (timer) clearTimeout(timer); stopMemoryRevocation(); }
}

/** Bounded real job steps; JSON serialization exercises persisted cursor representation.
 * Deliberately retain targets (no done phase) to isolate repeated effects from queue bookkeeping. */
function expand(db: DatabaseSync, original: RevocationJob): RevocationJob {
  let job = original;
  for (let slice = 0; slice < 10_000; slice++) {
    const done = transaction(db, () => advanceRevocationJob(db, job, 17));
    job = JSON.parse(JSON.stringify(job)) as RevocationJob;
    if (done) return job;
  }
  throw new Error("Expand did not terminate in 10,000 bounded slices");
}

it.each([true, false])("second pass over an already-revoked set writes zero rows (indexed=%s)", indexed => {
  const { db, file } = fixture(65, indexed);
  const job: RevocationJob = { v: 2, id: "retained-targets", phases: ["expand"], c: null };
  transaction(db, () => {
    db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(SOURCE);
    db.exec(`UPDATE memory_records SET state='deleted',owner_pinned=1 WHERE id='record-000000';
      UPDATE memory_records SET state='deleted' WHERE id='record-000001';
      UPDATE memory_records SET state='deleted',text='' WHERE id='record-000002';
      INSERT INTO memory_projection_receipts VALUES('record-000000',1,1,'delete-pending','delete-pending',NULL);
      INSERT INTO memory_projection_receipts VALUES('record-000001',1,1,'deleted','deleted',NULL);
      INSERT INTO memory_projection_receipts VALUES('record-000002',1,1,'indexed','indexed',NULL)`);
    addTarget(db, job, "s", SOURCE);
  });
  const measured = meter(db, file), first = measured.snapshot();
  const completed = expand(db, job);
  expect(delta(first, measured.snapshot()).recordUpdates).toBeGreaterThan(0);
  expect(scalar(db, "SELECT count(*) FROM memory_records WHERE state!='deleted' OR owner_pinned!=0 OR text!=''")).toBe(0);
  // Revisit the SAME evidence and retained targets, not an empty completed job object.
  const before = measured.snapshot();
  expand(db, { ...completed, phases: ["expand"], c: null });
  const change = delta(before, measured.snapshot());
  console.log(JSON.stringify({ case: "second-expand", indexed, ...change }));
  expectNoWrites(change);
  expect(db.prepare("SELECT lexical_status,embedding_status FROM memory_projection_receipts ORDER BY record_id").all())
    .toEqual([
      { lexical_status: "delete-pending", embedding_status: "delete-pending" },
      { lexical_status: "deleted", embedding_status: "deleted" },
      { lexical_status: "delete-pending", embedding_status: "delete-pending" },
    ]);
  // A different job collects its own targets: exercise the SQL guard across jobs too.
  const overlapping: RevocationJob = { v: 2, id: "overlapping-job", phases: ["expand"], c: null };
  transaction(db, () => addTarget(db, overlapping, "s", SOURCE));
  const beforeOverlap = measured.snapshot();
  expand(db, overlapping);
  // Its new target rows are legitimate bookkeeping, but record updates are not.
  expect(delta(beforeOverlap, measured.snapshot()).recordUpdates).toBe(0);
});

it.each(["thread", "scope"] as const)("a retained %s pass leaves scrubbed payloads and scope text unchanged", phase => {
  const { db, file } = fixture(65);
  const job: RevocationJob = { v: 2, id: "placed-source", phases: [phase], c: null, thread: THREAD, scopes: ["s-room"] };
  const measured = meter(db, file);
  const completed = expand(db, job);
  expect(JSON.parse(String(db.prepare("SELECT payload FROM memory_source_versions WHERE source_id=?").get(SOURCE)!.payload)))
    .toEqual({ deleted: phase === "thread" ? "thread-deleted" : "bot-deleted" });
  const before = measured.snapshot();
  expand(db, { ...completed, phases: [phase], c: null });
  expectNoWrites(delta(before, measured.snapshot()));
});

it("rejects a checkpoint restart even when the WAL file does not shrink", () => {
  const { db, file } = fixture(0), measured = meter(db, file);
  const write = () => transaction(db, () => db.exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1 WHERE id=1"));
  write();
  const before = measured.snapshot();
  expect(db.prepare("PRAGMA wal_checkpoint(RESTART)").get()).toMatchObject({ busy: 0 });
  write();
  expect(statSync(`${file}-wal`).size).toBeGreaterThanOrEqual(before.walBytes);
  expect(() => measured.snapshot()).toThrow("checkpoint sequence/salts changed");
});

it("empty-queue baseline runner window writes zero rows and zero WAL frames", async () => {
  const { db, file } = fixture(65);
  await drain(db); // Finish late-index setup before the baseline, on either checkout.
  const measured = meter(db, file), before = measured.snapshot();
  await drain(db);
  expectNoWrites(delta(before, measured.snapshot()));
}, 50_000);

// MEMDEL-SIMPLIFY-109: the deny row and receipt are written with the cleanup job, and that job always runs to its end, so a replay while
// it is still owed adds nothing: the owed job finishes the walk.
it("a replay while the deletion's cleanup is still owed writes no second walk, and the owed job erases the words", async () => {
  const { db } = fixture(65);
  const inline = { ...INLINE_REVOCATION };
  INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0;
  try { transaction(db, () => captureThreadDeletion(db, THREAD)); } finally { Object.assign(INLINE_REVOCATION, inline); }
  const jobs = () => scalar(db, "SELECT count(*) FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'");
  expect(jobs()).toBe(1);
  const epoch = scalar(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1");
  transaction(db, () => captureThreadDeletion(db, THREAD));
  expect(scalar(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1")).toBe(epoch);
  expect(jobs()).toBe(1);
  await drain(db);
  expect(scalar(db, "SELECT count(*) FROM memory_records WHERE id LIKE 'record-%' AND (state!='deleted' OR text!='')")).toBe(0);
}, 50_000);

it("a deny without its write-time receipt still admits cleanup", async () => {
  const { db } = fixture(0);
  transaction(db, () => captureThreadDeletion(db, THREAD));
  await drain(db);
  db.prepare("DELETE FROM memory_deny_line WHERE thread_id=? AND lsn=? AND reason='delete-conversation'").run(THREAD, FIRST_LSN);
  const epoch = scalar(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1");
  transaction(db, () => captureThreadDeletion(db, THREAD));
  expect(scalar(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1")).toBe(epoch + 1);
  expect(db.prepare("SELECT 1 FROM memory_deny_line WHERE thread_id=? AND lsn=? AND reason='delete-conversation'").get(THREAD, FIRST_LSN)).toBeTruthy();
  await drain(db);
}, 50_000);

// MEMDEL-SIMPLIFY-109 (memdel r1 High #1): a cleanup this build cannot run as written (a phase it does not know, a row an older build
// parked, a format it cannot read) is never left unfinished. Across a restart, with the conversation's journal entry long gone and the
// deletion replayed by the boot reconcile, the runner alone erases its words, and the replay commits no second deletion.
const RECEIPT = "SELECT reason FROM memory_deny_line WHERE thread_id=? AND lsn=? ORDER BY revoke_id";
const ownJob = (db: DatabaseSync) => db.prepare(`SELECT id,state,intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'
  AND json_extract(intent,'$.thread')=?`).get(THREAD);
const jobRows = (db: DatabaseSync) => scalar(db, "SELECT count(*) FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'");
const stored = (db: DatabaseSync) => ({
  text: scalar(db, "SELECT count(*) FROM memory_records WHERE id LIKE 'record-%' AND text!=''"),
  indexed: scalar(db, "SELECT count(*) FROM memory_projection_receipts WHERE record_id LIKE 'record-%' AND lexical_status NOT IN ('delete-pending','deleted')"),
  payloads: scalar(db, `SELECT count(*) FROM memory_source_versions WHERE source_id='${SOURCE}' AND instr(payload,'words')>0`),
});
it.each(["unknown-phase", "parked-by-older-build", "unreadable"] as const)("a %s cleanup finishes after a restart with no second deletion", async how => {
  const { db, file } = fixture(65);
  db.exec("INSERT INTO memory_projection_receipts SELECT id,version,0,'indexed','indexed',NULL FROM memory_records WHERE id LIKE 'record-%'");
  const inline = { ...INLINE_REVOCATION };
  INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0;
  try { transaction(db, () => captureThreadDeletion(db, THREAD)); } finally { Object.assign(INLINE_REVOCATION, inline); }
  const job = ownJob(db)!;
  expect(job, "the first deletion's cleanup is still owed").toBeTruthy();
  expect(stored(db).text + stored(db).payloads).toBeGreaterThan(0);
  const intent = JSON.parse(String(job.intent)) as RevocationJob;
  if (how === "unknown-phase") db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify({ ...intent, phases: ["no-such-phase", ...intent.phases] }), String(job.id));
  else if (how === "parked-by-older-build") db.prepare("UPDATE memory_scope_bindings SET state='revoked',intent=? WHERE id=?")
    .run(JSON.stringify({ ...intent, phases: ["no-such-phase", ...intent.phases], failed: "unknown-phase:no-such-phase" }), String(job.id));
  else db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify({ v: 1, thread: THREAD }), String(job.id));
  // Restart: a new connection; the boot reconcile replays the deletion before the runner starts.
  close(db);
  const restarted = open(file);
  const epoch = scalar(restarted, "SELECT deletion_epoch FROM memory_meta WHERE id=1");
  transaction(restarted, () => captureThreadDeletion(restarted, THREAD));
  expect(scalar(restarted, "SELECT deletion_epoch FROM memory_meta WHERE id=1")).toBe(epoch);
  expect(jobRows(restarted)).toBe(1);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await drain(restarted);
  expect(warn.mock.calls.some(call => /unknown phase|unreadable/.test(String(call[0])))).toBe(true);
  expect(stored(restarted)).toEqual({ text: 0, indexed: 0, payloads: 0 });
  expect(scalar(restarted, "SELECT count(*) FROM memory_records WHERE id LIKE 'record-%' AND state!='deleted'")).toBe(0);
  expect(jobRows(restarted)).toBe(0);
  // The receipt still stands for the one deletion; another replay writes nothing and walks nothing.
  expect(restarted.prepare(RECEIPT).all(THREAD, FIRST_LSN).map(row => row.reason)).toEqual(["delete-conversation"]);
  transaction(restarted, () => captureThreadDeletion(restarted, THREAD));
  expect(scalar(restarted, "SELECT deletion_epoch FROM memory_meta WHERE id=1")).toBe(epoch);
  expect(jobRows(restarted)).toBe(0);
}, 50_000);

// memdel r2 High #1: the job's own targets are carried, not dropped with it. A deleted conversation's message ids are target rows written
// with the deletion (its messages go in the same transaction); a lesson resting only on a message no source was captured for is found
// through them alone, so a replacement walk of the thread cannot find it.
it.each(["unknown-phase", "unknown-phase-before-done", "unreadable"] as const)("a %s cleanup still expires a lesson resting only on a deleted message", async how => {
  const { db } = fixture(65);
  db.prepare("INSERT OR IGNORE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?1,'m',0,'user','text','words','{}'),(?1,'msg-only',0,'user','text','words','{}')").run(THREAD);
  db.prepare(`INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,evidence,created_at)
    VALUES('lesson-1',1,'bot-1','bot','note','lessonwords','typed','active','[{"messageId":"msg-only"}]',0)`).run();
  const inline = { ...INLINE_REVOCATION };
  INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0;
  try { transaction(db, () => { captureThreadDeletion(db, THREAD); db.prepare("DELETE FROM messages WHERE thread_id=?").run(THREAD); }); }
  finally { Object.assign(INLINE_REVOCATION, inline); }
  const job = ownJob(db)!;
  const intent = JSON.parse(String(job.intent)) as RevocationJob;
  expect(db.prepare("SELECT 1 FROM memory_revocation_targets WHERE job_id=? AND kind='m' AND id='msg-only'").get(intent.id)).toBeTruthy();
  const phases = how === "unknown-phase" ? ["no-such-phase", ...intent.phases] : how === "unknown-phase-before-done" ? ["no-such-phase", "done"] : null;
  db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(phases ? { ...intent, phases, c: null } : { v: 1, thread: THREAD }), String(job.id));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await drain(db);
  expect(db.prepare("SELECT state,text,evidence FROM memory_lessons WHERE id='lesson-1'").get()).toEqual({ state: "unsupported", text: "", evidence: null });
  expect(scalar(db, "SELECT count(*) FROM memory_records WHERE id LIKE 'record-%' AND text!=''")).toBe(0);
  expect(jobRows(db)).toBe(0);
  expect(scalar(db, "SELECT count(*) FROM memory_revocation_targets")).toBe(0);
}, 50_000);

it("an unreadable bot-deletion cleanup is replaced by this build's walk of the denied scope", async () => {
  const { db } = fixture(65);
  transaction(db, () => {
    db.prepare("INSERT OR IGNORE INTO memory_deny(kind,id,epoch,created_at) VALUES('scope','s-room',0,0)").run();
    db.prepare("INSERT INTO memory_scope_bindings VALUES('memory-revocation:future','s-room','system','memory-revocation',0,'granted',?)").run(JSON.stringify({ v: 9, scopes: ["s-room", "never-denied"] }));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await drain(db);
  expect(scalar(db, "SELECT count(*) FROM memory_records WHERE scope_id='s-room' AND text!=''")).toBe(0);
  expect(jobRows(db)).toBe(0);
}, 50_000);

it("an unknown-phase cleanup of another thread leaves this thread's finished receipt standing", async () => {
  const { db } = fixture(0);
  transaction(db, () => captureThreadDeletion(db, THREAD));
  await drain(db);
  transaction(db, () => createRevocationJob(db, { v: 2, id: "other", phases: ["no-such-phase" as never], c: null, thread: "another-thread" }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await drain(db);
  expect(db.prepare(RECEIPT).all(THREAD, FIRST_LSN).map(row => row.reason)).toEqual(["delete-conversation"]);
  const epoch = scalar(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1");
  transaction(db, () => captureThreadDeletion(db, THREAD));
  expect(scalar(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1")).toBe(epoch);
}, 50_000);

it.each([0, 65])("re-delete an already-cleaned thread on start writes zero rows and zero WAL frames (records=%s)", async records => {
  const { db, file } = fixture(records);
  // The no-source path must also skip includeRevoked's otherwise unconditional disclosure UPDATE.
  db.prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,
    record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    VALUES('old-disclosure',?,'fixture','session','[]','[]','[]',0,0,0,'revoked',0)`).run(THREAD);
  transaction(db, () => captureThreadDeletion(db, THREAD));
  await drain(db);
  expect(scalar(db, "SELECT count(*) FROM memory_records WHERE state!='deleted' OR text!=''")).toBe(0);
  close(db);
  const restarted = open(file), measured = meter(restarted, file);
  const baseline = measured.snapshot();
  await drain(restarted);
  expectNoWrites(delta(baseline, measured.snapshot()));
  const before = measured.snapshot();
  // Boot reconciliation calls this once per pending thread per start.
  transaction(restarted, () => captureThreadDeletion(restarted, THREAD));
  expect(revocationWorkPending(restarted)).toBe(false);
  await drain(restarted);
  const change = delta(before, measured.snapshot());
  console.log(JSON.stringify({ case: "second-deletion-on-start", ...change, queue: queueState(restarted) }));
  expectNoWrites(change);
}, 50_000);

/** Real-minute measurements are opt-in; failures to drain have a fixed deadline.
 * Run unchanged on baseline/candidate in SEPARATE Vitest processes. No acceptance is inferred here. */
it.skipIf(process.env.REVOCATION_108_MEASURE !== "1")("minute measurements on a copy of a pristine data directory", async () => {
  const { db, file } = fixture(4_800);
  await drain(db); // Exclude unrelated late-index setup from all windows, including baseline.
  const measured = meter(db, file);
  async function window(name: string, start: () => void, pulse: () => void) {
    const started = performance.now(), before = measured.snapshot();
    let previous = before, observedDataVersionDelta = 0;
    start();
    const initialQueue = queueState(db);
    const samples: Array<{ elapsedMs: number; rows: number; walBytes: number; frames: number; queue: ReturnType<typeof queueState> }> = [];
    while (performance.now() - started < 60_000) {
      await delay(Math.min(1_000, Math.max(1, 60_000 - (performance.now() - started))));
      const current = measured.snapshot();
      observedDataVersionDelta += current.dataVersion - previous.dataVersion;
      const change = delta(before, current);
      samples.push({ elapsedMs: performance.now() - started, rows: change.rows, walBytes: change.walBytes, frames: change.frames, queue: queueState(db) });
      previous = current;
      if (performance.now() - started < 60_000) pulse();
    }
    const elapsedMs = performance.now() - started, change = delta(before, measured.snapshot());
    console.log(JSON.stringify({ case: name, sqlite: db.prepare("SELECT sqlite_version() AS version").get(),
      elapsedMs, pageSize: measured.pageSize, ...change, observedDataVersionDelta,
      rowsPerMinute: change.rows * 60_000 / elapsedMs, framesPerMinute: change.frames * 60_000 / elapsedMs,
      walBytesPerMinute: change.walBytes * 60_000 / elapsedMs,
      pageImageBytesPerMinute: change.frames * measured.pageSize * 60_000 / elapsedMs,
      initialQueue, queue: queueState(db), samples }));
    return change;
  }
  const wake = () => wakeMemoryRevocation(() => db);
  expectNoWrites(await window("empty-queue-baseline", wake, wake));
  const start = () => {
    stopMemoryRevocation();
    transaction(db, () => captureThreadDeletion(db, THREAD));
    wake();
  };
  await window("initial-deletion", start, () => {});
  // Keep draining within a fixed deadline before defining a completed-repeat window.
  await drain(db, 120_000);
  await window("completed-repeat-on-one-start", start, () => {});
  await drain(db, 120_000);
  expectNoWrites(await window("empty-queue", wake, wake));
  await drain(db);
}, 480_000);
