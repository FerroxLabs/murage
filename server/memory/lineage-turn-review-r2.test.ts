// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 review round 2 of the per-turn lineage work (Astra BLOCK on 55d71541d):
//   P1. two root sets that share a receipt: the second set's kept proof lost the receipt's dependencies, so after a soft
//       source-revision change a warm replay showed the second output where a cold replay withheld it;
//   P2. the per-turn capability generation was part of the reader's cache key, so every turn judged the ancestry again.
// Plus the class: a kept answer must always equal a cold one, over random sequences of the changes that matter.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { filterMemoryReplay } from "./disclosures.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { chainStore } from "./schema.ts";
import { keptVerdictCount, recordRestsOnWithheldMessage, replayExclusions, type ReplayAudience, setTurnLineageNodesForTest } from "./replay-lineage.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const thread = "r2-direct";
const key = (message: string) => `${thread}\u0000${message}`;
// closeDatabase stops the WAL checkpointer without waiting; one still alive when the data dir is rebuilt removes the NEW file's -wal/-shm by path,
// so rows of the previous run resurface (UNIQUE memory_sources.id). The checkpointer is awaited after every close.
beforeEach(async () => { setTurnLineageNodesForTest(null); closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const tally = { rows: 0 };
const realPrepare = DatabaseSync.prototype.prepare;
beforeAll(() => {
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = realPrepare.call(this, sql);
    const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    const get = statement.get.bind(statement), all = statement.all.bind(statement);
    own.get = (...args) => { const row = (get as (...a: unknown[]) => unknown)(...args); if (row) tally.rows++; return row; };
    own.all = (...args) => { const rows = (all as (...a: unknown[]) => unknown[])(...args); tally.rows += rows.length; return rows; };
    return statement;
  } as typeof realPrepare;
});
afterAll(() => { DatabaseSync.prototype.prepare = realPrepare; });

function begin(): void {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
}
function addSource(id: string): void {
  const scope = ensureScope("conversation", thread);
  database().prepare("INSERT INTO memory_sources VALUES(?,?,NULL,NULL,NULL,1,'hash','text','owner','recorded',NULL,'active')").run(id, scope);
}
function addReceipt(bundle: string, outputs: string[], sources: string[]): void {
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d','[]',?,?,0,0,0,'delivered',9)")
    .run(bundle, thread, JSON.stringify(sources.map(id => ({ id, revision: 1 }))), JSON.stringify(outputs));
}
/** `root` is a single-root set; `out` is a reply whose output roots are that set. */
function addReply(out: string, ...roots: string[]): void {
  const db = database(), write = chainStore(db);
  const set = write(null, 0, roots.map(key));
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, out, set);
}
/** What the owner's change of a reader's access does: a revocation-relevant write (a scope binding changes). */
let bumps = 0;
function bumpAuthority(): void { database().prepare("DELETE FROM memory_scopes WHERE id=?").run(ensureScope("conversation", `bump-${bumps++}`)); }
let readers = 0;
const reader = (revoked: (row: Record<string, unknown>) => boolean, cacheKey: string): ReplayAudience => ({ policyRevision: 0, deletionEpoch: 0, revoked, cacheKey });
const cold = (revoked: (row: Record<string, unknown>) => boolean) => reader(revoked, `cold-${readers++}`);
const shown = (window: string[], audience: ReplayAudience) => [...replayExclusions(LineageAllowance.tool(1_000_000_000), thread, window.map(id => ({ id, role: "bot" })), audience, { failClosed: true })].sort();

it("P1: two root sets sharing a receipt both fall with the evidence the receipt cites (warm equals cold)", () => {
  begin();
  addSource("doc:s1");
  addReceipt("shared", ["rootA", "rootB"], ["doc:s1"]);
  addReply("outA", "rootA"); addReply("outB", "rootB");
  const never = () => false, audience = reader(never, "reader-a");
  const window = ["outA", "outB"];
  expect(shown(window, audience)).toEqual([]);
  expect(shown(window, audience)).toEqual([]);
  expect(keptVerdictCount()).toBeGreaterThan(0);
  // the cited source is revised (still active): the receipt cited the old words
  database().prepare("UPDATE memory_sources SET revision=2 WHERE id='doc:s1'").run();
  expect(shown(window, cold(never))).toEqual(["outA", "outB"]);
  expect(shown(window, audience)).toEqual(["outA", "outB"]);
});

