// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane M (plan 3.8, "Project memory in"): what a room's threads capture lands
// in the room's own memory scope, so a save made in a project is project
// memory with its evidence intact, and "What this project remembers" (which
// lists the room scope) is no longer empty. Direct chats and bot pair rooms
// keep capturing into their own conversation scope.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { captureMessage, captureSource } from "./capture.ts";
import { saveMemoryCandidate } from "./authority.ts";
import { setMemoryCaptureRoster, threadCaptureScope } from "./capture-scope.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "../human-principals.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { refreshMemoryCheckpoint, consolidateMemorySource } from "./consolidate.ts";
import { buildMemoryBundle, hydrateMemoryRecord } from "./bundle.ts";
import type { Message } from "../store.ts";
import { checkReplyActions, toolAction } from "../reply-action-guard.ts";
import { admissibleActionSources } from "./pip-admission.ts";
import { setMemoryMode } from "./repository.ts";

const roster: MemoryRoster = {
  bots: [
    { id: "finch", threadId: "finch-direct", section: "Dev Shop", tasks: [{ threadId: "finch-task" }, { threadId: "finch-desk", channelProjectDesk: { groupId: "closing" } }] },
    { id: "dax", threadId: "dax-direct", section: "Operations" },
  ],
  groups: [
    { id: "closing", threadId: "closing-chat", memberIds: ["finch", "dax"], tasks: [{ threadId: "closing-chat" }, { threadId: "closing-goal-task" }], channelProject: { goal: "Close", status: "active", startedAt: 1, updatedAt: 1 } },
    { id: "office", threadId: "office-chat", memberIds: ["finch", "dax"] },
    { id: "pair", threadId: "pair-chat", memberIds: ["finch", "dax"], dm: true },
  ],
};

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryCaptureRoster(() => roster); });
afterEach(() => setMemoryCaptureRoster(null));

function access(botId: string, thread: string, notOwnerAudience = false) {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g");
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false, ...(notOwnerAudience ? { notOwnerAudience: true } : {}) });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const sourceScope = (id: string) => String((database().prepare("SELECT scope_id FROM memory_sources WHERE id=?").get(id) as { scope_id: string }).scope_id);

it("names the room scope for a room's main chat, its task threads and a project desk thread", () => {
  expect(threadCaptureScope("closing-chat")).toEqual({ kind: "room", owner: "closing" });
  expect(threadCaptureScope("closing-goal-task")).toEqual({ kind: "room", owner: "closing" });
  expect(threadCaptureScope("finch-desk")).toEqual({ kind: "room", owner: "closing" });
  expect(threadCaptureScope("office-chat")).toEqual({ kind: "room", owner: "office" });
  expect(threadCaptureScope("finch-direct")).toEqual({ kind: "conversation", owner: "finch-direct" });
  expect(threadCaptureScope("finch-task")).toEqual({ kind: "conversation", owner: "finch-task" });
  expect(threadCaptureScope("pair-chat")).toEqual({ kind: "conversation", owner: "pair-chat" });
});

it("a desk thread naming a project its bot is not in, or a group that is no project, captures into its own conversation", () => {
  setMemoryCaptureRoster(() => ({ ...roster, bots: [{ id: "finch", threadId: "finch-direct", tasks: [{ threadId: "finch-desk", channelProjectDesk: { groupId: "office" } }] }, { id: "lone", threadId: "lone-direct", tasks: [{ threadId: "lone-desk", channelProjectDesk: { groupId: "closing" } }] }] }));
  expect(threadCaptureScope("finch-desk")).toEqual({ kind: "conversation", owner: "finch-desk" });
  expect(threadCaptureScope("lone-desk")).toEqual({ kind: "conversation", owner: "lone-desk" });
});

