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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver, claudeMcpStartupEnv, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { MCP_OPTIONAL_WAIT_MS, toolsMayBeLoadingNotice, toolsUnavailableNotice } from "./mcp-readiness.ts";
import { windowsPerfBudget } from "../testing/windows-hosted.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const ENV_KEYS = ["FAKE_CLAUDE_DUMP", "FAKE_CLAUDE_CONTROL_LOG", "FAKE_CLAUDE_MCP_READY_MS", "FAKE_CLAUDE_MCP_RECONNECT_MS",
  "FAKE_CLAUDE_MCP_KILL_FILE", "FAKE_CLAUDE_MCP_RECONNECT_NEEDS_CRED", "FAKE_CLAUDE_MCP_STATUS", "FAKE_CLAUDE_DUMP_EACH_TURN",
  "MURAGE_MCP_REQUIRED_WAIT_MS", "MURAGE_MCP_RECONNECT_WAIT_MS", "MURAGE_MCP_OPTIONAL_WAIT_MS", "MURAGE_MCP_RECOVERY_MS"] as const;

const composio = { command: process.execPath, args: ["/fake/connector-proxy.js"], env: { MURAGE_BOT_ID: "dax" } };
/** The same mount with its per-turn token, which travels in the credential file. */
const composioWithToken = () => ({ ...composio, env: { ...composio.env, MURAGE_CONNECTORS_TOKEN: `tok-${Math.random().toString(36).slice(2)}` } });
const browser = { command: process.execPath, args: ["/fake/browser-proxy.js"], env: {} };

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
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "bypassPermissions" },
    });
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
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-slow-apps", text: "Founders sweep", integrations: { composio } });
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

  it("reconnects connected apps that failed, within one deadline, then runs the turn with a plain notice", async () => {
    // The CLI gives up on the server at its MCP_TIMEOUT (the reconnect bound,
    // 1 s here): failed. The one reconnect fails too.
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: -1 });
    process.env.FAKE_CLAUDE_MCP_RECONNECT_MS = JSON.stringify({ murage_connectors: -1 });
    process.env.MURAGE_MCP_REQUIRED_WAIT_MS = "1500";
    process.env.MURAGE_MCP_RECONNECT_WAIT_MS = "1000";
    process.env.MURAGE_MCP_RECOVERY_MS = "3000";
    const started = Date.now();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-never-apps", text: "Founders sweep", integrations: { composio } });
    const done = await completed(turnId);
    expect(done).toMatchObject({ ok: true, toolsUnavailable: ["connected apps"] });
    const reconnects = controls().filter((c) => c.request.subtype === "mcp_reconnect");
    expect(reconnects.map((c) => c.request.serverName)).toEqual(["murage_connectors"]);
    const prompt = seen().prompt.message.content;
    expect(prompt.startsWith(toolsUnavailableNotice(["connected apps"]))).toBe(true);
    expect(prompt).toContain("Founders sweep");
    expect(prompt).not.toMatch(/composio|—|\bsafe/i);
    // Never longer than the one recovery deadline (plus process start and slack).
    expect(Date.now() - started).toBeLessThan(3_000 + 6_000);
  }, 60_000);

  it("does not hold a turn past the short budget for a slow optional server", async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 200, browser: 20_000 });
    const started = Date.now();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-slow-browser", text: "hi", integrations: { composio, browser } });
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
    const first = await instance.adapter.sendTurn({ threadId: "t-kept", text: "one", integrations: { composio } });
    await completed(first.turnId);
    const before = controls().filter((c) => c.request.subtype === "mcp_status").length;
    const second = await instance.adapter.sendTurn({ threadId: "t-kept", text: "two", integrations: { composio } });
    const done = await completed(second.turnId);
    expect(done).toMatchObject({ ok: true });
    expect(done.toolsUnavailable).toBeUndefined();
    // The kept process was asked again before the second prompt.
    expect(controls().filter((c) => c.request.subtype === "mcp_status").length).toBeGreaterThan(before);
  }, 60_000);

  it("a kept process whose connected-apps bridge died between turns reconnects WITH this turn's credentials", async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0 });
    process.env.FAKE_CLAUDE_MCP_RECONNECT_NEEDS_CRED = "1";
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    const killFile = join(scratch, "kill");
    process.env.FAKE_CLAUDE_MCP_KILL_FILE = killFile;
    const first = await instance.adapter.sendTurn({ threadId: "t-bridge-died", text: "one", integrations: { composio: composioWithToken() } });
    await completed(first.turnId);
    const firstPid = (JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid;
    // Settlement emptied the credential file; then the bridge dies.
    const credPath = seen().credFile.path!;
    expect(JSON.parse(readFileSync(credPath, "utf8"))).toEqual({});
    writeFileSync(killFile, "murage_connectors");
    const second = await instance.adapter.sendTurn({ threadId: "t-bridge-died", text: "two", integrations: { composio: composioWithToken() } });
    const done = await completed(second.turnId);
    expect(done).toMatchObject({ ok: true });
    expect(done.toolsUnavailable).toBeUndefined();
    // The same kept process; the restarted bridge listed its tools with a token.
    expect((JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid).toBe(firstPid);
    expect(allControls().filter((c) => c.reconnected === "murage_connectors")).toEqual([expect.objectContaining({ unauthorized: false })]);
    expect(seen().mcpAtPrompt.murage_connectors).toBe("connected");
    expect(seen().prompt.message.content).not.toContain("[Murage:");
  }, 60_000);

  it("shows the loading chip on a kept process's slow check, on that turn", async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0 });
    process.env.FAKE_CLAUDE_MCP_RECONNECT_MS = JSON.stringify({ murage_connectors: 2_500 });
    const killFile = join(scratch, "kill");
    process.env.FAKE_CLAUDE_MCP_KILL_FILE = killFile;
    const first = await instance.adapter.sendTurn({ threadId: "t-warm-chip", text: "one", integrations: { composio } });
    await completed(first.turnId);
    writeFileSync(killFile, "murage_connectors");
    const second = await instance.adapter.sendTurn({ threadId: "t-warm-chip", text: "two", integrations: { composio } });
    const done = await completed(second.turnId);
    expect(done).toMatchObject({ ok: true });
    expect(done.toolsUnavailable).toBeUndefined();
    const ofTurn = recorder.events.filter((e) => e.turnId === second.turnId);
    const startedAt = ofTurn.findIndex((e) => e.type === "turn.started");
    const chipAt = ofTurn.findIndex((e) => e.type === "item.started" && (e as { itemId?: string }).itemId === `mcp-wait-${second.turnId}`);
    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(chipAt).toBeGreaterThan(startedAt);
    expect(ofTurn[chipAt]).toMatchObject({ title: "Loading connected apps" });
    expect(ofTurn.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(ofTurn.find((e) => e.type === "item.completed" && (e as { itemId?: string }).itemId === `mcp-wait-${second.turnId}`)).toMatchObject({ ok: true });
  }, 60_000);

  it("takes this turn's credentials back out when a kept process's turn is refused at submission", async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0 });
    const first = await instance.adapter.sendTurn({ threadId: "t-refused", text: "one", integrations: { composio: composioWithToken() } });
    await completed(first.turnId);
    const credPath = seen().credFile.path!;
    await expect(instance.adapter.sendTurn({
      threadId: "t-refused", text: "two", integrations: { composio: composioWithToken() },
      beforeSubmit: () => { throw new Error("refused at submission"); },
    })).rejects.toThrow("refused at submission");
    expect(JSON.parse(readFileSync(credPath, "utf8"))).toEqual({});
  }, 60_000);

  it("a build that refuses mcp_status: readiness unknown on the turn and in the notice, the CLI's own hold kept, and it is not asked again", async () => {
    process.env.FAKE_CLAUDE_MCP_STATUS = "error";
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    const first = await instance.adapter.sendTurn({ threadId: "t-old-cli", text: "one", integrations: { composio } });
    const done = await completed(first.turnId);
    expect(done).toMatchObject({ ok: true, mcpReadiness: "unknown" });
    expect(done.toolsUnavailable).toBeUndefined();
    expect(seen().prompt.message.content.startsWith(toolsMayBeLoadingNotice(["connected apps"]))).toBe(true);
    const asked = controls().filter((c) => c.request.subtype === "mcp_status").length;
    expect(asked).toBe(1);
    const second = await instance.adapter.sendTurn({ threadId: "t-old-cli", text: "two", integrations: { composio } });
    expect(await completed(second.turnId)).toMatchObject({ ok: true, mcpReadiness: "unknown" });
    expect(controls().filter((c) => c.request.subtype === "mcp_status").length).toBe(asked);
    // A new process of the same build keeps the CLI's own bounded start-up hold.
    const other = await instance.adapter.sendTurn({ threadId: "t-old-cli-2", text: "one", integrations: { composio } });
    await completed(other.turnId);
    expect(seen().env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS).toBeUndefined();
    expect(seen().env).toMatchObject(claudeMcpStartupEnv(false));
  }, 60_000);

  it("a kept process spawned with the start-up hold off is replaced once its build is learned not to answer mcp_status", async () => {
    process.env.FAKE_CLAUDE_MCP_STATUS = "error";
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    const first = await instance.adapter.sendTurn({ threadId: "t-hold", text: "one", integrations: { composio } });
    await completed(first.turnId);
    const firstDump = seen() as ReturnType<typeof seen> & { pid: number };
    // The learning turn's process was launched with the CLI's own hold off.
    expect(firstDump.env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS).toBe("0");
    const second = await instance.adapter.sendTurn({ threadId: "t-hold", text: "two", integrations: { composio } });
    await completed(second.turnId);
    const secondDump = seen() as ReturnType<typeof seen> & { pid: number };
    // A new process with the CLI's native hold, not the pooled one with none.
    expect(secondDump.pid).not.toBe(firstDump.pid);
    expect(secondDump.env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS).toBeUndefined();
    expect(secondDump.env).toMatchObject(claudeMcpStartupEnv(false));
    // From then on that process is kept.
    const third = await instance.adapter.sendTurn({ threadId: "t-hold", text: "three", integrations: { composio } });
    await completed(third.turnId);
    expect((seen() as unknown as { pid: number }).pid).toBe(secondDump.pid);
  }, 60_000);

  it("adds near-zero latency to a kept process's turn when everything is ready", { timeout: 120_000, ...windowsPerfBudget() }, async () => {
    process.env.FAKE_CLAUDE_MCP_READY_MS = JSON.stringify({ murage_connectors: 0, "murage-memory": 0, agents: 0 });
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    const mounts = { composio, "murage-memory": { ...composio, args: ["/fake/memory.js"] }, agents: { ...composio, args: ["/fake/agents.js"] } };
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    const measure = async (threadId: string, integrations: Record<string, unknown> | undefined): Promise<number> => {
      const warmUp = await instance.adapter.sendTurn({ threadId, text: "warm", ...(integrations ? { integrations } : {}) });
      await completed(warmUp.turnId);
      const samples: number[] = [];
      for (let i = 0; i < 8; i++) {
        const sentAt = Date.now();
        const { turnId } = await instance.adapter.sendTurn({ threadId, text: `turn ${i}`, ...(integrations ? { integrations } : {}) });
        await completed(turnId);
        samples.push(seen().promptWallMs - sentAt);
      }
      return median(samples);
    };
    const without = await measure("t-latency-none", undefined);
    const withGate = await measure("t-latency-gate", mounts);
    const statusAsks = controls().filter((c) => c.request.subtype === "mcp_status").length;
    console.info(`MCP-GATE-LATENCY warm send-to-prompt median: no MCP gate ${without} ms, all-ready gate ${withGate} ms, added ${withGate - without} ms (status asks ${statusAsks})`);
    expect(controls().some((c) => c.request.subtype === "mcp_reconnect")).toBe(false);
    expect(withGate - without).toBeLessThan(50);
  });
});
