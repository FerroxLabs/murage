// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fuigo 1.0.32 driver-facing changes (104-lastresort-evidence/FUIGO-1032-DRIVER-CHANGES.md), held on a
// driver that must also run 1.0.31:
//   - `--permission-mode acceptEdits` now approves workspace edits by itself. Murage never passes it,
//     at any level: Murage's own approval layer keeps deciding every edit.
//   - Any provider API key in the engine's env now triggers a daily model-list call to that provider,
//     with no switch. Only the credential the turn runs on reaches the engine, from the instance env
//     and from the owner's captured shell map alike, and the subscription refresh is switched off.
// Every value here is fake.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderDriver } from "../../contracts.ts";
import { recordEvents } from "../../testing/events.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import type { AcpConfig } from "./core.ts";
import { FUIGO_WITHHELD_PROVIDER_ENV, FuigoAgentDriver, scrubFuigoHandedEnv, withholdFuigoProviderEnv } from "./fuigo.ts";

// Names a provider switcher or a developer exports in the owner's shell; a Finder-launched Murage never had them.
const SHELL_ONLY = {
  GROQ_API_KEY: "fake-shell-groq-0001-not-real",
  OPENROUTER_API_KEY: "fake-shell-openrouter-0002-not-real",
  DEEPSEEK_API_KEY: "fake-shell-deepseek-0003-not-real",
  GROK_API_KEY: "fake-shell-grok-0004-not-real",
  LC_ANTHROPIC_AUTH_TOKEN: "fake-shell-lc-0005-not-real",
  FUIGO_CODE_API_KEY: "fake-shell-not-a-flux-key",
  FUIGO_DISABLE_MODEL_REFRESH: "0",
  FUIGO_SUBAGENTS: "1",
} as const;

vi.mock("../../env-path.ts", async (original) => {
  const real = await original<typeof import("../../env-path.ts")>();
  return {
    ...real,
    captureOwnerEnv: vi.fn(async () => {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) if (typeof value === "string") env[name] = value;
      return { env: { ...env, ...SHELL_ONLY, PATH: real.augmentedPath() }, capture: "session" as const };
    }),
  };
});

const cli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const FLUX = "sk-flux-fixture-only";
const homes: string[] = [];

beforeEach(() => {
  ensureDirs();
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|MODEL_REFRESH/i.test(key)) vi.stubEnv(key, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) removeTempDirSync(home);
});

type Spawned = { argv: string[]; env: Record<string, string> };

async function turn(options: { fullAuto?: boolean; environment?: Record<string, string>; enforced?: { routeAsks?: true; stopLine?: true; askLevel?: true } } = {}): Promise<Spawned> {
  const home = mkdtempSync(join(tmpdir(), "murage-fuigo-1032-"));
  homes.push(home);
  const dump = join(home, "spawn.json");
  const driver = FuigoAgentDriver as unknown as ProviderDriver<AcpConfig>;
  const instance = await driver.create({ instanceId: "fuigo-1032", displayName: "Fuigo", enabled: true,
    config: driver.decodeConfig({ cli, fullAuto: options.fullAuto === true }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model",
      FUIGO_API_KEY: FLUX, ...options.environment } });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "f1032", text: "hello", cwd: home, ...options.enforced });
    await recorder.until((event) => event.threadId === "f1032" && event.type === "turn.completed", 15000);
    return JSON.parse(readFileSync(dump, "utf8")) as Spawned;
  } finally { recorder.stop(); await instance.dispose(); }
}

const modeOf = (argv: string[]) => argv[argv.indexOf("--permission-mode") + 1];

