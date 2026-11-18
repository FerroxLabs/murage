// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { registerCloudHomeIpc } from "./cloud-home-ipc.mjs";
import { channelClass, CLASS_CLOUD_ONLY, CLASS_LOCAL_ONLY } from "./ipc-channel-classes.mjs";

function preload(file, { cloud = true, surface, origin = true, invoke = vi.fn(async () => ({ requested: true })) } = {}) {
  const listeners = new Map(); let exposed;
  const cloudPage = file === "preload-cloud.cjs";
  const ipcRenderer = { invoke, send: vi.fn(), sendSync: () => "fixture", on: (channel, cb) => listeners.set(channel, cb), removeListener: (channel, cb) => { if (listeners.get(channel) === cb) listeners.delete(channel); } };
  const argv = cloudPage ? ["--murage-cloud-home=home-1", ...(surface ? [`--murage-cloud-surface=${surface}`] : [])] : ["--murage-renderer-origin=http://127.0.0.1:1234", ...(cloud ? ["--murage-cloud=1"] : [])];
  const location = cloudPage ? { protocol: "murage-home:", hostname: origin ? "home-1" : "other-home", search: surface ? `?surface=${surface}` : "" } : { origin: origin ? "http://127.0.0.1:1234" : "https://other.example", search: "" };
  vm.runInNewContext(readFileSync(new URL(file, import.meta.url), "utf8"), { require: () => ({ contextBridge: { exposeInMainWorld: (_name, bridge) => { exposed = bridge; } }, ipcRenderer }), process: { argv, platform: "linux", arch: "x64" }, location, URL, URLSearchParams, Buffer, setTimeout, clearTimeout, console });
  return { bridge: exposed, invoke, listeners };
}

function main({ homeId = "home-1", active = true, shown = true, show } = {}) {
  const handlers = new Map(), showSignIn = vi.fn(show ?? (async () => shown));
  registerCloudHomeIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { cloudHome: { client: {}, senderHomeId: () => homeId }, getCpToken: () => "fixture", active: () => active, showSignIn });
  return { showSignIn, invoke: async (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args) };
}

describe("Cloud sign-in through the real preload surfaces", () => {
  it("hands this bot and engine to the existing local Connect sign-in, deriving the home in main", async () => {
    const local = preload("preload.cjs");
    const mainSource = readFileSync(new URL("main.mjs", import.meta.url), "utf8");
    const body = mainSource.match(/showSignIn: request => \{([\s\S]*?)\n  \},\n  cpEnvironment:/)?.[1];
    expect(body, "main installs the Connect sign-in handoff").toBeTruthy();
    const win = { isDestroyed: () => false, webContents: { isLoadingMainFrame: () => false, send: (channel, request) => local.listeners.get(channel)({}, request) } };
    const activate = vi.fn();
    const show = new Function("mainWindow", "appReadiness", "activateExistingWindow", `return request => {${body}};`)(win, { ready: () => true }, activate);
    const m = main({ show }), cloud = preload("preload-cloud.cjs", { invoke: m.invoke });
    expect(typeof cloud.bridge.requestSignIn).toBe("function");
    expect(typeof local.bridge.cloudHome.onSignInRequested).toBe("function");
    const answer = await cloud.bridge.requestSignIn({ bot: "bot-a", engine: "codex" });
    expect(answer).toEqual({ requested: true });
    expect(m.showSignIn).toHaveBeenCalledExactlyOnceWith({ homeId: "home-1", bot: "bot-a", engine: "codex" });
    // A request arriving before React mounts its listener is retained by the preload.
    const request = m.showSignIn.mock.calls[0][0], received = vi.fn();
    expect(activate).toHaveBeenCalledExactlyOnceWith([win]);
    const stop = local.bridge.cloudHome.onSignInRequested(received);
    expect(received).toHaveBeenCalledExactlyOnceWith(request);
    stop();
    local.listeners.get("cloud-home:sign-in-requested")({}, { ...request, bot: "bot-b" });
    expect(received).toHaveBeenCalledTimes(1);
    const next = vi.fn(); local.bridge.cloudHome.onSignInRequested(next);
    expect(next).toHaveBeenCalledExactlyOnceWith({ ...request, bot: "bot-b" });
  });

  it("supports each Connect engine and refuses malformed requests before opening anything", async () => {
    const m = main();
    for (const engine of ["claudeAgent", "codex", "grokAgent", "kimiAgent", "opencodeGo"]) {
      expect(await preload("preload-cloud.cjs", { invoke: m.invoke }).bridge.requestSignIn({ bot: "bot-a", engine })).toEqual({ requested: true });
    }
    m.showSignIn.mockClear();
    for (const input of [null, {}, { bot: "../bad", engine: "codex" }, { bot: 1, engine: "codex" }, { bot: "a", engine: "antigravityAgent" }, { bot: "a", engine: "codex", homeId: "other-home" }, { bot: "a", engine: "anything" }]) {
      await expect(m.invoke("cloud-home:request-sign-in", input)).rejects.toThrow("Invalid request.");
    }
    await expect(m.invoke("cloud-home:request-sign-in", { bot: "a", engine: "codex" }, "extra")).rejects.toThrow("Invalid request.");
    expect(m.showSignIn).not.toHaveBeenCalled();
  });

  it("never reports success for a missing sender home, inactive Cloud, or an unavailable local window", async () => {
    const request = { bot: "a", engine: "codex" };
    for (const options of [{ homeId: null }, { active: false }, { shown: false }]) {
      await expect(main(options).invoke("cloud-home:request-sign-in", request)).rejects.toThrow();
    }
    expect(preload("preload-cloud.cjs", { surface: "browser-popout" }).bridge.requestSignIn).toBeUndefined();
    expect(preload("preload-cloud.cjs", { origin: false }).bridge).toBeUndefined();
    expect(preload("preload.cjs", { cloud: false }).bridge.cloudHome).toBeUndefined();
    expect(channelClass("cloud-home:request-sign-in")).toBe(CLASS_CLOUD_ONLY);
    expect(channelClass("cloud-home:sign-in-requested")).toBe(CLASS_LOCAL_ONLY);
  });

  it("strips Electron's error wrapper before the UI reads a refusal", async () => {
    const { bridge } = preload("preload-cloud.cjs", { invoke: async () => { throw new Error("Error invoking remote method 'cloud-home:request-sign-in': Error: Open Murage on this computer, then try signing in again."); } });
    await expect(bridge.requestSignIn({ bot: "a", engine: "codex" })).rejects.toThrow(/^Open Murage on this computer, then try signing in again\.$/);
  });
});
