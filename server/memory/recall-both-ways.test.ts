// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane M (plan 3.8, "Recall both ways"; evidence R1/R2): a bot in a project
// walked in blank (room recall never reached its own chats) and its direct
// chat knew nothing of the project (direct recall had no room scopes). On an
// owner-audience turn a room member now also recalls its own direct chat and
// tasks, and a direct turn recalls the rooms it is a member of whose every
// thread is the owner's. Never for a channel person, never for words nobody
// proved are the owner's, never another member's chats, never a pair room.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "../human-principals.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { captureSource } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { memoryOwnerRoute } from "./settings.ts";

let roster: MemoryRoster;
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  roster = {
    bots: [
      { id: "reed", threadId: "reed-direct", section: "Sales", tasks: [{ threadId: "reed-task" }, { threadId: "reed-desk", channelProjectDesk: { groupId: "launch" } }, { threadId: "reed-other-desk", channelProjectDesk: { groupId: "ops" } }] },
      { id: "cole", threadId: "cole-direct", section: "Sales" },
    ],
    groups: [
      { id: "launch", threadId: "launch-chat", memberIds: ["reed", "cole"], tasks: [{ threadId: "launch-goal" }], channelProject: { goal: "Launch", status: "active", startedAt: 1, updatedAt: 1 } },
      { id: "ops", threadId: "ops-chat", memberIds: ["reed"], channelProject: { goal: "Ops", status: "active", startedAt: 1, updatedAt: 1 } },
      { id: "channel", threadId: "channel-chat", memberIds: ["reed", "cole"] },
      { id: "guest-room", threadId: "guest-chat", memberIds: ["reed"] },
      { id: "elsewhere", threadId: "elsewhere-chat", memberIds: ["cole"] },
      { id: "pair", threadId: "pair-chat", memberIds: ["reed", "cole"], dm: true },
    ],
  };
  setMemoryCaptureRoster(() => roster);
});

function access(botId: string, thread: string, options: { notOwnerAudience?: boolean; human?: ReturnType<typeof resolveHumanBinding> } = {}) {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g", options.human);
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false, ...(options.notOwnerAudience ? { notOwnerAudience: true } : {}), ...(options.human ? { humanPrincipal: options.human } : {}) });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
function guest() {
  reconcileMemoryRoster(roster);
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  return resolveHumanBinding(binding);
}

it("an owner-audience room turn recalls the member's own direct chat and tasks, never a teammate's", () => {
  const scopes = access("reed", "launch-chat").scopeIds;
  for (const thread of ["reed-direct", "reed-task"]) expect(scopes).toContain(ensureScope("conversation", thread));
  expect(scopes).not.toContain(ensureScope("conversation", "cole-direct"));
});

it("a room turn whose words were not proven to be the owner's recalls only the room", () => {
  const scopes = access("reed", "launch-chat", { notOwnerAudience: true }).scopeIds;
  expect(scopes).toContain(ensureScope("room", "launch"));
  expect(scopes).not.toContain(ensureScope("conversation", "reed-direct"));
});

it("a room with a channel person keeps the room boundary both ways", () => {
  const person = guest();
  bindHumanThread("guest-chat", person);
  expect(access("reed", "guest-chat", { human: person }).scopeIds).not.toContain(ensureScope("conversation", "reed-direct"));
  // and the bot's direct chat does not recall that room
  expect(access("reed", "reed-direct").scopeIds).not.toContain(ensureScope("room", "guest-room"));
});

it("an owner-audience direct turn recalls the owner-only rooms the bot is a member of", () => {
  const scopes = access("reed", "reed-direct").scopeIds;
  for (const room of ["launch", "ops", "channel"]) expect(scopes).toContain(ensureScope("room", room));
  expect(scopes).not.toContain(ensureScope("room", "elsewhere")); // not a member
  expect(scopes).not.toContain(ensureScope("room", "pair")); // a pair room is not the owner's room
});

it("never on a direct turn nobody proved is the owner's, and never in a channel person's thread", () => {
  expect(access("reed", "reed-direct", { notOwnerAudience: true }).scopeIds).not.toContain(ensureScope("room", "launch"));
  const person = guest();
  roster.bots[0]!.tasks!.push({ threadId: "reed-contact" });
  bindHumanThread("reed-contact", person);
  const scopes = access("reed", "reed-contact", { human: person }).scopeIds;
  expect(scopes).not.toContain(ensureScope("room", "launch"));
  expect(scopes).not.toContain(ensureScope("conversation", "reed-direct"));
});

