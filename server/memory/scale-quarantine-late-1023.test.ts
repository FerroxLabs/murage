// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1023-scalefin2. Writer side owner: the marker (revoke-marker.ts markPending / storeQuarantineLow) and the start at listen
// (memory-revocation.ts retryQuarantinedAtStart); reader side owner: deny-read.ts keyWindows.
// Reviews of a482cd6d07 (fix/1022q-scale-fin), each a way the stored quarantine low-water mark could sit above a quarantined job's rows:
//   Fable/Opus H1: a denied write under a job that is already quarantined adds a pending row to it (revoke-commit.ts inheritMarks ->
//     markPending) and nothing lowered the mark, so past 256 rows a prepared ref under that row was shown until the next start.
//   Astra High: a start pass that could not run was dropped with no retry, and a recompute that wrote only the mark did not move the
//     readers' memo on that connection.
//   Fable/Opus H3: the start with an unreadable app version was not proven (the version stand-in never reached the runner's module).
// The version source is the only stand-in (it cannot be made unreadable from a test); writer, marker, runner start and readers are real.
import { afterEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { WritetimeFixture } from "./testing/writetime-fixture.ts";
import type { LineageRef, PreparedWindow } from "./lineage-types.ts";

// the setup file has already loaded the memory modules, so the stand-in is installed on a fresh module graph the test imports below
const version = { unreadable: false };
vi.resetModules();
vi.doMock("./app-version.ts", async importOriginal => {
  const real = await importOriginal<typeof import("./app-version.ts")>();
  return { ...real, runningAppVersion: () => version.unreadable ? null : real.runningAppVersion() };
});
const { denyGeneration, preparedWindowIdentity, refsLookup } = await import("./deny-read.ts");
const { memoryRefKey } = await import("./lineage-types.ts");
const { stopMemoryRevocation, wakeMemoryRevocation } = await import("./memory-revocation.ts");
const { inheritMarks } = await import("./revoke-commit.ts");
const { resetRevokeWriteBudget } = await import("./revoke-budget.ts");
const { CONTENT, WritetimeFixture: Fixture } = await import("./testing/writetime-fixture.ts");

const QUARANTINE_LOW = "memory-revoke-quarantine-low";
const fixtures: WritetimeFixture[] = [];
afterEach(() => { stopMemoryRevocation(); resetRevokeWriteBudget(); version.unreadable = false; for (const f of fixtures.splice(0)) f.close(); });
const ref = { kind: "record" as const, id: "rec", version: 1 };
const refs: LineageRef[] = [{ kind: "memory", ref }];
const T = "room";
/** Scope s-bot past the 256-row limit (300 rows of live jobs from lsn 60 up; the whole file stays under the 512-row identity bound of a
 * prepared window), the record `rec` at lsn 50 and job 7
 * quarantined in its mark phase, with a denied line of the room (lsn 20) under it and no pending row yet. */
function file(): WritetimeFixture {
  const f = new Fixture().cert(true).ready(T, true); fixtures.push(f);
  f.source("src", "s-bot").record("rec", 1, "s-bot", ["src"]);
  f.db.exec("UPDATE memory_record_lsn SET created_lsn=50 WHERE id='rec'");
  f.reply(T, "parent", 20, { turnLsn: 15 }).reply(T, "late", 40, { turnLsn: 35 }).denyLine(T, 20, 7).job(7, 30);
  f.db.prepare("UPDATE memory_revoke_jobs SET phase='mark',state='quarantined' WHERE revoke_id=7").run();
  const scope = f.db.prepare("INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-bot',?,?)");
  for (let i = 0; i < 300; i++) scope.run(60 + i, 100000 + i);
  f.db.prepare("UPDATE memory_lsn SET next=5000 WHERE id=1").run();
  return f;
}
const mark = (f: WritetimeFixture) => f.db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(QUARANTINE_LOW)?.intent;
const tx = <R>(db: DatabaseSync, work: () => R): R => {
  db.exec("BEGIN IMMEDIATE");
  try { const out = work(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; }
};
/** The record as the send fence judges a ref its turn prepared under the window open now. */
function judged(f: WritetimeFixture) {
  const window: PreparedWindow = { reader: CONTENT, generation: denyGeneration(f.db), identity: preparedWindowIdentity(f.db), memoryKeys: new Set([memoryRefKey(ref)]), open: true };
  return refsLookup(f.db, refs, CONTENT, true, window);
}
const start = (f: WritetimeFixture, getDb: () => DatabaseSync = () => f.db) => wakeMemoryRevocation(getDb, { busy: () => true, retryMs: 5, pauseMs: 5 });

// SITES rows revoke-commit.ts inheritMarks -> markPending under an existing job (the scope table and the thread table).
it.each([
  ["a record child (scope row)", (f: WritetimeFixture) => inheritMarks(f.db, { kind: "record", ref: { ...ref, scopeId: "s-bot" }, lsn: 45 }, [], [{ threadId: T, from: 20, to: 20 }]), '{"s":45}'],
  ["a line child (thread row)", (f: WritetimeFixture) => inheritMarks(f.db, { kind: "line", threadId: T, lsn: 40 }, [], [{ threadId: T, from: 20, to: 20 }]), '{"t":40}'],
] as const)("W-QLOW-LATE-ROW a denied write under an already quarantined job lowers the stored mark: %s", (_name, write, stored) => {
  const f = file();
  expect(mark(f)).toBeUndefined();
  expect(judged(f)).toMatchObject({ state: "shown" });
  tx(f.db, () => write(f));
  expect(f.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=7").get()?.state).toBe("quarantined");
  expect(Number(f.db.prepare("SELECT (SELECT count(*) FROM memory_deny_pending WHERE revoke_id=7)+(SELECT count(*) FROM memory_deny_pending_scope WHERE revoke_id=7) AS n").get()?.n)).toBe(1);
  // pre-fix a482cd6d07: undefined (the row was written under the quarantined job and the mark stayed where it was)
  expect(mark(f)).toBe(stored);
});
it("W-QLOW-LATE-HELD past 256 rows a prepared ref under the row a denied write added to a quarantined job reads withheld, not shown", () => {
  const f = file();
  expect(judged(f)).toMatchObject({ state: "shown" });
  tx(f.db, () => inheritMarks(f.db, { kind: "record", ref: { ...ref, scopeId: "s-bot" }, lsn: 45 }, [], [{ threadId: T, from: 20, to: 20 }]));
  // pre-fix a482cd6d07: shown (held_low null: the prepared exception stood over the quarantined job's new row)
  expect(judged(f)).toMatchObject({ state: "withheld", reason: "scope-deny" });
});

/** A file as an earlier candidate build left it: job 7 quarantined with a row on the scope (lsn 0) and no stored mark. */
function unmarked(since = 0): WritetimeFixture {
  const f = file();
  f.pendingScope("s-bot", since, 7);
  expect(mark(f)).toBeUndefined();
  return f;
}
it("W-QLOW-START a start with an unreadable app version still stores the mark of a quarantined job that has none", () => {
  const f = unmarked();
  version.unreadable = true;
  start(f);
  // pre-fix 7b9de96263 (and with the early return on an unreadable version restored): undefined
  expect(mark(f)).toBe('{"s":0}');
});
it("W-QLOW-MEMO a start's recompute that writes only the mark moves the reader's memo on that connection", () => {
  const f = unmarked();
  // the reader memoises the pending read (held_low null) on this connection before the start
  expect(judged(f)).toMatchObject({ state: "shown" });
  start(f);
  expect(mark(f)).toBe('{"s":0}');
  // pre-fix a482cd6d07: shown (no watched table was written, so the memoised rows still carried a null held_low)
  expect(judged(f)).toMatchObject({ state: "withheld", reason: "scope-deny" });
});
it("W-QLOW-RETRY a start pass that could not run is owed: the reader withholds past the limit meanwhile, the pass runs again off the turn path and the mark is trusted again", async () => {
  // job 7's row starts above the record (lsn 55 > 50): with a proven mark the prepared ref is shown, so "withheld" below is the owed pass
  const f = unmarked(55);
  f.db.exec("BEGIN IMMEDIATE"); // the handle is inside a transaction at the start: the pass cannot run
  start(f);
  f.db.exec("COMMIT");
  expect(mark(f)).toBeUndefined();
  // pre-fix a482cd6d07: shown (the pass was dropped and the missing mark read as "no quarantined window")
  expect(judged(f)).toMatchObject({ state: "withheld", reason: "scope-deny" });
  // a later wake (a turn's fence wait, a commit that queued work) does not run the pass: its work grows with the quarantined jobs
  wakeMemoryRevocation(() => f.db);
  expect(mark(f)).toBeUndefined();
  // the pass's own timer (the runner's retryMs here) runs it
  const end = Date.now() + 5_000;
  while (Date.now() < end && mark(f) === undefined) await new Promise(resolve => setTimeout(resolve, 10));
  expect(mark(f)).toBe('{"s":55}');
  // the pass landed: the stored mark is trusted again, and it does not reach the record
  expect(judged(f)).toMatchObject({ state: "shown" });
});
