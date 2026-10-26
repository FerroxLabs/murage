// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane D (scale F6, A6): revocation reads memory_disclosure_refs instead of
// parsing every receipt's JSON. These tests hold the indexed statements to the
// 1.0.1 full scans over randomized histories (same revoked set, same count),
// check the index can never drift from the JSON, that completed deletion work
// is not requeued, that a downgrade drops the index, and a time bound at 150k
// receipts. REVOKE_BENCH=1 also prints before/after timings. Ids are mixed-type
// (a JSON number cited for a text id, floats, leading zeros, null and missing
// fields), because the index's untyped columns compare differently from the
// json_extract they replace unless the statements strip their affinity. The
// upgrade backfill is sliced and resumable, and revocation reads the JSON until
// it is ready. The disk-backed 500k upgrade benchmark is revocation-index.bench.mjs.
import { mkdtempSync } from "node:fs";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downgradeMemorySchema, migrateMemorySchema, revocationRefsExpectedSql, validateMemorySchema } from "./schema.ts";
import { RECORD_REVOCATION_SCAN_SQL, RECORD_REVOCATION_SQL, revocationIndexReady, revokeRecordDisclosures } from "./revocation.ts";
import { INLINE_REVOCATION, runRevocationJobsNow } from "./memory-revocation.ts";
import { BACKFILL_MAX_ROWS, BACKFILL_MIN_ROWS, buildRevocationIndexStep, finishRevocationIndexAtStartup, nextBackfillSliceRows, RECOVERY_DELETE_CHUNK, startRevocationIndexBackfill, type RevocationIndexEvent } from "./revocation-index.ts";
import {
  applyMemoryTombstones, applyRecordTombstone, pauseRestoredMemory, RECORD_TOMBSTONE_AFFECTED, RECORD_TOMBSTONE_REVOCATION_SCAN_TAIL,
  RECORD_TOMBSTONE_REVOCATION_TAIL, TOMBSTONE_REVOCATION_SCAN_SQL, TOMBSTONE_REVOCATION_SQL,
} from "./restore.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dbs: DatabaseSync[] = [];
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });

function open(): DatabaseSync {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0)");
  return db;
}

/** Deterministic PRNG (mulberry32), so a failing seed can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}

type Shape = { records: number; sources: number; receipts: number };
const STATES = ["prepared", "delivered", "revoked"] as const;

/** A random memory: records at several versions and states, sources at two
 * revisions, evidence, derivation chains (cycles included), source tombstones,
 * and receipts that cite known and unknown ids, at real and stale versions,
 * some of them later rewritten (the lookup merge), revoked or deleted. */
function seed(db: DatabaseSync, r: ReturnType<typeof rng>, shape: Shape) {
  const now = 1;
  const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,?,'w','fact','x','owner-statement',?,0,0)");
  const versions: Array<[string, number]> = [];
  for (let i = 0; i < shape.records; i++) {
    const n = 1 + r.int(3);
    for (let v = 1; v <= n; v++) { record.run(recordId(i), v, r.pick(["active", "archived", "superseded", "deleted", "candidate"])); versions.push([recordId(i), v]); }
  }
  const sources: Array<[string, number]> = [];
  for (let i = 0; i < shape.sources; i++) {
    const rev = 1 + r.int(2);
    db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,'w','t','m',?,'h','message','owner','ok',?)")
      .run(sourceId(i), rev, r.pick(["active", "active", "retired", "deleted"]));
    for (let v = 1; v <= rev; v++) { db.prepare("INSERT INTO memory_source_versions VALUES(?,?,'h','{}',0)").run(sourceId(i), v); sources.push([sourceId(i), v]); }
    if (r.next() < 0.15) db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,?,NULL,0,'forget',0)").run(`tomb-s${i}`, sourceId(i), r.next() < 0.5 ? null : 1 + r.int(2));
  }
  for (let i = 0; i < shape.records; i++) {
    const [id, v] = r.pick(versions), [sid, sv] = r.pick(sources);
    db.prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,?,?,?,0,1)").run(id, v, sid, sv);
    if (r.next() < 0.4) { const [cid, cv] = r.pick(versions); db.prepare("INSERT OR IGNORE INTO memory_derivations VALUES(?,?,?,?)").run(id, v, cid, cv); }
  }
  const insert = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d',NULL,?,?,0,0,0,?,?)");
  const cites = () => ({
    records: citeJson(Array.from({ length: r.int(5) }, () => { const [id, v] = r.pick(versions); return r.next() < 0.1 ? cite(r, `ghost${r.int(5)}`, "version", 1) : cite(r, id, "version", r.next() < 0.2 ? v + 1 : v); })),
    sources: citeJson(Array.from({ length: r.int(4) }, () => { const [id, v] = r.pick(sources); return cite(r, id, "revision", r.next() < 0.2 ? v + 1 : v); })),
  });
  for (let i = 0; i < shape.receipts; i++) {
    const c = cites();
    insert.run(`b${i}`, `t${r.int(5)}`, c.records, c.sources, r.pick(STATES), now);
  }
  // later life of receipts: rewritten citations (lookup merge), state changes (revocation is final in practice, but the index must follow any write), deletions
  for (let i = 0; i < shape.receipts / 4; i++) {
    const id = `b${r.int(shape.receipts)}`, roll = r.next(), c = cites();
    if (roll < 0.4) db.prepare("UPDATE memory_disclosures SET record_versions=?,source_versions=? WHERE bundle_id=?").run(c.records, c.sources, id);
    else if (roll < 0.7) db.prepare("UPDATE memory_disclosures SET state=? WHERE bundle_id=?").run(r.pick(STATES), id);
    else if (roll < 0.8) db.prepare("UPDATE memory_disclosures SET native_session='n',output_message_ids='[\"m1\"]' WHERE bundle_id=?").run(id);
    else if (roll < 0.9) db.prepare("UPDATE memory_disclosures SET bundle_id=? WHERE bundle_id=?").run(`${id}-moved`, id);
    else db.prepare("DELETE FROM memory_disclosures WHERE bundle_id=?").run(id);
  }
  return { versions, sources };
}

/** Ids of every kind a TEXT id column can hold that a JSON citation can name differently:
 * plain numbers ("4", cited as 4, 4.0 or "4"), leading zeros ("05", never equal to 5),
 * decimal forms ("10.0", "11.5", cited as numbers too) and ordinary ids. */
