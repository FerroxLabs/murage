// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SCOPED-REVOKES (1.0.4): a roster save or a notebook re-import ends only the receipts it withdraws. Creating a bot or a task, and
// re-importing a notebook, used to revoke every receipt on the machine (policy.ts:151, import.ts:192 at d12c102b6), so every warm bot
// started a fresh engine session on its next turn. Removing a thread ends that thread's receipts and nothing else; what other threads
// were shown from it is judged live on their next continuation; an audience change (section, membership, desk, partition) still ends
// everything under a new policy revision.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { Store } from "../store.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { assertMemoryAccess, ensureScope, memoryAccess, persistMemoryRoster, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { memoryState, setMemoryMode } from "./repository.ts";
import { buildMemoryBundle, hydrateDisclosedMemoryRecord } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { recordMemorySettlement } from "./settlement.ts";
import { COLD_CHECK_ROWS, continuationMemoryRevoked, deliverMemoryDisclosure, filterDirectReplay, prepareMemoryDisclosure, resetSessionHolds } from "./disclosures.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { markSessionKnown } from "./testing/legacy-file-model.ts";
import { authorityParts } from "./authority-epoch.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { commitMemoryImport, previewMemoryImport } from "./import.ts";
import { ensureWorkspace } from "../workspace.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(async () => { closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); thawRootSetWritesForTest(true); resetSessionHolds(); });
afterEach(() => { thawRootSetWritesForTest(false); vi.restoreAllMocks(); });

/** Every "memory receipts revoked" line the code under test logs. */
const policyWatermark = () => Number(database().prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='policy_bump_lsn'").get()?.value ?? 0);
function revokeLines() {
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { const line = args.map(String).join(" "); if (line.includes("memory receipts revoked")) lines.push(line); });
  return lines;
}
const policyRevision = () => memoryState().policyRevision;
const hard = () => authorityParts()?.hard;
const receiptState = (bundleId: string) => database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundleId)?.state;
const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };

function drain() {
  for (let n = 0; n < 100; n++) {
    const work = claimMemoryJob("scoped-revokes");
    if (!work) return;
    const result = captureWork(work);
    publishMemoryWork(work, "scoped-revokes", result);
    if (result.status === "complete") refreshMemoryCheckpoint(work.id);
  }
}

/** reset-loop.test.ts world(): the real pipeline (Store messages, settlement, capture, checkpoints, frame receipts) and the same two
 * continuation checks a direct turn makes (index.ts). The Store saves its roster through persistMemoryRoster (memoryReady, store.ts:1606). */
