// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { threadHumanPrincipal } from "./human-principals.ts";
import { audienceTask, authorizeWork, effectiveAudience, homeThread, markPartitions, partitionRoots, threadPartition } from "./execution-audience.ts";
import { taskWorkspacePath } from "./workspace.ts";
import { bindHumanThread, humanTask, observeVerifiedHuman, linkHumanBinding, resolveHumanBinding } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { scopedConfig } from "./sse-visibility.ts";

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
it("creates one inactive owner work task without changing policy revision", () => {
  const { store, iris, sam, sales } = fixture(); store.createGroup("pair", [iris.id, sam.id], true, "Sales");
  const revision = database().prepare("SELECT policy_revision FROM memory_meta").get()!.policy_revision;
  const active = iris.threadId, task = store.createSharedWorkTask(iris.id, sales)!;
  expect(store.createSharedWorkTask(iris.id, sales)).toBe(task); expect(iris.threadId).toBe(active);
  expect(database().prepare("SELECT policy_revision FROM memory_meta").get()!.policy_revision).toBe(revision);
  expect(taskWorkspacePath(DATA_DIR, iris.id, task.threadId)).toBe(partitionRoots(iris, { kind: "team", teamId: sales })[0] + "/threads/" + task.threadId);
});
it.each(["", "Design"])("mixed %s room never becomes home", label => {
  const { store, iris, bob } = fixture(); const room = store.createGroup("mixed", [iris.id, bob.id], false, label);
  expect(threadPartition(iris, room.threadId)).toEqual({ kind: "room", groupId: room.id });
  store.patchGroup(room.id, { memberIds: [iris.id], section: "Design" }); markPartitions(store);
  expect(threadPartition(iris, room.threadId)).toEqual({ kind: "room", groupId: room.id });
});
it("team marker survives relabel and wins over project detection", () => {
  const { store, iris, sam, sales } = fixture(); const room = store.createGroup("Sales", [iris.id, sam.id], false, "Sales");
  expect(threadPartition(iris, room.threadId)).toEqual({ kind: "team", teamId: sales });
  store.patchGroup(room.id, { section: "Design", channelProject: { goal: "test", status: "active", startedAt: 1, updatedAt: 1 } });
  expect(threadPartition(iris, room.threadId)).toEqual({ kind: "team", teamId: sales });
  expect(effectiveAudience(iris, room.threadId, null)).toEqual({ kind: "team", teamId: sales });
});
it("selects home despite active shared and newest routine threads", () => {
  const { store, iris, sales } = fixture(); const original = iris.threadId;
  const routine = store.createTask(iris.id, "routine", false)!;
  store.appendMessage(routine.threadId, { role: "user", kind: "text", text: "routine", routineRunPrompt: { trigger: "manual", routineName: "test" } });
  const work = store.createSharedWorkTask(iris.id, sales)!; store.switchTask(iris.id, work.threadId);
  expect(homeThread(iris).threadId).toBe(original);
  expect(audienceTask(store, iris.id, threadHumanPrincipal(original), { v: 1, kind: "team", team: sales, human: "owner", rootRequestId: "r" })).toBe(work);
});
it("creates an owner home thread if every existing thread is partitioned", () => {
  const { store, iris, sales } = fixture(); iris.tasks = [store.createSharedWorkTask(iris.id, sales)!]; iris.threadId = iris.tasks[0].threadId;
  const task = homeThread(iris); expect(task.sharedWork).toBeUndefined(); expect(task.title).toBe("Direct chat"); expect(task.threadId).not.toBe(iris.threadId);
});