const recordId = (i: number) => [String(i), `0${i}`, `${i}.0`, `${i}.5`, `r${i}`][i % 5]!;
const sourceId = (i: number) => [String(1000 + i), `0${1000 + i}`, `${1000 + i}.0`, `s${i}`][i % 4]!;
const JSON_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
/** One citation of `id` at `version`, as raw JSON members: the id as a JSON string, or as a
 * number (its JSON literal, its value, or that value as a float) when it reads as one; the
 * version as a number, a float, a string, a string with a leading zero, null, or missing; and
 * now and then an id that is null or missing. */
function cite(r: ReturnType<typeof rng>, id: string, key: "version" | "revision", version: number): string[] {
  const forms = [JSON.stringify(id)];
  if (JSON_NUMBER.test(id)) forms.push(id, String(Number(id)), Number.isInteger(Number(id)) ? `${Number(id)}.0` : `${Number(id)}`, JSON.stringify(id));
  const roll = r.next();
  const idMember = roll < 0.03 ? [] : roll < 0.06 ? ['"id":null'] : [`"id":${r.pick(forms)}`];
  const versionForms = [String(version), String(version), `${version}.0`, `"${version}"`, `"0${version}"`, "null", ""];
  const v = r.pick(versionForms);
  return [...idMember, ...(v === "" ? [] : [`"${key}":${v}`])];
}
const citeJson = (cites: string[][]) => `[${cites.map(members => `{${members.join(",")}}`).join(",")}]`;

const revokedSet = (db: DatabaseSync) => db.prepare("SELECT bundle_id FROM memory_disclosures WHERE state='revoked' ORDER BY bundle_id").all().map(row => String(row.bundle_id)).join(",");
/** Runs `reference` and `candidate` on the same state; both must revoke the same receipts. */
function same(db: DatabaseSync, reference: () => number, candidate: () => number) {
  db.exec("SAVEPOINT reference");
  const expectedCount = reference(), expected = revokedSet(db);
  db.exec("ROLLBACK TO reference; RELEASE reference");
  const count = candidate();
  expect(revokedSet(db)).toBe(expected);
  expect(count).toBe(expectedCount);
  return count;
}

function recordRevocationMatchesScan(seeds = 40): number {
  let revoked = 0;
  for (let s = 1; s <= seeds; s++) {
    const db = open(), r = rng(s);
    seed(db, r, { records: 30, sources: 20, receipts: 200 });
    validateMemorySchema(db); // the full sweep proves the index equals the JSON after every kind of write
    for (let step = 0; step < 12; step++) {
      const recordIds = Array.from({ length: r.int(3) }, () => r.next() < 0.1 ? "ghost1" : recordId(r.int(30)));
      const sourceIds = Array.from({ length: r.int(2) }, () => sourceId(r.int(20)));
      const via = r.next() < 0.7 ? 1 : 0;
      // now and then a caller passes numbers: revokeRecordDisclosures takes the 1.0.1 scan for those
      const loose = step % 4 === 1, typed = (ids: string[]) => loose ? ids.map(id => JSON_NUMBER.test(id) ? Number(id) : id) as unknown as string[] : ids;
      const rids = typed(recordIds), sids = typed(sourceIds);
      const args = [JSON.stringify([...new Set(rids)]), JSON.stringify([...new Set(sids)]), via] as const;
      revoked += same(db,
        () => Number(db.prepare(RECORD_REVOCATION_SCAN_SQL).run(...args).changes),
        () => step % 2 ? revokeRecordDisclosures(db, "test", { recordIds: rids, sourceIds: sids, viaSources: via === 1 }) + runRevocationJobsNow(db) : Number(db.prepare(RECORD_REVOCATION_SQL).run(...args).changes));
    }
    validateMemorySchema(db);
  }
  return revoked;
}

it("record revocation through the index revokes exactly what the full scan revoked, across randomized histories", () => {
  expect(recordRevocationMatchesScan()).toBeGreaterThan(100); // the histories exercised real revocations, not only empty ones
});

it("a records revocation whose inline slice stops part way counts each receipt once, inline or in the job", () => {
  // CI 40193051242 (macOS): the 8 ms inline deadline expired inside the refs phase after some of its flips, the job row kept the
  // inline count, and finishing the job counted those receipts again (44 for 22). Small row budgets stop the inline slice at every
  // point of the phase (closure, evidence, the seeks between flips), deterministically, whatever the machine's speed.
  const saved = { ...INLINE_REVOCATION };
  let revoked = 0;
  try {
    // REVOKE_SWEEP=1: every budget from 1 to 64 rows over all 40 histories
    const sweep = process.env.REVOKE_SWEEP === "1", budgets = sweep ? Array.from({ length: 64 }, (_, i) => i + 1) : [2, 3, 5, 8, 13, 21, 34];
    for (const rows of budgets) { INLINE_REVOCATION.rows = rows; revoked += recordRevocationMatchesScan(sweep ? 40 : 8); }
  } finally { Object.assign(INLINE_REVOCATION, saved); }
  expect(revoked).toBeGreaterThan(100);
});

it("tombstone revocations (forget, one-record delete) through the index match the full scans", () => {
  let revoked = 0;
  for (let s = 100; s < 130; s++) {
    const db = open(), r = rng(s);
    seed(db, r, { records: 25, sources: 15, receipts: 200 });
    revoked += same(db, () => Number(db.prepare(TOMBSTONE_REVOCATION_SCAN_SQL).run().changes), () => Number(db.prepare(TOMBSTONE_REVOCATION_SQL).run().changes));
    for (let step = 0; step < 6; step++) {
      const id = recordId(r.int(25));
      revoked += same(db,
        () => Number(db.prepare(`${RECORD_TOMBSTONE_AFFECTED} ${RECORD_TOMBSTONE_REVOCATION_SCAN_TAIL}`).run(id).changes),
        () => Number(db.prepare(`${RECORD_TOMBSTONE_AFFECTED} ${RECORD_TOMBSTONE_REVOCATION_TAIL}`).run(id).changes));
      // and after more material is forgotten
      db.prepare("UPDATE memory_records SET state='deleted' WHERE id=?").run(recordId(r.int(25)));
      if (r.next() < 0.5) db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(sourceId(r.int(15)));
      revoked += same(db, () => Number(db.prepare(TOMBSTONE_REVOCATION_SCAN_SQL).run().changes), () => Number(db.prepare(TOMBSTONE_REVOCATION_SQL).run().changes));
    }
  }
  expect(revoked).toBeGreaterThan(100);
});

