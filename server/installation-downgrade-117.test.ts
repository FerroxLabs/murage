// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// memory-downgrade --to 13 is the step back to 1.0.17. One read-only preflight runs on every target before anything is written; only the
// removal steps depend on the target (handoffs/designs/PIPPERF-DOWNGRADE13-rule.md). Here, on a data folder opened by the real 1.0.18 open
// path: a phone call still in progress, or a hand-off held for the owner, refuses --to 13 before anything changes; an ended call is kept in
// place with a private copy beside the folder; the search index file is left as 1.0.17 has it; --to 12 and 13 report what they removed.
import { execFile } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { checkPhoneCallsForDowngrade, downgradeInstallationMemorySchema, preservePhoneCallsForDowngrade, removeDataDirNamesAfter102 } from "./installation-memory-downgrade.ts";
import { LEXICAL_AGE_SCHEMA } from "./memory/age-index.ts";
import { ftsProbeBoth, ftsSettled } from "./settle-copy.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../scripts/installation-recovery.ts", import.meta.url));
const roots: string[] = [];
const PRESERVED = ".murage-phone-calls-preserved-";
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(join(DATA_DIR, "config.json"), '{"profile":{"name":"Fixture"}}'); });
afterEach(() => { closeDatabase(); for (const path of roots.splice(0)) removeTempDirSync(path); });

