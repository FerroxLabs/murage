// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 revoke-bounded: forgetting must never freeze Murage on a heavy install (REVOKE.md). The index
// build survives a lock and reaches ready, a forget applies only its own targets (and ends the same
// receipts the installation-wide pass would), its cost does not grow with earlier tombstones or receipts,
// and with the index not ready it never scans: readers already treat the receipts as stale.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { bindMemoryDisclosureSession, continuationMemoryRevoked, deliverMemoryDisclosure, prepareMemoryDisclosure } from "./disclosures.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import { migrateMemorySchema } from "./schema.ts";
import { applyForgetTombstones, applyMemoryTombstones, type ForgetTargets } from "./restore.ts";
import { BUNDLE_PAGE_END, FLIP_SQL, citingSeekSql, lateBuildStep, memoryRevocationIdle, memoryRevocationStats, resetMemoryRevocationStats, stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { lockedError, startRevocationIndexBackfill } from "./revocation-index.ts";
import { revocationIndexReady } from "./revocation.ts";
import type { MemorySearchBridge } from "./search.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { stampFreshSession } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { settleTestHandles } from "../test-handle-registry.ts";
import { REVOKE_WRITE_BUDGET, resetRevokeWriteBudget } from "./revoke-budget.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
thawBeforeEach(() => thawRootSetWritesForTest(true));
thawAfterEach(() => thawRootSetWritesForTest(false));

const dbs: DatabaseSync[] = [];
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {}); });
beforeEach(() => resetMemoryRevocationStats());
// these bound each slice's rows and time; the per-minute write budget (revoke-budget.ts, 1.0.3 revoke storm M3) has its own tests
// (revoke-budget.test.ts), and 20k receipts inside it take many minutes by design
const BUDGET = REVOKE_WRITE_BUDGET.bytesPerMinute;
beforeEach(() => { REVOKE_WRITE_BUDGET.bytesPerMinute = Number.POSITIVE_INFINITY; resetRevokeWriteBudget(); });
afterEach(() => { REVOKE_WRITE_BUDGET.bytesPerMinute = BUDGET; resetRevokeWriteBudget(); });
afterEach(() => { stopMemoryRevocation(); vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });
/** Runs every job row of `db` to completion through the runner. */
async function drain(db: DatabaseSync | (() => DatabaseSync)) { wakeMemoryRevocation(typeof db === "function" ? db : () => db, { pauseMs: 1 }); await memoryRevocationIdle(); }
const jobRows = (db: DatabaseSync) => Number(db.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'").get()!.n);

function open(): DatabaseSync {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0)");
  return db;
}
const receipt = (db: DatabaseSync, id: string, records: Array<[string, number]>, sources: Array<[string, number]>, state = "delivered") =>
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'t','d',NULL,?,?,0,0,0,?,0)")
    .run(id, JSON.stringify(records.map(([i, version]) => ({ id: i, version }))), JSON.stringify(sources.map(([i, revision]) => ({ id: i, revision }))), state);

/** A small memory with earlier forgets already applied: ten records, six sources, evidence, a derivation chain, a copy brought in from s3, jobs, receipts. */
function world(): DatabaseSync {
  const db = open();
  for (let i = 0; i < 10; i++) db.prepare("INSERT INTO memory_records VALUES(?,1,'w','fact','x','owner-statement','active',1,1,NULL,NULL,1)").run(`r${i}`);
  db.prepare("INSERT INTO memory_records VALUES('bi1',1,'w','fact','x','assistant-inference','active',0,1,NULL,NULL,1)").run();
  const addSource = (id: string, kind: string, payload: string) => {
    db.prepare("INSERT INTO memory_sources VALUES(?,'w','t',?,NULL,1,'h',?,'owner','ok',NULL,'active')").run(id, `m-${id}`, kind);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'h',?,0)").run(id, payload);
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,cursor,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','pending',0,1,1)").run(`job-${id}`, id);
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,cursor,policy_revision,deletion_epoch,error) VALUES(?,?,1,'embed','1','cancelled',0,1,1,'parked:x')").run(`park-${id}`, id);
  };
  for (let i = 0; i < 6; i++) addSource(`s${i}`, "message", "{}");
  addSource("bring-in:g:k1", "bring-in", JSON.stringify({ text: "x", broughtFrom: { sources: [{ id: "s3", revision: 1 }] } }));
  for (let i = 0; i < 10; i++) db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,1)").run(`r${i}`, `s${i % 6}`);
  db.prepare("INSERT INTO memory_evidence VALUES('bi1',1,'bring-in:g:k1',1,0,1)").run();
  db.prepare("INSERT INTO memory_derivations VALUES('r3',1,'r4',1)").run();
  db.prepare("INSERT INTO memory_derivations VALUES('r2',1,'r3',1)").run();
  for (const id of ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "bi1"]) db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)").run(id);
  for (let i = 0; i < 400; i++) receipt(db, `b${i}`, [[`r${i % 10}`, 1]], [[`s${i % 6}`, 1], ...(i % 7 === 0 ? [["bring-in:g:k1", 1] as [string, number]] : []), ...(i % 11 === 0 ? [["s3", 2] as [string, number]] : [])], i % 13 === 0 ? "revoked" : "delivered");
  // an earlier forget, applied long ago
  db.prepare("INSERT INTO memory_tombstones VALUES('old1','source','s0',NULL,NULL,1,'owner-forget',0)").run();
  applyMemoryTombstones(db);
  return db;
}
const snapshot = (db: DatabaseSync) => JSON.stringify({
  records: db.prepare("SELECT id,version,state,owner_pinned FROM memory_records ORDER BY 1,2").all(),
  sources: db.prepare("SELECT id,state FROM memory_sources ORDER BY 1").all(),
  jobs: db.prepare("SELECT id,status,error,lease_generation FROM memory_jobs ORDER BY 1").all(),
  projection: db.prepare("SELECT record_id,lexical_status,embedding_status FROM memory_projection_receipts ORDER BY 1").all(),
  receipts: db.prepare("SELECT bundle_id,state FROM memory_disclosures ORDER BY 1").all(),
});
const cases: Array<[string, ForgetTargets, string[]]> = [
  ["a source", { sources: [{ id: "s3", revision: null }], records: [] }, ["INSERT INTO memory_tombstones VALUES('n1','source','s3',NULL,NULL,2,'owner-forget',0)"]],
  ["a record with its supporting source", { sources: [{ id: "s5", revision: 1 }], records: [{ id: "r5", revision: null }] },
    ["INSERT INTO memory_tombstones VALUES('n1','record','r5',NULL,NULL,2,'owner-forget',0)", "INSERT INTO memory_tombstones VALUES('n2','source','s5',1,NULL,2,'forgotten-supporting-source',0)"]],
  ["a record whose derived record also goes", { sources: [], records: [{ id: "r2", revision: 1 }] }, ["INSERT INTO memory_tombstones VALUES('n1','record','r2',1,NULL,2,'owner-forget',0)"]],
];