it("after a whole forget or a one-record delete, the 1.0.1 scans find nothing left to revoke", () => {
  for (let s = 200; s < 215; s++) {
    const db = open(), r = rng(s);
    seed(db, r, { records: 20, sources: 12, receipts: 150 });
    db.prepare("INSERT INTO memory_tombstones VALUES('t-r','record',?,NULL,NULL,0,'forget',0)").run(recordId(r.int(20)));
    applyMemoryTombstones(db);
    expect(Number(db.prepare(TOMBSTONE_REVOCATION_SCAN_SQL).run().changes)).toBe(0);
    const id = recordId(r.int(20));
    applyRecordTombstone(db, id);
    expect(Number(db.prepare(`${RECORD_TOMBSTONE_AFFECTED} ${RECORD_TOMBSTONE_REVOCATION_SCAN_TAIL}`).run(id).changes)).toBe(0);
    expect(Number(db.prepare(TOMBSTONE_REVOCATION_SCAN_SQL).run().changes)).toBe(0);
    validateMemorySchema(db);
  }
});

it("the index holds every live receipt's citations and nothing for revoked or deleted ones; a lost row fails validation", () => {
  const db = open();
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('a','t','d',?,?,0,0,0,'prepared',0)")
    .run(JSON.stringify([{ id: "r1", version: 2 }, { id: "r2", version: 1 }]), JSON.stringify([{ id: "s1", revision: 3 }]));
  const refs = () => db.prepare("SELECT bundle_id,kind,ref_id,ref_version FROM memory_disclosure_refs ORDER BY bundle_id,kind,ref_id").all().map(row => ({ ...row }));
  expect(refs()).toEqual([
    { bundle_id: "a", kind: "record", ref_id: "r1", ref_version: 2 }, { bundle_id: "a", kind: "record", ref_id: "r2", ref_version: 1 },
    { bundle_id: "a", kind: "source", ref_id: "s1", ref_version: 3 }]);
  db.exec("UPDATE memory_disclosures SET state='delivered'");
  expect(refs()).toHaveLength(3);
  db.exec(`UPDATE memory_disclosures SET record_versions='[{"id":"r9","version":1}]'`);
  expect(refs().map(row => row.ref_id)).toEqual(["r9", "s1"]);
  db.exec("UPDATE memory_disclosures SET state='revoked'");
  expect(refs()).toEqual([]);
  db.exec("UPDATE memory_disclosures SET state='prepared'");
  expect(refs()).toHaveLength(2);
  validateMemorySchema(db);
  db.exec("DELETE FROM memory_disclosure_refs WHERE kind='source'");
  expect(() => validateMemorySchema(db)).toThrow("INVALID_MEMORY_REVOCATION_INDEX");
  db.exec("INSERT INTO memory_disclosure_refs VALUES('a','source','s1',3),('ghost','record','r1',1)");
  expect(() => validateMemorySchema(db)).toThrow("INVALID_MEMORY_REVOCATION_INDEX");
  db.exec("DELETE FROM memory_disclosures");
  expect(refs()).toEqual([{ bundle_id: "ghost", kind: "record", ref_id: "r1", ref_version: 1 }]);
});

it("a forget does not requeue deletion work that is already complete (A6)", () => {
  const db = open();
  const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,'w','fact','x','owner-statement',?,0,0)");
  const receipt = db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,?,?,NULL)");
  record.run("done", "deleted"); receipt.run("done", "deleted", "deleted");
  record.run("halfway", "deleted"); receipt.run("halfway", "delete-pending", "delete-pending");
  record.run("fresh", "active"); receipt.run("fresh", "indexed", "indexed");
  db.exec("INSERT INTO memory_tombstones VALUES('t1','record','fresh',NULL,NULL,0,'forget',0)");
  const statuses = () => Object.fromEntries(db.prepare("SELECT record_id,lexical_status||'/'||embedding_status AS s FROM memory_projection_receipts").all().map(row => [row.record_id, row.s]));
  for (let i = 0; i < 3; i++) {
    applyMemoryTombstones(db);
    expect(statuses()).toEqual({ done: "deleted/deleted", halfway: "delete-pending/delete-pending", fresh: "delete-pending/delete-pending" });
  }
  // a restore resets receipts first, so a restored file's deleted records are scrubbed again
  pauseRestoredMemory(db);
  expect(statuses()).toEqual({ done: "delete-pending/delete-pending", halfway: "delete-pending/delete-pending", fresh: "delete-pending/delete-pending" });
});

it("a downgrade drops the revocation index, and the next start rebuilds it", () => {
  const db = open(), r = rng(7);
  seed(db, r, { records: 10, sources: 8, receipts: 60 });
  const names = () => db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'memory_disclosure_refs%' OR name IN ('memory_disclosures_state','memory_revocation_index_build') ORDER BY name").all().map(row => String(row.name));
  expect(names()).toEqual(["memory_disclosure_refs", "memory_disclosure_refs_bundle", "memory_disclosure_refs_delete", "memory_disclosure_refs_insert", "memory_disclosure_refs_ref", "memory_disclosure_refs_update", "memory_disclosures_state", "memory_revocation_index_build"]);
  const before = db.prepare("SELECT count(*) AS n FROM memory_disclosure_refs").get()!.n;
  expect(downgradeMemorySchema(db, 7)).toEqual({ status: "downgraded", from: 12, to: 7 });
  expect(names()).toEqual([]);
  validateMemorySchema(db);
  expect(db.prepare("SELECT schema_version FROM memory_meta").get()!.schema_version).toBe(7);
  // a 1.0.2 build without the index writes receipts; the next start backfills them
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('later','t','d',?,'[]',0,0,0,'prepared',0)").run(JSON.stringify([{ id: recordId(1), version: 1 }]));
  migrateMemorySchema(db);
  expect(revocationIndexReady(db)).toBe(false);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_disclosure_refs").get()!.n)).toBe(0);
  validateMemorySchema(db);
  expect(finishRevocationIndexAtStartup(db)).toEqual({ built: true });
  expect(revocationIndexReady(db)).toBe(true);
  validateMemorySchema(db);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_disclosure_refs").get()!.n)).toBe(Number(before) + 1);
  expect(finishRevocationIndexAtStartup(db)).toEqual({ built: false });
  expect(revokeRecordDisclosures(db, "test", { recordIds: [recordId(1)], viaSources: false }) + runRevocationJobsNow(db)).toBeGreaterThan(0);
  expect(db.prepare("SELECT state FROM memory_disclosures WHERE bundle_id='later'").get()!.state).toBe("revoked");
  // and the desktop's "reinstall 1.0.1" step (to 6) passes through it
  expect(downgradeMemorySchema(db, 6)).toMatchObject({ status: "downgraded", from: 12, to: 6 });
  expect(names()).toEqual([]);
});