describe("Fuigo 1.0.32: acceptEdits approves workspace edits, so Murage never passes it", () => {
  it.each([
    ["Ask level", { fullAuto: false, enforced: { routeAsks: true as const, askLevel: true as const } }, "default"],
    ["Auto with Murage's stop line", { fullAuto: true, enforced: { stopLine: true as const } }, "default"],
    ["Auto routing asks to Murage", { fullAuto: true, enforced: { routeAsks: true as const } }, "default"],
    ["an asking instance", { fullAuto: false }, "default"],
    ["Full access", { fullAuto: true }, "bypassPermissions"],
  ])("%s spawns --permission-mode %s and never acceptEdits", async (_label, options, expected) => {
    const { argv } = await turn(options);
    expect(argv.filter((arg) => arg === "--permission-mode")).toHaveLength(1);
    expect(modeOf(argv)).toBe(expected);
    expect(argv).not.toContain("acceptEdits");
  }, 30000);

  it("the Cloud launcher accepts only default and bypassPermissions for Fuigo", () => {
    const launcher = readFileSync(fileURLToPath(new URL("../../../deploy/cloud-home/murage-turn-launch.py", import.meta.url)), "utf8");
    expect(launcher).toMatch(/^PERMISSION_MODES = one_of\("default", "bypassPermissions"\)$/m);
    expect(launcher).toMatch(/"fuigoAgent": ArgvRule\(\{"--permission-mode": PERMISSION_MODES,/);
  });
});

describe("Fuigo subagents are off on every bot turn: a subagent definition cannot run wider than the bot", () => {
  it.each([
    ["Ask level", { fullAuto: false, enforced: { routeAsks: true as const, askLevel: true as const } }],
    ["Auto with Murage's stop line", { fullAuto: true, enforced: { stopLine: true as const } }],
    ["Full access", { fullAuto: true }],
  ])("%s: FUIGO_SUBAGENTS=0 over the instance's 1 and the shell's 1", async (_label, options) => {
    const { env } = await turn({ ...options, environment: { FUIGO_SUBAGENTS: "1" } });
    expect(env.FUIGO_SUBAGENTS).toBe("0");
  }, 30000);

  it("the handed shell map is pinned too", () => {
    const map: Record<string, string | undefined> = { fuigo_subagents: "1", LANG: "C" };
    scrubFuigoHandedEnv(map, {}, "win32");
    expect(map).toEqual({ LANG: "C", FUIGO_DISABLE_MODEL_REFRESH: "1", FUIGO_SUBAGENTS: "0" });
  });
});

describe("Fuigo 1.0.32: only the turn's own credential reaches the engine", () => {
  it("withholds every other provider key Fuigo discovers, any casing on Windows, and turns the refresh off", () => {
    const env: Record<string, string | undefined> = { Groq_Api_Key: "x", openrouter_api_key: "y", FUIGO_DISABLE_MODEL_REFRESH: "0", MURAGE_PROVIDER_API_KEY: "route", FUIGO_API_KEY: FLUX };
    for (const name of FUIGO_WITHHELD_PROVIDER_ENV) env[name] = "fake";
    withholdFuigoProviderEnv(env, "win32");
    expect(env).toEqual({ FUIGO_DISABLE_MODEL_REFRESH: "1", FUIGO_SUBAGENTS: "0", MURAGE_PROVIDER_API_KEY: "route", FUIGO_API_KEY: FLUX });
  });

  it("keeps a Fuigo key in the handed map only with the value the child env kept", () => {
    const map: Record<string, string | undefined> = { FUIGO_API_KEY: "shell-value", FUIGO_CODE_API_KEY: "shell-other", GROQ_API_KEY: "g", LANG: "C" };
    scrubFuigoHandedEnv(map, { FUIGO_API_KEY: FLUX }, "linux");
    expect(map).toEqual({ LANG: "C", FUIGO_DISABLE_MODEL_REFRESH: "1", FUIGO_SUBAGENTS: "0" });
    const same: Record<string, string | undefined> = { FUIGO_API_KEY: FLUX };
    scrubFuigoHandedEnv(same, { FUIGO_API_KEY: FLUX }, "linux");
    expect(same.FUIGO_API_KEY).toBe(FLUX);
  });

  it("a real turn: no instance or shell provider key, the Flux key intact, refresh off", async () => {
    const { env } = await turn({ environment: { GROQ_API_KEY: "fake-instance-groq-not-real", GEMINI_API_KEY: "fake-instance-gemini-not-real", MISTRAL_API_KEY: "fake-instance-mistral-not-real" } });
    for (const name of [...FUIGO_WITHHELD_PROVIDER_ENV, "FUIGO_CODE_API_KEY"]) expect([name, env[name]]).toEqual([name, undefined]);
    expect(env.FUIGO_API_KEY).toBeDefined();
    expect(env.FUIGO_DISABLE_MODEL_REFRESH).toBe("1");
  }, 30000);
});