it.each(cases.flatMap(c => [true, false].map(ready => [...c, ready] as const)))("the forget step for %s ends exactly what the installation-wide pass ends (index ready: %s)", async (_name, targets, tombstones, ready) => {
  const global = world(), targeted = world();
  expect(snapshot(global)).toBe(snapshot(targeted));
  for (const sql of tombstones) { global.exec(sql); targeted.exec(sql); }
  applyMemoryTombstones(global);
  if (!ready) targeted.exec("UPDATE memory_revocation_index_build SET ready=0,cursor=NULL,done=0,finished_at=NULL");
  const before = targeted.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state='revoked'").get()!.n;
  // a tiny inline budget: the rest is a job row the runner finishes
  const ended = applyForgetTombstones(targeted, targets, { inline: { rows: 2, ms: 1000 } });
  expect(ended.pending).toBe(true);
  expect(jobRows(targeted)).toBe(1);
  if (!ready) expect(targeted.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state='revoked'").get()!.n).toBe(before);
  await drain(targeted);
  expect(jobRows(targeted)).toBe(0);
  expect(snapshot(targeted)).toBe(snapshot(global));
  expect(snapshot(global)).not.toBe(snapshot(world())); // the forget did something
});

it("the index build survives 'table is locked' from an open statement on its connection and reaches ready", async () => {
  const db = open();
  for (let i = 0; i < 300; i++) receipt(db, `b${i}`, [[`r${i % 10}`, 1]], [[`s${i % 6}`, 1]]);
  db.exec("UPDATE memory_revocation_index_build SET ready=0,cursor=NULL,done=0,finished_at=NULL");
  const held = db.prepare("SELECT bundle_id FROM memory_disclosures").iterate(); // a cursor another caller left open on the shared connection
  held.next();
  const run = startRevocationIndexBackfill(db, { slice: 10, targetMs: 0.0001, pauseMs: 1, retryMs: 1, retryCapMs: 4 });
  await expect(run.done).resolves.toEqual({ built: true });
  held.return?.(undefined);
  expect(revocationIndexReady(db)).toBe(true);
  expect(db.prepare("SELECT count(*) AS n FROM memory_disclosure_refs").get()!.n).toBe(600);
});

it("the index build retries a lock error and any other error with backoff until it is ready, and only stop() ends it", async () => {
  expect(lockedError(Object.assign(new Error("database table is locked"), { errcode: 6 }))).toBe(true);
  expect(lockedError(new Error("database table is locked"))).toBe(true);
  expect(lockedError(Object.assign(new Error("busy"), { errcode: 5 }))).toBe(true);
  expect(lockedError(new Error("disk I/O error"))).toBe(false);
  const db = open();
  for (let i = 0; i < 120; i++) receipt(db, `b${i}`, [[`r${i % 10}`, 1]], [[`s${i % 6}`, 1]]);
  db.exec("UPDATE memory_revocation_index_build SET ready=0,cursor=NULL,done=0,finished_at=NULL");
  let failures = 0;
  const ready = vi.fn();
  const run = startRevocationIndexBackfill(db, { slice: 10, targetMs: 0.0001, pauseMs: 1, retryMs: 1, retryCapMs: 4, onReady: ready,
    afterChunk: () => { if (failures < 3) { failures++; throw failures === 1 ? Object.assign(new Error("database table is locked"), { errcode: 6 }) : new Error("transient failure"); } } });
  await expect(run.done).resolves.toEqual({ built: true });
  expect(run.stats.lockedRetries).toBe(1);
  expect(run.stats.errorRetries).toBe(2);
  expect(ready).toHaveBeenCalledTimes(1);
});

// ---- the live path: a file database through database() ----
const empty: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const BULK = `INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at)
  WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i+1 FROM n WHERE i<?2)
  SELECT 'bulk'||i,'t','d',NULL,json_array(json_object('id','r'||(i%500),'version',1)),
    json_array(json_object('id',CASE WHEN i<50000 AND i%1500<3 THEN 'hot'||substr('ABC',i%1500+1,1) ELSE 's'||(i%500) END,'revision',1)),0,0,0,'delivered',0 FROM n`;
function addSource(id: string, scope: string, text = "x") {
  const db = database();
  db.prepare("INSERT INTO memory_sources VALUES(?,?,'private',?,NULL,1,'hash','text','owner','settled',NULL,'active')").run(id, scope, `msg-${id}`);
  storeAnchorMessage(db, "private", `msg-${id}`, text);
  db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'hash',?,1)").run(id, JSON.stringify({ text }));
}

