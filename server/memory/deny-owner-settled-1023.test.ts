// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-denyfable (MAIN-RULING 2026-11-26T20:15:28Z "owner turns use the last settled view"; rule 5 removal).
// Owners: the settled-view reader and its sites = q1023-denyfable (lineage-types.ts LineageReader.settled, deny-read.ts, session-proof.ts,
// disclosures.ts, readable.ts, index.ts); the pending windows of every other reader = deny-read.ts, unchanged; rulings = MAIN.
//
// The owner's own direct turn is judged by the durable deny rows alone. A revoke walk still in flight (its pending windows) is no verdict
// for it: on a real store 4,474 unfinished jobs kept every resumed owner turn "checking:pending" (sent with nothing remembered) for days.
// Entry points: the owner turn's own continuation check (disclosures.ts continuationMemoryRevoked and continuationPendingProbe, called at
// index.ts continuation.check) with a real owner capability on a real store, and every production reader of deny-read.ts (SITES.md), over
// windows written by the real commitRevoke with its walk left to the paced runner (inline: false), as a turn finds them.
// RED on d2c1083fbc at each W-OT row: every one read "checking:pending". The G rows (a settled deny row still withholds on the owner's
// turn; every other reader keeps every window) are green on both sides and go RED under their mutants.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, database } from "../database.ts";
import { denyLookup, fenceVerdict, memoryLookup, refsLookup, sessionLookup } from "./deny-read.ts";
import { continuationMemoryRevoked, continuationPendingProbe, ownerDirectChat, resetSessionHolds } from "./disclosures.ts";
import { CONTENT_SESSION_READER } from "./dispatch.ts";
import * as lineageTypes from "./lineage-types.ts";
import { memoryRefKey, type BuiltPrompt, type LineageReader, type LineageRef, type MemoryRef } from "./lineage-types.ts";
import { writetimeRecordRefusal } from "./readable.ts";
import { LineageAllowance, recordSessionRoots } from "./replay-lineage.ts";
import { resetRevokeWriteBudget, revokePaceTestHooks } from "./revoke-budget.ts";
import * as revokeCommit from "./revoke-commit.ts";
import { commitRevoke } from "./revoke-commit.ts";
const { openBulkRevoke, activateBulkRevoke } = revokeCommit;
import { setScopeFlowEdgesRecorded } from "./revoke-marker.ts";
import { sessionKeyOf } from "./session-incarnation.ts";
import { noteSessionFrame } from "./session-proof-schema.ts";
import { initializeFreshSessionProof } from "./session-proof.ts";
import { accessFor, freshDataDir, ROSTER } from "./testing/recall-fixture.ts";
import { fixtureMemoryAccess } from "../testing/recall-access-fixture.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { MEMBER, OWNER, stampFreshSession, WritetimeFixture } from "./testing/writetime-fixture.ts";

beforeEach(() => { freshDataDir("active"); resetSessionHolds(); resetRevokeWriteBudget(); setScopeFlowEdgesRecorded(true); revokePaceTestHooks.osUnknown = true; });
afterEach(() => { vi.restoreAllMocks(); revokePaceTestHooks.osUnknown = false; setScopeFlowEdgesRecorded(false); closeDatabase(); });

const key = sessionKeyOf("thread", "engine", "fixture-session");
/** More windows than one key's exact read takes (deny-read.ts PENDING_READ_LIMIT 256): the shape of the real store's threads. */
const REVOKES = 300;
const SCOPE = "s-own";

/** The owner's direct conversation "thread" with a retained engine session over lsn 10..900 (a proven, delivered receipt), one generated
 * reply "gen" and one remembered record "rec" (evidence "src", anchored at the owner line "said"), and a conversation "other" with REVOKES
 * owner lines. Then, when `revoke`, each of those lines is revoked by the real writer with the walk left to the paced runner. */
