// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN rulings 2026-11-17T06:28Z Q3 and Q5. Producer owner: trainred-b5 (recall-view.ts live-reader recompute and read-through);
// consumer owner: recall-scope (recall-view-index.ts page drivers).
// Q5: an in-flight access reads through its recomputed view only when that view is not wider than the one it was issued.
// Q3: the recompute at an epoch-moving writer is bounded by the live readers, never by the number of past generations.
// MAIN ruling 2026-11-17T19:46Z Q3 (binding over 06:28Z Q5 for the handle; MAIN ruling H5 2026-11-18T13:29Z): "after a reconciled epoch
// change, an OLD access handle with no scope MUST throw ... Live readers keep access only by RE-VALIDATING ... never by retaining the old
// handle." So after each epoch move below the old handle throws MEMORY_CONTEXT_REVOKED, and the reads go on through
// revalidateMemoryAccess(access), which stays bounded by the grant the access was issued (never wider, a lost scope never comes back).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { observeVerifiedHuman, linkHumanBinding, resolveHumanBinding, bindHumanThread } from "../human-principals.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { assertMemoryAccess, revalidateMemoryAccess, ensureScope, persistMemoryRoster, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { captureBotDeletion } from "./capture.ts";
import { stopMemoryRevocation } from "./memory-revocation.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { readableRecallView, recallViewCounters, recallViewHasScope, RECALL_LIVE_READERS_MAX, stopRecallViewMaintenance } from "./recall-view.ts";

beforeEach(async () => {
  closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); stopMemoryRevocation(); stopRecallViewMaintenance(); });
