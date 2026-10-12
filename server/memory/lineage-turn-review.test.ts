// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 review round 1 of the per-turn lineage work (Astra BLOCK on afef761ce):
//   1. at the verdict cache's capacity a proof kept above an evicted proof lost its dependencies on it;
//   2. routine learning (a candidate becoming an active fact) dropped every stored root-set handle between turns;
//   3. a reader who is not the owner paid for the whole ancestry every turn.
// Work is pinned in rows read through the SQL layer (no clock), as lineage-turn-scale.test.ts does.
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { chainStore } from "./schema.ts";
import { mergeOutputRoots, outputRootsBad, outputRootsFor, recordOutputRoots, keptVerdictCount, recordSessionRoots, replayExclusions, sessionOutputRoots, setVerdictLimitForTest, type ReplayAudience } from "./replay-lineage.ts";

const thread = "review-direct", driver = "drv", session = "sess";
const key = (reply: number | string) => `${thread}\u0000r${reply}`;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => setVerdictLimitForTest(null));

const tally = { rows: 0, statements: 0 };
const realPrepare = DatabaseSync.prototype.prepare;
beforeAll(() => {
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = realPrepare.call(this, sql);
    const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    const get = statement.get.bind(statement), all = statement.all.bind(statement), run = statement.run.bind(statement);
    own.get = (...args) => { tally.statements++; const row = (get as (...a: unknown[]) => unknown)(...args); if (row) tally.rows++; return row; };
    own.all = (...args) => { tally.statements++; const rows = (all as (...a: unknown[]) => unknown[])(...args); tally.rows += rows.length; return rows; };
    own.run = (...args) => { tally.statements++; return (run as (...a: unknown[]) => unknown)(...args); };
    return statement;
  } as typeof realPrepare;
});
afterAll(() => { DatabaseSync.prototype.prepare = realPrepare; });
function sqlWork<T>(run: () => T): { value: T; rows: number } {
  const before = tally.rows;
  const value = run();
  return { value, rows: tally.rows - before };
}

function buildSession(n: number): string[] {
  const db = database(), write = chainStore(db), ids: string[] = [];
  db.exec("BEGIN");
  let parent: string | null = null;
  for (let index = 0; index < n; index++) { parent = write(parent, index, [key(index)]); ids.push(parent); }
  const pointer = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  for (let index = Math.max(0, n - 300); index < n; index++) pointer.run(thread, `r${index}`, ids[index]!);
  db.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES(?,?,?,?)").run(thread, driver, session, ids[n - 1]!);
  db.exec("COMMIT");
  return ids;
}
function turn(index: number, audience: ReplayAudience | null): void {
  const shown = outputRootsFor([{ threadId: thread, id: `r${index - 1}`, role: "bot" }]);
  const roots = mergeOutputRoots(mergeOutputRoots(shown, { roots: new Set([key(index)]), over: false }), sessionOutputRoots(thread, driver, session));
  recordSessionRoots(thread, driver, session, roots);
  recordOutputRoots(thread, `r${index}`, roots);
  expect(outputRootsBad(sessionOutputRoots(thread, driver, session))).toBe(false);
  const window = Array.from({ length: 100 }, (_, back) => ({ id: `r${index - 1 - back}`, role: "bot" }));
  expect(replayExclusions(thread, window, audience, { failClosed: true }).size).toBe(0);
}
let activations = 0;
/** What automatic learning does between two turns: a candidate becomes an active fact (assertion and kind set as it goes active). */
function activateFact(): void {
  const db = database(), id = `fact-${activations++}`, scope = ensureScope("conversation", thread);
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'assistant-inference','candidate',0,?,NULL,NULL,?)").run(id, scope, `a learned fact ${id}`, Date.now(), Date.now());
  db.prepare("UPDATE memory_records SET state='active',assertion=?,kind=? WHERE id=? AND version=1").run("owner-statement", "fact", id);
}
function measure(size: number, audience: ReplayAudience | null, between: () => void): number {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  database();
  buildSession(size);
  turn(size, audience); turn(size + 1, audience);
  let rows = 0;
  for (let index = 0; index < 3; index++) { between(); rows += sqlWork(() => turn(size + 2 + index, audience)).rows; }
  return rows / 3;
}
const flat = (run: (size: number) => number, ceiling = 2_000) => {
  const small = run(5_000), medium = run(10_000), large = run(20_000);
  console.log(`LINEAGE-REVIEW 5k=${small} 10k=${medium} 20k=${large}`);
  expect(large / small).toBeLessThanOrEqual(1.3);
  expect(medium / small).toBeLessThanOrEqual(1.3);
  expect(large).toBeLessThan(ceiling);
};
const reader = (revoked: (row: Record<string, unknown>) => boolean = () => false, cacheKey = "reader-a"): ReplayAudience => ({ policyRevision: 0, deletionEpoch: 0, revoked, cacheKey });

it("finding 2: a fact activated between turns does not make the next turn read the session's ancestry again", () => {
  flat(size => measure(size, null, activateFact));
}, 900_000);

it("finding 3: a reader who is not the owner pays for what the turn added, not for the ancestry", () => {
  flat(size => measure(size, reader(), () => {}));
}, 900_000);

it("finding 3: the same reader keeps its answers across a fact activation", () => {
  flat(size => measure(size, reader(), activateFact));
}, 900_000);

