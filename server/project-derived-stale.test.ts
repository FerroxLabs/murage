// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC-P 15.3 wired (lane M): when the owner forgets a message, or memory
// that rests on one, the project text derived from it (summaries, cards,
// brief decisions) goes stale in the same transaction and drops out of the
// member layers until it is rewritten.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./memory/authority.ts";
import { captureSource } from "./memory/capture.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { forgetMemory, onMemoryMessagesForgotten } from "./memory/forget.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { projectSummaryLayer } from "./project-layers.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { markProjectDerivedStale } from "./project-tables.ts";
import { projectMessagePlaces, projectThreadDeletion } from "./project-memory-tools.ts";
import { Store } from "./store.ts";

const NOW = 1_790_000_000_000;
const roster: MemoryRoster = {
  bots: [{ id: "finch", threadId: "finch-direct" }, { id: "dax", threadId: "dax-direct" }],
  groups: [{ id: "launch", threadId: "launch-chat", memberIds: ["finch", "dax"], channelProject: { goal: "Launch" } }],
};
const view = { groupId: "launch", botId: "dax", names: new Map([["finch", "Finch"]]) };
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryCaptureRoster(() => roster); setMemoryMode("active"); reconcileMemoryRoster(roster);
  onMemoryMessagesForgotten((db, ids) => { markProjectDerivedStale(db, ids); });
  channelToProjectRows(database(), { groupId: "launch", bulletin: "", leadBotId: "finch", now: NOW });
  database().prepare("INSERT INTO project_summaries(group_id, version, text, source_message_ids, made_by, at) VALUES('launch',1,'SUMMARY_CANARY the price is 12','[\"m-price\"]','finch',?)").run(NOW);
});
afterEach(() => onMemoryMessagesForgotten(null));

function capture(id: string, text: string) {
  captureSource(database(), { id: `message:launch-chat:${id}`, threadId: "launch-chat", messageId: id, kind: "text", speaker: "owner", outcome: "recorded", text });
}

it("forgetting the message a summary cites drops the summary from the member's layers", () => {
  capture("m-price", "The price is 12.");
  expect(projectSummaryLayer(database(), view, true)).toContain("SUMMARY_CANARY");
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:launch-chat:m-price" });
  expect(database().prepare("SELECT stale FROM project_summaries WHERE group_id='launch' AND version=1").get()?.stale).toBe(1);
  expect(projectSummaryLayer(database(), view, true)).not.toContain("SUMMARY_CANARY");
});

it("forgetting a memory note that rests on the message does the same", () => {
  capture("m-price", "The price is 12.");
  const registry = new InternalCapabilities(); registry.begin("dax", "launch-chat", "g");
  const access = memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "dax", threadId: "launch-chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
  const record = saveMemoryCandidate("The price is 12.", [{ sourceId: "message:launch-chat:m-price", revision: 1, startByte: 0, endByte: 16 }], "k", access);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(database().prepare("SELECT stale FROM project_summaries WHERE group_id='launch' AND version=1").get()?.stale).toBe(1);
});

it("forgetting something else leaves the summary alone", () => {
  capture("m-other", "Unrelated.");
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:launch-chat:m-other" });
  expect(database().prepare("SELECT stale FROM project_summaries WHERE group_id='launch' AND version=1").get()?.stale).toBe(0);
});

