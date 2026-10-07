// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC-X 12.1 and 12.2: the owner's sharing routes, called through the one
// entry point index.ts uses, over a real store and messages.db.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR, loadConfig, saveConfig } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { partitionRoots } from "./execution-audience.ts";
import { enqueueSharedWork } from "./shared-work.ts";
import { sharingRoute, sharedLoadLine, teamSharing } from "./sharing-routes.ts";
import { roomRequest } from "./room-requests.ts";
import { ensureWorkspace } from "./workspace.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const make = (name: string, section: string, extra: Record<string, unknown> = {}) => { const bot = store.createBot(); store.patchBot(bot.id, { name, section, ...extra }); return bot; };
  const iris = make("Iris", "Design", { title: "Designer", description: "Makes things", persona: "dry", notifications: false });
  const carl = make("Carl", "Design"), sam = make("Sam", "Sales", { chiefOfStaff: true }), tia = make("Tia", "Support", { chiefOfStaff: true });
  const solo = make("Solo", "Solo", { individual: true });
  const call = async (method: string, path: string, body?: unknown, desktop = true, visible = true) =>
    (await sharingRoute({ method, path, desktop, visible: () => visible, readBody: async () => body, deps: { store } }))!;
  return { store, iris, carl, sam, tia, solo, call };
}

it("GET lists every named team with its identity, home and assistants-only teams not selectable, and the limits", async () => {
  const f = fixture();
  const view = (await f.call("GET", `/api/bots/${f.iris.id}/sharing`)).body as any;
  expect(view.home).toMatchObject({ name: "Design" });
  expect(view.sharedWith).toEqual({ mode: "none", teams: [] });
  expect(view.partitioned).toBe(false);
  expect(view.teams.map((t: any) => [t.name, t.selectable, t.reason ?? null])).toEqual([["Design", false, "home"], ["Sales", true, null], ["Solo", false, "assistants"], ["Support", true, null]]);
  expect(view.teams.every((t: any) => /^[\w-]+$/.test(t.id))).toBe(true);
  expect(view.limits).toEqual({ runningPerTeam: 1, runningTotal: 2, queuedPerTeam: 20, expiresHours: 24 });
});

it("PATCH list shares with named teams and partitions the bot; home, unknown, assistants-only, General and the Chief are refused", async () => {
  const f = fixture(); const sales = teamIdFor("Sales"), design = teamIdFor("Design"), solo = teamIdFor("Solo");
  const path = `/api/bots/${f.iris.id}/sharing`;
  expect((await f.call("PATCH", path, { mode: "list", teamIds: [design] })).status).toBe(400);
  expect((await f.call("PATCH", path, { mode: "list", teamIds: [solo] })).status).toBe(400);
  expect((await f.call("PATCH", path, { mode: "list", teamIds: ["no-such-team"] })).status).toBe(400);
  expect((await f.call("PATCH", path, { mode: "list", teamIds: [] })).status).toBe(400);
  expect((await f.call("PATCH", path, { mode: "list", teamIds: [sales], extra: 1 })).status).toBe(400);
  expect((await f.call("PATCH", `/api/bots/${f.solo.id}/sharing`, { mode: "all" })).status).toBe(400);
  expect(f.store.bot(f.iris.id)!.partitionedAt).toBeUndefined();
  const shared = await f.call("PATCH", path, { mode: "list", teamIds: [sales] });
  expect(shared.status).toBe(200);
  expect(shared.body).toMatchObject({ sharedWith: { mode: "list", teams: [{ id: sales, name: "Sales" }] }, partitioned: true, cancelled: 0, stopping: [] });
  const at = f.store.bot(f.iris.id)!.partitionedAt;
  expect(at).toBeTypeOf("number");
  // turning sharing off keeps the partitions (never cleared)
  expect((await f.call("PATCH", path, { mode: "none" })).status).toBe(200);
  expect(f.store.bot(f.iris.id)!.partitionedAt).toBe(at);
});

