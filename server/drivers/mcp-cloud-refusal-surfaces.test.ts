// What the owner reads when a Cloud launch refuses an add-on (MCP) server, seen from each driver's own surface:
// the stream events, or the error the driver hands its caller. The host code stays on `.code` for logs only.
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { windowRuntimeEvent } from "../runtime-event-out.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
import { McpScopeUnavailableError, MCP_CLOUD_UNAVAILABLE_TEXT } from "./mcp-stop-runtime.ts";
import { createAcpDriver, resetAcpMcpReadinessForTests, type AcpSupport } from "./acp/core.ts";

const CODE = "MCP_CLOUD_SCOPE_UNAVAILABLE";
const fake = (name: string) => fileURLToPath(new URL(`../testing/${name}`, import.meta.url));
const mountedInput = (threadId: string, cwd: string, extra: Partial<SendTurnInput> = {}): SendTurnInput => ({
  threadId, cwd, text: "hello", warmIdentity: { botId: `${threadId}-bot`, audience: "owner", decidedOwner: true },
  integrations: { agents: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } }, ...extra,
});
/** Every string the owner-facing stream would carry for these events (the projection the log and the UI both get). */
const ownerText = (events: readonly RuntimeEvent[]) => JSON.stringify(events.map(event => windowRuntimeEvent(event)));

let scratch = "";
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
beforeEach(() => {
  ensureDirs();
  scratch = mkdtempSync(join(tmpdir(), "murage-mcp-refusal-"));
  mkdirSync(join(scratch, "work"));
  // The Cloud launch refusal arrives from the mount relay (planMcpSpawn); every driver reaches it through CliMountRelay.create.
  vi.spyOn(CliMountRelay, "create").mockRejectedValue(new McpScopeUnavailableError());
});
afterEach(async () => {
  recorder?.stop(); recorder = undefined;
  await instance?.dispose(); instance = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await removeTempDir(scratch);
});

describe("MCP Cloud refusal, owner-facing surface per driver", () => {
  it.each([
    ["claude", () => ClaudeDriver.create({ instanceId: "refuse-claude", displayName: "Claude", enabled: true, environment: { CLAUDE_CONFIG_DIR: join(scratch, "claude") },
      config: { cli: fake("fake-claude-cli.ts"), permissionMode: "acceptEdits" } as never })],
    ["codex", () => CodexDriver.create({ instanceId: "refuse-codex", displayName: "Codex", enabled: true, environment: {},
      config: { cli: fake("fake-codex-app-server.ts"), fullAuto: false } as never })],
  ])("%s hands its caller the plain sentence and never the code", async (_name, make) => {
    chmodSync(fake("fake-claude-cli.ts"), 0o755); chmodSync(fake("fake-codex-app-server.ts"), 0o755);
    instance = await make();
    recorder = recordEvents(instance.adapter);
    // Claude rethrows from sendTurn; Codex settles the turn with a runtime.error. Either way this is what the owner reads.
    const sent = await instance.adapter.sendTurn(fixtureMountTurn(mountedInput(`refuse-${_name}`, join(scratch, "work"))))
      .then(value => value, caught => caught as Error);
    const failure = sent instanceof Error ? sent
      : await recorder.until(event => event.type === "runtime.error" && event.turnId === sent.turnId);
    expect((failure as { message?: string }).message).toBe(MCP_CLOUD_UNAVAILABLE_TEXT);
    expect(ownerText(recorder.events)).not.toContain(CODE);
    expect((failure as { engineCode?: string }).engineCode).toBeUndefined();
  });

  it("acp emits the plain sentence in its runtime.error and keeps the code out of the owner-facing event", async () => {
    resetAcpMcpReadinessForTests();
    const cli = fake("fake-acp-cli.ts"); chmodSync(cli, 0o755);
    vi.stubEnv("MURAGE_ACP_POOL", "1"); vi.stubEnv("FAKE_ACP_MCP_LIST", "all:ready");
    const support: AcpSupport = {
      driverKind: "fuigoAgent", displayName: "Refusal ACP", defaultCli: cli, nativeSource: "refusal.acp",
      models: { default: "", options: [] }, loginNote: "fixture", spawnArgs: () => [],
      pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
      pooledSessions: true, mcpListMethod: "_fuigo/mcp/list", fluxReach: () => "elsewhere",
    };
    instance = await createAcpDriver(support).create({ instanceId: "refuse-acp", displayName: "Refusal ACP", enabled: true,
      environment: { HOME: scratch }, config: { cli, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    const sent = await instance.adapter.sendTurn(fixtureMountTurn(mountedInput("refuse-acp", join(scratch, "work"))));
    const failure = await recorder.until(event => event.type === "runtime.error" && event.turnId === sent.turnId);
    expect(failure).toMatchObject({ type: "runtime.error", message: MCP_CLOUD_UNAVAILABLE_TEXT });
    expect((failure as { engineCode?: string }).engineCode).toBeUndefined();
    expect(ownerText(recorder.events)).not.toContain(CODE);
  });

  it("antigravity hands its caller the plain sentence, not the memory-context code, and never the host code", async () => {
    chmodSync(fake("fake-agy-cli.ts"), 0o755);
    vi.stubEnv("FAKE_AGY_RUN_HOOKS", "1");
    instance = await AntigravityDriver.create({ instanceId: "refuse-agy", displayName: "Antigravity", enabled: true,
      environment: { HOME: join(scratch, "home") }, config: { cli: fake("fake-agy-cli.ts"), fullAuto: true } as never });
    recorder = recordEvents(instance.adapter);
    const error = await instance.adapter.sendTurn(fixtureMountTurn(mountedInput("refuse-agy", join(scratch, "work"), { routeAsks: true, askLevel: true })))
      .then(() => undefined, caught => caught as Error);
    expect(error).toBeDefined();
    expect(error!.message).toBe(MCP_CLOUD_UNAVAILABLE_TEXT);
    expect(ownerText(recorder.events)).not.toContain(CODE);
  });
});
