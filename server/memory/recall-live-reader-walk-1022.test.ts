// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope (recall-view.ts live-reader recompute). Consumer owner: recallwalk row 39 (bot deletion, capture.ts).
//
// 1022 RECALLWALK row 39 (ASTRA 0fb2ede338): bot deletion rebuilds the live readers' views inside its own write transaction
// (captureBotDeletion -> prepareActiveRecallReaders -> prepareRecallContextSync). A linked person's construction walks the whole
// human-thread range, and another person's thread costs a step but no construction budget, so one stale linked reader held the deletion's
// lock for the whole range. The linked-person rebuilds of one such pass now share RECALL_SYNC_READER_SLICES slices; past that the context
// is queued for the background builder and the reader refuses until it is built. Owner readers are rebuilt in full, as before.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { observeVerifiedHuman, linkHumanBinding, resolveHumanBinding, bindHumanThread, isGroupPrincipal, type HumanPrincipal } from "../human-principals.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { assertMemoryAccess, ensureScope, reconcileMemoryRoster, revalidateMemoryAccess, type MemoryRoster } from "./policy.ts";
import { fixtureMemoryAccess as memoryAccess } from "../testing/recall-access-fixture.ts";
import { captureBotDeletion } from "./capture.ts";
import { stopMemoryRevocation } from "./memory-revocation.ts";
import { readableRecallView, recallViewHasScope, RECALL_BUILD_SLICE, stopRecallViewMaintenance, waitForRecallConstructionIdleForTest } from "./recall-view.ts";
import { RECALL_CONSTRUCTION_BYTES } from "./recall-construction.ts";

beforeEach(async () => {
  closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); stopMemoryRevocation(); stopRecallViewMaintenance(); closeDatabase(); });

