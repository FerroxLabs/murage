// The ACP engine process pool (upstream 4b0dabc6, #1575), against the shared
// fake ACP CLI. One process per thread is kept between turns ONLY when
// nothing that matters changed, and it is closed on every path that retires
// a thread: a contract change, a reset (#1562), an interrupt, an idle
// timeout, its own crash, stopAll and dispose. Each test counts real
// processes (FAKE_ACP_SPAWN_LOG) and real requests (FAKE_ACP_RPC_LOG), so a
// "reuse" that quietly respawned, or a "close" that left a process behind,
// fails here.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { fixtureCredentialFingerprint } from "../../testing/fixture-dump.ts";
import { warmPool } from "../warm-pool.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** A pooled harness shaped like Fuigo: the model rides argv, MCP readiness is
 *  announced, and a sign-in method is advertised. */
const POOL_SUPPORT: AcpSupport = {
  driverKind: "poolTest",
  displayName: "Pool Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }, { id: "m-two", label: "Two" }] },
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
const PoolDriver = createAcpDriver(POOL_SUPPORT);
/** The same harness without the opt-in: every turn is its own process. */
const UnpooledDriver = createAcpDriver({ ...POOL_SUPPORT, driverKind: "unpooledTest", pooledSessions: false });

const SESSION = "fake-acp-session";
/** A zombie has exited: it only waits to be reaped, and in a container whose
 *  PID 1 is no init a killed orphan is never reaped. kill(pid, 0) still
 *  succeeds on one, so the state decides. */
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
async function until(check: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("ACP process pool (fake CLI)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let scratch: string;
  let spawnLog: string;
  let rpcLog: string;
  let infoLines: string[] = [];
  let infoSpy: ReturnType<typeof vi.spyOn> | undefined;
  const logged = (text: string) => infoLines.some((line) => line.includes(text));
  /** The reused process was closed for a child it should not carry. Windows has no argv probe, so there the
   *  same close is reported as an unavailable probe (or by the park check) rather than pre-prompt-leftover. */
  const closedForLeftover = () => logged("acp close thread=t-pool reason=pre-prompt-leftover")
    || (process.platform === "win32" && (logged("acp close thread=t-pool reason=process probe unavailable") || logged("acp close thread=t-pool reason=post-turn-descendant")));
  /** Windows' process listing (PowerShell) takes seconds, so an activity window sized for POSIX lapses mid-turn. */
  const windowMs = (posix: number) => String(process.platform === "win32" ? 5_000 : posix);

  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const rpc = () => (existsSync(rpcLog)
    ? readFileSync(rpcLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; method: string; noReplay?: true; agentsToken?: string })
    : []);
  const calls = (method: string) => rpc().filter((entry) => entry.method === method);

  const create = async (driver = PoolDriver) => {
    instance = await driver.create({
      instanceId: "pool-test",
      displayName: "Pool Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    return instance;
  };
  /** A fresh capability token per turn, the way the harness mints them. */
  const agents = (): NonNullable<SendTurnInput["integrations"]> => ({
    agents: { command: process.execPath, args: [FAKE_CLI, "--never-started"], env: { MURAGE_COMMS_TOKEN: `turn-${randomUUID()}` } },
  });
  /** An agents server the fake really runs (as `sleep 300`), with a fresh token per turn. */
  const mcpAgents = (): NonNullable<SendTurnInput["integrations"]> => ({
    agents: { command: "sleep", args: ["300"], env: { MURAGE_COMMS_TOKEN: `turn-${randomUUID()}` } },
  });
  const turn = async (input: Omit<SendTurnInput, "threadId"> & { threadId?: string }) => {
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-pool", ...input });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    return { turnId, done: done as Extract<RuntimeEvent, { type: "turn.completed" }> };
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-acp-pool-"));
    spawnLog = join(scratch, "spawns.log");
    rpcLog = join(scratch, "rpc.log");
    process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
    process.env.FAKE_ACP_RPC_LOG = rpcLog;
    process.env.FAKE_ACP_MCP_READY = "1";
    // per-turn is the default for 1.0; this file exercises the opt-in pool. Cross-thread spares are off.
    process.env.MURAGE_ACP_POOL = "1";
    infoLines = [];
    infoSpy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { infoLines.push(args.map(String).join(" ")); });
  });

  afterEach(async () => {
    for (const name of ["FAKE_ACP_SPAWN_LOG", "FAKE_ACP_RPC_LOG", "FAKE_ACP_MCP_READY", "FAKE_ACP_MODE",
      "FAKE_ACP_REJECT_LIVE_LOAD", "MURAGE_ACP_POOL_IDLE_MS", "MURAGE_ACP_POOL", "MURAGE_ACP_POOL_MAX", "MURAGE_WARM_ACTIVITY_WINDOW_MS", "MURAGE_PREWARM_WAIT_MS", "MURAGE_ACP_MCP_READY_MS", "MURAGE_WARM_POOL_BUDGET_MB", "FAKE_ACP_GATE_FILE", "FAKE_ACP_UNIQUE_SESSIONS", "FAKE_ACP_LATE_FRAMES_MS", "FAKE_ACP_LATE_REPLY_LOG", "FAKE_ACP_LATE_SHAPE", "FAKE_ACP_CHILD_PID_FILE", "FAKE_ACP_MCP_CHILD_LOG", "MURAGE_ACP_CROSS_THREAD_SPARE", "FAKE_ACP_NAMED_UPDATES", "FAKE_ACP_INIT_DELAY_MS", "FAKE_ACP_CHILD_DELAY_MS", "MURAGE_WARM_MAX_AGE_MS", "FAKE_ACP_LOAD_NULL", "FAKE_ACP_MCP_READY_NEW_ONLY"]) delete process.env[name];
    infoSpy?.mockRestore();
    recorder?.stop();
    const pids = spawns();
    await instance?.dispose();
    instance = undefined;
    // nothing any test started may outlive the instance
    await until(() => pids.every((pid) => !alive(pid)), "every engine process to exit");
    await removeTempDir(scratch);
  });

  it("reuses one process across two turns: one spawn, one handshake, the new tokens over session/load", async () => {
    await create();
    const first = agents(), second = agents();
    expect((await turn({ text: "one", integrations: first })).done).toMatchObject({ ok: true });
    const { turnId, done } = await turn({ text: "two", resumeCursor: SESSION, integrations: second });
    expect(done).toMatchObject({ ok: true, stopReason: null });

    expect(spawns()).toHaveLength(1);
    expect(calls("initialize")).toHaveLength(1);
    expect(calls("authenticate")).toHaveLength(1);
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/prompt")).toHaveLength(2);
    // the rotated capability token reached the live session, without a replay
    expect(calls("session/load")).toEqual([
      expect.objectContaining({ noReplay: true, agentsToken: fixtureCredentialFingerprint(second.agents!.env.MURAGE_COMMS_TOKEN) }),
    ]);
    expect(recorder.events.filter((event) => event.type === "session.started")).toMatchObject([
      { sessionId: SESSION },
      { sessionId: SESSION, turnId },
    ]);
    // the reused turn still waited for its re-established servers
    expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
  });

  it("prompts the live session directly when its servers did not change", async () => {
    await create();
    await turn({ text: "one" });
    expect((await turn({ text: "two", resumeCursor: SESSION })).done).toMatchObject({ ok: true });
    expect(spawns()).toHaveLength(1);
    expect(calls("session/load")).toHaveLength(0);
    expect(calls("session/prompt")).toHaveLength(2);
  });

  it("a parked turn's teardown is released at once, so the harness frees its resources", async () => {
    await create();
    const { turnId } = await turn({ text: "one" });
    await expect(instance!.adapter.awaitTurnTeardown!("t-pool", turnId)).resolves.toEqual({ closeConfirmed: true });
    expect(alive(spawns()[0]!)).toBe(true);
  });

  it.each([
    ["cwd", { cwd: "b" }],
    ["model", { model: "m-two" }],
  ] as const)("a changed spawn contract (%s) closes the old process and spawns a new one", async (_name, change) => {
    await create();
    const dirs = { a: mkdtempSync(join(scratch, "a-")), b: mkdtempSync(join(scratch, "b-")) };
    await turn({ text: "one", cwd: dirs.a, model: "m-one" });
    const [firstPid] = spawns();
    const next = "cwd" in change ? { cwd: dirs.b, model: "m-one" } : { cwd: dirs.a, model: change.model };
    expect((await turn({ text: "two", resumeCursor: SESSION, ...next })).done).toMatchObject({ ok: true });
    expect(spawns()).toHaveLength(2);
    await until(() => !alive(firstPid!), "the replaced process to exit");
    expect(calls("initialize")).toHaveLength(2);
  });

  it("a changed engine environment is a different contract", async () => {
    await create();
    await turn({ text: "one" });
    const [firstPid] = spawns();
    // e.g. a rotated Flux key that transformEnv hands the child
    process.env.MURAGE_POOL_TEST_MARK = "changed";
    try {
      expect((await turn({ text: "two", resumeCursor: SESSION })).done).toMatchObject({ ok: true });
    } finally {
      delete process.env.MURAGE_POOL_TEST_MARK;
    }
    expect(spawns()).toHaveLength(2);
    await until(() => !alive(firstPid!), "the replaced process to exit");
  });

  describe("reset paths never reach a process that holds the old session", () => {
    it("sessionReset (an edit, branch switch, memory refresh; #1562)", async () => {
      await create();
      await turn({ text: "one" });
      const [firstPid] = spawns();
      expect((await turn({ text: "two", resumeCursor: SESSION, sessionReset: true })).done).toMatchObject({ ok: true });
      expect(spawns()).toHaveLength(2);
      await until(() => !alive(firstPid!), "the reset process to exit");
      // the reset outranks the cursor: a brand-new native session
      expect(calls("session/new")).toHaveLength(2);
      expect(calls("session/load")).toHaveLength(0);
    });

    it("a turn that carries no cursor (a rebuilt context)", async () => {
      await create();
      await turn({ text: "one" });
      const [firstPid] = spawns();
      await turn({ text: "two" });
      expect(spawns()).toHaveLength(2);
      await until(() => !alive(firstPid!), "the dropped process to exit");
    });

    it("a cursor for another session", async () => {
      await create();
      await turn({ text: "one" });
      await turn({ text: "two", resumeCursor: "some-other-session" });
      expect(spawns()).toHaveLength(2);
    });

    it("resetSession closes the idle process and resolves after it exited", async () => {
      await create();
      await turn({ text: "one" });
      const [pid] = spawns();
      await instance!.adapter.resetSession!("t-pool");
      expect(alive(pid!)).toBe(false);
      await turn({ text: "two", resumeCursor: SESSION });
      expect(spawns()).toHaveLength(2);
    });

    it("resetSession during a turn keeps that turn from parking its process", async () => {
      process.env.FAKE_ACP_MODE = "permission";
      await create();
      const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-pool", text: "go" });
      const opened = await recorder.until((event) => event.type === "request.opened" && event.turnId === turnId);
      await instance!.adapter.resetSession!("t-pool");
      await instance!.adapter.respondToRequest("t-pool", (opened as { requestId: string }).requestId, { behavior: "allow" });
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(done).toMatchObject({ ok: true });
      await until(() => !alive(spawns()[0]!), "the reset turn's process to exit");
    });

    it("interruptTurn on an idle thread (Stop, bot delete, watchdog) closes it and confirms", async () => {
      await create();
      await turn({ text: "one" });
      const [pid] = spawns();
      await expect(instance!.adapter.interruptTurn("t-pool")).resolves.toEqual({ closeConfirmed: true });
      expect(alive(pid!)).toBe(false);
      await turn({ text: "two", resumeCursor: SESSION });
      expect(spawns()).toHaveLength(2);
    });
  });

  it("an idle process closes after MURAGE_ACP_POOL_IDLE_MS and the next turn resumes on a new one", async () => {
    process.env.MURAGE_ACP_POOL_IDLE_MS = "150";
    await create();
    await turn({ text: "one" });
    const [pid] = spawns();
    await until(() => !alive(pid!), "the idle process to close");
    const { done } = await turn({ text: "two", resumeCursor: SESSION });
    expect(done).toMatchObject({ ok: true });
    expect(spawns()).toHaveLength(2);
    // a new process resumes the recorded session, without its transcript replay
    expect(calls("session/load")).toEqual([expect.objectContaining({ noReplay: true })]);
  });

  it("a process that crashes while idle is dropped, and the next turn spawns cleanly", async () => {
    await create();
    await turn({ text: "one" });
    const [pid] = spawns();
    process.kill(pid!, "SIGKILL");
    await until(() => !alive(pid!), "the killed process to exit");
    const { done } = await turn({ text: "two", resumeCursor: SESSION });
    expect(done).toMatchObject({ ok: true });
    expect(spawns()).toHaveLength(2);
    expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
  });

  it("an engine that refuses to re-load its live session gets a fresh process in the same turn", async () => {
    process.env.FAKE_ACP_REJECT_LIVE_LOAD = "1";
    await create();
    await turn({ text: "one", integrations: agents() });
    const [firstPid] = spawns();
    const second = agents();
    const { done } = await turn({ text: "two", resumeCursor: SESSION, integrations: second });
    expect(done).toMatchObject({ ok: true });
    expect(spawns()).toHaveLength(2);
    await until(() => !alive(firstPid!), "the refusing process to exit");
    // refused on the old process, resumed (never session/new) on the new one
    const loads = calls("session/load");
    expect(loads.map((entry) => entry.pid)).toEqual([firstPid, spawns()[1]]);
    expect(loads[1]).toMatchObject({ agentsToken: fixtureCredentialFingerprint(second.agents!.env.MURAGE_COMMS_TOKEN) });
    expect(calls("session/new")).toHaveLength(1);
  });

  it("an interrupt on a reused process still cancels the turn, and closes the process", async () => {
    await create();
    await turn({ text: "one" });
    const [pid] = spawns();
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-pool", text: "go __fixture_cancel_ack__", resumeCursor: SESSION });
    await recorder.until((event) => event.type === "content.delta" && event.turnId === turnId);
    expect(spawns()).toHaveLength(1);
    await expect(instance!.adapter.interruptTurn("t-pool", turnId)).resolves.toEqual({ closeConfirmed: true });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(calls("session/cancel")).toHaveLength(1);
    expect(alive(pid!)).toBe(false);
    // the next turn pays for a new process
    await turn({ text: "three", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(2);
  });

  it("a failed turn never parks its process", async () => {
    process.env.FAKE_ACP_MODE = "fail-after-text";
    await create();
    const { done } = await turn({ text: "one" });
    expect(done).toMatchObject({ ok: false });
    await until(() => !alive(spawns()[0]!), "the failed turn's process to exit");
  });

  it.each(["stopAll", "dispose"] as const)("%s closes the pooled process", async (how) => {
    await create();
    await turn({ text: "one" });
    expect(spawns()).toHaveLength(1);
    if (how === "stopAll") await instance!.adapter.stopAll();
    else {
      await instance!.dispose();
      instance = undefined;
    }
    for (const pid of spawns()) expect(alive(pid)).toBe(false);
  });

  it("cross-thread spares off (the default): thread B never adopts A's process, and A's spare goes at the one-spare limit", async () => {
    expect(process.env.MURAGE_ACP_CROSS_THREAD_SPARE).toBeUndefined();
    await create();
    await turn({ text: "one", threadId: "t-pool-a" });
    const [a] = spawns();
    await turn({ text: "one", threadId: "t-pool-b", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(2);
    expect(spawns()[1]).not.toBe(a);
    expect(rpc().filter((entry) => entry.pid === a && entry.method === "session/load")).toHaveLength(0);
    await until(() => !alive(a!), "A's spare to close at the one-spare limit");
    expect(warmPool.idleCount()).toBe(1);
  });

  it("cross-thread spares off: A's late output and late permission request never reach B's handlers", async () => {
    expect(process.env.MURAGE_ACP_CROSS_THREAD_SPARE).toBeUndefined();
    process.env.FAKE_ACP_UNIQUE_SESSIONS = "1";
    process.env.FAKE_ACP_LATE_FRAMES_MS = "500";
    const lateLog = join(scratch, "late.log");
    process.env.FAKE_ACP_LATE_REPLY_LOG = lateLog;
    const gate = join(scratch, "gate");
    process.env.FAKE_ACP_MODE = "echo-gated";
    process.env.FAKE_ACP_GATE_FILE = gate;
    appendFileSync(gate, "open");
    await create();
    await turn({ threadId: "t-a", text: "one" });
    const [a] = spawns();
    rmSync(gate); // B's prompt stays open while A's session speaks late
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-b", text: "two", resumeCursor: SESSION });
    await until(() => calls("session/prompt").length === 2, "B's prompt");
    expect(spawns()).toHaveLength(2);
    expect(calls("session/prompt")[1]!.pid).not.toBe(a);
    // A's late request (on A's own idle process) is refused and that process closed
    await until(() => !alive(a!), "A's process, which acted while idle, to close");
    appendFileSync(gate, "open");
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ ok: true });
    const mine = recorder.events.filter((event) => event.threadId === "t-b");
    expect(JSON.stringify(mine)).not.toContain("LATE FRAME");
    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
  });

  it("post-turn tool activity closes the parked process at once, and it is never adopted again", async () => {
    await create();
    const { done } = await turn({ text: "go __fixture_tool_after_turn__" });
    expect(done).toMatchObject({ ok: true });
    const [pid] = spawns();
    await until(() => !alive(pid!), "the process that kept working after its turn to close");
    expect(logged("acp close thread=t-pool reason=post-turn-activity frame=tool_call")).toBe(true);
    expect(warmPool.idleCount()).toBe(0);
    await turn({ text: "two", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(2);
  });

  it("Fuigo's own post-turn metadata (last_turn_summary, session_summary_generated, session_info_update) does not retire the parked process", async () => {
    await create();
    const { done } = await turn({ text: "go __fixture_summary_after_turn__" });
    expect(done).toMatchObject({ ok: true });
    const [pid] = spawns();
    await new Promise((resolve) => setTimeout(resolve, 1500)); // all three frames have arrived
    expect(alive(pid!)).toBe(true);
    expect(logged("post-turn-activity")).toBe(false);
    expect(warmPool.idleCount()).toBe(1);
    await turn({ text: "two", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(1);
  });

  it.each(["toolCall", "prompt"] as const)("a last_turn_summary that carries a %s still retires the parked process", async (kind) => {
    process.env.FAKE_ACP_SMUGGLE = kind;
    onTestFinished(() => { delete process.env.FAKE_ACP_SMUGGLE; });
    await create();
    const { done } = await turn({ text: "go __fixture_summary_with_work__" });
    expect(done).toMatchObject({ ok: true });
    const [pid] = spawns();
    await until(() => !alive(pid!), "the process whose summary carried work to close");
    expect(logged("acp close thread=t-pool reason=post-turn-activity frame=last_turn_summary")).toBe(true);
    expect(warmPool.idleCount()).toBe(0);
  });

  it("a turn the engine starts on its own 2 s after end_turn (turn_completed) closes the parked process", async () => {
    await create();
    const { done } = await turn({ text: "go __fixture_wake_after_turn__" });
    expect(done).toMatchObject({ ok: true });
    const [pid] = spawns();
    await until(() => warmPool.idleCount() === 1, "the process to park");
    await until(() => !alive(pid!), "the self-woken process to close", 6_000);
    expect(logged("acp close thread=t-pool reason=post-turn-activity frame=turn_completed")).toBe(true);
    expect(warmPool.idleCount()).toBe(0);
  });

  it("a child process left running after end_turn closes the process and kills its whole tree", async () => {
    const childPidFile = join(scratch, "child.pid");
    process.env.FAKE_ACP_CHILD_PID_FILE = childPidFile;
    await create();
    const { done } = await turn({ text: "go __fixture_child_after_turn__" });
    expect(done).toMatchObject({ ok: true });
    await until(() => existsSync(childPidFile), "the leftover child to start");
    const leftover = Number(readFileSync(childPidFile, "utf8"));
    const [pid] = spawns();
    await until(() => logged("acp close thread=t-pool reason=post-turn-descendant"), "the process-tree guard to close it");
    await until(() => !alive(pid!), "the engine process to exit");
    await until(() => !alive(leftover), "the leftover child to be killed with its tree");
    expect(warmPool.idleCount()).toBe(0);
  });

  // Windows has no argv probe (processParentsAndArgs is null there), so a replaced MCP child cannot be
  // verified and the pooled process is recycled by design; the pool is opt-in (MURAGE_ACP_POOL=1).
  it.skipIf(process.platform === "win32")("MCP servers the engine replaces each turn are baseline: four replacing turns on one process, never closed as a leftover", async () => {
    const mcpLog = join(scratch, "mcp-children.log");
    process.env.FAKE_ACP_MCP_CHILD_LOG = mcpLog;
    const mcpChildren = () => (existsSync(mcpLog) ? readFileSync(mcpLog, "utf8").split("\n").filter(Boolean).map(Number) : []);
    await create();
    expect((await turn({ text: "one", integrations: mcpAgents() })).done).toMatchObject({ ok: true });
    // A fresh capability token each turn: session/load re-establishes the
    // servers and the engine replaces its MCP child (a new pid). A follow-up
    // adopts the parked process only once its park check passed, so one spawn
    // means every check found the replacement legitimate.
    for (const text of ["two", "three", "four"]) {
      expect((await turn({ text, resumeCursor: SESSION, integrations: mcpAgents() })).done).toMatchObject({ ok: true });
    }
    // unchanged servers: no reconnect, no new child; it proves the last
    // replacing turn's park check passed too
    const last = mcpAgents();
    expect((await turn({ text: "five", resumeCursor: SESSION, integrations: last })).done).toMatchObject({ ok: true });
    expect((await turn({ text: "six", resumeCursor: SESSION, integrations: last })).done).toMatchObject({ ok: true });
    expect(calls("session/load")).toHaveLength(4);
    const children = mcpChildren();
    expect(children).toHaveLength(5);
    expect(new Set(children).size).toBe(5);
    expect(alive(children.at(-1)!)).toBe(true);
    expect(spawns()).toHaveLength(1);
    expect(calls("session/prompt")).toHaveLength(6);
    expect(logged("reason=post-turn-descendant")).toBe(false);
    expect(logged("reason=pre-prompt-leftover")).toBe(false);
    await instance!.dispose();
    instance = undefined;
    await until(() => children.every((pid) => !alive(pid)), "every MCP child to exit with the engine");
  });

  it("a child that starts after the park check passed is caught before the next prompt: closed, and the turn spawns fresh", async () => {
    const childPidFile = join(scratch, "later.pid");
    process.env.FAKE_ACP_CHILD_PID_FILE = childPidFile;
    process.env.FAKE_ACP_CHILD_DELAY_MS = "800";
    await create();
    expect((await turn({ text: "go __fixture_child_later__" })).done).toMatchObject({ ok: true });
    // the child appears well after the settle check passed and well before the 5 s parked sweep
    await until(() => existsSync(childPidFile) && readFileSync(childPidFile, "utf8").length > 0, "the late child to start");
    const later = Number(readFileSync(childPidFile, "utf8"));
    // Windows' listing takes longer than the 800 ms delay, so its park check may already see the child
    if (process.platform !== "win32") expect(logged("reason=post-turn-descendant")).toBe(false);
    const [first] = spawns();
    expect((await turn({ text: "two", resumeCursor: SESSION })).done).toMatchObject({ ok: true });
    expect(closedForLeftover()).toBe(true);
    expect(spawns()).toHaveLength(2);
    // the turn ran on the fresh process, never the one with the leftover
    expect(calls("session/prompt").at(-1)!.pid).toBe(spawns()[1]);
    await until(() => !alive(first!), "the process with the leftover to exit");
    await until(() => !alive(later), "the leftover child to be killed with its tree");
  });

  it("a fresh process replacing a rejected reused one keeps none of its session: a load answering null opens a new session", async () => {
    const childPidFile = join(scratch, "later.pid");
    process.env.FAKE_ACP_CHILD_PID_FILE = childPidFile;
    process.env.FAKE_ACP_CHILD_DELAY_MS = "800";
    // set before the first spawn (the env is part of the spawn contract); the
    // first turn sends no cursor, and the reused process loads nothing
    process.env.FAKE_ACP_LOAD_NULL = "1";
    await create();
    expect((await turn({ text: "go __fixture_child_later__" })).done).toMatchObject({ ok: true });
    await until(() => existsSync(childPidFile) && readFileSync(childPidFile, "utf8").length > 0, "the late child to start");
    const later = Number(readFileSync(childPidFile, "utf8"));
    expect((await turn({ text: "two", resumeCursor: SESSION })).done).toMatchObject({ ok: true });
    expect(closedForLeftover()).toBe(true);
    const fresh = spawns()[1]!;
    expect(fresh).toBeDefined();
    // the replacement tried the cursor, got null, and opened its own session
    expect(calls("session/load").filter((entry) => entry.pid === fresh)).toHaveLength(1);
    expect(calls("session/new").filter((entry) => entry.pid === fresh)).toHaveLength(1);
    expect(calls("session/prompt").at(-1)!.pid).toBe(fresh);
    await until(() => !alive(later), "the leftover child to be killed with its tree");
  });

  it("a reused process whose reconnected MCP servers never report ready is closed, and the turn spawns fresh", async () => {
    process.env.FAKE_ACP_MCP_READY_NEW_ONLY = "1";
    process.env.MURAGE_ACP_MCP_READY_MS = "300";
    await create();
    expect((await turn({ text: "one", integrations: agents() })).done).toMatchObject({ ok: true });
    const [first] = spawns();
    // a fresh token: session/load re-establishes the servers, and no ready arrives
    expect((await turn({ text: "two", resumeCursor: SESSION, integrations: agents() })).done).toMatchObject({ ok: true });
    expect(logged("acp close thread=t-pool reason=mcp-ready-timeout")).toBe(true);
    expect(spawns()).toHaveLength(2);
    // the fresh process times out too and goes on as before: the prompt runs on it
    expect(calls("session/prompt").at(-1)!.pid).toBe(spawns()[1]);
    await until(() => !alive(first!), "the rejected process to exit");
  });

  it("an engine older than MURAGE_WARM_MAX_AGE_MS is recycled at the next turn, never mid-turn", async () => {
    // set before the first spawn: the engine's env is part of its spawn contract
    process.env.MURAGE_WARM_MAX_AGE_MS = "3000";
    const started = Date.now();
    await create();
    expect((await turn({ text: "one" })).done).toMatchObject({ ok: true });
    const [first] = spawns();
    // parked young; idle past the age, nothing closes it until a turn boundary
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + 3_200 - Date.now())));
    expect(alive(first!)).toBe(true);
    expect(logged("reason=max-age")).toBe(false);
    expect((await turn({ text: "two", resumeCursor: SESSION })).done).toMatchObject({ ok: true });
    expect(logged("acp close thread=t-pool reason=max-age")).toBe(true);
    expect(spawns()).toHaveLength(2);
    expect(calls("session/prompt").at(-1)!.pid).toBe(spawns()[1]);
    await until(() => !alive(first!), "the aged process to exit");
  });

  it.each([
    ["a computer", { computer: { boxId: "box-1", token: `box-${randomUUID()}` } }],
    ["a browser", { browser: { command: process.execPath, args: [FAKE_CLI, "--never-started"], env: {} } }],
  ] as const)("a turn that holds %s never parks its process", async (_name, integrations) => {
    await create();
    await turn({ text: "one", integrations: integrations as SendTurnInput["integrations"] });
    await until(() => !alive(spawns()[0]!), "the resource-holding turn's process to exit");
  });

  it("a bypass-permissions instance never parks its process", async () => {
    instance = await PoolDriver.create({
      instanceId: "pool-test-full", displayName: "Pool Test", environment: {}, enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    await turn({ text: "one" });
    await until(() => !alive(spawns()[0]!), "the bypass-permissions turn's process to exit");
  });

  it("an engine that asks for anything while idle is refused and closed", async () => {
    await create();
    const { turnId, done } = await turn({ text: "go __fixture_request_after_turn__" });
    expect(done).toMatchObject({ ok: true });
    await until(() => !alive(spawns()[0]!), "the process that acted while idle to exit");
    expect(logged("acp close thread=t-pool reason=post-turn-activity frame=session/request_permission")).toBe(true);
    // nobody was asked: the late request never became a card
    expect(recorder.events.filter((event) => event.type === "request.opened")).toHaveLength(0);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", turnId });
    await turn({ text: "two", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(2);
  });

  it("MURAGE_ACP_POOL=1: one spare while active, and back to zero after the activity window", async () => {
    expect(process.env.MURAGE_ACP_POOL).toBe("1");
    process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = windowMs(300);
    await create();
    await turn({ text: "one" });
    await turn({ text: "two", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(1);
    const [pid] = spawns();
    await until(() => warmPool.idleCount() === 1, "the spare to park");
    expect(alive(pid!)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, Number(windowMs(300)) + 150));
    await warmPool.tick();
    await until(() => !alive(pid!), "the spare to be released after the window");
    expect(warmPool.idleCount()).toBe(0);
 }, 45_000);

  it.each([["unset", undefined], ["0", "0"], ["true", "true"]] as const)("the default config (MURAGE_ACP_POOL %s) keeps no spare: each turn spawns and closes its own process", async (_name, value) => {
    if (value === undefined) delete process.env.MURAGE_ACP_POOL; else process.env.MURAGE_ACP_POOL = value;
    await create();
    await turn({ text: "one" });
    const [first] = spawns();
    await until(() => !alive(first!), "the per-turn process to close");
    expect(warmPool.idleCount()).toBe(0);
    await turn({ text: "two", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(2);
    expect(await instance!.adapter.prewarm!("t-pool")).toBe(false);
    expect(warmPool.idleCount()).toBe(0);
  });

  it("per turn, an ACP turn still counts as user activity, and a background one does not", async () => {
    delete process.env.MURAGE_ACP_POOL;
    const seen: string[] = [];
    const noteUser = vi.spyOn(warmPool, "noteUserActivity").mockImplementation(() => { seen.push("user"); });
    try {
      await create();
      await turn({ text: "one" });
      expect(seen).toEqual(["user"]);
      await turn({ text: "routine", background: true });
      expect(seen).toEqual(["user"]);
    } finally { noteUser.mockRestore(); }
  });

  it("a candidate is unavailable until its park check succeeded: an immediate follow-up never adopts a process the check found unfit", async () => {
    const childPidFile = join(scratch, "child.pid");
    process.env.FAKE_ACP_CHILD_PID_FILE = childPidFile;
    await create();
    const first = await instance!.adapter.sendTurn({ threadId: "t-pool", text: "go __fixture_child_after_turn__" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
    // sent at once: the settle check of the parked process has not answered yet
    const second = await instance!.adapter.sendTurn({ threadId: "t-pool", text: "two", resumeCursor: SESSION });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);
    expect(done).toMatchObject({ ok: true });
    const [pid] = spawns();
    // the leftover child made the first process unfit: the follow-up ran on a fresh one
    expect(spawns()).toHaveLength(2);
    expect(calls("session/prompt").map((entry) => entry.pid)).toEqual([pid, spawns()[1]]);
    expect(logged("acp close thread=t-pool reason=post-turn-descendant")).toBe(true);
    await until(() => !alive(pid!), "the unfit process to exit");
    const leftover = Number(readFileSync(childPidFile, "utf8"));
    await until(() => !alive(leftover), "the leftover child to be killed with its tree");
  });

  it("a clean park check lets an immediate follow-up adopt the process (after the check, with handlers attached only then)", async () => {
    await create();
    const first = await instance!.adapter.sendTurn({ threadId: "t-pool", text: "one" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
    const second = await instance!.adapter.sendTurn({ threadId: "t-pool", text: "two", resumeCursor: SESSION });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);
    expect(done).toMatchObject({ ok: true });
    expect(spawns()).toHaveLength(1);
    expect(calls("initialize")).toHaveLength(1);
  });

  it("measures what a reused turn saves over a fresh one", async () => {
    const timeTurns = async (driver: typeof PoolDriver) => {
      await create(driver);
      const times: number[] = [];
      for (let i = 0; i < 4; i++) {
        // a person's gap between messages: the parked process's settle check has answered
        // by then (an immediate follow-up waits for it, by design)
        if (i) await new Promise((resolve) => setTimeout(resolve, 250));
        const started = performance.now();
        await turn({ text: `turn ${i}`, ...(i ? { resumeCursor: SESSION } : {}), integrations: agents() });
        times.push(performance.now() - started);
      }
      await instance!.dispose();
      instance = undefined;
      recorder.stop();
      return times.slice(1);
    };
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    // a startup cost for the fake engine, as a real one has: reuse must save it
    process.env.FAKE_ACP_INIT_DELAY_MS = "1000";
    const fresh = median(await timeTurns(UnpooledDriver));
    const pooled = median(await timeTurns(PoolDriver));
    // The fake engine takes 1 s to answer initialize, which a reused turn never
    // sends: reuse must come out at least 200 ms ahead. The margin left covers
    // the reused turn's process listings (~30-40 ms of `ps` each on an idle Mac,
    // several hundred on a loaded one) and noise.
    const line = `[acp-pool] fake CLI turn, median of 3: fresh ${fresh.toFixed(0)} ms, reused ${pooled.toFixed(0)} ms, saved ${(fresh - pooled).toFixed(0)} ms`;
    console.info(line);
    if (process.env.ACP_POOL_MEASURE_FILE) appendFileSync(process.env.ACP_POOL_MEASURE_FILE, `${line}\n`);
    expect(pooled).toBeLessThan(fresh - 200);
  });

  describe("intent prewarm", () => {
    /** One user turn, then the pool's own idle timer closes its process: the next warm starts cold. */
    const goCold = async () => {
      process.env.MURAGE_ACP_POOL_IDLE_MS = "150";
      process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "250";
      await create();
      await turn({ text: "one" });
      const [pid] = spawns();
      await until(() => !alive(pid!), "the idle process to close");
      process.env.MURAGE_ACP_POOL_IDLE_MS = "60000";
    };

    it("starts a cold engine once with its session established, sends no prompt, and announces nothing", async () => {
      await goCold();
      const before = recorder.events.length;
      expect(await instance!.adapter.prewarm!("t-pool")).toBe(true);
      expect(spawns()).toHaveLength(2);
      expect(calls("session/prompt")).toHaveLength(1);
      expect(recorder.events.slice(before).map((e) => e.type)).toEqual([]);
      expect(warmPool.idleCount()).toBe(1);
      // an engine already parked for the thread: nothing more to start
      expect(await instance!.adapter.prewarm!("t-pool")).toBe(false);
      expect(spawns()).toHaveLength(2);
    });

    it("is released when no send follows within the window", async () => {
      await goCold();
      expect(await instance!.adapter.prewarm!("t-pool")).toBe(true);
      const pid = spawns()[1]!;
      await new Promise((resolve) => setTimeout(resolve, 400));
      await warmPool.tick();
      await until(() => !alive(pid), "the unclaimed prewarm to be released");
      expect(warmPool.idleCount()).toBe(0);
    });

    it("prewarm then send reuses the engine: no second spawn, the turn is prompted on the held session", async () => {
      await goCold();
      process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = windowMs(250);
      expect(await instance!.adapter.prewarm!("t-pool")).toBe(true);
      const { done } = await turn({ text: "two", resumeCursor: SESSION });
      expect(done).toMatchObject({ ok: true });
      expect(spawns()).toHaveLength(2);
      expect(calls("session/prompt")).toHaveLength(2);
    });

    it("prewarm then a changed contract (another model) recycles the process", async () => {
      await goCold();
      expect(await instance!.adapter.prewarm!("t-pool")).toBe(true);
      const held = spawns()[1]!;
      const { done } = await turn({ text: "two", resumeCursor: SESSION, model: "m-two" });
      expect(done).toMatchObject({ ok: true });
      expect(spawns()).toHaveLength(3);
      await until(() => !alive(held), "the stale prewarmed process to close");
    });

    it("a send that outwaits a slow prewarm takes over: the prewarm is cancelled and its slot freed, never 'already running'", async () => {
      // like goCold, but the remembered turn mounts an MCP server, so the warm has something to wait for
      process.env.MURAGE_ACP_POOL_IDLE_MS = "150";
      process.env.MURAGE_WARM_ACTIVITY_WINDOW_MS = "250";
      await create();
      await turn({ text: "one", integrations: agents() });
      await until(() => !alive(spawns()[0]!), "the idle process to close");
      process.env.MURAGE_ACP_POOL_IDLE_MS = "60000";
      process.env.MURAGE_PREWARM_WAIT_MS = "100";
      delete process.env.FAKE_ACP_MCP_READY; // the warm's MCP servers never report ready: it stays starting
      process.env.MURAGE_ACP_MCP_READY_MS = "60000";
      const warming = instance!.adapter.prewarm!("t-pool");
      await until(() => spawns().length === 2, "the prewarm's process to start");
      await new Promise((resolve) => setTimeout(resolve, 200)); // past the send's wait
      process.env.FAKE_ACP_MCP_READY = "1"; // the real send's own engine reports ready
      const { done } = await turn({ text: "two", resumeCursor: SESSION, integrations: agents() });
      expect(done).toMatchObject({ ok: true });
      await warming;
    });

    it("with no remembered args it is a no-op, and a routine turn leaves nothing to warm or keep", async () => {
      await create();
      expect(await instance!.adapter.prewarm!("t-unknown")).toBe(false);
      await turn({ threadId: "t-routine", text: "routine", background: true });
      expect(warmPool.idleCount()).toBe(0);
      expect(await instance!.adapter.prewarm!("t-routine")).toBe(false);
      expect(spawns()).toHaveLength(1);
    });
  });

  describe("with MURAGE_ACP_CROSS_THREAD_SPARE=1 the spare serves any thread's own session, and a running engine is never an idle spare", () => {
    // a moved process admits only frames naming its pinned session; the fixture names them all
    beforeEach(() => { process.env.MURAGE_ACP_CROSS_THREAD_SPARE = "1"; process.env.FAKE_ACP_NAMED_UPDATES = "1"; });

    it("a thread with no session of its own never takes another thread's process: session/new always gets a fresh one", async () => {
      await create();
      await turn({ threadId: "t-a", text: "one" });
      expect(spawns()).toHaveLength(1);
      const { done } = await turn({ threadId: "t-b", text: "two" });
      expect(done).toMatchObject({ ok: true });
      expect(spawns()).toHaveLength(2);
      expect(calls("session/new").map((entry) => entry.pid)).toEqual(spawns());
    });

    it.each([
      ["a frame naming no session", "sessionless"],
      ["a late helper of the earlier owner", "helper"],
    ] as const)("after a transfer, %s is refused under the new owner", async (_name, shape) => {
      process.env.FAKE_ACP_UNIQUE_SESSIONS = "1";
      process.env.FAKE_ACP_LATE_FRAMES_MS = "500";
      process.env.FAKE_ACP_LATE_SHAPE = shape;
      const lateLog = join(scratch, "late.log");
      process.env.FAKE_ACP_LATE_REPLY_LOG = lateLog;
      const gate = join(scratch, "gate");
      process.env.FAKE_ACP_MODE = "echo-gated";
      process.env.FAKE_ACP_GATE_FILE = gate;
      appendFileSync(gate, "open");
      await create();
      await turn({ threadId: "t-a", text: "one" });
      rmSync(gate);
      const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-b", text: "two", resumeCursor: "t-b-own-session" });
      await until(() => calls("session/prompt").length === 2, "t-b's prompt on the moved process");
      expect(spawns()).toHaveLength(1);
      await until(() => existsSync(lateLog), "the late request to be answered");
      const reply = JSON.parse(readFileSync(lateLog, "utf8").trim()) as { result?: unknown; error?: { message?: string } };
      expect(reply.result).toBeUndefined();
      expect(reply.error?.message).toMatch(/not active/);
      appendFileSync(gate, "open");
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(done).toMatchObject({ ok: true });
      const mine = recorder.events.filter((event) => event.threadId === "t-b");
      expect(JSON.stringify(mine)).not.toContain("LATE FRAME");
      expect(mine.some((event) => event.type === "request.opened")).toBe(false);
    });

    it("loads the target thread's own session with that thread's current MCP config", async () => {
      await create();
      await turn({ threadId: "t-a", text: "one", integrations: agents() });
      const second = agents();
      const { done } = await turn({ threadId: "t-b", text: "two", resumeCursor: SESSION, integrations: second });
      expect(done).toMatchObject({ ok: true });
      expect(spawns()).toHaveLength(1);
      expect(calls("session/load")).toEqual([
        expect.objectContaining({ noReplay: true, agentsToken: fixtureCredentialFingerprint(second.agents!.env.MURAGE_COMMS_TOKEN) }),
      ]);
    });

    it("an incompatible spare (another model on the command line) is closed and a fresh process spawned", async () => {
      await create();
      await turn({ threadId: "t-a", text: "one", model: "m-one" });
      const [first] = spawns();
      const { done } = await turn({ threadId: "t-b", text: "two", model: "m-two", resumeCursor: SESSION });
      expect(done).toMatchObject({ ok: true });
      expect(spawns()).toHaveLength(2);
      await until(() => !alive(first!), "the incompatible spare to close");
    });

    it("the earlier owner's frames never reach the thread that took its process: output dropped, its request refused", async () => {
      process.env.FAKE_ACP_UNIQUE_SESSIONS = "1";
      process.env.FAKE_ACP_LATE_FRAMES_MS = "500";
      const lateLog = join(scratch, "late.log");
      process.env.FAKE_ACP_LATE_REPLY_LOG = lateLog;
      const gate = join(scratch, "gate");
      process.env.FAKE_ACP_MODE = "echo-gated";
      process.env.FAKE_ACP_GATE_FILE = gate;
      appendFileSync(gate, "open");
      await create();
      await turn({ threadId: "t-a", text: "one" });
      rmSync(gate); // t-b's prompt stays open while t-a's session speaks late
      const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-b", text: "two", resumeCursor: "t-b-own-session" });
      await until(() => calls("session/prompt").length === 2, "t-b's prompt on the moved process");
      expect(spawns()).toHaveLength(1);
      await until(() => existsSync(lateLog), "the earlier session's late request to be answered");
      const reply = JSON.parse(readFileSync(lateLog, "utf8").trim()) as { result?: unknown; error?: { message?: string } };
      expect(reply.result).toBeUndefined();
      expect(reply.error?.message).toMatch(/not active/);
      appendFileSync(gate, "open");
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(done).toMatchObject({ ok: true });
      const mine = recorder.events.filter((event) => event.threadId === "t-b");
      expect(JSON.stringify(mine)).not.toContain("LATE FRAME");
      expect(mine.some((event) => event.type === "request.opened")).toBe(false);
    });

    it.each([
      ["a late update and request naming the earlier owner's session", undefined],
      ["a late update and request naming no session", "sessionless"],
    ] as const)("while parked, %s retires the process (before the ownership filter)", async (_name, shape) => {
      process.env.FAKE_ACP_UNIQUE_SESSIONS = "1";
      process.env.FAKE_ACP_LATE_FRAMES_MS = "1200";
      if (shape) process.env.FAKE_ACP_LATE_SHAPE = shape;
      const lateLog = join(scratch, "late.log");
      process.env.FAKE_ACP_LATE_REPLY_LOG = lateLog;
      await create();
      await turn({ threadId: "t-a", text: "one" });
      const { done } = await turn({ threadId: "t-b", text: "two", resumeCursor: "t-b-own-session" });
      expect(done).toMatchObject({ ok: true });
      expect(spawns()).toHaveLength(1);
      const [pid] = spawns();
      // t-b's turn is over and the moved process is parked; t-a's session now speaks
      await until(() => warmPool.idleCount() === 1, "the moved process to park under t-b");
      await until(() => !alive(pid!), "the parked process, which saw foreign activity, to be retired", 6_000);
      expect(logged("acp close thread=t-b reason=post-turn-activity frame=")).toBe(true);
      expect(warmPool.idleCount()).toBe(0);
      expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    });

    it("a process serving another thread leaves both pools when it exits, under the thread it serves now", async () => {
      await create();
      await turn({ threadId: "t-a", text: "one" });
      await turn({ threadId: "t-b", text: "two", resumeCursor: SESSION });
      expect(spawns()).toHaveLength(1);
      await until(() => warmPool.idleCount() === 1, "the moved process to park under t-b");
      const [pid] = spawns();
      process.kill(pid!, "SIGKILL");
      await until(() => !alive(pid!), "the moved process to exit");
      await until(() => warmPool.idleCount() === 0, "the shared warm pool to drop it");
      // nothing dead is left parked under t-b: its next warm starts a live engine
      expect(await instance!.adapter.prewarm!("t-b")).toBe(true);
      expect(spawns()).toHaveLength(2);
    });

    it("an engine adopted by a running turn is not evicted by pool pressure", async () => {
      const gate = join(scratch, "gate");
      process.env.FAKE_ACP_MODE = "echo-gated";
      process.env.FAKE_ACP_GATE_FILE = gate;
      appendFileSync(gate, "open");
      await create();
      await turn({ text: "one" });
      const [pid] = spawns();
      rmSync(gate); // the next turn holds open
      const { turnId } = await instance!.adapter.sendTurn({ threadId: "t-pool", text: "two", resumeCursor: SESSION });
      await until(() => calls("session/prompt").length === 2, "the second prompt to be in flight");
      process.env.MURAGE_WARM_POOL_BUDGET_MB = "1";
      await warmPool.tick();
      await warmPool.beforeSpawn();
      expect(alive(pid!)).toBe(true);
      expect(spawns()).toHaveLength(1);
      appendFileSync(gate, "open");
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(done).toMatchObject({ ok: true });
    });
  });

});