/** Every file under `dir` with its bytes (a folder by its name), so "changes nothing" is checked byte for byte. */
function tree(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isDirectory()) { out[`${prefix}${name}/`] = "dir"; Object.assign(out, tree(path, `${prefix}${name}/`)); }
    else out[`${prefix}${name}`] = readFileSync(path).toString("hex");
  }
  return out;
}
const preservedSiblings = (dir: string) => readdirSync(dirname(dir)).filter(name => name.startsWith(PRESERVED)).sort();
const objectNames = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return (db.prepare("SELECT name FROM sqlite_schema WHERE substr(name,1,7)<>'sqlite_' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name); } finally { db.close(); }
};
/** closeDatabase() stops the WAL checkpointer without waiting (database.ts stopWalMaintenance): its connection leaves the file a moment later and takes
 * -wal and -shm with it. Wait until both have been absent for a stretch, so a byte-for-byte tree read is not racing it. */
async function quiesce(dir: string) {
  const names = ["messages.db-wal", "messages.db-shm"].map(name => join(dir, name));
  let quiet = 0;
  for (let waited = 0; quiet < 8 && waited < 10_000; waited += 40) {
    quiet = names.some(path => existsSync(path)) ? 0 : quiet + 1;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  expect(quiet, "messages.db-wal and -shm stayed absent").toBeGreaterThanOrEqual(8);
}
function phoneCalls(dir: string, status: string) {
  const calls = new DatabaseSync(join(dir, "phone-calls.db"));
  calls.exec(`CREATE TABLE phone_calls (status TEXT NOT NULL); INSERT INTO phone_calls VALUES ('${status}')`);
  calls.close();
}
/** A data folder as 1.0.18 leaves it: the real open path (its optional memory indexes made), with source stamps in it. */
function openedBy118() {
  const db = database();
  db.prepare(`INSERT INTO memory_source_lsn(source_id,revision,created_lsn) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<500)
    SELECT printf('s%06d',i),1,1000+i FROM n`).run();
  expect(db.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE name='memory_source_lsn_created'").get()).toEqual({ ok: 1 });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase();
}

it.each(["in_progress", "ringing", "scheduled", "uncertain"])("a phone call still %s refuses memory-downgrade --to 13 with PHONE_CALLS_PENDING and changes nothing", async status => {
  openedBy118();
  phoneCalls(DATA_DIR, status);
  await quiesce(DATA_DIR);
  const before = tree(DATA_DIR), siblings = preservedSiblings(DATA_DIR);
  expect(() => downgradeInstallationMemorySchema(DATA_DIR, 13)).toThrow(expect.objectContaining({ code: "PHONE_CALLS_PENDING" }));
  expect(tree(DATA_DIR)).toEqual(before);
  // no private copy was started either: the refusal comes before any write
  expect(preservedSiblings(DATA_DIR)).toEqual(siblings);
});

// once 1.0.1's step alone: now in the preflight of every target (rule note), so the step back to 1.0.17 refuses too, before any write
it("a hand-off held for the owner refuses memory-downgrade --to 13 with DOWNGRADE_HANDOFFS_HELD and changes nothing", async () => {
  openedBy118();
  const db = database();
  db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, submitted_at, started_at) VALUES('h1','t1','b2','b1','started',NULL,'{\"message\":\"m\",\"depth\":0,\"attempts\":0}','owner','k1',1,NULL)").run();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDatabase();
  phoneCalls(DATA_DIR, "ended");
  await quiesce(DATA_DIR);
  const before = tree(DATA_DIR), siblings = preservedSiblings(DATA_DIR);
  expect(() => downgradeInstallationMemorySchema(DATA_DIR, 13)).toThrow(expect.objectContaining({ code: "DOWNGRADE_HANDOFFS_HELD" }));
  expect(tree(DATA_DIR)).toEqual(before);
  // the phone copy comes after the preflight: a refusal starts none
  expect(preservedSiblings(DATA_DIR)).toEqual(siblings);
});

it("the real CLI --to 13 with every call ended: phone-calls.db stays in place, a private copy is kept beside the folder, and \"removed\" names only 1.0.18 objects", async () => {
  openedBy118();
  phoneCalls(DATA_DIR, "ended");
  const calls = readFileSync(join(DATA_DIR, "phone-calls.db"));
  // the search index file mid age-fill, as 1.0.17 also writes it (its age-index.ts has lexical_age and lexical_age_keys)
  const indexFile = join(DATA_DIR, "memory-index.db"), index = new DatabaseSync(indexFile);
  index.exec(LEXICAL_AGE_SCHEMA); index.exec("INSERT INTO lexical_age_keys VALUES('r1',1,1)"); index.close();
  const indexObjects = objectNames(indexFile);
  expect(indexObjects).toEqual(expect.arrayContaining(["lexical_age", "lexical_age_keys"]));
  const file = join(DATA_DIR, "messages.db"), objects = objectNames(file);
  const out = JSON.parse((await exec(process.execPath, [cli, "memory-downgrade", "--data-dir", DATA_DIR, "--to", "13"], { timeout: 60_000 })).stdout);
  expect(objectNames(indexFile)).toEqual(indexObjects);
  roots.push(out.phoneCallsPreservedAt);
  const after = objectNames(file);
  // the existing keys stay; "removed" is added: exactly what left, sorted
  expect(out).toEqual({ ok: true, operation: "memory-downgrade", status: "downgraded", from: 13, to: 13, phoneCallsPreservedAt: expect.any(String), removed: objects.filter(name => !after.includes(name)) });
  expect(out.removed).toContain("memory_source_lsn_created");
  for (const name of out.removed) expect(name).toMatch(/^(memory_source_lsn_created|memory_owner_.*|thread_summar.*|chats_.*|venue_posts.*|room_shares.*|speech_.*)$/);
  expect(after.filter(name => !objects.includes(name))).toEqual([]);
  expect(readFileSync(join(DATA_DIR, "phone-calls.db"))).toEqual(calls);
  expect(basename(out.phoneCallsPreservedAt).startsWith(PRESERVED)).toBe(true);
  expect(readFileSync(join(out.phoneCallsPreservedAt, "phone-calls.db"))).toEqual(calls);
  // the step back to 1.0.17 leaves the search index file as it is (1.0.17 has its objects)
  // a second run finds nothing more to remove (it keeps another private copy: registered for cleanup)
  const again = JSON.parse((await exec(process.execPath, [cli, "memory-downgrade", "--data-dir", DATA_DIR, "--to", "13"], { timeout: 60_000 })).stdout);
  roots.push(again.phoneCallsPreservedAt);
  expect(again).toMatchObject({ status: "already-v13", removed: [] });
}, 120_000);

it("the real CLI --to 12 reports the schema objects and the data-folder names it removed", async () => {
  openedBy118();
  phoneCalls(DATA_DIR, "ended");
  const copy = join(mkdtempSync(join(tmpdir(), "murage-down12-")), "data"); roots.push(dirname(copy));
  cpSync(DATA_DIR, copy, { recursive: true });
  const objects = objectNames(join(copy, "messages.db"));
  const out = JSON.parse((await exec(process.execPath, [cli, "memory-downgrade", "--data-dir", copy, "--to", "12"], { timeout: 60_000 })).stdout);
  roots.push(out.phoneCallsPreservedAt);
  const after = objectNames(join(copy, "messages.db"));
  expect(out).toMatchObject({ ok: true, operation: "memory-downgrade", status: "downgraded", from: 13, to: 12 });
  const gone = objects.filter(name => !after.includes(name));
  expect(gone.length).toBeGreaterThan(0);
  expect(out.removed.slice(0, gone.length)).toEqual(gone);
  const names = out.removed.slice(gone.length);
  expect(names).toContain("phone-calls.db");
  for (const name of names) expect(existsSync(join(copy, name)), name).toBe(false);
}, 120_000);


// ---- S1 (1): the preflight parses both phone revocation files with the readers that read them back, before any write ----
it.each(["phone-revocations.tombstone.json", "phone-ask-revocations.tombstone.json"])("an unreadable %s refuses --to 13 and --to 12 with PHONE_REVOCATIONS_UNREADABLE and changes nothing", async name => {
  openedBy118();
  phoneCalls(DATA_DIR, "ended");
  await quiesce(DATA_DIR);
  writeFileSync(join(DATA_DIR, name), "{ not a list");
  for (const to of [13, 12] as const) {
    const before = tree(DATA_DIR), siblings = preservedSiblings(DATA_DIR);
    expect(() => downgradeInstallationMemorySchema(DATA_DIR, to)).toThrow(expect.objectContaining({ code: "PHONE_REVOCATIONS_UNREADABLE" }));
    expect(tree(DATA_DIR)).toEqual(before);
    expect(preservedSiblings(DATA_DIR)).toEqual(siblings);
  }
});

it("the search-index preflight runs BOTH probes: a tombstone page does not hide an orphan question that cannot be answered", () => {
  const db = new DatabaseSync(":memory:");
  // a tombstone page is there, and the docsize table the orphan probe reads is not
  db.exec("CREATE TABLE messages_fts(x); CREATE TABLE messages_fts_data(id INTEGER, block BLOB)");
  db.prepare("INSERT INTO messages_fts_data VALUES(?, x'00')").run(9007199254740992n);
  expect(ftsSettled(db)).toBe("owed");
  expect(ftsProbeBoth(db)).toBe("unknown");
  db.close();
});

// ---- S1 (3)/(4): every step that leaves a file or a name runs before the stamp is lowered; a stop in any phase is finished by a rerun ----
const stampOf = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Number((db.prepare("SELECT schema_version AS v FROM memory_meta").get() as { v: number }).v); } finally { db.close(); }
};
/** Every schema object's SQL and every table's row count: a rerun must leave the same definitions and the same rows as an uninterrupted run. */
const schemaAndRows = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const objects = db.prepare("SELECT name, sql FROM sqlite_schema WHERE substr(name,1,7)<>'sqlite_' ORDER BY name").all() as Array<{ name: string; sql: string | null }>;
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND substr(name,1,7)<>'sqlite_' ORDER BY name").all() as Array<{ name: string }>;
    const rows = Object.fromEntries(tables.map(({ name }) => {
      try { return [name, Number((db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n)]; } catch { return [name, -1]; }
    }));
    return { objects, rows };
  } finally { db.close(); }
};
const shape = (dir: string) => ({
  detail: schemaAndRows(join(dir, "messages.db")),
  indexDetail: existsSync(join(dir, "memory-index.db")) ? schemaAndRows(join(dir, "memory-index.db")) : null,
  names: readdirSync(dir).filter(name => !name.endsWith("-wal") && !name.endsWith("-shm")).sort(),
  objects: objectNames(join(dir, "messages.db")),
  stamp: stampOf(join(dir, "messages.db")),
  index: existsSync(join(dir, "memory-index.db")) ? objectNames(join(dir, "memory-index.db")) : null,
});
/** A 1.0.18 folder with an ended phone call (a data-folder name that leaves) and the search index file with 1.0.18's age tables in it. */
function buildFolderWithIndexAndNames() {
  openedBy118();
  phoneCalls(DATA_DIR, "ended");
  const index = new DatabaseSync(join(DATA_DIR, "memory-index.db"));
  index.exec(LEXICAL_AGE_SCHEMA); index.exec("INSERT INTO lexical_age_keys VALUES('r1',1,1)"); index.close();
  // the live merge marker row (the last step leaves it out after the checkpoint)
  const marker = new DatabaseSync(join(DATA_DIR, "messages.db"));
  marker.exec("INSERT OR REPLACE INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_merge',0,0,0); PRAGMA wal_checkpoint(TRUNCATE)"); marker.close();
}
const cloneOfData = (): string => {
  const copy = join(mkdtempSync(join(tmpdir(), "murage-interrupt-")), "data"); roots.push(dirname(copy));
  cpSync(DATA_DIR, copy, { recursive: true });
  return copy;
};
const PHASES = ["optimized", "config-restored", "index-file-removed", "names-removed", "checkpointed", "marker-deleted"] as const;
it.each(PHASES)("a stop at %s leaves 1.0.17 refusing the folder only while the stamp is up, and a rerun ends exactly where an uninterrupted run ends", async point => {
  buildFolderWithIndexAndNames();
  await quiesce(DATA_DIR);
  const reference = cloneOfData();
  const uninterrupted = downgradeInstallationMemorySchema(reference, 12);
  if (uninterrupted.phoneCallsPreservedAt) roots.push(uninterrupted.phoneCallsPreservedAt);
  const done = shape(reference);
  expect(done.stamp).toBe(12);
  const dir = cloneOfData();
  let hit = false;
  expect(() => downgradeInstallationMemorySchema(dir, 12, { at: reached => { if (reached === point && !hit) { hit = true; throw new Error(`STOP_AT_${point}`); } } })).toThrow(`STOP_AT_${point}`);
  expect(hit).toBe(true);
  // the stamp is the last thing lowered: a stop before it keeps it up (names and index file may already be gone), so 1.0.17 refuses the folder
  if (point === "optimized" || point === "config-restored" || point === "index-file-removed" || point === "names-removed") expect(shape(dir).stamp).toBe(13);
  const rerun = downgradeInstallationMemorySchema(dir, 12);
  if (rerun.phoneCallsPreservedAt) roots.push(rerun.phoneCallsPreservedAt);
  expect(shape(dir)).toEqual(done);
});

