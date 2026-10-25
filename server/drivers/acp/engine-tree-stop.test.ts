// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U24 T11, behavioural (Astra re-review Medium 2; engine-pid-sites.test.ts is the source gate beside it). On Windows the
// ACP root child is the job launcher and the engine CLI is its child, so child.pid is not the engine. Here every engine
// spawn goes through a launcher stand-in (testing/fake-job-launcher.fixture.mjs) in front of the shared fake ACP CLI,
// so the launcher and CLI pids differ on every OS, and the process-tree probe is injected (wrapped, still the real
// listing) to record which pid each probe was asked about. Covered:
//   - every tree probe a pooled process gets (turn baseline, park check, reused-tree reconcile) asks about the CLI,
//     never the launcher;
//   - reconcileReusedTree admits the MCP child an engine replaces each turn, whose parent is the CLI, so a pooled
//     process is kept (one spawn over four replacing turns), never closed as a pre-prompt leftover;
//   - a mid-turn Stop ends the whole tree: the launcher, the CLI and the CLI's own MCP child, pooled and per turn.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { createAcpDriver, resetAcpMcpReadinessForTests, type AcpSupport } from "./core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(HERE, "..", "..", "testing", "fake-acp-cli.ts");
const LAUNCHER = join(HERE, "..", "..", "testing", "fake-job-launcher.fixture.mjs");

