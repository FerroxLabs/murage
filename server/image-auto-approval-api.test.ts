// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Images made without an approval card, on a real server with a fake engine
// that asks for one image through Murage's own generate_image tool (the same
// tool every engine reaches): the level, the per-bot Images setting, the
// owner-audience guard, and the setting's persistence over HTTP.
//
// HEADLESS ONLY: throwaway data directory and port (launchVerificationServer),
// a fake engine, and every outbound https request is refused and logged.
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const PROMPT = "A red cube on a white table";
const bank = JSON.stringify([{ id: "c-openai", preset: "openai", label: "Fixture OpenAI", enabled: true, key: "sk-proj-FAKE_IMAGE_AUTO", revision: "r1" }]);
let fixture: VerificationServer, headers: Record<string, string>;
const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = headers) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...extra, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const api = (method: string, path: string, body?: unknown) => call(method, path, body);
const imageRequests = () => { const file = join(fixture.info.dataDir, "network.log"); return (existsSync(file) ? readFileSync(file, "utf8") : "").split("\n").filter(url => /\/images/.test(url)); };

beforeAll(async () => {
  chmodSync(FAKE_ACP, 0o755);
  fixture = await launchVerificationServer(process.env, undefined, { env: { MURAGE_MODEL_PROVIDER_CONNECTIONS: bank } as Record<string, string>, instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=>{ const url=String(input instanceof Request?input.url:input); if(url.startsWith('https://')){ fs.appendFileSync(path.join(process.env.MURAGE_DATA_DIR,'network.log'),url+'\\n'); return Promise.reject(new Error('External network is refused in this fixture')); } return originalFetch(input,init); };
    const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.imager={driver:'grokAgent',displayName:'Image fixture',environment:{FAKE_ACP_MODE:'project-image',FAKE_ACP_MCP_TIMEOUT_MS:'4000'},config:{cli:${JSON.stringify(FAKE_ACP)},fullAuto:true}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60000);
afterAll(async () => { await fixture?.close(); });

async function makeBot(name: string, patch: Record<string, unknown> = {}) {
  const instance = (await api("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === "imager");
  const made = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "imager", model: instance.models.options[0]?.id || instance.models.default || "fixture-model" } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const bot = made.body.bot;
  const set = await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false, ...patch });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  return bot as { id: string; threadId: string };
}
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages as any[];
const card = async (threadId: string) => (await messages(threadId)).find(message => message.card?.tool === "generate_image");
const record = async (threadId: string) => (await messages(threadId)).find(message => message.tool?.imageRecord);
const ask = (bot: { id: string; threadId: string }, extra?: Record<string, string>) => call("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "draw it" }, extra ?? headers);
async function closeCard(bot: { id: string; threadId: string }) {
  const open = await card(bot.threadId);
  await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: open.card.requestId, behavior: "deny" });
  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
}
const FULL = { fullAccess: true, acknowledgeFullAccess: true };
const runThreadOf = async (runId: string) => {
  const deadline = Date.now() + 20000;
  for (;;) {
    const run = ((await api("GET", "/api/routines")).body.runs ?? []).find((r: any) => r.id === runId);
    if (run?.threadId) return run.threadId as string;
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, 250));
  }
};
async function routineRun(botId: string, extra: Record<string, unknown> = {}) {
  const created = await api("POST", "/api/routines", { name: "Social batch " + Math.random().toString(36).slice(2, 7), prompt: "draw it", botId, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, timeoutMinutes: 20, ...extra });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const threadId = await runThreadOf(started.body.run.id);
  expect(threadId).toBeTruthy();
  return threadId!;
}
const outcome = async (threadId: string) => {
  const deadline = Date.now() + 30000;
  for (;;) {
    const list = await messages(threadId);
    const c = list.find(m => m.card?.tool === "generate_image");
    const r = list.find(m => m.tool?.imageRecord);
    if (c) return { kind: "card", name: c.card.title };
    if (r) return { kind: "record", name: r.tool.name };
    if (Date.now() > deadline) return { kind: "none", name: JSON.stringify(list.map(m => m.text ?? m.tool?.name)).slice(0, 600) };
    await new Promise(res => setTimeout(res, 250));
  }
};


