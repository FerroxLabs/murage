// SPDX-License-Identifier: AGPL-3.0-or-later
// The relay's Cloud restore: it asks the launcher for the saved storage before the engine starts and tells
// the launcher each origin it puts back. The launcher is faked here; browser-restore-launcher.test.ts runs
// the real modes.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({ requests: [] as Array<{ method: string; params: unknown }>, evalReply: "murage-restore-done", failOpen: undefined as string | undefined }));
vi.mock("../drivers/headless-browser-proxy.ts", () => ({
  startHeadlessEngine: () => ({
    request: async (method: string, params?: { name?: string }) => {
      engine.requests.push({ method, params });
      if (engine.failOpen && JSON.stringify(params).includes(engine.failOpen)) throw new Error("engine request failed");
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
type Answer = string | { code: number };
function launcher(answers: Record<string, Answer | (() => Answer)>, delays: Record<string, number> = {}) {
  const launches: Launch[] = [];
  const events: string[] = [];
  const launch = (args: string[], env: NodeJS.ProcessEnv, mode: string) => {
    launches.push({ args, mode, env });
    events.push(`launch ${mode}`);
    const given = answers[mode];
    const answer = typeof given === "function" ? given() : given;
    const child = typeof answer === "object" ? fakeChild("", answer.code, delays[mode] ?? 0) : fakeChild(answer ?? "", 0, delays[mode] ?? 0);
    child.once("close", () => { events.push(`closed ${mode}`); });
    return child;
  };
  return { launches, events, launch: launch as never };
}
const GEN = "a1".repeat(16);
const GEN2 = "b2".repeat(16);
const ready = (generation = GEN, origins: Record<string, unknown> = { [ORIGIN]: STORAGE }) => JSON.stringify({ state: "ready", generation, origins, cookies: 2, logs: ["[browser] restore store: 1 origins with saved storage, 2 cookies"] });
const READY = ready();
const MARKED = JSON.stringify({ state: "marked" });
const env = () => ({
  AGENT_BROWSER_SOCKET_DIR: "/nonexistent/sockets", AGENT_BROWSER_SESSION: "fixture", AGENT_BROWSER_RESTORE: "fixture", AGENT_BROWSER_ENCRYPTION_KEY: KEY,
  AGENT_BROWSER_RESTORE_SAVE: "auto", MURAGE_CLOUD_BROWSER_BOT: "bot-1", HOME: "/data/browser/bot-1",
});

beforeEach(() => { engine.requests.length = 0; engine.evalReply = "murage-restore-done"; engine.failOpen = undefined; vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("asks the launcher for the saved session before the engine starts and marks each origin it restores", async () => {
  const { launches, launch } = launcher({ "browser-restore": READY, "browser-restore-mark": MARKED });
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
  expect(launches.filter(item => item.mode === "browser-restore-mark").map(item => item.args)).toEqual([[GEN, ORIGIN]]);
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
  expect(lines.filter(line => line.includes("could not note a visit"))).toHaveLength(2);
  expect(lines.join("\n")).not.toContain(KEY);
});

it("takes marks in the order they happened, one launcher call each", async () => {
  const many = ready(GEN, { [ORIGIN]: STORAGE, "https://b.example": STORAGE, "https://c.example:8443": STORAGE });
  const { launches, launch } = launcher({ "browser-restore": many, "browser-restore-mark": MARKED });
  const session = (await prepareCloudBrowserRestore(env(), () => {}, launch))!;
  session.restored("https://c.example:8443"); session.passed(ORIGIN); session.restored("https://b.example"); session.abandoned("https://nowhere.example");
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(launches.filter(item => item.mode === "browser-restore-mark").map(item => item.args)).toEqual([[GEN, "https://c.example:8443"], [GEN, ORIGIN], [GEN, "https://b.example"]]);
});

it("answers nothing off a Cloud home", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  expect(await prepareCloudBrowserRestore(env(), () => {})).toBeUndefined();
});

it("puts the restore modes on the same private request every browser request uses", async () => {
  const { cloudBrowserRequest } = await import("./browser-process.ts");
  const request = cloudBrowserRequest([GEN, ORIGIN], env(), "browser-restore-mark");
  expect(request).toMatchObject({ mode: "browser-restore-mark", bot: "bot-1", args: [GEN, ORIGIN] });
  expect(Object.keys(request.settings).sort()).toEqual(["AGENT_BROWSER_ENCRYPTION_KEY", "AGENT_BROWSER_RESTORE", "AGENT_BROWSER_RESTORE_SAVE", "AGENT_BROWSER_SESSION"]);
  expect(cloudBrowserRequest(["mcp"], env()).mode).toBe("browser");
});

// ── Astra cloud-browser review (REVISE) fixes, relay side ──────────────────────────────────────────────
const evals = () => engine.requests.filter(item => (item.params as { name?: string } | undefined)?.name === "agent_browser_eval").length;
const settle = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

it("#5 a mark needs the launcher's validated `marked` ack: a missing one is logged in fixed words and sent once more", async () => {
  for (const [answers, logged, sent] of [
    [["{}", "{}"], 2, 2], [["", MARKED], 1, 2], [[JSON.stringify({ state: "marked", extra: 1 }), MARKED], 1, 2], [[JSON.stringify({ state: "none" }), JSON.stringify({ state: "none" })], 2, 2], [[MARKED], 0, 1],
  ] as Array<[string[], number, number]>) {
    const lines: string[] = [];
    const queue = [...answers];
    const { launches, launch } = launcher({ "browser-restore": READY, "browser-restore-mark": () => queue.shift() ?? MARKED });
    const session = (await prepareCloudBrowserRestore(env(), line => lines.push(line), launch))!;
    session.restored(ORIGIN);
    await settle(100);
    expect(launches.filter(item => item.mode === "browser-restore-mark")).toHaveLength(sent);
    expect(lines.filter(line => line === "[browser] restore store could not note a visit; its saved copy is kept for the next run")).toHaveLength(logged);
  }
});

it("#3 a new host generation (idle exit, restarted without the relay) refreshes the snapshot: restored origins become eligible again", async () => {
  let clock = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  let answer = READY;
  const { launches, launch } = launcher({ "browser-restore": () => answer, "browser-restore-mark": MARKED });
  const native = createNativeBrowser({ command: "/nonexistent/engine", args: ["mcp"], env: env() }, { cloudLaunch: launch });
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/` } });
  await settle();
  expect(evals()).toBe(1);
  // Within the refresh interval nothing is asked again.
  clock += 30_000;
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/a` } });
  expect(launches.filter(item => item.mode === "browser-restore")).toHaveLength(1);
  // Same generation after the interval: this run's progress is kept, nothing is restored twice.
  clock += 61_000;
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/b` } });
  expect(launches.filter(item => item.mode === "browser-restore")).toHaveLength(2);
  expect(evals()).toBe(1);
  // The host idled out and the pump restarted it: a new generation, the origin is restored again and marked under it.
  answer = ready(GEN2);
  clock += 6 * 60_000;
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/c` } });
  await settle();
  expect(evals()).toBe(2);
  expect(launches.filter(item => item.mode === "browser-restore-mark").map(item => item.args)).toEqual([[GEN, ORIGIN], [GEN2, ORIGIN]]);
});

it("#4 a refresh drains queued marks first, and a stale mark refreshes at once without being sent again", async () => {
  let clock = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  let answer = READY;
  let mark = MARKED;
  const { launches, events, launch } = launcher({ "browser-restore": () => answer, "browser-restore-mark": () => mark }, { "browser-restore-mark": 150 });
  const native = createNativeBrowser({ command: "/nonexistent/engine", args: ["mcp"], env: env() }, { cloudLaunch: launch });
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/` } });
  // The mark is still in flight when the next refresh is due: the refresh waits for it.
  clock += 61_000;
  answer = ready(GEN2);
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: "https://elsewhere.example/" } });
  const markClosed = events.indexOf("closed browser-restore-mark");
  const secondRestore = events.indexOf("launch browser-restore", events.indexOf("launch browser-restore") + 1);
  expect(markClosed).toBeGreaterThanOrEqual(0);
  expect(secondRestore).toBeGreaterThan(markClosed);
  // Now the host restarts behind the relay's back: the next mark comes back stale ...
  mark = JSON.stringify({ state: "stale" });
  answer = ready("c3".repeat(16));
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/x` } });
  await settle(400);
  expect(launches.filter(item => item.mode === "browser-restore-mark").at(-1)!.args).toEqual([GEN2, ORIGIN]);
  const marks = launches.filter(item => item.mode === "browser-restore-mark").length;
  // ... so the very next request refreshes, inside the interval, and the stale mark is never re-sent.
  const before = launches.filter(item => item.mode === "browser-restore").length;
  await native.request("tools/call", { name: "agent_browser_get_url", arguments: {} });
  expect(launches.filter(item => item.mode === "browser-restore").length).toBe(before + 1);
  await settle(400);
  expect(launches.filter(item => item.mode === "browser-restore-mark").length).toBe(marks);
});

