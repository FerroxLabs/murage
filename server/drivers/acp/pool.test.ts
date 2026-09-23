// The ACP engine process pool (upstream 4b0dabc6, #1575), against the shared
// fake ACP CLI. One process per thread is kept between turns ONLY when
// nothing that matters changed, and it is closed on every path that retires
// a thread: a contract change, a reset (#1562), an interrupt, an idle
// timeout, its own crash, stopAll and dispose. Each test counts real
// processes (FAKE_ACP_SPAWN_LOG) and real requests (FAKE_ACP_RPC_LOG), so a
// "reuse" that quietly respawned, or a "close" that left a process behind,
// fails here.
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
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
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
    // the pool ships off; every case here turns it on unless it says otherwise
    process.env.MURAGE_ACP_POOL = "1";
  });

  afterEach(async () => {
    for (const name of ["FAKE_ACP_SPAWN_LOG", "FAKE_ACP_RPC_LOG", "FAKE_ACP_MCP_READY", "FAKE_ACP_MODE",
      "FAKE_ACP_REJECT_LIVE_LOAD", "MURAGE_ACP_POOL_IDLE_MS", "MURAGE_ACP_POOL", "MURAGE_ACP_POOL_MAX"]) delete process.env[name];
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
      expect.objectContaining({ noReplay: true, agentsToken: second.agents!.env.MURAGE_COMMS_TOKEN }),
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
    // a new process resumes the recorded session (with its transcript replay)
    expect(calls("session/load")).toEqual([expect.not.objectContaining({ noReplay: true })]);
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
    expect(loads[1]).toMatchObject({ agentsToken: second.agents!.env.MURAGE_COMMS_TOKEN });
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

  it.each(["stopAll", "dispose"] as const)("%s closes every pooled process", async (how) => {
    await create();
    await turn({ text: "one" });
    await turn({ text: "one", threadId: "t-pool-2" });
    expect(spawns()).toHaveLength(2);
    if (how === "stopAll") await instance!.adapter.stopAll();
    else {
      await instance!.dispose();
      instance = undefined;
    }
    for (const pid of spawns()) expect(alive(pid)).toBe(false);
  });

  it("keeps at most MURAGE_ACP_POOL_MAX idle processes, closing the longest-idle first", async () => {
    process.env.MURAGE_ACP_POOL_MAX = "1";
    await create();
    await turn({ text: "one", threadId: "t-pool-a" });
    const [first] = spawns();
    await turn({ text: "one", threadId: "t-pool-b" });
    const [, second] = spawns();
    await until(() => !alive(first!), "the longest-idle process to close");
    expect(alive(second!)).toBe(true);
    // the surviving thread still reuses its process
    await turn({ text: "two", threadId: "t-pool-b", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(2);
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
    // nobody was asked: the late request never became a card
    expect(recorder.events.filter((event) => event.type === "request.opened")).toHaveLength(0);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", turnId });
    await turn({ text: "two", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(2);
  });

  it("the pool is off by default: each turn spawns its own process, as before #1575", async () => {
    delete process.env.MURAGE_ACP_POOL;
    await create();
    await turn({ text: "one" });
    await turn({ text: "two", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(2);
  });

  it("MURAGE_ACP_POOL=0 turns the pool off", async () => {
    process.env.MURAGE_ACP_POOL = "0";
    await create();
    await turn({ text: "one" });
    await turn({ text: "two", resumeCursor: SESSION });
    expect(spawns()).toHaveLength(2);
  });

  it("measures what a reused turn saves over a fresh one", async () => {
    const timeTurns = async (driver: typeof PoolDriver) => {
      await create(driver);
      const times: number[] = [];
      for (let i = 0; i < 4; i++) {
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
    const fresh = median(await timeTurns(UnpooledDriver));
    const pooled = median(await timeTurns(PoolDriver));
    // Informational: printed for the lane record, asserted only loosely so a
    // loaded machine cannot flake it.
    const line = `[acp-pool] fake CLI turn, median of 3: fresh ${fresh.toFixed(0)} ms, reused ${pooled.toFixed(0)} ms, saved ${(fresh - pooled).toFixed(0)} ms`;
    console.info(line);
    if (process.env.ACP_POOL_MEASURE_FILE) appendFileSync(process.env.ACP_POOL_MEASURE_FILE, `${line}\n`);
    expect(pooled).toBeLessThan(fresh);
  });
});