it("a stop at any point while the phone history family is removed leaves a folder a re-run reads and finishes (main file leaves last)", () => {
  const files = ["phone-calls.db", "phone-calls.db-journal", "phone-calls.db-shm", "phone-calls.db-wal"];
  const base = mkdtempSync(join(tmpdir(), "pp-family-"));
  roots.push(base);
  const make = (name: string) => {
    const dir = join(base, name, "data");
    mkdirSync(dir, { recursive: true });
    const calls = new DatabaseSync(join(dir, "phone-calls.db"));
    calls.exec("CREATE TABLE phone_calls (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO phone_calls (status) VALUES ('ended')");
    calls.close();
    for (const name2 of files.slice(1)) writeFileSync(join(dir, name2), "");
    return dir;
  };
  const probeDir = make("order");
  const removed = removeDataDirNamesAfter102(probeDir, true).filter(name => files.includes(name));
  expect(removed).toHaveLength(4);
  expect(removed[removed.length - 1]).toBe("phone-calls.db");
  for (let cut = 1; cut < removed.length; cut += 1) {
    const dir = make("cut" + cut);
    for (const name of removed.slice(0, cut)) unlinkSync(join(dir, name));
    expect(() => checkPhoneCallsForDowngrade(dir), "after removing " + removed.slice(0, cut).join(",")).not.toThrow();
  }
});

