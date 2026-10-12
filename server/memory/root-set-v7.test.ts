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
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, DEFAULT_BUSY_MS } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { replayExclusions } from "./replay-lineage.ts";
import { collectRootSets, compactRootSetsStep, finishLineageStorageAtStartup, lineageStorageStatus, maintainLineageStorage, type StartupStorageEvent } from "./root-set-compaction.ts";
import { downgradeMemorySchema, MEMORY_SCHEMA_VERSION, migrateMemorySchema, rootSetMembers, storeRootSet, validateMemorySchema } from "./schema.ts";
import { fixtureReply, fixtureRoster, fixtureThread, longThreadsV5 } from "./testing/root-set-fixture.ts";

let copyDir: string;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); copyDir = mkdtempSync(join(tmpdir(), "murage-v7-")); });
afterEach(() => { closeDatabase(); rmSync(copyDir, { recursive: true, force: true }); });

const live = () => join(DATA_DIR, "messages.db");
/** Puts a file in place as the app's messages.db. */
function install(file: string) {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${live()}${suffix}`)) rmSync(`${live()}${suffix}`);
  copyFileSync(file, live());
}
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
  try { migrateMemorySchema(db); expect(downgradeMemorySchema(db, 6)).toMatchObject({ status: "downgraded", from: 8, to: 6 }); validateMemorySchema(db); }
  finally { db.close(); }
  return file;
}

it("a 400-reply thread upgrades to one row per root, reads back whole, and is withheld as a whole when its source goes", async () => {
  install(await longThreadsV5(join(copyDir, "v5.db"), 1, 400));
  const db = database();
  expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(MEMORY_SCHEMA_VERSION);
  // 399 sets, sizes 1 to 399: v6 stored 79,800 member rows, v7 one per root
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_root_sets").get()?.n)).toBe(399);
  expect(memberRows(db)).toBe(399);
  for (const reply of [1, 2, 200, 399]) {
    const members = rootSetMembers(db, setOf(db, fixtureThread(0), fixtureReply(0, reply)));
    expect(members?.size).toBe(reply);
    for (let before = 0; before < reply; before++) expect(members!.has(`${fixtureThread(0)}\u0000${fixtureReply(0, before)}`)).toBe(true);
  }
  expect([...replayExclusions(fixtureThread(0), replies(0, 400), null, { failClosed: true })]).toEqual([]);
  reconcileMemoryRoster(fixtureRoster(1));
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src-0", revision: 1 });
  expect(replayExclusions(fixtureThread(0), replies(0, 400), null, { failClosed: true }).size).toBe(400);
}, 120_000);

it("a chain that cannot be proven withholds everything resting on it (missing link, missing row)", async () => {
  install(await longThreadsV5(join(copyDir, "v5.db"), 1, 300));
  const db = database(), thread = fixtureThread(0);
  const withheld = () => replayExclusions(thread, replies(0, 300), null, { failClosed: true });
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
    // the upgrade itself writes no member row
    expect(memberRows(raw)).toBe(fullRows);
    expect(lineageStorageStatus(raw)).toMatchObject({ state: "converting", total: 298, done: 0, percent: 0 });
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
    expect(memberRows(raw)).toBe(298);
    // converted, the space not handed back yet
    expect(lineageStorageStatus(raw)).toMatchObject({ state: "waiting-for-disk", percent: 100 });
    // nothing pointed-at is collected; an unused set is
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
    validateMemorySchema(raw);
  } finally { raw.close(); }
  // the same verdicts through the app's connection
  const db = database();
  expect(everySet(db)).toEqual(before!);
  expect([...replayExclusions(fixtureThread(1), replies(1, 150), null, { failClosed: true })]).toEqual([]);
  reconcileMemoryRoster(fixtureRoster(2));
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src-1", revision: 1 });
  expect(replayExclusions(fixtureThread(1), replies(1, 150), null, { failClosed: true }).size).toBe(150);
  expect([...replayExclusions(fixtureThread(0), replies(0, 150), null, { failClosed: true })]).toEqual([]);
}, 180_000);

it("the conversion survives a kill: every set still proves the same, and the next run finishes it", async () => {
  const file = await v6File(2, 120);
  const db = new DatabaseSync(file);
  let before: Map<string, string>;
  try { before = everySet(db); migrateMemorySchema(db); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
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
  const after = new DatabaseSync(file);
  try {
    validateMemorySchema(after);
    expect(everySet(after)).toEqual(before!);
    const status = lineageStorageStatus(after);
    expect(status.state).toBe("converting");
    expect(status.done).toBeGreaterThan(0);
    expect(memberRows(after)).toBeLessThan(2 * (119 * 120) / 2);
    while (compactRootSetsStep(after, { maxRows: 5000 }).remaining) { /* resume */ }
    expect(everySet(after)).toEqual(before!);
    expect(memberRows(after)).toBe(2 * 119);
    expect(lineageStorageStatus(after).state).not.toBe("converting");
  } finally { after.close(); }
}, 180_000);

it("v7 goes back to v6 with every set written out in full, and up again", async () => {
  const file = await longThreadsV5(join(copyDir, "v5.db"), 1, 60);
  const db = new DatabaseSync(file);
  try {
    migrateMemorySchema(db);
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
    expect(finishLineageStorageAtStartup(raw, { sliceMs: 0, onProgress: event => events.push(event) }).converted).toBe(true);
    const counts = events.filter(event => event.phase === "converting").map(event => (event as { done: number }).done);
    expect(counts.length).toBeGreaterThan(1);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(events.at(-1)).toMatchObject({ phase: "converting", done: 198, total: 198 });
    expect(everySet(raw)).toEqual(before);
  } finally { raw.close(); }
  // and through the app's own open (database.ts): nothing left to convert once it returns
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  const second = await v6File(1, 80);
  install(second);
  expect(lineageStorageStatus(database()).state).not.toBe("converting");
  expect(memberRows(database())).toBe(79);
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

it("v7 has no member index: a fresh file never builds it, and an upgraded v6 file drops it", async () => {
  expect(database().prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeUndefined();
  const file = await v6File(1, 20);
  const db = new DatabaseSync(file);
  try {
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeTruthy();
    migrateMemorySchema(db);
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeUndefined();
    validateMemorySchema(db);
  } finally { db.close(); }
}, 120_000);

it("the v7 to v6 downgrade of a 1,200-set chain writes each set in turn, leaves every provable set whole and marks a broken link and everything resting on it", async () => {
  install(await longThreadsV5(join(copyDir, "v5.db"), 1, 1200));
  const db = database();
  const thread = fixtureThread(0), tail = (reply: number) => setOf(db, thread, fixtureReply(0, reply));
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_root_set_parents").get()?.n)).toBeGreaterThan(1000);
  // break one link in the middle of the chain: its own rows no longer add up
  const broken = tail(600);
  const row = db.prepare("SELECT root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id=? ORDER BY root_message_id LIMIT 1").get(broken)!;
  db.prepare("DELETE FROM memory_root_set_members WHERE set_id=? AND root_thread_id=? AND root_message_id=?").run(broken, row.root_thread_id, row.root_message_id);
  const before = everySet(db);
  expect(before.get(broken)).toBe("UNPROVABLE");
  const started = Date.now();
  expect(downgradeMemorySchema(db, 6)).toMatchObject({ status: "downgraded", from: 8, to: 6 });
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
