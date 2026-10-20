// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rc4 identity: an existing record promoted IN PLACE (kind to character-canon, or its details to partition 'identity') by another connection
// writes no new rowid, so a watermark refresh cannot see it. The identity set must be exact on the very next check, with and without the
// identity indexes, a skill's evidence check must then refuse (never a remembered pass), and the cost must stay flat as the store grows.
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { captureSource } from "./capture.ts";
import { setMemoryMode } from "./repository.ts";
import { reclaimPaused, type ReclaimGate } from "./root-set-reclaim.ts";
import { buildEagerIndexes } from "./optional-index.ts";
import { holdWritersForIndexBuild, writersHeldForIndexBuild } from "../database.ts";
import { identityRecomputeStats, ensureIdentityIndexes, identityGeneration, identityIndexesReady, identitySourceSet, IDENTITY_SQL, recomputeIdentityOffThread, SMALL_STORE_ROWS } from "./provenance-stamp.ts";
import { assertSkillProcedureEvidence, type SkillProcedureContext } from "../skills.ts";
import { dropRecordKeys } from "./schema.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });

function source(threadId: string) {
  const id = `source:${threadId}`;
  transaction(db => captureSource(db, { id, threadId, kind: "tool-outcome", speaker: "tool", outcome: "completed", text: `o ${threadId}`, action: { label: "fixture-check", reportedOutcome: "completed", verification: "tool-reported" } }));
  const scopeId = String(database().prepare("SELECT scope_id FROM memory_sources WHERE id=?").get(id)!.scope_id);
  return { kind: "source" as const, id, revision: 1, scopeId };
}
function record(id: string, scope: string, source: string) {
  const db = database();
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','plain','owner-statement','active',0,1,NULL,NULL,1)").run(id, scope);
  db.prepare("INSERT INTO memory_record_details(record_id,record_version,partition,attention,claim_status) VALUES(?,1,'semantic','current','current') ON CONFLICT(record_id,record_version) DO UPDATE SET partition=excluded.partition").run(id);
  db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,1)").run(id, source);
}
const elsewhere = (sql: string) => { const other = new DatabaseSync(join(DATA_DIR, "messages.db")); try { other.exec("PRAGMA foreign_keys=OFF"); other.exec(sql); } finally { other.close(); } };

for (const indexed of [false, true]) {
  it(`an in-place promotion by another connection is seen on the next check and revokes skill evidence (indexes ${indexed ? "built" : "absent"})`, async () => {
    const item = source("a"), other = source("b");
    record("plain", item.scopeId, item.id); record("kept", item.scopeId, other.id);
    if (indexed) { await ensureIdentityIndexes(database(), { inline: true }); expect(identityIndexesReady(database())).toBe(true); }
    const context: SkillProcedureContext = { audienceKey: "bot:x:owner", allowedScopeIds: [item.scopeId] };
    expect([...identitySourceSet(database())]).toEqual([]);
    assertSkillProcedureEvidence(context, [item]); // a pass, now remembered
    assertSkillProcedureEvidence(context, [item]);

    elsewhere("UPDATE memory_record_details SET partition='identity' WHERE record_id='plain'");
    expect(identitySourceSet(database()).has(`${item.id}:1`)).toBe(true);
    expect(() => assertSkillProcedureEvidence(context, [item])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
    expect(() => assertSkillProcedureEvidence(context, [item])).toThrow("PROCEDURE_EVIDENCE_REVOKED");

    elsewhere("UPDATE memory_record_details SET partition='semantic' WHERE record_id='plain'");
    expect(identitySourceSet(database()).has(`${item.id}:1`)).toBe(false);
    assertSkillProcedureEvidence(context, [item]);

    elsewhere("UPDATE memory_records SET kind='character-canon' WHERE id='kept'");
    expect(identitySourceSet(database()).has(`${other.id}:1`)).toBe(true);
    const second: SkillProcedureContext = { audienceKey: "bot:x:owner", allowedScopeIds: [other.scopeId] };
    expect(() => assertSkillProcedureEvidence(second, [other])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
  });
}

it("the identity version moves when the set is replaced and reads -1 once another connection has committed", () => {
  const item = source("g");
  record("plain", item.scopeId, item.id);
  identitySourceSet(database());
  const before = identityGeneration(database());
  expect(before).toBeGreaterThan(0);
  expect(identityGeneration(database())).toBe(before);
  elsewhere("UPDATE memory_records SET text='x' WHERE id='plain'");
  expect(identityGeneration(database())).toBe(-1);
  identitySourceSet(database());
  expect(identityGeneration(database())).toBeGreaterThan(before);
});

it("a read through the indexes costs the same rows with 10 and with 100,000 records, and walks only the indexes", async () => {
  const rows: number[] = [];
  for (const n of [10, 100_000]) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
    const item = source("c"), db = database();
    db.exec("PRAGMA foreign_keys=OFF"); db.exec("BEGIN");
    db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT INTO memory_records SELECT 'h-'||n,1,?,'fact','x','owner-statement','active',0,1,NULL,NULL,1 FROM c`).run(n, item.scopeId);
    db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT OR REPLACE INTO memory_record_details(record_id,record_version,partition,attention,claim_status) SELECT 'h-'||n,1,'semantic','current','current' FROM c`).run(n);
    db.exec("COMMIT");
    record("ident", item.scopeId, item.id);
    db.prepare("UPDATE memory_record_details SET partition='identity' WHERE record_id='ident'").run();
    await ensureIdentityIndexes(db, { inline: true });
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${IDENTITY_SQL}`).all() as Array<{ detail: string }>).map(row => row.detail).join(" | ");
    expect(plan).toMatch(/memory_records_canon/);
    expect(plan).toMatch(/memory_details_identity/);
    expect(plan).not.toMatch(/SCAN (memory_records|memory_record_details)\b(?! USING)/);
    expect(db.prepare(IDENTITY_SQL).all().length).toBe(1);
    elsewhere("UPDATE memory_records SET text='y' WHERE id='h-1'");
    expect([...identitySourceSet(db)]).toEqual([`${item.id}:1`]);
    rows.push(db.prepare(IDENTITY_SQL).all().length);
  }
  expect(rows[1]).toBe(rows[0]);
});

// Guard: every statement that can PROMOTE a record into the identity set (set kind, or set partition on the details) is one the identity read
// sees by reading the identity rows afresh, so nothing here depends on the paths; but a new such path should still be a conscious one.
// This lists the files that do it today, so adding another fails here and prompts a look at the identity checks.
it("the files that write partition or kind on memory records are the known ones", () => {
  const root = fileURLToPath(new URL("..", import.meta.url)), found = new Set<string>();
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); const s = statSync(path); if (s.isDirectory()) { if (name !== "node_modules" && name !== "testdata" && name !== "testing") walk(path); } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) { const text = readFileSync(path, "utf8"); if (/UPDATE\s+memory_records\s+SET[^;`"]*\b(kind|partition)\s*=/i.test(text) || /UPDATE\s+memory_record_details\s+SET[^;`"]*\bpartition\s*=/i.test(text)) found.add(relative(root, path).replace(/\\/g, "/")); } } };
  walk(root);
  expect([...found].sort()).toEqual(["memory/automatic-learning.ts", "memory/identity.ts", "memory/pip-episodes.ts", "memory/pip-lived.ts", "memory/pip-stance.ts", "memory/reveal-capture.ts"]);
});

