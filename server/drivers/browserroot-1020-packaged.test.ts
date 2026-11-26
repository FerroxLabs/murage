// BROWSERROOT-1020 (Owners: this lane owns the relay's dropped-mount line and the browser proxy's start-failure line; the
// packaged layout stays with scripts/bundle-server.mjs). On the owner Mac every browser turn logs only
// "mount unavailable mount=browser cause=ipc" about 1 s after dispatch: the relay retired the transport, which silenced the
// child's exit and discarded its stderr, the one place a bundled proxy names its first failure. These witnesses run the
// BUNDLED proxy (esbuild output, ELECTRON_RUN_AS_NODE=1, stdio + IPC, as Resources/server ships it) through the real relay.
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { build } from "esbuild";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import type { SendTurnInput } from "../contracts.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { boundProxyState, boundTerminalReason, spawnBoundProxy } from "../testing/bound-proxy-fixture.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const stop = vi.hoisted(() => ({ confirmed: true }));
// The packaged layout: SPAWNED_PROXIES.unifiedBrowser IS the bundled file, so the admission issues it its release channel.
const layout = vi.hoisted(() => ({ out: `${process.env.TMPDIR ?? "/tmp"}/browserroot-bundle-${process.pid}-${Date.now()}` }));
vi.mock("../proxy-paths.ts", async original => {
  const real = await original<typeof import("../proxy-paths.ts")>();
  return { ...real, SPAWNED_PROXIES: Object.freeze({ ...real.SPAWNED_PROXIES, unifiedBrowser: `${layout.out}/drivers/unified-browser-proxy.js` }) };
});
vi.mock("../procs.ts", async original => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => stop.confirmed,
  cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));