const ORIGIN2 = "https://other.example";

it("#3 a host restart inside the refresh window (an engine request failed) is re-synchronised before anything is restored", async () => {
  let clock = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  let answer = READY;
  const { launches, launch } = launcher({ "browser-restore": () => answer, "browser-restore-mark": MARKED });
  const native = createNativeBrowser({ command: "/nonexistent/engine", args: ["mcp"], env: env() }, { cloudLaunch: launch });
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/` } });
  await settle();
  expect(evals()).toBe(1);
  // The host dies and restarts under a new generation inside the 60 s window; the request that met it fails.
  engine.failOpen = "doomed.example";
  await expect(native.request("tools/call", { name: "agent_browser_open", arguments: { url: "https://doomed.example/" } })).rejects.toThrow();
  engine.failOpen = undefined;
  answer = ready(GEN2);
  clock += 10_000;
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/again` } });
  await settle();
  // The new generation's snapshot was fetched before choosing what to restore: the origin goes back into the new run.
  expect(launches.filter(item => item.mode === "browser-restore")).toHaveLength(2);
  expect(evals()).toBe(2);
  expect(launches.filter(item => item.mode === "browser-restore-mark").map(item => item.args)).toEqual([[GEN, ORIGIN], [GEN2, ORIGIN]]);
});

