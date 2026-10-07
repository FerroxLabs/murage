// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane D integration (coordinator requirement for lane X round 4): with X's
// `learningDestination` installed through D's `installLearningDestination`
// (as server/index.ts does at boot), a shared bot's learning from one team's
// evidence lands only in that team's partition, through D's real learning
// guard: never home, never another team. `#general` evidence goes to the
// owner. And D's bot-initiated bring-in honours X's partition rule.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { learningDestination as partitionLearningDestination } from "./execution-audience.ts";
import { installLearningDestination } from "./memory/learning-destination.ts";
import { learningWriteDecision } from "./memory/learning-guard.ts";
import { activateGroundedMemory } from "./memory/automatic-learning.ts";
import { captureSource } from "./memory/capture.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { claimMemoryJob, publishMemoryWork } from "./memory/jobs.ts";
import { captureWork } from "./memory/chunks.ts";
import { ensureScope, reconcileMemoryRoster } from "./memory/policy.ts";
import { appendMessage } from "./message-db.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { registerProjectMemoryTools } from "./project-memory-tools.ts";
import { projectToolHandlers, type ProjectToolCallContext } from "./project-tool-routing.ts";
import type { Message } from "./store.ts";
import type { RoomRequest } from "./room-requests.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { pendingProcedureReviews, processProcedureReview, procedureCandidateHash, procedureSnapshotDigest, procedureTargetDigest,
  type ProcedureEvaluationReceipt, type ProcedureReviewHost, type ProcedureReviewSnapshot } from "./memory/procedure-review.ts";

const uninstall: Array<() => void> = [];
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { while (uninstall.length) uninstall.pop()!(); setMemoryCaptureRoster(null); });

function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string) => { const bot = store.createBot(); store.patchBot(bot.id, { name, section }); return bot; };
  const iris = make("Iris", "Design"), sam = make("Sam", "Sales"); make("Tia", "Support");
  const sales = teamIdFor("Sales"), support = teamIdFor("Support");
  store.patchBot(iris.id, { sharedWith: { mode: "list", teams: [{ id: sales, name: "Sales" }, { id: support, name: "Support" }] } });
  const salesWork = store.createSharedWorkTask(iris.id, sales)!, supportWork = store.createSharedWorkTask(iris.id, support)!;
  setMemoryCaptureRoster(() => store);
  reconcileMemoryRoster(store);
  database().exec("UPDATE memory_meta SET mode='active'");
  // what index.ts does at boot
  uninstall.push(installLearningDestination(partitionLearningDestination));
  return { store, iris, sam, sales, support, salesWork, supportWork };
}

let n = 0;
/** An owner source captured in a thread, in whatever scope that thread captures to. */
function ownerSource(threadId: string, text: string) {
  const id = `source-${++n}`;
  captureSource(database(), { id, threadId, kind: "text", speaker: "owner", outcome: "recorded", text, origin: { kind: "attended" } });
  return { id, scope: String(database().prepare("SELECT scope_id FROM memory_sources WHERE id=?").get(id)!.scope_id) };
}
/** A candidate grounded on one source, in a scope the test names. */
function candidate(source: { id: string }, scopeId: string) {
  const db = database(), id = `candidate-${++n}`;
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','tea','assistant-inference','candidate',0,1,NULL,NULL,1)").run(id, scopeId);
  // finish every capture job, the fixture's seed messages included
  for (let work = claimMemoryJob("fixture"); work; work = claimMemoryJob("fixture")) publishMemoryWork(work, "fixture", captureWork(work));
  db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,3)").run(id, source.id);
  return id;
}
const state = (id: string) => database().prepare("SELECT state FROM memory_records WHERE id=?").get(id)?.state;
const decide = (source: { id: string }, targetScopeId: string, botId: string, extra: Partial<Parameters<typeof learningWriteDecision>[1]> = {}) =>
  learningWriteDecision(database(), { writer: "activation", sourceId: source.id, sourceRevision: 1, targetScopeId, botId, target: "memory", ...extra });