it("a save made in the project's chat lands in project memory with its evidence", () => {
  reconcileMemoryRoster(roster);
  const text = "The RWA close call is on Thursday at 10.";
  captureSource(database(), { id: "src-1", threadId: "closing-chat", kind: "text", speaker: "owner", outcome: "recorded", text });
  expect(sourceScope("src-1")).toBe(ensureScope("room", "closing"));
  const id = saveMemoryCandidate(text, [{ sourceId: "src-1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k1", access("dax", "closing-chat"));
  const row = database().prepare("SELECT scope_id FROM memory_records WHERE id=?").get(id) as { scope_id: string };
  expect(row.scope_id).toBe(ensureScope("room", "closing"));
  const evidence = database().prepare("SELECT source_id FROM memory_evidence WHERE record_id=?").all(id) as Array<{ source_id: string }>;
  expect(evidence.map(item => item.source_id)).toEqual(["src-1"]);
});

it("the project's main chat recalls what its goal task thread captured", () => {
  reconcileMemoryRoster(roster);
  captureSource(database(), { id: "src-task", threadId: "closing-goal-task", kind: "text", speaker: "owner", outcome: "recorded", text: "Pricing is 12 a month." });
  expect(access("dax", "closing-chat").scopeIds).toContain(sourceScope("src-task"));
});

it("direct chats and bot pair rooms keep their own conversation scope", () => {
  reconcileMemoryRoster(roster);
  captureSource(database(), { id: "src-direct", threadId: "finch-direct", kind: "text", speaker: "owner", outcome: "recorded", text: "hi" });
  captureSource(database(), { id: "src-pair", threadId: "pair-chat", kind: "text", speaker: "owner", outcome: "recorded", text: "hi" });
  expect(sourceScope("src-direct")).toBe(ensureScope("conversation", "finch-direct"));
  expect(sourceScope("src-pair")).toBe(ensureScope("conversation", "pair-chat"));
});

it("without a registered roster capture keeps today's conversation scope", () => {
  setMemoryCaptureRoster(null);
  reconcileMemoryRoster(roster);
  captureSource(database(), { id: "src-x", threadId: "closing-chat", kind: "text", speaker: "owner", outcome: "recorded", text: "hi" });
  expect(sourceScope("src-x")).toBe(ensureScope("conversation", "closing-chat"));
});

it("a room thread whose human is a linked channel person keeps its own conversation scope", () => {
  reconcileMemoryRoster(roster);
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  bindHumanThread("office-chat", resolveHumanBinding(binding));
  captureSource(database(), { id: "src-guest", threadId: "office-chat", kind: "text", speaker: "owner", outcome: "recorded", text: "the guest's words" });
  expect(sourceScope("src-guest")).toBe(ensureScope("conversation", "office-chat"));
  expect(threadCaptureScope("office-chat")).toEqual({ kind: "conversation", owner: "office-chat" });
});

it("a project desk thread recalls its project's memory on an owner-audience turn only", () => {
  reconcileMemoryRoster(roster);
  const room = ensureScope("room", "closing");
  expect(access("finch", "finch-desk").scopeIds).toContain(room);
  expect(access("finch", "finch-desk", true).scopeIds).not.toContain(room);
  // an ordinary task of the same bot is not a desk thread: it reaches the
  // project only by recall both ways, and not on a turn nobody proved
  expect(access("finch", "finch-task", true).scopeIds).not.toContain(room);
});

it("a save made in a project desk thread lands in project memory", () => {
  reconcileMemoryRoster(roster);
  const text = "Desk notes: the reconciler is done.";
  captureSource(database(), { id: "src-desk", threadId: "finch-desk", kind: "text", speaker: "owner", outcome: "recorded", text });
  const id = saveMemoryCandidate(text, [{ sourceId: "src-desk", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k-desk", access("finch", "finch-desk"));
  expect((database().prepare("SELECT scope_id FROM memory_records WHERE id=?").get(id) as { scope_id: string }).scope_id).toBe(ensureScope("room", "closing"));
});

it("the room thread's own checkpoint, now kept in the room scope, still rides its turns", async () => {
  reconcileMemoryRoster(roster);
  setMemoryMode("capture");
  captureSource(database(), { id: "src-cp", threadId: "closing-chat", messageId: "m-cp", kind: "text", speaker: "owner", outcome: "recorded", text: "Ship the pricing page by Friday." });
  const work = claimMemoryJob("m-worker")!;
  publishMemoryWork(work, "m-worker", captureWork(work));
  const result = refreshMemoryCheckpoint(work.id);
  expect(result.status).toBe("updated");
  const bundle = await buildMemoryBundle("", access("dax", "closing-chat"), { async search() { return { hits: [], vectorRows: 0, coverageComplete: false }; } });
  expect(bundle.checkpoint.map(record => record.scopeId)).toEqual([ensureScope("room", "closing")]);
  expect(bundle.text).toContain("Ship the pricing page by Friday.");
});

it.each(["closing-chat", "finch-desk", "finch-direct"])("retains failed tool evidence for learning without publishing recall in %s", threadId => {
  reconcileMemoryRoster(roster);
  setMemoryMode("capture");
  captureMessage(database(), threadId, {
    id: "failed-tool", role: "bot", kind: "activity", at: 1,
    tool: { name: "delegate_bot", ok: false, errorDetails: "Failed to parse arguments for tool `delegate_bot`: Tool not found: delegate_bot" },
  });
  expect(database().prepare("SELECT outcome FROM memory_sources WHERE message_id='failed-tool'").get()).toMatchObject({ outcome: "failed" });
  expect(claimMemoryJob("failed-recall")).toBeNull();
  expect(database().prepare("SELECT * FROM memory_records").all()).toEqual([]);
  const text = "delegate_bot\nFailed to parse arguments for tool `delegate_bot`: Tool not found: delegate_bot";
  expect(() => saveMemoryCandidate("The delegation completed", [{ sourceId: `message:${threadId}:failed-tool`, revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "failed-fact", access("finch", threadId))).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
});

it("does not carry a previously captured failed tool into a checkpoint", () => {
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  captureSource(database(), { id: "legacy-tool", threadId: "closing-chat", kind: "tool-outcome", speaker: "tool", outcome: "completed", text: "delegate_bot Failed to parse arguments: Tool not found" });
  const work = claimMemoryJob("pf-checkpoint")!;
  publishMemoryWork(work, "pf-checkpoint", captureWork(work));
  // A stored row from before PF, whose failed outcome was kept in memory.
  database().prepare("UPDATE memory_sources SET outcome='failed' WHERE id='legacy-tool'").run();
  expect(refreshMemoryCheckpoint(work.id)).toMatchObject({ status: "deferred", reason: "no-current-completed-evidence" });
  expect(database().prepare("SELECT text FROM memory_records WHERE kind='checkpoint' AND state='active'").all()).toEqual([]);
});

const simulationFailure = "delegate_bot\nFailed to parse arguments for tool `delegate_bot`: Tool not found: delegate_bot\n\nYour original arguments:\n{\"assignee\": \"Reed\", \"task\": \"Identify and document three target customer segments for Tallyroo (an app that lets small teams split and track shared expenses). For each segment, provide a one-line reason why it's a good fit. Save the output to a file in the project folder so Wren can use it for the launch plan.\"}";
it("retains the simulation's legacy activity only for learning",()=>{
 reconcileMemoryRoster(roster); setMemoryMode("capture");
 captureSource(database(),{id:"sim-failure",threadId:"closing-chat",kind:"activity",speaker:"assistant",outcome:"failed",text:simulationFailure});
 expect(database().prepare("SELECT count(*) n FROM memory_sources WHERE id='sim-failure'").get()).toMatchObject({n:1});
 expect(claimMemoryJob("sim-failed-recall")).toBeNull();
});
it("removes the simulation's assistant-inference failed activity from checkpoint evidence",()=>{
 reconcileMemoryRoster(roster); setMemoryMode("capture");
 captureSource(database(),{id:"sim-legacy",threadId:"closing-chat",kind:"activity",speaker:"assistant",outcome:"completed",text:simulationFailure});
 const work=claimMemoryJob("sim-replay")!;
 publishMemoryWork(work,"sim-replay",captureWork(work));
 expect(database().prepare("SELECT kind,assertion,text FROM memory_records WHERE kind='source'").get()).toMatchObject({kind:"source",assertion:"assistant-inference",text:simulationFailure});
 database().prepare("UPDATE memory_sources SET outcome='failed' WHERE id='sim-legacy'").run();
 expect(refreshMemoryCheckpoint(work.id)).toMatchObject({status:"deferred",reason:"no-current-completed-evidence"});
 expect(database().prepare("SELECT text FROM memory_records WHERE kind='checkpoint' AND state='active'").all()).toEqual([]);
});

it.each(["recall", "extraction"])("withholds legacy failed activity from %s while retaining learning evidence", async path => {
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  captureSource(database(), { id: "legacy-recall", threadId: "closing-chat", kind: "activity", speaker: "assistant", outcome: "completed", text: simulationFailure });
  const work = claimMemoryJob("legacy-recall")!;
  publishMemoryWork(work, "legacy-recall", captureWork(work));
  const record = database().prepare("SELECT id FROM memory_records WHERE kind='source'").get()!;
  database().prepare("UPDATE memory_sources SET outcome='failed' WHERE id='legacy-recall'").run();
  if (path === "recall") expect(() => hydrateMemoryRecord(String(record.id), 1, access("finch", "closing-chat"))).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
  // Lane D's learnable-source gate is the one refusal: a failed activity is not an owner statement.
  else expect(await consolidateMemorySource(work.id, null, new AbortController().signal)).toMatchObject({ status: "deferred", reason: "not-owner-speaker", retryAfter: null, candidateIds: [] });
  expect(database().prepare("SELECT outcome FROM memory_sources WHERE id='legacy-recall'").get()).toMatchObject({ outcome: "failed" });
});

it("refuses a legacy failed tool outcome through lane D's learnable-source gate", async () => {
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  captureSource(database(), { id: "legacy-failed-tool", threadId: "closing-chat", kind: "tool-outcome", speaker: "tool", outcome: "completed", text: "delegate_bot Failed to parse arguments: Tool not found" });
  const work = claimMemoryJob("legacy-failed-tool")!;
  publishMemoryWork(work, "legacy-failed-tool", captureWork(work));
  database().prepare("UPDATE memory_sources SET outcome='failed' WHERE id='legacy-failed-tool'").run();
  expect(await consolidateMemorySource(work.id, null, new AbortController().signal)).toMatchObject({ status: "deferred", reason: "tool-results-nightly-only", retryAfter: null, candidateIds: [] });
  expect(database().prepare("SELECT count(*) n FROM memory_records WHERE kind!='source'").get()).toMatchObject({ n: 0 });
});

it("excludes Fuigo notices and Murage held queues from capture, action admission and reply evidence", () => {
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  const db = database(), threadId = "finch-direct";
  const completed: Message = { id: "completed", at: 1, role: "bot", kind: "activity", turnId: "turn",
    tool: { name: "send_message", ok: true, action: toolAction("send_message", true) } };
  const notice: Message = { ...completed, id: "fuigo-notice", tool: { ...completed.tool!, notice: true } };
  const queue: Message = { ...completed, id: "held-queue", actorKind: "murage",
    murage: { kind: "queue", held: { count: 1, items: [] } } };
  const reply: Message = { id: "reply", at: 2, role: "bot", kind: "text", turnId: "turn", text: "I sent it." };
  for (const row of [notice, queue]) {
    captureMessage(db, threadId, row);
    expect(db.prepare("SELECT * FROM memory_sources WHERE message_id=?").all(row.id)).toEqual([]);
    expect(checkReplyActions({ reply, path: [row, reply] }).state).toBe("flagged");
  }
  expect(admissibleActionSources(db, "finch", { threadId })).toEqual([]);
  // Positive controls ensure neither a disabled capture mode nor the thread's
  // audience could make the exclusions pass without exercising the guards.
  captureMessage(db, threadId, completed);
  expect(db.prepare("SELECT kind,speaker,outcome FROM memory_sources WHERE message_id=?").get(completed.id))
    .toMatchObject({ kind: "tool-outcome", speaker: "tool", outcome: "completed" });
  expect(admissibleActionSources(db, "finch", { threadId }).map(source => source.messageId)).toEqual([completed.id]);
  expect(checkReplyActions({ reply, path: [completed, reply] }).state).toBe("recorded");
});