function bulk(n: number, scope: string) {
  const db = database();
  db.exec("PRAGMA foreign_keys=OFF"); db.exec("BEGIN");
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT INTO memory_records SELECT 'h-'||n,1,?,'fact','x','owner-statement','active',0,1,NULL,NULL,n FROM c`).run(n, scope);
  db.prepare(`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?) INSERT OR REPLACE INTO memory_record_details(record_id,record_version,partition,attention,claim_status) SELECT 'h-'||n,1,'semantic','current','current' FROM c`).run(n);
  db.exec("COMMIT");
}
function statementsDuring(run: () => void): string[] {
  const db = database(), real = db.prepare.bind(db), seen: string[] = [];
  (db as any).prepare = (sql: string) => { seen.push(sql); return real(sql); };
  try { run(); } finally { (db as any).prepare = real; }
  return seen;
}

it("a large store with no indexes: a foreign commit does no full read on the calling thread, the check withholds meanwhile, then passes or revokes correctly", async () => {
  const item = source("big");
  record("plain", item.scopeId, item.id);
  bulk(SMALL_STORE_ROWS + 5_000, item.scopeId);
  const db = database(), context: SkillProcedureContext = { audienceKey: "bot:x:owner", allowedScopeIds: [item.scopeId] };
  expect(identityIndexesReady(db)).toBe(false);
  // unknown at first: withheld, and not by a read of the store here
  let seen = statementsDuring(() => expect(() => assertSkillProcedureEvidence(context, [item])).toThrow("PROCEDURE_EVIDENCE_REVOKED"));
  expect(seen.filter(sql => /memory_record_details|FROM memory_records/.test(sql) && !/max\(rowid\)/.test(sql) && /kind='character-canon'|partition='identity'/.test(sql))).toEqual([]);
  expect(await recomputeIdentityOffThread(db)).toBe(true);
  assertSkillProcedureEvidence(context, [item]); // known now: a pass
  // a foreign commit marks it stale again: withheld at once, no full read here, correct after the recompute
  elsewhere("UPDATE memory_record_details SET partition='identity' WHERE record_id='plain'");
  seen = statementsDuring(() => expect(() => assertSkillProcedureEvidence(context, [item])).toThrow("PROCEDURE_EVIDENCE_REVOKED"));
  expect(seen.filter(sql => /kind='character-canon'|partition='identity'/.test(sql))).toEqual([]);
  expect(await recomputeIdentityOffThread(db)).toBe(true);
  expect(identitySourceSet(db).has(`${item.id}:1`)).toBe(true);
  expect(() => assertSkillProcedureEvidence(context, [item])).toThrow("PROCEDURE_EVIDENCE_REVOKED");
  elsewhere("UPDATE memory_record_details SET partition='semantic' WHERE record_id='plain'");
  expect(() => assertSkillProcedureEvidence(context, [item])).toThrow("PROCEDURE_EVIDENCE_REVOKED"); // stale: still withheld, never a remembered pass
  expect(await recomputeIdentityOffThread(db)).toBe(true);
  assertSkillProcedureEvidence(context, [item]);
}, 60_000);

it("building both identity indexes on 187,000 records takes this long (write lock held for the build)", async () => {
  const item = source("t");
  bulk(187_000, item.scopeId);
  const db = database();
  const started = performance.now();
  expect(await ensureIdentityIndexes(db, { inline: true })).toBe(true);
  const ms = Math.round(performance.now() - started);
  console.log(`IDENTITY_INDEX_BUILD_MS=${ms}`);
  expect(ms).toBeLessThan(5000);
}, 120_000);

// rc5: the recount converges beside a running reclaim (which commits every ~100 ms), and still catches a promotion made during it.
function standInReclaim(honourPause: boolean, every = 50) {
  const other = new DatabaseSync(join(DATA_DIR, "messages.db")); other.exec("PRAGMA busy_timeout=5000");
  let n = 0, commits = 0;
  const timer = setInterval(() => {
    if (honourPause && reclaimPaused()) return;
    try { other.prepare("INSERT OR REPLACE INTO memory_lineage_lsn_meta(key,value) VALUES('root_sets_dropped',?)").run(++n); commits++; } catch { /* busy: next tick */ }
  }, every);
  return { commits: () => commits, stop: () => { clearInterval(timer); other.close(); } };
}

it("a recount completes while a reclaim commits to root-set tables every 50 ms (the reclaim parks for the scan, then goes on)", async () => {
  const item = source("rc");
  record("plain", item.scopeId, item.id);
  bulk(SMALL_STORE_ROWS + 5_000, item.scopeId);
  const db = database(), reclaim = standInReclaim(true);
  try {
    await new Promise(r => setTimeout(r, 200));
    const before = reclaim.commits();
    expect(before).toBeGreaterThan(0);
    expect(await recomputeIdentityOffThread(db)).toBe(true);
    expect(reclaimPaused()).toBe(false); // released
    await new Promise(r => setTimeout(r, 200));
    expect(reclaim.commits()).toBeGreaterThan(before); // and it carries on afterwards
  } finally { reclaim.stop(); }
}, 60_000);

it("a promotion made during the recount is caught: the result is thrown away and the set read again", async () => {
  const item = source("pr");
  record("plain", item.scopeId, item.id);
  bulk(SMALL_STORE_ROWS + 5_000, item.scopeId);
  const db = database(), reclaim = standInReclaim(true), movedBefore = identityRecomputeStats.moved, startedBefore = identityRecomputeStats.started;
  try {
    const run = recomputeIdentityOffThread(db);
    for (let i = 0; i < 2000 && identityRecomputeStats.started === startedBefore; i++) await new Promise(r => setTimeout(r, 1));
    elsewhere("UPDATE memory_record_details SET partition='identity' WHERE record_id='plain'");
    expect(await run).toBe(true);
    expect(identityRecomputeStats.moved).toBeGreaterThan(movedBefore);
    expect(identitySourceSet(db).has(`${item.id}:1`)).toBe(true);
  } finally { reclaim.stop(); }
}, 60_000);

it("on a file without the durable identity counter, a writer that does not park (not the reclaim) still keeps a snapshot from being accepted", async () => {
  const item = source("rg");
  record("plain", item.scopeId, item.id);
  bulk(SMALL_STORE_ROWS + 5_000, item.scopeId);
  const db = database();
  dropRecordKeys(db); // the shape an older build left: no memory_identity_stamp, so any other commit moves the reading
  const rogue = standInReclaim(false, 2);
  try { expect(await recomputeIdentityOffThread(db, 2)).toBe(false); } finally { rogue.stop(); }
}, 60_000);

it("with the durable identity counter (1.0.3, 2.3), a writer that does not park but writes nothing identity rests on no longer throws the snapshot away", async () => {
  const item = source("rk");
  record("plain", item.scopeId, item.id);
  bulk(SMALL_STORE_ROWS + 5_000, item.scopeId);
  const db = database(), rogue = standInReclaim(false, 2);
  try { expect(await recomputeIdentityOffThread(db, 2)).toBe(true); } finally { rogue.stop(); }
}, 60_000);

it("the early identity index build holds the writers while it runs and lets go after", async () => {
  const item = source("eb");
  record("plain", item.scopeId, item.id);
  const gate = { liveTurn: () => false, typingHeld: () => false } as unknown as ReclaimGate, seen: boolean[] = [];
  const built = await buildEagerIndexes(database(), gate, { inline: true, hold: on => { holdWritersForIndexBuild(on); seen.push(on, writersHeldForIndexBuild()); } });
  expect(built.length).toBeGreaterThan(0);
  expect(seen.slice(0, 2)).toEqual([true, true]);
  expect(seen.slice(-2)).toEqual([false, false]);
  expect(writersHeldForIndexBuild()).toBe(false);
});