it("a Sales work-thread capture lands in the Sales team scope, and the guard allows only that scope", () => {
  const f = fixture();
  const source = ownerSource(f.salesWork.threadId, "CANARY_SALES_FACT the Sales team ships on Fridays");
  const salesScope = ensureScope("team", "Sales"), home = ensureScope("bot", f.iris.id), supportScope = ensureScope("team", "Support");
  expect(source.scope).toBe(salesScope);
  expect(decide(source, salesScope, f.iris.id)).toEqual({ decision: "auto", scopeId: salesScope });
  // never home, never the other team
  expect(decide(source, home, f.iris.id)).toMatchObject({ decision: "refused" });
  expect(decide(source, supportScope, f.iris.id)).toMatchObject({ decision: "refused" });
  expect(decide(source, ensureScope("bot", `${f.iris.id}#team:${f.support}`), f.iris.id)).toMatchObject({ decision: "refused" });
  // evidence that mixes Sales with Support or with home is refused outright
  const other = ownerSource(f.supportWork.threadId, "CANARY_SUPPORT_FACT");
  expect(decide(source, salesScope, f.iris.id, { evidenceScopeIds: [other.scope] })).toEqual({ decision: "refused", reason: "cross-partition" });
  expect(decide(source, salesScope, f.iris.id, { evidenceScopeIds: [home] })).toEqual({ decision: "refused", reason: "cross-partition" });
});

it("D's automatic activation activates a Sales candidate in Sales and leaves a home or Support copy of the same evidence a candidate", () => {
  const f = fixture();
  // the candidate quotes bytes 0-3 of its source: "tea"
  const source = ownerSource(f.salesWork.threadId, "tea for CANARY_SALES_FACT");
  const inSales = candidate(source, source.scope);
  expect(transaction(db => activateGroundedMemory(db, inSales, "owner-statement", undefined, { connection: "fixture" }))).toBe(true);
  expect(state(inSales)).toBe("active");
  const events = database().prepare("SELECT scope_id, bot_id FROM memory_learning_events").all();
  expect(events).toEqual([{ scope_id: source.scope, bot_id: f.iris.id }]);
  for (const scope of [ensureScope("bot", f.iris.id), ensureScope("team", "Support")]) {
    const leaked = candidate(source, scope);
    expect(transaction(db => activateGroundedMemory(db, leaked, "owner-statement", undefined, { connection: "fixture" }))).toBe(false);
    expect(state(leaked)).toBe("candidate");
  }
  expect(database().prepare("SELECT count(*) AS n FROM memory_learning_events").get()!.n).toBe(1);
});

it("#general evidence goes to the owner for review, never learned automatically", () => {
  const f = fixture();
  const source = ownerSource(f.salesWork.threadId, "CANARY_GENERAL_FACT");
  const general = ensureScope("bot", `${f.iris.id}#general`);
  database().prepare("UPDATE memory_sources SET scope_id=? WHERE id=?").run(general, source.id);
  expect(decide(source, general, f.iris.id)).toEqual({ decision: "owner-approval", reason: "needs-owner-approval" });
  const held = candidate(source, general);
  expect(transaction(db => activateGroundedMemory(db, held, "owner-statement", undefined, { connection: "fixture" }))).toBe(false);
  expect(state(held)).toBe("candidate");
});

