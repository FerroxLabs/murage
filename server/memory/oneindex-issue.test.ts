// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: q1023-oneindex (issuance from the computed scope set, H1 fence, H4 cold-index fallback); rulings = MAIN.
// The production entry points: memoryAccess (policy.ts, the turn's memory capability) and searchMemory (search.ts, the turn's recall).
// No recall view is prepared or built anywhere in this file: the first owner turn after a start must recall without one.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { closeMessageDb } from "../message-db.ts";
import { ensureWorkspace } from "../workspace.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resetDataRootsForTest } from "../data-roots.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { accessIncludesRoom, assertMemoryAccess, ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { scopeSetOf } from "./oneindex.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "../human-principals.ts";
import { commitMemoryImport, previewMemoryImport } from "./import.ts";
import { searchMemory } from "./search.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { resetSessionHolds } from "./disclosures.ts";

const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: "a", threadId: "thread-a" }, { id: "b", threadId: "thread-b" }], groups: [] };
/** The semantic helper is cold (no vectors yet), as on the first turn after a start. */
const cold = { search: async () => ({ hits: [], vectorRows: 0, coverageComplete: false }) };
beforeEach(() => {
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetDataRootsForTest(); resetSessionHolds();
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
  const root = ensureWorkspace("a"), ticket = ownerMemoryTicket();
  writeFileSync(join(root, "MEMORY.md"), "The lighthouse keeper paints the shutters teal every spring.\n");
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
});
afterEach(() => { closeMessageDb(); closeDatabase(); });
function issue(bot = "a", thread = "thread-a", live: () => MemoryRoster = () => roster): { access?: MemoryAccess; outcome: string } {
  const registry = new InternalCapabilities(), generation = registry.begin(bot, thread);
  const token = registry.mint({ botId: bot, threadId: thread, generation, depth: 0, kind: "memory", skillAuthoring: false });
  try { return { access: memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, live), outcome: "issued" }; }
  catch (error) { return { outcome: error instanceof Error ? error.constructor.name + ":" + error.message : String(error) }; }
}
const ids = (result: { hits: Array<{ id: string }> }) => result.hits.map(hit => hit.id);

it("W-A first owner turn after a start: access is issued with no built view (base: held, RecallPreparationPending)", () => {
  const { outcome } = issue();
  expect(outcome).toBe("issued");
});

it("W-H4 cold index (no memory-index.db, no vectors): recall is not empty, the owner's record is found by its words", async () => {
  const { access } = issue();
  expect(access, "issuance").toBeDefined();
  const found = await searchMemory("what colour are the lighthouse shutters", access!, cold, { allowance: LineageAllowance.tool() });
  const record = database().prepare("SELECT id FROM memory_records WHERE text LIKE '%lighthouse%' AND state='active'").get()!.id as string;
  expect(ids(found)).toContain(record);
});

it("W-H1 a revoke that commits mid-turn refuses the next read (room membership withdrawn: the scope fence in assertMemoryAccess)", async () => {
  // The owner's direct turn also recalls the owner-only room it sits in (recall both ways); one record lives in the room's scope.
  const withRoom: MemoryRoster = { ...roster, memoryRosterRevision: 2, groups: [{ id: "room", threadId: "room-thread", memberIds: ["a"] }] };
  reconcileMemoryRoster(withRoom);
  let live = withRoom;
  const db = database(), roomScope = ensureScope("room", "room");
  const own = db.prepare("SELECT id FROM memory_records WHERE text LIKE '%lighthouse%' AND state='active'").get()!.id as string;
  db.exec("CREATE TEMP TABLE w_rec AS SELECT * FROM memory_records WHERE 0; CREATE TEMP TABLE w_ev AS SELECT * FROM memory_evidence WHERE 0; CREATE TEMP TABLE w_rc AS SELECT * FROM memory_projection_receipts WHERE 0");
  db.prepare("INSERT INTO w_rec SELECT * FROM memory_records WHERE id=?").run(own); db.prepare("INSERT INTO w_ev SELECT * FROM memory_evidence WHERE record_id=?").run(own);
  db.prepare("INSERT INTO w_rc SELECT * FROM memory_projection_receipts WHERE record_id=?").run(own);
  db.prepare("UPDATE w_rec SET id='room-lighthouse',scope_id=?,text='The room agreed the lighthouse shutters stay teal.'").run(roomScope);
  db.exec("UPDATE w_ev SET record_id='room-lighthouse'; UPDATE w_rc SET record_id='room-lighthouse'; INSERT INTO memory_records SELECT * FROM w_rec; INSERT INTO memory_evidence SELECT * FROM w_ev; INSERT INTO memory_projection_receipts SELECT * FROM w_rc");
  const { access } = issue("a", "thread-a", () => live);
  expect(access, "issuance").toBeDefined();
  const before = ids(await searchMemory("lighthouse shutters", access!, cold, { allowance: LineageAllowance.tool() }));
  expect(before, "the room record is recalled before the revoke (non-vacuous)").toContain("room-lighthouse");
  // Mid-turn: the room is gone from the roster (membership withdrawn). Same access, next read.
  live = { ...roster, memoryRosterRevision: 3, groups: [] };
  reconcileMemoryRoster(live);
  let after: string[] | string;
  try { after = ids(await searchMemory("lighthouse shutters", access!, cold, { allowance: LineageAllowance.tool() })); }
  catch (error) { after = error instanceof Error ? error.message : String(error); }
  expect(Array.isArray(after) ? after.includes("room-lighthouse") : after === "MEMORY_CONTEXT_REVOKED" || after === "MEMORY_SCOPE_DENIED" ? false : `unexpected ${after}`, `after revoke: ${JSON.stringify(after)}`).toBe(false);
});

