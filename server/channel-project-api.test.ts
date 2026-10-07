// The project block and the archive flag through the real HTTP routes, on a
// real server with its own data directory. Nothing here touches the owner's
// workspace: launchVerificationServer gives the child its own MURAGE_DATA_DIR
// and its own free port.
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string> = {};

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then((r) => r.json() as any);
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60000);

afterAll(async () => {
  await fixture?.close();
});

const newBot = async (name: string) => (await api("POST", "/api/bots", { name })).body.bot;

it("creates a channel that is a project from the start, and reserves lifecycle changes for Close and Reopen", async () => {
  const bot = await newBot("Catalogue lead");
  const created = await api("POST", "/api/groups", {
    name: "Winter catalogue",
    memberIds: [bot.id],
    setup: { bulletin: "Ship it before the shops order.", defaultResponder: { kind: "everyone" } },
    channelProject: { goal: "Get the winter range into the shops by October." },
  });
  expect(created.status).toBe(201);
  const id = created.body.group.id;
  expect(created.body.group.channelProject).toMatchObject({
    goal: "Get the winter range into the shops by October.",
    status: "active",
  });
  expect(created.body.group.bulletin).toBe("Ship it before the shops order.");
  const startedAt = created.body.group.channelProject.startedAt;
  expect(startedAt).toBeGreaterThan(0);

  for (const status of ["paused", "done", "active", "shipped"]) {
    expect(await api("PATCH", `/api/groups/${id}`, { channelProject: { status } })).toMatchObject({ status: 409, body: { error: "not_allowed", reason: "Use the brief and goal controls to update this project. Use Close or Reopen to change its status." } });
  }
  for (const goal of ["Ship the winter range.", "", "x".repeat(2001)]) {
    expect(await api("PATCH", `/api/groups/${id}`, { channelProject: { goal } })).toMatchObject({ status: 409, body: { error: "not_allowed", reason: "Use the brief and goal controls to update this project. Use Close or Reopen to change its status." } });
  }
  const retained = (await api("GET", "/api/bots")).body.groups.find((group: any) => group.id === id);
  expect(retained.channelProject).toMatchObject({ goal: created.body.group.channelProject.goal, status: "active", startedAt });
  expect(await api("POST", "/api/groups", { name: "No goal", memberIds: [bot.id], channelProject: {} })).toMatchObject({ status: 400 });

  // Clearing it leaves the channel, its chat, its bots and its instructions
  // exactly where they were.
  const cleared = await api("PATCH", `/api/groups/${id}`, { channelProject: null });
  expect(cleared.status).toBe(200);
  expect(cleared.body.group.channelProject).toBeUndefined();
  expect(cleared.body.group.memberIds).toEqual([bot.id]);
  expect(cleared.body.group.bulletin).toBe("Ship it before the shops order.");
}, 60000);

it("archives a channel without losing anything, and gives it back", async () => {
  const bot = await newBot("Archivist");
  const created = await api("POST", "/api/groups", { name: "Last winter", memberIds: [bot.id] });
  const group = created.body.group;
  expect(group.hidden).toBeUndefined();

  // Transcript retention across an archive is proved at the store level in
  // channel-archive.test.ts. Sending a real message here would dispatch a
  // provider turn, and a room that is working refuses to be archived, which
  // is a different test.
  const archived = await api("PATCH", `/api/groups/${group.id}`, { hidden: true });
  expect(archived.status).toBe(200);
  expect(archived.body.group.hidden).toBe(true);
  expect(archived.body.group.memberIds).toEqual([bot.id]);

  // Still there, still whole: archiving is not delete.
  const hydrated = (await api("GET", "/api/bots")).body.groups.find((g: any) => g.id === group.id);
  expect(hydrated.hidden).toBe(true);
  expect(hydrated.memberIds).toEqual([bot.id]);

  const restored = await api("PATCH", `/api/groups/${group.id}`, { hidden: false });
  expect(restored.body.group.hidden).toBeUndefined();
  expect(await api("PATCH", `/api/groups/${group.id}`, { hidden: "yes" })).toMatchObject({ status: 400 });
}, 60000);

it("leaves a channel that is neither archived nor a project completely unchanged", async () => {
  const bot = await newBot("Ordinary");
  const created = await api("POST", "/api/groups", { name: "Kitchen table", memberIds: [bot.id] });
  const id = created.body.group.id;
  expect(created.body.group).not.toHaveProperty("channelProject");
  expect(created.body.group).not.toHaveProperty("hidden");

  const renamed = await api("PATCH", `/api/groups/${id}`, { name: "Kitchen table talk", bulletin: "Keep it short." });
  expect(renamed.status).toBe(200);
  expect(renamed.body.group.name).toBe("Kitchen table talk");
  expect(renamed.body.group).not.toHaveProperty("channelProject");
  expect(renamed.body.group).not.toHaveProperty("hidden");

  const hydrated = (await api("GET", "/api/bots")).body.groups.find((g: any) => g.id === id);
  expect(hydrated).not.toHaveProperty("channelProject");
  expect(hydrated).not.toHaveProperty("hidden");
}, 60000);

it("serves project records and preserves brief history through End and Make project", async () => {
  const bot = await newBot("Project records");
  const created = await api("POST", "/api/groups", { name: "Records", memberIds: [bot.id], channelProject: { goal: "Ship" } });
  const id = created.body.group.id;
  expect(await api("GET", `/api/groups/${id}/project`)).toMatchObject({ status: 200, body: { lifecycle: "open", settings: { parallelCards: 3 } } });
  expect(await api("PATCH", `/api/groups/${id}`, { bulletin: "Revised rules" })).toMatchObject({ status: 200 });
  expect(await api("GET", `/api/groups/${id}/project`)).toMatchObject({ body: { brief: { rules: "Revised rules", version: 2 } } });
  expect(await api("PATCH", `/api/groups/${id}`, { channelProject: null })).toMatchObject({ body: { group: { bulletin: "Revised rules" } } });
  expect(await api("GET", `/api/groups/${id}/project`)).toMatchObject({ body: { lifecycle: "ended" } });
  expect(await api("POST", `/api/groups/${id}/project/goals`, { title: "No" })).toMatchObject({ status: 409 });
  expect(await api("PATCH", `/api/groups/${id}`, { channelProject: { goal: "Again" } })).toMatchObject({ status: 200 });
  expect(await api("GET", `/api/groups/${id}/project`)).toMatchObject({ body: { lifecycle: "open", brief: { rules: "Revised rules", version: 3 } } });
}, 60000);

it("refuses authority fields on the conversation-class creation route", async () => {
  const bot = await newBot("Defaults only");
  for (const body of [{ messageAllow: { mode: "all" } }, { parallelCards: 5 }, { channelProject: { goal: "Work", workRoots: ["/tmp"] } }, { setup: { bulletin: "", defaultResponder: { kind: "everyone" }, runState: "running" } }]) {
    const response = await fetch(`${fixture.info.url}/api/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberIds: [bot.id], ...body }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Set this up in the Murage app on your computer." });
  }
});
