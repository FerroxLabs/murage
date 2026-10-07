// Contract tests for the OpenClaw ACP driver. The scripted fake ACP CLI
// stands in for `openclaw acp`; no real openclaw binary is ever run.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { OpenclawAgentDriver, openclawBridgeArgs } from "./openclaw.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("OpenclawAgentDriver config", () => {
  it("is registered as a built-in driver", () => {
    expect(BUILT_IN_DRIVERS.some((d) => d.driverKind === "openclawAgent")).toBe(true);
  });

  it("spawns `openclaw acp --session agent:<name>:main` for the chosen agent", () => {
    expect(openclawBridgeArgs({ agent: "fred" })).toEqual(["acp", "--session", "agent:fred:main"]);
  });

  it("defaults to the main agent when none is configured or the name is invalid", () => {
    expect(openclawBridgeArgs(undefined)).toEqual(["acp", "--session", "agent:main:main"]);
    expect(openclawBridgeArgs({})).toEqual(["acp", "--session", "agent:main:main"]);
    expect(openclawBridgeArgs({ agent: "../etc" })).toEqual(["acp", "--session", "agent:main:main"]);
    expect(openclawBridgeArgs({ agent: "A b" })).toEqual(["acp", "--session", "agent:main:main"]);
  });

  it("decodes the agent off the raw instance config and drops invalid values", () => {
    expect(OpenclawAgentDriver.decodeConfig({ agent: "fred" })).toMatchObject({ cli: "openclaw", agent: "fred" });
    expect(OpenclawAgentDriver.decodeConfig({ agent: "../x" }).agent).toBeUndefined();
    expect(OpenclawAgentDriver.decodeConfig({}).agent).toBeUndefined();
  });

  it("declares that it runs on its own tools: no Murage mounts and no stop-line claimed", async () => {
    const instance = await OpenclawAgentDriver.create({
      instanceId: "openclaw-caps",
      displayName: "OpenClaw Caps",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      const caps = instance.adapter.capabilities;
      expect(caps.runsOnOwnTools).toBe(true);
      for (const key of ["agentsMcp", "memoryMcp", "customMcp", "computerMcp", "composioMcp", "browserMcp", "localComputerMcp"] as const) {
        expect(caps[key], key).toBe(false);
      }
    } finally {
      await instance.dispose();
    }
  });

  it("advertises the custom rail, multi-instance, and a passthrough model", () => {
    expect(OpenclawAgentDriver.metadata).toMatchObject({ access: "custom", supportsMultipleInstances: true });
    expect(OpenclawAgentDriver.models.options).toEqual([
      { id: "openclaw-default", label: "OpenClaw agent default", custom: true },
    ]);
  });
});

describe("OpenclawAgentDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (config: Record<string, unknown> = {}, environment: Record<string, string> = {}) => {
    instance = await OpenclawAgentDriver.create({
      instanceId: "openclaw-test",
      displayName: "OpenClaw Test",
      environment,
      enabled: true,
      // The fake CLI stands in for the `openclaw` binary.
      config: { cli: FAKE_CLI, fullAuto: false, ...config },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-openclaw-acp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.XAI_API_KEY;
    delete process.env.FLUX_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  const dumped = (dump: string) =>
    JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string | undefined> };

  it("runs a full turn with an empty authMethods bridge and names the agent in argv", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_MODE = "no-auth";
    await create({ agent: "fred" });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-oc", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "openclawAgent")).toBe(true);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(dumped(dump).argv).toEqual(["acp", "--session", "agent:fred:main"]);
  });

  it("uses the default agent when none is configured", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_MODE = "no-auth";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-oc-default", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(dumped(dump).argv).toEqual(["acp", "--session", "agent:main:main"]);
  });

  it("hands the bridge no Murage tool mounts even when the turn carries them", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_MODE = "no-auth";
    await create({ agent: "fred" });
    await instance.adapter.sendTurn({
      threadId: "t-oc-mounts",
      text: "hi",
      integrations: {
        agents: { command: "node", args: ["agents.js"], env: { A: "1" } },
        memory: { command: "node", args: ["memory.js"], env: {} },
      },
    } as never);
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    const state = JSON.parse(readFileSync(dump, "utf8")) as { mcpServers?: unknown[] };
    expect(state.mcpServers ?? []).toEqual([]);
  });

  it("injects no credentials: no Flux or foreign provider key reaches the child", async () => {
    process.env.XAI_API_KEY = "xai-should-not-leak";
    process.env.FLUX_API_KEY = "flux-should-not-leak";
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_MODE = "no-auth";
    await create({ agent: "fred" });
    await instance.adapter.sendTurn({ threadId: "t-oc-env", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const { env } = dumped(dump);
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(Object.keys(env).filter((k) => /flux/i.test(k))).toEqual([]);
    expect(env.HERMES_HOME).toBeUndefined();
  });
});
