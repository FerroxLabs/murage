// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { learningDestination, partitionOfScope } from "./execution-audience.ts";
import { ensureScope } from "./memory/policy.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string) => { const bot = store.createBot(); store.patchBot(bot.id, { name, section }); return bot; };
  const iris = make("Iris", "Design"), carl = make("Carl", "Design"), sam = make("Sam", "Sales"), bob = make("Bob", "Sales"), zed = make("Zed", "Support");
  sam.chiefOfStaff = true;
  const sales = teamIdFor("Sales");
  iris.partitionedAt = zed.partitionedAt = 1;
  iris.sharedWith = zed.sharedWith = { mode: "list", teams: [{ id: sales, name: "Sales" }] };
  return { store, iris, carl, sam, bob, zed, sales };
}
it("preserves a single real scope with or without a bot", () => {
  const { iris, sales } = fixture(); const scope = ensureScope("bot", iris.id + "#team:" + sales);
  expect(partitionOfScope(scope)).toEqual({ botId: iris.id, partition: { kind: "team", teamId: sales } });
  expect(learningDestination({ botId: iris.id, evidenceScopeIds: [scope], target: "memory" })).toMatchObject({ ok: true, scopeId: scope });
  const room = ensureScope("room", "room"); expect(learningDestination({ evidenceScopeIds: [room], target: "memory" })).toMatchObject({ ok: true, scopeId: room });
});
it("refuses mixed partitions, empty evidence and general evidence", () => {
  const { iris, sales } = fixture(); const home = ensureScope("bot", iris.id), team = ensureScope("bot", iris.id + "#team:" + sales), general = ensureScope("bot", iris.id + "#general");
  expect(learningDestination({ botId: iris.id, evidenceScopeIds: [home, team], target: "memory" })).toEqual({ ok: false, reason: "cross-partition" });
  expect(learningDestination({ evidenceScopeIds: [], target: "memory" }).ok).toBe(false);
  expect(learningDestination({ botId: iris.id, evidenceScopeIds: [general], target: "memory" })).toEqual({ ok: false, reason: "needs-owner-approval" });
});
it.each(["skill", "persona", "general"] as const)("requires approval for %s", target => {
  const { iris } = fixture(); expect(learningDestination({ botId: iris.id, evidenceScopeIds: [ensureScope("bot", iris.id)], target })).toEqual({ ok: false, reason: "needs-owner-approval" });
});
it("routes multiple team scopes to work-thread capture and refuses a retired scope", () => {
  const { store, iris, sales } = fixture(); const team = ensureScope("team", "Sales"), own = ensureScope("bot", iris.id + "#team:" + sales), task = store.createSharedWorkTask(iris.id, sales)!;
  expect(learningDestination({ botId: iris.id, threadId: task.threadId, evidenceScopeIds: [team, own], target: "memory" })).toMatchObject({ ok: true, scopeId: team });
  expect(learningDestination({ botId: iris.id, evidenceScopeIds: [team, own], target: "memory" }).ok).toBe(false);
  database().prepare("UPDATE team_identities SET retired_at=1 WHERE team_id=?").run(sales);
  expect(learningDestination({ botId: iris.id, evidenceScopeIds: [team], target: "memory" })).toEqual({ ok: false, reason: "retired-partition" });
});

it("routine instructions accept only home evidence", () => {
  const { iris, sales } = fixture();
  expect(learningDestination({ botId: iris.id, evidenceScopeIds: [ensureScope("bot", iris.id)], target: "routine-instructions" })).toMatchObject({ ok: true, audienceKey: `bot:${iris.id}:owner` });
  expect(learningDestination({ botId: iris.id, evidenceScopeIds: [ensureScope("bot", iris.id + "#team:" + sales)], target: "routine-instructions" }).ok).toBe(false);
});
it("unknown scopes and no-bot jobs cannot write bot destinations", () => {
  const { iris } = fixture(); expect(learningDestination({ evidenceScopeIds: ["unknown"], target: "memory" }).ok).toBe(false);
  expect(learningDestination({ evidenceScopeIds: [ensureScope("bot", iris.id)], target: "memory" })).toEqual({ ok: false, reason: "cross-partition" });
});
it("unpartitioned home-team evidence retains the owner audience", () => {
  const { carl } = fixture(); teamIdFor("Design");
  const scope = ensureScope("team", "Design"); expect(learningDestination({ botId: carl.id, evidenceScopeIds: [scope], target: "memory" })).toMatchObject({ ok: true, scopeId: scope, partition: { kind: "home" }, audienceKey: `bot:${carl.id}:owner` });
});
it("same partition evidence belonging to different bots is refused", () => {
  const { iris, zed, sales } = fixture(); const scopes = [iris, zed].map(bot => ensureScope("bot", bot.id + "#team:" + sales));
  expect(learningDestination({ botId: iris.id, evidenceScopeIds: scopes, target: "memory" })).toEqual({ ok: false, reason: "cross-partition" });
});
it("a renamed team's memory resolves through memory_key, including its deletion tombstone", () => {
  const { iris, sales } = fixture(); const scope = ensureScope("team", "Sales");
  database().prepare("UPDATE team_identities SET label='Revenue' WHERE team_id=?").run(sales);
  expect(partitionOfScope(scope)).toEqual({ partition: { kind: "team", teamId: sales } });
  database().prepare("UPDATE memory_scopes SET owner_key='deleted-team:fixture' WHERE id=?").run(scope);
  database().prepare("UPDATE team_identities SET memory_key='deleted-team:fixture', retired_at=1 WHERE team_id=?").run(sales);
  expect(learningDestination({ botId: iris.id, evidenceScopeIds: [scope], target: "memory" })).toEqual({ ok: false, reason: "retired-partition" });
});

it("a team-marked room's capture and notebook evidence share the bot's partition", () => {
  const { store, iris, sam, sales } = fixture(); const room = store.createGroup("Sales", [iris.id, sam.id], false, "Sales");
  const captured = ensureScope("room", room.id), notebook = ensureScope("bot", iris.id + "#team:" + sales);
  expect(learningDestination({ botId: iris.id, threadId: room.threadId, evidenceScopeIds: [captured, notebook], target: "memory" })).toMatchObject({ ok: true, scopeId: captured, partition: { kind: "team", teamId: sales } });
});
it("non-home project desk evidence resolves to its project capture scope", () => {
  const { store, iris, sam } = fixture(); const room = store.createGroup("Project", [iris.id, sam.id], false, "Sales");
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(room.id);
  store.patchGroup(room.id, { channelProject: { goal: "fixture", status: "active", startedAt: 1, updatedAt: 1 } });
  const desk = store.ensureProjectDesk(iris.id, room.id, "Project")!, capture = ensureScope("room", room.id), own = ensureScope("bot", iris.id + "#project:" + room.id);
  expect(learningDestination({ botId: iris.id, threadId: desk.threadId, evidenceScopeIds: [capture, own], target: "memory" })).toMatchObject({ ok: true, scopeId: capture, partition: { kind: "project", groupId: room.id } });
});
