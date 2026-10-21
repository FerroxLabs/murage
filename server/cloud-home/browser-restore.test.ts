// SPDX-License-Identifier: AGPL-3.0-or-later
// The relay's Cloud restore: it asks the launcher for the saved storage before the engine starts and tells
// the launcher each origin it puts back. The launcher is faked here; browser-restore-launcher.test.ts runs
// the real modes.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ requests: [] as Array<{ method: string; params: unknown }>, evalReply: "murage-restore-done" }));
vi.mock("../drivers/headless-browser-proxy.ts", () => ({
  startHeadlessEngine: () => ({
    request: async (method: string, params?: { name?: string }) => {
      engine.requests.push({ method, params });
      if (params?.name === "agent_browser_eval") return { content: [{ type: "text", text: engine.evalReply }] };
      return { ok: true };
    },
    close: async () => {},
  }),
}));
vi.mock("../browser-sandbox.ts", () => ({ ensureBrowserSandboxAccess: async () => {} }));

const { createNativeBrowser } = await import("../browser-native-relay.ts");
const { prepareCloudBrowserRestore } = await import("./browser-restore.ts");

const KEY = "cd".repeat(32);
const ORIGIN = "https://shop.example";
const STORAGE = { localStorage: [{ name: "cart", value: "3" }], sessionStorage: [] };
type Launch = { args: string[]; mode: string; env: NodeJS.ProcessEnv };

function fakeChild(output: string, code = 0, delay = 0): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { killed?: boolean };
  const stdout = new PassThrough(); const stderr = new PassThrough();
  Object.assign(child, { stdout, stderr, stdin: new PassThrough(), kill: () => { child.killed = true; return true; } });
  setTimeout(() => { stdout.end(output); child.emit("close", code); }, delay);
  return child;
}
function launcher(answers: Record<string, string | { code: number }>) {
  const launches: Launch[] = [];
  const launch = (args: string[], env: NodeJS.ProcessEnv, mode: string) => {
    launches.push({ args, mode, env });
    const answer = answers[mode];
    return typeof answer === "object" ? fakeChild("", answer.code) : fakeChild(answer ?? "");
  };
  return { launches, launch: launch as never };
}
const READY = JSON.stringify({ state: "ready", origins: { [ORIGIN]: STORAGE }, cookies: 2, logs: ["[browser] restore store: 1 origins with saved storage, 2 cookies"] });
const env = () => ({
  AGENT_BROWSER_SOCKET_DIR: "/nonexistent/sockets", AGENT_BROWSER_SESSION: "fixture", AGENT_BROWSER_RESTORE: "fixture", AGENT_BROWSER_ENCRYPTION_KEY: KEY,
  AGENT_BROWSER_RESTORE_SAVE: "auto", MURAGE_CLOUD_BROWSER_BOT: "bot-1", HOME: "/data/browser/bot-1",
});

beforeEach(() => { engine.requests.length = 0; engine.evalReply = "murage-restore-done"; vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("asks the launcher for the saved session before the engine starts and marks each origin it restores", async () => {
  const { launches, launch } = launcher({ "browser-restore": READY, "browser-restore-mark": JSON.stringify({ state: "marked" }) });
  const native = createNativeBrowser({ command: "/nonexistent/engine", args: ["mcp"], env: env() }, { cloudLaunch: launch });
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/cart?x=1` } });
  await new Promise(resolve => setTimeout(resolve, 50));
  // The split was asked for first, with no arguments, and the engine started only after it.
  expect(launches[0]).toMatchObject({ mode: "browser-restore", args: [] });
  expect(engine.requests[0]!.method).toBe("initialize");
  // The origin's storage went into the page at its root, then the page asked for was opened.
  const calls = engine.requests.filter(item => item.method === "tools/call").map(item => (item.params as { name: string; arguments: { url?: string; script?: string } }));
  expect(calls.map(call => call.name)).toEqual(["agent_browser_open", "agent_browser_open", "agent_browser_eval", "agent_browser_open", "agent_browser_get_url"].slice(0, calls.length));
  expect(calls.find(call => call.name === "agent_browser_eval")!.arguments.script).toContain("cart");
  // And the launcher was told it was restored.
  expect(launches.filter(item => item.mode === "browser-restore-mark").map(item => item.args)).toEqual([[ORIGIN]]);
  // A second visit to the same origin restores nothing and marks nothing more.
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/other` } });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(launches.filter(item => item.mode === "browser-restore-mark")).toHaveLength(1);
  // The key rides in the settings only: no launcher argument carries it.
  expect(JSON.stringify(launches.map(item => item.args))).not.toContain(KEY);
  expect(launches.every(item => item.env.AGENT_BROWSER_ENCRYPTION_KEY === KEY)).toBe(true);
});

