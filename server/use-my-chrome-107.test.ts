// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.7: "Use my Chrome" goes through Murage for Chrome when it is paired, asks
// Chrome for Allow once on the remote-debugging route, and never keeps the
// owner holding a browser they asked to give back.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { UnifiedBrowserController } from "./browser-control.ts";
import { createNativeBrowser, type NativeBrowser } from "./browser-native-relay.ts";
import { pairedExtensionProfile, resetUserChromeTroubleCache, userChromeAttachLog, UserChromeBinds, userChromeTrouble, useMyChromeProfile, useMyChromeRoute } from "./user-chrome.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "murage-umc107-")); scratch.push(path); return path; };
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const path of scratch.splice(0)) removeTempDirSync(path);
  resetUserChromeTroubleCache(); vi.restoreAllMocks();
});
const ID = "4c1b0f0e-9a2d-4e8f-b1c3-5d6e7f8a9b0c";

describe("which route Use my Chrome takes", () => {
  it("uses Murage for Chrome whenever a profile is paired, naming it only when there is one", () => {
    expect(useMyChromeRoute([{ profileId: "p1", browser: "chrome" }], "listening")).toEqual({ route: "extension", transport: "extension", profileId: "p1" });
    expect(useMyChromeRoute([{ profileId: "p1", browser: "chrome" }, { profileId: "p2", browser: "chrome" }], "off")).toEqual({ route: "extension", transport: "extension" });
    // Google Chrome only: "Use my Chrome" never lands in Edge or Brave.
    expect(pairedExtensionProfile([{ profileId: "e1", browser: "edge" }, { profileId: "c1", browser: "chrome" }])).toEqual({ ready: true, profileId: "c1", profileIds: ["c1"] });
    expect(useMyChromeRoute([{ profileId: "e1", browser: "edge" }], "listening")).toEqual({ route: "remote-debugging", transport: undefined });
    expect(useMyChromeRoute([{ profileId: "b1", browser: "brave" }], "off")).toEqual({ route: "install", transport: "extension" });
  });
  it("counts Murage for Chrome's own hello (\"chromium\", as in real Google Chrome 156) as paired, but never pins it", () => {
    // "chromium" is said by Chrome, Edge and Brave alike: the extension route, with the owner choosing the profile.
    expect(useMyChromeRoute([{ profileId: "p1", browser: "chromium" }], "listening")).toEqual({ route: "extension", transport: "extension" });
    expect(useMyChromeRoute([{ profileId: "p1", browser: "chromium" }], "off")).toEqual({ route: "extension", transport: "extension" });
    expect(pairedExtensionProfile([{ profileId: "e1", browser: "edge" }, { profileId: "c1", browser: "chromium" }])).toEqual({ ready: true, profileIds: ["c1"] });
    expect(pairedExtensionProfile([{ profileId: "c1", browser: "chrome" }, { profileId: "c2", browser: "chromium" }])).toEqual({ ready: true, profileIds: ["c1", "c2"] });
    expect(pairedExtensionProfile([{ profileId: "c1", browser: "Chrome" }])).toEqual({ ready: true, profileId: "c1", profileIds: ["c1"] });
    expect(pairedExtensionProfile([{ profileId: "e1", browser: "edge" }, { profileId: "b1", browser: "brave" }, { profileId: "x1" }])).toEqual({ ready: false, profileIds: [] });
  });
  it("keeps a bot's profile on \"auto\" only while it is in the Chrome set", () => {
    const edge = [{ profileId: "e1", browser: "edge" }, { profileId: "c1", browser: "chromium" }];
    const route = useMyChromeRoute(edge, "off");
    // Several or only "chromium" profiles: the bot keeps a Chrome-set profile it already had.
    expect(useMyChromeProfile(route, edge, "c1")).toBe("c1");
    // A profile that says Edge (or one no longer connected) is dropped, so the panel asks.
    expect(useMyChromeProfile(route, edge, "e1")).toBeNull();
    expect(useMyChromeProfile(route, edge, "gone")).toBeNull();
    expect(useMyChromeProfile(route, edge, undefined)).toBeNull();
    // The one named Chrome profile wins; the install and remote-debugging routes have no profile.
    expect(useMyChromeProfile(useMyChromeRoute([{ profileId: "c9", browser: "chrome" }], "off"), [{ profileId: "c9", browser: "chrome" }], "c1")).toBe("c9");
    expect(useMyChromeProfile(useMyChromeRoute([{ profileId: "b1", browser: "brave" }], "off"), [{ profileId: "b1", browser: "brave" }], "b1")).toBeNull();
    expect(useMyChromeProfile(useMyChromeRoute([], "listening"), [], "c1")).toBeNull();
  });
  it("falls back to remote debugging only when nothing is paired and Chrome listens", () => {
    expect(useMyChromeRoute([], "listening")).toEqual({ route: "remote-debugging", transport: undefined });
  });
  it("otherwise shows the extension's install steps", () => {
    expect(useMyChromeRoute([], "off")).toEqual({ route: "install", transport: "extension" });
  });
});

