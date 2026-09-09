import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { transitionComputerControlLease } from "../src/lib/computer-control.ts";

const require = createRequire(import.meta.url);
const {
  applyBrowserControlHold,
  browserLifecycleResult,
  decodeBrowserLifecycleMessage,
} = require("./browser-control-sync.cjs");

const requestId = "123e4567-e89b-42d3-a456-426614174000";

// Execute the actual main-process registration and startup function, without
// starting Electron, providers or a user's application. Real surface control
// state is used; window/process ownership and host startup are fixture doubles.
function takeoverFixture() {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const handlers = new Map();
  const owner = { isDestroyed: () => false, webContents: { on() {}, isDestroyed: () => false }, once() {} };
  const context = {
    mainWindow: owner, browserSurface: null, browserHost: { url: "http://127.0.0.1:1" },
    browserControlHolds: new Set(), browserSurfaceIsSupported: true,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    browserProfileFromRenderer: (profile) => profile,
    // The production factory checks Function identity. Adapt the VM callback
    // into this realm without changing the actual manager's admission check.
    createBrowserSurfaceManager: (options) => require("./browser-surface.cjs").createBrowserSurfaceManager({
      ...options, createView: (...args) => options.createView(...args),
    }),
    desktopBrowserPartition: (id) => `fixture-${id}`, desktopBrowserProfilePartition: (id) => `fixture-profile-${id}`,
    WebContentsView: class { constructor() { throw new Error("fixture must not create a browser view"); } },
    ensureBrowserHost: vi.fn(async () => {
      expect(context.browserSurface.controlLease("bot-a").held).toBe(context.browserControlHolds.has("bot-a"));
    }), slog() {}, removeBrowserConnectionDescriptor() {}, serverProc: null,
  };
  const registration = source.slice(source.indexOf('ipcMain.handle("browser:set-human-control",'), source.indexOf('ipcMain.handle("browser:close",'));
  const startup = source.slice(source.indexOf("async function startBrowserSurface(owner)"), source.indexOf("function browserSurfaceForEvent(event)"));
  expect(registration).toContain("browserControlHolds");
  expect(startup).toContain("ensureBrowserHost");
  runInNewContext(`${registration}\n${startup}\nthis.start = startBrowserSurface;`, context);
  const set = (held, event = { sender: owner.webContents }, id = "bot-a") => handlers.get("browser:set-human-control")(event, id, held);
  const transition = (action, requestControl) => transitionComputerControlLease({
    action, syncNativeBrowser: true, setNativeBrowserControl: async (held) => set(held), requestControl,
  });
  return { context, owner, set, transition };
}

describe("Computer takeover without a native browser surface", () => {
  it("records the native hold before requesting the server lease", async () => {
    const f = takeoverFixture();
    await f.transition("take", async () => {
      expect(f.context.browserControlHolds.has("bot-a")).toBe(true);
      return { held: true, helpReason: null };
    });
    expect(f.context.browserSurface).toBeNull();
  });

  it("applies a remembered hold before a future or recreated surface host is exposed", async () => {
    const f = takeoverFixture();
    expect(f.set(true)).toBe(true);
    await f.context.start(f.owner);
    expect(f.context.browserSurface.controlLease("bot-a").held).toBe(true);
    f.context.browserSurface.closeAll();
    f.context.browserSurface = null;
    await f.context.start(f.owner);
    expect(f.context.browserSurface.controlLease("bot-a").held).toBe(true);
    expect(f.context.ensureBrowserHost).toHaveBeenCalledTimes(2);
  });

  it("clears a remembered hold only after confirmed server release", async () => {
    const f = takeoverFixture();
    f.context.browserControlHolds.add("bot-a");
    await f.transition("release", async () => {
      expect(f.context.browserControlHolds.has("bot-a")).toBe(true);
      return { held: false, helpReason: null };
    });
    expect(f.context.browserControlHolds.has("bot-a")).toBe(false);
    await f.context.start(f.owner);
    expect(f.context.browserSurface.controlLease("bot-a").held).toBe(false);
  });

  it("retains the private hold when durable take or release fails", async () => {
    const f = takeoverFixture();
    await expect(f.transition("take", async () => { throw new Error("server unavailable"); })).rejects.toThrow("server unavailable");
    expect(f.context.browserControlHolds.has("bot-a")).toBe(true);
    await expect(f.transition("release", async () => ({ held: true, helpReason: null }))).rejects.toThrow(/could not release/);
    expect(f.context.browserControlHolds.has("bot-a")).toBe(true);
  });

  it("updates an existing surface and remembers its hold across recreation", async () => {
    const f = takeoverFixture();
    await f.context.start(f.owner);
    expect(f.set(true)).toBe(true);
    expect(f.context.browserSurface.controlLease("bot-a").held).toBe(true);
    expect(f.set(false)).toBe(true);
    expect(f.context.browserSurface.controlLease("bot-a").held).toBe(false);
    expect(f.context.browserControlHolds.size).toBe(0);
  });

  it("rejects another window, a destroyed owner and invalid bot ids before changing holds", () => {
    const f = takeoverFixture();
    expect(() => f.set(true, { sender: {} })).toThrow(/main app window/);
    expect(() => f.set(true, undefined, "../bot")).toThrow(/bot id/);
    f.owner.isDestroyed = () => true;
    expect(() => f.set(true)).toThrow(/main app window/);
    expect(f.context.browserControlHolds.size).toBe(0);
  });
});