function world(engine = "claude") {
  const store = new Store(() => ({ instanceId: engine, model: "fixture" }));
  const bot = store.createBot(); store.patchBot(bot.id, { name: "Sable" });
  setMemoryMode("active");
  const threadId = bot.threadId;
  const roster = (): MemoryRoster => ({ bots: store.bots, groups: store.groups } as unknown as MemoryRoster);
  const registry = new InternalCapabilities();
  const access = () => {
    const generation = registry.begin(bot.id, threadId);
    const token = registry.mint({ botId: bot.id, threadId, generation, depth: 0, kind: "memory", skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, roster);
  };
  let session = "S-1", sessions = 1;
  const resets: string[] = [];
  const receipts: string[] = [];
  const turn = async (n: number) => {
    const allowance = LineageAllowance.turn();
    store.appendMessage(threadId, { role: "user", kind: "text", text: `Tell me about item ${n} please.`, origin: "desktop" } as never);
    recordMemorySettlement(threadId, `t${n}`, "working");
    drain();
    const a = access();
    const earlyWhy: { reason?: string } = {};
    const early = n > 1 && continuationMemoryRevoked(allowance, threadId, engine, session, a, earlyWhy);
    const why: { reason?: string } = {};
    const revoked = n > 1 && continuationMemoryRevoked(allowance, threadId, engine, session, a, why);
    if (early || revoked) { resets.push(`${earlyWhy.reason ?? "-"} | ${why.reason ?? "-"}`); session = `S-${++sessions}`; }
    filterDirectReplay(allowance, threadId, store.activePath(threadId) as never, a, new Set());
    const bundle = await buildMemoryBundle(`item ${n}`, a, bridge, { allowance });
    const receipt = new MemoryDispatchReceipt(bundle, a, engine);
    receipt.sessionStarted(session); receipt.accepted(); receipts.push(bundle.bundleId);
    markSessionKnown(threadId, engine, session, bot.id);
    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "", turnId: `t${n}`, from: { botId: bot.id, name: "Sable", color: "x" } } as never);
    receipt.output(reply.id);
    store.patchMessage(threadId, reply.id, { text: `Item ${n} is a blue widget with ${n} parts.` } as never);
    store.markTerminalAssistantMessage(threadId, `t${n}`, "completed");
    drain();
  };
  /** `count` receipts citing nothing, appended to the current session as its newest rows (what a long session accumulates). */
  const fill = (count: number) => {
    const state = memoryState(), db = database();
    for (let n = 0; n < count; n++) db.prepare("INSERT INTO memory_disclosures VALUES(?,?,?,?,'[]','[]','[]',?,?,0,'delivered',?)").run(`fill-${session}-${fills++}`, threadId, engine, session, state.policyRevision, state.deletionEpoch, Date.now());
  };
  let fills = 0;
  return { store, bot, threadId, turn, resets, receipts, access, fill, session: () => session };
}

it.each(["bot", "task", "other-bot-task"])("a warm session keeps holding when a fresh %s is added (no global revoke, no epoch move)", async kind => {
  const w = world(), lines = revokeLines();
  for (let n = 1; n <= 4; n++) await w.turn(n);
  expect(w.resets).toEqual([]);
  const before = policyRevision(), stamp = hard();
  if (kind === "bot") w.store.createBot();
  if (kind === "task") { w.store.createTask(w.bot.id, "one", false); w.store.createTask(w.bot.id, "two", false); }
  if (kind === "other-bot-task") { const other = w.store.createBot(); w.store.createTask(other.id, "work", false); }
  expect(policyRevision()).toBe(before);
  expect(hard()).toBe(stamp);
  expect(lines.filter(line => line.includes("scope=global"))).toEqual([]);
  await w.turn(5);
  expect(w.resets).toEqual([]);
  for (const id of w.receipts) expect(receiptState(id)).not.toBe("revoked");
});

it("a session past COLD_CHECK_ROWS keeps its hold when the bot gains a task (the hold widens with the reader's scopes)", async () => {
  const w = world();
  for (let n = 1; n <= 3; n++) await w.turn(n);
  // the session grows past the cold-check ceiling a few hundred receipts at a time, each turn judging only the new ones (a resumed check)
  for (let batch = 0; batch < 4; batch++) { w.fill(300); await w.turn(4 + batch); }
  expect(w.resets).toEqual([]);
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_disclosures WHERE native_session=?").get(w.session())!.n)).toBeGreaterThan(COLD_CHECK_ROWS);
  const stamp = hard();
  w.store.createTask(w.bot.id, "fresh", false);
  expect(hard()).toBe(stamp);
  await w.turn(9);
  expect(w.resets).toEqual([]);
});