it("an active contact thread cannot become the owner home thread", () => {
  const { store, iris } = fixture(); const ownerThread = iris.threadId;
  const bindingId = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "fixture", userId: "contact" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" }); const principal = resolveHumanBinding(bindingId);
  const contact = humanTask(store, iris.id, principal)!; bindHumanThread(contact.threadId, principal); store.switchTask(iris.id, contact.threadId);
  expect(homeThread(iris).threadId).toBe(ownerThread);
  expect(audienceTask(store, iris, principal, { v: 1, kind: "team", human: "owner", team: "sales", rootRequestId: "r" })).toBe(contact);
});
it("sharing sets partitionedAt once and eager saves mark affected rooms", () => {
  const { store, carl, bob, sales } = fixture(); const group = store.createGroup("mixed", [carl.id, bob.id]);
  store.patchBot(carl.id, { sharedWith: { mode: "list", teams: [{ id: sales, name: "Sales" }] } }); const since = carl.partitionedAt;
  expect(since).toBeTypeOf("number"); expect(group.partitionedFor?.[carl.id]).toEqual({ kind: "room" });
  store.patchBot(carl.id, { sharedWith: { mode: "none", teams: [] }, partitionedAt: undefined }); expect(carl.partitionedAt).toBe(since);
});
it("General-only rooms remain home for a General-home bot and historical DMs remain home", () => {
  const { store, iris } = fixture(); const general = store.createBot(); store.patchBot(general.id, { partitionedAt: 1 });
  const room = store.createGroup("General", [general.id]); expect(threadPartition(general, room.threadId)).toEqual({ kind: "home" });
  const dm = store.createGroup("old pair", [iris.id, general.id], true, "Sales"); expect(threadPartition(iris, dm.threadId)).toEqual({ kind: "home" });
});
it("quarantined threads and home-team restored markers remain isolated from home", () => {
  const { store, iris, sales } = fixture(); const task = store.createSharedWorkTask(iris.id, sales)!; task.sharedWork!.quarantined = true;
  expect(threadPartition(iris, task.threadId)).toEqual({ kind: "isolated", threadId: task.threadId });
  const room = store.createGroup("Design", [iris.id], false, "Design"); room.partitionedFor = { [iris.id]: { kind: "team", teamId: teamIdFor("Design") } };
  expect(threadPartition(iris, room.threadId)).toEqual({ kind: "room", groupId: room.id });
});
it("the four sibling partition folders belong to the workspaces inventory", () => {
  const { iris, sales } = fixture();
  for (const partition of [{ kind: "general" }, { kind: "team", teamId: sales }, { kind: "project", groupId: "p" }, { kind: "room", groupId: "g" }] as const) {
    const root = partitionRoots(iris, partition)[0];
    expect(root.startsWith(DATA_DIR + "/workspaces/" + iris.id + ".")).toBe(true);
    expect(classifyDataDirEntry(root.slice(DATA_DIR.length + 1).split("/")[0])).toMatchObject({ backup: "owner-folder" });
  }
});

it("the sharing flag defaults on, survives config loading, and stays off scoped surfaces", () => {
  expect(loadConfig().features?.botsSharedAcrossTeams !== false).toBe(true);
  saveConfig({ features: { botsSharedAcrossTeams: false } }); expect(loadConfig().features?.botsSharedAcrossTeams).toBe(false);
  const projected = scopedConfig({ profile: {}, features: { botsSharedAcrossTeams: true, projectsLead: true } });
  expect(projected.features).toEqual({ projectsLead: true });
});

it("an owner project tag selects a member's desk, never a nonmember's home", () => {
  const { store, iris, sam, carl } = fixture(); const room = store.createGroup("Project", [iris.id, sam.id], false, "Sales");
  database().prepare("INSERT INTO project_settings(group_id,updated_at) VALUES(?,1)").run(room.id);
  const principal = threadHumanPrincipal(iris.threadId), tag = { v: 1 as const, kind: "project" as const, human: "owner" as const, projectId: room.id, rootRequestId: "root" };
  const desk = audienceTask(store, iris, principal, tag)!; expect(desk.channelProjectDesk?.groupId).toBe(room.id);
  expect(threadPartition(iris, desk.threadId)).toEqual({ kind: "project", groupId: room.id, homeMember: false });
  expect(audienceTask(store, carl, principal, tag)).toBeNull();
  expect(audienceTask(store, iris, principal, null)).toBe(homeThread(iris));
});

it("R4d N2: a legacy section over 60 characters with a partitioned member keeps a room marker and never breaks the store", () => {
  const long = "L".repeat(61), store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const iris = store.createBot(); store.patchBot(iris.id, { name: "Iris", section: "Design" });
  const lead = store.createBot(); store.patchBot(lead.id, { name: "Lee", section: "Short" });
  const room = store.createGroup("Legacy", [iris.id, lead.id], false, "Short");
  closeDatabase();
  const edit = (file: string, fn: (rows: any[]) => void) => { const path = join(DATA_DIR, file), rows = JSON.parse(readFileSync(path, "utf8")); fn(rows); writeFileSync(path, JSON.stringify(rows)); };
  edit("bots.json", rows => { rows.find(b => b.id === iris.id).partitionedAt = 1; Object.assign(rows.find(b => b.id === lead.id), { section: long, chiefOfStaff: true }); });
  edit("groups.json", rows => { rows.find(g => g.id === room.id).section = long; });
  let loaded!: Store;
  expect(() => { loaded = new Store(() => ({ instanceId: "fixture", model: "fixture" })); }).not.toThrow();
  expect(loaded.group(room.id)?.partitionedFor?.[iris.id]).toEqual({ kind: "room" });
  expect(database().prepare("SELECT COUNT(*) AS n FROM team_identities").get()).toMatchObject({ n: 0 });
  expect(() => loaded.patchBot(iris.id, { name: "Iris B" })).not.toThrow();
  expect(() => loaded.patchBot(lead.id, { name: "Lee B" })).not.toThrow();
  const lee = loaded.bot(lead.id)!;
  expect(authorizeWork({ edge: "peer", requesterBotId: lee.id, requesterThreadId: lee.threadId, targetBotId: iris.id, verb: "ask", tag: null, ownerAudience: true })).toMatchObject({ ok: false, code: "not_reachable" });
  expect(database().prepare("SELECT COUNT(*) AS n FROM team_identities").get()).toMatchObject({ n: 0 });
});