it("a forget costs the same with 1k or 100k earlier tombstones and 50k or 500k receipts (no request over 50 ms)", () => {
  const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] };
  reconcileMemoryRoster(roster);
  const scope = ensureScope("bot", "bot"), db = database();
  for (const id of ["hotA", "hotB", "hotC", "hotD", "hotE", "hotF"]) addSource(id, scope);
  const tomb = db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,1,'owner-forget',0)");
  const timed = (id: string) => { const t0 = performance.now(); forgetMemory(ownerMemoryTicket(), { kind: "source", id }); return performance.now() - t0; };
  db.exec("BEGIN");
  for (let i = 0; i < 1000; i++) tomb.run(`t${i}`, `gone${i}`);
  db.prepare(BULK).run(0, 49_999);
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const small = [timed("hotA")];
  expect(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state='revoked'").get()!.n).toBeGreaterThan(0);
  db.exec("BEGIN");
  for (let i = 1000; i < 100_000; i++) tomb.run(`t${i}`, `gone${i}`);
  db.prepare(BULK).run(50_000, 499_999);
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(revocationIndexReady(db)).toBe(true);
  const large = [timed("hotB"), timed("hotC")];
  // The work bound is the statements: a forget reads the receipts by primary-key seek and range, never a scan of memory_disclosures, whether or
  // not the optional live-receipts index exists (rc3f: it is built late, off-thread; the plans below are identical with and without it).
  for (const sql of [FLIP_SQL, BUNDLE_PAGE_END]) {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql === FLIP_SQL ? ['["bulk1"]'] : ["", 200])) as Array<{ detail: string }>).map(row => row.detail).join(" | ");
    expect(plan, sql).not.toMatch(/SCAN memory_disclosures/);
    expect(plan, sql).toMatch(/SEARCH memory_disclosures USING (COVERING )?INDEX sqlite_autoindex_memory_disclosures_1/);
  }
  // Wall time only guards against a scan (hundreds of ms to seconds on 500k receipts); a loaded machine adds noise, so the bound is loose.
  for (const ms of [...small, ...large]) expect(ms).toBeLessThan(400);
  expect(Math.max(...large)).toBeLessThan(Math.max(...small) + 300);
}, 600_000);