/** 150k receipts: 3,000 records, 1,500 sources, ~5 record and ~3 source citations each. */
function large(db: DatabaseSync, receipts: number) {
  db.exec("BEGIN");
  const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,'w','fact','x','owner-statement','active',0,0)");
  for (let i = 0; i < 3000; i++) record.run(`r${i}`);
  for (let i = 0; i < 1500; i++) {
    db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,'w','t','m',1,'h','message','owner','ok','active')").run(`s${i}`);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,'h','{}',0)").run(`s${i}`);
    db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,1)").run(`r${i}`, `s${i}`);
  }
  const r = rng(42);
  const insert = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d',?,?,0,0,0,?,0)");
  for (let i = 0; i < receipts; i++) {
    insert.run(`bundle-${i}`, `thread-${r.int(200)}`, JSON.stringify(Array.from({ length: 5 }, () => ({ id: `r${r.int(3000)}`, version: 1 }))),
      JSON.stringify(Array.from({ length: 3 }, () => ({ id: `s${r.int(1500)}`, revision: 1 }))), r.next() < 0.3 ? "revoked" : "delivered");
  }
  db.exec("COMMIT");
}
async function stall(run: () => void) {
  const histogram = monitorEventLoopDelay({ resolution: 1 }); histogram.enable();
  await new Promise(resolve => setTimeout(resolve, 20));
  const start = performance.now();
  await new Promise<void>(resolve => setImmediate(() => { run(); resolve(); }));
  const ms = performance.now() - start;
  await new Promise(resolve => setTimeout(resolve, 20));
  histogram.disable();
  return { ms: Math.round(ms * 10) / 10, maxDelayMs: Math.round(histogram.max / 1e5) / 10 };
}

it("one revocation at 150k receipts touches only the receipts that cite it", async () => {
  const db = open();
  large(db, 150_000);
  // every read of the refs table goes through the expression index on CAST(ref_id AS TEXT), never a scan of it or of the receipts
  const plans = [
    db.prepare(`EXPLAIN QUERY PLAN ${RECORD_REVOCATION_SQL}`).all(JSON.stringify(["r1"]), "[]", 1),
    db.prepare(`EXPLAIN QUERY PLAN ${TOMBSTONE_REVOCATION_SQL}`).all(),
    db.prepare(`EXPLAIN QUERY PLAN ${RECORD_TOMBSTONE_AFFECTED} ${RECORD_TOMBSTONE_REVOCATION_TAIL}`).all("r1"),
  ].map(rows => rows.map(row => String(row.detail)));
  for (const plan of plans) {
    expect(plan.some(line => /^SCAN (memory_disclosures|x)\b/.test(line)), plan.join("\n")).toBe(false); // x: the refs table
    expect(plan.some(line => /^SEARCH x USING INDEX memory_disclosure_refs_ref\b/.test(line)), plan.join("\n")).toBe(true);
  }
  const bench = process.env.REVOKE_BENCH === "1";
  const results: Record<string, unknown> = {};
  for (const [name, sql] of [["before (1.0.1 scan)", RECORD_REVOCATION_SCAN_SQL], ["after (index)", RECORD_REVOCATION_SQL]] as const) {
    if (!bench && name.startsWith("before")) continue;
    for (let i = 0; i < 3; i++) {
      db.exec("SAVEPOINT b");
      let changes = 0;
      const measured = await stall(() => { changes = Number(db.prepare(sql).run(JSON.stringify([`r${100 + i}`]), "[]", 1).changes); });
      db.exec("ROLLBACK TO b; RELEASE b");
      results[`${name} #${i}`] = { ...measured, revoked: changes };
      if (!bench || name.startsWith("after")) expect(measured.ms).toBeLessThan(250);
    }
  }
  if (bench) {
    // a forget: one record deleted, the whole tombstone revocation statement
    db.exec("UPDATE memory_records SET state='deleted' WHERE id='r7'");
    for (const [name, sql] of [["forget before", TOMBSTONE_REVOCATION_SCAN_SQL], ["forget after", TOMBSTONE_REVOCATION_SQL]] as const) {
      db.exec("SAVEPOINT f");
      let changes = 0;
      results[name] = { ...(await stall(() => { changes = Number(db.prepare(sql).run().changes); })), revoked: changes };
      db.exec("ROLLBACK TO f; RELEASE f");
    }
    console.info(`REVOKE_BENCH ${JSON.stringify(results)}`);
  }
}, 300_000);

/** Every comparison the revocation statements make, on one state, each in its own savepoint: the
 * forget-wide tombstone statement, the one-record tombstone for every record id, and the record
 * revocation (both widths) for every record and source id, plus the runtime functions that choose
 * between the index and the scan. The index statements themselves are compared only once the index
 * is ready (before that nothing reads them). Returns the receipts a forget revokes and the count. */