it("W-A2 issuance writes nothing and no recall view exists after the turn reads", async () => {
  const db = database(), before = Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  const { access } = issue();
  expect(access, "issuance").toBeDefined();
  const issuanceWrites = Number(db.prepare("SELECT total_changes() AS n").get()!.n) - before;
  await searchMemory("lighthouse", access!, cold, { allowance: LineageAllowance.tool() });
  const views = Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views").get()!.n);
  expect({ views, issuanceWrites }).toEqual({ views: 0, issuanceWrites: 0 });
});

it("W-H3 a person lineage scope never reaches bot recall: the person's other thread is lineage-only, its record is never recalled or citable", async () => {
  // The reader's thread is bound to a linked person who also owns a thread outside the roster (S(P) lineage, recall-membership.ts).
  const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
  const person = resolveHumanBinding(bindingId);
  for (const thread of ["thread-a", "person-elsewhere"]) bindHumanThread(thread, person);
  const elsewhere = ensureScope("conversation", "person-elsewhere");
  // control: the person's own thread, which the reader recalls in full
  database().prepare("INSERT INTO memory_records VALUES('own-record',1,?,'constraint','The lighthouse shutters are painted on this thread.','owner-statement','active',0,0,NULL,NULL,1)").run(ensureScope("conversation", "thread-a"));
  database().prepare("INSERT INTO memory_records VALUES('elsewhere-record',1,?,'constraint','The lighthouse lantern is lit from the person elsewhere thread.','owner-statement','active',0,0,NULL,NULL,1)").run(elsewhere);
  const registry = new InternalCapabilities(), generation = registry.begin("a", "thread-a", undefined, person);
  const token = registry.mint({ botId: "a", threadId: "thread-a", generation, depth: 0, kind: "memory", skillAuthoring: false, humanPrincipal: person });
  const access: MemoryAccess | undefined = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const set = scopeSetOf(access!.view)!.set;
  // non-vacuous: the scope IS in the reader's lineage set, and only there
  expect(set.lineage).toContain(elsewhere);
  expect(access!.scopeIds).not.toContain(elsewhere);
  // the outcome (hits, or the refusal a leaked hit causes downstream) is compared exactly: only the person's own record is recalled
  const found = await searchMemory("lighthouse lantern shutters", access!, cold, { allowance: LineageAllowance.tool() }).then(ids, (error: Error) => [error.message]);
  expect(found).toEqual(["own-record"]);
  expect(() => assertMemoryAccess(access!, elsewhere)).toThrow("MEMORY_SCOPE_DENIED");
});