const OTHER_THREADS = 50_000;
function world(ids = ["a", "b", "gone"]) {
  const roster: MemoryRoster = { bots: ids.map(id => ({ id, threadId: `t-${id}`, section: "team" })), groups: [] };
  reconcileMemoryRoster(roster);
  return { roster, registry: new InternalCapabilities() };
}
/** OTHER_THREADS human-thread bindings of other people: each is one step of a linked person's walk and none is charged. */
function seedOtherPeoplesThreads() {
  const db = database(), scope = ensureScope("workspace", "history");
  db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO memory_scope_bindings SELECT 'history-'||i,?,'human-thread','history-'||i,1,'granted',json_object('personId','fixture-other-'||(i%7)) FROM n`)
    .run(OTHER_THREADS, scope);
}
/** Every `$.personId` evaluation SQLite makes while `work` runs (human-thread walk steps, matched or not). */
function personReads(work: () => void): number {
  const db = database(), native = new DatabaseSync(":memory:"), extract = native.prepare("SELECT json_extract(?, ?) AS value");
  let reads = 0, counting = false;
  db.function("json_extract", (value, path) => { if (counting && path === "$.personId") reads++; return extract.get(value, path)!.value; });
  try { counting = true; work(); } finally { counting = false; }
  return reads;
}
/** The v1.0.20 bound: the rows one charged walk (4 KiB a row) read before the construction budget refused it, in build slices. */
const SYNC_SLICES = RECALL_CONSTRUCTION_BYTES / 4096 / RECALL_BUILD_SLICE;

it("W-L1: bot deletion's live rebuilds of two linked readers share one bounded part of 50,000 other people's threads under its lock; owner and room readers are rebuilt in full; the queued builds finish the linked ones", async () => {
  const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
  const person = resolveHumanBinding(bindingId);
  bindHumanThread("t-a", person); bindHumanThread("t-b", person);
  // a channel room (group principal) on bot c; bot d is the workspace owner's
  const group = resolveHumanBinding(observeVerifiedHuman({ platform: "whatsapp", connectionId: "fixture-group", authorityId: "fixture", userId: "fixture-room@g.us" }));
  bindHumanThread("t-c", group);
  expect(isGroupPrincipal(group)).toBe(true);
  const { roster, registry } = world(["a", "b", "c", "d", "gone"]), gone = ensureScope("bot", "gone"), later = ensureScope("bot", "later");
  // the deleted bots had shared their notebooks: revoking each grant moves the authority epoch, so the linked readers' views are stale
  const share = database().prepare(`INSERT INTO memory_scope_bindings VALUES(?,?,'bot','b',0,'granted','{}')`);
  share.run("peer-grant", gone); share.run("later-grant", later);
  seedOtherPeoplesThreads();
  const issue = (botId: string, principal?: HumanPrincipal) => {
    const threadId = `t-${botId}`, generation = registry.begin(botId, threadId, undefined, principal);
    const token = registry.mint({ botId, threadId, generation, kind: "memory", depth: 100, skillAuthoring: false, ...(principal ? { humanPrincipal: principal } : {}) });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  };
  // issued first, so the pass (newest reader first) reaches them after the linked readers have spent the allowance
  const unbounded = [issue("c", group), issue("d")];
  const readers = [issue("a", person), issue("b", person)];
  for (const access of [...unbounded, ...readers]) expect(() => assertMemoryAccess(access)).not.toThrow();

  const underLock = personReads(() => transaction(db => captureBotDeletion(db, "gone")));
  // ONEINDEX (designs/ONEINDEX-DESIGN.md "Every reader/writer": recall-view.ts build/prepare deleted, nothing to rebuild): the deletion builds no view
  // under its lock, so it reads none of the human-thread range (was: a bounded rebuild ran, 0 < reads <= SYNC_SLICES x RECALL_BUILD_SLICE + 64)
  expect(underLock).toBe(0);
  // fail closed until the background builder has built the views: no current view is read through
  for (const access of readers) expect(() => readableRecallView(database(), access.view)).toThrow();
  // ONEINDEX (designs/ONEINDEX-DESIGN.md "Every reader/writer": recall-view.ts build/prepare deleted, nothing to rebuild): the room and owner readers'
  // stale handles from the past authority epoch fail closed too (recall-view.ts recallViewHasScope epoch fence), and their re-validated
  // accesses read at once without the deleted scope (was: rebuilt inside the deletion, read through to a new generation)
  for (const access of unbounded) {
    expect(() => readableRecallView(database(), access.view)).toThrow();
    let live = access;
    expect(() => { live = revalidateMemoryAccess(access); }).not.toThrow();
    expect(() => assertMemoryAccess(live)).not.toThrow();
    expect(live.scopeIds).not.toContain(gone);
  }
  // a second writer before the background builder ran: the deferred contexts are queued again, never walked again under its lock
  const secondPass = personReads(() => transaction(db => captureBotDeletion(db, "later")));
  expect(secondPass).toBe(0);

  // both contexts were queued: the background builder finishes them in their own slices, and the re-validated accesses read without the
  // deleted scope, with no new demand
  await waitForRecallConstructionIdleForTest(roster);
  for (const access of readers) {
    let live = access;
    expect(() => { live = revalidateMemoryAccess(access); }).not.toThrow();
    expect(() => assertMemoryAccess(live)).not.toThrow();
    expect(live.scopeIds).not.toContain(gone);
  }
}, 120_000);

it("W-L2: an owner reader whose membership oracle runs past the linked-person slice bound is still rebuilt in full inside the deletion and reads through at once", () => {
  // 6,000 task threads of the owner's bot, each with its conversation scope: every one is a roster step, an own-thread step and a sort
  // move of the owner's construction, so its oracle takes far more than SYNC_SLICES slices without reading the human-thread range
  const tasks = Array.from({ length: 6_000 }, (_, n) => ({ threadId: `t-a-task-${n}` }));
  const roster: MemoryRoster = { bots: [{ id: "a", threadId: "t-a", section: "team", tasks }, ...["b", "gone"].map(id => ({ id, threadId: `t-${id}`, section: "team" }))], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(), own = ensureScope("bot", "a"), gone = ensureScope("bot", "gone");
  database().exec("BEGIN");
  try { for (const task of tasks) ensureScope("conversation", task.threadId); database().exec("COMMIT"); } catch (error) { database().exec("ROLLBACK"); throw error; }
  database().prepare(`INSERT INTO memory_scope_bindings VALUES('peer-grant',?,'bot','a',0,'granted','{}')`).run(gone);
  const threadId = "t-a", generation = registry.begin("a", threadId);
  const token = registry.mint({ botId: "a", threadId, generation, kind: "memory", depth: 100, skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  expect(recallViewHasScope(database(), access.view, gone)).toBe(true);
  expect(access.scopeIds.length).toBeGreaterThan(SYNC_SLICES * 10);

  transaction(db => captureBotDeletion(db, "gone"));
  // ONEINDEX (designs/ONEINDEX-DESIGN.md "Every reader/writer": recall-view.ts build/prepare deleted, nothing to rebuild): the stale handle fails closed and
  // the re-validated access holds the owner's own scope and not the deleted one (was: rebuilt in full inside the deletion, read through)
  expect(() => readableRecallView(database(), access.view)).toThrow();
  const live = revalidateMemoryAccess(access);
  expect(recallViewHasScope(database(), live.view, own)).toBe(true);
  expect(recallViewHasScope(database(), live.view, gone)).toBe(false);
}, 120_000);

it("W-L3: a linked reader whose oracle is small but whose record copy takes more than the slice bound is rebuilt in full inside the deletion", () => {
  const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
  const person = resolveHumanBinding(bindingId);
  bindHumanThread("t-a", person);
  const { roster, registry } = world(), gone = ensureScope("bot", "gone"), own = ensureScope("conversation", "t-a");
  database().prepare(`INSERT INTO memory_scope_bindings VALUES('peer-grant',?,'bot','b',0,'granted','{}')`).run(gone);
  // more records in the person's own conversation than SYNC_SLICES record pages: only the copy is long, not the walk
  const records = SYNC_SLICES * RECALL_BUILD_SLICE + 1_000;
  database().prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO memory_records SELECT 'own-'||i,1,?,'fact','own text '||i,'owner-statement','active',1,1,NULL,NULL,1 FROM n`).run(records, own);
  const generation = registry.begin("a", "t-a", undefined, person);
  const token = registry.mint({ botId: "a", threadId: "t-a", generation, kind: "memory", depth: 100, skillAuthoring: false, humanPrincipal: person });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  expect(recallViewHasScope(database(), access.view, own)).toBe(true);

  transaction(db => captureBotDeletion(db, "gone"));
  // ONEINDEX (designs/ONEINDEX-DESIGN.md "Every reader/writer": recall-view.ts build/prepare deleted, nothing to rebuild): the stale handle fails closed and
  // the re-validated linked access reads its own conversation at once (was: rebuilt in full inside the deletion, read through)
  expect(() => readableRecallView(database(), access.view)).toThrow();
  const live = revalidateMemoryAccess(access);
  expect(recallViewHasScope(database(), live.view, own)).toBe(true);
  expect(recallViewHasScope(database(), live.view, gone)).toBe(false);
}, 120_000);