describe("private browser control sync", () => {
  it("mirrors a valid server hold into Electron", () => {
    const take = vi.fn();
    expect(applyBrowserControlHold({ type: "murage:browser-control", botId: "bot-a", held: true }, take)).toBe(true);
    expect(take).toHaveBeenCalledWith("bot-a");
  });

  it("never treats a generic server release as authority to clear the local gate", () => {
    const take = vi.fn();
    expect(() => applyBrowserControlHold({ type: "murage:browser-control", botId: "bot-a", held: false }, take))
      .toThrow(/invalid browser-control hold/);
    expect(take).not.toHaveBeenCalled();
  });

  it("rejects malformed bot ids and ignores unrelated private messages", () => {
    expect(() => applyBrowserControlHold({ type: "murage:browser-control", botId: "../other", held: true }, () => {}))
      .toThrow(/invalid browser-control hold/);
    expect(applyBrowserControlHold({ type: "murage:browser-connection" }, () => {})).toBe(false);
  });
});

describe("private browser lifecycle sync", () => {
  it("accepts exact bot/profile deletion messages", () => {
    expect(decodeBrowserLifecycleMessage({
      type: "murage:browser-bot-deleted",
      requestId,
      botId: "bot_A-1",
    })).toEqual({ type: "bot-deleted", requestId, botId: "bot_A-1" });
    expect(decodeBrowserLifecycleMessage({
      type: "murage:browser-profile-deleted",
      requestId,
      partitionId: "Client_1",
    })).toEqual({ type: "profile-deleted", requestId, partitionId: "Client_1" });
  });

  it("builds an exact acknowledgement only for a valid request id", () => {
    expect(browserLifecycleResult(requestId, true)).toEqual({
      type: "murage:browser-lifecycle-result",
      requestId,
      ok: true,
    });
    expect(() => browserLifecycleResult("../request", true)).toThrow(/result id/);
  });

  it("rejects malformed lifecycle ids and ignores unrelated messages", () => {
    expect(() => decodeBrowserLifecycleMessage({ type: "murage:browser-bot-deleted", botId: "../other" }))
      .toThrow(/bot-deleted/);
    expect(() => decodeBrowserLifecycleMessage({ type: "murage:browser-profile-deleted", partitionId: "work!" }))
      .toThrow(/profile-deleted/);
    expect(() => decodeBrowserLifecycleMessage({ type: "murage:browser-profile-deleted", partitionId: "guest" }))
      .toThrow(/profile-deleted/);
    expect(() => decodeBrowserLifecycleMessage({
      type: "murage:browser-profile-deleted",
      requestId: "not-a-request-id",
      partitionId: "Work",
    })).toThrow(/request id/);
    expect(() => decodeBrowserLifecycleMessage({
      type: "murage:browser-profile-deleted",
      profileId: "work",
    })).toThrow(/profile-deleted/);
    expect(decodeBrowserLifecycleMessage({ type: "murage:managed-composio" })).toBeNull();
  });
});
