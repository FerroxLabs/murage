// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 (extreme scale): what one turn of a long session costs in lineage work follows what the
// turn adds, not the session's ancestry. A resumed session's set is a chain of one root per
// turn; the turn path used to expand the chain (rows), hash and sort the union (members) and
// judge every root again, at every turn, up to the 50k ceiling. This file pins the work in rows
// read through the SQL layer (no clock): flat from 5k to 20k replies, and the same answers the
// whole-set reading gave.
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureSource } from "./capture.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { chainStore, rootSetMembers, storeRootSet } from "./schema.ts";
import { mergeOutputRoots, outputRootsBad, outputRootsFor, recordOutputRoots, recordSessionRoots, replayExclusions, sessionOutputRoots, setRootSetCeilingForTest, type ReplayAudience } from "./replay-lineage.ts";
import { resetRootSetWork, rootSetWork } from "./root-set-handles.ts";

const thread = "scale-direct", driver = "drv", session = "sess";
const key = (reply: number | string) => `${thread}\u0000r${reply}`;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => setRootSetCeilingForTest(null));

/** Statements run and rows they hand back, counted at the SQL layer: every statement prepared on a connection is wrapped
 * (the connection is opened after the wrapper is in place). */
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
function sqlWork<T>(run: () => T): { value: T; rows: number; statements: number } {
  const before = { ...tally };
  const value = run();
  return { value, rows: tally.rows - before.rows, statements: tally.statements - before.statements };
}

/** A session of `n` replies as the app stores it: set k is set k-1 plus root k (a chain), the last 300 replies point at their sets,
 * the engine session at the newest. */
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
/** One turn of the resumed session: the context shows the previous reply, a new receipt output joins, the session and the reply are
 * recorded, the retained session is judged, and the replay filter looks at the recent lines. */
function turn(index: number, audience: ReplayAudience | null = null): void {
  const shown = outputRootsFor([{ threadId: thread, id: `r${index - 1}`, role: "bot" }]);
  const roots = mergeOutputRoots(mergeOutputRoots(shown, { roots: new Set([key(index)]), over: false }), sessionOutputRoots(thread, driver, session));
  recordSessionRoots(thread, driver, session, roots);
  recordOutputRoots(thread, `r${index}`, roots);
  expect(outputRootsBad(sessionOutputRoots(thread, driver, session))).toBe(false);
  const window = Array.from({ length: 100 }, (_, back) => ({ id: `r${index - 1 - back}`, role: "bot" }));
  expect(replayExclusions(thread, window, audience, { failClosed: true }).size).toBe(0);
}
function measure(size: number, audience: ReplayAudience | null = null): { rows: number; statements: number; members: number } {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  database();
  buildSession(size);
  // the first turns after a start read what the session already holds
  turn(size, audience); turn(size + 1, audience);
  resetRootSetWork();
  let rows = 0, statements = 0;
  for (let index = 0; index < 3; index++) { const spent = sqlWork(() => turn(size + 2 + index, audience)); rows += spent.rows; statements += spent.statements; }
  return { rows: rows / 3, statements: statements / 3, members: rootSetWork().members / 3 };
}

it("a turn's lineage work stays flat from 5k to 20k replies of one session", () => {
  const small = measure(5_000), medium = measure(10_000), large = measure(20_000);
  console.log(`LINEAGE-TURN 5k=${JSON.stringify(small)} 10k=${JSON.stringify(medium)} 20k=${JSON.stringify(large)}`);
  expect(large.rows / small.rows).toBeLessThanOrEqual(1.3);
  expect(medium.rows / small.rows).toBeLessThanOrEqual(1.3);
  expect(large.statements / small.statements).toBeLessThanOrEqual(1.3);
  expect(large.members / Math.max(1, small.members)).toBeLessThanOrEqual(1.3);
  // and small in itself: a turn adds a handful of roots
  expect(large.rows).toBeLessThan(2_000);
  expect(large.members).toBeLessThan(2_000);
}, 600_000);