// Round 9 (S1): a lead card made on a goal Start or Change wake binds no
// message, yet the lead's session read the room's owner messages. Forgetting
// one marks every such card of the project made after it stale.
it("forgetting an owner message in the room marks the lead's sourceless cards made after it stale", () => {
  capture("m-owner", "Plan the launch around the 12 price.");
  const card = (id: string, createdBy: string, sources: string, at: number) => database().prepare(`INSERT INTO project_work_items
    (id, group_id, number, title, state, position, source_message_ids, created_by, created_at, updated_at) VALUES (?, 'launch', ?, ?, 'todo', 1, ?, ?, ?, ?)`)
    .run(id, Number(id.slice(1)), `Card ${id}`, sources, createdBy, at, at);
  card("c1", "finch", "[]", NOW - 10);
  card("c2", "finch", "[]", NOW + 10);
  card("c3", "finch", '["m-other"]', NOW + 10);
  card("c4", "owner", "[]", NOW + 10);
  onMemoryMessagesForgotten((db, ids) => { markProjectDerivedStale(db, ids, (id) => id === "m-owner" ? { groupId: "launch", at: NOW } : undefined); });
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:launch-chat:m-owner" });
  expect(database().prepare("SELECT id, stale FROM project_work_items ORDER BY id").all()).toEqual([
    { id: "c1", stale: 0 }, { id: "c2", stale: 1 }, { id: "c3", stale: 0 }, { id: "c4", stale: 0 },
  ]);
});

// Round 10 (R5): a forgotten message in any thread of the project (its
// room, a task thread, a member's desk) is placed in that project, and each
// thread is read once however many of its messages go.
function projectStore() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Finch", section: "Studio" });
  const group = store.createGroup("Launch", [bot.id]);
  const task = store.createGroupTask(group.id, "Pricing", false)!;
  const desk = store.ensureProjectDesk(bot.id, group.id, "Launch")!;
  const liveRoster = { bots: store.bots, groups: store.groups };
  setMemoryCaptureRoster(() => liveRoster); reconcileMemoryRoster(liveRoster);
  channelToProjectRows(database(), { groupId: group.id, bulletin: "", leadBotId: bot.id, now: NOW });
  const say = (threadId: string, text: string, at: number) => {
    const messageId = store.appendMessage(threadId, { role: "user", kind: "text", text, at }).id;
    captureSource(database(), { id: `message:${threadId}:${messageId}`, threadId, messageId, kind: "text", speaker: "owner", outcome: "recorded", text });
    return messageId;
  };
  const card = (id: string, sources: string, at: number) => database().prepare(`INSERT INTO project_work_items
    (id, group_id, number, title, state, position, source_message_ids, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'todo', 1, ?, ?, ?, ?)`)
    .run(id, group.id, Number(id.slice(1)), `Card ${id}`, sources, bot.id, at, at);
  return { store, group, task, desk, say, card, roster: liveRoster };
}

it("places a forgotten message in any thread of its project, reading each thread once", () => {
  const { store, group, task, desk, say, roster } = projectStore();
  const inRoom = say(group.threadId, "room", NOW - 30), inTask = say(task.threadId, "task", NOW - 20);
  const inTaskToo = say(task.threadId, "task again", NOW - 15), atDesk = say(desk.threadId, "desk", NOW - 10);
  const reads: string[] = [];
  const messagesFor = (threadId: string) => { reads.push(threadId); return store.messagesFor(threadId); };
  const places = projectMessagePlaces(database(), { roster, messagesFor, messageIds: [inRoom, inTask, inTaskToo, atDesk, "not-captured"] });
  expect(Object.fromEntries(places)).toEqual({
    [inRoom]: { groupId: group.id, at: NOW - 30 }, [inTask]: { groupId: group.id, at: NOW - 20 },
    [inTaskToo]: { groupId: group.id, at: NOW - 15 }, [atDesk]: { groupId: group.id, at: NOW - 10 },
  });
  expect(reads.sort()).toEqual([group.threadId, task.threadId, desk.threadId].sort());
  // a thread named by the caller is read once for all of its messages
  reads.length = 0;
  expect(projectMessagePlaces(database(), { roster, messagesFor, messageIds: [inTask, inTaskToo], threadId: task.threadId }).size).toBe(2);
  expect(reads).toEqual([task.threadId]);
});