it("PATCH answers 409 while sharing is turned off, and every route but work-threads refuses a caller that is not the desktop", async () => {
  const f = fixture(); const config = loadConfig();
  saveConfig({ ...config, features: { ...config.features, botsSharedAcrossTeams: false } });
  expect((await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "all" })).status).toBe(409);
  saveConfig({ ...config, features: { ...config.features, botsSharedAcrossTeams: true } });
  for (const [method, path] of [["GET", "sharing"], ["PATCH", "sharing"], ["POST", "sharing/skills"], ["POST", "sharing/copy"], ["GET", "general-notes"], ["PUT", "general-notes"]])
    expect((await f.call(method, `/api/bots/${f.iris.id}/${path}`, {}, false)).status, `${method} ${path}`).toBe(404);
  expect(await sharingRoute({ method: "DELETE", path: `/api/bots/${f.iris.id}/sharing`, desktop: true, visible: () => true, readBody: async () => ({}), deps: { store: f.store } })).toBeNull();
});

it("removing a team with Stop it now cancels its queued and running rows and names the stopped team", async () => {
  const f = fixture(); const sales = teamIdFor("Sales");
  await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "all" });
  const enqueue = (key: string) => enqueueSharedWork(f.store, { fromBotId: f.sam.id, sourceThreadId: f.sam.threadId, toBotId: f.iris.id, message: "CANARY_SALES", admissionKey: key, ownerAudience: true, now: 1 });
  const running = enqueue("run"), queued = enqueue("queued"); if (!running.ok || !queued.ok) throw Error("fixture");
  database().prepare("UPDATE room_requests SET state='running',dispatched_at=2 WHERE id=?").run(running.request.id);
  const view = (await f.call("GET", `/api/bots/${f.iris.id}/sharing`)).body as any;
  expect(view.load).toEqual([{ teamId: sales, name: "Sales", running: 1, queued: 1, waitingOnYou: 0 }]);
  expect(view.loadLine).toBe("Iris, shared from Design: working for Sales, 1 waiting");
  const stopped = await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "list", teamIds: [teamIdFor("Support")], running: "stop" });
  expect(stopped.body).toMatchObject({ cancelled: 2, stopping: [sales] });
  expect(roomRequest(database(), running.request.id)?.state).toBe("cancelled");
  expect(f.store.bot(f.iris.id)!.tasks!.find(t => t.sharedWork?.teamId === sales)!.sharedWork).toMatchObject({ closedReason: "revoked" });
});

it("general notes: owner-only GENERAL.md with a revision, a 409 on a stale revision and a size cap", async () => {
  const f = fixture(); const path = `/api/bots/${f.iris.id}/general-notes`;
  const empty = (await f.call("GET", path)).body as any;
  expect(empty).toMatchObject({ text: "", lastWrittenAt: null });
  const saved = await f.call("PUT", path, { text: "CANARY_GENERAL rides every team", expectedRevision: empty.revision });
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ text: "CANARY_GENERAL rides every team" });
  expect(existsSync(join(partitionRoots(f.iris, { kind: "general" })[0], "GENERAL.md"))).toBe(true);
  const stale = await f.call("PUT", path, { text: "late", expectedRevision: empty.revision });
  expect(stale.status).toBe(409);
  expect(stale.body).toMatchObject({ error: "changed", text: "CANARY_GENERAL rides every team" });
  expect((await f.call("PUT", path, { text: "x".repeat(16385), expectedRevision: (saved.body as any).revision })).status).toBe(400);
  expect((await f.call("PUT", path, { text: "no revision" })).status).toBe(400);
});

it("skills: an unknown or owner-installed skill has no every-team switch, and the list holds only learned skills", async () => {
  const f = fixture();
  expect((await f.call("POST", `/api/bots/${f.iris.id}/sharing/skills`, { name: "missing", revision: "r", everyTeam: true })).status).toBe(404);
  expect((await f.call("POST", `/api/bots/${f.iris.id}/sharing/skills`, { name: "missing" })).status).toBe(400);
  expect(((await f.call("GET", `/api/bots/${f.iris.id}/sharing`)).body as any).skills).toEqual([]);
});

