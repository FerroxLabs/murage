// SPDX-License-Identifier: AGPL-3.0-or-later
// BrowserExtensionIntegration.bind against the REAL service with a fake broker,
// so offline, paused and stopped behave as they do in the app.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { BrowserExtensionIntegration } from "./browser-extension-integration.ts";
import { createBrowserExtensionService } from "./browser-extension-service.ts";
import { extensionBrowserUnavailablePrompt } from "./browser-extension-prompt.ts";
import type { BotRecord } from "./store.ts";
import type { BrowserExtensionCommand, BrowserExtensionHello, BrowserExtensionResponse } from "../shared/browser-extension-protocol.ts";
import { privateTestDirectory } from "./testing/private-test-dir.ts";

const cleanup: string[] = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
type Tab = { tabId: number; navigationEpoch: number; origin: string; url: string };
async function fixture(profileIds: string[]) {
  const { root: directoryRoot, directory } = await privateTestDirectory(path.resolve(".integration-")); cleanup.push(directoryRoot);
  let profiles = profileIds; let connected = true; let nextTab = 1;
  const bindings = new Map<string, { generation: number; state: string; tabs: Tab[] }>();
  const hello = (profileId: string): BrowserExtensionHello => ({ version: 1, type: "hello", profileId, browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1"] });
  const broker = {
    profiles: () => connected ? profiles.map(hello) : [],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      if (!connected) throw Object.assign(Error("host_offline"), { code: "host_offline" });
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: nextTab++, navigationEpoch: 1, origin: "https://fixture.test", url: "https://fixture.test/" }] }; bindings.set(command.bindingId, b); }
      if (command.operation === "stop" || command.operation === "pause") { b.generation++; b.state = command.operation === "stop" ? "stopped" : "paused"; }
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(b) };
    },
  };
  const service = await createBrowserExtensionService({ collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: 'visible', ariaHidden: false, coveredBy: null } }) as never, broker, workspaceId: "workspace", stateFile: path.join(directory, "state.json"), askSite: async () => "allow" });
  const value = new BrowserExtensionIntegration({ dataDir: "/unused", socketDir: "/unused", workspaceId: "workspace", approvalBus: { store: { bots: [], groups: [], messagesFor: () => [] } } as never, bot: () => undefined, protectedOrigins: [] });
  value.start = async () => service as never;
  return { value, service, bindings, offline: () => { connected = false; }, setProfiles: (next: string[]) => { profiles = next; } };
}
const bot = (fields: Partial<BotRecord> = {}) => ({ id: "bot", useMyChrome: true, browserTransport: "extension", ...fields }) as BotRecord;
const PLAIN = /^[A-Z][^_]*\.$/;

