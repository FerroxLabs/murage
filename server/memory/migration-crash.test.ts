// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.62 memmigrate review: the v2 -> v4 upgrade of messages.db under a real
// process kill at each step and under a real full disk, checked against the
// invariants that matter to the owner:
//   - messages.db always opens, passes integrity_check, and is at v2 or v4;
//   - at v2 it still opens in 0.1.61 (its own validator, kept verbatim in testdata/);
//   - a pre-upgrade copy at its final name is always whole and at v2;
//   - the next start removes any `.partial` and finishes the upgrade.
// Kills run in a child process (temp data dir only). The full-disk cases need
// a small real filesystem: set MEMMIGRATE_TINY_FS to an empty tmpfs mount (the
// review ran them with `docker run --tmpfs /tiny:size=128m`); skipped otherwise.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { MEMORY_PRE_V3_SNAPSHOT, MEMORY_SCHEMA_V2, MemoryMigrationError, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { DEFAULT_MEMORY_LEARNING_V1 } from "./learning-policy.ts";
import { migrateMemorySchema as migrate0161 } from "./testdata/v0161-schema.ts";

const roots: string[] = [];
const open: DatabaseSync[] = [];
afterEach(() => {
  for (const db of open.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function connect(file: string) {
  const db = new DatabaseSync(file); open.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  return db;
}

/** A 0.1.61-shaped messages.db: chat rows plus memory v2 with disclosures (the backfill's work). */
function buildV2(root: string, { messages = 2000, disclosures = 2000, blob = 1000 } = {}) {
  const file = join(root, "messages.db");
  const db = connect(file);
  db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id))");
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${messages})
    INSERT INTO messages SELECT 'thread-'||(i%50),'m'||i,i,'user','text',hex(randomblob(${blob})),'{}' FROM n`);
  db.exec(MEMORY_SCHEMA_V2);
  db.prepare("INSERT INTO memory_meta VALUES(1,2,?,4,5,6,'active')").run(randomUUID());
  db.prepare("INSERT INTO memory_learning_config VALUES(1,3,?)").run(JSON.stringify({ ...DEFAULT_MEMORY_LEARNING_V1, reviewMode: false }));
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${disclosures})
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'b'||i,'thread-'||(i%50),'drv',NULL,'[]','[]','["m'||i||'-'||hex(randomblob(24))||'","n'||i||'-'||hex(randomblob(24))||'"]',0,0,5,'delivered',i FROM n`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close(); open.splice(open.indexOf(db), 1);
  return file;
}

const version = (db: DatabaseSync) => Number(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version);
const integrity = (db: DatabaseSync) => String(db.prepare("PRAGMA integrity_check").get()?.integrity_check);
const count = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) n FROM messages").get()?.n);

/** Every invariant a kill or a full disk must leave intact. Returns the version found. */
function assertWhole(root: string, messages: number): number {
  const db = connect(join(root, "messages.db"));
  expect(integrity(db)).toBe("ok");
  expect(count(db)).toBe(messages);
  const found = version(db);
  expect([2, 7]).toContain(found);
  if (found === 2) {
    expect(() => validateMemorySchema(db)).not.toThrow();
    expect(() => migrate0161(db)).not.toThrow(); // 0.1.61's own open path: validate, already v2, return
    expect(version(db)).toBe(2);
  }
  db.close(); open.splice(open.indexOf(db), 1);
  const snapshot = join(root, MEMORY_PRE_V3_SNAPSHOT);
  if (existsSync(snapshot)) {
    const copy = new DatabaseSync(snapshot, { readOnly: true }); open.push(copy);
    expect(integrity(copy)).toBe("ok");
    expect(version(copy)).toBe(2);
    expect(count(copy)).toBe(messages);
  }
  return found;
}

/** The next start: the real options database.ts passes, room on the disk. */
function restart(root: string) {
  const db = connect(join(root, "messages.db"));
  migrateMemorySchema(db, "off", { snapshotV2Path: join(root, MEMORY_PRE_V3_SNAPSHOT), freeBytes: () => 1024 ** 4 });
  expect(version(db)).toBe(7);
  db.close(); open.splice(open.indexOf(db), 1);
  expect(readdirSync(root).filter(name => name.endsWith(".partial"))).toEqual([]);
  assertWhole(root, countOf(root));
}
function countOf(root: string) { const db = new DatabaseSync(join(root, "messages.db"), { readOnly: true }); try { return count(db); } finally { db.close(); } }

