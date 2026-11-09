import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FUIGO-NO-SILENT-HANG pins (1.0.15): every Fuigo bot turn retries a failed request 3 times, gives a connection 15 s,
// and, when the turn presents Murage's Flux key, never parks on an uncharged 401. The same values on the child env,
// the handed owner map and the spawned engine; a `fuigo login` turn and a provider route keep Fuigo's own park.
// The Cloud launcher (deploy/cloud-home/murage-turn-launch.py) pins the same values; its test reads these constants.
// Every value here is fake.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderDriver, SendTurnInput } from "../../contracts.ts";
import { recordEvents } from "../../testing/events.ts";
import { fixtureCredentialFingerprint } from "../../testing/fixture-dump.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { applyProviderRoute } from "../../provider-routing.ts";
import type { AcpConfig } from "./core.ts";
import {
  applyFuigoParkPin, FUIGO_PARK_ENV, FUIGO_RETRY_PINS, FUIGO_TURN_PINS, FuigoAgentDriver, fuigoParkPin, presentedFuigoKey,
  scrubFuigoCredentialEnv, scrubFuigoHandedEnv, withholdFuigoProviderEnv,
} from "./fuigo.ts";

// An owner's shell that stretches every request: 10 retries, a 2 minute connect limit, the park forced on.
const SHELL = { FUIGO_MAX_RETRIES: "10", FUIGO_CONNECT_TIMEOUT_SECS: "120", FUIGO_UNCHARGED_401_PARK: "1" } as const;
// names the owner's captured shell holds on top of this process's env, per test
const ownerExtra = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock("../../env-path.ts", async (original) => {
  const real = await original<typeof import("../../env-path.ts")>();
  return {
    ...real,
    captureOwnerEnv: vi.fn(async () => {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env)) if (typeof value === "string") env[name] = value;
      return { env: { ...env, ...SHELL, ...ownerExtra.value, PATH: real.augmentedPath() }, capture: "session" as const };
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
  ownerExtra.value = {};
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) removeTempDirSync(home);
});

type Spawned = { argv: string[]; env: Record<string, string> };

