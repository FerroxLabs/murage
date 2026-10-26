// SPDX-License-Identifier: AGPL-3.0-or-later
// rig581: the browser daemon must outlive each one-shot command yet stay contained and be cleaned up.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createChildSpawner, createUiCanary } from "./ui-canary.ts";
import { canaryReason, createCloudUiLauncher } from "./ui-canary-browser.ts";

vi.mock("./browser-process.ts", () => ({
  cleanupCanaryBrowser: vi.fn(async () => {}), cleanupCloudBrowser: vi.fn(async () => {}),
  spawnCanaryBrowser: vi.fn(() => null), spawnCloudBrowser: vi.fn(() => null),
}));

const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const fixture = fileURLToPath(new URL("./browser-session-host.fixture.py", import.meta.url));
const EXECS_THROUGH_EXEC_SLOT = new Set(["three-invocations", "old-path-and-expiry", "idle-and-cap", "host-exits", "single-start", "rogue"]);
afterEach(() => vi.unstubAllEnvs());

for (const scenario of ["three-invocations", "old-path-and-expiry", "ensure-host", "spawn-host", "contract", "idle-and-cap", "host-exits", "single-start", "rogue", "sandbox-cgroup", "mcp-idle", "mcp-gate", "pump-death", "close-deadline", "relay"]) {
  // the real launcher's session host: O_PATH, /proc and Linux AF_UNIX path lengths (Python has no os.O_PATH elsewhere)
  // These scenarios run the host's warm-up client and relay through the launcher's exec_slot in this process, as the test user; the
  // guard refuses uid 0 (LANE-G r3 sec. 1.3: no slot-capable exec as root), so under a root test run they are left to unprivileged runners.
  it.skipIf(process.platform !== "linux" || (process.getuid?.() === 0 && EXECS_THROUGH_EXEC_SLOT.has(scenario)))(`session host: ${scenario}`, () => {
    expect(execFileSync("python3", ["-I", fixture, launcher, scenario], { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] })).toBe(`OK ${scenario}\n`);
  }, 100_000);
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, any>;
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 4242, kill: vi.fn(() => true) });
  return child as unknown as Omit<import("node:child_process").ChildProcessWithoutNullStreams, "stdout" | "stderr"> & { stdout: PassThrough; stderr: PassThrough };
}
const fail = (child: ReturnType<typeof fakeChild>, text: string, code: number) => queueMicrotask(() => { child.stderr.write(text); setImmediate(() => child.emit("close", code)); });

it("maps only the launcher's fixed refusal sentences to reason codes; anything else is 'other'", () => {
  expect(canaryReason("Cloud browser session is not running")).toBe("session-not-running");
  expect(canaryReason("Cloud browser session did not start")).toBe("session-did-not-start");
  expect(canaryReason("Cloud browser relay could not reach its endpoint (endpoint lookup failed)")).toBe("endpoint-lookup-failed");
  expect(canaryReason("Cloud browser relay could not reach its endpoint (connect refused)")).toBe("connect-refused");
  expect(canaryReason("Cloud browser is busy")).toBe("busy");
  expect(canaryReason("Cloud turn launcher refused the request")).toBe("launcher-refused");
  for (const text of ["", "token=abc /data/home/x", "Cloud browser session is not running secret"]) expect(canaryReason(text)).toBe("other");
});

it("a cdp-url step refused for a dead session names the step and reason in the one-line log", async () => {
  const log = vi.fn();
  const canary = createUiCanary({
    launcher: createCloudUiLauncher("/unused", { proxyGet: async () => { throw new Error("no"); } }),
    makeSpawner: (signal: AbortSignal) => createChildSpawner((args): never => {
      const child = fakeChild();
      if (args.includes("open")) queueMicrotask(() => child.emit("close", 0));
      else if (args.includes("cdp-url")) fail(child, "Cloud browser session is not running\n", 77);
      else queueMicrotask(() => child.emit("close", 0));
      return child as never;
    }, signal),
    cleanup: async () => {}, publishInstance: () => {}, log,
  } as never);
  expect(await canary.runOnce()).toBe("failed");
  const line = log.mock.calls.map(c => c[0]).join("\n");
  expect(line).toContain("launch gen=1 result=failed error=cdp-url-session-not-running");
  expect(line).toMatch(/^\[ui-canary\] [a-z0-9= -]+$/);
});

it("an open that fails with free text logs only its step and exit code, never the text", async () => {
  const run = createCloudUiLauncher("/unused", { proxyGet: async () => { throw new Error("no"); } });
  const spawner = createChildSpawner((args): never => { const child = fakeChild(); if (args.includes("open")) fail(child, "Error: secret-token /data/home/x\n", 1); return child as never; }, new AbortController().signal);
  const error = await run({ path: "/", userAgent: "ua", signal: new AbortController().signal, spawner }).then(() => undefined, e => e);
  expect(error.canaryCode).toBe("open-exit-1");
  expect(JSON.stringify(error.canaryCode)).not.toContain("secret");
});

it("a relay that exits with the launcher's refusal text reports relay-<reason>, not a bare close", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const run = createCloudUiLauncher("/unused", { proxyGet: async () => { throw new Error("no"); } });
  const spawner = createChildSpawner((args): never => {
    const child = fakeChild();
    if (args.includes("open")) queueMicrotask(() => child.emit("close", 0));
    else if (args.includes("cdp-url")) queueMicrotask(() => { child.stdout.write(JSON.stringify({ data: "ws://127.0.0.1:9/devtools/browser/x" })); setImmediate(() => child.emit("close", 0)); });
    else if (args[0] === "relay") queueMicrotask(() => { child.stderr.write("Cloud browser session is not running\n"); setImmediate(() => { child.stdout.end(); child.emit("close", 77); }); });
    return child as never;
  }, new AbortController().signal);
  const error = await run({ path: "/", userAgent: "ua", signal: new AbortController().signal, spawner }).then(() => undefined, e => e);
  expect(error?.canaryCode).toBe("relay-session-not-running");
});
