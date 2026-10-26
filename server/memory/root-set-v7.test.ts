// Memory schema v7 (1.0.2): root sets grow linearly. A set may be its parent
// plus what it adds; the members, the content address and every verdict are
// the same as v6's full sets. A v6 file upgrades without rewriting anything,
// its sets are converted afterwards in bounded steps that survive a kill, and
// the space is handed back.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, DEFAULT_BUSY_MS, finishBackgroundUpgradeWorkNow } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { replayExclusions } from "./replay-lineage.ts";
import { COMPACTION_MAX_CHAIN, collectRootSets, compactRootSetsStep, finishLineageConversion, finishLineageStorageAtStartup, reclaimLineageSpace, lineageStorageStatus, maintainLineageStorage, type StartupStorageEvent } from "./root-set-compaction.ts";
import { downgradeMemorySchema, lineageRepairPending, MEMORY_SCHEMA_VERSION, migrateMemorySchema, repairOutputRootBackfill, rootSetMembers, storeRootSet, validateMemorySchema } from "./schema.ts";
import { fixtureReply, fixtureRoster, fixtureThread, longThreadsV5 } from "./testing/root-set-fixture.ts";
import { forceReadTimeJudgeForTest } from "./read-time-retired.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { legacyFile, v10Again } from "./testing/legacy-file-model.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
// 1.0.2 S6: the subject here is the retired root-set machinery (conversion, chains, proofs), which stays in the tree until its mechanical deletion, so
// the judge is kept deciding on the file (read-time-retired.ts forceReadTimeJudgeForTest); the write-time behaviour is covered by the lookups' own tests
thawBeforeEach(() => { thawRootSetWritesForTest(true); forceReadTimeJudgeForTest(true); });
thawAfterEach(() => { thawRootSetWritesForTest(false); forceReadTimeJudgeForTest(false); });

let copyDir: string;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); copyDir = mkdtempSync(join(tmpdir(), "murage-v7-")); });
afterEach(() => { closeDatabase(); removeTempDirSync(copyDir); });