function differential(db: DatabaseSync, recordIds: readonly string[], sourceIds: readonly string[]) {
  const isolated = <T>(run: () => T): T => { db.exec("SAVEPOINT isolated"); try { return run(); } finally { db.exec("ROLLBACK TO isolated; RELEASE isolated"); } };
  const ready = revocationIndexReady(db);
  let total = 0;
  const forgotten = isolated(() => {
    const scan = () => Number(db.prepare(TOMBSTONE_REVOCATION_SCAN_SQL).run().changes);
    total += ready ? same(db, scan, () => Number(db.prepare(TOMBSTONE_REVOCATION_SQL).run().changes)) : scan();
    return db.prepare("SELECT bundle_id FROM memory_disclosures WHERE state='revoked' ORDER BY bundle_id").all().map(row => String(row.bundle_id));
  });
  // the runtime functions, whole (they delete records before revoking): as they run now, and as they run on the scan
  // (with the index not ready a request reads a bounded window and leaves a durable job for the rest: run to its end here)
  const run = (scan: boolean, apply: () => void) => isolated(() => { if (scan) db.exec("UPDATE memory_revocation_index_build SET ready=0"); apply(); runRevocationJobsNow(db); return revokedSet(db); });
  expect(run(false, () => applyMemoryTombstones(db))).toBe(run(true, () => applyMemoryTombstones(db)));
  for (const id of recordIds) expect(run(false, () => applyRecordTombstone(db, id))).toBe(run(true, () => applyRecordTombstone(db, id)));
  if (ready) for (const id of recordIds) {
    total += isolated(() => same(db,
      () => Number(db.prepare(`${RECORD_TOMBSTONE_AFFECTED} ${RECORD_TOMBSTONE_REVOCATION_SCAN_TAIL}`).run(id).changes),
      () => Number(db.prepare(`${RECORD_TOMBSTONE_AFFECTED} ${RECORD_TOMBSTONE_REVOCATION_TAIL}`).run(id).changes)));
  }
  for (const via of [0, 1]) for (const [records, sources] of [...recordIds.map(id => [[id], []]), ...sourceIds.map(id => [[], [id]])] as Array<[string[], string[]]>) {
    const args = [JSON.stringify(records), JSON.stringify(sources), via] as const;
    const scan = () => Number(db.prepare(RECORD_REVOCATION_SCAN_SQL).run(...args).changes);
    if (ready) total += isolated(() => same(db, scan, () => Number(db.prepare(RECORD_REVOCATION_SQL).run(...args).changes)));
    total += isolated(() => same(db, scan, () => revokeRecordDisclosures(db, "test", { recordIds: records, sourceIds: sources, viaSources: via === 1 }) + runRevocationJobsNow(db)));
  }
  return { forgotten, total };
}

it("mixed-type citations (a number for a text id, floats, leading zeros, null and missing fields) revoke exactly what the full scans revoke, through 8 -> 6 -> 8", () => {
  const db = open();
  const recordIds = ["1", "01", "1.0", "1.5", "2", "a", "true"], sourceIds = ["1", "01", "1.0", "2", "7", "s"];
  const record = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,?,'w','fact','x','owner-statement',?,0,0)");
  for (const id of recordIds) { record.run(id, 1, ["1", "1.5", "a", "01"].includes(id) ? "deleted" : "active"); record.run(id, 2, "active"); }
  for (const [i, id] of sourceIds.entries()) {
    db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES(?,'w','t','m',2,'h','message','owner','ok',?)").run(id, id === "1" ? "deleted" : "active");
    for (const v of [1, 2]) db.prepare("INSERT INTO memory_source_versions VALUES(?,?,'h','{}',0)").run(id, v);
    db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,1)").run(recordIds[i % recordIds.length], id);
  }
  // revision tombstones: one revision of "2", every revision of "01", revision 2 of "1.0"
  db.exec("INSERT INTO memory_tombstones VALUES('t1','source','2',1,NULL,0,'forget',0),('t2','source','01',NULL,NULL,0,'forget',0),('t3','source','1.0',2,NULL,0,'forget',0)");
  db.exec("INSERT INTO memory_derivations VALUES('2',1,'1.5',2)");
  const idForms = ["1", '"1"', "1.0", '"01"', '"1.0"', "1.5", '"1.5"', "2", "2.0", '"2"', "7", "7.0", "true", "null", "", '"a"', '"s"', "1e0", "-0"];
  const versionForms = ["1", '"1"', "1.0", '"01"', '" 1"', '"1.0"', "2", '"2"', "null", ""];
  const insert = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'t','d',?,?,0,0,0,'delivered',0)");
  const members = (id: string, key: string, version: string) => `{${[id === "" ? "" : `"id":${id}`, version === "" ? "" : `"${key}":${version}`].filter(Boolean).join(",")}}`;
  for (const [i, id] of idForms.entries()) for (const [j, version] of versionForms.entries()) {
    insert.run(`rec-${i}-${j}`, `[${members(id, "version", version)}]`, "[]");
    insert.run(`src-${i}-${j}`, "[]", `[${members(id, "revision", version)}]`);
  }
  validateMemorySchema(db);
  // Astra's case: record "1" deleted at version 1, a receipt citing {"id":1,"version":1} (a number)
  const first = differential(db, recordIds, sourceIds);
  expect(first.forgotten).toContain("rec-0-0"); // {"id":1,"version":1}
  expect(first.forgotten).toContain("src-0-0"); // {"id":1,"revision":1}: source "1" is deleted
  expect(first.forgotten).toContain("src-7-0"); // {"id":2,"revision":1}: revision 1 of "2" is tombstoned
  expect(first.forgotten).not.toContain("rec-2-0"); // {"id":1.0,...} reads as "1.0", not "1", and record "1.0" is live
  expect(first.total).toBeGreaterThan(100);
  // the stored forms are the JSON's own: a number stays a number
  expect(db.prepare("SELECT typeof(ref_id) AS t FROM memory_disclosure_refs WHERE bundle_id='rec-0-0'").get()!.t).toBe("integer");
  // persists through a downgrade to 6 and the upgrade back: JSON scan while the index is rebuilt, the index after
  expect(downgradeMemorySchema(db, 6)).toMatchObject({ status: "downgraded", from: 12, to: 6 });
  migrateMemorySchema(db);
  expect(revocationIndexReady(db)).toBe(false);
  const during = differential(db, recordIds, sourceIds);
  expect(during.forgotten).toEqual(first.forgotten);
  finishRevocationIndexAtStartup(db, { slice: 13 });
  expect(revocationIndexReady(db)).toBe(true);
  validateMemorySchema(db);
  const after = differential(db, recordIds, sourceIds);
  expect(after.forgotten).toEqual(first.forgotten);
  expect(after.total).toBe(first.total);
  expect(during.total).toBeGreaterThan(0);
});