it("a partitioned bot's bring-in cannot take another partition's sources into a project", () => {
  const f = fixture();
  const project = f.store.createGroup("Launch", [f.iris.id, f.sam.id], false, "Sales");
  channelToProjectRows(database(), { groupId: project.id, bulletin: "", leadBotId: f.sam.id, now: 1 });
  const desk = f.store.ensureProjectDesk(f.iris.id, project.id, project.name)!;
  reconcileMemoryRoster(f.store);
  const notes: string[] = [];
  registerProjectMemoryTools({ roster: () => f.store as never, note: (_group, text) => notes.push(text) });
  const say = (threadId: string, text: string) => {
    const message = { id: `msg-${++n}`, role: "user", kind: "text", text, at: n } as Message;
    appendMessage(threadId, message);
    captureSource(database(), { id: `message:${threadId}:${message.id}`, threadId, messageId: message.id, kind: "text", speaker: "owner", outcome: "recorded", text });
    return message;
  };
  const call = (body: Record<string, unknown>) => projectToolHandlers.get("bring-in")!({
    db: database(), groupId: project.id, botId: f.iris.id, role: "member",
    request: { id: "req", targetThreadId: desk.threadId, rootThreadId: desk.threadId } as RoomRequest,
    memberIds: project.memberIds, ownerAudience: true, now: 10,
  } as ProjectToolCallContext, body);
  const refused = { status: 403, body: { error: "Those sources belong to another team." } };
  const fromSupport = say(f.supportWork.threadId, "CANARY_SUPPORT the support rota");
  const fromHome = say(f.iris.threadId, "CANARY_DESIGN the design system");
  expect(call({ sourceMessageId: fromSupport.id, text: "the support rota" })).toEqual(refused);
  expect(call({ sourceMessageId: fromHome.id, text: "the design system" })).toEqual(refused);
  expect(call({ sourceMessageId: fromHome.id, threadId: f.salesWork.threadId, text: "the design system" })).toEqual(refused);
  expect(call({ text: "a note with no source" })).toEqual(refused);
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE scope_id=?").get(ensureScope("room", project.id))!.n).toBe(0);
  expect(notes).toEqual([]);
  // the partition rule is what refuses: the desk's own words are not refused for it
  const own = say(desk.threadId, "CANARY_P the launch date");
  expect(call({ sourceMessageId: own.id, text: "the launch date" })).not.toEqual(refused);
});

// Final review C1: an unpartitioned bot keeps today's behaviour through X's
// installed destination. Its skill review from its own conversation (evidence
// conversation:<thread>, target bot:<id>) publishes instead of parking forever
// on "cross-scope"; routine instructions from room evidence need no approval;
// a pair room's conversation scope is not "cross-partition" by itself.
function plainFixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string) => { const bot = store.createBot(); store.patchBot(bot.id, { name, section }); return bot; };
  const carl = make("Carl", "Design"), dana = make("Dana", "Design");
  setMemoryCaptureRoster(() => store);
  reconcileMemoryRoster(store);
  uninstall.push(installLearningDestination(partitionLearningDestination));
  return { store, carl, dana };
}
function receiptFor(snapshot: ProcedureReviewSnapshot): ProcedureEvaluationReceipt {
  const candidate = "Use the observed result before claiming success.";
  return { id: "fixture-receipt", requestId: snapshot.requestId, targetDigest: procedureTargetDigest(snapshot.target), snapshotDigest: procedureSnapshotDigest(snapshot), evidenceDigest: snapshot.evidenceDigest, candidate, candidateHash: procedureCandidateHash(candidate), evaluator: "deterministic-fixture-v1", decision: "accepted", heldout: { corpusDigest: "a".repeat(64), untouched: true, cases: 2, baseline: 0.5, candidate: 1, regressions: 0 }, budgetRespected: true, cancelled: false };
}

it("C1: an unpartitioned bot's skill review from its own conversation publishes through X and D's real review", async () => {
  const f = plainFixture();
  setMemoryMode("capture");
  const threadId = f.carl.threadId;
  transaction(db => {
    captureSource(db, { id: "tool:c1", threadId, turnId: "c1", kind: "tool-outcome", speaker: "tool", outcome: "failed", text: "Expected output missing", action: { label: "synthetic-check", reportedOutcome: "failed", verification: "tool-reported" } });
    captureSource(db, { id: "turn:c1", threadId, turnId: "c1", kind: "turn", speaker: "harness", outcome: "completed", text: "Turn completed." });
  });
  const evidenceScope = String(database().prepare("SELECT scope_id FROM memory_sources WHERE id='turn:c1'").get()!.scope_id);
  const botScope = ensureScope("bot", f.carl.id);
  expect(evidenceScope).not.toBe(botScope);
  const host: ProcedureReviewHost = {
    resolveTargets: () => [{ kind: "skill", scopeId: botScope, ownerId: f.carl.id, artifactId: "synthetic", baseRevision: "1", threadId, bundleId: "bundle" }],
    isTargetCurrent: () => true, canReadEvidence: () => true, canPublish: () => true, publish: vi.fn(), evaluate: async snapshot => receiptFor(snapshot),
  };
  for (const id of pendingProcedureReviews(4)) await processProcedureReview(id, host, new AbortController().signal);
  const review = String(database().prepare("SELECT id FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%'").get()!.id);
  await processProcedureReview(review, host, new AbortController().signal);
  const intent = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(review)!.intent));
  expect(intent.reason).not.toBe("cross-scope");
  expect(intent.status).toBe("complete");
  expect(host.publish).toHaveBeenCalledTimes(1);
});