const empty = { search: async () => ({ hits: [], vectorRows: 0 }) };
function world(ids = ["a", "b", "gone"]) {
  const roster: MemoryRoster = { bots: ids.map(id => ({ id, threadId: `t-${id}`, section: "team" })), groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities();
  const access = (botId: string) => {
    const threadId = `t-${botId}`, generation = registry.begin(botId, threadId);
    const token = registry.mint({ botId, threadId, generation, kind: "memory", depth: 100, skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  };
  return { access, roster };
}
const pin = (id: string, scope: string) => database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',1,1,NULL,NULL,1)").run(id, scope, `${id} text`);
const grant = (id: string, scope: string, bot: string) => database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'bot',?,0,'granted','{}')").run(id, scope, bot);
const ids = async (access: ReturnType<ReturnType<typeof world>["access"]>) =>
  (await buildMemoryBundle("held", access, empty, { allowance: LineageAllowance.tool() })).recordVersions.map(r => r.id).sort();

it("narrower: after a peer's notebook is deleted the old handle throws; the re-validated access reads on through its narrower view, without the deleted scope", async () => {
  const w = world(), gone = ensureScope("bot", "gone"), own = ensureScope("bot", "a");
  grant("peer-grant", gone, "a"); pin("shared-record", gone); pin("own-record", own);
  const access = w.access("a");
  expect(await ids(access)).toEqual(["own-record", "shared-record"]);
  expect(recallViewHasScope(database(), access.view, gone)).toBe(true);
  transaction(db => captureBotDeletion(db, "gone"));
  expect(() => assertMemoryAccess(access)).toThrow("MEMORY_CONTEXT_REVOKED");
  const live = revalidateMemoryAccess(access);
  expect(() => assertMemoryAccess(live)).not.toThrow();
  expect(live.scopeIds).toContain(own);
  expect(live.scopeIds).not.toContain(gone);
  // the deny wins at once: the issued view no longer answers for the deleted scope, and reads are served from the narrower view.
  // ONEINDEX (designs/ONEINDEX-DESIGN.md, MAIN-GO 15:10:36Z): no narrowed view copy exists any more. The deletion moved the authority
  // epoch, so the issued scope-set handle answers for no scope at all (fail closed, recall-view.ts recallViewHasScope) and refuses a
  // read-through at the epoch fence; the narrower reads go through the re-validated access, which holds its own scope and not the deleted one.
  expect(recallViewHasScope(database(), access.view, gone)).toBe(false);
  expect(recallViewHasScope(database(), access.view, own)).toBe(false);
  expect(() => readableRecallView(database(), access.view)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(recallViewHasScope(database(), live.view, own)).toBe(true);
  expect(recallViewHasScope(database(), live.view, gone)).toBe(false);
  expect(await ids(live)).toEqual(["own-record"]);
  // the old handle is refused by bundle building too: it reads on only through the re-validated access
  await expect(ids(access)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
});

it("wider: a room added after an access was issued never reaches that access, old or re-validated; a fresh access reads it", async () => {
  const w = world(), own = ensureScope("bot", "a");
  pin("own-record", own);
  const access = w.access("a");
  expect(await ids(access)).toEqual(["own-record"]);
  const next = structuredClone(w.roster);
  next.groups.push({ id: "late-room", threadId: "late-thread", memberIds: ["a", "b"] });
  persistMemoryRoster(next, () => { w.roster.groups = next.groups; });
  const room = ensureScope("room", "late-room");
  pin("late-record", room);
  expect(() => assertMemoryAccess(access)).toThrow("MEMORY_CONTEXT_REVOKED");
  const live = revalidateMemoryAccess(access);
  expect(() => assertMemoryAccess(live)).not.toThrow();
  expect(() => assertMemoryAccess(live, room)).toThrow("MEMORY_SCOPE_DENIED");
  expect(live.scopeIds).not.toContain(room);
  // no read-through to the wider view: the issued view does not widen, and the old handle's read is refused (19:46Z Q3), never widened.
  // ONEINDEX (designs/ONEINDEX-DESIGN.md, MAIN-GO 15:10:36Z): no narrowed view copy exists any more; the stale scope-set handle refuses at the epoch fence (MEMORY_CONTEXT_REVOKED), not as an unavailable view.
  expect(() => readableRecallView(database(), access.view)).toThrow("MEMORY_CONTEXT_REVOKED");
  await expect(ids(access)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  expect(await ids(live)).toEqual(["own-record"]);
  const fresh = w.access("a");
  expect(recallViewHasScope(database(), fresh.view, room)).toBe(true);
  expect(await ids(fresh)).toContain("late-record");
});

it("narrowed then widened again: an access that lost a scope does not get it back in flight, by re-validating or by its old handle", async () => {
  const w = world(), peer = ensureScope("bot", "b"), own = ensureScope("bot", "a");
  grant("peer-grant", peer, "a"); pin("own-record", own);
  const access = w.access("a");
  expect(recallViewHasScope(database(), access.view, peer)).toBe(true);
  database().prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id='peer-grant'").run();
  reconcileMemoryRoster(w.roster);
  expect(() => assertMemoryAccess(access)).toThrow("MEMORY_CONTEXT_REVOKED");
  const narrowed = revalidateMemoryAccess(access);
  expect(() => assertMemoryAccess(narrowed)).not.toThrow();
  expect(narrowed.scopeIds).not.toContain(peer);
  expect(recallViewHasScope(database(), access.view, peer)).toBe(false);
  expect(await ids(narrowed)).toEqual(["own-record"]);
  database().prepare("UPDATE memory_scope_bindings SET state='granted' WHERE id='peer-grant'").run();
  reconcileMemoryRoster(w.roster);
  // the current view equals the issued one again, but it is wider than the view this access was narrowed to: refused, not widened
  expect(() => assertMemoryAccess(access)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => assertMemoryAccess(narrowed)).toThrow("MEMORY_CONTEXT_REVOKED");
  const again = revalidateMemoryAccess(access);
  expect(again.scopeIds).not.toContain(peer);
  expect(() => assertMemoryAccess(again, peer)).toThrow("MEMORY_SCOPE_DENIED");
  expect(recallViewHasScope(database(), access.view, peer)).toBe(false);
  // ONEINDEX (designs/ONEINDEX-DESIGN.md, MAIN-GO 15:10:36Z): no narrowed view copy exists any more; the stale scope-set handle refuses at the epoch fence (MEMORY_CONTEXT_REVOKED), not as an unavailable view.
  expect(() => readableRecallView(database(), access.view)).toThrow("MEMORY_CONTEXT_REVOKED");
  await expect(ids(access)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  expect(await ids(again)).toEqual(["own-record"]);
  const fresh = w.access("a");
  expect(recallViewHasScope(database(), fresh.view, peer)).toBe(true);
});

/** Statements one reconcile and the live access's re-validation prepare after `generations` earlier epoch moves that the same live
 * access re-validated through (19:46Z Q3: each move refuses the handle it had, so it goes on only by re-validating). */
function reconcileStatements(generations: number): number {
  const w = world(), own = ensureScope("bot", "a"), issued = w.access("a"), db = database();
  let access = issued;
  const move = () => db.prepare("UPDATE memory_scopes SET audience=audience WHERE id=?").run(own);
  for (let n = 0; n < generations; n++) {
    move(); reconcileMemoryRoster(w.roster);
    expect(() => assertMemoryAccess(access)).toThrow("MEMORY_CONTEXT_REVOKED");
    access = revalidateMemoryAccess(access); assertMemoryAccess(access);
  }
  move();
  const spy = vi.spyOn(db, "prepare");
  reconcileMemoryRoster(w.roster);
  const live = revalidateMemoryAccess(access);
  const count = spy.mock.calls.length; spy.mockRestore();
  expect(() => assertMemoryAccess(access)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => assertMemoryAccess(live)).not.toThrow();
  // ONEINDEX (designs/ONEINDEX-DESIGN.md, MAIN-GO 15:10:36Z): no narrowed view copy exists any more; the issued handle never reads as itself after the epoch moved: it refuses at the epoch fence.
  expect(() => readableRecallView(db, issued.view)).toThrow("MEMORY_CONTEXT_REVOKED");
  return count;
}
it("Q3: the recompute at a roster reconcile costs the same after 3 and after 24 past generations", async () => {
  const few = reconcileStatements(3);
  closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const many = reconcileStatements(24);
  expect(few).toBeGreaterThan(0);
  expect(many).toBe(few);
});

/** DESIGN-B5-PROOF F3 (W3b as built; see trainred-b5-n8 DONE DEVIATION D1): `claims` live memory claims of one linked-human turn, each
 * holding its issued view, plus one access of another bot issued last. Returns the registry entries one reconcile inspects and the
 * linked-human binding reads it makes, and whether the last access still reads after that reconcile. */
function claimsReconcile(claims: number): { visits: number; bindingReads: number; lastAlive: boolean } {
  const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
  const person = resolveHumanBinding(bindingId);
  bindHumanThread("t-a", person);
  const w = world(), db = database(), registry = new InternalCapabilities();
  const generation = registry.begin("a", "t-a", undefined, person);
  const held = Array.from({ length: claims }, () => {
    const token = registry.mint({ botId: "a", threadId: "t-a", generation, kind: "memory", depth: 100, skillAuthoring: false, humanPrincipal: person });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => w.roster);
  });
  const last = w.access("b");
  db.prepare("UPDATE memory_scopes SET audience=audience WHERE id=?").run(ensureScope("bot", "b"));
  const visits = recallViewCounters().readerVisits, spy = vi.spyOn(db, "prepare");
  reconcileMemoryRoster(w.roster);
  const bindingReads = spy.mock.calls.filter(([text]) => String(text).includes("subject_type='human-binding'")).length; spy.mockRestore();
  let lastAlive = true;
  try { assertMemoryAccess(last); } catch { lastAlive = false; }
  for (const access of held) expect(() => assertMemoryAccess(access)).not.toThrow();
  return { visits: recallViewCounters().readerVisits - visits, bindingReads, lastAlive };
}
const freshFile = async () => { closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); };
it("Q3 (F3 W3b): one reconcile inspects at most the bound of live readers, the same for 200 and for 400 live claims", async () => {
  const some = claimsReconcile(200);
  await freshFile();
  const many = claimsReconcile(400);
  expect(some.bindingReads).toBeGreaterThan(0);
  expect(many.bindingReads).toBe(some.bindingReads);
  expect(some.visits).toBeGreaterThan(0);
  expect(many.visits).toBeLessThanOrEqual(RECALL_LIVE_READERS_MAX);
  expect(many.visits).toBe(some.visits);
});
it("Q3 (F3 W3a as built): the bound drops the oldest entries, so an access issued after it is full is still recomputed and reads", () => {
  expect(claimsReconcile(RECALL_LIVE_READERS_MAX + 2).lastAlive).toBe(true);
});

/** View builds one roster write and the two live readers' re-validations make when it seats `added` new members (each a new scope).
 * 19:46Z Q3: the write refuses both old handles; each reader goes on only by re-validating. */
function rosterWriteBuilds(added: number): number {
  const w = world(), a = w.access("a"), b = w.access("b");
  const next = structuredClone(w.roster);
  for (let n = 0; n < added; n++) next.bots.push({ id: `new-${n}`, threadId: `t-new-${n}`, section: "team" });
  const before = recallViewCounters().oracleComputes;
  persistMemoryRoster(next, () => { w.roster.bots = next.bots; });
  const live = [a, b].map(access => revalidateMemoryAccess(access));
  const builds = recallViewCounters().oracleComputes - before;
  for (const access of [a, b]) expect(() => assertMemoryAccess(access)).toThrow("MEMORY_CONTEXT_REVOKED");
  for (const access of live) expect(() => assertMemoryAccess(access)).not.toThrow();
  return builds;
}
it("Q3: a roster write that seats 1 or 6 new members builds the live readers' views the same number of times", async () => {
  const one = rosterWriteBuilds(1);
  closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const six = rosterWriteBuilds(6);
  // ONEINDEX (designs/ONEINDEX-DESIGN.md, MAIN-GO 15:10:36Z): no narrowed view copy exists any more; a roster write and the re-validations build no view at all (the scope set is computed, never built),
  // so the count is 0 for 1 and for 6 new members; the re-validated readers still read (asserted in rosterWriteBuilds).
  expect(one).toBe(0);
  expect(six).toBe(one);
});



it("F3: an oldest issued view evicted by newer leases refuses after the epoch moves", () => {
  const w = world(), oldest = w.access("a"), registry = new InternalCapabilities();
  const generation = registry.begin("b", "t-b");
  const newer = Array.from({ length: RECALL_LIVE_READERS_MAX }, () => {
    const token = registry.mint({ botId: "b", threadId: "t-b", generation, kind: "memory", depth: 100, skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => w.roster);
  });
  database().prepare("UPDATE memory_scopes SET audience=audience WHERE id=?").run(ensureScope("bot", "a"));
  reconcileMemoryRoster(w.roster);
  // ONEINDEX (designs/ONEINDEX-DESIGN.md, MAIN-GO 15:10:36Z): no narrowed view copy exists any more; no live reader is recomputed in place (19:46Z Q3), so every handle from before the move refuses at the epoch
  // fence, the oldest and the newest alike; the newest reads on only by re-validating.
  expect(() => readableRecallView(database(), oldest.view)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => readableRecallView(database(), newer.at(-1)!.view)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => assertMemoryAccess(revalidateMemoryAccess(newer.at(-1)!))).not.toThrow();
});