it("Make a copy for this team: a new bot in that team with the profile allowlist and none of the bot's own material", async () => {
  const f = fixture(); const sales = teamIdFor("Sales");
  await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "all" });
  writeFileSync(join(ensureWorkspace(f.iris.id), "MEMORY.md"), "CANARY_DESIGN_NOTE");
  expect((await f.call("POST", `/api/bots/${f.iris.id}/sharing/copy`, { teamId: teamIdFor("Design") })).status).toBe(400);
  const made = await f.call("POST", `/api/bots/${f.iris.id}/sharing/copy`, { teamId: sales });
  expect(made.status).toBe(201);
  const copy = f.store.bot((made.body as any).bot.id)!;
  expect(copy).toMatchObject({ name: "Iris for Sales", title: "Designer", description: "Makes things", persona: "dry", notifications: false, section: "Sales", color: f.iris.color });
  expect(copy.modelSelection).toEqual(f.iris.modelSelection);
  expect(copy.sharedWith).toBeUndefined();
  expect(copy.partitionedAt).toBeUndefined();
  expect(copy.tasks).toHaveLength(1);
  const notebook = join(DATA_DIR, "workspaces", copy.id, "MEMORY.md");
  expect(existsSync(notebook) && readFileSync(notebook, "utf8").includes("CANARY_DESIGN")).toBe(false);
});

it("work-threads: opens on first use for a covered team, 404 for a team it is not shared with, and a closed thread stays readable", async () => {
  const f = fixture(); const sales = teamIdFor("Sales"), support = teamIdFor("Support");
  await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "list", teamIds: [sales] });
  const path = `/api/bots/${f.iris.id}/work-threads`;
  expect((await f.call("POST", path, { teamId: support })).status).toBe(404);
  // the phone may open it (visible to it); a hidden bot is not found
  expect((await f.call("POST", path, { teamId: sales }, false, false)).status).toBe(404);
  const opened = await f.call("POST", path, { teamId: sales }, false, true);
  expect(opened.status).toBe(200);
  const threadId = (opened.body as any).threadId;
  expect(f.store.bot(f.iris.id)!.tasks!.find(t => t.threadId === threadId)!.sharedWork).toMatchObject({ teamId: sales });
  expect(((await f.call("POST", path, { teamId: sales })).body as any).threadId).toBe(threadId);
  await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "none" });
  expect(((await f.call("POST", path, { teamId: sales })).body as any).threadId).toBe(threadId);
  expect((await f.call("GET", path)) ?? null).toBeNull();
});

it("Team settings: the team's id and the bots shared into it, with the owner's load line only", async () => {
  const f = fixture(); const sales = teamIdFor("Sales");
  await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "all" });
  expect(teamSharing(f.store, "Sales")).toEqual({ id: sales, sharedIn: [{ botId: f.iris.id, name: "Iris", from: "Design", load: "" }] });
  expect(teamSharing(f.store, "Design").sharedIn).toEqual([]);
  const row = enqueueSharedWork(f.store, { fromBotId: f.sam.id, sourceThreadId: f.sam.threadId, toBotId: f.iris.id, message: "x", admissionKey: "k", ownerAudience: true, now: 1 });
  expect(row.ok).toBe(true);
  expect(teamSharing(f.store, "Sales").sharedIn[0].load).toBe("Iris, shared from Design: working for Sales, 1 waiting");
  // the owner-only surface is empty for any other audience
  expect(sharedLoadLine(f.store.bot(f.iris.id)!, false)).toBe("");
});