it("after an upgrade, revocation reads the JSON until the sliced backfill is complete and proven; the backfill resumes and follows writes made meanwhile", () => {
  const db = open(), r = rng(9);
  seed(db, r, { records: 20, sources: 12, receipts: 400 });
  const refs = () => db.prepare("SELECT bundle_id,kind,ref_id,ref_version FROM memory_disclosure_refs ORDER BY bundle_id,kind,quote(ref_id),quote(ref_version)").all().map(row => ({ ...row }));
  downgradeMemorySchema(db, 7);
  migrateMemorySchema(db);
  expect(db.prepare("SELECT ready,cursor,done,total FROM memory_revocation_index_build").get()).toMatchObject({ ready: 0, cursor: null, done: 0 });
  expect(refs()).toEqual([]);
  const lookupIndex = () => db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_disclosure_refs_ref'").get();
  expect(lookupIndex()).toBeTruthy(); // made with the (empty) table: every write keeps it, so no last-step sort is left to do
  // not ready: every path reads the JSON, so nothing is missed with an empty index
  const cited = db.prepare("SELECT json_extract(j.value,'$.id') AS id FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.state!='revoked' AND json_type(j.value,'$.id')='text' LIMIT 1").get()!.id as string;
  db.exec("SAVEPOINT probe");
  expect(revokeRecordDisclosures(db, "test", { recordIds: [cited], viaSources: false }) + runRevocationJobsNow(db)).toBeGreaterThan(0);
  db.exec("ROLLBACK TO probe; RELEASE probe");
  // one slice, then a slice that fails part-way (nothing of it stays), then writes on both sides of the cursor
  expect(buildRevocationIndexStep(db, 60)).toMatchObject({ ready: false, done: 60 });
  const cursor = db.prepare("SELECT cursor FROM memory_revocation_index_build").get()!.cursor as string;
  const victim = db.prepare("SELECT bundle_id FROM memory_disclosures WHERE bundle_id>? AND state!='revoked' AND EXISTS (SELECT 1 FROM json_each(record_versions) j WHERE json_extract(j.value,'$.id') IS NOT NULL) ORDER BY bundle_id LIMIT 1").get(cursor)!.bundle_id as string;
  db.exec(`CREATE TEMP TRIGGER fail_slice BEFORE INSERT ON main.memory_disclosure_refs WHEN NEW.bundle_id='${victim}' BEGIN SELECT RAISE(ABORT,'disk went away'); END;`);
  expect(() => buildRevocationIndexStep(db, 60)).toThrow("disk went away");
  expect(db.prepare("SELECT ready,cursor,done FROM memory_revocation_index_build").get()).toMatchObject({ ready: 0, cursor, done: 60 });
  expect(revocationIndexReady(db)).toBe(false);
  db.exec("DROP TRIGGER temp.fail_slice");
  const insert = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'t','d',?,'[]',0,0,0,'prepared',0)");
  insert.run("a-written-meanwhile", JSON.stringify([{ id: 4, version: 1 }]));
  insert.run("zz-written-meanwhile", JSON.stringify([{ id: "4", version: "1" }]));
  db.prepare("UPDATE memory_disclosures SET record_versions=? WHERE bundle_id=?").run('[{"id":5.0,"version":1}]', victim);
  db.prepare("DELETE FROM memory_disclosures WHERE bundle_id=(SELECT bundle_id FROM memory_disclosures WHERE bundle_id>? ORDER BY bundle_id LIMIT 1 OFFSET 3)").run(cursor);
  const events: RevocationIndexEvent[] = [];
  expect(finishRevocationIndexAtStartup(db, { slice: 37, onProgress: event => events.push(event) })).toEqual({ built: true });
  expect(revocationIndexReady(db)).toBe(true);
  expect(events[0]).toEqual({ phase: "indexing", done: 60, total: expect.any(Number) });
  expect(events.at(-1)!.done).toBe(events.at(-1)!.total);
  expect(events.length).toBeGreaterThan(5);
  validateMemorySchema(db); // the sliced full sweep
  expect(lookupIndex()).toBeTruthy();
  // a file an earlier build of this lane left with every slice written but no lookup index (it was made last, in one sort):
  // the next start makes the index on the emptied table and reads every slice again
  db.exec("DROP INDEX memory_disclosure_refs_ref; UPDATE memory_revocation_index_build SET ready=0");
  validateMemorySchema(db);
  expect(finishRevocationIndexAtStartup(db, { slice: 37 })).toEqual({ built: true });
  expect(lookupIndex()).toBeTruthy();
  expect(revocationIndexReady(db)).toBe(true);
  // a ready index must have it
  db.exec("SAVEPOINT noindex; DROP INDEX memory_disclosure_refs_ref");
  expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
  db.exec("ROLLBACK TO noindex; RELEASE noindex");
  const built = refs();
  db.exec(`DELETE FROM memory_disclosure_refs; INSERT INTO memory_disclosure_refs ${revocationRefsExpectedSql({ lo: null, hi: null })}`.replaceAll("?1 IS NULL", "1").replaceAll("?2 IS NULL", "1"));
  expect(built).toEqual(refs()); // exactly what one pass over the JSON writes
  // ready: the index paths agree with the scans on the finished index
  differential(db, [cited, "4", "5"], []);
});

it("the background backfill starts without waiting, revocation during it uses the scan and is exact, then it completes and the flag flips", async () => {
  const db = open(), r = rng(21);
  seed(db, r, { records: 20, sources: 12, receipts: 400 });
  const cited = db.prepare("SELECT json_extract(j.value,'$.id') AS id FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.state!='revoked' AND json_type(j.value,'$.id')='text' LIMIT 1").get()!.id as string;
  const revoked = () => { db.exec("SAVEPOINT probe"); const n = revokeRecordDisclosures(db, "test", { recordIds: [cited], viaSources: false }) + runRevocationJobsNow(db); db.exec("ROLLBACK TO probe; RELEASE probe"); return n; };
  const expected = revoked(); // ready index: the answer every state must give
  expect(expected).toBeGreaterThan(0);
  downgradeMemorySchema(db, 7);
  migrateMemorySchema(db);
  expect(revocationIndexReady(db)).toBe(false);
  // the call returns at once with nothing built: whatever follows (listen) did not wait for it
  const run = startRevocationIndexBackfill(db, { slice: 10, targetMs: 0.0001, pauseMs: 2 });
  expect(revocationIndexReady(db)).toBe(false);
  expect(db.prepare("SELECT done FROM memory_revocation_index_build").get()!.done).toBe(0);
  while (Number(db.prepare("SELECT done FROM memory_revocation_index_build").get()!.done) === 0) await new Promise(res => setTimeout(res, 1));
  // part-way: the flag is unset, so revocation scans the JSON, and the answer is exact
  expect(revocationIndexReady(db)).toBe(false);
  expect(revoked()).toBe(expected);
  await expect(run.done).resolves.toEqual({ built: true });
  expect(revocationIndexReady(db)).toBe(true);
  expect(run.stats.slices).toBeGreaterThan(5);
  validateMemorySchema(db);
  expect(revoked()).toBe(expected);
  // nothing left to do: a second start is a no-op
  await expect(startRevocationIndexBackfill(db).done).resolves.toEqual({ built: false });
});

