import { fixtureBotFolder } from "./testing/bot-folder-fixture.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U05 (1.0.4, GrokBuild H1): a turn reaches Flux when the engine's real host is
// Flux Router (env override, its own config, or its compiled default), not only
// on a flux-* pick. Fuigo's compiled default IS Flux. An unknown host counts as
// Flux (fail closed). Every ACP engine is checked.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "./config.ts";
import type { ProviderInstance, SendTurnInput } from "./contracts.ts";
import { acpFluxReach, createAcpDriver, type AcpSupport } from "./drivers/acp/core.ts";
import { clineSupport } from "./drivers/acp/cline.ts";
import { copilotSupport } from "./drivers/acp/copilot.ts";
import { cursorSupport } from "./drivers/acp/cursor.ts";
import { CustomAcpDriver, customAcpSupport } from "./drivers/acp/custom.ts";
import { droidSupport } from "./drivers/acp/droid.ts";
import { FuigoAgentDriver, fuigoAcpSupport } from "./drivers/acp/fuigo.ts";
import { GeminiAgentDriver, geminiAcpSupport } from "./drivers/acp/gemini.ts";
import { grokAcpSupport } from "./drivers/acp/grok.ts";
import { hermesAcpSupport } from "./drivers/acp/hermes.ts";
import { kimiAcpSupport } from "./drivers/acp/kimi.ts";
import { openclawSupport } from "./drivers/acp/openclaw.ts";
import { openCodeAcpSupport } from "./drivers/acp/opencode-go.ts";
import { qwenAcpSupport } from "./drivers/acp/qwen.ts";
import { configFilesReach, textNamesFlux } from "./flux-engine-reach.ts";
import { FLUX_HEADER_REFUSAL, fluxMemoryBreaker, fluxMemoryDecision, setFluxMemorySettings } from "./flux-memory-headers.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";

const handedHost = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("./engine-env.ts", async original => {
  const actual = await original<typeof import("./engine-env.ts")>();
  return { ...actual, handedEngineEnv: async (...args: Parameters<typeof actual.handedEngineEnv>) => {
    const handed = await actual.handedEngineEnv(...args);
    if (handedHost.value) handed.env.GOOGLE_GEMINI_BASE_URL = handedHost.value;
    return handed;
  } };
});

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
/** Shape only, never a live credential. */
const FLUX_KEY = "sk-flux-Rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"; // secret-scan: fixture
const FLUX = "https://api.fluxrouter.ai/v1";
const LOCAL = "http://127.0.0.1:8080/v1";
const NON_OWNER = { warmIdentity: { botId: "b", audience: "non-owner", decidedOwner: false } } as Partial<SendTurnInput>;
const OWNER = { warmIdentity: { botId: "b", audience: "owner", decidedOwner: true } } as Partial<SendTurnInput>;

let home: string;
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const reach = (support: AcpSupport, env: Record<string, string | undefined>, config: Record<string, unknown> = {}) => acpFluxReach(support, { HOME: home, HERMES_MANAGED_DIR: join(home, "managed"), ...env }, config as never);

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "murage-flux-reach-")); });
afterEach(async () => { handedHost.value = undefined; await removeTempDir(home); });

describe("U05 the host scan", () => {
  it("names Flux only for a Flux Router host, with or without a scheme", () => {
    expect(textNamesFlux(`base_url = "${FLUX}"`)).toBe(true);
    expect(textNamesFlux(`{"baseUrl":"eu.fluxrouter.ai/v1"}`)).toBe(true);
    expect(textNamesFlux(`base_url = "https://fluxrouter.ai.example.com/v1"`)).toBe(false);
    expect(textNamesFlux(`base_url = "${LOCAL}"`)).toBe(false);
  });
  it("a missing config is the compiled default; one that cannot be read is unknown", () => {
    expect(configFilesReach([join(home, "none.json")])).toBe("elsewhere");
    mkdirSync(join(home, "dir.json"));
    expect(configFilesReach([join(home, "dir.json")])).toBe("unknown");
  });
  it("an engine with no reach hook, or one that throws, is unknown", () => {
    expect(acpFluxReach({}, {}, {} as never)).toBe("unknown");
    expect(acpFluxReach({ fluxReach: () => { throw new Error("x"); } }, {}, {} as never)).toBe("unknown");
  });
});