it("the same for a reader who is not the owner: a turn's lineage work stays flat from 5k to 20k replies", () => {
  const audience: ReplayAudience = { policyRevision: 0, deletionEpoch: 0, revoked: () => false, cacheKey: "scale-reader" };
  const small = measure(5_000, audience), medium = measure(10_000, audience), large = measure(20_000, audience);
  console.log(`LINEAGE-TURN-READER 5k=${JSON.stringify(small)} 10k=${JSON.stringify(medium)} 20k=${JSON.stringify(large)}`);
  expect(large.rows / small.rows).toBeLessThanOrEqual(1.3);
  expect(medium.rows / small.rows).toBeLessThanOrEqual(1.3);
  expect(large.statements / small.statements).toBeLessThanOrEqual(1.3);
  expect(large.rows).toBeLessThan(2_000);
}, 600_000);

it("the roots a session holds are exactly the whole-set reading, for legacy full sets, chains and branches", () => {
  const db = database();
  // legacy: content-addressed full sets; chains; a branch (two children of one set); a full copy of a chain
  const write = chainStore(db);
  const legacy = storeRootSet(db, [key("a"), key("b"), key("c")]);
  const grown = write(legacy, 3, [key("d"), key("e")]);
  const left = write(grown, 5, [key("l1")]), right = write(grown, 5, [key("r1"), key("r2")]);
  const longer = write(left, 6, [key("l2")]);
  const copy = storeRootSet(db, rootSetMembers(db, longer)!);
  const other = storeRootSet(db, [key("x"), key("y"), key("a")]);
  const sets = [legacy, grown, left, right, longer, copy, other];
  const point = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  sets.forEach((id, index) => point.run(thread, `p${index}`, id));
  const randomLines = (seed: number) => {
    let state = seed;
    const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff);
    return Array.from({ length: 1 + (next() % 4) }, () => ({ threadId: thread, id: `p${next() % sets.length}`, role: "bot" }));
  };
  for (let seed = 1; seed <= 60; seed++) {
    const lines = randomLines(seed);
    const reference = new Set<string>();
    for (const line of lines) for (const member of rootSetMembers(db, sets[Number(line.id.slice(1))]!)!) reference.add(member);
    const found = outputRootsFor(lines);
    expect(found.over).toBe(false);
    expect(new Set(found.roots)).toEqual(reference);
    expect(found.roots.size).toBe(reference.size);
    for (const member of reference) expect(found.roots.has(member)).toBe(true);
    expect(found.roots.has(key("never"))).toBe(false);
    // the set a reply is recorded under holds the same members
    recordOutputRoots(thread, `w${seed}`, found);
    const stored = db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?").get(thread, `w${seed}`);
    expect(rootSetMembers(db, String(stored!.set_id))).toEqual(reference);
    expect(outputRootsBad(found)).toBe(false);
  }
  // a union of sets from different families and loose roots
  const merged = mergeOutputRoots(outputRootsFor([{ threadId: thread, id: "p4", role: "bot" }]), mergeOutputRoots(outputRootsFor([{ threadId: thread, id: "p6", role: "bot" }]), { roots: new Set([key("loose"), key("a")]), over: false }));
  expect(new Set(merged.roots)).toEqual(new Set([...rootSetMembers(db, longer)!, ...rootSetMembers(db, other)!, key("loose")]));
  recordSessionRoots(thread, driver, session, merged);
  const again = sessionOutputRoots(thread, driver, session);
  expect(new Set(again.roots)).toEqual(new Set(merged.roots));
  // the same union again writes nothing new
  const before = Number(db.prepare("SELECT count(*) AS n FROM memory_root_sets").get()!.n);
  recordSessionRoots(thread, driver, session, merged);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_root_sets").get()!.n)).toBe(before);
});

