// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14 (designs/TURNSTART-CURSOR-1018-r14.md): what the warmer calls "warm" is warm for the REAL turn entry points.
//
// T12 REAL-ENTRY (sec. 6) for the two ops r14 adds against Astra r13 H1 and H2, plus T10(n), (n4), (n5):
// - (n4) H1: a thread warm on a resumed session whose continuation hold (disclosures.ts sessionHolds) is evicted by 512 other sessions'
//   holds: while the thread reads "warm" the next E2 must be a hit (no full check). r14: the hold is the store's 4th map, its eviction moves
//   lossOf, the thread reads "pending" until the re-confirm rebuilds the hold.
// - (n5) an authority-only write moves the stamp a hold rests on (DI:150): "pending" until the re-confirm, never "warm" over a stale hold.
// - (n) H2 / Astra (h): a member DELETE of an UNRELATED set (RL:1827 STRUCT) drops every stored root handle (RL:2005-2007): a thread whose
//   confirm used a handle must not read "warm" while its next E1 rebuilds handles; r14 moves handleEpoch and re-confirms.
//
// RB rule (r13 sec. 6): on b13e there is no lineageThreadState, so the TIP ADAPTER reads "warm" = lineageWarmIdle() and warmedHook fired for t.
// With r14 the module's own lineageThreadState is read. The oracle is the same for both: whenever t reads "warm", the real entry point run on
// one fresh turn allowance does no more work than the clean probe taken right after warming (statements, judge misses, handle rows).
//
// Warm driver: `settle()` steps the warmer until it says it is done. The r14 green replaces it with the clock rule's fake-time driver.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { continuationMemoryRevoked, filterDirectReplay, resetSessionHolds } from "./disclosures.ts";
import * as LW from "./lineage-warm.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { forgetKeptLineageForTest, lineageCacheCounts, outputRootsFor, recordSessionRoots, thawRootSetWritesForTest } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { rootSetWork } from "./root-set-handles.ts";
import { chainStore } from "./schema.ts";
import { stampFreshSession } from "./testing/writetime-fixture.ts";

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
const A = "chat", B = "older", driver = "engine", session = "S";

// ---- the state reader: r14's own, else the tip adapter (RB) ----
const lw = LW as unknown as Record<string, unknown>;
const hooked = new Set<string>();
const r14State = typeof lw.lineageThreadState === "function" ? lw.lineageThreadState as (thread: string) => string : null;
function stateOf(thread: string): string {
  if (r14State) return r14State(thread);
  return LW.lineageWarmIdle() && hooked.has(thread) ? "warm" : "checking";
}
const warmReader = r14State ? "r14 lineageThreadState" : "tip adapter (lineageWarmIdle && warmedHook)";

// ---- statements at the SQL layer (installed before any connection opens) ----
const tally = { statements: 0 };
const realPrepare = DatabaseSync.prototype.prepare;
beforeAll(() => {
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = realPrepare.call(this, sql);
    const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ["get", "all", "run", "iterate"] as const) {
      const real = (statement as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!.bind(statement);
      own[name] = (...args) => { tally.statements++; return real(...args); };
    }
    return statement;
  } as typeof realPrepare;
});
afterAll(() => { DatabaseSync.prototype.prepare = realPrepare; });

beforeEach(() => {
  thawRootSetWritesForTest(true);
  LW.resetLineageWarmForTest(); hooked.clear(); LW.onLineageThreadWarmed(thread => hooked.add(thread));
  closeDatabase(); forgetKeptLineageForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active"); reconcileMemoryRoster(roster); resetSessionHolds();
  // r15 / L2 (b)(c): production has no fallback source, so the confirm reads "checking: inputs" until a mint is registered; this file registers
  // the same access() mint the probe uses, and the surface's DB-backed line and task-row sources (its defaults when not given).
  sources()?.useSources({ mint: (_bot: string, thread: string) => access(thread) });
});
afterEach(() => { sources()?.useSources(null); LW.onLineageThreadWarmed(null); thawRootSetWritesForTest(false); });
function sources(): { useSources(s: { mint?: (botId: string, threadId: string) => unknown } | null): void } | null {
  const make = lw.lineageWarmTestSurface;
  return typeof make === "function" ? (make as () => { useSources(s: { mint?: (botId: string, threadId: string) => unknown } | null): void })() : null;
}