it("prepares once per engine start, not on every command", async () => {
  const { launches, launch } = launcher({ "browser-restore": JSON.stringify({ state: "none", logs: [] }) });
  const native = createNativeBrowser({ command: "/nonexistent/engine", args: ["mcp"], env: env() }, { cloudLaunch: launch });
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: "https://a.example/" } });
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: "https://b.example/" } });
  expect(launches.filter(item => item.mode === "browser-restore")).toHaveLength(1);
  expect(launches.filter(item => item.mode === "browser-restore-mark")).toHaveLength(0);
});

it("starts the engine as before when the launcher refuses or answers badly", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const answers of [{ "browser-restore": { code: 1 } }, { "browser-restore": "not json" }, { "browser-restore": JSON.stringify({ state: "ready", origins: [] }) }] as Array<Record<string, string | { code: number }>>) {
    engine.requests.length = 0;
    const { launches, launch } = launcher(answers);
    const native = createNativeBrowser({ command: "/nonexistent/engine", args: ["mcp"], env: env() }, { cloudLaunch: launch });
    await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/` } });
    expect(engine.requests.some(item => item.method === "initialize")).toBe(true);
    expect(engine.requests.some(item => (item.params as { name?: string } | undefined)?.name === "agent_browser_eval")).toBe(false);
    expect(launches.filter(item => item.mode === "browser-restore-mark")).toHaveLength(0);
  }
  const logged = vi.mocked(console.error).mock.calls.map(call => String(call[0])).join("\n");
  expect(logged).not.toContain(KEY);
});

it("does not ask the launcher when the browser keeps no saved session or is the owner's own Chrome", async () => {
  for (const changed of [{ AGENT_BROWSER_RESTORE_SAVE: "never" }, { AGENT_BROWSER_CDP: "ws://127.0.0.1:9222/devtools/browser/x" }] as Array<Record<string, string>>) {
    const { launches, launch } = launcher({});
    const native = createNativeBrowser({ command: "/nonexistent/engine", args: ["mcp"], env: { ...env(), ...changed } }, { cloudLaunch: launch });
    await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/` } }).catch(() => {});
    expect(launches).toHaveLength(0);
  }
});

it("a marker that fails is logged in fixed words and never stops the bot's browser", async () => {
  const lines: string[] = [];
  const { launch } = launcher({ "browser-restore": READY, "browser-restore-mark": { code: 76 } });
  const session = (await prepareCloudBrowserRestore(env(), line => lines.push(line), launch))!;
  expect(session.origins).toBe(1);
  session.restored(ORIGIN);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(session.waiting()).toBe(false);
  expect(lines.some(line => line.includes("could not note a visit"))).toBe(true);
  expect(lines.join("\n")).not.toContain(KEY);
});

it("takes marks in the order they happened, one launcher call each", async () => {
  const many = JSON.stringify({ state: "ready", origins: { [ORIGIN]: STORAGE, "https://b.example": STORAGE, "https://c.example:8443": STORAGE }, cookies: 0, logs: [] });
  const { launches, launch } = launcher({ "browser-restore": many, "browser-restore-mark": JSON.stringify({ state: "marked" }) });
  const session = (await prepareCloudBrowserRestore(env(), () => {}, launch))!;
  session.restored("https://c.example:8443"); session.passed(ORIGIN); session.restored("https://b.example"); session.abandoned("https://nowhere.example");
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(launches.filter(item => item.mode === "browser-restore-mark").map(item => item.args[0])).toEqual(["https://c.example:8443", ORIGIN, "https://b.example"]);
});

it("answers nothing off a Cloud home", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  expect(await prepareCloudBrowserRestore(env(), () => {})).toBeUndefined();
});

it("puts the restore modes on the same private request every browser request uses", async () => {
  const { cloudBrowserRequest } = await import("./browser-process.ts");
  const request = cloudBrowserRequest([ORIGIN], env(), "browser-restore-mark");
  expect(request).toMatchObject({ mode: "browser-restore-mark", bot: "bot-1", args: [ORIGIN] });
  expect(Object.keys(request.settings).sort()).toEqual(["AGENT_BROWSER_ENCRYPTION_KEY", "AGENT_BROWSER_RESTORE", "AGENT_BROWSER_RESTORE_SAVE", "AGENT_BROWSER_SESSION"]);
  expect(cloudBrowserRequest(["mcp"], env()).mode).toBe("browser");
});
