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
import { TURN_ASK_RULES } from "../../../shared/ask-wording.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("OpenclawAgentDriver config", () => {
  it("is registered as a built-in driver", () => {
    expect(BUILT_IN_DRIVERS.some((d) => d.driverKind === "openclawAgent")).toBe(true);
  });

  const owner = (threadId: string) => ({ threadId, warmIdentity: { botId: "b1", audience: "owner" as const } });
  const guest = (threadId: string, humanPrincipal?: string) => ({ threadId, warmIdentity: { botId: "b1", audience: "non-owner" as const, ...(humanPrincipal ? { humanPrincipal } : {}) } });
  const key = (args: string[]) => { expect(args.slice(0, 2)).toEqual(["acp", "--session"]); return args[2]!; };

  it("spawns `openclaw acp --session agent:<name>:murage-...` for the chosen agent", () => {
    expect(key(openclawBridgeArgs({ agent: "fred" }, owner("t1")))).toMatch(/^agent:fred:murage-owner-[0-9a-f]{24}$/);
  });

  it("defaults to the main agent when none is configured or the name is invalid", () => {
    for (const config of [undefined, {}, { agent: "../etc" }, { agent: "A b" }]) {
      expect(key(openclawBridgeArgs(config, owner("t1")))).toMatch(/^agent:main:murage-owner-[0-9a-f]{24}$/);
    }
  });

  // Audit 03-3: every launch got `agent:<agent>:main`, so every conversation on
  // one agent was one OpenClaw conversation, whoever it was for.
  it("gives each conversation its own OpenClaw conversation, and never hands the owner's to anyone else", () => {
    const a = key(openclawBridgeArgs({ agent: "fred" }, owner("thread-a")));
    const b = key(openclawBridgeArgs({ agent: "fred" }, owner("thread-b")));
    expect(a).not.toBe(b);
    expect(key(openclawBridgeArgs({ agent: "fred" }, owner("thread-a")))).toBe(a); // stable, so resume keeps working
    for (const turn of [guest("thread-a"), guest("thread-a", "p1:b1"), { threadId: "thread-a" }]) {
      const other = key(openclawBridgeArgs({ agent: "fred" }, turn));
      expect(other).toMatch(/^agent:fred:murage-guest-[0-9a-f]{24}$/);
      expect(other).not.toBe(a);
    }
    expect(key(openclawBridgeArgs({ agent: "fred" }, guest("thread-a", "p1:b1")))).not.toBe(key(openclawBridgeArgs({ agent: "fred" }, guest("thread-a", "p2:b2"))));
    expect(key(openclawBridgeArgs({ agent: "fred" }, owner("thread-a")))).not.toContain("thread-a");
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
    expect(dumped(dump).argv[2]).toMatch(/^agent:fred:murage-(owner|guest)-[0-9a-f]{24}$/);
  });

  it("two conversations on one OpenClaw bot spawn on different OpenClaw conversations; a guest never gets the owner's", async () => {
    process.env.FAKE_ACP_MODE = "no-auth";
    await create({ agent: "fred" });
    const argvFor = async (turn: { threadId: string; warmIdentity?: { botId: string; audience: "owner" | "non-owner"; humanPrincipal?: string } }) => {
      const dump = join(scratch, `dump-${turn.threadId}-${turn.warmIdentity?.audience ?? "none"}.json`);
      process.env.FAKE_ACP_DUMP = dump;
      const { turnId } = await instance.adapter.sendTurn({ ...turn, text: "hi" });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      return dumped(dump).argv;
    };
    const ownerA = await argvFor({ threadId: "t-oc-a", warmIdentity: { botId: "b1", audience: "owner" } });
    const ownerB = await argvFor({ threadId: "t-oc-b", warmIdentity: { botId: "b1", audience: "owner" } });
    const guestC = await argvFor({ threadId: "t-oc-c", warmIdentity: { botId: "b1", audience: "non-owner", humanPrincipal: "p1:b1" } });
    expect(ownerA[1]).toBe("--session");
    expect(new Set([ownerA[2], ownerB[2], guestC[2]]).size).toBe(3);
    expect(guestC[2]).toMatch(/^agent:fred:murage-guest-/);
  });

  it("a reset turn moves the conversation to a new gateway key, and later turns keep it (03-A2)", async () => {
    process.env.FAKE_ACP_MODE = "no-auth";
    await create({ agent: "fred" });
    const keyFor = async (threadId: string, extra: { sessionReset?: boolean } = {}) => {
      const dump = join(scratch, `dump-${threadId}-${Math.random().toString(36).slice(2)}.json`);
      process.env.FAKE_ACP_DUMP = dump;
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi", warmIdentity: { botId: "b1", audience: "owner" }, ...extra });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      return dumped(dump).argv[2]!;
    };
    const before = await keyFor("t-oc-reset");
    const other = await keyFor("t-oc-untouched");
    const afterReset = await keyFor("t-oc-reset", { sessionReset: true });
    expect(afterReset).not.toBe(before);
    expect(afterReset).toMatch(/^agent:fred:murage-owner-[0-9a-f]{24}$/);
    expect(await keyFor("t-oc-reset")).toBe(afterReset);
    expect(await keyFor("t-oc-untouched")).toBe(other);
  });

  it("uses the default agent when none is configured", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_MODE = "no-auth";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-oc-default", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(dumped(dump).argv[2]).toMatch(/^agent:main:murage-(owner|guest)-[0-9a-f]{24}$/);
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

  it("sends a non-Ask prompt with no /exec directive, as in 1.0.2, so the owner's OpenClaw policy applies (2026.10.5 refused redirects under ask=always)", async () => {
    const promptDump = join(scratch, "prompt.json");
    process.env.FAKE_ACP_PROMPT_DUMP = promptDump;
    process.env.FAKE_ACP_MODE = "no-auth";
    await create({ agent: "fred" });
    await instance.adapter.sendTurn({ threadId: "t-oc-ask", text: "run it", system: "You are Fred." });
    await recorder.until((e) => e.type === "turn.completed");
    const blocks = JSON.parse(readFileSync(promptDump, "utf8")) as Array<{ type: string; text?: string }>;
    const text = blocks.map((b) => b.text ?? "").join("");
    expect(text).not.toContain("/exec");
    // 1.0.4 QW (21e9b0f53): every engine's turn carries the ask rule line after the persona.
    expect(text.startsWith(`You are Fred.\n\n${TURN_ASK_RULES}\n\nrun it`)).toBe(true);
    delete process.env.FAKE_ACP_PROMPT_DUMP;
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
