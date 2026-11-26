// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PARITYFIX S2 and the E1 engine inventory through the real preload surfaces and the real IPC registration:
//   S2  the Cloud window's openEngineSignIn(engine) -> main (home from the sender) -> the local window's Connect row.
//   E1  cloud-home:list-engines reads the home's /api/instances `cloud` field (S1, owner L2) for the local Connect panel.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import * as cloudHomeIpc from "./cloud-home-ipc.mjs";

const { registerCloudHomeIpc } = cloudHomeIpc;
const cloudEngineInventory = (body) => cloudHomeIpc.cloudEngineInventory?.(body);
import { channelClass, CLASS_CLOUD_ONLY, CLASS_LOCAL_ONLY } from "./ipc-channel-classes.mjs";

function preload(file, { surface, invoke = vi.fn(async () => ({ requested: true })) } = {}) {
  const listeners = new Map(); let exposed;
  const cloudPage = file === "preload-cloud.cjs";
  const ipcRenderer = { invoke, send: vi.fn(), sendSync: () => "fixture", on: (channel, cb) => listeners.set(channel, cb), removeListener: (channel, cb) => { if (listeners.get(channel) === cb) listeners.delete(channel); } };
  const argv = cloudPage ? ["--murage-cloud-home=home-1", ...(surface ? [`--murage-cloud-surface=${surface}`] : [])] : ["--murage-renderer-origin=http://127.0.0.1:1234", "--murage-cloud=1"];
  const location = cloudPage ? { protocol: "murage-home:", hostname: "home-1", search: surface ? `?surface=${surface}` : "" } : { origin: "http://127.0.0.1:1234", search: "" };
  vm.runInNewContext(readFileSync(new URL(file, import.meta.url), "utf8"), { require: () => ({ contextBridge: { exposeInMainWorld: (_name, bridge) => { exposed = bridge; } }, ipcRenderer }), process: { argv, platform: "linux", arch: "x64" }, location, URL, URLSearchParams, Buffer, setTimeout, clearTimeout, console });
  return { bridge: exposed, invoke, listeners };
}

function main({ homeId = "home-1", show, fetch = async () => new Response("{}", { status: 200 }) } = {}) {
  const handlers = new Map(), showSignIn = vi.fn(show ?? (async () => true)), fetched = [];
  const client = { fetch: async (id, path) => { fetched.push([id, path]); return fetch(id, path); } };
  registerCloudHomeIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { cloudHome: { client, senderHomeId: () => homeId }, getCpToken: () => "fixture", active: () => true, showSignIn });
  return { showSignIn, fetched, handlers, invoke: async (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args) };
}

/** main.mjs's own showSignIn body, run against a fake local window that feeds the real local preload. */
function mainShowSignIn(local) {
  const body = readFileSync(new URL("main.mjs", import.meta.url), "utf8").match(/showSignIn: request => \{([\s\S]*?)\n  \},\n  cpEnvironment:/)?.[1];
  const win = { isDestroyed: () => false, webContents: { isLoadingMainFrame: () => false, send: (channel, request) => local.listeners.get(channel)({}, request) } };
  return new Function("mainWindow", "appReadiness", "activateExistingWindow", `return request => {${body}};`)(win, { ready: () => true }, () => {});
}

describe("S2 openEngineSignIn", () => {
  it("the Cloud window's bridge has openEngineSignIn", () => {
    expect(typeof preload("preload-cloud.cjs").bridge.openEngineSignIn).toBe("function");
  });

  it("an engine name from the Cloud window reaches main with the sender's home and no bot", async () => {
    const m = main(), cloud = preload("preload-cloud.cjs", { invoke: m.invoke });
    const answer = await cloud.bridge.openEngineSignIn?.("claudeAgent");
    expect([answer, m.showSignIn.mock.calls]).toEqual([{ requested: true }, [[{ homeId: "home-1", engine: "claudeAgent" }]]]);
  });

  it("the local window's Connect panel receives the engine's sign-in with no bot", async () => {
    const local = preload("preload.cjs");
    const m = main({ show: mainShowSignIn(local) }), cloud = preload("preload-cloud.cjs", { invoke: m.invoke });
    const received = [];
    local.bridge.cloudHome.onSignInRequested((request) => received.push(request));
    await cloud.bridge.openEngineSignIn?.("codex");
    expect(received).toEqual([{ homeId: "home-1", engine: "codex" }]);
  });

  it("refuses anything but one known engine name, before opening anything", async () => {
    const m = main();
    const outcomes = [];
    for (const args of [[], ["anything"], ["antigravityAgent"], [{ engine: "codex" }], ["codex", "extra"], [null]]) {
      outcomes.push(await m.invoke("cloud-home:open-engine-sign-in", ...args).then(() => "accepted", (error) => error.message));
    }
    expect([outcomes, m.showSignIn.mock.calls.length]).toEqual([Array(6).fill("Invalid request."), 0]);
  });

  it("never reports success when the local window cannot show it", async () => {
    const m = main({ show: async () => false });
    await expect(m.invoke("cloud-home:open-engine-sign-in", "claudeAgent")).rejects.toThrow(/^Open Murage on this computer, then try signing in again\.$/);
  });

  it("is cloud-only, and a browser pop-out never gets it", () => {
    expect([channelClass("cloud-home:open-engine-sign-in"), preload("preload-cloud.cjs", { surface: "browser-popout" }).bridge.openEngineSignIn]).toEqual([CLASS_CLOUD_ONLY, undefined]);
  });
});

describe("E1 the home's engine inventory (S1)", () => {
  const instances = { instances: [
    { instanceId: "claude", driverKind: "claudeAgent", cloud: { installed: true, signedIn: false } },
    { instanceId: "codex", driverKind: "codex", cloud: { installed: false, signedIn: false } },
    { instanceId: "kimi", driverKind: "kimiAgent", cloud: { installed: true, signedIn: true } },
  ] };

  it("the local window lists a home's engines from its /api/instances", async () => {
    const m = main({ fetch: async () => new Response(JSON.stringify(instances), { status: 200 }) });
    const engines = await m.invoke("cloud-home:list-engines", "home-1").catch((error) => error.message);
    expect([m.fetched, Array.isArray(engines) ? engines.filter((entry) => entry.installed) : engines]).toEqual([[["home-1", "/api/instances"]],
      [{ engine: "claudeAgent", installed: true, signedIn: false }, { engine: "kimiAgent", installed: true, signedIn: true }]]);
  });

  it("an engine the home has not installed is never reported signed in", () => {
    const engines = cloudEngineInventory({ instances: [{ driverKind: "codex", cloud: { installed: false, signedIn: true } }] });
    expect(engines?.find((entry) => entry.engine === "codex")).toEqual({ engine: "codex", installed: false, signedIn: false });
  });

  it("a home that does not say (no cloud field) is null, so the panel offers every sign-in as before", () => {
    expect(cloudEngineInventory({ instances: [{ driverKind: "claudeAgent" }] })).toBeNull();
  });

  it("is local-only and in the local preload", () => {
    expect([channelClass("cloud-home:list-engines"), typeof preload("preload.cjs").bridge.cloudHome.listEngines]).toEqual([CLASS_LOCAL_ONLY, "function"]);
  });
});
