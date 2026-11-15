import { TurnSubmissionBoundary } from "../turn-dispatch-guard.ts";
import { useOutsideStoreFixture } from "../testing/outside-store-fixture.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
// A Claude turn never starts without the MCP servers it needs. Claude Code
// connects servers in the background and sends the prompt without one still
// pending (rig, 2.1.280 and 2.1.296), so the driver asks the CLI (`mcp_status`)
// before it writes the prompt, reconnects a required server once, and tells
// the bot plainly when one is still missing. Run against the fake CLI's MCP
// simulation (server/testing/fake-claude-cli.ts, FAKE_CLAUDE_MCP_READY_MS).
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver, claudeMcpStartupEnv, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { mountNeverConnectedLine } from "./stop-copy.ts";
import { MCP_OPTIONAL_WAIT_MS, toolsMayBeLoadingNotice } from "./mcp-readiness.ts";
import { windowsPerfBudget } from "../testing/windows-hosted.ts";
import { bindFixtureAdapter } from "../testing/mcp-admission-fixture.ts";

// These kept-process controls use the exact scripted CLI receipt, including
// the final synchronous identity check; native admission stays production code.
vi.mock("./claude-s2-qualification.ts", async original => {
  const actual = await original<typeof import("./claude-s2-qualification.ts")>();
  const { withClaudeWireReceipt } = await import("../testing/claude-s2-wire-receipt.ts");
  return withClaudeWireReceipt(actual);
});

const IDLE_MCP = fileURLToPath(new URL("../testing/fake-idle-mcp.mjs", import.meta.url));
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const ENV_KEYS = ["FAKE_CLAUDE_DUMP", "FAKE_CLAUDE_CONTROL_LOG", "FAKE_CLAUDE_MCP_READY_MS", "FAKE_CLAUDE_MCP_RECONNECT_MS",
  "FAKE_CLAUDE_MCP_KILL_FILE", "FAKE_CLAUDE_MCP_RECONNECT_NEEDS_CRED", "FAKE_CLAUDE_MCP_STATUS", "FAKE_CLAUDE_DUMP_EACH_TURN",
  "MURAGE_MCP_REQUIRED_WAIT_MS", "MURAGE_MCP_RECONNECT_WAIT_MS", "MURAGE_MCP_OPTIONAL_WAIT_MS", "MURAGE_MCP_RECOVERY_MS"] as const;

const composio = { command: process.execPath, args: [IDLE_MCP], env: { MURAGE_BOT_ID: "dax" } };
/** The same mount with its per-turn token, which travels in the credential file. */
const composioWithToken = () => ({ ...composio, env: { ...composio.env, MURAGE_CONNECTORS_TOKEN: `tok-${Math.random().toString(36).slice(2)}` } });
const browser = { command: process.execPath, args: [IDLE_MCP], env: {} };


/** The server's own wiring of one logical turn's submission boundary (server/index.ts), so a driver test goes through the real boundary. */
function wiredBoundary(validate: () => void = () => {}) {
  const boundary = new TurnSubmissionBoundary();
  const withdraws = vi.fn();
  boundary.onNotWritten(withdraws);
  boundary.started();
  return {
    boundary, withdraws,
    input: {
      beforeSubmit: () => boundary.beforeSubmit(validate),
      notWritten: () => boundary.notWritten(),
      attemptWritten: (id: number | void) => boundary.attemptWritten(id),
      attemptUncertain: (id: number | void) => boundary.attemptUncertain(id),
      attemptNotWritten: (id: number | void) => boundary.attemptNotWritten(id),
    },
  };
}