// Round 10 (S2): deleting a project's task thread forgets its messages for
// the project: cards citing one, and the lead's sourceless cards made after
// its first message, go stale.
it("deleting a project's task thread marks the cards derived from it stale", () => {
  const { store, group, task, say, card, roster } = projectStore();
  const first = say(task.threadId, "Plan around the 12 price.", NOW - 5);
  say(task.threadId, "And the second tier.", NOW + 1);
  card("c1", "[]", NOW - 10);
  card("c2", "[]", NOW + 10);
  card("c3", JSON.stringify([first]), NOW - 20);
  card("c4", '["m-other"]', NOW + 10);
  const forget = projectThreadDeletion(database(), { roster, messagesFor: (threadId) => store.messagesFor(threadId), threadIds: [task.threadId] });
  expect(store.deleteGroupTask(group.id, task.threadId)).toBeTruthy();
  expect(forget()).toBe(2);
  expect(database().prepare("SELECT id, stale FROM project_work_items ORDER BY id").all()).toEqual([
    { id: "c1", stale: 0 }, { id: "c2", stale: 1 }, { id: "c3", stale: 1 }, { id: "c4", stale: 0 },
  ]);
});

// Round 12 (S2): deleting a member's project desk conversation, or the
// member itself with all its desks, forgets their messages for the project
// the same way.
it("deleting a member's project desk conversation marks the cards derived from it stale", () => {
  const { store, desk, say, card, roster } = projectStore();
  const first = say(desk.threadId, "Use the 12 price.", NOW - 5);
  card("c1", "[]", NOW - 10);
  card("c2", "[]", NOW + 10);
  card("c3", JSON.stringify([first]), NOW - 20);
  const bot = store.bots[0]!;
  const forget = projectThreadDeletion(database(), { roster, messagesFor: (threadId) => store.messagesFor(threadId), threadIds: [desk.threadId] });
  expect(store.deleteTask(bot.id, desk.threadId)).toBeTruthy();
  expect(forget()).toBe(2);
  expect(database().prepare("SELECT id, stale FROM project_work_items ORDER BY id").all()).toEqual([
    { id: "c1", stale: 0 }, { id: "c2", stale: 1 }, { id: "c3", stale: 1 },
  ]);
});
it("deleting a member marks the cards derived from any of its desks stale", () => {
  const { store, desk, say, card, roster } = projectStore();
  const first = say(desk.threadId, "Use the 12 price.", NOW - 5);
  card("c1", "[]", NOW - 10);
  card("c3", JSON.stringify([first]), NOW - 20);
  const bot = store.bots[0]!;
  const threadIds = [bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)];
  const forget = projectThreadDeletion(database(), { roster, messagesFor: (threadId) => store.messagesFor(threadId), threadIds });
  store.deleteBot(bot.id);
  expect(forget()).toBe(1);
  expect(database().prepare("SELECT id, stale FROM project_work_items ORDER BY id").all()).toEqual([{ id: "c1", stale: 0 }, { id: "c3", stale: 1 }]);
});

// Round 12 (L5): the thread is already gone when the marking runs, so a
// failure there is logged and never turns the deletion into a failure.
it("a failure marking stale after the deletion is logged, not thrown", () => {
  const { store, group, task, say, card, roster } = projectStore();
  say(task.threadId, "Plan around the 12 price.", NOW - 5);
  card("c2", "[]", NOW + 10);
  const forget = projectThreadDeletion(database(), { roster, messagesFor: (threadId) => store.messagesFor(threadId), threadIds: [task.threadId] });
  expect(store.deleteGroupTask(group.id, task.threadId)).toBeTruthy();
  database().exec("CREATE TRIGGER stale_boom BEFORE UPDATE ON project_work_items BEGIN SELECT RAISE(ABORT, 'boom'); END");
  const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect(forget()).toBe(0);
    const diag = warned.mock.calls.filter((c) => !String(c[0]).startsWith("memory receipts revoked"));
    expect(diag).toHaveLength(1);
    expect(String(diag[0]![0])).toContain("boom");
  } finally { warned.mockRestore(); }
});