it("with the index not ready a forget returns at once and a reader treats the revoked receipts as stale immediately", async () => {
  const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities();
  const access = () => {
    const generation = registry.begin("bot", "private");
    const token = registry.mint({ botId: "bot", threadId: "private", generation, kind: "memory", depth: 100, skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  };
  const scope = ensureScope("bot", "bot"), db = database();
  db.prepare("INSERT INTO memory_records VALUES('shown',1,?,'fact','The owner keeps backups on Fridays','owner-statement','active',1,1,NULL,NULL,1)").run(scope);
  addSource("source-shown", scope, "The owner keeps backups on Fridays");
  db.prepare("INSERT INTO memory_evidence VALUES('shown',1,'source-shown',1,0,?)").run(Buffer.byteLength("The owner keeps backups on Fridays"));
  const a = access();
  const bundle = await buildMemoryBundle("anything", a, empty, { allowance: LineageAllowance.tool() });
  expect(bundle.recordVersions.map(r => r.id)).toEqual(["shown"]);
  prepareMemoryDisclosure(bundle, a, "claude");
  bindMemoryDisclosureSession(bundle.bundleId, "session-1");
  stampFreshSession(database(), "private", "claude", "session-1"); // stamped as a 1.0.3 fresh start leaves it (S6 rule 26)
  deliverMemoryDisclosure(bundle.bundleId, a);
  db.prepare(BULK).run(0, 99_999);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // the bulk fixture's own checkpoint is not a revocation slice
  db.exec("UPDATE memory_revocation_index_build SET ready=0,cursor=NULL,done=0,finished_at=NULL");
  expect(revocationIndexReady(db)).toBe(false);
  const state = () => String(db.prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundle.bundleId)!.state);
  expect(continuationMemoryRevoked(LineageAllowance.tool(), "private", "claude", "session-1", access())).toBe(false);
  const t0 = performance.now();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "source-shown" });
  expect(performance.now() - t0).toBeLessThan(300); // wall time only guards a scan of 100k receipts; the row bound below is the work bound (a loaded host stalls a 5 ms call past 100 ms)
  // privacy holds from the commit: the deletion epoch moved, so the reader ends the session before the runner has run; the request
  // itself read at most its inline budget of receipt rowids (INLINE_REVOCATION), never all of them
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state='revoked'").get()!.n)).toBeLessThanOrEqual(256);
  expect(continuationMemoryRevoked(LineageAllowance.tool(), "private", "claude", "session-1", access())).toBe(true);
  await memoryRevocationIdle();
  expect(state()).toBe("revoked");
  // a file database: each slice's own work stays inside its 8 ms budget plus one step; its COMMIT may also carry SQLite's WAL
  // auto-checkpoint (a disk cost every writer pays, not this job's)
  expect(memoryRevocationStats.maxWorkMs).toBeLessThan(150); // rows are bounded by the statements; wall time only guards a scan, loose for a loaded host
}, 600_000);

it("a source cited by 20k receipts: the request flips only a few, timed background batches finish the rest", async () => {
  const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] };
  reconcileMemoryRoster(roster);
  const scope = ensureScope("bot", "bot"), db = database();
  addSource("heavy", scope);
  db.prepare(BULK.replace(/CASE WHEN .* END,'revision'/, "'heavy','revision'")).run(0, 19_999);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // the bulk fixture's own checkpoint is not a revocation slice
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_disclosure_refs WHERE ref_id='heavy'").get()!.n)).toBe(20_000);
  const t0 = performance.now();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "heavy" });
  const requestMs = performance.now() - t0;
  // The work bound is the row count: the request flips at most its inline budget of receipts (INLINE_REVOCATION, 256 rows), and an
  // unbounded request would flip all 20k here. Its reads are seeks and ranges, never a scan (the query plans are pinned in the 500k
  // test above). Wall time only guards against gross regressions: about 20 ms on an idle 8-CPU runner, and a loaded CI shard stalled
  // the same bounded call to 142 ms, so the bound is loose like the other request bounds in this file.
  const revokedNow = Number(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state='revoked'").get()!.n);
  expect(revokedNow).toBeGreaterThan(0);
  expect(revokedNow).toBeLessThanOrEqual(256);
  expect(requestMs).toBeLessThan(300);
  await memoryRevocationIdle();
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state!='revoked'").get()!.n)).toBe(0);
  // a file database: each slice's own work stays inside its 8 ms budget plus one step; its COMMIT may also carry SQLite's WAL
  // auto-checkpoint (a disk cost every writer pays, not this job's)
  expect(memoryRevocationStats.maxWorkMs).toBeLessThan(150); // rows are bounded by the statements; wall time only guards a scan, loose for a loaded host
}, 600_000);

// ---- r1 review fixes (revoke-bounded round 2) ----

