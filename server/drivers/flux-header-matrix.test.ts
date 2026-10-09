// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The header matrix (PROPOSAL-v2 5.4 and 5.8 gate 4): for every engine that can
// route through Flux, an owner turn, a non-owner turn, an owner-looking turn
// nobody proved, and a background turn each carry the exact Flux Memory headers
// in what the engine is spawned with. The fakes are the ones the driver tests
// already use (fake Claude, fake Codex app-server, fake ACP agent) and a stub
// fetch for Murage's own HTTP engines.
//
// A live echo canary (F-ECHO) is still the rollout gate: this proves what Murage
// hands each engine, not what the engine does with it.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { fluxMemoryBreaker, setFluxMemorySettings } from "../flux-memory-headers.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { FuigoAgentDriver } from "./acp/fuigo.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { HermesAgentDriver } from "./acp/hermes.ts";
import { QwenAgentDriver } from "./acp/qwen.ts";
import { OpenCodeGoDriver } from "./acp/opencode-go.ts";

const TESTING = join(dirname(fileURLToPath(import.meta.url)), "..", "testing");
const FAKE_CLAUDE = join(TESTING, "fake-claude-cli.ts");
const FAKE_CODEX = join(TESTING, "fake-codex-app-server.ts");
const FAKE_ACP = join(TESTING, "fake-acp-cli.ts");

/** Shape only, never a live credential. */
const FLUX_KEY = "sk-flux-Mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm"; // secret-scan: fixture

const APP = { "x-flux-memory-app": "murage" };
const OFF = { ...APP, "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" };

/** The four audiences of the matrix, as the harness stamps them on a turn. */
const CASES: Array<{ name: string; turn: Partial<SendTurnInput>; headers: Record<string, string> }> = [
  { name: "owner", turn: { warmIdentity: { botId: "b", audience: "owner", decidedOwner: true } }, headers: APP },
  { name: "non-owner", turn: { warmIdentity: { botId: "b", audience: "non-owner", decidedOwner: false } }, headers: OFF },
  { name: "unproven room turn", turn: { warmIdentity: { botId: "b", audience: "owner", decidedOwner: false } }, headers: OFF },
  { name: "background", turn: { background: true, warmIdentity: { botId: "b", audience: "owner", decidedOwner: true } }, headers: OFF },
];

let scratch: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
let seq = 0;
const threadId = (label: string) => `t-hdr-${label}-${++seq}`;

beforeEach(() => {
  ensureDirs();
  for (const file of [FAKE_CLAUDE, FAKE_CODEX, FAKE_ACP]) chmodSync(file, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "murage-flux-hdr-"));
  process.env.FLUX_API_KEY = FLUX_KEY;
  setFluxMemorySettings({});
  fluxMemoryBreaker.reset();
});

afterEach(async () => {
  delete process.env.FLUX_API_KEY;
  delete process.env.FAKE_CLAUDE_DUMP;
  delete process.env.FAKE_CLAUDE_DUMP_EACH_TURN;
  delete process.env.FAKE_CODEX_DUMP;
  setFluxMemorySettings({});
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  await removeTempDir(scratch);
});

const parseLines = (value: string | undefined): Record<string, string> =>
  Object.fromEntries((value ?? "").split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]));

async function oneTurn(turn: Partial<SendTurnInput> & { threadId: string; model: string }): Promise<void> {
  const completed = () => recorder!.events.filter((event) => event.type === "turn.completed").length;
  const before = completed();
  await instance!.adapter.sendTurn({ text: "hi", ...turn });
  await vi.waitFor(() => expect(completed()).toBeGreaterThan(before), { timeout: 10_000, interval: 25 });
}

// ----------------------------------------------------------------- claude ----