it("a desk thread recalls its own project, not the bot's other rooms", () => {
  const scopes = access("reed", "reed-desk").scopeIds;
  expect(scopes).toContain(ensureScope("room", "launch"));
  expect(scopes).not.toContain(ensureScope("room", "ops"));
  expect(scopes).not.toContain(ensureScope("room", "channel"));
});

it("a thread the owner left out of memory is not recalled in a room", async () => {
  reconcileMemoryRoster(roster);
  await memoryOwnerRoute("/api/memory/action", { action: "configure", excludedThreadIds: ["reed-task"] }, ownerMemoryTicket(), roster);
  expect(access("reed", "launch-chat").scopeIds).not.toContain(ensureScope("conversation", "reed-task"));
});

it("what the owner told the project reaches the member's direct chat, and its direct chat reaches the project", async () => {
  reconcileMemoryRoster(roster);
  const inProject = "Tallyroo launches on the 14th with the annual plan.";
  captureSource(database(), { id: "p1", threadId: "launch-chat", messageId: "pm1", kind: "text", speaker: "owner", outcome: "recorded", text: inProject });
  const projectRecord = saveMemoryCandidate(inProject, [{ sourceId: "p1", revision: 1, startByte: 0, endByte: Buffer.byteLength(inProject) }], "k1", access("reed", "launch-chat"));
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(projectRecord);
  const inDirect = "Pricing rule: never discount below 12 a month.";
  captureSource(database(), { id: "d1", threadId: "reed-direct", messageId: "dm1", kind: "text", speaker: "owner", outcome: "recorded", text: inDirect });
  const directRecord = saveMemoryCandidate(inDirect, [{ sourceId: "d1", revision: 1, startByte: 0, endByte: Buffer.byteLength(inDirect) }], "k2", access("reed", "reed-direct"));
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(directRecord);
  const bridge = (id: string) => ({ async search() { return { hits: [{ id, version: 1, score: 1, lexical: true }], vectorRows: 0, coverageComplete: false }; } });
  const direct = await buildMemoryBundle("when does Tallyroo launch", access("reed", "reed-direct"), bridge(projectRecord));
  expect(direct.text).toContain("Tallyroo launches on the 14th");
  const room = await buildMemoryBundle("pricing rules", access("reed", "launch-chat"), bridge(directRecord));
  expect(room.text).toContain("never discount below 12");
  // a teammate in the same room does not get Reed's direct chat
  const teammate = await buildMemoryBundle("pricing rules", access("cole", "launch-chat"), bridge(directRecord));
  expect(teammate.text).not.toContain("never discount below 12");
});

it("reaching a room reaches what its threads captured before 0.1.61, in their own conversation scopes", async () => {
  reconcileMemoryRoster(roster);
  const room = access("reed", "reed-direct").scopeIds;
  for (const thread of ["launch-chat", "launch-goal", "channel-chat"]) expect(room).toContain(ensureScope("conversation", thread));
  expect(room).not.toContain(ensureScope("conversation", "elsewhere-chat"));
  // the project's main chat reaches its own goal thread (R3), and a desk thread its project's threads
  expect(access("cole", "launch-chat").scopeIds).toContain(ensureScope("conversation", "launch-goal"));
  expect(access("reed", "reed-desk").scopeIds).toContain(ensureScope("conversation", "launch-chat"));
  expect(access("reed", "reed-desk").scopeIds).not.toContain(ensureScope("conversation", "ops-chat"));
  // a room thread the owner left out of memory stays out
  await memoryOwnerRoute("/api/memory/action", { action: "configure", excludedThreadIds: ["launch-goal"] }, ownerMemoryTicket(), roster);
  expect(access("reed", "reed-direct").scopeIds).not.toContain(ensureScope("conversation", "launch-goal"));
  expect(access("cole", "launch-chat").scopeIds).not.toContain(ensureScope("conversation", "launch-goal"));
});

it("Astra r1 #2: a desk thread never reaches a channel person's task thread in its project", () => {
  const person = guest();
  roster.groups[0]!.tasks!.push({ threadId: "launch-contact" });
  bindHumanThread("launch-contact", person);
  reconcileMemoryRoster(roster);
  const scopes = access("reed", "reed-desk").scopeIds;
  expect(scopes).toContain(ensureScope("room", "launch"));
  expect(scopes).toContain(ensureScope("conversation", "launch-chat"));
  expect(scopes).not.toContain(ensureScope("conversation", "launch-contact"));
});

it("Astra r2 #17: a room turn nobody proved is the owner's does not reach the room's other threads", () => {
  expect(access("cole", "launch-chat").scopeIds).toContain(ensureScope("conversation", "launch-goal"));
  expect(access("cole", "launch-chat", { notOwnerAudience: true }).scopeIds).not.toContain(ensureScope("conversation", "launch-goal"));
});