describe("U05 every ACP engine's real host", () => {
  it("copilot: GitHub by default, its BYOK endpoint or provider registry when configured, and unknown when unreadable", () => {
    expect(reach(copilotSupport, {})).toBe("elsewhere");
    expect(reach(copilotSupport, { COPILOT_PROVIDER_BASE_URL: FLUX })).toBe("flux");
    expect(reach(copilotSupport, { COPILOT_PROVIDER_BASE_URL: LOCAL })).toBe("elsewhere");
    const providers = join(home, "copilot-providers.json");
    write(providers, JSON.stringify({ providers: [{ name: "router", baseUrl: FLUX }] }));
    expect(reach(copilotSupport, { COPILOT_PROVIDERS_CONFIG: providers })).toBe("flux");
    expect(reach(copilotSupport, { COPILOT_PROVIDERS_CONFIG: providers, COPILOT_PROVIDER_BASE_URL: LOCAL })).toBe("flux");
    mkdirSync(join(home, "unreadable-providers.json"));
    expect(reach(copilotSupport, { COPILOT_PROVIDERS_CONFIG: join(home, "unreadable-providers.json") })).toBe("unknown");
  });
  it("fuigo: its compiled default is Flux, whatever the model; another FUIGO_API_BASE_URL is not", () => {
    expect(reach(fuigoAcpSupport, {})).toBe("flux");
    expect(reach(fuigoAcpSupport, { FUIGO_API_BASE_URL: FLUX })).toBe("flux");
    expect(reach(fuigoAcpSupport, { FUIGO_API_BASE_URL: LOCAL })).toBe("elsewhere");
  });
  it("kimi: KIMI_MODEL_BASE_URL, else its config.toml, else its own backend", () => {
    expect(reach(kimiAcpSupport, {})).toBe("elsewhere");
    expect(reach(kimiAcpSupport, { KIMI_MODEL_BASE_URL: FLUX })).toBe("flux");
    write(join(home, ".kimi-code", "config.toml"), `[providers.flux]\nbase_url = "${FLUX}"\n`);
    expect(reach(kimiAcpSupport, {})).toBe("flux");
  });
  it("droid: custom models in ~/.factory/settings.json", () => {
    expect(reach(droidSupport, {})).toBe("elsewhere");
    write(join(home, ".factory", "settings.json"), JSON.stringify({ customModels: [{ baseUrl: FLUX }] }));
    expect(reach(droidSupport, {})).toBe("flux");
  });
  it("qwen: OPENAI_BASE_URL, else ~/.qwen settings", () => {
    expect(reach(qwenAcpSupport, {})).toBe("elsewhere");
    expect(reach(qwenAcpSupport, { OPENAI_BASE_URL: FLUX })).toBe("flux");
    write(join(home, ".qwen", "settings.json"), JSON.stringify({ modelProviders: { openai: [{ baseUrl: FLUX }] } }));
    expect(reach(qwenAcpSupport, {})).toBe("flux");
  });
  it("cline: the providers.json it selects from", () => {
    expect(reach(clineSupport, {})).toBe("elsewhere");
    write(join(home, ".cline", "data", "settings", "providers.json"), JSON.stringify({ providers: { openai: { baseUrl: FLUX } } }));
    expect(reach(clineSupport, {})).toBe("flux");
  });
  it("grok build: model hosts in the Grok home config", () => {
    expect(reach(grokAcpSupport, {})).toBe("elsewhere");
    write(join(home, ".grok", "config.toml"), `[model.flux]\nbase_url = "${FLUX}"\n`);
    expect(reach(grokAcpSupport, {})).toBe("flux");
  });
  it("hermes: HERMES_HOME (or ~/.hermes) config.yaml", () => {
    expect(reach(hermesAcpSupport, {})).toBe("elsewhere");
    write(join(home, ".hermes", "config.yaml"), `model:\n  base_url: ${FLUX}\n`);
    expect(reach(hermesAcpSupport, {})).toBe("flux");
  });
  it("opencode: the OpenCode config files", () => {
    expect(reach(openCodeAcpSupport((async () => []) as never), {})).toBe("elsewhere");
    write(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ provider: { flux: { options: { baseURL: FLUX } } } }));
    expect(reach(openCodeAcpSupport((async () => []) as never), {})).toBe("flux");
  });
  it("gemini and cursor: their own backends unless the env points at Flux", () => {
    expect(reach(geminiAcpSupport, {})).toBe("elsewhere");
    expect(reach(geminiAcpSupport, { GOOGLE_GEMINI_BASE_URL: FLUX })).toBe("flux");
    const cursor = cursorSupport((async () => ({ code: 0, stdout: "", stderr: "" })) as never);
    expect(reach(cursor, {})).toBe("elsewhere");
    expect(reach(cursor, { OPENAI_BASE_URL: FLUX })).toBe("flux");
  });
  it("openclaw: unknown without a config Murage can read, else its providers", () => {
    expect(reach(openclawSupport, {})).toBe("unknown");
    write(join(home, ".openclaw", "openclaw.json"), JSON.stringify({ models: { providers: { local: { baseUrl: LOCAL } } } }));
    expect(reach(openclawSupport, {})).toBe("elsewhere");
    write(join(home, ".openclaw", "openclaw.json"), JSON.stringify({ models: { providers: { flux: { baseUrl: FLUX } } } }));
    expect(reach(openclawSupport, {})).toBe("flux");
  });
  it("a remote OpenClaw gateway has an unknown model destination despite local provider files", () => {
    write(join(home, ".openclaw", "openclaw.json"), JSON.stringify({ gateway: { mode: "remote", remote: { url: "wss://gateway.example" } }, models: { providers: { local: { baseUrl: LOCAL } } } }));
    expect(reach(openclawSupport, {})).toBe("unknown");
  });
  it("custom ACP reads explicit model addresses without assuming an unknown host is safe", () => {
    expect(reach(customAcpSupport, { OPENAI_BASE_URL: LOCAL })).toBe("elsewhere");
    expect(reach(customAcpSupport, { ANTHROPIC_BASE_URL: FLUX })).toBe("flux");
  });
  it("custom ACP: unknown (any command, any host)", () => {
    expect(reach(customAcpSupport, {})).toBe("unknown");
  });
});