function world(revoke = true) {
  const db = database(), f = new WritetimeFixture(db);
  f.cert(true).ready("thread", true).ready("other", true).scope(SCOPE)
    .owner("thread", "said", 20).reply("thread", "gen", 50, { turnLsn: 40 })
    .source("src", SCOPE, { thread: "thread", message: "said" }).record("rec", 1, SCOPE, ["src"]);
  for (let i = 0; i < REVOKES; i++) f.owner("other", `line-${i}`, 100 + i);
  db.exec("UPDATE memory_lsn SET next=1000 WHERE id=1");
  stampFreshSession(db, key.threadId, key.driverInstance, key.nativeSession);
  db.prepare("UPDATE memory_session_lineage SET first_lsn=10,last_lsn=900 WHERE thread_id=?").run("thread");
  recordSessionRoots(key.threadId, key.driverInstance, key.nativeSession, { roots: new Set(), over: false });
  noteSessionFrame(db, key, false);
  initializeFreshSessionProof(key, accessFor().access, () => {
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) SELECT 'fixture-receipt',?,?,?,'[]','[]',policy_revision,deletion_epoch,0,'delivered',1 FROM memory_meta WHERE id=1").run(key.threadId, key.driverInstance, key.nativeSession);
    noteSessionFrame(db, key, true);
  });
  db.prepare("UPDATE memory_session_checks SET up_to=0 WHERE thread_id=? AND driver_instance=? AND native_session=?").run(key.threadId, key.driverInstance, key.nativeSession);
  if (revoke) for (let i = 0; i < REVOKES; i++) commitRevoke(db, { kind: "line", threadId: "other", messageIds: [`line-${i}`], cause: "edit" }, { inline: false });
  return { db, f, access: accessFor().access };
}
const unfinished = (db: ReturnType<typeof database>) => Number(db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state NOT IN ('done','undone','folded')").get()!.n);
const windows = (db: ReturnType<typeof database>) => Number(db.prepare("SELECT (SELECT count(*) FROM memory_deny_pending)+(SELECT count(*) FROM memory_deny_pending_scope) AS n").get()!.n);
/** The owner turn's reader, written out (not imported) so this file loads on a tree without the constant and each row there fails at its
 * own assertion; W-OT-C pins the production constant to exactly this value. */
const OWNER_TURN_READER = { audience: null, settled: true } as LineageReader;
const PENDING = { state: "checking", reason: "pending" };
const SHOWN = { state: "shown" };
const REC: MemoryRef = { kind: "record", id: "rec", version: 1 };
const SRC: MemoryRef = { kind: "source", id: "src", version: 1 };
const prefixHeld = (): LineageRef => ({ kind: "prefix", threadId: "thread", headLsn: 900, held: 900, heldFrom: 10 });
const prefixWhole = (): LineageRef => ({ kind: "prefix", threadId: "thread", headLsn: 900 });
const prefixShown = (): LineageRef => ({ kind: "prefix", threadId: "thread", headLsn: 900, held: null, shown: ["gen"] });
const built = (refs: LineageRef[]): BuiltPrompt => ({ parts: [{ text: "", lineageOf: refs }], denyGeneration: -1 } as unknown as BuiltPrompt);

/** SITES.md I1: every reader of a pending window in deny-read.ts, one row per site, read for `reader` through its production function. */
const SITES: ReadonlyArray<readonly [site: string, read: (db: ReturnType<typeof database>, reader: LineageReader) => unknown]> = [
  ["lookupPage (denyLookup: a generated line of the thread)", (db, reader) => denyLookup(db, { threadId: "thread", lines: [{ messageId: "gen", author: "generated" }] }, reader).get("gen")],
  ["lookupMemory record (memoryLookup: the scope window)", (db, reader) => memoryLookup(db, [REC], reader).get(memoryRefKey(REC))],
  ["lookupMemory source (memoryLookup: the scope window)", (db, reader) => memoryLookup(db, [SRC], reader).get(memoryRefKey(SRC))],
  ["sessionLookup (the retained session)", (db, reader) => sessionLookup(db, key, reader)],
  ["prefixVerdict, held span (refsLookup)", (db, reader) => refsLookup(db, [prefixHeld()], reader)],
  ["prefixVerdict, whole prefix (refsLookup)", (db, reader) => refsLookup(db, [prefixWhole()], reader)],
  ["contentReader (refsLookup: a prefix's shown line)", (db, reader) => refsLookup(db, [prefixShown()], reader)],
  ["refsLookup memory refs", (db, reader) => refsLookup(db, [{ kind: "memory", ref: REC }], reader)],
  ["fenceVerdict (the send fence over a built prompt)", (db, reader) => fenceVerdict(db, built([prefixHeld(), { kind: "memory", ref: REC }]), reader)],
];

describe("W-OT the owner's own turn reads the last settled view: an unfinished revoke walk is no verdict for it", () => {
  it("W-OT-A the owner turn's continuation check keeps the session AND its memory under 300 unfinished revokes (not kept-without-memory)", () => {
    const w = world();
    // the fixture is the real store's shape: unfinished jobs, open windows, and a content reader that is not the owner's turn held by them
    expect(unfinished(w.db)).toBe(REVOKES);
    expect(windows(w.db)).toBeGreaterThanOrEqual(REVOKES);
    expect(ownerDirectChat("thread", w.access)).toBe(true);
    expect(sessionLookup(w.db, key, CONTENT_SESSION_READER)).toMatchObject(PENDING);
    // the probe (index.ts: the owner turn asks before its one real check) still counts the windows, so the turn still hurries the marker
    expect(continuationPendingProbe(key.threadId, key.driverInstance, key.nativeSession, w.access)).toBe(true);
    // the real check, as the owner's turn calls it (keepPending): the session continues, and NOT as "kept" (kept = sent with nothing remembered)
    const why: { reason?: string; kept?: boolean } = {};
    expect(continuationMemoryRevoked(LineageAllowance.turn(), key.threadId, key.driverInstance, key.nativeSession, w.access, why, true)).toBe(false);
    expect(why).toEqual({});
    // nothing was settled, closed or marked to get there: the walk is still the paced runner's
    expect(unfinished(w.db)).toBe(REVOKES);
  });
  it("W-OT-B the owner turn's check still does its bounded work first: a revoke it can finish is finished, and the window closes for every reader", () => {
    const w = world(false);
    commitRevoke(w.db, { kind: "line", threadId: "other", messageIds: ["line-0"], cause: "edit" }, { inline: false });
    expect(sessionLookup(w.db, key, CONTENT_SESSION_READER)).toMatchObject(PENDING);
    const why: { reason?: string; kept?: boolean } = {};
    expect(continuationMemoryRevoked(LineageAllowance.turn(), key.threadId, key.driverInstance, key.nativeSession, w.access, why, true)).toBe(false);
    expect(why).toEqual({});
    // not merely read past: the turn's bounded settle walked that revoke, so a reader that is not the owner's turn is shown too
    expect(sessionLookup(w.db, key, CONTENT_SESSION_READER)).toMatchObject(SHOWN);
  });
  it("G-OUTSIDE the same check NOT made for the owner's own turn (outside input in the owner's chat: a webhook, a hand-off) still resets on checking:pending", () => {
    const w = world();
    expect(ownerDirectChat("thread", w.access)).toBe(true);
    const why: { reason?: string; kept?: boolean } = {};
    expect(continuationMemoryRevoked(LineageAllowance.turn(), key.threadId, key.driverInstance, key.nativeSession, w.access, why)).toBe(true);
    expect(why).toEqual({ reason: "checking:pending" });
  });
  it("G-NOTOWNER an access that is not the owner's direct chat never reads the settled view, even when asked as an owner turn (the recall half: deny-owner-recall-1023.test.ts G-RC-NOTOWNER)", () => {
    const w = world();
    // the same bot, conversation and roster, but the turn's words were not proven to be the owner's (a room member, a channel sender)
    const registry = new InternalCapabilities(), generation = registry.begin("bot", "thread");
    const token = registry.mint({ botId: "bot", threadId: "thread", generation, depth: 0, kind: "memory", skillAuthoring: false, notOwnerAudience: true });
    const other = fixtureMemoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => ROSTER);
    expect(ownerDirectChat("thread", other)).toBe(false);
    void w;
    const why: { reason?: string; kept?: boolean } = {};
    continuationMemoryRevoked(LineageAllowance.turn(), key.threadId, key.driverInstance, key.nativeSession, other, why, true);
    expect(why.reason).toBe("checking:pending");
  });
  for (const [site, read] of SITES) it(`W-OT-S ${site}: shown to the owner's turn, still checking for every other reader`, () => {
    const w = world();
    expect(read(w.db, OWNER_TURN_READER)).toMatchObject(SHOWN);
    // G-OTHERS: the windows are all still there for a content reader that is not the owner's turn, an owner audience and a member audience
    expect(read(w.db, { audience: null })).toMatchObject(PENDING);
    if (!site.startsWith("lookupMemory") && !site.startsWith("refsLookup memory")) {
      expect(read(w.db, OWNER)).toMatchObject({ state: "checking" });
      expect(read(w.db, MEMBER)).toMatchObject({ state: "checking" });
    }
  });
  it("W-OT-R recall of a record (readable.ts writetimeRecordRefusal): no refusal for the owner's turn, the limit error for any other read", () => {
    const w = world();
    const evidence = [{ sourceId: "src", revision: 1, startByte: 0, endByte: 3 }] as unknown as Parameters<typeof writetimeRecordRefusal>[2];
    const refusal = (...reader: LineageReader[]): string => {
      try { return (writetimeRecordRefusal as (...args: unknown[]) => string | undefined)(w.db, { ...REC, scopeId: SCOPE }, evidence, ...reader) ?? "none"; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
    };
    expect(refusal(OWNER_TURN_READER)).toBe("none");
    expect(refusal()).toBe("MEMORY_REPLAY_LIMIT");
    expect(refusal({ audience: null })).toBe("MEMORY_REPLAY_LIMIT");
  });
  it("W-OT-C the production constant is exactly the settled content reader, frozen, and no other exported reader carries the flag", () => {
    const types = lineageTypes as unknown as { OWNER_TURN_READER?: LineageReader; readsSettledView?: (reader: LineageReader) => boolean; strictReader?: (reader: LineageReader) => LineageReader };
    expect(types.OWNER_TURN_READER).toEqual({ audience: null, settled: true });
    expect(Object.isFrozen(types.OWNER_TURN_READER)).toBe(true);
    expect([{ audience: null }, CONTENT_SESSION_READER, OWNER, MEMBER].map(reader => types.readsSettledView?.(reader))).toEqual([false, false, false, false]);
    expect(types.readsSettledView?.(OWNER_TURN_READER)).toBe(true);
    expect(types.strictReader?.(OWNER_TURN_READER)).toEqual({ audience: null });
  });
});

describe("G a deny rule is one durable row checked at read: the owner's turn is withheld by every settled row, windows or not", () => {
  const RULES: ReadonlyArray<readonly [rule: string, write: (f: WritetimeFixture) => void, read: (db: ReturnType<typeof database>) => unknown, want: object]> = [
    ["memory_deny_point on the line", f => f.denyLine("thread", 50, 9001), db => denyLookup(db, { threadId: "thread", lines: [{ messageId: "gen", author: "generated" }] }, OWNER_TURN_READER).get("gen"), { state: "withheld", reason: "deny-line" }],
    ["memory_deny_range over the line", f => f.denyRange("thread", 45, 60, 9001), db => denyLookup(db, { threadId: "thread", lines: [{ messageId: "gen", author: "generated" }] }, OWNER_TURN_READER).get("gen"), { state: "withheld", reason: "deny-range" }],
    ["memory_deny_point via a prefix's shown line", f => f.denyLine("thread", 50, 9001), db => refsLookup(db, [prefixShown()], OWNER_TURN_READER), { state: "withheld", reason: "deny-line" }],
    ["memory_deny_object on the record", f => f.denyMemory("record", "rec", 1, 9001), db => memoryLookup(db, [REC], OWNER_TURN_READER).get(memoryRefKey(REC)), { state: "withheld", reason: "deny-memory" }],
    ["memory_deny_object on the record's evidence source (the read-time rule)", f => f.denyMemory("source", "src", 0, 9001), db => memoryLookup(db, [REC], OWNER_TURN_READER).get(memoryRefKey(REC)), { state: "withheld", reason: "deny-memory" }],
    ["memory_deny scope", f => f.deny("scope", SCOPE), db => memoryLookup(db, [REC], OWNER_TURN_READER).get(memoryRefKey(REC)), { state: "withheld", reason: "scope-deny" }],
    ["memory_deny_session", f => f.denySession(key.threadId, key.driverInstance, key.nativeSession, 9001), db => sessionLookup(db, key, OWNER_TURN_READER), { state: "withheld", reason: "deny-session" }],
    ["memory_deny_range the session held (begun before its cap, ran past its line): the walk's session stage, read at read", f => f.denyRange("thread", 20, 950, 9001), db => sessionLookup(db, key, OWNER_TURN_READER), { state: "withheld", reason: "deny-session" }],
    ["memory_deny_range at the session's last line (last_lsn >= from)", f => f.denyRange("thread", 900, 950, 9001), db => sessionLookup(db, key, OWNER_TURN_READER), { state: "withheld", reason: "deny-session" }],
    ["memory_deny_range over the span the session holds (prefixVerdict, held span)", f => f.denyRange("thread", 20, 950, 9001), db => refsLookup(db, [prefixHeld()], OWNER_TURN_READER), { state: "withheld", reason: "deny-range" }],
    ["memory_deny thread (the session)", f => f.deny("thread", "thread"), db => sessionLookup(db, key, OWNER_TURN_READER), { state: "withheld", reason: "thread-deny" }],
    ["memory_deny thread (a prefix)", f => f.deny("thread", "thread"), db => refsLookup(db, [prefixHeld()], OWNER_TURN_READER), { state: "withheld", reason: "thread-deny" }],
  ];
  for (const [rule, write, read, want] of RULES) it(`G-RULE ${rule}`, () => {
    const w = world();
    expect(read(w.db)).toMatchObject(SHOWN);
    write(w.f);
    expect(read(w.db)).toMatchObject(want);
  });
  it("G-REVOKE a real revoke of a line the session held resets the owner turn's session at once, its walk unfinished (never kept, never shown)", () => {
    const w = world();
    commitRevoke(w.db, { kind: "line", threadId: "thread", messageIds: ["said"], cause: "edit" }, { inline: false });
    const why: { reason?: string; kept?: boolean } = {};
    expect(continuationMemoryRevoked(LineageAllowance.turn(), key.threadId, key.driverInstance, key.nativeSession, w.access, why, true)).toBe(true);
    expect(why.kept).toBeUndefined();
    expect(why.reason).toBe("writetime-deny-session");
  });
  it("W-FORGET a Forgotten record is honoured on the owner's turn at its commit, walk unfinished: the replies after its source's line are withheld and the session that held them resets", () => {
    const w = world();
    const rangesBefore = Number(w.db.prepare("SELECT count(*) AS n FROM memory_deny_range WHERE thread_id='thread'").get()!.n);
    // the forget's own commit (forget.ts forgetMemory commits exactly this root), its walk left to the paced runner
    const revoke = commitRevoke(w.db, { kind: "memory", ref: { kind: "record", id: "rec", version: 1 }, cause: "forget" }, { inline: false });
    expect(Number(w.db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id=? AND state NOT IN ('done','undone','folded')").get(revoke)!.n)).toBe(1);
    // the durable rows of the supporting source's capture line ("said", lsn 20), written by the commit under the forget's own revoke id
    expect(Number(w.db.prepare("SELECT count(*) AS n FROM memory_deny_range WHERE thread_id='thread' AND from_lsn=20 AND revoke_id=?").get(revoke)!.n)).toBe(1);
    expect(Number(w.db.prepare("SELECT count(*) AS n FROM memory_deny_range WHERE thread_id='thread'").get()!.n)).toBe(rangesBefore + 1);
    expect(denyLookup(w.db, { threadId: "thread", lines: [{ messageId: "gen", author: "generated" }] }, OWNER_TURN_READER).get("gen")).toMatchObject({ state: "withheld", reason: "deny-range" });
    expect(memoryLookup(w.db, [REC], OWNER_TURN_READER).get(memoryRefKey(REC))).toMatchObject({ state: "withheld" });
    expect(sessionLookup(w.db, key, OWNER_TURN_READER)).toMatchObject({ state: "withheld", reason: "deny-session" });
    const why: { reason?: string; kept?: boolean } = {};
    expect(continuationMemoryRevoked(LineageAllowance.turn(), key.threadId, key.driverInstance, key.nativeSession, w.access, why, true)).toBe(true);
    expect(why.kept).toBeUndefined();
  });
  // OPUS 60fe2e2655 HIGH-1: the commit's rows on both arms the first cut left out. Entry point: commitRevoke with forget.ts's own root
  // (and openBulkRevoke / activateBulkRevoke, the bulk's own writers), read by the owner turn's reader. RED on 60fe2e2655 ("shown") and on
  // d2c1083fbc ("checking") at the same assertion.
  it("W-FORGET-257 a Forgotten record with more capture lines than the seed cap (257) is honoured on the owner's turn at its commit, on every capture line", () => {
    const w = world(false);
    w.f.ready("cap", true);
    for (let k = 0; k < 256; k++) {
      w.f.owner("cap", `c-${k}`, 400 + 2 * k).reply("cap", `g-${k}`, 401 + 2 * k, { turnLsn: 400 + 2 * k }).source(`s-${k}`, SCOPE, { thread: "cap", message: `c-${k}` });
      w.db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES('rec',1,?,1,0,3)").run(`s-${k}`);
    }
    const revoke = commitRevoke(w.db, { kind: "memory", ref: { kind: "record", id: "rec", version: 1 }, cause: "forget" }, { inline: false });
    expect(Number(w.db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id=? AND state NOT IN ('done','undone','folded')").get(revoke)!.n), "setup: the walk is unfinished").toBe(1);
    for (const id of ["g-0", "g-128", "g-255"]) expect(denyLookup(w.db, { threadId: "cap", lines: [{ messageId: id, author: "generated" }] }, OWNER_TURN_READER).get(id), id).toMatchObject({ state: "withheld" });
    expect(denyLookup(w.db, { threadId: "thread", lines: [{ messageId: "gen", author: "generated" }] }, OWNER_TURN_READER).get("gen")).toMatchObject({ state: "withheld" });
  });
  it("W-FORGET-BULK a record Forgotten inside a bulk revoke is honoured on the owner's turn at its commit, the bulk's walk unfinished", () => {
    const w = world(false);
    const bulk = openBulkRevoke(w.db, "forget", false);
    commitRevoke(w.db, { kind: "memory", ref: { kind: "record", id: "rec", version: 1 }, cause: "forget" }, { inline: false, into: bulk });
    activateBulkRevoke(w.db, bulk);
    expect(Number(w.db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id=? AND state='active'").get(bulk)!.n), "setup: the bulk's walk is unfinished").toBe(1);
    expect(denyLookup(w.db, { threadId: "thread", lines: [{ messageId: "gen", author: "generated" }] }, OWNER_TURN_READER).get("gen")).toMatchObject({ state: "withheld" });
  });
  it("G-UNDO a range row of a revoke being undone, or undone, resets nothing (the write-time rule's own exclusion)", () => {
    const w = world();
    w.f.denyRange("thread", 20, 950, 9001).denyRange("thread", 30, 950, 9002);
    w.db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(9001,'line','{}',20,950,'undo','','undoing'),(9002,'line','{}',30,950,'undo','','undone')").run();
    expect(sessionLookup(w.db, key, OWNER_TURN_READER)).toMatchObject(SHOWN);
    expect(refsLookup(w.db, [prefixHeld()], OWNER_TURN_READER)).toMatchObject(SHOWN);
  });
  it("G-RANGE-NOT-HELD a range the session never held does not reset it: begun at or after the range's cap, or ended before its line", () => {
    const w = world();
    w.f.denyRange("thread", 5, 10, 9001).denyRange("thread", 901, 950, 9002);
    expect(sessionLookup(w.db, key, OWNER_TURN_READER)).toMatchObject(SHOWN);
  });
  it("G-NOTREADY the settled view is no shortcut past a thread that is not ready", () => {
    const w = world();
    w.f.ready("thread", false);
    expect(sessionLookup(w.db, key, OWNER_TURN_READER)).toMatchObject({ state: "checking", reason: "thread-not-ready" });
    expect(denyLookup(w.db, { threadId: "thread", lines: [{ messageId: "gen", author: "generated" }] }, OWNER_TURN_READER).get("gen")).toMatchObject({ state: "checking", reason: "thread-not-ready" });
    expect(refsLookup(w.db, [prefixHeld()], OWNER_TURN_READER)).toMatchObject({ state: "checking", reason: "thread-not-ready" });
  });
});
