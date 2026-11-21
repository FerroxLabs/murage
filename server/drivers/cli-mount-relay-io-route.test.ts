// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.20 winrelay: an owned MCP proxy's io receipts reach the mount relay on both launch routes without sealing it.
// darwin/linux: the server spawns the proxy itself and observes the proxy's own generation.
// win32: spawnCli puts every server-owned mount in a job through the real job launcher (procs.ts `contained`), so the
// server observes the LAUNCHER's generation while the launcher's own meter observes the proxy under a fresh one. The
// launcher once forwarded those proxy receipts, and the relay sealed every Windows turn on the first one.
// Every process below is real: this worker's launch meter, the real launcher with the real io preload, and an owned
// proxy fixture whose first receipt is the preload's own. Unrelated IPC from the proxy must still seal the relay.
// win32-packaged (1.0.20 winrelay2): the release build runs bundled entries (scripts/bundle-server.mjs), so inside the
// launcher process the io preload (io-child-bootstrap.js) and job-launcher.js each inline their own copy of
// sentinel/io-child-receipts. The preload's meter observed the proxy; the launcher's forward check consulted its own,
// empty copy and forwarded the proxy's receipts, sealing every mount (agents, murage_connectors, murage-memory) on
// real Windows. This route runs exactly those three bundles, built per entry like the release build.
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { windowsHideBundlePlugin } from "../../scripts/windows-hide-bundle-plugin.mjs";
import { windowsHideImport } from "../../shared/win-hide-child-process.mjs";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { installChildProcessMeter, registerOwnedChildForTest } from "../io-child-meter.ts";
import { observeChildIo, ownedChildIoBytes } from "../sentinel/io-child-receipts.ts";
import { launcherEnvironment, launcherFrame } from "../procs.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import type { SendTurnInput } from "../contracts.ts";