it("deleting another bot's task adds no policy bump, no global revoke and ends no receipt of the warm bot", async () => {
  const w = world(), lines = revokeLines();
  for (let n = 1; n <= 3; n++) await w.turn(n);
  const other = w.store.createBot(), task = w.store.createTask(other.id, "doomed", false)!;
  w.store.appendMessage(task.threadId, { role: "user", kind: "text", text: "a line in the doomed task", origin: "desktop" } as never);
  const before = policyRevision(), policyMark = policyWatermark();
  w.store.deleteTask(other.id, task.threadId);
  expect(policyRevision()).toBe(before);
  expect(policyWatermark()).toBe(policyMark);
  expect(lines.filter(line => line.includes("scope=global"))).toEqual([]);
  for (const id of w.receipts) expect(receiptState(id)).toBe("delivered");
  // the deletion lanes' own contract: the deletion epoch moved (capture.ts captureThreadDeletion) and its watermark with it, which is what
  // the next turn sees (one reset, deny-read.ts "watermark" on deletion_epoch); the roster save added no policy watermark on top
  await w.turn(4);
  expect(w.resets.length).toBeLessThanOrEqual(1);
});

/** p02 shape: a two-bot roster with a room; bot a holds `tasks`. */
function fixture(tasks: string[] = []) {
  const roster: MemoryRoster = { bots: [{ id: "a", threadId: "private-a", section: "alpha", tasks: tasks.map(threadId => ({ threadId })) }, { id: "b", threadId: "private-b", section: "beta" }], groups: [{ id: "room", threadId: "room-thread", memberIds: ["a", "b"] }] };
  reconcileMemoryRoster(roster);
  setMemoryMode("active");
  const access = (thread: string, bot = "a") => {
    const registry = new InternalCapabilities(); registry.begin(bot, thread, `gen-${thread}`);
    const token = registry.mint({ botId: bot, threadId: thread, generation: `gen-${thread}`, depth: 0, kind: "memory", skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  };
  // recall runs only for a non-empty query (bundle.ts `if (query.trim())`): a receipt that must cite a searched record passes one
  const receipt = async (thread: string, search = bridge, bot = "a", query = "") => {
    const a = access(thread, bot);
    const bundle = await buildMemoryBundle(query, a, search, { allowance: LineageAllowance.tool() });
    prepareMemoryDisclosure(bundle, a, "fixture"); deliverMemoryDisclosure(bundle.bundleId, a, `session-${thread}`);
    return { access: a, bundle };
  };
  const save = (next: MemoryRoster) => persistMemoryRoster(next, () => { roster.bots = next.bots; roster.groups = next.groups; });
  return { roster, access, receipt, save };
}

it("removing a task ends its receipts only; the bot's other thread keeps its receipt, access and policy revision", async () => {
  const f = fixture(["private-a", "task-x"]), lines = revokeLines();
  const onX = await f.receipt("task-x"), onA = await f.receipt("private-a");
  const before = policyRevision(), stamp = hard();
  const next = structuredClone(f.roster); next.bots[0].tasks = [{ threadId: "private-a" }];
  f.save(next);
  expect(policyRevision()).toBe(before);
  expect(hard()).not.toBe(stamp);
  expect(receiptState(onX.bundle.bundleId)).toBe("revoked");
  expect(receiptState(onA.bundle.bundleId)).toBe("delivered");
  expect(lines.filter(line => line.includes("scope=global"))).toEqual([]);
  expect(lines.some(line => line.includes("scope=thread cause=roster-removed count=1"))).toBe(true);
  expect(() => assertMemoryAccess(onX.access)).toThrow("MEMORY_SCOPE_DENIED");
  expect(() => assertMemoryAccess(onA.access)).not.toThrow();
  expect(database().prepare("SELECT state FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()?.state).toBe("granted");
});

it("a receipt on another thread that cited the removed task's scope is judged live: hydrate denies, the hold is gone, the session resets", async () => {
  const f = fixture(["private-a", "task-x"]);
  const scope = ensureScope("conversation", "task-x"), db = database();
  db.prepare("INSERT INTO memory_records VALUES('fact-x',1,?,'fact','task-x knows the launch date','owner-statement','active',0,?,NULL,NULL,?)").run(scope, 1, 1);
  const citing = { search: async () => ({ hits: [{ id: "fact-x", version: 1, score: 1, lexical: true }], vectorRows: 1, coverageComplete: true }) };
  const onA = await f.receipt("private-a", citing as never, "a", "launch date");
  expect(JSON.parse(String(db.prepare("SELECT record_versions FROM memory_disclosures WHERE bundle_id=?").get(onA.bundle.bundleId)!.record_versions)).map((r: { id: string }) => r.id)).toContain("fact-x");
  markSessionKnown("private-a", "fixture", "session-private-a", "a");
  const allowance = LineageAllowance.turn();
  expect(continuationMemoryRevoked(allowance, "private-a", "fixture", "session-private-a", f.access("private-a"), {})).toBe(false);
  const stamp = hard();
  const next = structuredClone(f.roster); next.bots[0].tasks = [{ threadId: "private-a" }];
  f.save(next);
  expect(hard()).not.toBe(stamp);
  const fresh = f.access("private-a");
  expect(() => hydrateDisclosedMemoryRecord("fact-x", 1, fresh, { allowance: LineageAllowance.tool() })).toThrow("MEMORY_SCOPE_DENIED");
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.turn(), "private-a", "fixture", "session-private-a", fresh, why)).toBe(true);
  expect(why.reason).toContain("fact-x");
  expect(receiptState(onA.bundle.bundleId)).toBe("revoked");
});

it("removing a room ends the room threads' receipts; a member's direct access loses the room scope and keeps its own", async () => {
  const f = fixture(), lines = revokeLines();
  const inRoom = await f.receipt("room-thread"), onA = await f.receipt("private-a");
  expect(() => assertMemoryAccess(onA.access, ensureScope("room", "room"))).not.toThrow();
  const before = policyRevision();
  const next = structuredClone(f.roster); next.groups = [];
  f.save(next);
  expect(policyRevision()).toBe(before);
  expect(receiptState(inRoom.bundle.bundleId)).toBe("revoked");
  expect(receiptState(onA.bundle.bundleId)).toBe("delivered");
  expect(lines.filter(line => line.includes("scope=global"))).toEqual([]);
  expect(() => assertMemoryAccess(onA.access, ensureScope("room", "room"))).toThrow("MEMORY_SCOPE_DENIED");
  expect(() => assertMemoryAccess(onA.access, ensureScope("conversation", "private-a"))).not.toThrow();
});

it.each(["section", "membership", "dm", "desk-retag", "desk-archived", "shared-work-quarantine", "partitioned", "partitioned-for", "thread-moved", "non-fresh-thread", "reused-bot", "reused-room", "desk-room-added"])(
  "an audience change (%s) still ends every receipt under a new policy revision", async change => {
    const f = fixture(["private-a", "task-x"]);
    f.roster.bots[0].tasks![1] = { threadId: "task-x", channelProjectDesk: { groupId: change === "desk-room-added" ? "proj" : "room" } };
    reconcileMemoryRoster(f.roster);
    const onA = await f.receipt(change === "desk-room-added" ? "task-x" : "private-a");
    if (change === "reused-bot") ensureScope("bot", "ghost");
    if (change === "reused-room") ensureScope("room", "ghost-room");
    if (change === "non-fresh-thread") database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('orphan','m1',1,'user','text','x','{}')").run();
    const before = policyRevision();
    const next = structuredClone(f.roster);
    if (change === "section") next.bots[0].section = "beta";
    if (change === "membership") next.groups[0].memberIds = ["a"];
    if (change === "dm") next.groups[0].dm = true;
    if (change === "desk-retag") next.bots[0].tasks![1].channelProjectDesk = { groupId: "other" };
    if (change === "desk-archived") next.bots[0].tasks![1].channelProjectDesk = { groupId: "room", archivedAt: 5 };
    if (change === "shared-work-quarantine") { next.bots[0].tasks![1] = { threadId: "task-x", sharedWork: { teamId: "t", quarantined: true } }; }
    if (change === "partitioned") next.bots[0].partitionedAt = 7;
    if (change === "partitioned-for") next.groups[0].partitionedFor = { a: { kind: "team", teamId: "t" } };
    if (change === "thread-moved") { next.bots[0].tasks = [{ threadId: "private-a" }]; next.bots[1].tasks = [{ threadId: "task-x" }]; }
    if (change === "non-fresh-thread") next.bots[1].tasks = [{ threadId: "orphan" }];
    if (change === "reused-bot") next.bots.push({ id: "ghost", threadId: "ghost-thread" });
    if (change === "reused-room") next.groups.push({ id: "ghost-room", threadId: "ghost-room-thread", memberIds: ["a"] });
    // a fresh project room an existing desk already names: that desk thread's recall narrows to the project (policy.ts eligibleScopes)
    if (change === "desk-room-added") next.groups.push({ id: "proj", threadId: "proj-thread", memberIds: ["a"], channelProject: true });
    f.save(next);
    expect(policyRevision()).toBeGreaterThan(before);
    expect(receiptState(onA.bundle.bundleId)).toBe("revoked");
    expect(() => assertMemoryAccess(onA.access)).toThrow("MEMORY_CONTEXT_REVOKED");
  },
);

it("a crash between the removal's transaction and the file write fails closed at boot; after the file write it settles without a revoke", async () => {
  const f = fixture(["private-a", "task-x"]);
  const onX = await f.receipt("task-x"), onA = await f.receipt("private-a");
  const before = policyRevision();
  const next = structuredClone(f.roster); next.bots[0].tasks = [{ threadId: "private-a" }];
  expect(() => persistMemoryRoster(next, () => { throw new Error("disk failure"); })).toThrow("disk failure");
  expect(database().prepare("SELECT state FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()?.state).toBe("pending");
  expect(receiptState(onX.bundle.bundleId)).toBe("revoked");
  expect(policyRevision()).toBe(before);
  expect(() => assertMemoryAccess(onA.access)).toThrow("MEMORY_CONTEXT_REVOKED");
  // X1: the file still holds task-x; the restart reconciles the old roster against the pending intent: task-x is not fresh → one global
  closeDatabase(); reconcileMemoryRoster(f.roster);
  expect(policyRevision()).toBe(before + 1);
  expect(database().prepare("SELECT state FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()?.state).toBe("granted");
  expect(receiptState(onA.bundle.bundleId)).toBe("revoked");
  // X2: the same removal again, this time the file was written; the restart finds the intent and the file equal: no revoke
  const onA2 = await f.receipt("private-a");
  const revision = policyRevision();
  expect(() => persistMemoryRoster(next, () => { f.roster.bots = next.bots; throw new Error("after the write"); })).toThrow("after the write");
  closeDatabase(); reconcileMemoryRoster(f.roster);
  expect(policyRevision()).toBe(revision);
  expect(database().prepare("SELECT state FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()?.state).toBe("granted");
  expect(receiptState(onA2.bundle.bundleId)).toBe("delivered");
});

it("X3: a save over a pending binding takes the audience path once, then the binding is granted again", async () => {
  const f = fixture(["private-a", "task-x"]);
  const next = structuredClone(f.roster); next.bots[0].tasks = [{ threadId: "private-a" }];
  expect(() => persistMemoryRoster(next, () => { throw new Error("disk failure"); })).toThrow("disk failure");
  const before = policyRevision();
  f.save(next);
  expect(policyRevision()).toBe(before + 1);
  expect(database().prepare("SELECT state FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()?.state).toBe("granted");
  const again = structuredClone(next);
  const revision = policyRevision();
  f.save(again);
  expect(policyRevision()).toBe(revision);
});

it("a 1.0.3 binding (no partition facts) cannot vouch for desks or partitions: the first change after the upgrade ends everything once, then v2 holds", async () => {
  const f = fixture(["private-a", "task-x"]);
  f.roster.bots[0].tasks![1] = { threadId: "task-x", channelProjectDesk: { groupId: "room" } };
  reconcileMemoryRoster(f.roster);
  const db = database();
  // the v1 shape (policy.ts:36-43 at d12c102b6): ids, sections, members and threads only
  const v1 = { bots: f.roster.bots.map(b => ({ id: b.id, section: b.section?.trim() || "", threads: [...new Set([b.threadId, ...(b.tasks ?? []).map(t => t.threadId)])].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    groups: f.roster.groups.map(g => ({ id: g.id, section: g.section?.trim() || "", members: [...g.memberIds].sort(), threads: [...new Set([g.threadId, ...(g.tasks ?? []).map(t => t.threadId)])].sort() })) };
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(JSON.stringify(v1)).digest("hex");
  db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id='memory-roster-policy'").run(JSON.stringify({ hash, snapshot: v1 }));
  const onA = await f.receipt("private-a");
  const before = policyRevision();
  const retag = structuredClone(f.roster); retag.bots[0].tasks![1].channelProjectDesk = { groupId: "other" };
  f.save(retag);
  expect(policyRevision()).toBe(before + 1);
  expect(receiptState(onA.bundle.bundleId)).toBe("revoked");
  expect(JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()!.intent)).snapshot.v).toBe(2);
  // from the v2 binding on, a fresh task is scoped again
  const onA2 = await f.receipt("private-a");
  const fresh = structuredClone(f.roster); fresh.bots[0].tasks!.push({ threadId: "task-y" });
  f.save(fresh);
  expect(policyRevision()).toBe(before + 1);
  expect(receiptState(onA2.bundle.bundleId)).toBe("delivered");
});

it("a first notebook import ends no receipt and moves no hold; a changed one still ends every receipt", async () => {
  const roster: MemoryRoster = { bots: [{ id: "a", threadId: "thread-a" }, { id: "b", threadId: "thread-b" }], groups: [] };
  reconcileMemoryRoster(roster); database().exec("UPDATE memory_meta SET mode='active'");
  const lines = revokeLines();
  const access = (bot: string, thread: string) => {
    const registry = new InternalCapabilities(), generation = registry.begin(bot, thread);
    const token = registry.mint({ botId: bot, threadId: thread, generation, depth: 0, kind: "memory", skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  };
  const receipt = async (bot: string, thread: string, session: string) => {
    const a = access(bot, thread);
    const bundle = await buildMemoryBundle("", a, bridge, { allowance: LineageAllowance.tool() });
    prepareMemoryDisclosure(bundle, a, "fixture"); deliverMemoryDisclosure(bundle.bundleId, a, session);
    markSessionKnown(thread, "fixture", session, bot);
    return bundle.bundleId;
  };
  const judge = (bot: string, thread: string, session: string) => continuationMemoryRevoked(LineageAllowance.turn(), thread, "fixture", session, access(bot, thread), {});
  const unrelated = await receipt("b", "thread-b", "session-b");
  expect(judge("b", "thread-b", "session-b")).toBe(false);
  const before = policyRevision(), stamp = hard();
  const root = ensureWorkspace("a"), path = join(root, "MEMORY.md"), ticket = ownerMemoryTicket();
  writeFileSync(path, "The launch is on the first Tuesday.");
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
  expect(lines).toEqual([]);
  expect(hard()).toBe(stamp);
  expect(policyRevision()).toBe(before);
  expect(receiptState(unrelated)).toBe("delivered");
  expect(judge("b", "thread-b", "session-b")).toBe(false);
  // a changed notebook: every receipt, as before (SCOPED-REVOKES E10)
  writeFileSync(path, "The launch moved to the second Thursday.");
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
  expect(lines.filter(line => line.includes("scope=global cause=import"))).toHaveLength(1);
  expect(receiptState(unrelated)).toBe("revoked");
});