describe("which browser profile a bot uses", () => {
  it("the only connected profile is used for this turn but not pinned without the owner choosing", async () => {
    const f = await fixture(["profile_a"]);
    const record = bot();
    await expect(f.value.bind(record, "thread")).resolves.toMatchObject({ profileId: "profile_a" });
    expect(record.browserExtensionProfileId).toBeUndefined();
    // A second profile later: the owner chooses, nothing was pinned implicitly.
    f.setProfiles(["profile_a", "profile_b"]);
    await expect(f.value.bind(bot(), "thread")).rejects.toThrow("Choose the browser profile");
  });
  it("a remembered profile is used even when another profile connects", async () => {
    const f = await fixture(["profile_b", "profile_a"]);
    await expect(f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread")).resolves.toMatchObject({ profileId: "profile_a" });
  });
});
describe("browser tools only when the owner's browser is ready for this bot", () => {
  it("an active binding binds", async () => {
    const f = await fixture(["profile_a"]);
    await expect(f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread")).resolves.toMatchObject({ profileId: "profile_a" });
  });
  it("browser closed: a plain sentence, never a raw code, in the hint", async () => {
    const f = await fixture(["profile_a"]);
    await f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread");
    f.offline();
    const error = await f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread").catch(e => e);
    expect(error).toMatchObject({ code: "browser_extension_not_ready" });
    expect(error.message).toMatch(PLAIN); expect(error.message).toMatch(/not connected/);
    expect(extensionBrowserUnavailablePrompt(error.message, true)).not.toContain("host_offline");
  });
  it("owner paused, then browsed in the shared tab: the paused sentence, and Stop still works", async () => {
    const f = await fixture(["profile_a"]);
    const first = await f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread");
    await f.service.pause(first.bindingId);
    const runtime = f.bindings.get(first.bindingId)!; runtime.tabs[0].navigationEpoch++; runtime.tabs[0].origin = ""; runtime.tabs[0].url = "";
    const error = await f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread").catch(e => e);
    expect(error).toMatchObject({ code: "browser_extension_not_ready" });
    expect(error.message).toMatch(/paused/); expect(error.message).not.toMatch(/Invalid URL/);
    await expect(f.service.stop(first.bindingId)).resolves.toBeUndefined();
    const stopped = await f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread").catch(e => e);
    expect(stopped.message).toMatch(/stopped/);
  });
  it("any other failure becomes one fixed sentence", async () => {
    const f = await fixture(["profile_a"]);
    f.value.start = async () => ({ status: () => ({ profiles: [{ profileId: "profile_a", browser: "chromium" }], bindings: [] }), ensureBinding: async () => { throw Object.assign(Error("something_odd at /private/tmp/x"), { code: "something_odd" }); } }) as never;
    const error = await f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread").catch(e => e);
    expect(error).toMatchObject({ code: "browser_extension_not_ready" });
    expect(error.message).toMatch(PLAIN); expect(error.message).not.toMatch(/something_odd|\/private/);
  });
  it("c: an older extension (missing capabilities) or an older app is refused with a plain update sentence", async () => {
    for (const [code, pattern] of [["incompatible_capabilities", /Update Murage for Chrome/], ["update_murage", /Update Murage on this computer/]] as const) {
      const f = await fixture(["profile_a"]);
      f.value.start = async () => ({ status: () => ({ profiles: [{ profileId: "profile_a", browser: "chromium" }], bindings: [] }), ensureBinding: async () => { throw Object.assign(Error(`${code} at /private/tmp/x`), { code }); } }) as never;
      const error = await f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread").catch(e => e);
      expect(error).toMatchObject({ code: "browser_extension_not_ready" });
      expect(error.message).toMatch(PLAIN); expect(error.message).toMatch(pattern); expect(error.message).not.toMatch(/_|\/private|—/);
    }
  });
  it("d: an uncertain pause tells the bot plainly and does not claim a hand-off", async () => {
    const f = await fixture(["profile_a"]);
    f.value.start = async () => ({ status: () => ({ profiles: [{ profileId: "profile_a", browser: "chromium" }], bindings: [{ bindingId: "b", state: "paused", pausedReason: "uncertain" }] }), ensureBinding: async () => ({ bindingId: "b" }) }) as never;
    const error = await f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread").catch(e => e);
    expect(error.message).toMatch(/may not have finished/); expect(error.message).not.toMatch(/^YOUR TURN/);
  });
  it("the hint is plain text for every engine, and offers the request tool only where it exists", () => {
    const withTool = extensionBrowserUnavailablePrompt("Browser control is paused.", true);
    expect(withTool).toContain("Murage for Chrome");
    expect(withTool).toContain("request_browser_connection");
    expect(withTool).toContain("Browser control is paused.");
    const without = extensionBrowserUnavailablePrompt("The browser is not connected.", false);
    expect(without).not.toContain("request_browser_connection");
    expect(without).toMatch(/ask the owner/i);
    for (const text of [withTool, without]) { expect(text).not.toMatch(/—|\bsafe|\bunsafe|safety/i); expect(text.length).toBeLessThan(700); }
  });
});

describe("Windows Connect (W1): the helper alone creates the private folder", () => {
  it("does not pre-create the folder on Windows, and does on the other platforms", async () => {
    const { prepareStateDirectory } = await import("./browser-extension-integration.ts");
    const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bei-"));
    try {
      const windows = path.join(root, "win"), other = path.join(root, "other");
      prepareStateDirectory(windows, "win32"); expect(fs.existsSync(windows)).toBe(false);
      prepareStateDirectory(other, "linux"); expect(fs.statSync(other).isDirectory()).toBe(true);
      prepareStateDirectory(path.join(root, "mac"), "darwin"); expect(fs.existsSync(path.join(root, "mac"))).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Vultr live bug 5: a server restart pauses a task, it does not stop it for good", () => {
  it("close pauses an active task so the owner can Resume, and leaves a stopped one stopped", async () => {
    const f = await fixture(["profile_a"]); (f.value as any).service = f.service;
    const active = await f.service.ensureBinding({ botId: "bot_a", threadId: "t1", profileId: "profile_a" });
    const stopped = await f.service.ensureBinding({ botId: "bot_b", threadId: "t2", profileId: "profile_a" }); await f.service.stop(stopped.bindingId);
    await f.value.close();
    const states = Object.fromEntries(f.service.status().bindings.map(b => [b.bindingId, b.state]));
    expect(states[active.bindingId]).toBe("paused"); expect(states[stopped.bindingId]).toBe("stopped");
  });
  it("a failed event reconcile for an already stopped task does not call stop again", async () => {
    const f = await fixture(["profile_a"]);
    const b = await f.service.ensureBinding({ botId: "bot_a", threadId: "t1", profileId: "profile_a" }); await f.service.stop(b.bindingId);
    const stop = vi.spyOn(f.service, "stop");
    await (f.value as any).failClosed(b.bindingId, "stopped");
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("T20 owner actions: the phone and the side panel may only tighten", () => {
  it("raising a site needs the desktop; lowering, End task and Revoke work from anywhere and cancel waiting cards first", async () => {
    const f = await fixture(["profile_a"]);
    (f.value as unknown as { service: unknown }).service = f.service;
    const binding = await f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread");
    const id = binding.bindingId; const origin = "https://fixture.test";
    const cancelled = vi.spyOn(f.value.approvals, "cancelBinding");
    await expect(f.value.ownerAction(id, "site", { origin, access: "allow", surface: "phone" })).rejects.toMatchObject({ status: 403 });
    await expect(f.value.ownerAction(id, "site", { origin, access: "allow", surface: "panel" })).rejects.toMatchObject({ status: 403 });
    await expect(f.value.ownerAction(id, "site", { origin, access: "allow" })).rejects.toMatchObject({ status: 403 });
    expect(f.value.status().bindings[0].sites[origin]).toBeUndefined();
    await f.value.ownerAction(id, "site", { origin, access: "allow", surface: "desktop" });
    expect(f.value.status().bindings[0].sites[origin]).toBe("allow");
    cancelled.mockClear();
    await f.value.ownerAction(id, "revoke", { origin, surface: "phone" });
    expect(cancelled).toHaveBeenCalledWith(id);
    expect(f.value.status().bindings[0].sites[origin]).toBe("ask");
    cancelled.mockClear();
    await f.value.ownerAction(id, "site", { origin, access: "never", surface: "phone" });
    expect(cancelled).toHaveBeenCalledWith(id);
    cancelled.mockClear();
    await f.value.ownerAction(id, "end", { surface: "panel" });
    expect(cancelled).toHaveBeenCalledWith(id);
  });
  it("M2: the phone and the side panel cannot lift a Never to Ask", async () => {
    const f = await fixture(["profile_a"]);
    (f.value as unknown as { service: unknown }).service = f.service;
    const binding = await f.value.bind(bot({ browserExtensionProfileId: "profile_a" }), "thread");
    const id = binding.bindingId; const origin = "https://fixture.test";
    await f.value.ownerAction(id, "site", { origin, access: "never", surface: "phone" });
    expect(f.value.status().bindings[0].sites[origin]).toBe("never");
    for (const surface of ["phone", "panel", undefined] as const) {
      await expect(f.value.ownerAction(id, "site", { origin, access: "ask", ...(surface ? { surface } : {}) })).rejects.toMatchObject({ status: 403 });
      expect(f.value.status().bindings[0].sites[origin]).toBe("never");
    }
    await f.value.ownerAction(id, "site", { origin, access: "ask", surface: "desktop" });
    expect(f.value.status().bindings[0].sites[origin]).toBe("ask");
  });
});

// D7: "Browser helper setup needs repair" is true only until the browser connects. It must not outlive a successful connect.
describe("a leftover setup problem goes away once the browser connects", () => {
  const stale = (value: unknown) => { const target = value as { registrationProblem: string; registrationCode: string }; target.registrationProblem = "Browser helper setup needs repair. No existing registration was adopted."; target.registrationCode = "registration_repair_required"; };
  it("keeps the problem while nothing is connected", async () => {
    const f = await fixture([]);
    (f.value as unknown as { service: unknown }).service = f.service; stale(f.value);
    expect(f.value.setupProblem()).toContain("needs repair");
    expect(f.value.setupProblemKind()).toBe("repair");
  });
  it("clears it as soon as a browser profile is connected", async () => {
    const f = await fixture(["profile_a"]);
    (f.value as unknown as { service: unknown }).service = f.service; stale(f.value);
    expect(f.value.setupProblem()).toBe("");
    expect(f.value.setupProblemKind()).toBeUndefined();
  });
  it("clears it when the extension sends anything through the helper", async () => {
    const f = await fixture([]);
    stale(f.value);
    f.value.handleBrokerMessage("profile_a", { type: "event", event: "notice", bindingId: "none", data: {} } as never);
    expect(f.value.setupProblem()).toBe("");
  });
});