let out = "", bundled = "";
beforeAll(async () => {
  out = layout.out; mkdirSync(out, { recursive: true });
  bundled = join(out, "drivers", "unified-browser-proxy.js");
  expect(SPAWNED_PROXIES.unifiedBrowser).toBe(bundled);
  // The packaged options of scripts/bundle-server.mjs for this entry point.
  const pluginPath = fileURLToPath(new URL("../../scripts/windows-hide-bundle-plugin.mjs", import.meta.url));
  const { windowsHideBundlePlugin } = await import(pluginPath) as { windowsHideBundlePlugin: () => import("esbuild").Plugin };
  await build({ entryPoints: [fileURLToPath(new URL("./unified-browser-proxy.ts", import.meta.url))], bundle: true, platform: "node", target: "node20",
    format: "esm", outbase: fileURLToPath(new URL("..", import.meta.url)), outdir: out, logLevel: "silent", external: ["@huggingface/transformers"],
    plugins: [windowsHideBundlePlugin()],
    banner: { js: 'import { createRequire as __harnessRequire } from "node:module"; const require = __harnessRequire(import.meta.url);' } });
}, 60_000);
afterAll(() => { if (out) rmSync(out, { recursive: true, force: true }); });
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function bundledBrowserMount(env: Record<string, string>) {
  const f = consumingFixture(undefined, { botId: randomUUID() }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  // The release verdict endpoint is closed: the proxy's first answer cannot be released.
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "isolated", warmIdentity: { botId: f.binding.identity.botId, audience: "owner" }, releaseBinding: f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  // The production launch shape (spawnMount): the command and args the relay was handed, its filtered env, stdio plus IPC.
  const launch = (command: string, args: string[], childEnv: Record<string, string>, cwd: string): ChildProcess => {
    const child = spawn(command, args, { env: childEnv, cwd, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    children.push(child); cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    return child;
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const relay = await CliMountRelay.create(turn, { browser: { command: process.execPath, args: [bundled], env: { ELECTRON_RUN_AS_NODE: "1", ...env } } }, {}, cred, launch);
  cleanups.push(() => relay.finish());
  const closed = new Promise<void>(resolve => children[0]!.once("close", () => resolve()));
  return { relay, child: children[0]!, closed, warn, lines: () => warn.mock.calls.map(call => String(call[0])) };
}
const browserEnv = (url: string) => ({ MURAGE_BOT_ID: "fixture-bot", MURAGE_THREAD_ID: "fixture-thread", MURAGE_CONTROL_TOKEN: "fixture-token", MURAGE_CONTROL_URL: url });

it("BROWSERROOT-START: a bundled browser proxy that dies at start names its exit code on the dropped-child line", async () => {
  // An unusable control URL: the proxy cannot start, exactly as an unknown Mac-only start failure would end it.
  const x = await bundledBrowserMount(browserEnv("not a url"));
  await x.closed;
  await vi.waitFor(() => expect(x.relay.mountUnavailable("browser")).toBe(true));
  // INT-N9 rebase on B9 (Fable #12 rule): the relay keeps the B9 dropped-child line, code words only; its stderr words name
  // "[consuming] swallowed error" sites, so a start failure reads as its exit code here.
  const ended = x.lines().find(line => line.startsWith("[mount-relay] dropped mount child closed mount=\"browser\""));
  expect(ended, x.lines().join("\n")).toBeDefined();
  expect(ended).toContain(" code=1 signal=- ");
}, 30_000);

it("BROWSERROOT-TERMINAL: a bundled proxy's terminal names its reason on the drop line and its first refusing site from stderr", async () => {
  const x = await bundledBrowserMount(browserEnv("http://127.0.0.1:1/api/internal/computer-control?botId=fixture-bot"));
  const socket = connect(x.relay.socketPath); cleanups.push(() => { socket.destroy(); });
  socket.on("error", () => {}); await once(socket, "connect");
  socket.write(JSON.stringify({ ticket: x.relay.ticket, server: "browser" }) + "\n");
  socket.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) + "\n");
  await vi.waitFor(() => expect(x.relay.mountUnavailable("browser"), x.lines().join("\n")).toBe(true), { timeout: 15_000 });
  expect(x.lines()).toContain("[mount-relay] mount unavailable mount=\"browser\" cause=ipc reason=verdict-failed");
  // The relay stops a dropped child itself (mocked here); the line follows the child's close.
  x.child.kill("SIGTERM"); await x.closed;
  const ended = x.lines().find(line => line.startsWith("[mount-relay] dropped mount child closed mount=\"browser\""));
  expect(ended, x.lines().join("\n")).toBeDefined();
  expect(ended).toMatch(/ stderr=(?:\S*,)?proxy\.release\//);
}, 30_000);

it("BROWSERROOT-DISCOVER: the bundled browser proxy answers Claude Code's opening server/discover probe itself and keeps its tools", async () => {
  // Stand-in for /api/internal/unified-browser: tools/list answers; any other method is what the real route gives it
  // (UnifiedBrowserController.dispatch throws "Unsupported browser method" and the route rethrows it: an uncoded 500).
  const methods: string[] = [];
  const route = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const rpc = JSON.parse(body) as { method?: string }; methods.push(String(rpc.method));
    if (rpc.method === "tools/list") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ tools: [{ name: "agent_browser_open", description: "Open", inputSchema: { type: "object" } }] })); return; }
    res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Unsupported browser method" }));
  });
  await new Promise<void>(resolve => route.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { route.closeAllConnections(); route.close(() => resolve()); }));
  const child = await spawnBoundProxy("unifiedBrowser", process.execPath, [bundled], { stdio: ["pipe", "pipe", "pipe"],
    env: browserEnv(`http://127.0.0.1:${(route.address() as AddressInfo).port}/api/internal/computer-control?botId=fixture-bot`) });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  // The opening sequence the real Claude Code CLI sends every MCP server, in order.
  child.stdin.write([{ jsonrpc: "2.0", id: "server-discover-probe-1", method: "server/discover", params: {} },
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }].map(frame => JSON.stringify(frame) + "\n").join(""));
  await vi.waitFor(() => {
    expect(boundTerminalReason(child), `terminal; stderr: ${stderr}`).toBeUndefined();
    expect(stdout.trim().split("\n").filter(Boolean)).toHaveLength(3);
  }, { timeout: 15_000 });
  const replies = stdout.trim().split("\n").map(line => JSON.parse(line) as { id: unknown; error?: { code: number }; result?: { tools?: Array<{ name: string }> } });
  expect(replies.find(reply => reply.id === "server-discover-probe-1")?.error?.code).toBe(-32601);
  expect(replies.find(reply => reply.id === 1)?.result?.tools?.map(tool => tool.name)).toEqual(["agent_browser_open"]);
  expect(boundProxyState(child)).toEqual({ sealed: false, refusals: 0 });
  // The probe never reaches the browser route.
  expect(methods).toEqual(["tools/list"]);
}, 30_000);