function access(thread = A) {
  const registry = new InternalCapabilities(); registry.begin("bot", thread, "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
const key = (thread: string, id: string) => `${thread}\u0000${id}`;
function message(thread: string, id: string): void {
  const db = database(), scope = ensureScope("conversation", thread);
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:bot','settled',NULL,'active')").run(`message:${thread}:${id}`, scope, thread, id);
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, id, 0, "bot", "text", `line ${id}`, "{}");
}
/** A thread's replies x0..x{n-1}, the newest pointing at a chain of sets (one root per reply), as a 1.0.1 file stores it. */
function chain(thread: string, prefix: string, n: number): string[] {
  const write = chainStore(database()), sets: string[] = [];
  let parent: string | null = null;
  for (let index = 0; index < n; index++) { message(thread, `${prefix}${index}`); parent = write(parent, index, [key(thread, `${prefix}${index}`)]); sets.push(parent); }
  database().prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, `${prefix}${n - 1}`, sets[n - 1]!);
  return sets;
}
/** The retained session S of A: one sound receipt listing the newest reply, its lineage row and its 1.0.3 door stamp. */
function sessionOf(thread: string, nativeSession: string, listing: string[]): void {
  const db = database();
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]',?,(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',9)")
    .run(`rc-${thread}-${nativeSession}`, thread, driver, nativeSession, JSON.stringify(listing));
  recordSessionRoots(thread, driver, nativeSession, outputRootsFor(LineageAllowance.tool(1_000_000_000), []));
  stampFreshSession(db, thread, driver, nativeSession);
}
function fixture(): void {
  database();
  database().exec("BEGIN");
  chain(A, "a", 3);
  chain(B, "b", 3);
  sessionOf(A, session, ["a2"]);
  database().exec("COMMIT");
}
function settle(limit = 100_000): void {
  LW.bumpLineageWarm(A); LW.kickLineageWarm();
  let steps = 0;
  while (LW.lineageWarmStep(25)) if (++steps > limit) throw new Error("the warmer did not finish");
}

// ---- the REAL entry points on one fresh turn allowance ----
interface Probe { statements: number; misses: number; handleRows: number; hit: boolean; revoked: boolean; withheld: string[] }
const windowOf = (_thread: string, prefix: string) => [0, 1, 2].map(index => ({ id: `${prefix}${index}`, role: "bot", kind: "text", text: `line ${prefix}${index}` }));
function probe(thread = A, prefix = "a", withSession = true): Probe {
  const allowance = LineageAllowance.turn(), who = access(thread);
  const before = { statements: tally.statements, misses: lineageCacheCounts().misses, rows: rootSetWork().rows };
  // the turn's order (IX:12708 / :13285 before :13306): E2 then E1 (E3 inside it)
  const revoked = withSession ? continuationMemoryRevoked(allowance, thread, driver, session, who) : false;
  const result = filterDirectReplay(allowance, thread, windowOf(thread, prefix), who, new Set<string>());
  return { statements: tally.statements - before.statements, misses: lineageCacheCounts().misses - before.misses, handleRows: rootSetWork().rows - before.rows, hit: allowance.hit, revoked, withheld: [...result.withheld].sort() };
}
/** The oracle: if `thread` reads "warm", its real entry is no dearer than the clean probe `clean`, and answers the same. */
function oracle(thread: string, clean: Probe, op: string, prefix = "a", withSession = true): void {
  if (stateOf(thread) !== "warm") return;
  const now = probe(thread, prefix, withSession);
  const where = `[${warmReader}] op "${op}": ${thread} reads warm, real entry ${JSON.stringify(now)} vs clean ${JSON.stringify(clean)}`;
  expect(now.hit, where).toBe(false);
  expect(now.misses, where).toBe(0);
  expect(now.handleRows, where).toBe(0);
  expect(now.statements, where).toBeLessThanOrEqual(clean.statements);
  expect({ revoked: now.revoked, withheld: now.withheld }, where).toEqual({ revoked: clean.revoked, withheld: clean.withheld });
}
/** Warm A, then take the clean probe (the second one: the first may build what a turn keeps, the hold included). */
function warmA(): Probe {
  fixture();
  probe(); // a turn ran: the hold exists, the handles are built
  settle();
  expect(stateOf(A), `[${warmReader}] A warm after settling`).toBe("warm");
  const clean = probe();
  expect(clean.misses).toBe(0); expect(clean.handleRows).toBe(0); expect(clean.hit).toBe(false);
  return clean;
}