vi.mock("../procs.ts", async original => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => true, cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
const { CliMountRelay } = await import("./cli-mount-relay.ts");

const LAUNCHER = fileURLToPath(new URL("../job-launcher.ts", import.meta.url));
const PROXY = fileURLToPath(new URL("../testing/relay-io-proxy.fixture.ts", import.meta.url));
const REGISTER = pathToFileURL(fileURLToPath(new URL("../testing/relay-io-register.fixture.ts", import.meta.url))).href;
installChildProcessMeter();
registerOwnedChildForTest("testing/relay-io-proxy.fixture");

const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

// Separate entries, bundled like scripts/bundle-server.mjs `main`: no code splitting, so shared leaves are inlined per entry.
const SERVER = fileURLToPath(new URL("..", import.meta.url));
let packaged = "";
beforeAll(async () => {
  packaged = mkdtempSync(join(tmpdir(), "relay-io-packaged-"));
  await build({
    entryPoints: ["job-launcher.ts", "io-child-bootstrap.ts", "testing/relay-io-proxy.fixture.ts", "testing/relay-io-register.fixture.ts"].map(entry => join(SERVER, entry)),
    bundle: true, platform: "node", target: "node20", format: "esm", outbase: SERVER, outdir: packaged, logLevel: "silent",
    plugins: [windowsHideBundlePlugin()],
    banner: { js: windowsHideImport + 'import { createRequire as __harnessRequire } from "node:module"; const require = __harnessRequire(import.meta.url);' },
  });
}, 60_000);
afterAll(() => { if (packaged) removeTempDirSync(packaged); });

type Route = "win32" | "win32-packaged" | "darwin";
function launchPackaged(dir: string, mode: string): ChildProcess {
  // The packaged server's meter gives the launcher a fresh generation and the bundled io preload, then observes it.
  const generation = randomUUID();
  const child = spawn(process.execPath, [`--import=${pathToFileURL(join(packaged, "testing/relay-io-register.fixture.js")).href}`,
    `--import=${pathToFileURL(join(packaged, "io-child-bootstrap.js")).href}`, join(packaged, "job-launcher.js"),
    "--", process.execPath, join(packaged, "testing/relay-io-proxy.fixture.js"), dir, mode], {
    cwd: dir, env: { ...launcherEnvironment(process.env), PATH: process.env.PATH ?? "", NODE_ENV: "test", MURAGE_IO_CHILD: "1", MURAGE_IO_GENERATION: generation },
    stdio: ["pipe", "pipe", "pipe", "pipe", "ipc"],
  });
  observeChildIo(child, generation);
  return child;
}
function launch(route: Route, dir: string, mode: string): ChildProcess {
  const child = route === "win32-packaged" ? launchPackaged(dir, mode) : route === "darwin"
    ? spawn(process.execPath, [PROXY, dir, mode], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe", "ipc"] })
    // procs.ts startLauncher for an admitted proxy: the fixed launcher environment, fd 3 status, fd 4 IPC, then the frame.
    : spawn(process.execPath, [`--import=${REGISTER}`, LAUNCHER, "--", process.execPath, PROXY, dir, mode], {
      cwd: dir, env: { ...launcherEnvironment(process.env), PATH: process.env.PATH ?? "", NODE_ENV: "test" },
      stdio: ["pipe", "pipe", "pipe", "pipe", "ipc"],
    });
  if (route !== "darwin") {
    (child.stdio[3] as NodeJS.ReadableStream).resume();
    child.stdin!.write(launcherFrame({ PATH: process.env.PATH ?? "", MURAGE_RELEASE_INSTANCE: "fixture" }, dir, true));
  }
  cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  return child;
}

async function relayFor(route: Route, mode: string) {
  const f = consumingFixture(undefined, { botId: randomUUID() }); cleanups.push(() => f.close());
  const caps = new InternalCapabilities(); caps.begin(f.binding.identity.botId, f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: f.turn.threadId, text: "isolated", warmIdentity: { botId: f.binding.identity.botId, audience: "owner" }, releaseBinding: f.binding, mountAdmission: admission };
  const dir = mkdtempSync(join(tmpdir(), "relay-io-route-")); cleanups.push(() => removeTempDirSync(dir));
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
  let child: ChildProcess | undefined;
  const relay = await CliMountRelay.create(turn, { one: { command: "fixture-mcp", args: [], env: {} } }, {}, cred,
    () => (child = launch(route, dir, mode)));
  cleanups.push(() => relay.finish());
  let stderr = "";
  child!.stderr!.on("data", chunk => { stderr += String(chunk); });
  await expect.poll(() => stderr, { timeout: 15_000 }).toContain("fixture-proxy-written");
  // The proxy's first receipt left before its write; give it the same margin to cross the launcher hop.
  await new Promise(resolve => setTimeout(resolve, 500));
  return { f, relay, child: child!, warnings, sealed: () => relay.mounts.get("one")!.mount.ingress.sealed };
}

it.each<Route>(["win32", "win32-packaged", "darwin"])("WINRELAY %s route: the owned proxy's receipts never seal the relay and its bytes still reach the server meter", async route => {
  const before = ownedChildIoBytes();
  const x = await relayFor(route, "clean");
  const ipcSeal = () => x.warnings.filter(line => line.includes("mount ipc message seals the relay"));
  expect(ipcSeal(), "a valid io receipt is metering, not an unknown application message").toEqual([]);
  expect(x.sealed()).toBe(false);
  expect(x.f.refusals).toBe(0);
  // Closing stdin ends the proxy: its final receipt is acknowledged by its own observer, then (win32) the launcher seals
  // its own final with the proxy's bytes included.
  const exited = once(x.child, "exit");
  x.child.stdin!.end();
  expect((await exited)[0]).toBe(0);
  await expect.poll(() => ownedChildIoBytes() - before, { timeout: 5_000 }).toBeGreaterThanOrEqual(8192);
  expect(ipcSeal(), "final receipts and acknowledgements are metering too").toEqual([]);
});

it.each<[Route, string, string]>([
  ["win32", "unknown", "type=fixture-unknown"], ["darwin", "unknown", "type=fixture-unknown"],
  ["win32", "foreign-io", "type=io"], ["darwin", "foreign-io", "type=io"],
  ["win32-packaged", "unknown", "type=fixture-unknown"], ["win32-packaged", "foreign-io", "type=io"],
])("WINRELAY %s route: an unrelated IPC frame (%s) from the proxy still seals the relay", async (route, mode, type) => {
  const x = await relayFor(route, mode);
  expect(x.warnings.filter(line => line.includes("mount ipc message seals the relay"))).toEqual([
    expect.stringContaining(type),
  ]);
  expect(x.sealed()).toBe(true);
  expect(x.f.refusals).toBe(1);
});