it("the background backfill slows while an owner turn is live but never stops, and stops on request", async () => {
  const db = open();
  seed(db, rng(22), { records: 10, sources: 6, receipts: 100 });
  downgradeMemorySchema(db, 7);
  migrateMemorySchema(db);
  const run = startRevocationIndexBackfill(db, { slice: 10, targetMs: 0.0001, pauseMs: 1, busyPauseMs: 5, busy: () => true });
  await expect(run.done).resolves.toEqual({ built: true }); // an owner turn is live the whole time
  expect(run.stats.slices).toBeGreaterThan(5);
  const again = (downgradeMemorySchema(db, 7), migrateMemorySchema(db), startRevocationIndexBackfill(db, { slice: 10, pauseMs: 1 }));
  again.stop();
  await expect(again.done).resolves.toEqual({ built: false });
  expect(revocationIndexReady(db)).toBe(false);
});

// Starvation and resume (Astra r1 P2): a constantly active person never gives a quiet spell, and the build still finishes.
function openFile(rows: number): { db: DatabaseSync; dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "revoke-lookup-")), file = join(dir, "messages.db"), db = new DatabaseSync(file); dbs.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
  migrateMemorySchema(db, "active");
  db.exec("INSERT INTO memory_scopes VALUES('w','workspace','owner','[]',0)");
  seed(db, rng(31), { records: 20, sources: 12, receipts: rows });
  downgradeMemorySchema(db, 7); migrateMemorySchema(db);
  return { db, dir, file };
}
function closeAndRemove(db: DatabaseSync, dir: string) {
  try { db.close(); } catch { /* already closed */ }
  const at = dbs.indexOf(db); if (at >= 0) dbs.splice(at, 1);
  removeTempDirSync(dir);
}
const refsOf = (db: DatabaseSync) => db.prepare("SELECT bundle_id,kind,quote(ref_id) AS ref_id,quote(ref_version) AS ref_version FROM memory_disclosure_refs ORDER BY bundle_id,kind,quote(ref_id),quote(ref_version)").all().map(row => ({ ...row }));

it("under continuous owner writes every 2 s (no quiet spell ever) the build completes in short slices, loses no write made meanwhile, and the lookups equal the reference", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { db, dir } = openFile(600);
  try {
    const insert = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'t','d',?,'[]',0,0,0,'prepared',0)");
    const run = startRevocationIndexBackfill(db, { slice: 20, targetMs: 0.0001, pauseMs: 1_000, busyPauseMs: 2_000, busy: () => true });
    let written = 0, simulatedMs = 0;
    // an owner write lands at every 2 s tick of the (simulated) clock, both before and behind the build's cursor
    let finished = false; void run.done.then(() => { finished = true; });
    for (let tick = 0; tick < 400 && !finished; tick++) {
      insert.run(tick % 2 ? `a-live-${tick}` : `zz-live-${tick}`, JSON.stringify([{ id: String(1 + (tick % 7)), version: 1 }])); written++;
      db.prepare("UPDATE memory_disclosures SET record_versions=? WHERE bundle_id=(SELECT bundle_id FROM memory_disclosures ORDER BY bundle_id LIMIT 1 OFFSET ?)").run('[{"id":"2","version":1}]', tick % 50);
      await vi.advanceTimersByTimeAsync(2_000); simulatedMs += 2_000;
    }
    expect(finished).toBe(true);
    expect(written).toBeGreaterThan(3);
    await expect(run.done).resolves.toEqual({ built: true });
    expect(revocationIndexReady(db)).toBe(true);
    expect(run.stats.slices).toBeGreaterThan(5);
    validateMemorySchema(db); // slice-by-slice proof: the table equals what the JSON names, live writes included
    const built = refsOf(db);
    db.exec(`DELETE FROM memory_disclosure_refs; INSERT INTO memory_disclosure_refs ${revocationRefsExpectedSql({ lo: null, hi: null })}`.replaceAll("?1 IS NULL", "1").replaceAll("?2 IS NULL", "1"));
    expect(built).toEqual(refsOf(db));
    differential(db, ["2", "3", "r4"], []);
    expect(simulatedMs).toBeGreaterThan(0);
  } finally { vi.useRealTimers(); closeAndRemove(db, dir); }
});

it("a slice is a short writer transaction: an owner write between slices waits for one slice, never for the build", async () => {
  const { db, dir } = openFile(2000);
  try {
    const writes: number[] = [];
    const run = startRevocationIndexBackfill(db, { slice: 100, targetMs: 0.0001, pauseMs: 0, busyPauseMs: 0, busy: () => true });
    const probe = setInterval(() => {
      const t0 = performance.now();
      db.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS probe_writes(x); INSERT INTO probe_writes VALUES(1); COMMIT");
      writes.push(performance.now() - t0);
    }, 3);
    await run.done; clearInterval(probe);
    expect(revocationIndexReady(db)).toBe(true);
    expect(writes.length).toBeGreaterThan(2);
    // a probe runs between slices, so it never waits (single connection); the slices themselves stay bounded
    expect(Math.max(...writes)).toBeLessThan(250);
    expect(run.stats.maxSliceMs).toBeLessThan(500);
    expect(run.stats.slices).toBeGreaterThan(5);
  } finally { closeAndRemove(db, dir); }
});

it("a build stopped part-way resumes from the persisted cursor on a new connection, picks up what was written while it was down, and finishes", async () => {
  const { db, dir, file } = openFile(500);
  try {
    expect(buildRevocationIndexStep(db, 100)).toMatchObject({ ready: false, done: 100 });
    expect(buildRevocationIndexStep(db, 100)).toMatchObject({ ready: false, done: 200 });
    const cursor = db.prepare("SELECT cursor FROM memory_revocation_index_build").get()!.cursor;
    expect(cursor).toBeTruthy();
    db.close(); dbs.splice(dbs.indexOf(db), 1);
    const again = new DatabaseSync(file); dbs.push(again);
    again.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
    expect(again.prepare("SELECT ready,cursor,done FROM memory_revocation_index_build").get()).toMatchObject({ ready: 0, cursor, done: 200 });
    again.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('zz-after-restart','t','d','[{\"id\":\"9\",\"version\":1}]','[]',0,0,0,'prepared',0)").run();
    await expect(startRevocationIndexBackfill(again, { slice: 100, pauseMs: 1 }).done).resolves.toEqual({ built: true });
    expect(revocationIndexReady(again)).toBe(true);
    validateMemorySchema(again);
    expect(again.prepare("SELECT count(*) AS n FROM memory_disclosure_refs WHERE bundle_id='zz-after-restart'").get()!.n).toBe(1);
  } finally { closeAndRemove(dbs[dbs.length - 1] ?? db, dir); }
});