describe("claude: ANTHROPIC_CUSTOM_HEADERS in the spawn env", () => {
  const spawnFor = async (turn: Partial<SendTurnInput>, model = "flux-auto") => {
    const dump = join(scratch, `claude-${++seq}.json`);
    process.env.FAKE_CLAUDE_DUMP = dump;
    instance = await ClaudeDriver.create({ instanceId: "claude-hdr", displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLAUDE, permissionMode: "acceptEdits" } });
    recorder = recordEvents(instance.adapter);
    await oneTurn({ ...turn, threadId: threadId("claude"), model });
    return JSON.parse(readFileSync(dump, "utf8")) as { pid: number; env: Record<string, string | undefined> };
  };

  it.each(CASES)("$name", async ({ turn, headers }) => {
    const seen = await spawnFor(turn);
    expect(parseLines(seen.env.ANTHROPIC_CUSTOM_HEADERS)).toEqual(headers);
  });

  it("a turn with no identity is off/off, and a native (non-Flux) turn carries none", async () => {
    expect(parseLines((await spawnFor({})).env.ANTHROPIC_CUSTOM_HEADERS)).toEqual(OFF);
    recorder?.stop();
    await instance?.dispose();
    delete process.env.FLUX_API_KEY;
    expect((await spawnFor({ warmIdentity: CASES[1]!.turn.warmIdentity }, "claude-sonnet-4-5")).env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  it("a user's own ANTHROPIC_CUSTOM_HEADERS never rides a Flux turn", async () => {
    process.env.ANTHROPIC_CUSTOM_HEADERS = "x-flux-memory-inject: on\nx-team: a";
    try {
      expect(parseLines((await spawnFor(CASES[0]!.turn)).env.ANTHROPIC_CUSTOM_HEADERS)).toEqual(APP);
    } finally { delete process.env.ANTHROPIC_CUSTOM_HEADERS; }
  });

  it("a change of audience on a live thread respawns the process with the new headers", async () => {
    const dump = join(scratch, "claude-respawn.json");
    process.env.FAKE_CLAUDE_DUMP = dump;
    process.env.FAKE_CLAUDE_DUMP_EACH_TURN = "1";
    instance = await ClaudeDriver.create({ instanceId: "claude-hdr", displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLAUDE, permissionMode: "acceptEdits" } });
    recorder = recordEvents(instance.adapter);
    const id = threadId("claude-respawn");
    await oneTurn({ threadId: id, model: "flux-auto", ...CASES[0]!.turn });
    const owner = JSON.parse(readFileSync(dump, "utf8")) as { pid: number; env: Record<string, string> };
    expect(parseLines(owner.env.ANTHROPIC_CUSTOM_HEADERS)).toEqual(APP);
    await oneTurn({ threadId: id, model: "flux-auto", ...CASES[1]!.turn });
    const other = JSON.parse(readFileSync(dump, "utf8")) as { pid: number; env: Record<string, string> };
    expect(parseLines(other.env.ANTHROPIC_CUSTOM_HEADERS)).toEqual(OFF);
    expect(other.pid).not.toBe(owner.pid);
  });

  it("the kill switch makes an owner turn off/off", async () => {
    setFluxMemorySettings({ killSwitch: true });
    expect(parseLines((await spawnFor(CASES[0]!.turn)).env.ANTHROPIC_CUSTOM_HEADERS)).toEqual(OFF);
  });

  it("a Flux connection (named provider route) carries the headers too", async () => {
    const route = { connectionId: "c1", revision: "r1", preset: "flux", protocol: "anthropic", baseUrl: "https://api.fluxrouter.ai/v1", apiKey: FLUX_KEY, model: "claude-opus-5-5" } as SendTurnInput["providerRoute"];
    expect(parseLines((await spawnFor({ ...CASES[1]!.turn, providerRoute: route })).env.ANTHROPIC_CUSTOM_HEADERS)).toEqual(OFF);
  });
});

// ------------------------------------------------------------------ codex ----

describe("codex: three provider tables, one chosen per thread", () => {
  const spawnFor = async (turn: Partial<SendTurnInput>, model = "flux::flux-auto") => {
    const dump = join(scratch, `codex-${++seq}.json`);
    process.env.FAKE_CODEX_DUMP = dump;
    instance = await CodexDriver.create({ instanceId: "codex-hdr", displayName: "Codex", environment: {}, enabled: true, config: { cli: FAKE_CODEX, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await oneTurn({ ...turn, threadId: threadId("codex"), model });
    return JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; calls: Array<{ method: string; params: Record<string, unknown> | null }> };
  };
  const providerOf = (seen: { calls: Array<{ method: string; params: Record<string, unknown> | null }> }) => seen.calls.find((call) => call.method === "thread/start")?.params?.modelProvider;

  it.each(CASES)("$name", async ({ turn, headers }) => {
    const seen = await spawnFor(turn);
    expect(providerOf(seen)).toBe(headers === APP ? "flux" : "flux-off");
    const argv = seen.argv.join("\n");
    // the tables never change with the audience: one app-server serves every thread
    expect(argv).toContain('model_providers.flux.http_headers={ "x-flux-memory-app" = "murage" }');
    expect(argv).toContain('model_providers.flux-off.http_headers={ "x-flux-memory-app" = "murage", "x-flux-memory-capture" = "off", "x-flux-memory-inject" = "off" }');
    expect(argv).toContain('model_providers.flux-noinject.http_headers={ "x-flux-memory-app" = "murage", "x-flux-memory-inject" = "off" }');
  });

  it("the inject kill switch starts the owner's thread on the no-recall table", async () => {
    setFluxMemorySettings({ inject: "off" });
    expect(providerOf(await spawnFor(CASES[0]!.turn))).toBe("flux-noinject");
  });

  it("a native turn names no Flux table", async () => {
    const seen = await spawnFor(CASES[1]!.turn, "gpt-5.6-sol");
    expect(providerOf(seen)).toBe("openai");
  });
});

// ------------------------------------------------------------- ACP engines ----

describe("ACP engines: the headers land in the spawn env after the route settles", () => {
  const acpDump = async (create: (environment: Record<string, string>) => Promise<ProviderInstance>, turn: Partial<SendTurnInput>, model: string, extraEnv: Record<string, string> = {}) => {
    const dump = join(scratch, `acp-${++seq}.json`);
    instance = await create({ HOME: scratch, MURAGE_DATA_DIR: join(scratch, "state"), FAKE_ACP_DUMP: dump, ...extraEnv });
    recorder = recordEvents(instance.adapter);
    await oneTurn({ ...turn, threadId: threadId("acp"), model });
    return JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string> };
  };
  const overlayHeaders = (value: string | undefined) => (JSON.parse(value ?? "{}") as { models?: { extra_headers?: Record<string, string> } }).models?.extra_headers;

  describe("fuigo: FUIGO_CONFIG models.extra_headers", () => {
    const create = (environment: Record<string, string>) => FuigoAgentDriver.create({ instanceId: "fuigo-hdr", displayName: "Fuigo", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    it.each(CASES)("$name", async ({ turn, headers }) => {
      expect(overlayHeaders((await acpDump(create, turn, "flux-auto")).env.FUIGO_CONFIG)).toEqual(headers);
    });
    it("keeps the user's own overlay keys and replaces their memory headers", async () => {
      const seen = await acpDump(create, CASES[1]!.turn, "flux-auto", { FUIGO_CONFIG: JSON.stringify({ models: { extra_headers: { "x-team": "a", "x-flux-memory-inject": "on" } } }) });
      expect(overlayHeaders(seen.env.FUIGO_CONFIG)).toEqual({ "x-team": "a", ...OFF });
    });
  });

  describe("grok build: GROK_CONFIG models.extra_headers", () => {
    const route = { connectionId: "g1", revision: "r1", preset: "flux", protocol: "openai", baseUrl: "https://api.fluxrouter.ai/v1", apiKey: FLUX_KEY, model: "claude-opus-5-5" } as SendTurnInput["providerRoute"];
    const create = (environment: Record<string, string>) => GrokAgentDriver.create({ instanceId: "grok-hdr", displayName: "Grok", environment: { ...environment, GROK_HOME: join(scratch, "grok") }, enabled: true, config: GrokAgentDriver.decodeConfig({ cli: FAKE_ACP, fullAuto: true }) });
    it.each(CASES)("$name", async ({ turn, headers }) => {
      mkdirSync(join(scratch, "grok"), { recursive: true });
      expect(overlayHeaders((await acpDump(create, { ...turn, providerRoute: route }, "claude-opus-5-5")).env.GROK_CONFIG)).toEqual(headers);
    });
  });

  describe("hermes: config.yaml model.extra_headers in the scoped home", () => {
    const create = (environment: Record<string, string>) => HermesAgentDriver.create({ instanceId: "hermes-hdr", displayName: "Hermes", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    it.each(CASES)("$name", async ({ turn, headers }) => {
      const seen = await acpDump(create, turn, "flux-auto");
      const config = readFileSync(join(seen.env.HERMES_HOME!, "config.yaml"), "utf8");
      const block = config.split("\n").filter((line) => line.startsWith('    "x-flux-memory-')).map((line) => /"(.+?)": "(.+?)"/.exec(line)!.slice(1, 3));
      expect(Object.fromEntries(block)).toEqual(headers);
      // the block sits inside model:, before providers:, and the key line is untouched
      expect(config.indexOf("  extra_headers:")).toBeGreaterThan(config.indexOf("  api_key:"));
      expect(config.indexOf("  extra_headers:")).toBeLessThan(config.indexOf("providers:"));
    });
  });

  describe("qwen: a system-settings file with model.generationConfig.customHeaders", () => {
    const create = (environment: Record<string, string>) => QwenAgentDriver.create({ instanceId: "qwen-hdr", displayName: "Qwen", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    it.each(CASES)("$name", async ({ turn, headers }) => {
      const seen = await acpDump(create, turn, "flux-auto");
      const path = seen.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!;
      expect(path.startsWith(join(DATA_DIR, "native", "flux-memory"))).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).model.generationConfig.customHeaders).toEqual(headers);
    });
  });

  describe("opencode: OPENCODE_CONFIG_CONTENT provider.flux.options.headers", () => {
    const create = (environment: Record<string, string>) => OpenCodeGoDriver.create({ instanceId: "opencode-hdr", displayName: "OpenCode", environment: { ...environment, OPENCODE_API_KEY: "fixture-only-not-real" }, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    it.each(CASES)("$name", async ({ turn, headers }) => {
      const seen = await acpDump(create, turn, "flux-auto");
      expect(JSON.parse(seen.env.OPENCODE_CONFIG_CONTENT!).provider.flux.options.headers).toEqual(headers);
    });
  });

  it("an engine with no Flux surface is left alone on a model id that merely starts with flux-", async () => {
    const create = (environment: Record<string, string>) => GeminiAgentDriver.create({ instanceId: "gemini-hdr", displayName: "Gemini", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    const seen = await acpDump(create, CASES[1]!.turn, "flux-looking-local-model");
    expect(seen.env.FUIGO_CONFIG).toBeUndefined();
    expect(recorder!.events.some((event) => event.type === "turn.completed" && (event as { ok?: boolean }).ok === false)).toBe(false);
  });

  it("an ACP engine that is not Flux-routed gets nothing", async () => {
    const create = (environment: Record<string, string>) => QwenAgentDriver.create({ instanceId: "qwen-native", displayName: "Qwen", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    const seen = await acpDump(create, CASES[1]!.turn, "qwen3-coder-plus");
    expect(seen.env.QWEN_CODE_SYSTEM_SETTINGS_PATH).toBeUndefined();
  });
});

// ------------------------------------------- Murage's own HTTP engines ----

describe("openai-compat and the other HTTP engines: the request headers", () => {
  const DONE = "data: [DONE]\n\n";
  const reply = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n${DONE}`, { status: 200, headers: { "content-type": "text/event-stream" } });
  const seenHeaders: Array<{ url: string; headers: Headers }> = [];
  let previousFetch: typeof globalThis.fetch;

  beforeEach(() => {
    seenHeaders.length = 0;
    previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenHeaders.push({ url: String(input), headers: new Headers(init?.headers) });
      return reply();
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = previousFetch; });

  const run = async (apiUrl: string, turn: Partial<SendTurnInput>) => {
    instance = createOpenAIChatRuntime({
      input: { instanceId: "compat-hdr", displayName: "Compat", environment: {}, enabled: true, config: {} },
      driverKind: "openai-compat", apiKey: "k", apiUrl,
      models: () => ({ default: "m", options: [{ id: "m", label: "M" }] }),
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "Compat", missingKeyError: "missing key", unavailableReason: "no key", timeoutMs: 10_000,
      nativeLog: { source: "t", outgoing: (_t, messages, model) => ({ model, messages }), incoming: ({ text, usage }) => ({ text, usage }) },
    });
    recorder = recordEvents(instance.adapter);
    await oneTurn({ ...turn, threadId: threadId("compat"), model: "m" });
    return seenHeaders.find((call) => call.url.endsWith("/chat/completions"))!.headers;
  };
  const memoryOf = (headers: Headers) => Object.fromEntries([...headers.entries()].filter(([name]) => name.startsWith("x-flux-memory")));

  it.each(CASES)("$name", async ({ turn, headers }) => {
    expect(memoryOf(await run("https://api.fluxrouter.ai/v1", turn))).toEqual(headers);
  });

  it("sends none to a host that is not Flux", async () => {
    expect(memoryOf(await run("https://openrouter.ai/api/v1", CASES[1]!.turn))).toEqual({});
  });
});
