// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW Part A WP2b: the D0-D12 staged bulk of the age index (age-index.ts), on the real WAL core (index-wal.ts) where a line is measured
// and through MemoryIndex (index.ts) where the writer's dual writes (D5), purge (D6) and deletion paths (D8) are exercised.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGE_FILL_BELOW, AGE_FILL_BLOCKED, ageFillBlocked, agePhase, ageTestHooks, downgradeMemoryIndexFile, lexicalRowidsAged, MEMW_RETIRE_MERGE_PAGES, MEMW_RETIRE_STEP_ROWS, purgePendingHas, retireMergePages, retireStepRows } from "./age-index.ts";
import { type MemoryIndex, type IndexedMemory } from "./index.ts";
import { closeSealed, openTestIndex, put, settleIndex, workerTick } from "./testing/open-index.ts";
import { quarantineIndex } from "./index-quarantine.ts";
import { buildFixture, CALL_LINE_MS, driveStaged, ftsSegments, SEGMENT_GATE, type Fixture } from "./testing/age-staged-harness.ts";
import { MEMW_C_BYTES, MEMW_W_MERGE_BYTES, MEMW_W_STEP_BYTES } from "./memw-steps.ts";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "memw-wp2b-")); dirs.push(d); return d; };
beforeEach(() => { delete ageTestHooks.retireMergePages; delete ageTestHooks.retiredSegments; ageTestHooks.retireStepRows = 900; }); // 900: a test value only; the product constant is the owner's (unset fails closed)
afterEach(() => { delete ageTestHooks.retireMergePages; delete ageTestHooks.retiredSegments; delete ageTestHooks.retireStepRows; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ro = (path: string) => new DatabaseSync(path, { readOnly: true });
const q = <T = Record<string, unknown>>(path: string, sql: string, ...args: Array<string | number>) => { const db = ro(path); try { return db.prepare(sql).all(...args) as T[]; } finally { db.close(); } };
const metaOf = (path: string, key: string) => q<{ value: string }>(path, "SELECT value FROM index_meta WHERE key=?", key)[0]?.value;
const names = (path: string) => q<{ name: string }>(path, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name);
/** Every entries row sits in `lexical` at its authority age key, and nothing else is there. */
function agedExactly(fx: Fixture) {
  const auth = ro(fx.authPath), keys = new Map<string, number>();
  for (const r of auth.prepare("SELECT record_id AS id,age_key AS k FROM memory_record_keys").all()) keys.set(String(r.id), Number(r.k));
  auth.close();
  const rows = q<{ id: string; r: number }>(fx.indexPath, "SELECT e.id,k.fts_rowid AS r FROM entries e LEFT JOIN lexical_keys k ON k.id=e.id AND k.version=e.version");
  const wrong = rows.filter(row => row.r !== keys.get(String(row.id)));
  const ftsRows = Number(q<{ n: number }>(fx.indexPath, "SELECT count(*) AS n FROM lexical")[0]!.n);
  return { entries: rows.length, wrong: wrong.length, ftsRows };
}
/** The staged bulk through MemoryIndex, one worker tick per iteration (testing/open-index.ts workerTick: the 50 ms tick, maintenanceStep, the drain
 * seal), the age fill only when the worker's own gate says so (a step that ran nothing, gate clear, writer not owing a check). */
async function runIndex(index: MemoryIndex, auth: DatabaseSync, until: (r: ReturnType<MemoryIndex["fillAgeIndex"]>) => boolean = () => false, max = 100_000) {
  let last = await stepIndex(index, auth);
  for (let n = 0; n < max && index.ageFillOwed() && !until(last); n++) {
    if (last.waiting === "scrub") index.scrubDeleted(); // the worker's scrub; the cut waits for it (D8)
    if (last.waiting === "blocked") break;
    last = await stepIndex(index, auth);
  }
  await settleIndex(index);
  return last;
}
/** One worker iteration then, when the worker would, one fill step. A step the worker would not take returns the last result of a real fill call. */
async function stepIndex(index: MemoryIndex, auth: DatabaseSync, options: Parameters<MemoryIndex["fillAgeIndex"]>[1] = {}) {
  for (let n = 0; n < 2000; n++) {
    const tick = await workerTick(index);
    if (tick.fillMayRun) return index.fillAgeIndex(auth, options);
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
  return index.fillAgeIndex(auth, options); // the worker never ran the fill here (gate held): the call answers why
}
const addAuth = (fx: Fixture, id: string, key: number) => { const a = new DatabaseSync(fx.authPath); a.prepare("INSERT INTO memory_record_keys VALUES(?,1,'scope:0','active',0,'fact',?)").run(id, key); a.close(); };
const rec = (id: string, ageKey: number | null, extra: Partial<IndexedMemory> = {}): IndexedMemory => ({ id, version: 1, scopeId: "scope:0", text: `fresh words ${id}`, deleted: false, ageKey, ...extra });

describe("staged bulk on the real WAL core (T2(13) staged rows)", () => {
  it("every phase in order; every step rise <= W, merges <= W_merge, L <= C after every commit, every call <= 250 ms; lexical ends at age keys", async () => {
    const fx = buildFixture(dir(), 20_000, { mix: "mix", seed: 7, completePostings: false });
    const run = await driveStaged(fx);
    run.close();
    const s = run.stats;
    console.log(`[wp2b T2(13) 20k] steps ${s.steps} wall ${Math.round(s.wallMs)} ms maxL ${s.maxL} maxCall ${s.maxCallMs.toFixed(1)} ms seals ${s.seals} gate ${s.gateMerges} phases ${s.phases.join(">")} ` +
      Object.entries(s.byKind).map(([k, v]) => `${k}: n ${v.n} maxRise ${v.maxRise} maxMs ${v.maxMs.toFixed(1)} median ${v.medianMs.toFixed(1)}`).join("; "));
    expect(s.overruns).toEqual([]);
    expect(s.phases).toEqual(["fill", "validate", "keys", "stage_drop", "cut", "retiring", "none"]);
    for (const [kind, k] of Object.entries(s.byKind)) expect(k.maxRise, kind).toBeLessThanOrEqual(kind === "merge" ? MEMW_W_MERGE_BYTES : MEMW_W_STEP_BYTES);
    expect(s.maxL).toBeLessThanOrEqual(MEMW_C_BYTES);
    expect(s.maxCallMs).toBeLessThanOrEqual(CALL_LINE_MS);
    expect(agedExactly(fx)).toEqual({ entries: 20_000, wrong: 0, ftsRows: 20_000 });
    expect(names(fx.indexPath).filter(n => /^(age_|lexical_age|lexical_retired|purge_pending)/.test(n))).toEqual([]);
    expect(metaOf(fx.indexPath, "lexical_rowids")).toBe("age");
    // 1.8 T_t: lexical_age's counter, moved in every copy txn, became lexical's at the cut; the retired generation's left with it
    expect(Number(metaOf(fx.indexPath, "text_bytes:lexical"))).toBe(Number(q<{ n: number }>(fx.indexPath, "SELECT sum(length(CAST(text AS BLOB))) AS n FROM entries")[0]!.n));
    expect(q(fx.indexPath, "SELECT key FROM index_meta WHERE key LIKE '%bytes:lexical\\_%' ESCAPE '\\'")).toEqual([]);
    expect(q(fx.indexPath, "SELECT key FROM index_meta WHERE key LIKE 'age\\_%' ESCAPE '\\' OR key LIKE 'retire\\_%' ESCAPE '\\'")).toEqual([]);
  }, 600_000);
});

describe("D2 / D4 / D7: fail closed", () => {
  it("D2: a squatter at a prefix key blocks the whole prefix; nothing of it is copied and the frontier does not move", async () => {
    const fx = buildFixture(dir(), 600, { mix: "mix", seed: 3 });
    // the newest key is held in the stage by another record (a defect, never an eviction)
    const newest = Math.max(...Array.from({ length: 600 }, (_, i) => fx.keyOf(i)));
    const fx2 = fx;
    let index = await openTestIndex(fx2.indexPath); const auth = ro(fx2.authPath);
    await runIndex(index, auth, () => metaOf(fx2.indexPath, "age_sum_done") === "1"); // start + sum
    await closeSealed(index); // the foreign write below is made with the file closed: a live checked writer counts it as an overrun
    const raw = new DatabaseSync(fx2.indexPath);
    raw.prepare("INSERT INTO age_stage VALUES(?,?,1)").run(-newest, "intruder");
    raw.close();
    index = await openTestIndex(fx2.indexPath); await settleIndex(index);
    const step = await stepIndex(index, auth);
    expect(step).toMatchObject({ blocked: "fill_squatter", copied: 0 });
    expect(metaOf(fx2.indexPath, AGE_FILL_BELOW)).toBeUndefined();
    expect(q(fx2.indexPath, "SELECT rowid FROM lexical_age")).toEqual([]);
    expect(await stepIndex(index, auth)).toMatchObject({ waiting: "blocked", blocked: "fill_squatter" });
    expect(index.ageFillOwed()).toBe(true);
    await closeSealed(index); auth.close();
  });
  it("validate0: a b18 partial fill with a row at the wrong key removes age_fill_below in the same txn and blocks", async () => {
    const fx = buildFixture(dir(), 400, { mix: "mix", seed: 5 });
    const raw = new DatabaseSync(fx.indexPath);
    raw.exec("CREATE VIRTUAL TABLE lexical_age USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61'); CREATE TABLE lexical_age_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version));");
    const order = Array.from({ length: 400 }, (_, i) => i).sort((a, b) => fx.keyOf(b) - fx.keyOf(a)).slice(0, 50);
    order.forEach((i, n) => { const k = n === 10 ? fx.keyOf(i) + 1 : fx.keyOf(i); raw.prepare("INSERT INTO lexical_age(rowid,id,version,text) VALUES(?,?,1,'b18')").run(k, fx.idOf(i)); raw.prepare("INSERT INTO lexical_age_keys VALUES(?,1,?)").run(fx.idOf(i), k); });
    raw.prepare("INSERT INTO index_meta VALUES('age_fill_below',?)").run(String(fx.keyOf(order.at(-1)!)));
    raw.close();
    const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    const last = await runIndex(index, auth);
    expect(last.blocked ?? ageFillBlocked(ro(fx.indexPath))).toBe("validate0_key_mismatch");
    expect(metaOf(fx.indexPath, AGE_FILL_BELOW)).toBeUndefined();
    expect(metaOf(fx.indexPath, "age_phase")).toBe("validate0");
    await closeSealed(index); auth.close();
  });
});

describe("D5 dual writes and D6 / D8 deletion paths through MemoryIndex", () => {
  it("upserts, replacements and forgets in fill, validate and keys land at their keys; deletes take stage/emap rows; the end equals entries", async () => {
    const fx = buildFixture(dir(), 3_000, { mix: "mix", seed: 9 });
    const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    let next = 0;
    const touch = async (phase: string) => {
      await settleIndex(index); // the writer owes no check when a batch arrives (the worker's drain and the batch loop are exclusive)
      const id = `fresh:${phase}:${next++}`, key = 5_000_000_000 + next;
      addAuth(fx, id, key);
      expect(await index.applyBatch([rec(id, key), rec(fx.idOf(next), fx.keyOf(next), { text: `replaced ${phase}` }), rec(fx.idOf(next + 1500), fx.keyOf(next + 1500), { deleted: true })])).toEqual({ status: "done" });
      const a = new DatabaseSync(fx.authPath); a.prepare("DELETE FROM memory_record_keys WHERE record_id=?").run(fx.idOf(next + 1500)); a.close();
    };
    const seen = new Set<string>();
    let scrubWaits = 0;
    for (let n = 0; n < 20_000 && index.ageFillOwed(); n++) {
      if (index.deletionScrubPending()) scrubWaits++; // the worker tick (maintenanceStep) runs the scrub; the cut waits for it (D8)
      const step = await stepIndex(index, auth);
      expect(step.blocked).toBeUndefined();
      const phase = metaOf(fx.indexPath, "age_phase") ?? "none";
      if (!seen.has(phase) && ["fill", "validate", "keys", "stage_drop", "retiring"].includes(phase)) { seen.add(phase); await touch(phase); }
    }
    expect([...seen]).toEqual(["fill", "validate", "keys", "stage_drop", "retiring"]);
    expect(scrubWaits).toBeGreaterThan(0); // the forgets owed a scrub, and the cut waited for it
    const { wrong, entries, ftsRows } = agedExactly(fx);
    expect(wrong).toBe(0);
    expect(ftsRows).toBe(entries);
    expect(q(fx.indexPath, "SELECT text FROM lexical WHERE id=?", fx.idOf(1))).toEqual([{ text: "replaced fill" }]);
    await closeSealed(index); auth.close();
  });
  it("D5 destination check: another record at the key fails the batch `age-blocked`, the block is written, the fill stays stopped", async () => {
    const fx = buildFixture(dir(), 500, { mix: "mix", seed: 11 });
    let index = await openTestIndex(fx.indexPath); const auth = ro(fx.authPath);
    await runIndex(index, auth, r => r.phase === "fill" && r.copied > 0);
    const key = 7_000_000_000;
    await closeSealed(index); // the foreign write is made with the file closed
    const raw = new DatabaseSync(fx.indexPath); raw.prepare("INSERT INTO age_stage VALUES(?,'intruder',1)").run(-key); raw.close();
    index = await openTestIndex(fx.indexPath); await settleIndex(index);
    addAuth(fx, "fresh:x", key);
    const before = q(fx.indexPath, "SELECT count(*) AS n FROM entries")[0];
    expect(await index.applyBatch([rec("fresh:x", key)])).toEqual({ status: "failed", reason: "age-blocked", committed: 0 });
    expect(q(fx.indexPath, "SELECT count(*) AS n FROM entries")[0]).toEqual(before); // the whole group rolled back
    await index.maintenanceStep(); // the live check owed by the failed attempt
    expect(await stepIndex(index, auth)).toMatchObject({ waiting: "blocked", blocked: "dual_write_destination_other_record" });
    expect(metaOf(fx.indexPath, AGE_FILL_BLOCKED)).toBe("dual_write_destination_other_record");
    expect(await stepIndex(index, auth)).toMatchObject({ waiting: "blocked" });
    await closeSealed(index); auth.close();
  });
  it("D6: purgeRecords while MEMW objects exist lists the ids at once (unreadable), bounded steps remove every generation, the table drops", async () => {
    const fx = buildFixture(dir(), 2_000, { mix: "mix", seed: 13 });
    const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    await runIndex(index, auth, r => r.phase === "fill" && r.copied > 0);
    const copiedId = q<{ id: string }>(fx.indexPath, "SELECT id FROM age_stage LIMIT 1")[0]!.id, plainId = fx.idOf(0) === copiedId ? fx.idOf(1) : fx.idOf(0);
    expect(await index.purgeRecords([copiedId, plainId, "absent"])).toBe(3);
    const peek = ro(fx.indexPath);
    expect(purgePendingHas(peek, copiedId) && purgePendingHas(peek, plainId)).toBe(true);
    peek.close();
    await stepIndex(index, auth); // the purge step goes before any MEMW step
    for (const id of [copiedId, plainId]) {
      for (const t of ["entries", "lexical_keys", "lexical_age_keys", "age_stage", "vectors"]) expect(q(fx.indexPath, `SELECT 1 FROM ${t} WHERE id=?`, id), `${t} ${id}`).toEqual([]);
      expect(q(fx.indexPath, "SELECT 1 FROM lexical WHERE id=?", id)).toEqual([]);
      expect(q(fx.indexPath, "SELECT 1 FROM lexical_age WHERE id=?", id)).toEqual([]);
    }
    expect(names(fx.indexPath)).not.toContain("purge_pending");
    expect(metaOf(fx.indexPath, "merge_owed")).toBe("1");
    expect(index.entriesLive()).toBe(Number(q<{ n: number }>(fx.indexPath, "SELECT count(*) AS n FROM entries")[0]!.n));
    await closeSealed(index); auth.close();
  });
  it("D8 retiring: a forget of a record still in lexical_retired goes through lexical_retired_keys in the deletion txn", async () => {
    const fx = buildFixture(dir(), 1_000, { mix: "mix", seed: 17 });
    const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    await runIndex(index, auth, r => Boolean(r.cutover));
    expect(agePhase(ro(fx.indexPath))).toBe("retiring");
    const id = fx.idOf(3);
    expect(q(fx.indexPath, "SELECT 1 FROM lexical_retired_keys WHERE id=?", id)).toHaveLength(1);
    expect(await index.applyBatch([rec(id, fx.keyOf(3), { deleted: true })])).toEqual({ status: "done" });
    expect(q(fx.indexPath, "SELECT 1 FROM lexical_retired_keys WHERE id=?", id)).toEqual([]);
    expect(q(fx.indexPath, "SELECT 1 FROM lexical_retired WHERE id=?", id)).toEqual([]);
    expect(q(fx.indexPath, "SELECT 1 FROM lexical WHERE id=?", id)).toEqual([]);
    await closeSealed(index); auth.close();
  });
});

describe("D8 RETIRE step, reset, D11, D12", () => {
  it("a retirement delete step is min(800 rows, the D3 X budget): 64 KiB rows never ride one 800-row step", async () => {
    delete ageTestHooks.retireStepRows; // the product constant, 800
    const fx = buildFixture(dir(), 400, { mix: "huge", seed: 5, completePostings: false });
    const sizes: number[] = [];
    const run = await driveStaged(fx, { maxSteps: 30_000, onStep: r => { if (r.ran === "delete" && r.rows) sizes.push(r.rows); } });
    run.close();
    expect(agePhase(run.db)).toBeNull();
    expect(sizes.length).toBeGreaterThan(400 / 40); // many steps, not one 400-row step
    expect(Math.max(...sizes)).toBeLessThanOrEqual(40); // 0.8 W / rho / 64 KiB is about 16 rows; 40 is the slack
    expect(run.stats.overruns).toEqual([]);
  }, 300_000);
  it("retirement PROVABLY makes progress: every merge pass that ends above the 48-segment gate is followed by a delete step, so 3000 real-WAL rows retire inside a stated step bound", async () => {
    ageTestHooks.retireStepRows = 100; ageTestHooks.retiredSegments = 99; // a pass that ends above the gate, every time
    const fx = buildFixture(dir(), 3_000, { mix: "mix", seed: 7, completePostings: false });
    let deletes = 0, openers = 0;
    const run = await driveStaged(fx, { maxSteps: 30_000, onStep: r => { if (r.ran === "delete") { if (r.rows) deletes++; else openers++; } } });
    run.close();
    // bound: ceil(3000/100)=30 delete steps; a pass opens at most once per deletion run (+ the final empty pass); 30000 steps is far above that
    expect(agePhase(run.db)).toBeNull();
    expect(lexicalRowidsAged(run.db)).toBe(true);
    expect(run.stats.steps).toBeLessThan(30_000);
    expect(deletes).toBeGreaterThanOrEqual(Math.ceil(3_000 / 100));
    expect(openers).toBeLessThanOrEqual(deletes + 1); // no pass-opening step without a deletion since the last pass
  }, 300_000);
  it("RETIRE constant: p48 as ruled; an unset, zero or below-32 value fails closed at the first retirement step, nothing is deleted", async () => {
    expect(MEMW_RETIRE_MERGE_PAGES).toBe(48);
    expect(retireMergePages()).toBe(48);
    delete ageTestHooks.retireStepRows; expect(MEMW_RETIRE_STEP_ROWS).toBe(800);
    // MAIN RULING INT-CONFLICT-DEFAULT 052872805e / b36bf61264: the sizing constant stays 800; native write admission bounds an actual retirement step to 64 rows.
    expect(retireStepRows()).toBe(64);
    for (const bad of [0, -1, 1.5, Number.NaN]) { ageTestHooks.retireStepRows = bad; expect(() => retireStepRows(), String(bad)).toThrow("MEMW_RETIRE_STEP_ROWS_UNSET"); }
    ageTestHooks.retireStepRows = 900;
    for (const bad of [0, -5, 31, 1.5, Number.NaN, 65]) { ageTestHooks.retireMergePages = bad; expect(() => retireMergePages(), String(bad)).toThrow("MEMW_RETIRE_MERGE_PAGES_UNSET"); }
    delete ageTestHooks.retireMergePages;
    const fx = buildFixture(dir(), 300, { seed: 19 });
    const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    await runIndex(index, auth, r => Boolean(r.cutover));
    ageTestHooks.retireMergePages = 0;
    const left = q(fx.indexPath, "SELECT count(*) AS n FROM lexical_retired_keys")[0];
    expect(() => index.fillAgeIndex(auth)).toThrow("MEMW_RETIRE_MERGE_PAGES_UNSET");
    expect(q(fx.indexPath, "SELECT count(*) AS n FROM lexical_retired_keys")[0]).toEqual(left);
    await closeSealed(index); auth.close();
  });
  it("a reset (set quarantined, reopened fresh) carries no staged state: no phase, no MEMW objects, new rows at their keys at once", async () => {
    const fx = buildFixture(dir(), 800, { seed: 23 });
    let index = await openTestIndex(fx.indexPath); const auth = ro(fx.authPath);
    await runIndex(index, auth, r => r.phase === "keys");
    expect(agePhase(ro(fx.indexPath))).toBe("keys");
    await closeSealed(index);
    quarantineIndex(fx.indexPath);
    expect(existsSync(fx.indexPath)).toBe(false);
    index = await openTestIndex(fx.indexPath);
    expect(index.ageFillOwed()).toBe(false);
    expect(names(fx.indexPath).filter(n => /^(age_|lexical_age|lexical_retired|purge_pending)/.test(n))).toEqual([]);
    expect(q(fx.indexPath, "SELECT key FROM index_meta WHERE key LIKE 'age\\_%' ESCAPE '\\'")).toEqual([]);
    expect(index.fillAgeIndex(auth)).toMatchObject({ done: true, ran: null });
    expect(await index.applyBatch([rec(fx.idOf(5), fx.keyOf(5))])).toEqual({ status: "done" });
    expect(q(fx.indexPath, "SELECT rowid AS r FROM lexical WHERE id=?", fx.idOf(5))).toEqual([{ r: fx.keyOf(5) }]);
    await closeSealed(index); auth.close();
  });
  it("D11: statfs unknown waits and notes; a disk short of the reservation waits; nothing is written", async () => {
    const fx = buildFixture(dir(), 300, { seed: 29 });
    const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    await runIndex(index, auth, () => metaOf(fx.indexPath, "age_sum_done") === "1");
    const below = metaOf(fx.indexPath, AGE_FILL_BELOW);
    expect(index.fillAgeIndex(auth, { freeBytes: () => null })).toMatchObject({ waiting: "disk", ran: null });
    expect(index.fillAgeIndex(auth, { freeBytes: () => 100 * 1024 * 1024 })).toMatchObject({ waiting: "disk", ran: null });
    expect(metaOf(fx.indexPath, AGE_FILL_BELOW)).toBe(below);
    expect(index.fillAgeIndex(auth, { freeBytes: () => 64 * 1024 ** 3 }).ran).toBe("fill");
    await closeSealed(index); auth.close();
  });
  for (const at of ["fill", "keys", "retiring"] as const) it(`D12 downgrade from ${at}: open rule first, rows out by their mappings, survivors only, automerge 4 / crisismerge 16, no MEMW meta`, async () => {
    const fx = buildFixture(dir(), 1_200, { seed: 31 });
    const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    await runIndex(index, auth, r => at === "retiring" ? Boolean(r.cutover) : r.phase === at && r.copied + r.walked > 0);
    expect(await index.applyBatch([rec(fx.idOf(2), fx.keyOf(2), { text: "replaced" })])).toEqual({ status: "done" }); // P6: the batch is done, so a stop here is visible
    await closeSealed(index); auth.close();
    expect(await downgradeMemoryIndexFile(fx.indexPath, { stepRows: 100 })).toBe(true);
    expect(names(fx.indexPath).filter(n => !/^(lexical_(config|content|data|docsize|idx)|posting.*)$/.test(n))).toEqual(["entries", "index_meta", "lexical", "lexical_keys", "vectors"]);
    expect(q(fx.indexPath, "SELECT k,v FROM lexical_config WHERE k IN ('automerge','crisismerge') ORDER BY k")).toEqual([{ k: "automerge", v: 4 }, { k: "crisismerge", v: 16 }]);
    expect(q(fx.indexPath, "SELECT key FROM index_meta WHERE key LIKE 'age\\_%' ESCAPE '\\' OR key LIKE 'retire\\_%' ESCAPE '\\' OR key LIKE 'overrun\\_k:%' ESCAPE '\\' OR key IN ('wal_check','verified_through','lexical_keys_complete','entries_live','lexical_rowids')")).toEqual([]);
    expect(Number(q<{ n: number }>(fx.indexPath, "SELECT count(*) AS n FROM lexical")[0]!.n)).toBe(1_200);
    for (const s of ["-walstop", "-walok", "-walattempt"]) expect(existsSync(`${fx.indexPath}${s}`)).toBe(false);
  });
  it("D12 on a stopped file keeps the stop and writes nothing", async () => {
    const fx = buildFixture(dir(), 200, { seed: 37 });
    const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    await runIndex(index, auth, r => r.phase === "fill" && r.copied > 0);
    await closeSealed(index); auth.close();
    const raw = new DatabaseSync(fx.indexPath); raw.prepare("INSERT OR REPLACE INTO index_meta VALUES('wal_over_stop',?)").run(JSON.stringify({ reason: "test", kind: "fill", seq: 1 })); raw.exec("PRAGMA wal_checkpoint(TRUNCATE)"); raw.close();
    const before = names(fx.indexPath);
    expect(await downgradeMemoryIndexFile(fx.indexPath)).toBe(false);
    expect(names(fx.indexPath)).toEqual(before);
    expect(metaOf(fx.indexPath, "wal_over_stop")).toBeDefined();
    expect(metaOf(fx.indexPath, "age_phase")).toBe("fill");
    expect(lexicalRowidsAged(ro(fx.indexPath))).toBe(false);
  });

  // HIGH (WP3 S6): the staged fill and the sweep take the segment gate and the writer's admission exactly as applyBatch does.
  /** Level-0 segments in `table`, one per autocommit insert, with FTS5 merging off (what a floored table looks like). */
  const pump = (path: string, table: string, n: number) => {
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO ${table}(${table},rank) VALUES('automerge',0)`); raw.exec(`INSERT INTO ${table}(${table},rank) VALUES('crisismerge',1999)`);
    for (let i = 0; i < n; i++) raw.prepare(`INSERT INTO ${table}(rowid,id,version,text) VALUES(?,?,1,?)`).run(8_000_000_000_000 + i, `pump:${i}`, `pump word ${i}`);
    for (let i = 0; i < n; i++) raw.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(8_000_000_000_000 + i); // the rows go, the segments stay
    raw.close();
  };
  const segs = (path: string, table: string) => { const db = ro(path); try { return ftsSegments(db, table); } finally { db.close(); } };
  it("gate on the fill: a floored word table with a pending fill gains no segment, the phase does not move, and the fill resumes once the gate clears", async () => {
    const fx = buildFixture(dir(), 400, { seed: 51 });
    let index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    await runIndex(index, auth, r => r.phase === "fill" && r.copied > 0);
    await closeSealed(index);
    pump(fx.indexPath, "lexical", SEGMENT_GATE + 8);
    index = await openTestIndex(fx.indexPath);
    const before = { lexical: segs(fx.indexPath, "lexical"), age: segs(fx.indexPath, "lexical_age"), phase: metaOf(fx.indexPath, "age_phase") };
    expect(before.lexical).toBeGreaterThan(SEGMENT_GATE);
    for (let n = 0; n < 6; n++) { const step = index.fillAgeIndex(auth); expect(step.waiting).toBe("gate"); expect(step.copied).toBe(0); expect(step.ran).toBeNull(); }
    expect({ lexical: segs(fx.indexPath, "lexical"), age: segs(fx.indexPath, "lexical_age"), phase: metaOf(fx.indexPath, "age_phase") }).toEqual(before);
    for (let n = 0; n < 400 && segs(fx.indexPath, "lexical") > SEGMENT_GATE; n++) await index.maintenanceStep();
    expect(segs(fx.indexPath, "lexical")).toBeLessThanOrEqual(SEGMENT_GATE);
    const last = await runIndex(index, auth);
    expect(index.ageFillOwed()).toBe(false);
    expect(last.waiting).not.toBe("gate");
    await closeSealed(index); auth.close();
  });
  it("gate on the start: a floored word table holds the first fill step back; no phase, no age table", async () => {
    const fx = buildFixture(dir(), 200, { seed: 52 });
    pump(fx.indexPath, "lexical", SEGMENT_GATE + 8);
    const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    const names0 = names(fx.indexPath);
    for (let n = 0; n < 4; n++) expect(index.fillAgeIndex(auth).waiting).toBe("gate");
    expect(metaOf(fx.indexPath, "age_phase")).toBeUndefined();
    expect(names(fx.indexPath)).toEqual(names0);
    expect(names0).not.toContain("lexical_age");
    await closeSealed(index); auth.close();
  });
  it("gate on the sweep: a floored table gains no segment from the sweep, and the sweep resumes once the gate clears", async () => {
    const fx = buildFixture(dir(), 300, { seed: 53 });
    let index = await openTestIndex(fx.indexPath); const auth = ro(fx.authPath);
    await runIndex(index, auth);
    expect(index.ageFillOwed()).toBe(false);
    await closeSealed(index);
    pump(fx.indexPath, "lexical", SEGMENT_GATE + 8);
    index = await openTestIndex(fx.indexPath);
    const before = segs(fx.indexPath, "lexical");
    for (let n = 0; n < 4; n++) { const swept = index.sweepAgeRowids(auth, { maxRows: 64 }); expect(swept).toMatchObject({ busy: true, waiting: "gate", examined: 0, fixed: 0 }); }
    expect(segs(fx.indexPath, "lexical")).toBe(before);
    expect(metaOf(fx.indexPath, "age_sweep_after")).toBeUndefined();
    for (let n = 0; n < 400 && segs(fx.indexPath, "lexical") > SEGMENT_GATE; n++) await index.maintenanceStep();
    const swept = index.sweepAgeRowids(auth, { maxRows: 64 });
    expect(swept.busy).toBeUndefined();
    expect(swept.examined).toBeGreaterThan(0);
    await closeSealed(index); auth.close();
  });
  for (const mode of ["stopped", "checkOwed", "admit"] as const) it(`a writer that is ${mode}: neither the fill nor the sweep writes anything`, async () => {
    const fx = buildFixture(dir(), 300, { seed: 54 });
    let index = await openTestIndex(fx.indexPath); const auth = ro(fx.authPath);
    await runIndex(index, auth, r => r.phase === "fill" && r.copied > 0);
    const w = (index as unknown as { writer: Record<string, unknown> }).writer; // the seam writer: stopped/checkOwed/admit are its fields
    if (mode === "stopped") (w.markStopped as (k: string, n: number, r: string) => void).call(w, "unknown", 0, "test"); else if (mode === "checkOwed") w.checkOwed = () => true; else w.admit = () => false;
    const before = { lexical: segs(fx.indexPath, "lexical"), age: segs(fx.indexPath, "lexical_age"), phase: metaOf(fx.indexPath, "age_phase"), below: metaOf(fx.indexPath, "age_fill_below") };
    for (let n = 0; n < 4; n++) { const step = index.fillAgeIndex(auth); expect(step.busy).toBe(true); expect(step.copied).toBe(0); }
    expect({ lexical: segs(fx.indexPath, "lexical"), age: segs(fx.indexPath, "lexical_age"), phase: metaOf(fx.indexPath, "age_phase"), below: metaOf(fx.indexPath, "age_fill_below") }).toEqual(before);
    // the sweep half needs an aged index
    const fx2 = buildFixture(dir(), 200, { seed: 55 }), auth2 = ro(fx2.authPath), idx2 = await openTestIndex(fx2.indexPath);
    await runIndex(idx2, auth2); expect(idx2.ageFillOwed()).toBe(false);
    const w2 = (idx2 as unknown as { writer: Record<string, unknown> }).writer, b2 = segs(fx2.indexPath, "lexical");
    if (mode === "stopped") (w2.markStopped as (k: string, n: number, r: string) => void).call(w2, "unknown", 0, "test"); else if (mode === "checkOwed") w2.checkOwed = () => true; else w2.admit = () => false;
    expect(idx2.sweepAgeRowids(auth2, { maxRows: 64 })).toMatchObject({ busy: true, examined: 0, fixed: 0 });
    expect(segs(fx2.indexPath, "lexical")).toBe(b2); expect(metaOf(fx2.indexPath, "age_sweep_after")).toBeUndefined();
    await closeSealed(idx2); auth2.close();
    await closeSealed(index); auth.close();
  });
});

import { FTS_SEGMENT_LIMIT } from "./segment-limit.ts";
describe("RULING 2: lexical_retired config pin, gate and segment limit (R3, R4, R5)", () => {
  const segsOf = (path: string, table: string) => { const db = ro(path); try { return ftsSegments(db, table); } finally { db.close(); } };
  const cfg = (path: string, table: string) => Object.fromEntries(q<{ k: string; v: number }>(path, `SELECT k,v FROM ${table}_config WHERE k IN (\x27automerge\x27,\x27crisismerge\x27)`).map(r => [r.k, Number(r.v)]));
  /** A fixture cut over (retiring), closed and sealed. */
  const retiring = async (n: number, seed: number, mix: "mix" | "one-word" = "mix") => {
    const fx = buildFixture(dir(), n, { seed, mix }); const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    await runIndex(index, auth, r => Boolean(r.cutover));
    expect(agePhase(ro(fx.indexPath))).toBe("retiring");
    await closeSealed(index); auth.close(); return fx;
  };
  it("R3: the cut transaction pins automerge=0 and crisismerge=1999 on lexical_retired, even when lexical was at the FTS5 default at the cut", async () => {
    const fx = buildFixture(dir(), 400, { seed: 61 });
    let index = await openTestIndex(fx.indexPath); const auth = ro(fx.authPath);
    await runIndex(index, auth, r => r.phase === "fill" && r.copied > 0);
    const conn = (index as unknown as { db: DatabaseSync }).db; // the fixture sets the FTS5 default on the open connection, between steps
    conn.exec("INSERT INTO lexical(lexical,rank) VALUES(\x27automerge\x27,4)"); conn.exec("INSERT INTO lexical(lexical,rank) VALUES(\x27crisismerge\x27,16)");
    expect(cfg(fx.indexPath, "lexical")).toEqual({ automerge: 4, crisismerge: 16 }); // the fixture is at the default when the cut runs
    await runIndex(index, auth, r => Boolean(r.cutover));
    expect(agePhase(ro(fx.indexPath))).toBe("retiring");
    expect(cfg(fx.indexPath, "lexical_retired")).toEqual({ automerge: 0, crisismerge: 1999 });
    await closeSealed(index); auth.close();
  });
  it("R4: lexical_retired counts at the segment gate: 150 one-record forgets (one level-0 segment each) are all written, and the table never stands above the gate plus the one segment a write adds", async () => {
    const fx = await retiring(200, 62, "one-word");
    // The growing-segment case is an inherited FTS generation without secure
    // deletion. A current generation erases these rows in place and does not
    // create the 150 level-0 segments this gate regression must exercise.
    const legacy = new DatabaseSync(fx.indexPath);
    try { legacy.exec("INSERT INTO lexical_retired(lexical_retired,rank) VALUES('secure-delete',0)"); }
    finally { legacy.close(); }
    const index = await openTestIndex(fx.indexPath);
    let peak = 0, notDone = 0;
    for (let i = 0; i < 150; i++) {
      const res = await index.applyBatch([rec(fx.idOf(i), fx.keyOf(i), { deleted: true })]);
      if (res.status !== "done") { notDone++; break; }
      peak = Math.max(peak, segsOf(fx.indexPath, "lexical_retired"));
    }
    expect(notDone).toBe(0);
    expect(peak).toBeGreaterThan(SEGMENT_GATE - 5); // the forgets did climb to the gate
    expect(peak).toBeLessThanOrEqual(SEGMENT_GATE + 1);
    await closeSealed(index);
  });
  it("R5: a lexical_retired at FTS_SEGMENT_LIMIT-100 stops the writer segment_limit:lexical_retired, as lexical does", async () => {
    for (const table of ["lexical_retired", "lexical"]) {
      const fx = await retiring(300, table === "lexical" ? 71 : 72);
      const index = await openTestIndex(fx.indexPath);
      const holder = index as unknown as { segmentCount: (t?: string) => number; openState: string };
      const real = holder.segmentCount.bind(index);
      holder.segmentCount = (t = "lexical") => (t === table ? FTS_SEGMENT_LIMIT - 100 : real(t));
      await index.maintenanceStep();
      expect(holder.openState).toBe("stopped");
      expect(metaOf(fx.indexPath, "wal_over_stop")).toContain(`segment_limit:${table}`);
      try { await closeSealed(index); } catch { /* a stopped writer */ }
    }
  });
});

import { wordTerms } from "./postings.ts";
import { frameBytes, unitCost } from "./memw-steps.ts";
import { postingsCost } from "./index.ts";
describe("r4.1: distinct-term inline cost, scratch and deferred oversize debt (P2, P3, P4)", () => {
  type UnitsOf = { units(r: IndexedMemory[]): Array<{ cost: number }>; writer: { pageSize: number; L(): number } };
  // AGREED OVERSIZE r4.1: cost_post (lines 51, 129; D12 retained at line 366).
  // The inline 2(d) term stays; each tokenization additionally prices ceil(4 * UTF8 / page) + 8 scratch frames.
  const scratch = (text: string, page: number) => text.length ? Math.ceil(4 * Buffer.byteLength(text, "utf8") / page) + 8 : 0;
  const words = (n: number, tag = "w") => Array.from({ length: n }, (_, i) => `${tag}${i}x`).join(" ");
  const storedBytes = (path: string, id: string) => Number(q<{ n: number }>(path, "SELECT length(CAST(id AS BLOB))+length(CAST(scope_id AS BLOB))+length(CAST(text AS BLOB)) AS n FROM entries WHERE id=?", id)[0]?.n ?? 0);
  it("P2: units() prices distinct inline terms plus scratch; repeated words count once", async () => {
    const fx = buildFixture(dir(), 50, { seed: 81 });
    const index = await openTestIndex(fx.indexPath);
    const u = index as unknown as UnitsOf, ps = u.writer.pageSize;
    for (const [text, distinct] of [["alpha alpha alpha alpha alpha alpha beta", 2], [words(40), 40], ["same ".repeat(300), 1]] as const) {
      const row = rec("fresh:1", 5_000_000, { text });
      const cost = u.units([row])[0]!.cost;
      const expected = unitCost({ id: row.id, scopeId: row.scopeId, text, deleted: false, stored: 0 }, ps) + (distinct + Math.ceil(distinct / 8) + 4 + scratch(text, ps)) * frameBytes(ps);
      expect(cost).toBe(expected);
    }
    expect(postingsCost(2, 4096)).toBe((2 + 1 + 4) * frameBytes(4096));
    await closeSealed(index);
  });
  it("P3: replacing 300 old terms prices deferred debt and three scratch uses; a fresh insert has only new inline terms", async () => {
    const fx = buildFixture(dir(), 50, { seed: 82 });
    const index = await openTestIndex(fx.indexPath);
    await put(index, [rec("big:1", 5_000_001, { text: words(300) })]);
    const u = index as unknown as UnitsOf, ps = u.writer.pageSize;
    const stored = storedBytes(fx.indexPath, "big:1");
    const replaced = u.units([rec("big:1", 5_000_001, { text: "x" })])[0]!.cost;
    const fresh = u.units([rec("fresh:2", 5_000_002, { text: "x" })])[0]!.cost;
    const base = (s: number, id: string) => unitCost({ id, scopeId: "scope:0", text: "x", deleted: false, stored: s }, ps);
    const oldText = words(300);
    // Oversize old side contributes no inline terms: debt parts cost 8 * (UTF8(old) + 64), independently of the two old scratch uses.
    expect(replaced).toBe(base(stored, "big:1") + (1 + 1 + 4 + 2 * scratch(oldText, ps) + scratch("x", ps)) * frameBytes(ps) + 8 * (Buffer.byteLength(oldText, "utf8") + 64));
    expect(fresh).toBe(base(0, "fresh:2") + (1 + 1 + 4 + scratch("x", ps)) * frameBytes(ps));
    await closeSealed(index);
  });
  /** WAL frames of the postings table written between two log lengths (the frame header holds the page number; dbstat names the page). */
  const postingsFrames = (path: string, from: number, to: number, fb: number) => {
    const fd = openSync(`${path}-wal`, "r"), pages: number[] = [];
    try { const b = Buffer.alloc(4); for (let i = Math.round((from - 32) / fb); i < Math.round((to - 32) / fb); i++) { readSync(fd, b, 0, 4, 32 + i * fb); pages.push(b.readUInt32BE(0)); } } finally { closeSync(fd); }
    const db = ro(path), names = new Map<number, string>();
    try { for (const r of db.prepare("SELECT pageno, name FROM dbstat").all()) names.set(Number(r.pageno), String(r.name)); } finally { db.close(); }
    return pages.filter(p => names.get(p) === "postings").length;
  };
  it("P4: an oversize forget writes no posting frames and leaves durable debt at both 1,000 and 8,000 records", async () => {
    for (const n of [1_000, 8_000]) {
      const fx = buildFixture(dir(), 50, { seed: 83 });
      const index = await openTestIndex(fx.indexPath);
      for (let i = 0; i < n; i += 200) await put(index, Array.from({ length: Math.min(200, n - i) }, (_, j) => rec(`bg:${i + j}`, 6_000_000 + i + j, { text: Array.from({ length: 12 }, (_, k) => `v${((i + j) * 7919 + k * 104729) % 5000}`).join(" ") })));
      const id = "p4:big", text = words(300, "p");
      await put(index, [rec(id, 5_900_000, { text })]);
      await settleIndex(index);
      const T = wordTerms(text).length, u = index as unknown as UnitsOf, fb = frameBytes(u.writer.pageSize);
      await index.sealAndTruncate();
      const from = u.writer.L();
      const seq = Number(q<{ seq: number }>(fx.indexPath, "SELECT rowid AS seq FROM entries WHERE id=?", id)[0]!.seq);
      expect(await index.applyBatch([rec(id, 5_900_000, { deleted: true })])).toEqual({ status: "done" });
      const to = u.writer.L();
      const frames = postingsFrames(fx.indexPath, to > from ? from : 32, to, fb);
      // r4.1 D4/G4: oversize deletion is acknowledged now, with physical posting work in bounded debt steps.
      expect(T).toBeGreaterThan(256);
      expect(frames, "oversize forget wrote postings inline").toBe(0);
      expect(q(fx.indexPath, "SELECT 1 FROM entries WHERE id=?", id)).toEqual([]);
      expect(Number(q<{ n: number }>(fx.indexPath, "SELECT count(*) AS n FROM posting_drop WHERE seq=?", seq)[0]!.n)).toBeGreaterThan(0);
      await closeSealed(index);
    }
  });
});

describe("RULING 1 and 2c: units() copies (R1b, R2)", () => {
  type U = { units(r: IndexedMemory[]): Array<{ cost: number }>; writer: { pageSize: number } };
  it("R1b: while the fill runs units() = 2 x unitCost + 9 frames + the postings term; before it, 1 x unitCost + the postings term", async () => {
    const fx = buildFixture(dir(), 400, { seed: 91 });
    const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    const u = index as unknown as U, ps = u.writer.pageSize, fz = frameBytes(ps);
    const row = rec("fresh:r1b", 5_100_000, { text: "alpha beta" });
    const unit = unitCost({ id: row.id, scopeId: row.scopeId, text: row.text, deleted: false, stored: 0 }, ps), post = postingsCost(2, ps) + (Math.ceil(4 * Buffer.byteLength(row.text, "utf8") / ps) + 8) * fz; // r4.1 cost_post adds scratch; the 2(d) inline term is unchanged
    expect(u.units([row])[0]!.cost).toBe(unit + post);
    // This case prices a dual copy, not worker scheduling. Establish that state with real checked age writes;
    // draining every unrelated legacy posting first makes the fixture depend on history-wide deferred work.
    let copied = 0;
    for (let step = 0; step < 8 && copied === 0; step++) {
      copied += index.fillAgeIndex(auth).copied;
      expect((await index.sealAndTruncate()).truncated).toBe(true);
    }
    expect(copied).toBeGreaterThan(0);
    expect(agePhase((index as unknown as { db: DatabaseSync }).db)).toBe("fill");
    expect(u.units([row])[0]!.cost).toBe(2 * unit + 9 * fz + post);
    await closeSealed(index); auth.close();
  });
  it("R2: sixteen forgets of 64 KiB records still in lexical_retired go through one group within its reserve", async () => {
    const fx = buildFixture(dir(), 120, { mix: "huge", seed: 92 });
    const index = await openTestIndex(fx.indexPath), auth = ro(fx.authPath);
    await runIndex(index, auth, r => Boolean(r.cutover));
    expect(agePhase(ro(fx.indexPath))).toBe("retiring");
    const rows = Array.from({ length: 16 }, (_, i) => rec(fx.idOf(i), fx.keyOf(i), { deleted: true }));
    expect(await index.applyBatch(rows)).toEqual({ status: "done" });
    for (const r of rows) expect(q(fx.indexPath, "SELECT 1 FROM lexical_retired_keys WHERE id=?", r.id)).toEqual([]);
    await closeSealed(index); auth.close();
  });
});