it("C1: routine instructions from room evidence need no owner approval for an unpartitioned bot", () => {
  const f = plainFixture();
  const room = f.store.createGroup("Design room", [f.carl.id, f.dana.id], false, "Design");
  const source = ownerSource(room.threadId, "the review checklist");
  const botScope = ensureScope("bot", f.carl.id);
  expect(learningWriteDecision(database(), { writer: "procedure-review", sourceId: source.id, sourceRevision: 1, targetScopeId: botScope, botId: f.carl.id, target: "routine-instructions" }))
    .toEqual({ decision: "auto", scopeId: botScope });
  expect(partitionLearningDestination({ botId: f.carl.id, threadId: room.threadId, evidenceScopeIds: [source.scope], target: "skill" }))
    .toEqual({ ok: true, partition: { kind: "home" }, audienceKey: `bot:${f.carl.id}:owner` });
  // memory keeps its one-scope destination
  expect(partitionLearningDestination({ botId: f.carl.id, evidenceScopeIds: [source.scope], target: "memory" }))
    .toEqual({ ok: true, scopeId: source.scope, partition: { kind: "home" }, audienceKey: `bot:${f.carl.id}:owner` });
});

it("C1: a pair room's conversation scope maps like today when unpartitioned, and stays refused across a partitioned bot's partitions", () => {
  const f = fixture();
  const carl = f.store.createBot(); f.store.patchBot(carl.id, { name: "Carl", section: "Design" });
  const plainPair = f.store.createGroup("Carl ⇄ Sam", [carl.id, f.sam.id], true, "Design");
  reconcileMemoryRoster(f.store);
  const pairSource = ownerSource(plainPair.threadId, "CANARY_PAIR a plain pair room line");
  expect(pairSource.scope).toBe(ensureScope("conversation", plainPair.threadId));
  // no-bot job and unpartitioned bot: the pair room's own scope, as today
  expect(partitionLearningDestination({ evidenceScopeIds: [pairSource.scope], target: "memory" })).toMatchObject({ ok: true, scopeId: pairSource.scope });
  expect(partitionLearningDestination({ botId: carl.id, evidenceScopeIds: [pairSource.scope], target: "memory" })).toMatchObject({ ok: true, scopeId: pairSource.scope, partition: { kind: "home" } });
  expect(decide(pairSource, pairSource.scope, carl.id)).toEqual({ decision: "auto", scopeId: pairSource.scope });
  // a partitioned bot never takes another pair's conversation as its own
  expect(f.iris.partitionedAt).toBeDefined();
  expect(partitionLearningDestination({ botId: f.iris.id, evidenceScopeIds: [pairSource.scope], target: "memory" })).toEqual({ ok: false, reason: "cross-partition" });
  // and its Sales pair room plus its home notebook still cross partitions
  const salesPair = f.store.createGroup("Iris ⇄ Sam", [f.iris.id, f.sam.id], true, "Sales", undefined, { kind: "team", teamId: f.sales });
  reconcileMemoryRoster(f.store);
  const salesSource = ownerSource(salesPair.threadId, "CANARY_SALES_PAIR");
  expect(partitionLearningDestination({ botId: f.iris.id, threadId: salesPair.threadId, evidenceScopeIds: [salesSource.scope, ensureScope("bot", f.iris.id)], target: "memory" })).toEqual({ ok: false, reason: "cross-partition" });
});

it("C1: a skill review with room evidence and no bot still waits for the owner under X", () => {
  plainFixture();
  const room = ensureScope("room", "room");
  expect(partitionLearningDestination({ evidenceScopeIds: [room], target: "skill" })).toEqual({ ok: false, reason: "needs-owner-approval" });
});