const live = () => join(DATA_DIR, "messages.db");
/** Puts a file in place as the app's messages.db. */
function install(file: string) {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${live()}${suffix}`)) rmSync(`${live()}${suffix}`);
  copyFileSync(file, live());
}
/** Member rows of one thread whose sets grow by one root each (sizes 1..n) after the conversion: a set is cut onto its predecessor unless that
 * predecessor already sits on a chain of COMPACTION_MAX_CHAIN sets, in which case it stays full and the chain starts again. */
function convertedRows(n: number): number {
  let rows = 0, depth = 0;
  for (let size = 1; size <= n; size++) {
    if (size === 1 || depth >= COMPACTION_MAX_CHAIN) { rows += size; depth = 1; } else { rows += 1; depth++; }
  }
  return rows;
}
/** 1.0.2: a v10 file never repairs or converts root sets (the write-time backfill reads the receipts directly), so these tests, whose subject is that
 * retired machinery over the rows a 1.0.1 file held, take the certificate away on their connection (legacy-file-model.ts) and run it. A v6 file the
 * upgrade has just brought to v10 also has no conversion row (the upgrade writes none), so `startConversion` writes the one the v7 upgrade left. */
const startConversion = (db: DatabaseSync) => { legacyFile(db); db.exec("DELETE FROM memory_root_set_compaction"); db.prepare("INSERT INTO memory_root_set_compaction(id,total,done,cursor,started_at) VALUES(1,0,0,'',1)").run(); return db; };
const memberRows = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM memory_root_set_members").get()?.n);
/** Every stored set's members, as sorted text: what "the same sets" means. */
function everySet(db: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of db.prepare("SELECT set_id FROM memory_root_sets ORDER BY set_id").all()) {
    const members = rootSetMembers(db, String(row.set_id));
    out.set(String(row.set_id), members ? [...members].sort().join("|") : "UNPROVABLE");
  }
  return out;
}
const setOf = (db: DatabaseSync, thread: string, message: string) => String(db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?").get(thread, message)?.set_id ?? "");
const replies = (index: number, count: number) => Array.from({ length: count }, (_, reply) => ({ id: fixtureReply(index, reply), role: "bot" }));
/** A v6 file with full sets: the fixture upgraded, then taken back to v6 (which writes every set out in full). */
async function v6File(threads: number, count: number): Promise<string> {
  const file = await longThreadsV5(join(copyDir, "v5.db"), threads, count);
  const db = new DatabaseSync(file);
  try { migrateMemorySchema(db); legacyFile(db); repairOutputRootBackfill(db); v10Again(db); expect(downgradeMemorySchema(db, 6)).toMatchObject({ status: "downgraded", from: 13, to: 6 }); validateMemorySchema(db); }
  finally { db.close(); }
  return file;
}

it("a 400-reply thread upgrades to one row per root, reads back whole, and is withheld as a whole when its source goes", async () => {
  install(await longThreadsV5(join(copyDir, "v5.db"), 1, 400));
  const db = database();
  finishBackgroundUpgradeWorkNow();
  legacyFile(db); repairOutputRootBackfill(db); // what a 1.0.1 file's background repair left
  expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(MEMORY_SCHEMA_VERSION);
  // 399 sets, sizes 1 to 399: v6 stored 79,800 member rows, v7 one per root
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_root_sets").get()?.n)).toBe(399);
  expect(memberRows(db)).toBe(399);
  for (const reply of [1, 2, 200, 399]) {
    const members = rootSetMembers(db, setOf(db, fixtureThread(0), fixtureReply(0, reply)));
    expect(members?.size).toBe(reply);
    for (let before = 0; before < reply; before++) expect(members!.has(`${fixtureThread(0)}\u0000${fixtureReply(0, before)}`)).toBe(true);
  }
  expect([...replayExclusions(LineageAllowance.tool(1_000_000_000), fixtureThread(0), replies(0, 400), null, { failClosed: true })]).toEqual([]);
  reconcileMemoryRoster(fixtureRoster(1));
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src-0", revision: 1 });
  expect(replayExclusions(LineageAllowance.tool(1_000_000_000), fixtureThread(0), replies(0, 400), null, { failClosed: true }).size).toBe(400);
}, 120_000);

it("a chain that cannot be proven withholds everything resting on it (missing link, missing row)", async () => {
  install(await longThreadsV5(join(copyDir, "v5.db"), 1, 300));
  const db = database(), thread = fixtureThread(0);
  finishBackgroundUpgradeWorkNow();
  legacyFile(db); repairOutputRootBackfill(db);
  const withheld = () => replayExclusions(LineageAllowance.tool(1_000_000_000), thread, replies(0, 300), null, { failClosed: true });
  expect(withheld().size).toBe(0);
  // a member row of reply 250's set goes: 250 and every later reply rest on it
  const at250 = setOf(db, thread, fixtureReply(0, 250));
  db.prepare("DELETE FROM memory_root_set_members WHERE set_id=?1 AND root_message_id=(SELECT root_message_id FROM memory_root_set_members WHERE set_id=?1 LIMIT 1)").run(at250);
  expect(rootSetMembers(db, at250)).toBeNull();
  expect(new Set(withheld())).toEqual(new Set(replies(0, 300).slice(250).map(line => line.id)));
  // a set row in the middle goes: from reply 100 on
  db.prepare("DELETE FROM memory_root_sets WHERE set_id=?").run(setOf(db, thread, fixtureReply(0, 100)));
  expect(new Set(withheld())).toEqual(new Set(replies(0, 300).slice(100).map(line => line.id)));
  // a link that points up (a parent no smaller than its child) is a broken chain too
  const at50 = setOf(db, thread, fixtureReply(0, 50)), at60 = setOf(db, thread, fixtureReply(0, 60));
  db.prepare("UPDATE memory_root_set_parents SET parent_id=? WHERE set_id=?").run(at60, at50);
  expect(rootSetMembers(db, at50)).toBeNull();
  expect(withheld().has(fixtureReply(0, 50))).toBe(true);
  expect(withheld().has(fixtureReply(0, 49))).toBe(false);
}, 120_000);

it("a v6 file upgrades without rewriting its sets, then converts them in steps to the same members, linear, and reclaims the space", async () => {
  const file = await v6File(2, 150);
  install(file);
  const raw = new DatabaseSync(live());
  let before: Map<string, string>;
  try {
    before = everySet(raw);
    const fullRows = memberRows(raw);
    expect(fullRows).toBe(2 * (149 * 150) / 2);
    migrateMemorySchema(raw);
    startConversion(raw);
    // (the repair this v6 file's builder ran is undone: the file is as a 1.0.1 install left it, with its output-root repair still to do)
    raw.exec("DELETE FROM memory_scope_bindings WHERE id LIKE 'memory-lineage-backfill%'");
    // the upgrade itself writes no member row
    expect(memberRows(raw)).toBe(fullRows);
    expect(lineageStorageStatus(raw)).toMatchObject({ state: "converting", done: 0, percent: 0 }); // (the total is counted as the worklist fills, never up front)
    expect(everySet(raw)).toEqual(before);
    let steps = 0;
    for (;;) {
      const step = compactRootSetsStep(raw, { maxRows: 2000 });
      steps++;
      // a step stops at its budget: at most one set past it (no long write lock)
      expect(step.rows).toBeLessThanOrEqual(2000 + 2 * 150);
      // every step leaves every set provable and unchanged
      expect(everySet(raw)).toEqual(before);
      if (!step.remaining) break;
    }
    expect(steps).toBeGreaterThan(3);
    expect(memberRows(raw)).toBe(2 * convertedRows(149));
    // converted, the space not handed back yet: on offer to the owner (a rewrite of the file is their choice, never a start-up's)
    expect(lineageStorageStatus(raw)).toMatchObject({ state: "reclaim-available", percent: 100 });
    // nothing is collected while a lineage repair is unfinished (it may hold sets it has built and not pointed a reply at yet) ...
    expect(lineageRepairPending(raw)).toBe(true);
    expect(collectRootSets(raw)).toBe(0);
    repairOutputRootBackfill(raw);
    expect(lineageRepairPending(raw)).toBe(false);
    // ... and once it has finished, nothing pointed-at is collected; an unused set is
    expect(collectRootSets(raw)).toBe(0);
    const stray = storeRootSet(raw, ["t0-direct\u0000nowhere"]);
    expect(collectRootSets(raw)).toBe(1);
    expect(raw.prepare("SELECT 1 FROM memory_root_sets WHERE set_id=?").get(stray)).toBeUndefined();
    // the space goes back once, at start-up: not without room for the rewrite (said in plain words), then with it
    const freeBefore = lineageStorageStatus(raw).freeBytes;
    expect(freeBefore).toBeGreaterThan(0);
    expect(finishLineageStorageAtStartup(raw, { freeDiskBytes: () => 0, reclaimMinBytes: 1, reclaimFraction: 0 })).toEqual({ converted: false, vacuumed: false, skippedForDisk: true });
    const waiting = lineageStorageStatus(raw);
    expect(waiting).toMatchObject({ state: "waiting-for-disk", freeBytes: freeBefore });
    expect(waiting.message).toMatch(/free up some space/i);
    expect(waiting.message).not.toMatch(/safe|\u2014|composio/i);
    expect(finishLineageStorageAtStartup(raw, { freeDiskBytes: () => Number.MAX_SAFE_INTEGER, reclaimMinBytes: 1, reclaimFraction: 0 })).toMatchObject({ vacuumed: true });
    expect(lineageStorageStatus(raw)).toMatchObject({ state: "idle", freeBytes: 0 });
    expect(Number((raw.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum)).toBe(2);
    expect(everySet(raw)).toEqual(before);
    v10Again(raw);
    validateMemorySchema(raw);
  } finally { raw.close(); }
  // the same verdicts through the app's connection
  const db = database();
  finishBackgroundUpgradeWorkNow();
  expect(everySet(db)).toEqual(before!);
  expect([...replayExclusions(LineageAllowance.tool(1_000_000_000), fixtureThread(1), replies(1, 150), null, { failClosed: true })]).toEqual([]);
  reconcileMemoryRoster(fixtureRoster(2));
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src-1", revision: 1 });
  expect(replayExclusions(LineageAllowance.tool(1_000_000_000), fixtureThread(1), replies(1, 150), null, { failClosed: true }).size).toBe(150);
  expect([...replayExclusions(LineageAllowance.tool(1_000_000_000), fixtureThread(0), replies(0, 150), null, { failClosed: true })]).toEqual([]);
}, 180_000);

it("the conversion survives a kill: every set still proves the same, and the next run finishes it", async () => {
  const file = await v6File(2, 120);
  const db = new DatabaseSync(file);
  let before: Map<string, string>;
  // (the file is left a legacy one on disk, certificate away, for the child process; this connection restores it afterwards)
  before = everySet(db); migrateMemorySchema(db); startConversion(db); db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const child = spawn(process.execPath, [join(import.meta.dirname, "testing", "root-set-compact-child.ts"), file], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stderr.on("data", chunk => { errors += String(chunk); });
  const exited = new Promise<void>(resolve => child.on("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", chunk => { output += String(chunk); if ((output.match(/^step /gm) ?? []).length >= 3) { child.kill("SIGKILL"); resolve(); } });
    child.on("exit", () => (output.match(/^step /gm) ?? []).length >= 3 ? resolve() : reject(new Error(`child ended early: ${errors}`)));
  });
  await exited;
  expect(output).not.toContain("finished");
  const after = db;
  try {
    expect(everySet(after)).toEqual(before!);
    const status = lineageStorageStatus(after);
    expect(status.state).toBe("converting");
    expect(status.done).toBeGreaterThan(0);
    expect(memberRows(after)).toBeLessThan(2 * (119 * 120) / 2);
    while (compactRootSetsStep(after, { maxRows: 5000 }).remaining) { /* resume */ }
    expect(everySet(after)).toEqual(before!);
    expect(memberRows(after)).toBe(2 * convertedRows(119));
    expect(lineageStorageStatus(after).state).not.toBe("converting");
    v10Again(after);
    validateMemorySchema(after);
  } finally { after.close(); }
}, 180_000);

it("v7 goes back to v6 with every set written out in full, and up again", async () => {
  const file = await longThreadsV5(join(copyDir, "v5.db"), 1, 60);
  const db = new DatabaseSync(file);
  try {
    migrateMemorySchema(db);
    legacyFile(db); repairOutputRootBackfill(db); v10Again(db);
    const chained = everySet(db);
    expect(memberRows(db)).toBe(59);
    downgradeMemorySchema(db, 6);
    validateMemorySchema(db);
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_parents'").get()).toBeUndefined();
    expect(memberRows(db)).toBe((59 * 60) / 2);
    expect(everySet(db)).toEqual(chained);
    migrateMemorySchema(db);
    expect(everySet(db)).toEqual(chained);
  } finally { db.close(); }
}, 120_000);

it("opening a v6 file converts its sets before the app is handed the database, with progress counts", async () => {
  const file = await v6File(2, 100);
  const raw = new DatabaseSync(file);
  const events: StartupStorageEvent[] = [];
  try {
    const before = everySet(raw);
    migrateMemorySchema(raw);
    startConversion(raw);
    expect(finishLineageStorageAtStartup(raw, { sliceMs: 0, onProgress: event => events.push(event) }).converted).toBe(true);
    const counts = events.filter(event => event.phase === "converting").map(event => (event as { done: number }).done);
    expect(counts.length).toBeGreaterThan(1);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(events.filter(event => event.phase === "converting").at(-1)).toMatchObject({ phase: "converting", done: 198, total: 198 });
    expect(everySet(raw)).toEqual(before);
  } finally { raw.close(); }
  // and through the app's own open (database.ts): on v10 the open and the background job convert nothing (the upgrade writes no conversion row, and
  // the sets are reclaimed later by root-set-reclaim.ts), so the sets stay as the v6 file wrote them
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const second = await v6File(1, 80);
  install(second);
  expect(lineageStorageStatus(database()).state, "the open converts nothing").not.toBe("converting");
  finishBackgroundUpgradeWorkNow();
  expect(lineageStorageStatus(database()).state).not.toBe("converting");
  expect(memberRows(database())).toBe((79 * 80) / 2);
  expect(database().prepare("SELECT 1 FROM memory_root_set_compaction").get()).toBeUndefined();
}, 180_000);

it("background maintenance only takes short steps: unused sets in small batches, and a log copy that never takes the writer lock", async () => {
  const db = database();
  for (let index = 0; index < 120; index++) storeRootSet(db, [`t\u0000m${index}`]);
  expect(collectRootSets(db)).toBe(50);
  db.exec("CREATE TABLE IF NOT EXISTS filler(x)"); for (let index = 0; index < 200; index++) db.prepare("INSERT INTO filler VALUES(randomblob(4000))").run();
  // a reader holds a snapshot: the sweep neither waits for it nor stalls the app
  const reader = new DatabaseSync(live());
  try {
    reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM filler").get();
    const started = performance.now();
    await maintainLineageStorage({ database, idle: () => true, pauseMs: 0 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(Number((db.prepare("PRAGMA busy_timeout").get() as Record<string, number>).timeout)).toBe(DEFAULT_BUSY_MS); // the handle's own budget
    reader.exec("COMMIT");
  } finally { reader.close(); }
  const status = await maintainLineageStorage({ database, idle: () => true, pauseMs: 0 });
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_root_sets").get()?.n)).toBe(0);
  // the nudge leaves one page-1 frame behind, nothing more
  expect(status.walBytes).toBeLessThan(16 * 1024);
});

it("the app's connection keeps its write-ahead log short", async () => {
  const db = database();
  expect(Number((db.prepare("PRAGMA journal_size_limit").get() as Record<string, number>).journal_size_limit)).toBe(0);
  // the log is checkpointed by a worker thread once it is ready; until then (and if it fails) the connection does it at 1000 pages
  expect(Number((db.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, number>).wal_autocheckpoint)).toBe(1000);
  await vi.waitFor(() => expect(Number((db.prepare("PRAGMA wal_autocheckpoint").get() as Record<string, number>).wal_autocheckpoint)).toBe(0), { timeout: 10_000 });
  // a new file frees pages back in small steps
  expect(Number((db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum)).toBe(2);
});

it("v7 has no member index: a fresh file never builds it; an upgraded v6 file keeps it (dropping it blocked the server for minutes) until the owner's space hand-back", async () => {
  expect(database().prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeUndefined();
  const file = await v6File(1, 20);
  const db = new DatabaseSync(file);
  try {
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeTruthy();
    migrateMemorySchema(db);
    // the upgrade does not drop it (one statement over a multi-gigabyte index) and the structure check accepts exactly that definition
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeTruthy();
    validateMemorySchema(db);
    startConversion(db);
    finishLineageConversion(db);
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeTruthy();
    // the owner's hand-back drops it just before the VACUUM that returns its pages
    db.prepare("UPDATE memory_root_set_compaction SET reclaimed_at=NULL WHERE id=1").run();
    reclaimLineageSpace(db, { freeDiskBytes: () => 1e12 });
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeUndefined();
    v10Again(db);
    validateMemorySchema(db);
  } finally { db.close(); }
}, 120_000);

it("the v7 to v6 downgrade of a 1,200-set chain writes each set in turn, leaves every provable set whole and marks a broken link and everything resting on it", async () => {
  install(await longThreadsV5(join(copyDir, "v5.db"), 1, 1200));
  const db = database();
  finishBackgroundUpgradeWorkNow();
  legacyFile(db); repairOutputRootBackfill(db);
  const thread = fixtureThread(0), tail = (reply: number) => setOf(db, thread, fixtureReply(0, reply));
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_root_set_parents").get()?.n)).toBeGreaterThan(1000);
  // break one link in the middle of the chain: its own rows no longer add up
  const broken = tail(600);
  const row = db.prepare("SELECT root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id=? ORDER BY root_message_id LIMIT 1").get(broken)!;
  db.prepare("DELETE FROM memory_root_set_members WHERE set_id=? AND root_thread_id=? AND root_message_id=?").run(broken, row.root_thread_id, row.root_message_id);
  const before = everySet(db);
  expect(before.get(broken)).toBe("UNPROVABLE");
  const started = Date.now();
  v10Again(db);
  expect(downgradeMemorySchema(db, 6)).toMatchObject({ status: "downgraded", from: 13, to: 6 });
  expect(Date.now() - started).toBeLessThan(120_000);
  validateMemorySchema(db);
  // every set that was provable is now stored whole with exactly the same members
  const after = everySet(db);
  for (const [id, members] of before) if (members !== "UNPROVABLE") expect(after.get(id)).toBe(members);
  for (const row of db.prepare("SELECT set_id,size,(SELECT count(*) FROM memory_root_set_members m WHERE m.set_id=s.set_id) AS n FROM memory_root_sets s").all()) {
    if (before.get(String(row.set_id)) !== "UNPROVABLE") expect(Number(row.n)).toBe(Number(row.size));
  }
  // the broken link and what rests on it are withheld; earlier replies keep their sets
  expect(setOf(db, thread, fixtureReply(0, 600))).toBe("");
  expect(setOf(db, thread, fixtureReply(0, 1100))).toBe("");
  expect(setOf(db, thread, fixtureReply(0, 100))).not.toBe("");
  expect(setOf(db, thread, fixtureReply(0, 100))).toBe(tail(100));
}, 180_000);

it("r3 (v10): a v6 file upgraded to v10 has no conversion to budget: start-up leaves nothing unfinished, the idle sweep has nothing to carry on, and no hand-back is asked for", async () => {
  // 1.0.2: the upgrade writes no compaction row and root sets are never converted again (reclaimed later by root-set-reclaim.ts), so the budgeted
  // start-up conversion and its "finish after listen" step have nothing to do on a v10 file; the sets stay exactly as the v6 file wrote them.
  const file = await v6File(3, 100);
  const raw = new DatabaseSync(file);
  try {
    const before = everySet(raw);
    migrateMemorySchema(raw);
    expect(raw.prepare("SELECT 1 FROM memory_root_set_compaction").get()).toBeUndefined();
    const cut = finishLineageStorageAtStartup(raw, { sliceMs: 0, budgetMs: 0, freeDiskBytes: () => Number.MAX_SAFE_INTEGER, reclaimMinBytes: 1, reclaimFraction: 0 });
    expect(cut).toEqual({ converted: false, vacuumed: false, skippedForDisk: false });
    // the root sets are still in the file: the hand-back (root-set-reclaim.ts) waits for the write-time check of earlier memory
    expect(lineageStorageStatus(raw)).toMatchObject({ state: "waiting", reason: "checking" });
    await maintainLineageStorage({ database: () => raw, idle: () => true, pauseMs: 0 });
    // the root sets are still in the file: the hand-back (root-set-reclaim.ts) waits for the write-time check of earlier memory
    expect(lineageStorageStatus(raw)).toMatchObject({ state: "waiting", reason: "checking" });
    expect(everySet(raw)).toEqual(before);
    expect(memberRows(raw)).toBe(3 * (99 * 100) / 2);
    expect(finishLineageStorageAtStartup(raw, { freeDiskBytes: () => Number.MAX_SAFE_INTEGER, reclaimMinBytes: 1, reclaimFraction: 0, vacuumMaxBytes: 0 })).toEqual({ converted: false, vacuumed: false, skippedForDisk: false });
  } finally { raw.close(); }
}, 180_000);