describe("plain words once Chrome allowed the connection", () => {
  it("words a failed step as Allow or remote debugging off only while the connection is not allowed", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    const at = source.indexOf('"browser_user_chrome_off" : "browser_user_chrome_allow"');
    expect(at).toBeGreaterThan(-1);
    const guard = source.slice(source.lastIndexOf("if (ownChrome", at), at);
    expect(guard).toContain('userChromeProxies.get(entry!.botId)?.state !== "allowed"');
  });
});

describe("the remote debugging probe", () => {
  const listen = async (): Promise<{ server: Server; port: number }> => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { server, port: (server.address() as { port: number }).port };
  };
  it("answers the 1 s panel poll from one probe every few seconds", async () => {
    const dir = temporary(), { port } = await listen();
    expect(await userChromeTrouble(dir)).toBe("off");
    writeFileSync(join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/${ID}\n`);
    expect(await userChromeTrouble(dir)).toBe("off"); // cached
    expect(await userChromeTrouble(dir, 1000, 0)).toBe("allow");
  });
});

describe("the attach log", () => {
  it("carries fixed words and a duration only", () => {
    expect(userChromeAttachLog("start")).toBe("[browser] user-chrome attach start");
    expect(userChromeAttachLog("waiting-allow", 3001.4)).toBe("[browser] user-chrome attach waiting-allow (3001 ms)");
    expect(userChromeAttachLog("failed", 120000, "timeout")).toBe("[browser] user-chrome attach failed (120000 ms, timeout)");
  });
});

function controllerWith(native: Partial<NativeBrowser>, attached = true, chromeWaiting?: (key: string) => boolean | undefined) {
  const dir = temporary();
  const full: NativeBrowser = { protected: async () => false, request: async () => ({}), command: async () => ({}), connect: async () => "s", input: () => {}, resetStream: () => {}, close: async () => {}, ...native } as NativeBrowser;
  const controller = new UnifiedBrowserController({ stateFile: join(dir, "control.json"), createNative: () => full, ...(chromeWaiting ? { chromeWaiting } : {}) });
  controller.register("k", { command: "fixture", args: [], env: attached ? { AGENT_BROWSER_CDP: `ws://127.0.0.1:9222/devtools/browser/${ID}` } : {} });
  return controller;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the owner's Chrome is asked once per attempt", () => {
  it("says it is waiting for Allow while only a bot's step waits on Chrome's prompt", async () => {
    let asking = true;
    const controller = controllerWith({}, true, () => asking ? true : false);
    expect(controller.status("k").waitingForChrome).toBe(true);
    asking = false;
    expect(controller.status("k").waitingForChrome).toBeUndefined();
    // Never for a bot on its own browser.
    expect(controllerWith({}, false, () => true).status("k").waitingForChrome).toBeUndefined();
  });
  it("says it is waiting for Allow while the first connection is pending", async () => {
    let finish!: () => void;
    const controller = controllerWith({ connect: () => new Promise<string>((resolve) => { finish = () => resolve("s"); }) });
    expect((await controller.refresh("k")).waitingForChrome).toBe(true);
    finish(); await settle();
    const status = controller.status("k");
    expect(status.connected).toBe(true); expect(status.waitingForChrome).toBeUndefined();
  });
  it("never retries a failed attach on a timer, only on Try again", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const connect = vi.fn(async () => { throw new Error("Allow not clicked"); });
    const controller = controllerWith({ connect });
    await controller.refresh("k"); await settle();
    expect(controller.status("k").problem).toBeTruthy();
    vi.spyOn(Date, "now").mockReturnValue(1_000 + 60 * 60_000);
    for (let i = 0; i < 5; i++) { await controller.refresh("k"); await settle(); }
    expect(connect).toHaveBeenCalledTimes(1);
    await controller.retry("k"); await settle();
    expect(connect).toHaveBeenCalledTimes(2);
  });
  it("does not say Waiting for Chrome once Murage's connection is already allowed (an engine restart asks nothing)", async () => {
    let allowed = false;
    const controller = controllerWith({ connect: () => new Promise<string>(() => {}) }, true, () => allowed ? false : undefined);
    expect((await controller.refresh("k")).waitingForChrome).toBe(true);
    allowed = true;
    expect(controller.status("k").waitingForChrome).toBeUndefined();
  });
  it("clears a failed view once the bot's own step reached Chrome, so the view reconnects on its next read", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    let fail = true;
    const connect = vi.fn(async () => { if (fail) throw new Error("Allow not clicked"); return "s"; });
    const controller = controllerWith({ connect });
    await controller.refresh("k"); await settle();
    expect(controller.status("k").problem).toBeTruthy();
    fail = false;
    controller.noteChromeConnected("k");
    expect(controller.status("k").problem).toBeUndefined();
    await controller.refresh("k"); await settle();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(controller.status("k").connected).toBe(true);
  });
  it("keeps the 3 s retry for Murage's own browser", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const connect = vi.fn(async () => { throw new Error("engine down"); });
    const controller = controllerWith({ connect }, false);
    await controller.refresh("k"); await settle();
    now.mockReturnValue(5_000); await controller.refresh("k"); await settle();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe("handing control back", () => {
  it("works for the holding owner after the live view reconnected", async () => {
    let drop = () => {};
    const controller = controllerWith({ connect: async (_f, _u, d) => { drop = d; return "s"; } }, false);
    const held = await controller.take("k", "owner"); await settle();
    drop(); await settle(); // the live view dropped: the stream generation moved on, control did not
    expect(controller.status("k").generation).toBeGreaterThan(held.generation);
    await expect(controller.release("k", "owner", held.generation)).rejects.toThrow();
    await expect(controller.release("k", "owner", held.generation, held.control)).resolves.toMatchObject({ held: false });
  });
  it("still refuses a stale hand-back after the owner navigated", async () => {
    const controller = controllerWith({ connect: async () => "s", command: async () => ({}) }, false);
    const held = await controller.take("k", "owner");
    await controller.navigate("k", "owner", controller.status("k").generation, "https://example.com");
    await expect(controller.release("k", "owner", undefined, held.control)).rejects.toThrow();
    expect(controller.status("k").held).toBe(true);
  });
  it("is still refused to another owner", async () => {
    const controller = controllerWith({ connect: async () => "s" }, false);
    const held = await controller.take("k", "owner-a");
    await expect(controller.release("k", "owner-b", held.generation)).rejects.toThrow();
    expect(controller.status("k").held).toBe(true);
  });
});

describe("the relay attaches the owner's Chrome once", () => {
  it("runs one browser command for concurrent live views, opens the page check with it, and logs no address", async () => {
    const dir = temporary();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    closers.push(() => new Promise<void>((resolve) => { for (const client of wss.clients) client.terminate(); wss.close(() => resolve()); }));
    const port = (wss.address() as { port: number }).port;
    const calls = join(dir, "calls.log");
    const engine = join(dir, "fake-engine.mjs");
    writeFileSync(engine, `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
appendFileSync(process.env.FAKE_CALLS, args.join(" ") + "\\n");
const answer = (data) => process.stdout.write(JSON.stringify({ success: true, data }));
if (args[0] === "get" && args[1] === "url") setTimeout(() => answer({ url: "about:blank" }), 150);
else if (args[0] === "get" && args[1] === "cdp-url") answer({ cdpUrl: "ws://127.0.0.1:${port}/devtools/browser/${ID}" });
else if (args[0] === "stream") answer({ port: ${port} });
else answer({});
`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const native = createNativeBrowser({ command: process.execPath, args: [], env: { AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "umc", AGENT_BROWSER_CDP: `ws://127.0.0.1:${port}/devtools/browser/${ID}`, FAKE_CALLS: calls } }, { cliPrefix: [engine] });
    closers.push(() => native.close());
    const noop = () => {};
    await Promise.all([native.connect(noop, noop, noop), native.connect(noop, noop, noop)]);
    const ran = readFileSync(calls, "utf8").trim().split("\n");
    expect(ran.filter((line) => line === "get url")).toHaveLength(1);
    expect(ran).toContain("get cdp-url");
    native.resetStream();
    await native.connect(noop, noop, noop);
    expect(readFileSync(calls, "utf8").trim().split("\n").filter((line) => line === "get url")).toHaveLength(1);
    const lines = [...log.mock.calls, ...err.mock.calls].map((call) => String(call[0])).filter((line) => line.includes("user-chrome"));
    expect(lines[0]).toBe("[browser] user-chrome attach start");
    expect(lines.some((line) => /^\[browser\] user-chrome attach connected \(\d+ ms\)$/.test(line))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/ws:\/\/|devtools|about:blank/);
  });
});

describe("Use my Chrome binds", () => {
  it("runs one bind per bot at a time and shares it", async () => {
    const binds = new UserChromeBinds<string>();
    let finish!: (value: string) => void;
    const bind = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const first = binds.run("bot", bind), second = binds.run("bot", bind);
    expect(second).toBe(first); expect(bind).toHaveBeenCalledTimes(1);
    finish("binding"); expect(await first).toBe("binding");
    void binds.run("bot", async () => "again"); expect(bind).toHaveBeenCalledTimes(1);
  });
  it("tells a bind that awaited across a forget that it is stale, and lets the next bind start fresh", async () => {
    const binds = new UserChromeBinds<string>();
    let resume!: () => void; let seen: boolean | undefined;
    const stale = binds.run("bot", async (current) => { await new Promise<void>((resolve) => { resume = resolve; }); seen = current(); if (!seen) throw new Error("changed"); return "stale"; });
    binds.forget("bot");
    const next = binds.run("bot", async (current) => current() ? "fresh" : "stale");
    expect(next).not.toBe(stale);
    resume();
    await expect(stale).rejects.toThrow("changed");
    expect(seen).toBe(false);
    expect(await next).toBe("fresh");
  });
  it("lets a bind that forgets (Chrome restarted) bind again on the new generation", async () => {
    const binds = new UserChromeBinds<string>();
    const outer = binds.run("bot", async () => {
      await Promise.resolve();
      binds.forget("bot");
      return binds.run("bot", async (current) => current() ? "rebound" : "stale");
    });
    expect(await Promise.race([outer, new Promise((resolve) => setTimeout(() => resolve("stuck"), 1_000))])).toBe("rebound");
  });
  it("records the run before the bind starts, so a bind that forgets at once still rebinds", async () => {
    const binds = new UserChromeBinds<string>();
    const outer = binds.run("bot", (current) => {
      binds.forget("bot");
      expect(current()).toBe(false);
      return binds.run("bot", async (fresh) => fresh() ? "rebound" : "stale");
    });
    expect(await Promise.race([outer, new Promise((resolve) => setTimeout(() => resolve("stuck"), 1_000))])).toBe("rebound");
  });
  it("keeps bots apart", async () => {
    const binds = new UserChromeBinds<string>();
    let resume!: () => void;
    const a = binds.run("a", async (current) => { await new Promise<void>((resolve) => { resume = resolve; }); return current() ? "a" : "stale"; });
    binds.forget("b"); resume();
    expect(await a).toBe("a");
  });
});