it("a chain that cannot be proven is over, as before, and so is a set past the ceiling", () => {
  const db = database(), write = chainStore(db);
  const a = write(null, 0, [key(0), key(1)]), b = write(a, 2, [key(2)]), c = write(b, 3, [key(3)]);
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, "q", c);
  expect(outputRootsFor([{ threadId: thread, id: "q", role: "bot" }]).over).toBe(false);
  // a member row of the middle set goes: reading c is unprovable
  db.prepare("DELETE FROM memory_root_set_members WHERE set_id=?").run(b);
  expect(rootSetMembers(db, c)).toBeNull();
  const broken = outputRootsFor([{ threadId: thread, id: "q", role: "bot" }]);
  expect(broken.over).toBe(true);
  expect(outputRootsBad(broken)).toBe(true);
  setRootSetCeilingForTest(2);
  const small = write(null, 0, [key("s1"), key("s2")]), big = write(small, 2, [key("s3")]);
  db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, "big", big);
  expect(outputRootsFor([{ threadId: thread, id: "big", role: "bot" }]).over).toBe(true);
});

it("a root forgotten deep inside a long session fails the kept check, however long the answer was held", () => {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  buildSession(1_200);
  for (const reply of [5, 600, 1_199]) captureSource(database(), { id: `message:${thread}:r${reply}`, threadId: thread, messageId: `r${reply}`, kind: "text", speaker: "owner", outcome: "recorded", text: `note ${reply}` });
  const held = () => sessionOutputRoots(thread, driver, session);
  expect(outputRootsBad(held())).toBe(false);
  // a second look is served from the kept answer: no root is judged again
  const second = sqlWork(() => outputRootsBad(held()));
  expect(second.value).toBe(false);
  expect(second.rows).toBeLessThan(40);
  // one early root is deleted: the kept answer for the whole session must not survive it
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(`message:${thread}:r5`);
  expect(outputRootsBad(held())).toBe(true);
  database().prepare("UPDATE memory_sources SET state='active' WHERE id=?").run(`message:${thread}:r5`);
  expect(outputRootsBad(held())).toBe(false);
  // a root added by the turn (not in the stored set) is judged on its own
  captureSource(database(), { id: `message:${thread}:extra`, threadId: thread, messageId: "extra", kind: "text", speaker: "owner", outcome: "recorded", text: "extra" });
  const withExtra = mergeOutputRoots(held(), { roots: new Set([`${thread}\u0000extra`]), over: false });
  expect(outputRootsBad(withExtra)).toBe(false);
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(`message:${thread}:extra`);
  expect(outputRootsBad(withExtra)).toBe(true);
}, 120_000);

it("a write that rolled back leaves no trusted set behind", () => {
  const db = database();
  buildSession(50);
  db.exec("BEGIN");
  recordSessionRoots(thread, driver, session, mergeOutputRoots(sessionOutputRoots(thread, driver, session), { roots: new Set([key("g1")]), over: false }));
  const ghost = sessionOutputRoots(thread, driver, session);
  expect(ghost.roots.size).toBe(51);
  db.exec("ROLLBACK");
  expect(sessionOutputRoots(thread, driver, session).roots.size).toBe(50);
  // a caller still holding the rolled back set builds on a set that is gone: the write stores a whole set that proves
  recordOutputRoots(thread, "after", mergeOutputRoots(ghost, { roots: new Set([key("g2")]), over: false }));
  const stored = db.prepare("SELECT set_id FROM memory_output_roots WHERE message_id='after'").get();
  expect(rootSetMembers(db, String(stored!.set_id))?.size).toBe(52);
});

it("the replay filter of a long session's replies is served from the kept answer and still follows a forgotten root", () => {
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  buildSession(1_500);
  captureSource(database(), { id: `message:${thread}:r7`, threadId: thread, messageId: "r7", kind: "text", speaker: "owner", outcome: "recorded", text: "early" });
  const window = Array.from({ length: 100 }, (_, back) => ({ id: `r${1_499 - back}`, role: "bot" }));
  const filter = () => replayExclusions(thread, window, null, { failClosed: true });
  expect(filter().size).toBe(0);
  const again = sqlWork(filter);
  expect(again.value.size).toBe(0);
  expect(again.rows).toBeLessThan(400);
  // an early root of every set in the window is forgotten: the window is withheld, and comes back when it is restored
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id=?").run(`message:${thread}:r7`);
  expect(filter().size).toBe(100);
  database().prepare("UPDATE memory_sources SET state='active' WHERE id=?").run(`message:${thread}:r7`);
  expect(filter().size).toBe(0);
}, 120_000);