async function turn(options: { environment?: Record<string, string>; login?: true; route?: true } = {}): Promise<Spawned> {
  const home = mkdtempSync(join(tmpdir(), "murage-fuigo-pins-"));
  homes.push(home);
  if (options.login) { mkdirSync(join(home, ".fuigo"), { recursive: true }); writeFileSync(join(home, ".fuigo", "auth.json"), "{}"); }
  const dump = join(home, "spawn.json");
  const driver = FuigoAgentDriver as unknown as ProviderDriver<AcpConfig>;
  const instance = await driver.create({ instanceId: "fuigo-pins", displayName: "Fuigo", enabled: true,
    config: driver.decodeConfig({ cli }),
    environment: { HOME: home, USERPROFILE: home, FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, FAKE_ACP_MCP_READY: "1", FAKE_ACP_MODELS: "fixture-model",
      FUIGO_API_KEY: FLUX, ...SHELL, ...options.environment } });
  const recorder = recordEvents(instance.adapter);
  try {
    const input: SendTurnInput = { threadId: "fpins", text: "hello", cwd: home,
      ...(options.route ? { providerRoute: { connectionId: "fixture", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:49999/v1", apiKey: "synthetic-unused-key", model: "fixture", revision: "1" } as const } : {}) };
    await instance.adapter.sendTurn(input);
    await recorder.until((event) => event.threadId === "fpins" && event.type === "turn.completed", 15000);
    return JSON.parse(readFileSync(dump, "utf8")) as Spawned;
  } finally { recorder.stop(); await instance.dispose(); }
}

describe("the pin values", () => {
  it("retries 3 and connect 15 s are turn pins; the Cloud launcher reads these constants", () => {
    expect(FUIGO_RETRY_PINS).toEqual({ FUIGO_MAX_RETRIES: "3", FUIGO_CONNECT_TIMEOUT_SECS: "15" });
    expect(FUIGO_TURN_PINS).toMatchObject(FUIGO_RETRY_PINS);
    expect(FUIGO_PARK_ENV).toBe("FUIGO_UNCHARGED_401_PARK");
  });

  it("the park pin is 0 only for a presented Flux key", () => {
    expect(fuigoParkPin(FLUX)).toEqual({ FUIGO_UNCHARGED_401_PARK: "0" });
    expect(fuigoParkPin(null)).toEqual({});
    expect(presentedFuigoKey({ FUIGO_API_KEY: FLUX })).toBe(FLUX);
    expect(presentedFuigoKey({ FUIGO_API_KEY: "not-a-flux-key" })).toBeNull();
    expect(presentedFuigoKey({ MURAGE_PROVIDER_API_KEY: "synthetic-route-key" })).toBeNull();
  });
});

describe("every env copy carries the same pins", () => {
  it("child env: retry pins replace every casing on Windows", () => {
    const env: Record<string, string | undefined> = { fuigo_max_retries: "10", Fuigo_Connect_Timeout_Secs: "120", LANG: "C" };
    withholdFuigoProviderEnv(env, "win32");
    expect(Object.entries(env).filter(([name]) => /^FUIGO_(MAX_RETRIES|CONNECT_TIMEOUT_SECS)$/i.test(name)))
      .toEqual([["FUIGO_MAX_RETRIES", "3"], ["FUIGO_CONNECT_TIMEOUT_SECS", "15"]]);
  });

  it("child env: the park follows the key, every inherited casing gone", () => {
    const keyed: Record<string, string | undefined> = { Fuigo_Uncharged_401_Park: "1", FUIGO_UNCHARGED_401_PARK: "1" };
    scrubFuigoCredentialEnv(keyed, FLUX, "win32");
    applyFuigoParkPin(keyed, presentedFuigoKey(keyed, "win32"), "win32");
    expect(Object.entries(keyed).filter(([name]) => name.toUpperCase() === FUIGO_PARK_ENV)).toEqual([[FUIGO_PARK_ENV, "0"]]);
    const unkeyed: Record<string, string | undefined> = { FUIGO_UNCHARGED_401_PARK: "0", fuigo_uncharged_401_park: "1" };
    applyFuigoParkPin(unkeyed, presentedFuigoKey(unkeyed, "win32"), "win32");
    expect(unkeyed).toEqual({});
  });

  it("handed map: pinned from the child after the key mirror, so map and child always agree", () => {
    for (const platform of ["linux", "win32"] as const) {
      for (const child of [{ FUIGO_API_KEY: FLUX }, {}, { FUIGO_API_KEY: "not-a-flux-key" }, { MURAGE_PROVIDER_API_KEY: "synthetic-route-key" }]) {
        const childEnv: Record<string, string | undefined> = { ...child, ...SHELL };
        withholdFuigoProviderEnv(childEnv, platform);
        applyFuigoParkPin(childEnv, presentedFuigoKey(childEnv, platform), platform);
        const map: Record<string, string | undefined> = { ...SHELL, fuigo_uncharged_401_park: "1", FUIGO_API_KEY: "shell-value", LANG: "C" };
        scrubFuigoHandedEnv(map, childEnv, platform);
        // the name Fuigo reads: any casing on Windows, the exact name elsewhere
        const park = (env: Record<string, string | undefined>) => Object.entries(env).filter(([name]) => (platform === "win32" ? name.toUpperCase() : name) === FUIGO_PARK_ENV);
        expect([platform, child, park(map)]).toEqual([platform, child, park(childEnv)]);
        // and the same credential: park 0 never rides without the Flux key it was set for
        expect([platform, child, presentedFuigoKey(map, platform)]).toEqual([platform, child, presentedFuigoKey(childEnv, platform)]);
        expect([map.FUIGO_MAX_RETRIES, map.FUIGO_CONNECT_TIMEOUT_SECS]).toEqual(["3", "15"]);
      }
    }
  });
});

describe("a provider route on Windows", () => {
  it("drops every casing of the Fuigo key names, so the route turn gets no park pin", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-fuigo-pins-route-"));
    homes.push(home);
    const env: NodeJS.ProcessEnv = { Fuigo_Api_Key: FLUX, fuigo_code_api_key: FLUX, Flux_Api_Key: FLUX, LANG: "C" };
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...real, value: "win32" });
    try {
      applyProviderRoute("fuigoAgent", env, { connectionId: "fixture", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:49999/v1", apiKey: "synthetic-unused-key", model: "fixture", revision: "1" }, { threadId: "fpins-route", homeRoot: home });
    } finally { Object.defineProperty(process, "platform", real); }
    expect(Object.keys(env).filter((name) => /^(FUIGO_API_KEY|FUIGO_CODE_API_KEY|FLUX_API_KEY)$/i.test(name))).toEqual([]);
    expect(presentedFuigoKey(env, "win32")).toBeNull();
    applyFuigoParkPin(env, presentedFuigoKey(env, "win32"), "win32");
    expect(Object.keys(env).filter((name) => name.toUpperCase() === FUIGO_PARK_ENV)).toEqual([]);
  });
});

describe("the spawned engine", () => {
  it("this process holds the Flux key and the owner's shell a different one: the engine gets the key and park 0", async () => {
    vi.stubEnv("FUIGO_API_KEY", FLUX);
    ownerExtra.value = { FUIGO_API_KEY: "sk-flux-owner-shell-other-value" };
    const { env: differing } = await turn();
    expect([differing.FUIGO_API_KEY, differing.FUIGO_UNCHARGED_401_PARK]).toEqual([fixtureCredentialFingerprint(FLUX), "0"]);
    ownerExtra.value = { FUIGO_API_KEY: "" };
    const { env: emptyShell } = await turn();
    expect([emptyShell.FUIGO_API_KEY, emptyShell.FUIGO_UNCHARGED_401_PARK]).toEqual([fixtureCredentialFingerprint(FLUX), "0"]);
  }, 60000);

  it("a Flux key turn: 3 retries, 15 s connect, park 0, over the instance's and the shell's values", async () => {
    const { env } = await turn();
    expect([env.FUIGO_MAX_RETRIES, env.FUIGO_CONNECT_TIMEOUT_SECS, env.FUIGO_UNCHARGED_401_PARK]).toEqual(["3", "15", "0"]);
  }, 30000);

  it("a fuigo login (auth.json) turn: the same retry pins and no park pin, the shell's value dropped too", async () => {
    const { env } = await turn({ login: true, environment: { FUIGO_API_KEY: "" } });
    expect(env.FUIGO_API_KEY).toBeUndefined();
    expect([env.FUIGO_MAX_RETRIES, env.FUIGO_CONNECT_TIMEOUT_SECS]).toEqual(["3", "15"]);
    expect(env.FUIGO_UNCHARGED_401_PARK).toBeUndefined();
  }, 30000);

  it("a provider route replaces the Flux key: no park pin reaches the engine", async () => {
    const { env } = await turn({ route: true });
    expect(env.FUIGO_API_KEY).toBeUndefined();
    expect([env.FUIGO_MAX_RETRIES, env.FUIGO_CONNECT_TIMEOUT_SECS]).toEqual(["3", "15"]);
    expect(env.FUIGO_UNCHARGED_401_PARK).toBeUndefined();
  }, 30000);
});

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();