/** A seeded random memory: numeric-looking ids, receipts citing ids and versions as JSON numbers or strings, bring-in copies, derivations. */
function randomWorld(seed: number): { db: DatabaseSync; rnd: () => number } {
  let state = seed * 2654435761 % 4294967296 || 1;
  const rnd = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
  const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)]!;
  const db = open();
  const records: Array<[string, number]> = [], sources: Array<[string, number]> = [];
  for (let i = 0; i < 14; i++) {
    const id = i % 3 === 0 ? String(i + 1) : `r${i}`;
    const versions = 1 + Math.floor(rnd() * 3);
    for (let v = 1; v <= versions; v++) { db.prepare("INSERT INTO memory_records VALUES(?,?,'w','fact','x','assistant-inference','active',?,1,NULL,NULL,1)").run(id, v, rnd() < 0.3 ? 1 : 0); records.push([id, v]); }
  }
  for (let i = 0; i < 9; i++) {
    const id = i % 4 === 0 ? String(100 + i) : `s${i}`, revision = 1 + Math.floor(rnd() * 2);
    db.prepare("INSERT INTO memory_sources VALUES(?,'w','t',?,NULL,?,'h','message','owner','ok',NULL,'active')").run(id, `m${i}`, revision);
    for (let r = 1; r <= revision; r++) db.prepare("INSERT INTO memory_source_versions VALUES(?,?,'h','{}',0)").run(id, r);
    db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,cursor,policy_revision,deletion_epoch) VALUES(?,?,?,'capture','1','pending',0,1,1)").run(`job-${id}`, id, revision);
    sources.push([id, revision]);
  }
  for (let i = 0; i < 3; i++) {
    const from = pick(sources), id = `bring-in:g:${i}`;
    db.prepare("INSERT INTO memory_sources VALUES(?,'w','room',NULL,NULL,1,'h','bring-in','bot','recorded',NULL,'active')").run(id);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'h',?,0)").run(id, JSON.stringify({ text: "x", broughtFrom: { sources: [{ id: from[0], revision: from[1] }] } }));
    sources.push([id, 1]);
  }
  for (const [id, v] of records) {
    const n = 1 + Math.floor(rnd() * 2);
    for (let k = 0; k < n; k++) { const [sid, rev] = pick(sources); db.prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,?,?,?,0,1)").run(id, v, sid, 1 + Math.floor(rnd() * rev)); }
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,?,0,'pending','pending',NULL)").run(id, v);
  }
  for (let k = 0; k < 6; k++) { const a = Math.floor(rnd() * records.length), b = Math.floor(rnd() * records.length); if (a < b) db.prepare("INSERT OR IGNORE INTO memory_derivations VALUES(?,?,?,?)").run(...records[a]!, ...records[b]!); }
  const typed = (value: string | number) => typeof value === "number" ? (rnd() < 0.3 ? String(value) : value) : /^\d+$/.test(value) && rnd() < 0.4 ? Number(value) : value;
  for (let i = 0; i < 160; i++) {
    const cited = Array.from({ length: Math.floor(rnd() * 3) }, () => pick(records)).map(([id, version]) => ({ id: typed(id), version: typed(version) }));
    const shown = Array.from({ length: Math.floor(rnd() * 3) }, () => pick(sources)).map(([id, revision]) => ({ id: typed(id), revision: typed(1 + Math.floor(rnd() * revision)) }));
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'t','d',NULL,?,?,0,0,0,?,0)")
      .run(`b${i}`, JSON.stringify(cited), JSON.stringify(shown), rnd() < 0.1 ? "revoked" : "delivered");
  }
  // an earlier forget, applied long ago, so both sides start from a settled file
  const old = pick(sources);
  db.prepare("INSERT INTO memory_tombstones VALUES('old','source',?,NULL,NULL,1,'owner-forget',0)").run(old[0]);
  applyMemoryTombstones(db);
  return { db, rnd };
}
/** What forget.ts writes for a target, and the targets it hands applyForgetTombstones. */
function forgetOf(db: DatabaseSync, rnd: () => number): { sql: Array<[string, unknown[]]>; targets: ForgetTargets } {
  const asSource = rnd() < 0.5;
  if (asSource) {
    const row = db.prepare("SELECT id,revision FROM memory_sources WHERE state!='deleted' ORDER BY id LIMIT 1 OFFSET ?").get(Math.floor(rnd() * 6)) ?? db.prepare("SELECT id,revision FROM memory_sources WHERE state!='deleted' LIMIT 1").get()!;
    const revision = rnd() < 0.5 ? null : Number(row.revision);
    return { sql: [["INSERT INTO memory_tombstones VALUES('n0','source',?,?,NULL,2,'owner-forget',0)", [row.id, revision]]], targets: { sources: [{ id: String(row.id), revision }], records: [] } };
  }
  const row = db.prepare("SELECT id,version FROM memory_records WHERE state!='deleted' ORDER BY id,version LIMIT 1 OFFSET ?").get(Math.floor(rnd() * 8)) ?? db.prepare("SELECT id,version FROM memory_records WHERE state!='deleted' LIMIT 1").get()!;
  const revision = rnd() < 0.5 ? null : Number(row.version);
  const supporting = db.prepare("SELECT DISTINCT e.source_id AS id,e.source_revision AS revision FROM memory_evidence e WHERE e.record_id=? AND (? IS NULL OR e.record_version=?)").all(row.id, revision, revision) as Array<{ id: string; revision: number }>;
  return {
    sql: [["INSERT INTO memory_tombstones VALUES('n0','record',?,?,NULL,2,'owner-forget',0)", [row.id, revision]],
      ...supporting.map((s, k) => [`INSERT OR IGNORE INTO memory_tombstones VALUES('n${k + 1}','source',?,?,NULL,2,'forgotten-supporting-source',0)`, [s.id, s.revision]] as [string, unknown[]])],
    targets: { sources: supporting.map(s => ({ id: String(s.id), revision: Number(s.revision) })), records: [{ id: String(row.id), revision }] },
  };
}

