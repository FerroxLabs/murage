// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CANARY_BROWSER_ID, isReservedBotId, RESERVED_BOT_ID_PREFIX } from "../../shared/bot-identity.ts";

// A fake `sudo` launcher: records the request the app writes on fd 3 and exits 0 once the pipe is read.
const sent: { command: string; request: any }[] = [];
let exitCode = 0;
vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string) => {
    const child = new EventEmitter() as EventEmitter & Record<string, any>;
    const pipe = new PassThrough(); let text = "";
    pipe.on("data", chunk => { text += chunk.toString(); });
    pipe.on("end", () => { sent.push({ command, request: JSON.parse(text) }); setImmediate(() => child.emit("close", exitCode)); });
    Object.assign(child, { stdio: [null, null, null, pipe], stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true), pid: 1 });
    return child;
  }),
}));
const published: string[] = [];
vi.mock("./server-instance.ts", async importOriginal => ({ ...(await importOriginal<typeof import("./server-instance.ts")>()), ensureServerInstancePublished: vi.fn(() => { published.push("published"); }) }));
const { SERVER_INSTANCE } = await import("./server-instance.ts");
const { CLOUD_BROWSER_BOT, BROWSER_REFUSAL_LOG_INTERVAL_MS, browserLaunchFailure, noteBrowserRefusal, resetBrowserRefusalLogForTests, spawnCloudBrowser, canaryBrowserRequest, cleanupCanaryBrowser, cleanupCloudBrowser, cloudBrowserRequest, spawnCanaryBrowser } = await import("./browser-process.ts");
const { createSupervisorPort } = await import("./supervisor-port.ts");
const childProcess = await import("node:child_process");
const UUID = "0b9f4f0e-3c1d-4f6e-9a55-6f0f4f1e2a10";

beforeEach(() => { exitCode = 0; sent.length = 0; published.length = 0; vi.mocked(childProcess.spawn).mockClear(); });
afterEach(() => vi.unstubAllEnvs());

it("the reserved namespace is one prefix and the canary id lives inside it", () => {
  expect(RESERVED_BOT_ID_PREFIX).toBe("__murage-");
  expect(CANARY_BROWSER_ID).toBe("__murage-ui-canary"); expect(CANARY_BROWSER_ID.length).toBe(18);
  expect(isReservedBotId(CANARY_BROWSER_ID)).toBe(true); expect(isReservedBotId("ui-canary")).toBe(false); expect(isReservedBotId(UUID)).toBe(false);
  expect(/^[\w-]{1,64}$/.test(CANARY_BROWSER_ID)).toBe(true);   // valid for the root launcher's identity pattern
});
it("T14 a bot's browser request and cleanup refuse reserved ids and accept a UUID and ui-canary", async () => {
  for (const bot of [CANARY_BROWSER_ID, "__murage-x", "__murage-"]) {
    expect(() => cloudBrowserRequest([], { [CLOUD_BROWSER_BOT]: bot })).toThrow("Invalid cloud browser identity");
    await expect(cleanupCloudBrowser(bot)).rejects.toThrow("Invalid cloud browser identity");
  }
  expect(sent).toEqual([]); expect(childProcess.spawn).not.toHaveBeenCalled();
  for (const bot of [UUID, "ui-canary"]) {
    expect(cloudBrowserRequest(["--version"], { [CLOUD_BROWSER_BOT]: bot })).toMatchObject({ mode: "browser", bot });
    await cleanupCloudBrowser(bot);
  }
  expect(sent.map(item => item.request)).toEqual([{ mode: "browser-cleanup", bot: UUID }, { mode: "browser-cleanup", bot: "ui-canary" }]);
});
it("T15 the canary spawn and cleanup name only the canary, even with a forged bot in env", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  expect(canaryBrowserRequest(["--version"], { [CLOUD_BROWSER_BOT]: UUID, AGENT_BROWSER_SESSION: "s" })).toMatchObject({ mode: "browser", bot: CANARY_BROWSER_ID, settings: { AGENT_BROWSER_SESSION: "s" } });
  const child = spawnCanaryBrowser(["--version"], { [CLOUD_BROWSER_BOT]: UUID });
  expect(child).not.toBeNull();
  await vi.waitFor(() => expect(sent.length).toBe(1));
  expect(sent[0]!.request).toMatchObject({ mode: "browser", bot: CANARY_BROWSER_ID, args: ["--version"] });
  await cleanupCanaryBrowser();
  expect(sent[1]!.request).toEqual({ mode: "browser-cleanup", bot: CANARY_BROWSER_ID });
  expect(sent.every(item => item.command === "/usr/bin/sudo")).toBe(true);
  // A desktop never starts the canary's browser.
  vi.stubEnv("MURAGE_CLOUD_ROLE", ""); expect(spawnCanaryBrowser([], {})).toBeNull();
});
it("T16 supervisor-port cleanup of a reserved id is refused, for one bot and for a list", async () => {
  const results: any[] = [];
  const port = createSupervisorPort({ store: { getAll: () => ({}), patch: (value: never) => value } as never, send: (message: unknown) => { results.push(message); return true; } } as never);
  await port.handle({ type: "murage:browser-bot-deleted", requestId: "one", botId: CANARY_BROWSER_ID });
  await port.handle({ type: "murage:browser-profile-deleted", requestId: "many", cloudBotIds: [UUID, CANARY_BROWSER_ID] });
  expect(results.filter(r => r.type === "murage:browser-lifecycle-result").map(r => r.ok)).toEqual([false, false]);
  expect(sent.some(item => item.request.bot === CANARY_BROWSER_ID)).toBe(false);
});
it("r6 a cleanup refused because the root lock is held rejects as busy, never resolves clean", async () => {
  exitCode = 75;
  await expect(cleanupCanaryBrowser()).rejects.toMatchObject({ busy: true });
  exitCode = 1;
  await expect(cleanupCanaryBrowser()).rejects.toMatchObject({ busy: false });
});