describe("Claude turns wait for their required MCP servers", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let dump: string;
  let controlLog: string;

  beforeEach(async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-claude-mcp-ready-"));
    dump = join(scratch, "dump.json");
    controlLog = join(scratch, "control.log");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.FAKE_CLAUDE_CONTROL_LOG = controlLog;
    instance = await ClaudeDriver.create({
      instanceId: "claude-mcp-ready",
      displayName: "Claude",
      environment: { FAKE_CLAUDE_MCP_BASELINE_MS: "2000" },
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "bypassPermissions" },
    });
    bindFixtureAdapter(instance.adapter);
    recorder = recordEvents(instance.adapter);
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    resetClaudeVersionGate();
    resetClaudeMcpReadinessForTests();
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  type ControlLine = { at: number; request?: { subtype: string; serverName?: string }; reconnected?: string; unauthorized?: boolean };
  const allControls = (): ControlLine[] => existsSync(controlLog)
    ? readFileSync(controlLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ControlLine)
    : [];
  const controls = () => allControls().filter((c): c is ControlLine & { request: { subtype: string; serverName?: string } } => !!c.request);
  const seen = () => JSON.parse(readFileSync(dump, "utf8")) as { prompt: { message: { content: string } }; env: Record<string, string>; mcpAtPrompt: Record<string, string>; promptAtMs: number; promptWallMs: number; credFile: { path: string | null; content: unknown } };
  const completed = (turnId: string) => recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId, 60_000) as Promise<Extract<RuntimeEvent, { type: "turn.completed" }>>;

  it("holds the turn until slow connected apps (8 s) connect, then runs with their tools", async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 8_000 });
    const started = Date.now();
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-slow-apps", text: "Founders sweep", integrations: { composio } });
    const done = await completed(turnId);
    expect(done).toMatchObject({ ok: true });
    expect(done.toolsUnavailable).toBeUndefined();
    const dumped = seen();
    expect(dumped.mcpAtPrompt.murage_connectors).toBe("connected");
    expect(dumped.promptAtMs).toBeGreaterThanOrEqual(8_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(8_000);
    expect(dumped.prompt.message.content).not.toContain("[Murage:");
    expect(controls().some((c) => c.request.subtype === "mcp_reconnect")).toBe(false);
    // The wait explains itself.
    const chip = recorder.events.find((e) => e.type === "item.started" && (e as { itemId?: string }).itemId === `mcp-wait-${turnId}`);
    expect(chip).toMatchObject({ title: "Loading connected apps" });
    // The CLI's own hold is off and its connect timeout is the reconnect bound.
    expect(dumped.env).toMatchObject(claudeMcpStartupEnv());
  }, 60_000);

  it("a required connected app that never connects ends the turn within one deadline with a plain notice, and nothing is sent", async () => {
    // REPLACES "reconnects connected apps that failed, within one deadline, then runs the turn with a plain notice" (ruling 2:
    // fail closed is accepted because the owner is told). The CLI gives up on the server at its MCP_TIMEOUT: failed. The one
    // reconnect fails too; the relay seals (the required mount's connection closed) and the process ends before any prompt.
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: -1 });
    process.env.FAKE_CLAUDE_MCP_RECONNECT_MS = JSON.stringify({ murage_connectors: -1 });
    process.env.MURAGE_MCP_REQUIRED_WAIT_MS = "1500";
    process.env.MURAGE_MCP_RECONNECT_WAIT_MS = "1000";
    process.env.MURAGE_MCP_RECOVERY_MS = "3000";
    const logged: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((line: unknown) => { if (typeof line === "string") logged.push(line); });
    const started = Date.now();
    try {
      const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-never-apps", text: "Founders sweep", integrations: { composio } });
      const done = await completed(turnId);
      expect(done).toMatchObject({ ok: false });
      // The owner reads why, in plain words: the notice event, not an exit code.
      const errors = recorder.events.filter((e) => e.turnId === turnId && e.type === "runtime.error") as Array<Extract<RuntimeEvent, { type: "runtime.error" }>>;
      expect(errors.map((e) => e.message)).toEqual([mountNeverConnectedLine("Claude")]);
      expect(errors[0]!.message).toBe("Claude stopped because a connected app this bot needs did not connect. Nothing was sent. Send your message again in a moment.");
      expect(errors[0]!.message).not.toMatch(/exit code|composio|\bsafe/i);
      // Nothing reached the engine: no prompt, and the close is the relay's seal.
      expect(existsSync(dump)).toBe(false);
      await vi.waitFor(() => expect(logged.some((l) => l.includes("claude close thread=t-never-apps reason=mount-relay-sealed"))).toBe(true));
    } finally { spy.mockRestore(); }
    const reconnects = controls().filter((c) => c.request.subtype === "mcp_reconnect");
    expect(reconnects.map((c) => c.request.serverName)).toEqual(["murage_connectors"]);
    // Never longer than the one recovery deadline (plus process start and slack).
    expect(Date.now() - started).toBeLessThan(3_000 + 6_000);
  }, 60_000);

  it("does not hold a turn past the short budget for a slow optional server", async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 200, browser: 20_000 });
    const started = Date.now();
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-slow-browser", text: "hi", integrations: { composio, browser } });
    const done = await completed(turnId);
    expect(done).toMatchObject({ ok: true });
    expect(done.toolsUnavailable).toBeUndefined();
    const dumped = seen();
    expect(dumped.mcpAtPrompt).toMatchObject({ murage_connectors: "connected", browser: "pending" });
    expect(dumped.promptAtMs).toBeLessThan(MCP_OPTIONAL_WAIT_MS + 1_500);
    expect(Date.now() - started).toBeLessThan(MCP_OPTIONAL_WAIT_MS + 6_000);
    expect(controls().some((c) => c.request.subtype === "mcp_reconnect")).toBe(false);
    expect(dumped.prompt.message.content).not.toContain("[Murage:");
  }, 60_000);

  it("asks a kept process again before its next turn", async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0 });
    const first = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-kept", text: "one", integrations: { composio } });
    await completed(first.turnId);
    const before = controls().filter((c) => c.request.subtype === "mcp_status").length;
    const second = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-kept", text: "two", integrations: { composio } });
    const done = await completed(second.turnId);
    expect(done).toMatchObject({ ok: true });
    expect(done.toolsUnavailable).toBeUndefined();
    // The kept process was asked again before the second prompt.
    expect(controls().filter((c) => c.request.subtype === "mcp_status").length).toBeGreaterThan(before);
  }, 60_000);

  it("a kept process whose connected-apps bridge died between turns is replaced by a FRESH process that has this turn's credentials", async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0 });
    process.env.FAKE_CLAUDE_MCP_RECONNECT_NEEDS_CRED = "1";
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    const killFile = join(scratch, "kill");
    process.env.FAKE_CLAUDE_MCP_KILL_FILE = killFile;
    const first = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-bridge-died", text: "one", integrations: { composio: composioWithToken() } });
    await completed(first.turnId);
    const firstPid = (JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid;
    // Settlement emptied the credential file; then the bridge dies.
    const credPath = seen().credFile.path!;
    expect(JSON.parse(readFileSync(credPath, "utf8"))).toEqual({});
    writeFileSync(killFile, "murage_connectors");
    const second = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-bridge-died", text: "two", integrations: { composio: composioWithToken() } });
    const done = await completed(second.turnId);
    expect(done).toMatchObject({ ok: true });
    expect(done.toolsUnavailable).toBeUndefined();
    // REPLACES "the same kept process" (ruling 1): the S2 barrier failed (the bridge was dead, claude-s2-barrier.ts: a false result means
    // recycle and submit cold), so the turn runs on a fresh process; its bridge listed its tools with this turn's token.
    expect((JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid).not.toBe(firstPid);
    expect(seen().mcpAtPrompt.murage_connectors).toBe("connected");
    expect(seen().prompt.message.content).not.toContain("[Murage:");
  }, 60_000);

  const pidOf = () => (JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid;
  const custom = { venice: { command: process.execPath, args: [IDLE_MCP], env: {} } };
  const turnOn = async (threadId: string, text: string) => completed((await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text, integrations: { custom } })).turnId);

  it("a custom server that failed on a kept process gets a FRESH process, and the turn has it back", async () => {
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ venice: 0 });
    const killFile = join(scratch, "kill");
    process.env.FAKE_CLAUDE_MCP_KILL_FILE = killFile;
    await turnOn("t-opt-back", "one");
    const firstPid = pidOf();
    writeFileSync(killFile, "venice");
    await turnOn("t-opt-back", "two");
    // REPLACES "the same pid, one reconnect" (ruling 1): a failed server ends the S2 barrier, and the turn runs cold on a fresh process.
    expect(pidOf()).not.toBe(firstPid);
    expect(seen().mcpAtPrompt.venice).toBe("connected");
  }, 60_000);

  it("a custom server still failing on each kept turn gets a fresh process on each of them, and every turn completes", async () => {
    // REPLACES "a custom server still failed after two kept turns recycles the process, and the next turn starts it fresh" (ruling 1):
    // there is no kept process left to recycle: every failed barrier relaunches cold, so no count builds up.
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    process.env.FAKE_CLAUDE_MCP_RECONNECT_MS = JSON.stringify({ venice: -1 });
    process.env.MCP_TIMEOUT = "300";
    const killFile = join(scratch, "kill");
    process.env.FAKE_CLAUDE_MCP_KILL_FILE = killFile;
    try {
      await turnOn("t-opt-dead", "one");
      const pids = [pidOf()];
      for (const text of ["two", "three", "four"]) {
        writeFileSync(killFile, "venice");
        expect(await turnOn("t-opt-dead", text)).toMatchObject({ ok: true });
        pids.push(pidOf());
      }
      expect(new Set(pids).size).toBe(pids.length);
    } finally { delete process.env.MCP_TIMEOUT; }
  }, 60_000);

  it("a server back between failures keeps its process: a fresh one per failed turn, the same one while it is up", async () => {
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    const killFile = join(scratch, "kill");
    process.env.FAKE_CLAUDE_MCP_KILL_FILE = killFile;
    await turnOn("t-opt-flap", "one");
    const firstPid = pidOf();
    // REPLACES the same-pid-after-failure assertions (ruling 1): each failed turn runs on a fresh process.
    let previous = firstPid;
    for (const text of ["two", "three", "four"]) {
      writeFileSync(killFile, "venice"); await turnOn("t-opt-flap", text);
      expect(pidOf()).not.toBe(previous); previous = pidOf();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await turnOn("t-opt-flap", "five");
    // the server is up: the kept process of turn four answers turn five (the S2 "asks a kept process again" path)
    expect(pidOf()).toBe(previous);
  }, 60_000);

  it("a slow reconnect (2.5 s) on a kept process: the turn starts before its prompt, completes with its apps, and shows no loading chip", async () => {
    // REPLACES "shows the loading chip on a kept process's slow check, on that turn" (ruling B): on the S2 kept path the barrier runs
    // before turn.started (startLiveTurn is released by the gate), so no chip can sit on that turn; turn.started is not moved.
    // The chip itself stays pinned by "holds the turn until slow connected apps (8 s) connect, then runs with their tools" (S1/cold).
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0 });
    process.env.FAKE_CLAUDE_MCP_RECONNECT_MS = JSON.stringify({ murage_connectors: 2_500 });
    const killFile = join(scratch, "kill");
    process.env.FAKE_CLAUDE_MCP_KILL_FILE = killFile;
    const first = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-warm-chip", text: "one", integrations: { composio } });
    await completed(first.turnId);
    writeFileSync(killFile, "murage_connectors");
    const second = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-warm-chip", text: "two", integrations: { composio } });
    const done = await completed(second.turnId);
    expect(done).toMatchObject({ ok: true });
    expect(done.toolsUnavailable).toBeUndefined();
    const ofTurn = recorder.events.filter((e) => e.turnId === second.turnId);
    const turnStarted = ofTurn.filter((e) => e.type === "turn.started");
    expect(turnStarted).toHaveLength(1);
    expect(Date.parse(turnStarted[0]!.createdAt)).toBeLessThanOrEqual(seen().promptWallMs);
    expect(ofTurn.some((e) => e.type === "item.started" && (e as { itemId?: string }).itemId === `mcp-wait-${second.turnId}`)).toBe(false);
    expect(seen().prompt.message.content).toContain("two");
    expect(seen().prompt.message.content).not.toContain("[Murage:");
  }, 60_000);

  it("takes this turn's credentials back out when a kept process's turn is refused at submission", async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0 });
    const first = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-refused", text: "one", integrations: { composio: composioWithToken() } });
    await completed(first.turnId);
    const credPath = seen().credFile.path!;
    await expect(instance.adapter.sendTurn({ cwd: fixtureBotFolder(),
      threadId: "t-refused", text: "two", integrations: { composio: composioWithToken() },
      beforeSubmit: () => { throw new Error("refused at submission"); },
    })).rejects.toThrow("refused at submission");
    expect(JSON.parse(readFileSync(credPath, "utf8"))).toEqual({});
  }, 60_000);

  it("tells the boundary a turn refused at the second fence (after the MCP wait) was never written", async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0 });
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    let fences = 0;
    const notWritten = vi.fn();
    const boundary = new TurnSubmissionBoundary();
    boundary.onNotWritten(notWritten);
    boundary.started();
    // a fresh process: the first fence passes before the spawn, the second runs after the MCP wait and before the prompt is written;
    // through the real boundary the sole attempt proven unwritten withdraws the stamp exactly once (per attempt, never arg-less)
    await instance.adapter.sendTurn({ cwd: fixtureBotFolder(),
      threadId: "t-second-fence", text: "one", integrations: { composio },
      beforeSubmit: () => boundary.beforeSubmit(() => { if (++fences >= 2) throw new Error("refused at the second fence"); }),
      attemptNotWritten: (id) => boundary.attemptNotWritten(id),
      notWritten: () => boundary.notWritten(),
    }).catch(() => undefined);
    await vi.waitFor(() => expect(fences).toBeGreaterThanOrEqual(2), { timeout: 30_000 });
    await vi.waitFor(() => expect(notWritten).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(boundary.canRetry).toBe(true);
  }, 60_000);

  it("D3: the launch attempt (no prompt bytes at spawn) and a second fence refused through the REAL boundary: every attempt unwritten, the turn may rebuild, nothing sent", async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0 });
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    let fences = 0;
    const wired = wiredBoundary(() => { if (++fences >= 2) throw new Error("refused at the second fence"); });
    await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-d3-boundary", text: "one", integrations: { composio }, ...wired.input }).catch(() => undefined);
    await vi.waitFor(() => expect(fences).toBeGreaterThanOrEqual(2), { timeout: 30_000 });
    await vi.waitFor(() => expect(wired.withdraws).toHaveBeenCalled(), { timeout: 10_000 });
    expect(wired.boundary.hasReleasedSubmission).toBe(false);
    expect(wired.boundary.canRetry).toBe(true);
  }, 60_000);

  it("a build that refuses mcp_status: readiness unknown on the turn and in the notice, the CLI's own hold kept, and it is not asked again", async () => {
    process.env.FAKE_CLAUDE_MCP_STATUS = "error";
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    const first = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-old-cli", text: "one", integrations: { composio } });
    const done = await completed(first.turnId);
    expect(done).toMatchObject({ ok: true, mcpReadiness: "unknown" });
    expect(done.toolsUnavailable).toBeUndefined();
    // 1.0.3.1: the permission broker (muragebox) is a required server, so an unchecked turn names it too
    expect(seen().prompt.message.content.startsWith(toolsMayBeLoadingNotice(["connected apps", "approvals"]))).toBe(true);
    const asked = controls().filter((c) => c.request.subtype === "mcp_status").length;
    expect(asked).toBe(1);
    const second = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-old-cli", text: "two", integrations: { composio } });
    expect(await completed(second.turnId)).toMatchObject({ ok: true, mcpReadiness: "unknown" });
    expect(controls().filter((c) => c.request.subtype === "mcp_status").length).toBe(asked);
    // A new process of the same build keeps the CLI's own bounded start-up hold.
    const other = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-old-cli-2", text: "one", integrations: { composio } });
    await completed(other.turnId);
    expect(seen().env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS).toBeUndefined();
    expect(seen().env).toMatchObject(claudeMcpStartupEnv(false));
  }, 60_000);

  it("a kept process spawned with the start-up hold off is replaced once its build is learned not to answer mcp_status", async () => {
    process.env.FAKE_CLAUDE_MCP_STATUS = "error";
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    const first = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-hold", text: "one", integrations: { composio } });
    await completed(first.turnId);
    const firstDump = seen() as ReturnType<typeof seen> & { pid: number };
    // The learning turn's process was launched with the CLI's own hold off.
    expect(firstDump.env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS).toBe("0");
    const second = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-hold", text: "two", integrations: { composio } });
    await completed(second.turnId);
    const secondDump = seen() as ReturnType<typeof seen> & { pid: number };
    // A new process with the CLI's native hold, not the pooled one with none.
    expect(secondDump.pid).not.toBe(firstDump.pid);
    expect(secondDump.env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS).toBeUndefined();
    expect(secondDump.env).toMatchObject(claudeMcpStartupEnv(false));
    // REPLACES "from then on that process is kept" (ruling A): a build that does not answer mcp_status is never S2-eligible
    // (design LASTRESORT-A3F-S2-CLAUDE-1018.md section 2 line 24), so a mounted turn on it is single-use: a fresh process each turn.
    // The product gates it in three independent places: the reuse decision (claude.ts spawnReason, mounted-single-use), the settle
    // path (retire only when claudeMcpStatusSupport !== "unsupported"), and the s2Eligible initialiser at spawn. The initialiser is
    // redundant with the other two (every consumer of s2Eligible is behind one of them), so removing only it (mutant M4) is an
    // EQUIVALENT mutant, proved in the pack; this row goes red on removing either of the other two.
    const third = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-hold", text: "three", integrations: { composio } });
    await completed(third.turnId);
    expect((seen() as unknown as { pid: number }).pid).not.toBe(secondDump.pid);
    // A process on a build that does not answer mcp_status never enters the S2 barrier, so it is never sent mcp_reconnect on any of its turns.
    expect(controls().filter((c) => c.request.subtype === "mcp_reconnect")).toEqual([]);
  }, 60_000);

  // Enforced in the serial timing run (MURAGE_TEST_TIMING=1, on the quiet timing box under its lock; a MURAGE_ key without a TEST word is scrubbed by server/testing/murage-env.mjs, so this name is the one a test sees); sharded and loaded runs skip it, as worker-slices does.
  // REPLACES the 50 ms "near-zero" bound (MurageMain ruling): that bound predates S2. S2's own pass rule is handoffs/designs/LASTRESORT-A3F-S2-CLAUDE-1018.md
  // section 6 (line 44): p50(d) <= 300 ms and p95(d) <= 600 ms, d = added send-to-prompt time of a kept mounted turn over the same turn with no MCP gate.
  // The reconnect-per-kept-turn count has its own row below, which runs everywhere.
  it.skipIf(process.env.MURAGE_TEST_TIMING !== "1")("adds near-zero latency to a kept process's turn when everything is ready", { timeout: 120_000, ...windowsPerfBudget() }, async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0, "murage-memory": 0, agents: 0 });
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    const mounts = { composio, "murage-memory": { ...composio, args: [IDLE_MCP] }, agents: { ...composio, args: [IDLE_MCP] } };
    const pct = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.max(0, Math.ceil(q * values.length) - 1))]!;
    const measure = async (threadId: string, integrations: Record<string, unknown> | undefined): Promise<number[]> => {
      const warmUp = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: "warm", ...(integrations ? { integrations } : {}) });
      await completed(warmUp.turnId);
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        const sentAt = Date.now();
        const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId, text: `turn ${i}`, ...(integrations ? { integrations } : {}) });
        await completed(turnId);
        samples.push(seen().promptWallMs - sentAt);
      }
      return samples;
    };
    const reconnectsByServer = () => {
      const counts: Record<string, number> = {};
      for (const c of controls()) if (c.request.subtype === "mcp_reconnect") counts[c.request.serverName!] = (counts[c.request.serverName!] ?? 0) + 1;
      return counts;
    };
    const withoutSamples = await measure("t-latency-none", undefined);
    const beforeGate = reconnectsByServer();
    const gateSamples = await measure("t-latency-gate", mounts);
    const baseline = pct(withoutSamples, 0.5);
    const d = gateSamples.map((v) => v - baseline);
    const statusAsks = controls().filter((c) => c.request.subtype === "mcp_status").length;
    console.info(`MCP-GATE-LATENCY warm send-to-prompt: no MCP gate median ${baseline} ms, all-ready gate median ${pct(gateSamples, 0.5)} ms, added p50 ${pct(d, 0.5)} ms p95 ${pct(d, 0.95)} ms (status asks ${statusAsks})`);
    // REPLACES "no mcp_reconnect at all" (ruling 3): the S2 barrier reconnects every mounted server once per kept turn, in parallel
    // (handoffs/designs/LASTRESORT-A3F-S2-CLAUDE-1018.md section 2 step 3, lines 21-22; server/drivers/claude-s2-barrier.ts awaitClaudeS2Barrier, Promise.all over every mount name).
    // The warm-up turn is cold; the 20 measured turns are kept turns: exactly 20 reconnects per mounted server, never more.
    const after = reconnectsByServer();
    const added = Object.fromEntries(Object.entries(after).map(([name, n]) => [name, n - (beforeGate[name] ?? 0)]).filter(([, n]) => (n as number) > 0));
    expect(Object.keys(added)).toContain("murage_connectors");
    for (const n of Object.values(added)) expect(n).toBe(20);
    expect(pct(d, 0.5)).toBeLessThanOrEqual(300);
    expect(pct(d, 0.95)).toBeLessThanOrEqual(600);
  });

  it("reconnects each mounted server exactly once per kept turn (S2 barrier), never more", { timeout: 60_000 }, async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0, "murage-memory": 0, agents: 0 });
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    const mounts = { composio, "murage-memory": { ...composio, args: [IDLE_MCP] }, agents: { ...composio, args: [IDLE_MCP] } };
    const reconnects = () => {
      const counts: Record<string, number> = {};
      for (const c of controls()) if (c.request.subtype === "mcp_reconnect") counts[c.request.serverName!] = (counts[c.request.serverName!] ?? 0) + 1;
      return counts;
    };
    const warm = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-recon-count", text: "warm", integrations: mounts });
    await completed(warm.turnId);
    const before = reconnects();
    for (let i = 0; i < 3; i++) {
      const previousPid = pidOf();
      const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-recon-count", text: `turn ${i}`, integrations: mounts });
      await completed(turnId);
      // A real reconnect starts new shim children. The conservative idle
      // inspection can retire that process after its turn, so a cold send
      // here establishes the next kept process instead of being a kept turn.
      // Drive exactly three actual kept turns; a driver that always runs cold
      // still fails the independent pid check and the original exact counts.
      if (pidOf() !== previousPid) {
        const coldPid = pidOf();
        const kept = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-recon-count", text: `kept turn ${i}`, integrations: mounts });
        await completed(kept.turnId);
        // MAIN RULING INT-CONFLICT-DEFAULT 48a79a9071 / 8989ed69d6e: independently prove a kept turn; preserve the three exact reconnect counts below.
        expect(pidOf()).toBe(coldPid);
      }
    }
    const after = reconnects();
    const added = Object.fromEntries(Object.entries(after).map(([name, n]) => [name, n - (before[name] ?? 0)]).filter(([, n]) => (n as number) > 0));
    expect(Object.keys(added)).toContain("murage_connectors");
    for (const n of Object.values(added)) expect(n).toBe(3);
  });
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