/** launcher pid -> engine CLI pid, as the launcher stand-in reports them (FAKE_LAUNCHER_LOG). */
const launch = vi.hoisted(() => ({ log: "", fakeCli: "" }));
const launched = (): Map<number, number> => {
  if (!launch.log || !existsSync(launch.log)) return new Map();
  return new Map(readFileSync(launch.log, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ").map(Number) as [number, number]));
};
// The engine spawn goes through the launcher stand-in; engineProcessPid answers what the real one answers on Windows
// (cliProcessPid from the launcher's report, else the child's own pid). Everything else in procs.ts is the real code.
vi.mock("../../procs.ts", async (original) => {
  const actual = await original<typeof import("../../procs.ts")>();
  return {
    ...actual,
    spawnCli: (...args: Parameters<typeof actual.spawnCli>) => {
      const [cli, argv, opts, job, mode] = args;
      if (cli !== launch.fakeCli) return actual.spawnCli(...args);
      return actual.spawnCli(process.execPath, [LAUNCHER, cli, ...argv], opts, job, mode);
    },
    engineProcessPid: (child: import("node:child_process").ChildProcess) => (child.pid === undefined ? undefined : launched().get(child.pid) ?? child.pid),
  };
});
/** The injected process-tree probe: the real listing, with the root pid of every call recorded. */
const probed = vi.hoisted(() => ({ roots: [] as number[] }));
vi.mock("../process-tree.ts", async (original) => {
  const actual = await original<typeof import("../process-tree.ts")>();
  return {
    ...actual,
    descendantIdentities: (root: number) => { probed.roots.push(root); return actual.descendantIdentities(root); },
    untrackedIdentified: (root: number, ...rest: unknown[]) => {
      probed.roots.push(root);
      return (actual.untrackedIdentified as (root: number, ...rest: unknown[]) => ReturnType<typeof actual.untrackedIdentified>)(root, ...rest);
    },
  };
});

const SUPPORT: AcpSupport = {
  driverKind: "treeStopTest",
  displayName: "Tree Stop Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: "fake-tree-stop",
  nativeSource: "treestop.acp",
  loginNote: "never reached",
  spawnArgs: (_config, turn) => ["agent", ...(turn.model ? ["-m", turn.model] : []), "stdio"],
  pickAuthMethod: (methods) => methods[0]?.id ?? null,
  authFailure: "continue",
  isAuthenticated: () => true,
  mcpReadyNotification: "_fuigo/mcp_initialized",
  pooledSessions: true,
};
const PooledDriver = createAcpDriver(SUPPORT);
const PerTurnDriver = createAcpDriver({ ...SUPPORT, driverKind: "treeStopPerTurnTest", pooledSessions: false });
const SESSION = "fake-acp-session";

const zombie = (pid: number) => {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false;
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  return process.platform === "win32" || !zombie(pid);
};
async function until(check: () => boolean, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The pool is off on Windows (acpPoolingEnabled) and Windows has no argv probe, so the reconcile half runs on macOS and
// Linux, as pool.test.ts does; the real job launcher on Windows is proven on the gate box (U24 lane record).
describe.skipIf(process.platform === "win32")("ACP Stop ends the whole tree behind a launcher (U24 T11)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let scratch: string;
  let spawnLog: string;
  let mcpLog: string;
  let infoLines: string[] = [];
  let infoSpy: ReturnType<typeof vi.spyOn> | undefined;
  const logged = (text: string) => infoLines.some((line) => line.includes(text));
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const cliPids = () => lines(spawnLog);
  const mcpChildren = () => lines(mcpLog);
  const create = async (driver = PooledDriver) => {
    instance = await driver.create({ instanceId: "tree-stop", displayName: "Tree Stop", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
  };
  /** An MCP server the fake really runs as its own child (`sleep 300`), with a fresh token per turn, so it is replaced. */
  const mcpAgents = (): NonNullable<SendTurnInput["integrations"]> => ({
    agents: { command: "sleep", args: ["300"], env: { MURAGE_COMMS_TOKEN: `turn-${randomUUID()}` } },
  });
  const turn = async (input: Omit<SendTurnInput, "threadId">) => {
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-tree", ...input });
    return (await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)) as Extract<RuntimeEvent, { type: "turn.completed" }>;
  };
  /** Every probe so far asked about an engine CLI, and none about a launcher. */
  const probesSawOnlyTheCli = () => {
    const map = launched();
    const launchers = new Set(map.keys());
    const clis = new Set(map.values());
    expect(probed.roots.length).toBeGreaterThan(0);
    expect(probed.roots.filter((root) => launchers.has(root))).toEqual([]);
    expect(probed.roots.every((root) => clis.has(root))).toBe(true);
  };
  /** Stop mid-turn, then: the launcher, the CLI and every MCP child it ran are gone. */
  const stopMidTurnEndsTree = async (input: Omit<SendTurnInput, "threadId" | "text">) => {
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-tree", ...input, text: "go __fixture_cancel_ack__" });
    await recorder.until((event) => event.type === "content.delta" && event.turnId === turnId);
    const tree = [...launched().entries()].flat().concat(mcpChildren());
    expect(tree.some((pid) => alive(pid))).toBe(true);
    await expect(instance!.adapter.interruptTurn("t-tree", turnId)).resolves.toEqual({ closeConfirmed: true });
    expect(await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ stopReason: "cancelled" });
    await until(() => tree.every((pid) => !alive(pid)), "the launcher, the engine CLI and its MCP children to exit");
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-acp-tree-"));
    spawnLog = join(scratch, "spawns.log");
    mcpLog = join(scratch, "mcp-children.log");
    launch.log = join(scratch, "launcher.log");
    launch.fakeCli = FAKE_CLI;
    probed.roots = [];
    process.env.FAKE_LAUNCHER_LOG = launch.log;
    process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
    process.env.FAKE_ACP_MCP_CHILD_LOG = mcpLog;
    process.env.FAKE_ACP_MCP_READY = "1";
    process.env.MURAGE_ACP_POOL = "1";
    infoLines = [];
    infoSpy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { infoLines.push(args.map(String).join(" ")); });
  });
  afterEach(async () => {
    resetAcpMcpReadinessForTests();
    for (const name of ["FAKE_LAUNCHER_LOG", "FAKE_ACP_SPAWN_LOG", "FAKE_ACP_MCP_CHILD_LOG", "FAKE_ACP_MCP_READY", "MURAGE_ACP_POOL"]) delete process.env[name];
    infoSpy?.mockRestore();
    recorder?.stop();
    const tree = [...launched().entries()].flat().concat(mcpChildren());
    await instance?.dispose();
    instance = undefined;
    await until(() => tree.every((pid) => !alive(pid)), "every process the test started to exit");
    launch.fakeCli = "";
    await removeTempDir(scratch);
  });

  it("pooled: the probes ask about the CLI, a replaced MCP child (parent: the CLI) is admitted, and a Stop ends the tree", async () => {
    await create();
    expect(await turn({ text: "one", integrations: mcpAgents() })).toMatchObject({ ok: true });
    for (const text of ["two", "three", "four"]) {
      expect(await turn({ text, resumeCursor: SESSION, integrations: mcpAgents() })).toMatchObject({ ok: true });
    }
    // one launcher, one CLI behind it, and they are different processes
    const map = launched();
    expect(map.size).toBe(1);
    const [[launcherPid, cliPid]] = [...map.entries()];
    expect(launcherPid).not.toBe(cliPid);
    expect(cliPids()).toEqual([cliPid]);
    // four replacing turns on one process: every reconcile admitted the CLI's new MCP child
    expect(mcpChildren()).toHaveLength(4);
    expect(logged("reason=pre-prompt-leftover")).toBe(false);
    expect(logged("reason=post-turn-descendant")).toBe(false);
    probesSawOnlyTheCli();
    await stopMidTurnEndsTree({ resumeCursor: SESSION, integrations: mcpAgents() });
    expect(cliPids()).toEqual([cliPid]);
  });

  it("per turn (the Windows default): a mid-turn Stop ends the launcher, the CLI and the CLI's MCP child", async () => {
    await create(PerTurnDriver);
    expect(await turn({ text: "one", integrations: mcpAgents() })).toMatchObject({ ok: true });
    await stopMidTurnEndsTree({ integrations: mcpAgents() });
    expect(launched().size).toBe(2);
    for (const [launcherPid, cliPid] of launched()) expect(launcherPid).not.toBe(cliPid);
  });
});