it("a process killed in the middle of the build leaves a correct file; the next start resumes and finishes", async () => {
  const { db, dir, file } = openFile(1500);
  db.close(); dbs.splice(dbs.indexOf(db), 1);
  const child = fork(join(import.meta.dirname, "testing", "index-build-child.ts"), [file], { execArgv: ["--experimental-strip-types", "--no-warnings"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<void>(res => child.once("exit", () => res()));
  await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error("child never reported progress")), 20_000); child.on("message", (m: { type?: string }) => { if (m.type === "progress") { clearTimeout(t); res(); } }); });
  child.kill("SIGKILL"); await exited;
  const after = new DatabaseSync(file); dbs.push(after);
  try {
    after.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
    expect(after.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    const row = after.prepare("SELECT ready,done FROM memory_revocation_index_build").get()!;
    expect(Number(row.ready)).toBe(0); // the child is stopped before its last slice
    expect(finishRevocationIndexAtStartup(after, { slice: 200 })).toEqual({ built: true });
    expect(revocationIndexReady(after)).toBe(true);
    validateMemorySchema(after);
  } finally { closeAndRemove(after, dir); }
}, 60_000);

// Astra r2 P2-1: a slice is bounded by time (budget plus one chunk), not by rows alone; recovery cleanup is chunked and resumable.
const spin = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* a slow disk stand-in */ } };

it("the slice size starts small, grows only within the target, shrinks at once on an overrun, and is capped", () => {
  expect(nextBackfillSliceRows(32, 1, 5)).toBeGreaterThan(32);
  expect(nextBackfillSliceRows(32, 20, 5)).toBeLessThan(16);
  expect(nextBackfillSliceRows(32, 5000, 5)).toBe(BACKFILL_MIN_ROWS);
  let size = BACKFILL_MAX_ROWS; for (let i = 0; i < 20; i++) size = nextBackfillSliceRows(size, 0.1, 5);
  expect(size).toBe(BACKFILL_MAX_ROWS);
});

it("under an artificially slow statement no background slice runs longer than its budget plus one chunk", async () => {
  const { db, dir } = openFile(800);
  try {
    const chunkMs = 8, budget = 5;
    let chunks = 0, inSlice = 0, worstChunksPerSlice = 0;
    const run = startRevocationIndexBackfill(db, { slice: 512, targetMs: budget, pauseMs: 1, busyPauseMs: 1, afterChunk: () => { chunks++; inSlice++; worstChunksPerSlice = Math.max(worstChunksPerSlice, inSlice); spin(chunkMs); } });
    const tickEnd = setInterval(() => { inSlice = 0; }, 0);
    await run.done; clearInterval(tickEnd);
    expect(revocationIndexReady(db)).toBe(true);
    expect(chunks).toBeGreaterThan(0);
    // the 512-row cap would be 32 chunks (over 250 ms); the time bound ends a slice after the chunk that crosses 5 ms
    expect(worstChunksPerSlice).toBeLessThanOrEqual(2); // 5 ms budget, 8 ms chunk: one chunk crosses it, so a slice is one chunk (two at most)
    expect(run.stats.maxSliceMs).toBeLessThan(120); // the unbounded 512-row slice is 32 chunks, over 250 ms; the rest is scheduler noise
    validateMemorySchema(db);
  } finally { closeAndRemove(db, dir); }
});

it("the background slice is admitted through the gate: nothing runs until it opens", async () => {
  const { db, dir } = openFile(100);
  try {
    let open_!: () => void; const gate = new Promise<void>(r => { open_ = r; });
    const run = startRevocationIndexBackfill(db, { slice: 20, pauseMs: 1, admit: () => gate });
    await new Promise(r => setTimeout(r, 60));
    expect(run.stats.slices).toBe(0);
    open_();
    await expect(run.done).resolves.toEqual({ built: true });
    expect(run.stats.slices).toBeGreaterThan(0);
  } finally { closeAndRemove(db, dir); }
});

it("an earlier lane's refs table is emptied in bounded chunks across steps, the flag stays unset meanwhile, and a new connection resumes", () => {
  const { db, dir, file } = openFile(1500);
  try {
    finishRevocationIndexAtStartup(db);
    const total = Number(db.prepare("SELECT count(*) AS n FROM memory_disclosure_refs").get()!.n);
    expect(total).toBeGreaterThan(RECOVERY_DELETE_CHUNK * 3);
    db.exec("DROP INDEX memory_disclosure_refs_ref; UPDATE memory_revocation_index_build SET ready=0");
    let left = total, steps = 0;
    const count = (c: DatabaseSync) => Number(c.prepare("SELECT count(*) AS n FROM memory_disclosure_refs").get()!.n);
    let conn = db;
    for (; steps < 1000; steps++) {
      const before = count(conn), cleaning = !conn.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name='memory_disclosure_refs_ref'").get();
      const step = buildRevocationIndexStep(conn, 32, { budgetMs: 0.0001 });
      if (cleaning) expect(before - count(conn)).toBeLessThanOrEqual(RECOVERY_DELETE_CHUNK); // one bounded delete per step
      if (cleaning && before > RECOVERY_DELETE_CHUNK) { expect({ steps, before, step }).toMatchObject({ step: { ready: false } }); expect(Number(conn.prepare("SELECT ready FROM memory_revocation_index_build").get()!.ready)).toBe(0); }
      if (steps === 2) { // a restart part-way through the cleanup
        conn.close(); dbs.splice(dbs.indexOf(conn), 1);
        conn = new DatabaseSync(file); dbs.push(conn); conn.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
        expect(count(conn)).toBeLessThan(total);
        expect(count(conn)).toBeGreaterThan(0);
      }
      if (step.ready) break;
      left = count(conn);
    }
    expect(steps).toBeGreaterThan(3);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(revocationIndexReady(conn)).toBe(true);
    expect(count(conn)).toBe(total);
    validateMemorySchema(conn);
  } finally { closeAndRemove(dbs[dbs.length - 1] ?? db, dir); }
});