it("P1: the same when the first judgement of the receipt was outside any kept proof", () => {
  begin();
  addSource("doc:s1");
  addReceipt("shared", ["rootA", "rootB", "direct"], ["doc:s1"]);
  addReply("outA", "rootA"); addReply("outB", "rootB");
  const never = () => false, audience = reader(never, "reader-a");
  // 'direct' is listed by the receipt itself: judged first, with no proof being kept, then the two sets reuse that verdict
  const window = ["direct", "outA", "outB"];
  expect(shown(window, audience)).toEqual([]);
  expect(shown(window, audience)).toEqual([]);
  database().prepare("UPDATE memory_sources SET revision=2 WHERE id='doc:s1'").run();
  expect(shown(window, cold(never))).toEqual(["direct", "outA", "outB"]);
  expect(shown(window, audience)).toEqual(["direct", "outA", "outB"]);
});

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let activations = 0;
function activateFact(): void {
  const db = database(), id = `fact-${activations++}`, scope = ensureScope("conversation", thread);
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'assistant-inference','candidate',0,?,NULL,NULL,?)").run(id, scope, `a learned fact ${id}`, Date.now(), Date.now());
  db.prepare("UPDATE memory_records SET state='active',assertion=?,kind=? WHERE id=? AND version=1").run("owner-statement", "fact", id);
}

it("a kept answer always equals a cold one over random sequences of activation, revision, forget, deny and permission changes", async () => {
  const seedBase = Number(process.env.R2_SEED_BASE ?? 0); // a different 30 seeds on request, to hunt
  for (let seed = 1 + seedBase; seed <= 30 + seedBase; seed++) {
    closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const random = prng(seed), pick = (n: number) => Math.floor(random() * n);
    begin();
    const sources = Array.from({ length: 4 }, (_, at) => `doc:s${at}`);
    for (const id of sources) addSource(id);
    // 6 receipts over 8 roots: they share roots, share sources, and some cite nothing
    const rootCount = 8, receiptCount = 6;
    for (let at = 0; at < receiptCount; at++) {
      const outputs = Array.from({ length: rootCount }, (_, r) => r).filter(() => random() < 0.4).map(r => `root${r}`);
      if (!outputs.length) outputs.push(`root${at}`);
      const cited = sources.filter(() => random() < 0.4);
      // distinct frames so the receipts are distinct groups
      addReceipt(`rc${at}`, outputs, cited);
    }
    const outs: string[] = [];
    for (let at = 0; at < 6; at++) {
      const roots = Array.from({ length: rootCount }, (_, r) => r).filter(() => random() < 0.35).map(r => `root${r}`);
      if (!roots.length) roots.push(`root${at}`);
      addReply(`out${at}`, ...roots); outs.push(`out${at}`);
    }
    const denied = new Set<string>();
    const revoked = (row: Record<string, unknown>) => (JSON.parse(String(row.bundles)) as string[]).some(id => denied.has(id));
    const audience = reader(revoked, `warm-${seed}`);
    const trace: string[] = [];
    const check = () => {
      const warm = shown(outs, audience), fresh = shown(outs, cold(revoked));
      expect(warm, `seed ${seed} after ${trace.join(", ")}`).toEqual(fresh);
    };
    check(); check();
    for (let step = 0; step < 12; step++) {
      const op = pick(6);
      if (op === 0) { const id = sources[pick(sources.length)]!; database().prepare("UPDATE memory_sources SET revision=revision+1 WHERE id=?").run(id); trace.push(`revise ${id}`); }
      else if (op === 1) { const id = sources[pick(sources.length)]!; database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(id); trace.push(`forget ${id}`); }
      else if (op === 2) { activateFact(); trace.push("activate"); }
      else if (op === 3) { denied.add(`rc${pick(receiptCount)}`); bumpAuthority(); trace.push(`deny ${[...denied]}`); }
      else if (op === 4) { denied.clear(); bumpAuthority(); trace.push("permit all"); }
      else { bumpAuthority(); trace.push("permission change"); }
      check();
    }
  }
}, 600_000);

