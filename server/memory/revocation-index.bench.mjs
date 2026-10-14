// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Disk-backed upgrade benchmark for the v8 revocation index: a v7 messages.db
// with RECEIPTS receipts (default 500,000; 70% live; 5 record and 3 source
// citations each) is written to a temporary folder, then a fresh process opens
// it the way server/database.ts does (WAL, synchronous=FULL, secure_delete,
// in-memory temp store) and runs the upgrade: migrateMemorySchema, then the
// start-up backfill when this tree has one. Prints one JSON line with the
// times and the upgrade process's peak RSS. Not a test; run by hand:
//   node server/memory/revocation-index.bench.mjs [receipts]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const role = process.env.REVOKE_BENCH_ROLE;
const file = process.env.REVOKE_BENCH_FILE;
const schemaUrl = pathToFileURL(join(here, "schema.ts")).href;
const PRAGMAS = "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;";

if (role === "seed") {
  const { DatabaseSync } = await import("node:sqlite");
  const { migrateMemorySchema, downgradeMemorySchema } = await import(schemaUrl);
  const receipts = Number(process.env.REVOKE_BENCH_RECEIPTS);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA auto_vacuum=INCREMENTAL;" + PRAGMAS);
  migrateMemorySchema(db, "active");
  downgradeMemorySchema(db, 7); // the file a 1.0.2 build before the index wrote
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0)");
  db.exec("BEGIN");
  const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,'w','fact','x','owner-statement','active',0,0)");
  for (let i = 0; i < 20000; i++) record.run(`rec-${i}`);
  const source = db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,'w','t','m',1,'h','message','owner','ok','active')");
  const version = db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'h','{}',0)");
  for (let i = 0; i < 10000; i++) { source.run(`src-${i}`); version.run(`src-${i}`); }
  let a = 42; // mulberry32
  const rand = n => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return Math.floor(((t ^ (t >>> 14)) >>> 0) / 4294967296 * n); };
  const insert = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'driver',?,?,0,0,0,?,0)");
  for (let i = 0; i < receipts; i++) {
    insert.run(`${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")}-bundle-${i}`, `thread-${rand(2000)}`,
      JSON.stringify(Array.from({ length: 5 }, () => ({ id: `rec-${rand(20000)}`, version: 1 }))),
      JSON.stringify(Array.from({ length: 3 }, () => ({ id: `src-${rand(10000)}`, revision: 1 }))), rand(10) < 7 ? "delivered" : "revoked");
  }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
} else if (role === "upgrade") {
  const { DatabaseSync } = await import("node:sqlite");
  const { migrateMemorySchema } = await import(schemaUrl);
  let finish = null, start = null;
  try { ({ finishRevocationIndexAtStartup: finish } = await import(pathToFileURL(join(here, "revocation-index.ts")).href));   start = (await import(pathToFileURL(join(here, "revocation-index.ts")).href)).startRevocationIndexBackfill ?? null;
  } catch { /* a tree without the start-up backfill */ }
  const db = new DatabaseSync(file);
  db.exec(PRAGMAS);
  const t0 = performance.now();
  migrateMemorySchema(db, "off");
  const t1 = performance.now();
  let events = 0, lagMax = 0, last = performance.now();
  // a 1 ms ticker measures the longest stretch the event loop was held (the stand-in for "time to listen" and request latency)
  const lag = setInterval(() => { const now = performance.now(); lagMax = Math.max(lagMax, now - last - 1); if (inBuild) lagBuild = Math.max(lagBuild, now - last - 1); last = now; }, 1);
  let stats = null, lockMs = null;
    let writeMax = 0, writes = 0, writeFails = 0;
  db.exec("CREATE TABLE IF NOT EXISTS bench_writes(x)");
  // REVOKE_BENCH_WRITE=1: one write attempted 300 ms into the lookup build (a write is synchronous, so its wait is also a loop block);
  // unset: no write, so longestLoopBlockMs is the build's own cost to the event loop
  const probe = () => {
    const w0 = performance.now();
    try { db.exec("BEGIN IMMEDIATE"); db.exec("INSERT INTO bench_writes VALUES(1)"); db.exec("COMMIT"); writes++; }
    catch { writeFails++; try { db.exec("ROLLBACK"); } catch { /* none open */ } }
    writeMax = Math.max(writeMax, performance.now() - w0);
  };
  let inBuild = false, lagBuild = 0;
  const holdWriters = on => { inBuild = on; db.exec(`PRAGMA busy_timeout=${on ? 8000 : 1000}`); if (on && process.env.REVOKE_BENCH_WRITE) setTimeout(probe, 300); };
  const tListen = performance.now(); // the server would listen here: nothing above waits on the backfill
  if (start) { inBuild = true; const run = start(db, {}); const r = await run.done; inBuild = false; stats = run.stats; lockMs = 0; }
  else if (finish) finish(db, { onProgress: () => { events++; } });
  await new Promise(res => setTimeout(res, 10)); // let the ticker see a block that ended the run
  clearInterval(lag);
  const t2 = performance.now();
  const refs = Number(db.prepare("SELECT count(*) AS n FROM memory_disclosure_refs").get().n);
  let ready = null;
  try { ready = Number(db.prepare("SELECT ready FROM memory_revocation_index_build").get().ready); } catch { /* no flag in this tree */ }
  db.close();
  process.stdout.write(JSON.stringify({ migrateMs: Math.round(t1 - t0), timeToListenMs: Math.round(tListen - t0), backfillMs: Math.round(t2 - tListen), slices: stats?.slices, maxSliceMs: stats && Math.round(stats.maxSliceMs), longestLoopBlockMs: Math.round(lagMax), loopMaxDuringLookupMs: Math.round(lagBuild), finalIndexLockMs: lockMs, lookup: stats?.lookup, writes, writeFails, longestWriteWaitMs: Math.round(writeMax), totalMs: Math.round(t2 - t0), refs, ready, progressEvents: events, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
} else {
  const receipts = Number(process.argv[2] ?? 500000);
  const dir = mkdtempSync(join(tmpdir(), "revoke-bench-"));
  try {
    const env = { ...process.env, REVOKE_BENCH_FILE: join(dir, "messages.db"), REVOKE_BENCH_RECEIPTS: String(receipts) };
    const self = fileURLToPath(import.meta.url);
    const s0 = performance.now();
    execFileSync(process.execPath, [self], { env: { ...env, REVOKE_BENCH_ROLE: "seed" }, stdio: ["ignore", "inherit", "inherit"] });
    const seedMs = Math.round(performance.now() - s0), v7Bytes = statSync(env.REVOKE_BENCH_FILE).size;
    const out = execFileSync(process.execPath, [self], { env: { ...env, REVOKE_BENCH_ROLE: "upgrade" }, stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 20 }).toString();
    console.log(`REVOKE_UPGRADE_BENCH ${JSON.stringify({ receipts, seedMs, v7MiB: Math.round(v7Bytes / 1048576), v8MiB: Math.round(statSync(env.REVOKE_BENCH_FILE).size / 1048576), ...JSON.parse(out) })}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
