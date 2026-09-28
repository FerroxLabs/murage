// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ferrox Labs
import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

// Every saved key whose provider can make images is offered in Settings →
// Image generation, whichever door it came in by. Keys are fake. The fixture
// records and refuses every outbound https request, so each listing below
// also proves it called no image endpoint.
const bank = JSON.stringify([
  { id: "c-openai", preset: "openai", label: "Boot OpenAI", enabled: true, key: "sk-proj-FAKE_IMG_OPENAI", revision: "r1" },
  { id: "c-xai", preset: "xai", label: "Boot xAI", enabled: true, key: "xai-FAKE_IMG_XAI_0000", revision: "r2" },
  { id: "c-openrouter", preset: "openrouter", label: "Boot OpenRouter", enabled: true, key: "sk-or-v1-FAKE_IMG_OR", revision: "r3" },
  { id: "c-mistral", preset: "mistral", label: "Boot Mistral", enabled: true, key: "FAKE_IMG_MISTRAL_KEY", revision: "r4" },
  // Saved before labels were checked: the owner pasted the key as its name.
  { id: "c-leaky", preset: "xai", label: "xai-FAKE_IMG_LABEL_KEY_0", enabled: true, key: "xai-FAKE_IMG_LABEL_KEY_0", revision: "r5" },
  // A name holding ANOTHER account's opaque key (c-mistral's).
  { id: "c-other", preset: "openrouter", label: "Team FAKE_IMG_MISTRAL_KEY", enabled: true, key: "sk-or-v1-FAKE_IMG_OTHER_OR", revision: "r7" },
  // Saved before every door checked the issuer: a Google key filed as OpenAI.
  { id: "c-mismatch", preset: "openai", label: "Filed wrong", enabled: true, key: `AIza${"FAKE_IMG_MISFILED_".padEnd(35, "0")}`, revision: "r6" },
]);
const GOOGLE = "AIza" + "FAKE_IMG_GOOGLE_000000000000000000000".slice(0, 35);
let fixture: VerificationServer;
let headers: Record<string, string>;
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
async function images() {
  const settings = await api("GET", "/api/images/settings");
  expect(settings.status).toBe(200);
  expect(JSON.stringify(settings.body)).not.toMatch(/FAKE_IMG|AIzaFAKE/);
  return settings.body.connections as Array<{ id: string; label: string; provider: string }>;
}
// The harness refreshes chat model catalogs in the background on its own
// schedule; only an image endpoint would mean listing reached the network.
const imageRequests = () => { const file = join(fixture.info.dataDir, "network.log"); return (existsSync(file) ? readFileSync(file, "utf8") : "").split("\n").filter(url => /\/images|:generateContent/.test(url)); };
// Image requests since the one test that asks OpenRouter on purpose.
let expected = 0;
const network = () => imageRequests().slice(expected).join("\n");
beforeAll(async () => {
  // The packaged app hands the encrypted bank to the harness as env at spawn.
  // The avatar key restored with it is a Google key, saved before its slot checked.
  const env = { MURAGE_MODEL_PROVIDER_CONNECTIONS: bank, MURAGE_OPENAI_IMAGE_KEY: `AIza${"FAKE_IMG_AVATAR_".padEnd(35, "0")}` } as Record<string, string>;
  fixture = await launchVerificationServer(process.env, undefined, { env, instrumentationSource: `
 process.env.FAKE_CLAUDE_DUMP_EACH_TURN='1';
 import { appendFileSync } from 'node:fs';
 import { join } from 'node:path';
 const originalFetch=globalThis.fetch;
 globalThis.fetch=(input,init)=>{ const url=String(input instanceof Request?input.url:input); if(url.startsWith('https://')){ appendFileSync(join(process.env.MURAGE_DATA_DIR,'network.log'),url+'\\n'); throw new Error('External network blocked in image fixture'); } return originalFetch(input,init); };` });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

it("path 1: keys the packaged app restores from its encrypted store at boot", async () => {
  const listed = await images();
  expect(listed.map(row => [row.id, row.provider, row.label])).toEqual([["model:c-openai", "openai", "Boot OpenAI"], ["model:c-xai", "xai", "Boot xAI"], ["model:c-openrouter", "openrouter", "Boot OpenRouter"], ["model:c-leaky", "xai", "xai"], ["model:c-other", "openrouter", "openrouter"]]);
  // Misfiled keys are listed in Models for review, never enabled, offered or sent.
  const rows = (await api("GET", "/api/provider-connections")).body.connections as Array<{ id: string; enabled: boolean; catalog: { error?: { message: string } } }>;
  for (const id of ["c-mismatch", "legacy-openai-image"]) expect(rows.find(row => row.id === id)).toMatchObject({ enabled: false, catalog: { error: { message: expect.stringContaining("different provider") } } });
  const refused = await api("POST", "/api/provider-connections/c-mismatch/refresh", {});
  expect(refused.status).toBe(409);
  const model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  const bot = (await api("POST", "/api/bots", { name: "Avatar", modelSelection: { instanceId: "verification", model } })).body.bot;
  const avatar = await api("POST", `/api/bots/${bot.id}/avatar/generate`, { prompt: "a fox" });
  // Left out, not sent: with no Flux key here, nothing can draw.
  expect(avatar.status).toBe(409);
  expect(avatar.body.error).toContain("Avatar generation is unavailable");
  expect(imageRequests()).toEqual([]);
  expect(network()).toBe("");
});

it("path 2: Settings → Models and the paste box add named connections, Google included", async () => {
  for (const [preset, key] of [["openai", "sk-proj-FAKE_IMG_MODELS_OPENAI"], ["xai", "xai-FAKE_IMG_MODELS_XAI_00"], ["openrouter", "sk-or-v1-FAKE_IMG_MODELS_OR"], ["google", GOOGLE]]) {
    const created = await api("POST", "/api/provider-connections/mutate", { action: "create", preset, key });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
  }
  const connections = (await api("GET", "/api/provider-connections")).body.connections as Array<{ id: string; preset: string; legacy?: boolean }>;
  const added = connections.filter(row => !row.legacy && !row.id.startsWith("c-"));
  const listed = await images();
  for (const row of added) expect(listed).toContainEqual(expect.objectContaining({ id: `model:${row.id}`, provider: row.preset }));
  expect(listed.find(row => row.provider === "google")?.label).toBe("Google");
  expect(network()).toBe("");
});

it("path 3: the key rows in Tools & Connections, a bot's key request card and the avatar card", async () => {
  // All three write these config sections (CREDENTIAL_PATCH in electron/main.mjs).
  expect((await api("PUT", "/api/config", { xai: { key: "xai-FAKE_IMG_WORKSPACE_000" } })).status).toBe(200);
  expect((await api("PUT", "/api/config", { imageGen: { key: "sk-proj-FAKE_IMG_AVATAR_KEY" } })).status).toBe(200);
  const listed = await images();
  expect(listed).toContainEqual(expect.objectContaining({ id: "xai", provider: "xai" }));
  expect(listed).toContainEqual(expect.objectContaining({ id: "openai", provider: "openai" }));
  expect(network()).toBe("");
});

it("path 4: an existing compatible-engine key shows wherever Models shows it", async () => {
  // Models normalizes the endpoint; Image generation used to demand an exact
  // string and had no branch for xAI, so both of these were missing.
  expect((await api("PUT", "/api/config", { openaiCompat: { key: "sk-or-v1-FAKE_IMG_COMPAT_OR", url: "https://openrouter.ai/api/v1/" } })).status).toBe(200);
  expect(await images()).toContainEqual(expect.objectContaining({ id: "openrouter", provider: "openrouter" }));
  expect((await api("PUT", "/api/config", { openaiCompat: { key: "xai-FAKE_IMG_COMPAT_XAI_00", url: "https://api.x.ai/v1" } })).status).toBe(200);
  const listed = await images();
  expect(listed).toContainEqual(expect.objectContaining({ id: "model:legacy-openai-compatible", provider: "xai" }));
  expect(listed.some(row => row.id === "openrouter")).toBe(false);
  // A Google key saved on another provider's endpoint is held for review, never offered or sent.
  expect((await api("PUT", "/api/config", { openaiCompat: { key: `AIza${"FAKE_IMG_GOOGLE_ON_OPENAI_".padEnd(35, "0")}`, url: "https://api.openai.com/v1" } })).status).toBe(200);
  const rows = (await api("GET", "/api/provider-connections")).body.connections as Array<{ id: string; enabled: boolean; catalog: { error?: { message: string } } }>;
  expect(rows.find(row => row.id === "legacy-openai-compatible")).toMatchObject({ enabled: false });
  expect((await images()).some(row => row.id === "openai-compatible" || row.id === "model:legacy-openai-compatible")).toBe(false);
  expect(network()).toBe("");
});

it("keeps listing every connection when the chosen catalog cannot be read", async () => {
  // OpenRouter's image list lives with OpenRouter, and the fixture is offline.
  const saved = await api("POST", "/api/images/settings", { connectionId: "model:c-openrouter" });
  expect(saved.status).toBe(409);
  expect(saved.body.error).toMatch(/image model/);
  expect((await api("PUT", "/api/config", { imageGen: { connectionId: "model:c-openrouter" } })).status).toBe(200);
  const settings = await api("GET", "/api/images/settings");
  expect(settings.status).toBe(200);
  expect(settings.body.catalog).toBeNull();
  expect(settings.body.catalogError).toMatch(/image model/);
  expect(settings.body.connections.length).toBeGreaterThan(5);
  expect(imageRequests().every(url => url.startsWith("https://openrouter.ai/api/v1/images/models"))).toBe(true);
  expected = imageRequests().length;
  expect((await api("PUT", "/api/config", { imageGen: { connectionId: "" } })).status).toBe(200);
});

it("selects a Google connection and reads its model list locally", async () => {
  const google = (await images()).find(row => row.provider === "google")!;
  const saved = await api("POST", "/api/images/settings", { connectionId: google.id, enabled: true });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.selected).toEqual({ connectionId: google.id, model: "gemini-3.1-flash-image" });
  expect(saved.body.catalog.models.map((model: { id: string }) => model.id)).toEqual(["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image"]);
  expect(network()).toBe("");
});

it("tells a bot the real image connections and which one is in use", async () => {
  const model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  const bot = (await api("POST", "/api/bots", { name: "Petra", modelSelection: { instanceId: "verification", model } })).body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  const tag = "IMAGE_OPTIONS_TURN";
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: `Which image options do I have? ${tag}` })).status).toBeLessThan(300);
  let dump: { systemPrompt?: string | null; prompt?: unknown } | null = null;
  await expect.poll(() => { try { dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { dump = null; } return JSON.stringify(dump?.prompt ?? null).includes(tag); }, { timeout: 20000 }).toBe(true);
  const prompt = String(dump!.systemPrompt);
  const line = prompt.split("\n").find(text => text.startsWith("Image connections set up in this workspace:"));
  expect(line).toBeDefined();
  for (const label of ["Boot OpenAI", "Boot xAI", "Boot OpenRouter", "Google (in use, model gemini-3.1-flash-image)", "xAI"]) expect(line).toContain(label);
  expect(line).not.toContain("Boot Mistral");
  // The label that held a key is named by its provider instead.
  expect(line).not.toContain("xai-FAKE_IMG_LABEL_KEY_0");
  expect(prompt).toContain("create and edit images");
  expect(prompt).not.toMatch(/FAKE_IMG|AIzaFAKE/);
}, 60000);