it("R4 work-threads: an all-mode row with no team id opens by its name, which mints the team there and nowhere earlier", async () => {
  const f = fixture();
  expect((await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "all" })).status).toBe(200);
  const identities = () => database().prepare("SELECT label FROM team_identities WHERE retired_at IS NULL ORDER BY label").all().map(row => String(row.label));
  expect(identities()).toEqual([]);
  // Team settings is a read: a null id, the shared bot still listed, nothing minted
  expect(teamSharing(f.store, "Sales")).toEqual({ id: null, sharedIn: [{ botId: f.iris.id, name: "Iris", from: "Design", load: "" }] });
  expect(identities()).toEqual([]);
  const path = `/api/bots/${f.iris.id}/work-threads`;
  expect((await f.call("POST", path, { teamName: "Design" })).status).toBe(404);
  expect((await f.call("POST", path, { teamName: "Nowhere" })).status).toBe(404);
  expect((await f.call("POST", path, { teamName: "Sales", teamId: "x" })).status).toBe(400);
  const opened = await f.call("POST", path, { teamName: "Sales" }, false, true);
  expect(opened.status).toBe(200);
  expect(identities()).toEqual(["Sales"]);
  const task = f.store.bot(f.iris.id)!.tasks!.find(t => t.threadId === (opened.body as any).threadId)!;
  expect(task.sharedWork).toMatchObject({ teamId: teamIdFor("Sales") });
  // SPEC-X 13.2: the thread is "{name} · work for {team}"
  expect(task.title).toBe("Iris · work for Sales");
  expect(((await f.call("POST", path, { teamName: "Sales" })).body as any).threadId).toBe(task.threadId);
});

it("R4 a work thread's title follows a rename of the bot, and a title the owner changed stays", async () => {
  const f = fixture(); const sales = teamIdFor("Sales"), support = teamIdFor("Support");
  await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "list", teamIds: [sales, support] });
  const first = f.store.createSharedWorkTask(f.iris.id, sales)!, second = f.store.createSharedWorkTask(f.iris.id, support)!;
  f.store.bot(f.iris.id)!.tasks!.find(t => t.threadId === second.threadId)!.title = "Support desk";
  f.store.patchBot(f.iris.id, { name: "Ivy" });
  const tasks = f.store.bot(f.iris.id)!.tasks!;
  expect(tasks.find(t => t.threadId === first.threadId)!.title).toBe("Ivy · work for Sales");
  expect(tasks.find(t => t.threadId === second.threadId)!.title).toBe("Support desk");
});

it("R4 load: a turn the owner started in a work thread counts as running, so removing that team offers Let it finish", async () => {
  const f = fixture(); const sales = teamIdFor("Sales");
  await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "all" });
  const work = f.store.createSharedWorkTask(f.iris.id, sales)!;
  const generationFor = (threadId: string) => threadId === work.threadId ? "owner-generation" : undefined;
  const view = (await sharingRoute({ method: "GET", path: `/api/bots/${f.iris.id}/sharing`, desktop: true, visible: () => true, readBody: async () => undefined, deps: { store: f.store, generationFor } }))!.body as any;
  expect(view.load).toEqual([{ teamId: sales, name: "Sales", running: 1, queued: 0, waitingOnYou: 0 }]);
  expect(view.loadLine).toBe("Iris, shared from Design: working for Sales, 0 waiting");
  expect(teamSharing(f.store, "Sales", generationFor).sharedIn[0].load).toBe("Iris, shared from Design: working for Sales, 0 waiting");
  // no turn: nothing on
  expect(((await f.call("GET", `/api/bots/${f.iris.id}/sharing`)).body as any).load[0].running).toBe(0);
});

it("R4 PATCH refuses to share an archived bot; turning sharing off still works", async () => {
  const f = fixture();
  f.store.patchBot(f.iris.id, { hidden: true });
  const refused = await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "all" });
  expect(refused.status).toBe(400);
  expect((refused.body as any).error).toContain("Iris is archived");
  expect(f.store.bot(f.iris.id)!.sharedWith).toBeUndefined();
  expect((await f.call("PATCH", `/api/bots/${f.iris.id}/sharing`, { mode: "none" })).status).toBe(200);
});