const SCHEMA_URL = pathToFileURL(join(import.meta.dirname, "schema.ts")).href;
/** Runs one upgrade in a child process that kills itself (SIGKILL) at `step`. */
function childUpgrade(root: string, step: "after-copy-before-rename" | "mid-transaction" | "none", onLine?: (line: string, kill: () => void) => void) {
  const script = join(root, "child.mjs");
  writeFileSync(script, `
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
const { migrateMemorySchema } = await import(${JSON.stringify(SCHEMA_URL)});
const root = ${JSON.stringify(root)}; const step = ${JSON.stringify(step)};
const real = new DatabaseSync(join(root, "messages.db"));
real.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
const db = step !== "mid-transaction" ? real : new Proxy(real, { get(target, key) {
  if (key === "exec") return (sql) => { const out = target.exec(sql); if (/INSERT OR IGNORE INTO memory_disclosure_outputs/.test(sql)) process.kill(process.pid, "SIGKILL"); return out; };
  const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
const copy = step !== "after-copy-before-rename" ? undefined : (handle, target) => { handle.prepare("VACUUM INTO ?").run(target); process.kill(process.pid, "SIGKILL"); };
migrateMemorySchema(db, "off", { snapshotV2Path: join(root, ${JSON.stringify(MEMORY_PRE_V3_SNAPSHOT)}), freeBytes: () => 1024 ** 4, copy,
  onPhase: (event) => process.stdout.write("PHASE " + event.phase + "\\n") });
process.stdout.write("DONE\\n");
`);
  return new Promise<{ signal: NodeJS.Signals | null; out: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: root } });
    let out = ""; let err = "";
    const kill = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
    child.stdout.on("data", chunk => { out += chunk; for (const line of String(chunk).split("\n")) if (line) onLine?.(line, kill); });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      // Windows has no signals: process.kill(self, "SIGKILL") is TerminateProcess, seen as exit code 1 with no signal and no stderr.
      if (code && !signal && process.platform === "win32" && code === 1 && !err.trim()) { resolve({ signal: "SIGKILL", out }); return; }
      if (code && !signal) reject(new Error(`child failed ${code}: ${err}`)); else resolve({ signal, out });
    });
  });
}

function freshRoot() { const root = mkdtempSync(join(tmpdir(), "murage-memcrash-")); roots.push(root); return root; }

it("killed after the copy is whole but before its rename: the next start discards it and upgrades", async () => {
  const root = freshRoot(); buildV2(root);
  const run = await childUpgrade(root, "after-copy-before-rename");
  expect(run.signal).toBe("SIGKILL");
  expect(existsSync(join(root, `${MEMORY_PRE_V3_SNAPSHOT}.partial`))).toBe(true);
  expect(existsSync(join(root, MEMORY_PRE_V3_SNAPSHOT))).toBe(false);
  expect(assertWhole(root, 2000)).toBe(2);
  restart(root);
}, 60_000);

it("killed inside the upgrade transaction: messages.db reopens at v2 (and in 0.1.61), the kept copy is whole, the next start upgrades", async () => {
  const root = freshRoot(); buildV2(root);
  const run = await childUpgrade(root, "mid-transaction");
  expect(run.signal).toBe("SIGKILL");
  expect(run.out).toContain("PHASE migrating");
  expect(existsSync(join(root, MEMORY_PRE_V3_SNAPSHOT))).toBe(true);
  expect(assertWhole(root, 2000)).toBe(2);
  restart(root);
}, 60_000);

it("killed at arbitrary points of a real copy and upgrade: every outcome is whole and the next start finishes", async () => {
  const messages = 12000;
  const template = freshRoot(); buildV2(template, { messages, blob: 2000, disclosures: 20000 });
  for (const delay of [0, 2, 5, 10, 20, 40, 80, 160]) {
    const root = freshRoot();
    const { copyFileSync } = await import("node:fs");
    copyFileSync(join(template, "messages.db"), join(root, "messages.db"));
    await childUpgrade(root, "none", (line, kill) => { if (line === "PHASE copying") setTimeout(kill, delay); });
    assertWhole(root, messages);
    restart(root);
  }
}, 300_000);