/** A phone-calls.db whose log holds the committed "ended" update while the main file still says in_progress (the files are copied while the connection is open). */
function phoneDirWithLiveLog(base: string, name: string): { dir: string; holder: DatabaseSync } {
  const dir = join(base, name, "data");
  mkdirSync(dir, { recursive: true });
  const live = join(base, name, "live");
  mkdirSync(live, { recursive: true });
  const holder = new DatabaseSync(join(live, "phone-calls.db"));
  holder.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  holder.exec("CREATE TABLE phone_calls (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO phone_calls (status) VALUES ('in_progress')");
  holder.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  holder.exec("UPDATE phone_calls SET status='ended'");
  for (const file of ["phone-calls.db", "phone-calls.db-wal", "phone-calls.db-shm"]) copyFileSync(join(live, file), join(dir, file));
  expect(statSync(join(dir, "phone-calls.db-wal")).size).toBeGreaterThan(0);
  return { dir, holder };
}

it("a non-empty phone log holding the committed ended row: a stop at every removal point leaves a folder a re-run finishes", () => {
  const base = mkdtempSync(join(tmpdir(), "pp-walfam-"));
  roots.push(base);
  const order = ["phone-calls.db-journal", "phone-calls.db-shm", "phone-calls.db-wal", "phone-calls.db"];
  for (let cut = 0; cut <= order.length; cut += 1) {
    const { dir, holder } = phoneDirWithLiveLog(base, "cut" + cut);
    try {
      writeFileSync(join(dir, "phone-calls.db-journal"), "");
      const copy = preservePhoneCallsForDowngrade(dir)!;
      roots.push(copy);
      const kept = new DatabaseSync(join(copy, "phone-calls.db"));
      try { expect(kept.prepare("SELECT status FROM phone_calls").get()).toEqual({ status: "ended" }); } finally { kept.close(); }
      // the stop: the names the removal would already have taken
      for (const name of order.slice(0, cut)) rmSync(join(dir, name), { force: true });
      if (cut < order.length) {
        expect(() => checkPhoneCallsForDowngrade(dir), "stopped after " + order.slice(0, cut).join(",")).not.toThrow();
        removeDataDirNamesAfter102(dir);
        expect(existsSync(join(dir, "phone-calls.db"))).toBe(false);
      }
    } finally { holder.close(); }
  }
});

it("a phone log a reader keeps busy refuses the downgrade with nothing removed", () => {
  const base = mkdtempSync(join(tmpdir(), "pp-walbusy-"));
  roots.push(base);
  const { dir, holder } = phoneDirWithLiveLog(base, "busy");
  const reader = new DatabaseSync(join(dir, "phone-calls.db"));
  try {
    reader.exec("BEGIN; SELECT * FROM phone_calls");
    const writer = new DatabaseSync(join(dir, "phone-calls.db"));
    try { writer.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO phone_calls (status) VALUES ('ended')"); } finally { writer.close(); }
    const before = readdirSync(dir).sort();
    expect(() => removeDataDirNamesAfter102(dir)).toThrow("WAL_CHECKPOINT_INCOMPLETE");
    expect(readdirSync(dir).sort()).toEqual(before);
  } finally { try { reader.exec("ROLLBACK"); } catch {} reader.close(); holder.close(); }
});