it("property: over random memories (mixed id and version types), the targeted forget ends exactly what the installation-wide pass ends, index ready or not, evidence index or not", async () => {
  let checked = 0;
  for (let seed = 1; seed <= 40; seed++) {
    for (const mode of ["ready", "not-ready", "evidence-scan"] as const) {
      const g = randomWorld(seed), t = randomWorld(seed);
      expect(snapshot(t.db)).toBe(snapshot(g.db));
      const { sql, targets } = forgetOf(g.db, g.rnd);
      for (const [statement, args] of sql) { g.db.prepare(statement).run(...args as never[]); t.db.prepare(statement).run(...args as never[]); }
      applyMemoryTombstones(g.db);
      if (mode === "not-ready") t.db.exec("UPDATE memory_revocation_index_build SET ready=0,cursor=NULL,done=0,finished_at=NULL");
      // the lookups not built yet (an upgraded file mid-backfill): the job reads the evidence and the bring-ins in key windows
      if (mode === "evidence-scan") t.db.exec("UPDATE memory_late_build SET ready=0,cursor=NULL");
      applyForgetTombstones(t.db, targets, { inline: { rows: 1 + (seed % 5), ms: 1000 } });
      await drain(t.db);
      expect(snapshot(t.db), `seed ${seed} ${mode}`).toBe(snapshot(g.db));
      checked++;
      g.db.close(); t.db.close(); dbs.splice(dbs.indexOf(g.db), 1); dbs.splice(dbs.indexOf(t.db), 1);
    }
  }
  expect(checked).toBe(120);
}, 120_000);

it("a receipt citing a record version as a JSON string is revoked by the targeted forget, as by the installation-wide pass", async () => {
  const make = () => { const db = open(); db.exec("INSERT INTO memory_records VALUES('r',1,'w','fact','x','owner-statement','active',0,1,NULL,NULL,1)"); receipt(db, "typed", [], []); db.exec(`UPDATE memory_disclosures SET record_versions='[{"id":"r","version":"1"}]' WHERE bundle_id='typed'`); return db; };
  const global = make(), targeted = make();
  for (const db of [global, targeted]) db.exec("INSERT INTO memory_tombstones VALUES('n','record','r',NULL,NULL,2,'owner-forget',0)");
  applyMemoryTombstones(global);
  applyForgetTombstones(targeted, { sources: [], records: [{ id: "r", revision: null }] });
  await drain(targeted);
  expect(global.prepare("SELECT state FROM memory_disclosures").get()!.state).toBe("revoked");
  expect(targeted.prepare("SELECT state FROM memory_disclosures").get()!.state).toBe("revoked");
});

it("the citing receipts are read by an index seek with a rowid cursor, and the evidence by the source lookup: never a scan or a sort of what matches", () => {
  const db = world();
  for (const kind of ["record", "source"] as const) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${citingSeekSql(kind)}`).all(kind, "x", 0, 5).map(row => String(row.detail)).join("\n");
    expect(plan).toMatch(/SEARCH x USING INDEX memory_disclosure_refs_ref \(kind=\? AND <expr>=\? AND rowid>\?\)/);
    expect(plan).not.toMatch(/TEMP B-TREE|SCAN x\b/);
  }
  const evidence = db.prepare("EXPLAIN QUERY PLAN SELECT record_id FROM memory_evidence_by_source WHERE source_id=? AND (source_revision,record_id,record_version,start_byte)>(?,?,?,?) ORDER BY source_revision,record_id,record_version,start_byte LIMIT 5").all("s1", 0, "", 0, 0).map(row => String(row.detail)).join("\n");
  expect(evidence).toMatch(/SEARCH memory_evidence_by_source USING PRIMARY KEY \(source_id=\? AND \(source_revision,record_id,record_version,start_byte\)>\(\?,\?,\?,\?\)\)/);
  expect(evidence).not.toMatch(/TEMP B-TREE/);
});

it("one source cited by 300k receipts: the forget and every slice read a bounded number of candidates (no selection of the whole matching set)", { tags: ["perf-budget"], timeout: 300_000 }, async () => {
  const db = open();
  db.exec("INSERT INTO memory_sources VALUES('hot','w','t','m',NULL,1,'h','message','owner','ok',NULL,'active'); INSERT INTO memory_source_versions VALUES('hot',1,'h','{}',0)");
  db.prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<300000) SELECT 'b'||i,'t','d',NULL,'[]',json_array(json_object('id','hot','revision',1)),0,0,0,'delivered',0 FROM n`).run();
  db.exec("INSERT INTO memory_tombstones VALUES('n','source','hot',NULL,NULL,2,'owner-forget',0)");
  const t0 = performance.now();
  const ended = applyForgetTombstones(db, { sources: [{ id: "hot", revision: null }], records: [] });
  expect(performance.now() - t0).toBeLessThan(40);
  expect(ended.pending).toBe(true);
  await drain(db);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state!='revoked'").get()!.n)).toBe(0);
  expect(memoryRevocationStats.maxSliceMs).toBeLessThan(30);
  // and the runner left the loop most of the time
  expect(memoryRevocationStats.workMs / (memoryRevocationStats.workMs + memoryRevocationStats.pauseMs)).toBeLessThan(0.35);
});