// Round 13 (A7): the read before a deletion can never block it: a read
// that throws is logged (its message only) and leaves a step that marks
// nothing; and each thread is read once.
it("a read that throws before a deletion leaves a step that marks nothing, and logs only the message", () => {
  const { store, group, task, card, roster } = projectStore();
  card("c2", "[]", NOW + 10);
  const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const forget = projectThreadDeletion(database(), { roster, messagesFor: () => { throw new Error("read boom"); }, threadIds: [task.threadId] });
    expect(store.deleteGroupTask(group.id, task.threadId)).toBeTruthy();
    expect(forget()).toBe(0);
    const diag = warned.mock.calls.filter((c) => !String(c[0]).startsWith("memory receipts revoked"));
    expect(diag).toHaveLength(1);
    expect(diag[0]).toHaveLength(1);
    expect(String(diag[0]![0])).toContain("read boom");
    expect(String(diag[0]![0])).not.toContain("    at ");
  } finally { warned.mockRestore(); }
  expect(database().prepare("SELECT stale FROM project_work_items WHERE id='c2'").get()).toEqual({ stale: 0 });
});
// Round 14 (B5): one thread that cannot be read drops only its own
// messages; the threads that were read still mark what cites them.
it("a read that throws for one deleted thread still marks what the other threads' messages back", () => {
  const { store, group, task, desk, say, card, roster } = projectStore();
  const first = say(desk.threadId, "Use the 12 price.", NOW - 5);
  card("c1", "[]", NOW - 10);
  card("c3", JSON.stringify([first]), NOW - 20);
  const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const forget = projectThreadDeletion(database(), { roster, messagesFor: (threadId) => { if (threadId === task.threadId) throw new Error("read boom"); return store.messagesFor(threadId); }, threadIds: [task.threadId, desk.threadId] });
    expect(store.deleteGroupTask(group.id, task.threadId)).toBeTruthy();
    expect(forget()).toBe(1);
    const diag = warned.mock.calls.filter((c) => !String(c[0]).startsWith("memory receipts revoked"));
    expect(diag).toHaveLength(1);
    expect(String(diag[0]![0])).toContain("read boom");
  } finally { warned.mockRestore(); }
  expect(database().prepare("SELECT id, stale FROM project_work_items ORDER BY id").all()).toEqual([{ id: "c1", stale: 0 }, { id: "c3", stale: 1 }]);
});
it("reads each deleted thread once", () => {
  const { store, task, desk, say, roster } = projectStore();
  say(task.threadId, "task", NOW - 5);
  say(desk.threadId, "desk", NOW - 5);
  const reads: string[] = [];
  projectThreadDeletion(database(), { roster, messagesFor: (threadId) => { reads.push(threadId); return store.messagesFor(threadId); }, threadIds: [task.threadId, desk.threadId, task.threadId] });
  expect(reads.sort()).toEqual([task.threadId, desk.threadId].sort());
});

it("Astra r1 #7: the room turn renders the project layers again after its withholding check marks text stale", () => {
  const index = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  const sync = index.indexOf("if(roomTranscriptOwner)syncOwnerWithheldNotes(threadId,roomTranscript);");
  const again = index.indexOf("const projectNow=projectMember?roomProjectMember(group,bot.id,roomOwnerAudience,availableContextTokens):null;");
  const rebuilt = index.indexOf("text=`${withProjectStatus(serializeRoomContext(threadId,userName,roomTranscript.messages,roomTranscript.withheld,projectTranscript),projectStatus)}");
  expect(sync).toBeGreaterThan(0);
  expect(again).toBeGreaterThan(sync);
  expect(rebuilt).toBeGreaterThan(again);
  expect(index).toContain(`if(projectNow){const at=roomLayers.findIndex(layer=>layer.id==="project-brief");if(at>=0)roomLayers[at]=shapeLayer("project-brief",projectNow.brief?`);
  // Astra r2 #7: the Chief's roster in the room system prompt is rendered again too
  expect(index.indexOf('if(bot.chiefOfStaff){const fresh=buildRoomSystem();')).toBeGreaterThan(again);
});