/** A reply `p` with a receipt that lists it, inside a chain of two sets; the reply and the set it rests on. */
function receiptFixture(): { window: Array<{ id: string; role: string }> } {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), write = chainStore(db);
  const base = write(null, 0, [key("p"), key("q")]), grown = write(base, 2, [key("s")]);
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, "out", grown);
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('rcpt',?,'d','[]','[]','[\"rp\"]',0,0,0,'delivered',9)").run(thread);
  return { window: [{ id: "out", role: "bot" }] };
}
it("finding 3: a permission change reaches a reader's kept answer", () => {
  const { window } = receiptFixture();
  let denied = false;
  const audience = reader(() => denied);
  expect(replayExclusions(thread, window, audience, { failClosed: true }).size).toBe(0);
  expect(replayExclusions(thread, window, audience, { failClosed: true }).size).toBe(0);
  expect(keptVerdictCount()).toBeGreaterThan(0);
  // the owner takes this reader's access away: a revocation-relevant write (a scope binding changes) and the reader's receipts no longer hold
  denied = true;
  database().prepare("DELETE FROM memory_scopes WHERE id=?").run(ensureScope("conversation", "someone-else"));
  expect(replayExclusions(thread, window, audience, { failClosed: true }).size).toBe(1);
});
it("finding 3: readers with different keys never share an answer", () => {
  const { window } = receiptFixture();
  const allowed = reader(() => false, "reader-a"), refused = reader(() => true, "reader-b");
  expect(replayExclusions(thread, window, allowed, { failClosed: true }).size).toBe(0);
  expect(replayExclusions(thread, window, refused, { failClosed: true }).size).toBe(1);
  expect(replayExclusions(thread, window, allowed, { failClosed: true }).size).toBe(0);
  // and content-only judging (the owner) is a third answer
  expect(replayExclusions(thread, window, null, { failClosed: true }).size).toBe(0);
});
it("finding 3: a forgotten root withholds for a reader whose answer was kept", () => {
  const { window } = receiptFixture();
  captureSource(database(), { id: `message:${thread}:rs`, threadId: thread, messageId: "rs", kind: "text", speaker: "owner", outcome: "recorded", text: "a root" });
  const audience = reader();
  expect(replayExclusions(thread, window, audience, { failClosed: true }).size).toBe(0);
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(`message:${thread}:rs`);
  expect(replayExclusions(thread, window, audience, { failClosed: true }).size).toBe(1);
});

/** Receipts for 40 replies of the middle of the chain, each citing nothing but written differently: 40 distinct kept verdicts, enough to make a small cache evict. */
function crowdMiddle(): void {
  const insert = database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d',?,'[]',?,0,0,0,'delivered',9)");
  for (let at = 0; at < 40; at++) insert.run(`crowd-${at}`, thread, `[${" ".repeat(at)}]`, JSON.stringify([`r${700 + at}`]));
}
it("finding 1: a proof kept above one the cache made room by evicting still falls with the evidence below it", () => {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), write = chainStore(db);
  const members = (from: number, to: number) => Array.from({ length: to - from }, (_, at) => key(from + at));
  // s0 holds the one early root; s1 and s2 add a chunk of roots each (a proof is kept per chunk of 512)
  const s0 = write(null, 0, [key(5)]), s1 = write(s0, 1, members(1_000, 1_600)), s2 = write(s1, 601, members(2_000, 2_600));
  const filler = write(null, 0, Array.from({ length: 1_300 }, (_, at) => key(`f${at}`)));
  captureSource(db, { id: `message:${thread}:r5`, threadId: thread, messageId: "r5", kind: "text", speaker: "owner", outcome: "recorded", text: "early" });
  const point = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  point.run(thread, "tip0", s0); point.run(thread, "tip2", s2); point.run(thread, "filler", filler);
  const rootsOf = (message: string) => outputRootsFor([{ threadId: thread, id: message, role: "bot" }]);
  expect(outputRootsBad(rootsOf("tip0"))).toBe(false);
  // a crowd of newer entries sits between the first proof and the next ones
  expect(outputRootsBad(rootsOf("filler"))).toBe(false);
  // room for 420 more: judging the next chunk makes the cache evict its oldest eighth, which takes the first proof but none of the chunk's own
  setVerdictLimitForTest(keptVerdictCount() + 420);
  expect(outputRootsBad(rootsOf("tip2"))).toBe(false);
  setVerdictLimitForTest(null);
  db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(`message:${thread}:r5`);
  expect(outputRootsBad(rootsOf("tip2"))).toBe(true);
  expect(outputRootsBad(rootsOf("tip0"))).toBe(true);
});
it("finding 1: the same at the replay filter's per-set proofs", () => {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  const db = database(), write = chainStore(db);
  const members = (from: number, to: number) => Array.from({ length: to - from }, (_, at) => key(from + at));
  const s0 = write(null, 0, members(0, 600)), s1 = write(s0, 600, members(600, 1_200)), s2 = write(s1, 1_200, members(1_200, 1_800));
  captureSource(db, { id: `message:${thread}:r5`, threadId: thread, messageId: "r5", kind: "text", speaker: "owner", outcome: "recorded", text: "early" });
  const point = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  point.run(thread, "tip0", s0); point.run(thread, "tip2", s2);
  crowdMiddle();
  setVerdictLimitForTest(24);
  const filter = (id: string) => replayExclusions(thread, [{ id, role: "bot" }], null, { failClosed: true }).size;
  expect(filter("tip0")).toBe(0);
  expect(filter("tip2")).toBe(0);
  db.prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(`message:${thread}:r5`);
  expect(filter("tip2")).toBe(1);
  expect(filter("tip0")).toBe(1);
});