it("r7 every browser launch request carries this server's instance, bots and canary alike, and the instance is published before the spawn", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  expect(SERVER_INSTANCE).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(cloudBrowserRequest(["--version"], { [CLOUD_BROWSER_BOT]: UUID })).toMatchObject({ mode: "browser", instance: SERVER_INSTANCE });
  expect(canaryBrowserRequest(["--version"], {})).toMatchObject({ mode: "browser", bot: CANARY_BROWSER_ID, instance: SERVER_INSTANCE });
  spawnCanaryBrowser(["--version"], {});
  expect(published).toEqual(["published"]);
  expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(sent[0]!.request.instance).toBe(SERVER_INSTANCE));
  // Cleanup requests are not fenced: they come from the current server by definition.
  await cleanupCanaryBrowser();
  expect(sent[1]!.request).toEqual({ mode: "browser-cleanup", bot: CANARY_BROWSER_ID });
});
it("r7 exit 76 is a plain, retryable failed launch; other codes are not mapped", () => {
  expect(browserLaunchFailure(76)?.message).toMatch(/Try again/);
  for (const code of [0, 1, 75, 124, null]) expect(browserLaunchFailure(code)).toBeNull();
});

it("r7 a bot launch refused for a stale instance logs one plain line, rate-bounded to one per minute, and only for exit 76", () => {
  resetBrowserRefusalLogForTests();
  const log = vi.fn();
  expect(noteBrowserRefusal(75, log, 0)).toBe(false); expect(noteBrowserRefusal(0, log, 0)).toBe(false); expect(noteBrowserRefusal(null, log, 0)).toBe(false);
  expect(noteBrowserRefusal(76, log, 1_000_000)).toBe(true);
  for (let i = 1; i < 100; i++) expect(noteBrowserRefusal(76, log, 1_000_000 + i * 100)).toBe(false);
  expect(noteBrowserRefusal(76, log, 1_000_000 + BROWSER_REFUSAL_LOG_INTERVAL_MS)).toBe(true);
  expect(log.mock.calls).toEqual([["[browser] launch refused: server restarted"], ["[browser] launch refused: server restarted"]]);
});
it("r7 spawnCloudBrowser wires the exit-76 line to stderr", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); exitCode = 76; resetBrowserRefusalLogForTests();
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  spawnCloudBrowser(["--version"], { [CLOUD_BROWSER_BOT]: UUID });
  await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("[browser] launch refused: server restarted"));
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});