// ---- P2 -------------------------------------------------------------------------------------------------------------------------

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "private" }], groups: [] };
function turnAccess(registry: InternalCapabilities) {
  const generation = registry.begin("bot", "private");
  const token = registry.mint({ botId: "bot", threadId: "private", generation, kind: "memory", depth: 100, skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
function receiptReplies(roots: number): string[] {
  const db = database(), write = chainStore(db);
  const keys = Array.from({ length: roots }, (_, at) => `private\u0000q${at}`);
  // a chain of sets of 600 roots each, as a session's output roots grow turn by turn
  let set: string | null = null, end = 0;
  for (let at = 0; at < keys.length; at += 600) { set = write(set, end, keys.slice(at, at + 600)); end = Math.min(keys.length, at + 600); }
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES('private','answer',?)").run(set);
  // every root has a receipt of its own (written differently, so each is a distinct group)
  const insert = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,'private','d',?,'[]',?,0,0,0,'delivered',9)");
  db.exec("BEGIN");
  for (let at = 0; at < roots; at++) insert.run(`rc${at}`, `[${" ".repeat(at % 97)}${"\t".repeat(Math.floor(at / 97))}]`, JSON.stringify([`q${at}`]));
  db.exec("COMMIT");
  return ["answer"];
}
const lines = () => [{ id: "answer", role: "bot", kind: "text", text: "answer" }];

it("P2: a new turn generation for the same reader reuses the kept answers (rows and kept verdicts stay flat)", () => {
  // The first turn judges 3,000 receipts of its own (3,000 distinct groups): more than one turn's allowance, which is what a cold turn
  // withholds on (lineage-cold-turn.test.ts). This test pins what the turns AFTER the first read, so the first is given the room to finish.
  setTurnLineageNodesForTest(1_000_000_000);
  reconcileMemoryRoster(roster);
  setMemoryMode("active");
  const registry = new InternalCapabilities();
  receiptReplies(3_000);
  const first = turnAccess(registry);
  const before = tally.rows;
  expect(filterMemoryReplay(LineageAllowance.tool(), "private", lines(), first, { failClosed: true }).map(m => m.id)).toEqual(["answer"]);
  const firstRows = tally.rows - before, kept = keptVerdictCount();
  expect(firstRows).toBeGreaterThan(3_000);
  for (let generation = 0; generation < 3; generation++) {
    const access = turnAccess(registry);
    const mark = tally.rows;
    expect(filterMemoryReplay(LineageAllowance.tool(), "private", lines(), access, { failClosed: true }).map(m => m.id)).toEqual(["answer"]);
    expect(tally.rows - mark).toBeLessThan(firstRows / 10);
    expect(keptVerdictCount()).toBe(kept);
  }
});

it("P2: a revoked capability still denies, with the kept answers warm", () => {
  reconcileMemoryRoster(roster);
  setMemoryMode("active");
  const registry = new InternalCapabilities();
  receiptReplies(50);
  const old = turnAccess(registry);
  expect(filterMemoryReplay(LineageAllowance.tool(), "private", lines(), old, { failClosed: true }).length).toBe(1);
  const current = turnAccess(registry);   // the old generation is revoked by the new one
  expect(filterMemoryReplay(LineageAllowance.tool(), "private", lines(), current, { failClosed: true }).length).toBe(1);
  expect(() => filterMemoryReplay(LineageAllowance.tool(), "private", lines(), old, { failClosed: true })).toThrow("MEMORY_UNAUTHORIZED");
  registry.revokeThread("private");
  expect(() => filterMemoryReplay(LineageAllowance.tool(), "private", lines(), current, { failClosed: true })).toThrow("MEMORY_UNAUTHORIZED");
});

// ---- the chain cache (same class: audited, found to be flushed by the same keys; pinned so it stays so) -------------------------------------------------------------

it("a record's derivation chain is not served stale after a record in it changes its assertion", () => {
  reconcileMemoryRoster(roster);
  setMemoryMode("active");
  const db = database(), scope = ensureScope("bot", "bot");
  db.prepare("INSERT INTO memory_sources VALUES('message:private:m',?,'private','m',NULL,1,'hash','text','bot:bot','settled',NULL,'active')").run(scope);
  db.prepare("INSERT INTO memory_source_versions VALUES('message:private:m',1,'hash','{}',1)").run();
  const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,?,'active',0,1,NULL,?,1)");
  record.run("P", scope, "parent", "assistant-inference", null);
  record.run("C", scope, "child", "owner-statement", "P");
  db.prepare("INSERT INTO memory_evidence VALUES('P',1,'message:private:m',1,0,1)").run();
  db.prepare("INSERT INTO memory_derivations VALUES('P',1,'C',1)").run();
  // the reply 'm' is withheld: its receipt cites a record that is not there
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('bad','private','d',?,'[]','[\"m\"]',0,0,0,'delivered',9)").run(JSON.stringify([{ id: "gone", version: 1 }]));
  // an owner's correction does not carry the old words: the parent is history, not a dependency
  expect(recordRestsOnWithheldMessage(LineageAllowance.tool(1_000_000_000), "C", 1)).toBe(false);
  expect(recordRestsOnWithheldMessage(LineageAllowance.tool(1_000_000_000), "C", 1)).toBe(false);
  // the record stops being a correction: the parent is a dependency again
  db.prepare("UPDATE memory_records SET assertion='assistant-inference' WHERE id='C'").run();
  expect(recordRestsOnWithheldMessage(LineageAllowance.tool(1_000_000_000), "C", 1)).toBe(true);
});
