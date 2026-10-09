// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a bot remembers is Murage's to fence. Claude, Codex, Grok Build, Hermes and Qwen each keep a
// memory of their own on disk; every one is spawned with it off, so nothing crosses bots or people
// outside Murage's own rules. Fuigo already passes --no-memory (fuigo.test.ts). Native and Flux turns
// are both covered: the switch does not depend on where the model call goes.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { HermesAgentDriver } from "./acp/hermes.ts";
import { QwenAgentDriver } from "./acp/qwen.ts";

const TESTING = join(dirname(fileURLToPath(import.meta.url)), "..", "testing");
const FAKE_CLAUDE = join(TESTING, "fake-claude-cli.ts");
const FAKE_CODEX = join(TESTING, "fake-codex-app-server.ts");
const FAKE_ACP = join(TESTING, "fake-acp-cli.ts");
const FLUX_KEY = "sk-flux-Mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm"; // secret-scan: fixture

let scratch: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
let seq = 0;

beforeEach(() => {
  ensureDirs();
  for (const file of [FAKE_CLAUDE, FAKE_CODEX, FAKE_ACP]) chmodSync(file, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "murage-engine-memory-"));
});
afterEach(async () => {
  delete process.env.FLUX_API_KEY;
  delete process.env.FAKE_CLAUDE_DUMP;
  delete process.env.FAKE_CODEX_DUMP;
  delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  await removeTempDir(scratch);
});

async function oneTurn(turn: Partial<SendTurnInput> & { model: string }): Promise<void> {
  const completed = () => recorder!.events.filter((event) => event.type === "turn.completed").length;
  const before = completed();
  await instance!.adapter.sendTurn({ text: "hi", threadId: `t-mem-${++seq}`, ...turn });
  await vi.waitFor(() => expect(completed()).toBeGreaterThan(before), { timeout: 10_000, interval: 25 });
}

const fluxRoute = { connectionId: "g1", revision: "r1", preset: "flux", protocol: "openai", baseUrl: "https://api.fluxrouter.ai/v1", apiKey: FLUX_KEY, model: "claude-opus-5-5" } as SendTurnInput["providerRoute"];

describe("claude: auto memory is off at spawn", () => {
  const spawn = async (model: string) => {
    const dump = join(scratch, `claude-${++seq}.json`);
    process.env.FAKE_CLAUDE_DUMP = dump;
    instance = await ClaudeDriver.create({ instanceId: "claude-mem", displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLAUDE, permissionMode: "acceptEdits" } });
    recorder = recordEvents(instance.adapter);
    await oneTurn({ model });
    return JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string | undefined> };
  };
  it("native turn", async () => { expect((await spawn("claude-sonnet-4-5")).env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1"); });
  it("Flux turn", async () => { process.env.FLUX_API_KEY = FLUX_KEY; expect((await spawn("flux-auto")).env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1"); });
  it("a shell that turned it on does not win", async () => {
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "0";
    expect((await spawn("claude-sonnet-4-5")).env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });
});

describe("codex: features.memories is false in the app-server argv", () => {
  const spawn = async (model: string) => {
    const dump = join(scratch, `codex-${++seq}.json`);
    process.env.FAKE_CODEX_DUMP = dump;
    instance = await CodexDriver.create({ instanceId: "codex-mem", displayName: "Codex", environment: {}, enabled: true, config: { cli: FAKE_CODEX, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await oneTurn({ model });
    return (JSON.parse(readFileSync(dump, "utf8")) as { argv: string[] }).argv;
  };
  const has = (argv: string[]) => argv.some((arg, i) => arg === "features.memories=false" && argv[i - 1] === "-c");
  it("native turn", async () => { expect(has(await spawn("gpt-5.6-sol"))).toBe(true); });
  it("Flux turn", async () => { process.env.FLUX_API_KEY = FLUX_KEY; expect(has(await spawn("flux::flux-auto"))).toBe(true); });
});

describe("ACP engines", () => {
  const acp = async (create: (environment: Record<string, string>) => Promise<ProviderInstance>, turn: Partial<SendTurnInput> & { model: string }, extraEnv: Record<string, string> = {}) => {
    const dump = join(scratch, `acp-${++seq}.json`);
    instance = await create({ HOME: scratch, MURAGE_DATA_DIR: join(scratch, "state"), FAKE_ACP_DUMP: dump, ...extraEnv });
    recorder = recordEvents(instance.adapter);
    await oneTurn(turn);
    return JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string> };
  };

  it("grok build: --no-memory on the spawn argv", async () => {
    mkdirSync(join(scratch, "grok"), { recursive: true });
    const create = (environment: Record<string, string>) => GrokAgentDriver.create({ instanceId: "grok-mem", displayName: "Grok", environment: { ...environment, GROK_HOME: join(scratch, "grok") }, enabled: true, config: GrokAgentDriver.decodeConfig({ cli: FAKE_ACP, fullAuto: true }) });
    expect((await acp(create, { model: "claude-opus-5-5", providerRoute: fluxRoute })).argv).toContain("--no-memory");
  });

  describe("hermes: the scoped home has Hermes's memory and user profile off", () => {
    const create = (environment: Record<string, string>) => HermesAgentDriver.create({ instanceId: "hermes-mem", displayName: "Hermes", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    it("Flux turn", async () => {
      process.env.FLUX_API_KEY = FLUX_KEY;
      const seen = await acp(create, { model: "flux-auto" });
      const config = readFileSync(join(seen.env.HERMES_HOME!, "config.yaml"), "utf8");
      expect(config).toContain("\nmemory:\n  memory_enabled: false\n  user_profile_enabled: false\n");
      // still a valid top-level block after the headers were inserted before providers:
      expect(config.indexOf("memory:")).toBeGreaterThan(config.indexOf("providers:"));
    });
  });

  describe("qwen: system settings carry memory.enableManagedAutoMemory false", () => {
    const create = (environment: Record<string, string>) => QwenAgentDriver.create({ instanceId: "qwen-mem", displayName: "Qwen", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    const settings = (seen: { env: Record<string, string> }) => {
      const path = seen.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!;
      expect(existsSync(path)).toBe(true);
      return JSON.parse(readFileSync(path, "utf8")) as { memory?: { enableManagedAutoMemory?: boolean }; model?: unknown };
    };
    it("native turn: memory switch only", async () => {
      expect(settings(await acp(create, { model: "qwen3-coder-plus" }))).toEqual({ memory: { enableManagedAutoMemory: false } });
    });
    it("Flux turn: memory switch and the headers", async () => {
      process.env.FLUX_API_KEY = FLUX_KEY;
      const s = settings(await acp(create, { model: "flux-auto" }));
      expect(s.memory?.enableManagedAutoMemory).toBe(false);
      expect(s.model).toBeDefined();
    });
  });
});