it("a transient refresh failure keeps the last valid snapshot: pending origins stay restorable", async () => {
  let clock = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  let answer: Answer = ready(GEN, { [ORIGIN]: STORAGE, [ORIGIN2]: STORAGE });
  const { launch } = launcher({ "browser-restore": () => answer, "browser-restore-mark": MARKED });
  const native = createNativeBrowser({ command: "/nonexistent/engine", args: ["mcp"], env: env() }, { cloudLaunch: launch });
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/` } });
  await settle();
  expect(evals()).toBe(1);
  // The periodic refresh fails (the engine state behind the snapshot is already stripped) ...
  answer = { code: 1 };
  clock += 61_000;
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/x` } });
  // ... and the origin not yet visited is still restored on its first visit.
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN2}/` } });
  await settle();
  expect(evals()).toBe(2);
});

it("a queue that gets `stale` is retired: one onStale, no more marks sent, and a replaced session's late answer is ignored", async () => {
  const stale = JSON.stringify({ state: "stale" });
  const twoOrigins = ready(GEN, { [ORIGIN]: STORAGE, [ORIGIN2]: STORAGE });
  const first = launcher({ "browser-restore": twoOrigins, "browser-restore-mark": stale });
  const flagged: unknown[] = [];
  const session = (await prepareCloudBrowserRestore(env(), undefined, first.launch, item => flagged.push(item)))!;
  session.restored(ORIGIN); session.restored(ORIGIN2);
  await session.drain();
  expect(flagged).toEqual([session]);
  expect(first.launches.filter(item => item.mode === "browser-restore-mark")).toHaveLength(1);
  // A session replaced while its mark is still in flight: the late answer flags nothing, and nothing more is sent.
  const second = launcher({ "browser-restore": twoOrigins, "browser-restore-mark": stale }, { "browser-restore-mark": 100 });
  const flagged2: unknown[] = [];
  const old = (await prepareCloudBrowserRestore(env(), undefined, second.launch, item => flagged2.push(item)))!;
  old.restored(ORIGIN); old.restored(ORIGIN2);
  await settle(20);
  old.retire();
  await settle(300);
  expect(flagged2).toEqual([]);
  expect(second.launches.filter(item => item.mode === "browser-restore-mark")).toHaveLength(1);
});

it("an old queue's late stale does not flag the new session: the one-minute throttle holds", async () => {
  let clock = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  let answer = READY;
  // Marks answer stale, slowly: the first generation's mark is still in flight when the next refresh drains.
  const { launches, launch } = launcher({ "browser-restore": () => answer, "browser-restore-mark": JSON.stringify({ state: "stale" }) }, { "browser-restore-mark": 100 });
  const native = createNativeBrowser({ command: "/nonexistent/engine", args: ["mcp"], env: env() }, { cloudLaunch: launch });
  await native.request("tools/call", { name: "agent_browser_open", arguments: { url: `${ORIGIN}/` } });
  await settle(200);
  // That stale flagged the session at once; the refresh it asks for replaces it with generation 2.
  answer = ready(GEN2);
  await native.request("tools/call", { name: "agent_browser_get_url", arguments: {} });
  await settle(200);
  const asked = launches.filter(item => item.mode === "browser-restore").length;
  // Now the second generation is current and nothing is stale: inside the window nothing asks again.
  clock += 5_000;
  await native.request("tools/call", { name: "agent_browser_get_url", arguments: {} });
  clock += 5_000;
  await native.request("tools/call", { name: "agent_browser_get_url", arguments: {} });
  expect(launches.filter(item => item.mode === "browser-restore").length).toBe(asked);
});