it("a forget on a file with 300k evidence rows and 60k feedback rows does nothing proportional to them before its commit (evidence index absent)", async () => {
  const db = open();
  db.exec("INSERT INTO memory_sources VALUES('target','w','t','m-target',NULL,1,'h','message','owner','ok',NULL,'active'); INSERT INTO memory_source_versions VALUES('target',1,'h','{}',0)");
  db.exec("INSERT INTO memory_sources VALUES('other','w','t','m-other',NULL,1,'h','message','owner','ok',NULL,'active'); INSERT INTO memory_source_versions VALUES('other',1,'h','{}',0)");
  db.prepare(`INSERT INTO memory_records WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<300000) SELECT 'r'||i,1,'w','fact','x','assistant-inference','active',0,1,NULL,NULL,i FROM n`).run();
  db.prepare(`INSERT INTO memory_evidence WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<300000) SELECT 'r'||i,1,CASE WHEN i=150000 THEN 'target' ELSE 'other' END,1,0,1 FROM n`).run();
  db.prepare(`INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,polarity,strength,state,scope,correction,created_at) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<60000)
    SELECT 'f'||i,'bot','t',CASE WHEN i=30000 THEN 'm-target' ELSE 'm'||i END,'-',1,'detected','chat','said this',0 FROM n`).run();
  db.exec("INSERT INTO memory_tombstones VALUES('n','source','target',NULL,NULL,2,'owner-forget',0)");
  const t0 = performance.now();
  const ended = applyForgetTombstones(db, { sources: [{ id: "target", revision: null }], records: [] });
  expect(performance.now() - t0).toBeLessThan(40);
  expect(ended.pending).toBe(true);
  await drain(db);
  expect(db.prepare("SELECT state FROM memory_records WHERE id='r150000'").get()!.state).toBe("deleted");
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_records WHERE state='deleted'").get()!.n)).toBe(1);
  expect(db.prepare("SELECT state,correction FROM memory_feedback WHERE id='f30000'").get()).toEqual({ state: "expired", correction: null });
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_feedback WHERE state='expired'").get()!.n)).toBe(1);
  expect(memoryRevocationStats.maxSliceMs).toBeLessThan(30);
}, 300_000);