const TINY = process.env.MEMMIGRATE_TINY_FS;
const tiny = TINY ? it : it.skip;
function tinyRoot() {
  const root = join(TINY!, `case-${randomUUID().slice(0, 8)}`); mkdirSync(root); roots.push(root); return root;
}
const free = (dir: string) => { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); };
/** Leaves about `leave` bytes free on the volume holding `dir`. */
function fill(dir: string, leave: number) {
  const filler = join(dir, "filler.bin");
  const size = Math.max(0, free(dir) - leave);
  writeFileSync(filler, Buffer.alloc(size));
  return () => rmSync(filler, { force: true });
}

tiny("real full disk: the preflight refuses before writing anything; a disk that lies about free space fails the copy cleanly", () => {
  const root = tinyRoot(); const file = buildV2(root, { messages: 3000, blob: 1500, disclosures: 2000 });
  const size = statSync(file).size;
  const unfill = fill(root, Math.floor(size / 2));
  // honest statfs: refused up front
  let caught: unknown;
  const db = connect(file);
  try { migrateMemorySchema(db, "off", { snapshotV2Path: join(root, MEMORY_PRE_V3_SNAPSHOT) }); } catch (error) { caught = error; }
  expect((caught as MemoryMigrationError).code).toBe("MEMORY_MIGRATION_DISK_SPACE");
  expect((caught as Error).message).toMatch(/Nothing has been changed/);
  expect(readdirSync(root).filter(name => name.startsWith("messages.pre"))).toEqual([]);
  // statfs unknown: the copy itself hits ENOSPC
  caught = undefined;
  try { migrateMemorySchema(db, "off", { snapshotV2Path: join(root, MEMORY_PRE_V3_SNAPSHOT), freeBytes: () => null }); } catch (error) { caught = error; }
  expect((caught as MemoryMigrationError).code).toBe("MEMORY_MIGRATION_DISK_SPACE");
  expect((caught as MemoryMigrationError).shortBytes).toBeGreaterThanOrEqual(1048576 * 8);
  db.close(); open.splice(open.indexOf(db), 1);
  expect(readdirSync(root).filter(name => name.startsWith("messages.pre"))).toEqual([]);
  expect(assertWhole(root, 3000)).toBe(2);
  unfill();
  const again = connect(file);
  migrateMemorySchema(again, "off", { snapshotV2Path: join(root, MEMORY_PRE_V3_SNAPSHOT), freeBytes: () => null });
  expect(version(again)).toBe(7);
  again.close(); open.splice(open.indexOf(again), 1);
  assertWhole(root, 3000);
}, 120_000);

tiny("real full disk inside the upgrade transaction: rolled back to a whole v2 file that 0.1.61 opens, space handed back, retry upgrades", () => {
  const root = tinyRoot(); const file = buildV2(root, { messages: 500, blob: 500, disclosures: 60000 });
  let unfill = () => {};
  const db = connect(file);
  let caught: unknown;
  try {
    migrateMemorySchema(db, "off", {
      snapshotV2Path: join(root, MEMORY_PRE_V3_SNAPSHOT), freeBytes: () => null,
      copy: (handle, target) => { handle.prepare("VACUUM INTO ?").run(target); unfill = fill(root, 256 * 1024); },
    });
  } catch (error) { caught = error; }
  expect((caught as MemoryMigrationError).code).toBe("MEMORY_MIGRATION_DISK_SPACE");
  expect(db.isTransaction).toBe(false);
  expect(version(db)).toBe(2);
  // The server child exits on this error without closing the database, so the
  // failed transaction's write-ahead log must not keep the space it took.
  const wal = join(root, "messages.db-wal");
  expect(existsSync(wal) ? statSync(wal).size : 0).toBeLessThan(1048576);
  db.close(); open.splice(open.indexOf(db), 1);
  expect(assertWhole(root, 500)).toBe(2);
  unfill();
  const again = connect(file);
  migrateMemorySchema(again, "off", { snapshotV2Path: join(root, MEMORY_PRE_V3_SNAPSHOT), freeBytes: () => null });
  expect(version(again)).toBe(7);
  again.close(); open.splice(open.indexOf(again), 1);
  assertWhole(root, 500);
}, 120_000);