describe("U05 turns on the real drivers", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let seq = 0;
  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_ACP, 0o755);
    process.env.FLUX_API_KEY = FLUX_KEY;
    setFluxMemorySettings({ ownerMemory: "on", external: true, inject: "on", killSwitch: false });
    fluxMemoryBreaker.reset();
  });
  afterEach(async () => {
    delete process.env.FLUX_API_KEY;
    setFluxMemorySettings({});
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
  });
  const turnOn = async (create: (environment: Record<string, string>) => Promise<ProviderInstance>, turn: Partial<SendTurnInput>, model: string) => {
    const dump = join(home, `acp-${++seq}.json`);
    instance = await create({ HOME: home, MURAGE_DATA_DIR: join(home, "state"), FAKE_ACP_DUMP: dump });
    recorder = recordEvents(instance.adapter);
    const done = () => recorder!.events.filter((event) => event.type === "turn.completed").length;
    await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), text: "hi", ...turn, threadId: `t-reach-${seq}`, model });
    await vi.waitFor(() => expect(done()).toBeGreaterThan(0), { timeout: 10_000, interval: 25 });
    return JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> };
  };
  const fuigo = (environment: Record<string, string>) => FuigoAgentDriver.create({ instanceId: "fuigo-reach", displayName: "Fuigo", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
  const headers = (value: string | undefined) => (JSON.parse(value ?? "{}") as { models?: { extra_headers?: Record<string, string> } }).models?.extra_headers;

  it("a non-owner Fuigo turn on a model not named flux-* carries capture off and inject off", async () => {
    const seen = await turnOn(fuigo, NON_OWNER, "claude-haiku-4-5");
    expect(headers(seen.env.FUIGO_CONFIG)).toMatchObject({ "x-flux-memory-capture": "off", "x-flux-memory-inject": "off" });
  });
  it("the owner's Fuigo turn on that model says capture off (explicit-only) and keeps inject on", async () => {
    const seen = await turnOn(fuigo, OWNER, "claude-haiku-4-5");
    expect(headers(seen.env.FUIGO_CONFIG)?.["x-flux-memory-capture"]).toBe("off");
    expect(headers(seen.env.FUIGO_CONFIG)?.["x-flux-memory-inject"]).toBeUndefined();
  });
  it("a non-owner turn on a custom ACP engine (host unknown) is refused", async () => {
    instance = await CustomAcpDriver.create({ instanceId: "custom-reach", displayName: "Custom", environment: { HOME: home, MURAGE_DATA_DIR: join(home, "state") }, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
    await expect(instance.adapter.sendTurn({ cwd: fixtureBotFolder(), text: "hi", ...NON_OWNER, threadId: "t-reach-custom", model: "agent-default" })).rejects.toThrow(FLUX_HEADER_REFUSAL);
  });
  it("an owner turn on a custom ACP engine (host unknown, so Flux) is refused too: explicit-only capture, fail closed", async () => {
    instance = await CustomAcpDriver.create({ instanceId: "custom-reach-owner", displayName: "Custom", environment: { HOME: home, MURAGE_DATA_DIR: join(home, "state") }, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
    await expect(instance.adapter.sendTurn({ cwd: fixtureBotFolder(), text: "hi", ...OWNER, threadId: "t-reach-custom-owner", model: "agent-default" })).rejects.toThrow(FLUX_HEADER_REFUSAL);
  });
  it("the production custom support runs an ordinary command when Murage has no Flux integration", async () => {
    delete process.env.FLUX_API_KEY;
    const custom = (environment: Record<string, string>) => CustomAcpDriver.create({ instanceId: "custom-no-flux", displayName: "Custom", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    await turnOn(custom, OWNER, "agent-default");
    expect(recorder!.events.some(event => event.type === "turn.completed" && event.ok)).toBe(true);
  });
  it("the production custom support completes a turn on an explicitly configured non-Flux backend", async () => {
    const custom = (environment: Record<string, string>) => CustomAcpDriver.create({ instanceId: "custom-local", displayName: "Custom", environment: { ...environment, OPENAI_BASE_URL: LOCAL }, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    const seen = await turnOn(custom, OWNER, "agent-default");
    expect(seen.env.OPENAI_BASE_URL).toBe(LOCAL);
    expect(recorder!.events.some(event => event.type === "turn.completed" && event.ok)).toBe(true);
  });
  it("refuses a Flux host introduced only by the final terminal environment before spawning Gemini", async () => {
    handedHost.value = FLUX;
    instance = await GeminiAgentDriver.create({ instanceId: "gemini-final-host", displayName: "Gemini", environment: { HOME: home }, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
    await expect(instance.adapter.sendTurn({ cwd: fixtureBotFolder(), text: "hi", ...OWNER, threadId: "final-host", model: "gemini-2.5-pro" })).rejects.toThrow(FLUX_HEADER_REFUSAL);
    expect(recorder.events.some(event => event.type === "turn.started")).toBe(false);
  });
  it("an owner Gemini turn on its own backend still runs", async () => {
    const gemini = (environment: Record<string, string>) => GeminiAgentDriver.create({ instanceId: "gemini-reach-owner", displayName: "Gemini", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    await turnOn(gemini, OWNER, "gemini-2.5-pro");
    expect(recorder!.events.some((event) => event.type === "turn.completed" && (event as { ok?: boolean }).ok === false)).toBe(false);
  });

  // Grok HIGH / Astra HIGH (106 r1): the core computes the reach for EVERY turn. Each ACP engine kind, with its host on
  // Flux: one that carries the headers gets capture off on the owner's turn; one that cannot is refused for the owner too.
  const reachingSupport = (driverKind: string, carried: Array<Record<string, string>> | null): AcpSupport => ({
    ...customAcpSupport,
    driverKind: driverKind as never,
    fluxReach: () => "flux",
    ...(carried ? { applyFluxMemory: (_env: Record<string, string | undefined>, { decision }: { decision: { headers: Record<string, string> } }) => { carried.push({ ...decision.headers }); } } : { applyFluxMemory: undefined }),
  }) as AcpSupport;
  for (const kind of ["fuigoAgent", "grokAgent", "qwenAgent", "opencodeGo", "hermesAgent"]) {
    it(`${kind} with its host on Flux: the owner's turn carries capture off (and keeps inject on)`, async () => {
      const carried: Array<Record<string, string>> = [];
      const driver = createAcpDriver(reachingSupport(kind, carried));
      const seen = await turnOn((environment) => driver.create({ instanceId: `reach-${kind}`, displayName: kind, environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } }), OWNER, "agent-default");
      expect(seen).toBeDefined();
      expect(carried).toHaveLength(1);
      expect(carried[0]).toMatchObject({ "x-flux-memory-app": "murage", "x-flux-memory-capture": "off" });
      expect(carried[0]!["x-flux-memory-inject"]).toBeUndefined();
    });
  }
  for (const kind of ["kimiAgent", "droidAgent", "clineAgent", "cursorAgent", "geminiAgent", "customAcp", "openclawAgent"]) {
    it(`${kind} with its host on Flux: the owner's turn is refused (it cannot carry capture off)`, async () => {
      const driver = createAcpDriver(reachingSupport(kind, null));
      instance = await driver.create({ instanceId: `reach-${kind}`, displayName: kind, environment: { HOME: home, MURAGE_DATA_DIR: join(home, "state") }, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
      recorder = recordEvents(instance.adapter);
      await expect(instance.adapter.sendTurn({ cwd: fixtureBotFolder(), text: "hi", ...OWNER, threadId: `t-reach-refuse-${kind}`, model: "agent-default" })).rejects.toThrow(FLUX_HEADER_REFUSAL);
    });
  }

  it.each(["flux", "unknown"] as const)("the owner's memory-on turn checks the carrier version when reach is %s", async (reach) => {
    const carried: Array<Record<string, string>> = [];
    const gate = vi.fn(() => FLUX_HEADER_REFUSAL);
    const driver = createAcpDriver({
      ...reachingSupport("hermesAgent", carried),
      fluxReach: () => reach,
      fluxHeaderGate: gate,
    });
    instance = await driver.create({ instanceId: `gate-${reach}`, displayName: "Hermes", environment: { HOME: home, MURAGE_DATA_DIR: join(home, "state") }, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    await expect(instance.adapter.sendTurn({ cwd: fixtureBotFolder(), text: "hi", ...OWNER, threadId: `t-gate-${reach}`, model: "agent-default" })).rejects.toThrow(FLUX_HEADER_REFUSAL);
    expect(gate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ capture: "on", inject: "on", headers: expect.objectContaining({ "x-flux-memory-capture": "off" }) }), { providerRoute: false });
    expect(carried).toEqual([]);
  });

  it("a non-owner Gemini turn on its own backend still runs", async () => {
    const gemini = (environment: Record<string, string>) => GeminiAgentDriver.create({ instanceId: "gemini-reach", displayName: "Gemini", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: true } });
    await turnOn(gemini, NON_OWNER, "gemini-2.5-pro");
    expect(recorder!.events.some((event) => event.type === "turn.completed" && (event as { ok?: boolean }).ok === false)).toBe(false);
  });
});

describe("U05 each carrier puts capture off on the owner's Flux request", () => {
  const owner = () => fluxMemoryDecision({ audience: "owner" }, { settings: { ownerMemory: "on", external: true, inject: "on", killSwitch: false, spaces: false }, breaker: { isOpen: () => false } as never });
  it("the owner decision captures only by Murage's explicit POST: its headers say capture off", () => {
    const d = owner();
    expect(d.capture).toBe("on");
    expect(d.headers).toMatchObject({ "x-flux-memory-app": "murage", "x-flux-memory-capture": "off" });
  });
  it("fuigo and grok build: the config overlay's [models].extra_headers", () => {
    const d = owner();
    for (const support of [fuigoAcpSupport, grokAcpSupport]) {
      const env: Record<string, string | undefined> = { HOME: home };
      support.applyFluxMemory!(env, { decision: d });
      const overlay = JSON.parse((env.FUIGO_CONFIG ?? env.GROK_CONFIG)!) as { models?: { extra_headers?: Record<string, string> } };
      expect(overlay.models?.extra_headers?.["x-flux-memory-capture"]).toBe("off");
    }
  });
  it("opencode: the flux provider's headers", () => {
    const env: Record<string, string | undefined> = { HOME: home };
    openCodeAcpSupport((async () => []) as never).applyFluxMemory!(env, { decision: owner() });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({ provider: { flux: { options: { headers: { "x-flux-memory-capture": "off" } } } } });
  });
  it("qwen: the system settings, also when only Qwen's own settings name Flux (no OPENAI_BASE_URL)", () => {
    write(join(home, ".qwen", "settings.json"), JSON.stringify({ modelProviders: { openai: [{ baseUrl: FLUX }] } }));
    const env: Record<string, string | undefined> = { HOME: home };
    qwenAcpSupport.applyFluxMemory!(env, { decision: owner() });
    expect(readFileSync(env.QWEN_CODE_SYSTEM_SETTINGS_PATH!, "utf8")).toContain('"x-flux-memory-capture":"off"');
  });
});

useOutsideStoreFixture();