describe("T12 REAL-ENTRY / T10(n4), (n5), (n): a thread that reads warm has its real entry as a hit", () => {
  it("T10(n4) hold eviction: 512 other sessions' holds evict A's hold; A is not warm until the re-confirm rebuilds it, then the probe is hit-only", () => {
    const clean = warmA();
    // SESSION_HOLDS_MAX 512 (DI:127): 512 other sessions of A each pass and keep a hold; the oldest, A's S, is evicted at DI:193
    database().exec("BEGIN");
    for (let index = 0; index < 512; index++) sessionOf(A, `other-${index}`, []);
    database().exec("COMMIT");
    for (let index = 0; index < 512; index++) expect(continuationMemoryRevoked(LineageAllowance.tool(), A, driver, `other-${index}`, access())).toBe(false);
    oracle(A, clean, "hold eviction (512 sessions)");
    settle();
    expect(stateOf(A), `[${warmReader}] A warm again after the re-confirm`).toBe("warm");
    oracle(A, clean, "hold eviction, after the re-confirm");
  });

  it("T10(n5) authority stamp move: a hold over an old stamp never answers a thread that reads warm", () => {
    const clean = warmA();
    // an authority-only write (a tombstone of a record nothing cites): the stamp DI:150 compares moves, nothing A reads changes
    database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('tz','record','nobody',NULL,NULL,1,'forgotten',1)").run();
    oracle(A, clean, "authority stamp move");
    settle();
    expect(stateOf(A)).toBe("warm");
    oracle(A, clean, "authority stamp move, after the re-confirm");
  });

  it("T10(n) unrelated STRUCT member DELETE: B's set loses a member row, every stored handle is dropped; A (usedHandles) is not warm until re-confirmed", () => {
    const clean = warmA();
    const bSets = database().prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=?").all(B).map(row => String(row.set_id));
    expect(bSets.length).toBe(1);
    // RL:1827 lineage_root_sets_d: 'x' for B's set only, plus STRUCT -> keepHandlesCurrent clears sharedHandles (RL:2005-2007)
    const deleted = database().prepare("DELETE FROM memory_root_set_members WHERE set_id=? AND root_message_id=?").run(bSets[0]!, "b2");
    expect(Number(deleted.changes)).toBe(1);
    oracle(A, clean, "unrelated member DELETE (STRUCT)");
    settle();
    expect(stateOf(A)).toBe("warm");
    oracle(A, clean, "unrelated member DELETE, after the re-confirm");
  });

  // T10(n) form changed 11-07 (lead ruling, MurageMain accepted): r15.1 Y1 epochs fail closed; precision = no handle work. The member DELETE
  // moves the raw structure epoch, so W3'(4) misses on "epochs" for every thread (the turn's compare and, agreeing with it, the state), but
  // a thread whose confirm used no handle is NOT invalidated by the handle epoch ("pending: epochs", never "pending: stamps (handles)"), and
  // its one re-confirm costs no handle rows and no judge misses.
  it("T10(n) precision: a thread whose confirm used no handle is invalidated only by the raw epoch across the same STRUCT move, and re-warms with no handle work", () => {
    database();
    database().exec("BEGIN");
    for (let index = 0; index < 3; index++) message(A, `p${index}`); // replies with no roots: E1 reads no handle
    chain(B, "b", 3);
    database().exec("COMMIT");
    settle();
    const clean = probe(A, "p", false);
    const covered = (tag: string) => {
      // the turn's compare (IX:13283) on a plain send U right after the record's anchor; U is removed again after
      const rec = LW.lineageWarmRecordForTest(A)!;
      const u = `u-${tag}`;
      database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(A, u, 0, "user", "text", `user ${u}`, JSON.stringify({ parentId: rec.anchor!.id }));
      const before = LW.lineageWarmCounters().coveredMissByClause.epochs;
      const verdict = LW.lineageTurnCovered(A, { id: u }, rec.footprint!);
      const epochs = LW.lineageWarmCounters().coveredMissByClause.epochs - before;
      database().prepare("DELETE FROM messages WHERE thread_id=? AND id=?").run(A, u);
      return { verdict, epochs };
    };
    expect(stateOf(A)).toBe("warm");
    const bSet = String(database().prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=?").get(B)!.set_id);
    database().prepare("DELETE FROM memory_root_set_members WHERE set_id=? AND root_message_id='b2'").run(bSet);
    // (1) only the raw structure epoch invalidates A (not its handle stamp), and the turn's compare misses on that clause
    expect(stateOf(A)).toBe("pending: epochs");
    expect(covered("after-delete")).toEqual({ verdict: "not-covered", epochs: 1 });
    // (2) ONE settle: warm again, with no handle rows and no judge misses
    const work = { rows: rootSetWork().rows, misses: lineageCacheCounts().misses };
    settle();
    expect(stateOf(A)).toBe("warm");
    expect({ rows: rootSetWork().rows - work.rows, misses: lineageCacheCounts().misses - work.misses }).toEqual({ rows: 0, misses: 0 });
    // (3) the next plain send matches, and its real entry is as cheap as the clean probe
    expect(covered("after-settle").verdict).toBe("match");
    oracle(A, clean, "unrelated member DELETE, no handles used, after the re-confirm", "p", false);
  });
});