function liveSetup() {
  const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities();
  const access = () => {
    const generation = registry.begin("bot", "private");
    const token = registry.mint({ botId: "bot", threadId: "private", generation, kind: "memory", depth: 100, skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  };
  return { roster, access, scope: ensureScope("bot", "bot") };
}

it("the next turn after a forget resets a long session from two seeks, without judging or revoking its receipts one by one", async () => {
  const { access, scope } = liveSetup(), db = database();
  db.prepare("INSERT INTO memory_records VALUES('shown',1,?,'fact','The owner keeps backups on Fridays','owner-statement','active',1,1,NULL,NULL,1)").run(scope);
  addSource("source-shown", scope, "The owner keeps backups on Fridays");
  db.prepare("INSERT INTO memory_evidence VALUES('shown',1,'source-shown',1,0,?)").run(Buffer.byteLength("The owner keeps backups on Fridays"));
  const a = access();
  const bundle = await buildMemoryBundle("anything", a, empty, { allowance: LineageAllowance.tool() });
  prepareMemoryDisclosure(bundle, a, "claude");
  bindMemoryDisclosureSession(bundle.bundleId, "session-1");
  stampFreshSession(database(), "private", "claude", "session-1"); // stamped as a 1.0.3 fresh start leaves it (S6 rule 26)
  deliverMemoryDisclosure(bundle.bundleId, a);
  const meta = db.prepare("SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
  // a long session: 20k more receipts under the same epoch, each citing the record shown
  db.prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000) SELECT 'long'||i,'private','claude','session-1','[{"id":"shown","version":1}]','[]',?,?,0,'delivered',i FROM n`).run(meta.policy_revision, meta.deletion_epoch);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "source-shown" });
  stopMemoryRevocation(); // the job's own slices are not what this measures
  const revoked = () => Number(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE native_session='session-1' AND state='revoked'").get()!.n);
  const before = revoked();
  const why: { reason?: string } = {};
  const t0 = performance.now();
  expect(continuationMemoryRevoked(LineageAllowance.tool(), "private", "claude", "session-1", access(), why)).toBe(true);
  expect(performance.now() - t0).toBeLessThan(20);
  expect(why.reason).toMatch(/^memory-changed \((deletion-epoch|receipt-already-revoked)\)$/);
  expect(revoked() - before).toBeLessThanOrEqual(1);
}, 300_000);

it("memory not active: a captured reply the owner forgot is withheld from a room that holds no receipt, and a retained session with no receipt resets", async () => {
  const { captureSource } = await import("./capture.ts");
  const { setMemoryMode } = await import("./repository.ts");
  const { roomTranscriptWithoutMemory } = await import("../room-transcript.ts");
  const { recordSessionRoots, outputRootsFor } = await import("./replay-lineage.ts");
  const { retainedSessionInvalid } = await import("./dispatch.ts");
  liveSetup();
  setMemoryMode("capture");
  captureSource(database(), { id: "message:room-1:m-reply", threadId: "room-1", messageId: "m-reply", kind: "text", speaker: "bot", outcome: "recorded", text: "The vault code is 7788." });
  recordSessionRoots("room-1", "engine", "S", outputRootsFor(LineageAllowance.tool(), []));
  stampFreshSession(database(), "room-1", "engine", "S"); // stamped as a 1.0.3 fresh start leaves it (S6 rule 26)
  const lines = [{ id: "m-ask", role: "user", kind: "text", text: "code?", at: 1 }, { id: "m-reply", role: "bot", kind: "text", text: "The vault code is 7788.", at: 2 }] as unknown as import("../store.ts").Message[];
  expect(roomTranscriptWithoutMemory(LineageAllowance.tool(), "room-1", lines, false)).toBeUndefined();
  expect(retainedSessionInvalid(LineageAllowance.tool(), "room-1", "engine", "S")).toBe(false);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:room-1:m-reply" });
  expect(roomTranscriptWithoutMemory(LineageAllowance.tool(), "room-1", lines, false)!.messages.map(m => m.id)).toEqual(["m-ask"]);
  expect(roomTranscriptWithoutMemory(LineageAllowance.tool(), "room-1", lines, true)!.messages.find(m => m.id === "m-reply")?.text).not.toContain("7788");
  expect(retainedSessionInvalid(LineageAllowance.tool(), "room-1", "engine", "S")).toBe(true);
});

it("revocation work survives a restart: the job row stays until it completes, and the next start resumes it", async () => {
  const { scope } = liveSetup(), db = database();
  addSource("heavy", scope);
  db.prepare(BULK.replace(/CASE WHEN .* END,'revision'/, "'heavy','revision'")).run(0, 19_999);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "heavy" });
  stopMemoryRevocation(); // the process ends before the runner gets far
  expect(jobRows(db)).toBe(1);
  const left = Number(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state!='revoked'").get()!.n);
  expect(left).toBeGreaterThan(10_000);
  // the process ends: the server connection, then the WAL checkpointer's (which checkpoints this large log as it leaves)
  await settleTestHandles(DATA_DIR);
  // the next start
  expect(jobRows(database())).toBe(1);
  await drain(database);
  expect(jobRows(database())).toBe(0);
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state!='revoked'").get()!.n)).toBe(0);
}, 300_000);

it("a failing slice keeps the job and is tried again; an owner turn slows the runner, never stops it", async () => {
  const { scope } = liveSetup(), db = database();
  addSource("heavy", scope);
  db.prepare(BULK.replace(/CASE WHEN .* END,'revision'/, "'heavy','revision'")).run(0, 4_999);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "heavy" });
  stopMemoryRevocation();
  let fail = 2, busy = 0;
  wakeMemoryRevocation(() => { if (fail > 0) { fail--; throw new Error("disk I/O error"); } return database(); }, { pauseMs: 1, retryMs: 1, busyPauseMs: 2, busy: () => busy++ < 3 });
  await memoryRevocationIdle();
  expect(memoryRevocationStats.errorRetries).toBe(2);
  // a live turn: the marker yields before its slice (markerYields), any other job pauses after its slice (busyPauses)
  expect(memoryRevocationStats.busyPauses + memoryRevocationStats.markerYields).toBe(3);
  expect(jobRows(db)).toBe(0);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state!='revoked'").get()!.n)).toBe(0);
}, 300_000);

it("the revoke lookups are late objects: a v8 file is valid with or without them (exact text only), a downgrade drops them, the next open makes them", async () => {
  const { validateMemorySchema, downgradeMemorySchema, ensureRevokeLateObjects } = await import("./schema.ts");
  const db = open();
  const late = ["memory_deny", "memory_revocation_targets", "memory_evidence_by_source", "memory_source_origins", "memory_late_build", "memory_evidence_by_source_insert", "memory_evidence_by_source_delete", "memory_source_origins_insert"];
  // the live-receipts index is not made at open (it reads every receipt): ensureDisclosuresLiveIndex makes it after listen
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_disclosures_live'").get()).toBeUndefined();
  const { ensureDisclosuresLiveIndex } = await import("./schema.ts");
  await ensureDisclosuresLiveIndex(db, { inline: true });
  expect(() => validateMemorySchema(db)).not.toThrow();
  expect(late.every(name => db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name))).toBe(true);
  expect(() => validateMemorySchema(db)).not.toThrow();
  db.exec("DROP TRIGGER memory_source_origins_insert; CREATE TRIGGER memory_source_origins_insert AFTER INSERT ON memory_source_versions BEGIN SELECT 1; END;");
  expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
  db.exec("DROP TRIGGER memory_source_origins_insert");
  expect(() => validateMemorySchema(db)).not.toThrow();
  ensureRevokeLateObjects(db);
  // a development file that still has the superseded late index stays valid, and the downgrade drops it with the rest
  db.exec("CREATE INDEX memory_evidence_source ON memory_evidence(source_id)");
  expect(() => validateMemorySchema(db)).not.toThrow();
  downgradeMemorySchema(db, 7);
  for (const name of [...late, "memory_evidence_source", "memory_disclosures_live"]) expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name)).toBeUndefined();
  migrateMemorySchema(db, "active");
  expect(late.every(name => db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name))).toBe(true);
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_disclosures_live'").get()).toBeUndefined();
  expect(lateBuildStep(db, 10)).toBe(false); // an empty file has nothing to fill
});