// FABLE c087b9b70b H3: the room check that gates owner-private reads (policy.ts accessIncludesRoom) reads the memoized scope set at the
// current epoch. A room-membership change made on the SAME roster object (in place, as the Store does) must be seen at once.
it("W-H3-ROOM: a task thread that joins a room on the same roster object is a room reader at once (accessIncludesRoom)", () => {
  const live: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: "a", threadId: "thread-a", tasks: [{ threadId: "task-a" }] }, { id: "b", threadId: "thread-b" }], groups: [] };
  reconcileMemoryRoster(live);
  const { access, outcome } = issue("a", "task-a", () => live);
  expect(outcome).toBe("issued");
  const room = () => { try { return String(accessIncludesRoom(access!)); } catch (error) { return String((error as Error).message); } };
  expect(room()).toBe("false");
  live.groups.push({ id: "room-x", threadId: "room-x-thread", memberIds: ["a", "b"], tasks: [{ threadId: "task-a" }] });
  live.memoryRosterRevision = 2;
  reconcileMemoryRoster(live);
  expect(room()).toBe("true");
});
// FABLE :7525 H1 / :7585 H-C / :7661 / :7752 (OPEN until r8): a grant, binding, team or project revoke written with the SAME roster object
// must refuse the next read of the issued access. Nothing about the roster changes, so only the authority epoch (moved by the binding and scope
// triggers) can make the memoized scope set (cachedRecallScopes) and the issued handle (recallViewHasScope) stale. One row per write kind,
// entered through the turn's own entry points: memoryAccess issues, searchMemory recalls, assertMemoryAccess fences the scope.
const sameRoster: MemoryRoster = { memoryRosterRevision: 2, bots: [{ id: "a", threadId: "thread-a", tasks: [{ threadId: "task-a" }] }, { id: "b", threadId: "thread-b" }], groups: [] };
const grantTo = (id: string, scope: string) => database().prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'bot','a',0,'granted','{}')").run(id, scope);
const epochRows: Array<{ row: string; scope: () => string; grant: () => void; revoke: () => void }> = [
  { row: "binding (owner settings exclude the task thread)", scope: () => ensureScope("conversation", "task-a"), grant: () => {},
    revoke: () => { database().prepare("INSERT INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','owner-settings',0,'granted',?)").run(ensureScope("workspace", "settings"), JSON.stringify({ excludedThreadIds: ["task-a"] })); } },
  { row: "team grant revoked", scope: () => ensureScope("team", "crew"), grant: () => grantTo("team-grant", ensureScope("team", "crew")),
    revoke: () => { database().prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id='team-grant'").run(); } },
  { row: "project grant revoked", scope: () => ensureScope("project", "harbor"), grant: () => grantTo("project-grant", ensureScope("project", "harbor")),
    revoke: () => { database().prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id='project-grant'").run(); } },
];
for (const { row, scope, grant, revoke } of epochRows) {
  it(`W-H1-EPOCH ${row}: same roster object, the next read of the issued access is refused`, async () => {
    reconcileMemoryRoster(sameRoster);
    const db = database(), target = scope(); grant();
    const own = db.prepare("SELECT id FROM memory_records WHERE text LIKE '%lighthouse%' AND state='active'").get()!.id as string;
    db.exec("CREATE TEMP TABLE e_rec AS SELECT * FROM memory_records WHERE 0; CREATE TEMP TABLE e_ev AS SELECT * FROM memory_evidence WHERE 0; CREATE TEMP TABLE e_rc AS SELECT * FROM memory_projection_receipts WHERE 0");
    db.prepare("INSERT INTO e_rec SELECT * FROM memory_records WHERE id=?").run(own); db.prepare("INSERT INTO e_ev SELECT * FROM memory_evidence WHERE record_id=?").run(own);
    db.prepare("INSERT INTO e_rc SELECT * FROM memory_projection_receipts WHERE record_id=?").run(own);
    db.prepare("UPDATE e_rec SET id='scoped-lighthouse',scope_id=?,text='The crew agreed the lighthouse shutters stay teal.'").run(target);
    db.exec("UPDATE e_ev SET record_id='scoped-lighthouse'; UPDATE e_rc SET record_id='scoped-lighthouse'; INSERT INTO memory_records SELECT * FROM e_rec; INSERT INTO memory_evidence SELECT * FROM e_ev; INSERT INTO memory_projection_receipts SELECT * FROM e_rc");
    const { access } = issue("a", "thread-a", () => sameRoster);
    expect(access, "issuance").toBeDefined();
    expect(() => assertMemoryAccess(access!, target), "the scope is readable before the revoke (non-vacuous)").not.toThrow();
    expect(ids(await searchMemory("lighthouse shutters", access!, cold, { allowance: LineageAllowance.tool() })), "recalled before the revoke (non-vacuous)").toContain("scoped-lighthouse");
    revoke();
    let fence: string;
    try { assertMemoryAccess(access!, target); fence = "read"; } catch (error) { fence = error instanceof Error ? error.message : String(error); }
    expect(["MEMORY_CONTEXT_REVOKED", "MEMORY_SCOPE_DENIED"], `fence after the revoke: ${fence}`).toContain(fence);
    let after: string[] | string;
    try { after = ids(await searchMemory("lighthouse shutters", access!, cold, { allowance: LineageAllowance.tool() })); }
    catch (error) { after = error instanceof Error ? error.message : String(error); }
    expect(Array.isArray(after) ? after.includes("scoped-lighthouse") : after === "MEMORY_CONTEXT_REVOKED" || after === "MEMORY_SCOPE_DENIED" ? false : `unexpected ${after}`, `recall after the revoke: ${JSON.stringify(after)}`).toBe(false);
  });
}