describe("images made without asking, on a real server", () => {
  it("keeps the card on Ask, and the record never appears", async () => {
    const bot = await makeBot("Ask level");
    expect((await ask(bot)).status).toBe(202);
    await expect.poll(async () => (await card(bot.threadId))?.card?.requestId, { timeout: 30000 }).toMatch(/^image-/);
    expect(await record(bot.threadId)).toBeUndefined();
    await closeCard(bot);
  }, 60000);

  it("makes the image with no card on Full access, and leaves a record with the whole prompt", async () => {
    const before = imageRequests().length;
    const bot = await makeBot("Full level", FULL);
    expect((await ask(bot)).status).toBe(202);
    await expect.poll(async () => (await record(bot.threadId))?.tool?.imageRecord?.prompt, { timeout: 30000 }).toContain(PROMPT);
    expect((await record(bot.threadId)).tool.name).toBe("Making an image without asking (Full access)");
    expect(await card(bot.threadId)).toBeUndefined();
    await expect.poll(() => imageRequests().length, { timeout: 30000 }).toBeGreaterThan(before);
  }, 60000);

  it("makes the image with no card on No limits", async () => {
    const bot = await makeBot("No limits level", { noLimits: true, acknowledgeNoLimits: true });
    expect((await ask(bot)).status).toBe(202);
    await expect.poll(async () => (await record(bot.threadId))?.tool?.name, { timeout: 30000 }).toBe("Making an image without asking (No limits)");
    expect(await card(bot.threadId)).toBeUndefined();
  }, 60000);

  it("Auto still asks", async () => {
    const bot = await makeBot("Auto level", { autoApprove: true });
    expect((await ask(bot)).status).toBe(202);
    await expect.poll(async () => (await card(bot.threadId))?.card?.requestId, { timeout: 30000 }).toMatch(/^image-/);
    await closeCard(bot);
  }, 60000);

  it("Make images without asking overrides Ask, with its own basis in the record", async () => {
    const bot = await makeBot("Override allow", { imageApproval: "allow" });
    expect((await ask(bot)).status).toBe(202);
    await expect.poll(async () => (await record(bot.threadId))?.tool?.name, { timeout: 30000 }).toBe("Making an image without asking (the Images setting)");
    expect(await card(bot.threadId)).toBeUndefined();
  }, 60000);

  it("Ask before each image overrides Full access", async () => {
    const bot = await makeBot("Override ask", { ...FULL, imageApproval: "ask" });
    expect((await ask(bot)).status).toBe(202);
    await expect.poll(async () => (await card(bot.threadId))?.card?.requestId, { timeout: 30000 }).toMatch(/^image-/);
    expect(await record(bot.threadId)).toBeUndefined();
    await closeCard(bot);
  }, 60000);

  it("words nobody proved are the owner's still get the card, even on Full access with the override on", async () => {
    const bot = await makeBot("Unproven words", { ...FULL, imageApproval: "allow" });
    const sent = await ask(bot, {});
    expect([200, 202], JSON.stringify(sent.body)).toContain(sent.status);
    await expect.poll(async () => (await card(bot.threadId))?.card?.requestId, { timeout: 30000 }).toMatch(/^image-/);
    expect(await record(bot.threadId)).toBeUndefined();
    await closeCard(bot);
  }, 60000);
});

describe("the Images setting over HTTP", () => {
  it("is set from the desktop only, validated, kept, and cleared by follow", async () => {
    const bot = await makeBot("Setting holder");
    const state = async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: any) => entry.id === bot.id);
    expect(await state()).not.toHaveProperty("imageApproval");
    expect((await call("PATCH", `/api/bots/${bot.id}`, { imageApproval: "allow" }, {})).status).toBe(404);
    expect((await call("PATCH", `/api/bots/${bot.id}`, { imageAskAfter: 3 }, {})).status).toBe(404);
    for (const bad of ["always", "", 1, true, null]) expect((await api("PATCH", `/api/bots/${bot.id}`, { imageApproval: bad })).status, String(bad)).toBe(400);
    for (const bad of [0, 51, 1.5, "3", true]) expect((await api("PATCH", `/api/bots/${bot.id}`, { imageAskAfter: bad })).status, String(bad)).toBe(400);
    expect(await state()).not.toHaveProperty("imageApproval");

    const set = await api("PATCH", `/api/bots/${bot.id}`, { imageApproval: "allow", imageAskAfter: 3 });
    expect(set.status).toBe(200);
    expect(set.body.bot).toMatchObject({ imageApproval: "allow", imageAskAfter: 3 });
    expect(await state()).toMatchObject({ imageApproval: "allow", imageAskAfter: 3 });
    expect((await api("PATCH", `/api/bots/${bot.id}`, { imageApproval: "ask" })).body.bot.imageApproval).toBe("ask");
    const cleared = await api("PATCH", `/api/bots/${bot.id}`, { imageApproval: "follow", imageAskAfter: null });
    expect(cleared.status).toBe(200);
    expect(await state()).not.toHaveProperty("imageApproval");
    expect(await state()).not.toHaveProperty("imageAskAfter");
  }, 60000);
});

// The owner's routines are not unattended: they run at their own level, and the
// Images setting reaches them like the owner's own turn. A webhook never does.
// (Pinned so a later change to isUnattended or routineRunLevel cannot start
// carding Sean's batch routines, or stop carding a webhook routine.)
describe("routines and webhooks", () => {
  it("an owner routine at Full access makes the image with no card and leaves a record", async () => {
    const bot = await makeBot("Routine full", FULL);
    expect(await outcome(await routineRun(bot.id))).toEqual({ kind: "record", name: "Making an image without asking (Full access)" });
  }, 90000);
  it("an Ask routine on a bot set to make images without asking skips the card", async () => {
    const bot = await makeBot("Routine allow", { imageApproval: "allow" });
    expect(await outcome(await routineRun(bot.id))).toEqual({ kind: "record", name: "Making an image without asking (the Images setting)" });
  }, 90000);
  it("an Ask routine that follows the level shows the card", async () => {
    const bot = await makeBot("Routine ask");
    expect((await outcome(await routineRun(bot.id))).kind).toBe("card");
  }, 90000);
  it("a routine set to Ask shows the card even on a Full access bot", async () => {
    const bot = await makeBot("Routine ask on full", FULL);
    expect((await outcome(await routineRun(bot.id, { permissionMode: "ask" }))).kind).toBe("card");
  }, 90000);
  it("a webhook run shows the card even on a Full access bot set to make images without asking", async () => {
    const bot = await makeBot("Webhook", { ...FULL, imageApproval: "allow" });
    const hook = await api("POST", "/api/webhooks", { name: "Inbound", prompt: "draw it", botId: bot.id, runOn: "ember" });
    expect(hook.status, JSON.stringify(hook.body)).toBe(201);
    const delivered = await fetch(hook.body.credential.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "ping" }) });
    expect(delivered.status).toBe(202);
    const threadId = await runThreadOf(((await delivered.json()) as { runId: string }).runId);
    expect(threadId).toBeTruthy();
    expect((await outcome(threadId!)).kind).toBe("card");
  }, 90000);
});
