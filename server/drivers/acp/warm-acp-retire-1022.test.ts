// WARM W1 r3.5 (designs/WARM-W1-1022-r3.5.md), the ACP rows of WARM-1022-CODEX: the W1 receipt for the Fuigo row is F8 retire
// before handoff. A mounted ACP process is never handed to a next dispatch, `warm.s2r` ON or OFF and whatever prompt-scope capability
// the agent advertises (ACP reuse belongs to design-1022-grokwarm, GROKWARM COORD C1-C6). Real ACP core, real relay, real fake-ACP
// processes counted by FAKE_ACP_SPAWN_LOG / FAKE_ACP_RPC_LOG.
// Cells: W-FG2 r3.4 (i''') + M-FG12, W-FG1, W-FLAG (ACP part) + M-FLAGb.
import { fileURLToPath as fixtureFilePath } from "node:url";
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
import { recordAdmittedEvents as recordEvents, type EventRecorder } from "../../testing/admitted-events.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { createAcpDriver, resetAcpMcpReadinessForTests, type AcpSupport } from "./core.ts";
import { setWarmS2rSource, warmS2rOn } from "../warm-s2r-flag.ts";

const IDLE_MCP = fixtureFilePath(new URL("../../testing/fake-idle-mcp.mjs", import.meta.url));
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const SESSION = "fake-acp-session";
/** The pool.test.ts harness, shaped like Fuigo: pooled sessions on, MCP readiness announced. */
const SUPPORT: AcpSupport = {
  driverKind: "poolTest",
  fluxReach: () => "elsewhere" as const,
  displayName: "Pool Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: "fake-pool",
  nativeSource: "pool.acp",
  loginNote: "never reached",
  spawnArgs: (_config, turn) => ["agent", ...(turn.model ? ["-m", turn.model] : []), "stdio"],
  pickAuthMethod: (methods) => methods[0]?.id ?? null,
  authFailure: "continue",
  isAuthenticated: () => true,
  mcpReadyNotification: "_fuigo/mcp_initialized",
  pooledSessions: true,
};
const Driver = createAcpDriver(SUPPORT);
const zombie = (pid: number) => {
  try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { windowsHide: true, encoding: "utf8" }).trim().startsWith("Z"); }
  catch { try { process.kill(pid, 0); return false; } catch { return true; } }
};
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  return !zombie(pid);
};
async function until(check: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The opt-in ACP pool is off on Windows (acpPoolingEnabled): there every ACP turn is its own process already.
describe.skipIf(process.platform === "win32")("WARM W1 ACP retire before handoff (fake ACP CLI, real relay)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let scratch: string;
  let spawnLog: string;
  let rpcLog: string;
  let lateLog: string;
  let infoLines: string[] = [];
  let infoSpy: ReturnType<typeof vi.spyOn> | undefined;
  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const rpc = () => (existsSync(rpcLog) ? readFileSync(rpcLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; method: string }) : []);
  const lateReplies = () => (existsSync(lateLog) ? readFileSync(lateLog, "utf8").split("\n").filter(Boolean) : []);
  const dispatchLines = () => infoLines.filter((line) => line.startsWith("acp dispatch thread=t-warm"));
  const agents = (): NonNullable<SendTurnInput["integrations"]> => ({
    agents: { command: process.execPath, args: [IDLE_MCP], env: { MURAGE_COMMS_TOKEN: `turn-${randomUUID()}`, FIXTURE_REVISION_RECEIPT: join(scratch, "mount-receipts.jsonl") } },
  });
  const create = async () => {
    instance = await Driver.create({ instanceId: "warm-acp-retire", displayName: "Warm ACP", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
  };
  const turn = async (input: Omit<SendTurnInput, "threadId" | "cwd">) => {
    const { turnId } = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-warm", ...input });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    await instance!.adapter.awaitTurnTeardown?.("t-warm", turnId);
    return { turnId, done: done as Extract<RuntimeEvent, { type: "turn.completed" }> };
  };
  /** Past the fixture's late pair (FAKE_ACP_LATE_FRAMES_MS after the first prompt) plus delivery slack. */
  const pastLatePair = () => new Promise((resolve) => setTimeout(resolve, 900));

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-warm-acp-"));
    spawnLog = join(scratch, "spawns.log");
    rpcLog = join(scratch, "rpc.log");
    lateLog = join(scratch, "late.log");
    process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
    process.env.FAKE_ACP_RPC_LOG = rpcLog;
    process.env.FAKE_ACP_MCP_READY = "1";
    process.env.MURAGE_ACP_POOL = "1";
    process.env.FAKE_ACP_LATE_FRAMES_MS = "300";
    process.env.FAKE_ACP_LATE_REPLY_LOG = lateLog;
    infoLines = [];
    infoSpy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { infoLines.push(args.map(String).join(" ")); });
  });
  afterEach(async () => {
    setWarmS2rSource(() => undefined);
    for (const name of ["FAKE_ACP_SPAWN_LOG", "FAKE_ACP_RPC_LOG", "FAKE_ACP_MCP_READY", "MURAGE_ACP_POOL", "FAKE_ACP_LATE_FRAMES_MS", "FAKE_ACP_LATE_REPLY_LOG", "FAKE_ACP_PROMPT_SCOPE"]) delete process.env[name];
    infoSpy?.mockRestore();
    recorder?.stop();
    const pids = spawns();
    await instance?.dispose();
    instance = undefined;
    await until(() => pids.every((pid) => !alive(pid)), "every engine process to exit");
    resetAcpMcpReadinessForTests();
    await removeTempDir(scratch);
  });

  // W-FG2 r3.4 (i''') [R3.4-G3] + F8 + F8-UNPARK (1)/(3): `warm.s2r` ON, and an agent advertising the prompt-scope capability, are
  // still no handoff in W1. Mutant M-FG12 (ACP kept warm across handoff): the delayed pair reaches the live process, RED at LATE-PAIR.
  it.each([
    { flag: true, scope: "1" },
    { flag: false, scope: "1" },
    { flag: true, scope: "" },
  ])("(i''') a mounted ACP process is retired at handoff (warm.s2r=$flag, promptScope=$scope); the next turn is cold, resumed via session/load", async ({ flag, scope }) => {
    setWarmS2rSource(() => ({ warmS2r: flag }));
    expect(warmS2rOn()).toBe(flag);
    if (scope) process.env.FAKE_ACP_PROMPT_SCOPE = scope;
    await create();
    const first = await turn({ text: "one", integrations: agents() });
    expect(first.done).toMatchObject({ ok: true });
    const [a] = spawns();
    await pastLatePair();
    // LATE-PAIR: the turn-N session/update + session/request_permission pair written after handoff reaches no live process
    expect(lateReplies(), "a live process received the delayed pair").toEqual([]);
    expect(alive(a!)).toBe(false);
    expect(infoLines).toContain("acp close thread=t-warm reason=native-no-barrier");
    const second = await turn({ text: "two", integrations: agents(), resumeCursor: SESSION });
    expect(second.done).toMatchObject({ ok: true });
    const [, b] = spawns();
    expect(spawns()).toHaveLength(2);
    expect(b).not.toBe(a);
    // cold resumed=true: the new process loads the kept conversation, it never opens a new one
    expect(rpc().filter((entry) => entry.pid === b && entry.method === "session/load")).toHaveLength(1);
    expect(rpc().filter((entry) => entry.pid === b && entry.method === "session/new")).toHaveLength(0);
    expect(recorder.events.filter((event) => event.type === "request.opened")).toEqual([]);
    expect(JSON.stringify(recorder.events.filter((event) => event.turnId === second.turnId))).not.toContain("LATE FRAME");
  });

  // W-FG1 (P2, before any lift): 2 mounted turns, each spawned, the second resumed.
  it("W-FG1 two mounted turns: each spawned, the second resumes the conversation", async () => {
    await create();
    const first = await turn({ text: "one", integrations: agents() });
    const second = await turn({ text: "two", integrations: agents(), resumeCursor: SESSION });
    expect([first.done.ok, second.done.ok]).toEqual([true, true]);
    expect(new Set(spawns()).size).toBe(2);
    expect(rpc().filter((entry) => entry.pid === spawns()[1] && entry.method === "session/load")).toHaveLength(1);
  });

  // W-FLAG (ACP part) [R3.1-2]: a fresh profile, no setting written: every mounted turn logs spawned reason=mounted-single-use.
  // Mutant M-FLAGb (the lift not behind the flag: a mounted ACP turn poolable with the flag OFF): RED at FLAG-LINE.
  it("W-FLAG no setting written: the flag reads OFF and every mounted ACP turn is single use", async () => {
    process.env.FAKE_ACP_LATE_FRAMES_MS = "";
    expect(warmS2rOn()).toBe(false);
    await create();
    await turn({ text: "one", integrations: agents() });
    await turn({ text: "two", integrations: agents(), resumeCursor: SESSION });
    await turn({ text: "three", integrations: agents(), resumeCursor: SESSION });
    // FLAG-LINE
    expect(dispatchLines()).toEqual(Array(3).fill("acp dispatch thread=t-warm process=spawned reason=mounted-single-use"));
    expect(new Set(spawns()).size).toBe(3);
  });

  // Positive control: the same harness DOES keep an unmounted process, so the retire above is the mount rule, not the fixture.
  it("control: an unmounted turn on the same harness is parked and reused", async () => {
    process.env.FAKE_ACP_LATE_FRAMES_MS = "";
    await create();
    await turn({ text: "one" });
    await turn({ text: "two", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(1);
  });
});
