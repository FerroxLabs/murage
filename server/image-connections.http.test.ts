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
const network = () => { const file = join(fixture.info.dataDir, "network.log"); return (existsSync(file) ? readFileSync(file, "utf8") : "").split("\n").filter(url => /\/images|:generateContent/.test(url)).join("\n"); };
beforeAll(async () => {
  // The packaged app hands the encrypted bank to the harness as env at spawn.
  const env = { MURAGE_MODEL_PROVIDER_CONNECTIONS: bank } as Record<string, string>;
  fixture = await launchVerificationServer(process.env, undefined, { env, instrumentationSource: `
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
  expect(listed.map(row => [row.id, row.provider, row.label])).toEqual([["model:c-openai", "openai", "Boot OpenAI"], ["model:c-xai", "xai", "Boot xAI"], ["model:c-openrouter", "openrouter", "Boot OpenRouter"]]);
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
  expect(network()).toBe("");
});

it("selects a Google connection and reads its model list locally", async () => {
  const google = (await images()).find(row => row.provider === "google")!;
  const saved = await api("POST", "/api/images/settings", { connectionId: google.id, enabled: true });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.selected).toEqual({ connectionId: google.id, model: "gemini-3.1-flash-image" });
  expect(saved.body.catalog.models.map((model: { id: string }) => model.id)).toEqual(["gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image"]);
  expect(network()).toBe("");
});
