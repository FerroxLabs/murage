// SPDX-License-Identifier: AGPL-3.0-or-later
// Real isolated Murage HTTP server with fake engine. No browser is launched.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, afterAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { sharedRegistrationBrowsers } from "../scripts/browser-extension-host-registration.mjs";
let fixture: VerificationServer;
let headers: Record<string, string> = {};
let model: string;
let runtimeRoot: string;
let resourcesRoot: string;
/** The staged helper resources the server reads per request (build.json). */
function stageBuild(build: unknown) { writeFileSync(join(resourcesRoot, "browser-extension", "build.json"), JSON.stringify(build)); }
async function api(method: string, path: string, body?: unknown, owner = true) {
  const res = await fetch(fixture.info.url + path, { method, headers: { ...(owner ? headers : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
async function bot(name: string) {
  const value = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } });
  expect(value.status).toBe(201); return value.body.bot;
}
beforeAll(async () => {
  const root = resolve(".test-tmp"); mkdirSync(root, { recursive: true });
  // A short real runtime root keeps the broker socket inside Unix socket bounds.
  runtimeRoot = mkdtempSync(join(process.platform === "win32" ? tmpdir() : realpathSync("/tmp"), "mbe-api-"));
  resourcesRoot = mkdtempSync(join(root, "resources-")); mkdirSync(join(resourcesRoot, "browser-extension"));
  stageBuild({ version: 1, mode: "development", developmentId: "b".repeat(32) });
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `process.env.MURAGE_BROWSER_EXTENSION_RUNTIME_ROOT=${JSON.stringify(runtimeRoot)};process.env.MURAGE_BROWSER_EXTENSION_RESOURCES_PATH=${JSON.stringify(resourcesRoot)};
const {registerHooks}=await import('node:module');registerHooks({load(url,context,next){if(url.endsWith('/browser-extension-registration.mjs'))return {format:'module',shortCircuit:true,source:"export async function connectOwnerBrowser(input){if(!input.ownerConfirmed)throw Error('consent');return {status:'installed',connected:false}};export async function removeOwnerBrowser(){return {status:'removed'}}"};return next(url,context)}});` });
  const secret = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret.body.secret };
  model = (await api("GET", "/api/instances")).body.instances.find((item: any) => item.instanceId === "verification").models.options[0].id;
}, 60000);
afterAll(async () => { await fixture?.close(); if (runtimeRoot) rmSync(runtimeRoot, { recursive: true, force: true }); if (resourcesRoot) rmSync(resourcesRoot, { recursive: true, force: true }); });
it("requires owner authority and does not claim installation or connection", async () => {
  const one = await bot("Extension setup fixture");
  // No proof of who is asking: the route gate answers 404 before the handler (route-policy.ts).
  expect((await api("GET", `/api/bots/${one.id}/browser-extension`, undefined, false)).status).toBe(404);
  const status = await api("GET", `/api/bots/${one.id}/browser-extension`);
  expect(status.status).toBe(200); expect(status.body.profiles).toEqual([]); expect(status.body.helper.running).toBe(false); expect(status.body.storeUrl).toBeNull();
});
it("allows two explicit extension assignments while retaining legacy single-bot rule", async () => {
  const first = await bot("Extension one"), second = await bot("Extension two");
  for (const one of [first, second]) expect((await api("PATCH", `/api/bots/${one.id}`, { useMyChrome: true, browserTransport: "extension", browserExtensionProfileId: "fixture-profile" })).status).toBe(200);
  const legacy = await bot("Legacy one"), other = await bot("Legacy two");
  expect((await api("PATCH", `/api/bots/${legacy.id}`, { useMyChrome: true })).status).toBe(200);
  expect((await api("PATCH", `/api/bots/${other.id}`, { useMyChrome: true })).status).toBe(409);
  expect((await api("PATCH", `/api/bots/${second.id}`, { useMyChrome: false, browserTransport: null, browserExtensionProfileId: null })).status).toBe(200);
});
it("rejects malformed transport configuration and unowned binding control", async () => {
  const one = await bot("Invalid extension fixture");
  expect((await api("PATCH", `/api/bots/${one.id}`, { browserTransport: "automatic-fallback" })).status).toBe(400);
  expect((await api("PATCH", `/api/bots/${one.id}`, { browserTransport: "extension", browserExtensionProfileId: "../foreign" })).status).toBe(400);
  expect((await api("POST", `/api/bots/${one.id}/browser-extension`, { action: "stop", bindingId: "foreign" })).status).toBe(404);
});
it("starts only the isolated helper on consent, without claiming browser connectivity", async () => {
  const one = await bot("Helper fixture");
  const started = await api("POST", `/api/bots/${one.id}/browser-extension`, { action: "connect" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(started.body.helper.running).toBe(true); expect(started.body.profiles).toEqual([]);
  expect(started.body.helper.reason).toContain("not published");
  expect(started.body.extensionBuild).toBe("development");
});

it("a release build says the listing is not available until the feed turns the link on", async () => {
  const one = await bot("Release listing fixture");
  const id = "c".repeat(32);
  stageBuild({ version: 1, mode: "release", productionIds: [id], chromeWebStoreId: id });
  try {
    const status = await api("GET", `/api/bots/${one.id}/browser-extension`);
    expect(status.body).toMatchObject({ extensionBuild: "release", storeUrl: null });
    expect(status.body.helper.reason).toBe("Murage for Chrome is not in the Chrome Web Store yet. You can keep using the bot's own browser.");
    stageBuild({ version: 1, mode: "resources", productionIds: [] });
    expect((await api("GET", `/api/bots/${one.id}/browser-extension`)).body).toMatchObject({ extensionBuild: "none", storeUrl: null });
  } finally { stageBuild({ version: 1, mode: "development", developmentId: "b".repeat(32) }); }
});

it("Remove reports which browsers share the helper registration", async () => {
  const one = await bot("Remove fixture");
  const removed = await api("POST", `/api/bots/${one.id}/browser-extension`, { action: "remove", browser: "brave" });
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  expect(removed.body.removed.status).toBe("removed");
  const expected = process.platform === "darwin" ? ["brave", "chrome"] : process.platform === "win32" ? ["brave", "chromium"] : ["brave"];
  expect(removed.body.helper.shared.brave).toEqual(expected);
});

it("keeps external MCP disabled and rejects clients before pairing", async () => {
  const settings = await api("GET", "/api/browser-extension/clients");
  expect(settings.status).toBe(200); expect(settings.body.enabled).toBe(false); expect(settings.body.clients).toEqual([]);
  expect((await api("GET", "/api/browser-extension/clients", undefined, false)).status).toBe(404);
  expect((await api("POST", "/api/browser-extension/mcp", { method: "tools/list" }, false)).status).toBe(403);
  expect((await api("POST", "/api/browser-extension/clients", { action: "enabled", enabled: true })).body.enabled).toBe(true);
  expect((await api("POST", "/api/browser-extension/clients", { action: "pair", label: "Fixture external", profileId: "missing-profile" })).status).toBe(409);
  expect((await api("POST", "/api/browser-extension/clients", { action: "enabled", enabled: false })).body.enabled).toBe(false);
});
it("cannot switch an extension assignment into a second legacy owner", async () => {
  const one = await bot("Transport switch fixture");
  expect((await api("PATCH", `/api/bots/${one.id}`, { useMyChrome: true, browserTransport: "extension" })).status).toBe(200);
  expect((await api("PATCH", `/api/bots/${one.id}`, { browserTransport: null })).status).toBe(409);
});
it("remembers which browser the owner connected for a bot, and forgets it with the bot's own browser", async () => {
  const one = await bot("Remembered browser fixture");
  const read = async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((item: { id: string }) => item.id === one.id);
  expect((await api("PATCH", `/api/bots/${one.id}`, { useMyChrome: true, browserTransport: "extension" })).status).toBe(200);
  const connected = await api("POST", `/api/bots/${one.id}/browser-extension`, { action: "connect", browser: "brave" });
  expect(connected.status, JSON.stringify(connected.body)).toBe(200);
  expect((await read()).browserExtensionBrowser).toBe("brave");
  // A bot that is not on the extension never picks up a remembered browser.
  const other = await bot("Own browser fixture");
  expect((await api("POST", `/api/bots/${other.id}/browser-extension`, { action: "connect", browser: "edge" })).status).toBe(200);
  expect((await api("GET", "/api/bots?messages=0")).body.bots.find((item: { id: string }) => item.id === other.id).browserExtensionBrowser).toBeUndefined();
  expect((await api("PATCH", `/api/bots/${one.id}`, { useMyChrome: false, browserTransport: null, browserExtensionProfileId: null })).status).toBe(200);
  expect((await read()).browserExtensionBrowser).toBeUndefined();
});
it("review follow-up L8: the remembered browser name is cleared on a profile change and when that browser's helper is removed", async () => {
  const one = await bot("Stale browser name fixture");
  const read = async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((item: { id: string }) => item.id === one.id);
  expect((await api("PATCH", `/api/bots/${one.id}`, { useMyChrome: true, browserTransport: "extension", browserExtensionProfileId: "profile_a" })).status).toBe(200);
  expect((await api("POST", `/api/bots/${one.id}/browser-extension`, { action: "connect", browser: "edge" })).status).toBe(200);
  expect((await read()).browserExtensionBrowser).toBe("edge");
  // Same profile again: nothing changes.
  expect((await api("PATCH", `/api/bots/${one.id}`, { browserExtensionProfileId: "profile_a" })).status).toBe(200);
  expect((await read()).browserExtensionBrowser).toBe("edge");
  expect((await api("PATCH", `/api/bots/${one.id}`, { browserExtensionProfileId: "profile_b" })).status).toBe(200);
  expect((await read()).browserExtensionBrowser).toBeUndefined();
  expect((await api("POST", `/api/bots/${one.id}/browser-extension`, { action: "connect", browser: "brave" })).status).toBe(200);
  expect((await read()).browserExtensionBrowser).toBe("brave");
  // Removing another browser's helper leaves it; removing Brave's clears it (from any bot's panel).
  const other = await bot("Remove from another panel fixture");
  expect((await api("POST", `/api/bots/${other.id}/browser-extension`, { action: "remove", browser: "edge" })).status).toBe(200);
  expect((await read()).browserExtensionBrowser).toBe(sharedRegistrationBrowsers("edge").includes("brave") ? undefined : "brave");
  expect((await api("POST", `/api/bots/${other.id}/browser-extension`, { action: "remove", browser: "brave" })).status).toBe(200);
  expect((await read()).browserExtensionBrowser).toBeUndefined();
});

