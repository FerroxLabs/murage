// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Item 175 (design MCP-118-175 section 2 and 5): Cline over ACP. The scripted
// fake ACP CLI stands in for `cline --acp`; no real cline binary or ~/.cline is
// ever touched (CLINE_PROVIDER_SETTINGS_PATH points at a scratch file). Every
// key below is fake.
import { chmodSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { execEnvHanded } from "../../engine-env.ts";
import { rememberedHandsForTest } from "../../startup-files.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { fixtureCredentialFingerprint } from "../../testing/fixture-dump.ts";
import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";
import { CLINE_AUTO_APPROVE_REFUSAL, CLINE_LOGIN_NOTE, CLINE_MAX_SETTINGS_BYTES, ClineAgentDriver, clineForcedArgs, clineSettingsPath, clineSupport, savedProvider, savedProviderKey } from "./cline.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const KEY_A = "fake-cline-anthropic-key-AAAA1111";
const KEY_B = "fake-cline-openrouter-key-BBBB2222";
const TOKEN = "fake-cline-account-token-CCCC3333"; // secret-scan: fixture

const config = (cli = "cline"): AcpConfig => ({ cli } as AcpConfig);
const keyFile = (selected = "anthropic", keyA = KEY_A) => ({
  version: 1,
  lastUsedProvider: selected,
  providers: {
    anthropic: { settings: { provider: "anthropic", model: "claude-fixture-4", apiKey: keyA } },
    openrouter: { settings: { provider: "openrouter", model: "or-fixture", apiKey: KEY_B } },
    cline: { settings: { provider: "cline", auth: { accessToken: TOKEN } } },
  },
});

let scratch: string;
let settings: string;
const env = () => ({ CLINE_PROVIDER_SETTINGS_PATH: settings });
const write = (doc: unknown) => writeFileSync(settings, typeof doc === "string" ? doc : JSON.stringify(doc));

beforeEach(() => {
  ensureDirs();
  chmodSync(FAKE_CLI, 0o755);
  scratch = mkdtempSync(join(tmpdir(), "murage-cline-acp-test-"));
  settings = join(scratch, "providers.json");
});
afterEach(async () => {
  await removeTempDir(scratch);
});

describe("Cline's command and settings file", () => {
  it("refuses every --auto-approve occurrence other than exactly false, a trailing bare flag included", () => {
    for (const cli of ["cline --auto-approve", "cline --auto-approve false --auto-approve", "cline --auto-approve=true --auto-approve false", "cline --auto-approve false --auto-approve=yes", "cline --auto-approve --verbose"]) {
      expect(() => clineForcedArgs(config(cli)), cli).toThrow(CLINE_AUTO_APPROVE_REFUSAL);
    }
    expect(clineForcedArgs(config("cline --auto-approve=false"))).toEqual(["--acp"]);
  });

  it("is a built-in driver that always runs `--acp --auto-approve false`", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "clineAgent")).toBe(true);
    expect(clineForcedArgs(config())).toEqual(["--acp", "--auto-approve", "false"]);
    expect(clineForcedArgs(config("cline --acp --verbose"))).toEqual(["--auto-approve", "false"]);
    expect(clineForcedArgs(config("cline --auto-approve false"))).toEqual(["--acp"]);
    expect(() => clineForcedArgs(config("cline --auto-approve true"))).toThrow(CLINE_AUTO_APPROVE_REFUSAL);
    expect(() => ClineAgentDriver.decodeConfig({ cli: "cline --auto-approve=true" })).toThrow(CLINE_AUTO_APPROVE_REFUSAL);
  });

  it("finds providers.json by Cline's own rules", () => {
    expect(clineSettingsPath({ HOME: "/h" }, config())).toBe(join("/h", ".cline", "data", "settings", "providers.json"));
    expect(clineSettingsPath({ HOME: "/h", CLINE_DIR: "/c" }, config())).toBe(join("/c", "data", "settings", "providers.json"));
    expect(clineSettingsPath({ HOME: "/h" }, config("cline --config /x --data-dir /y"))).toBe(join("/y", "settings", "providers.json"));
    expect(clineSettingsPath({ CLINE_PROVIDER_SETTINGS_PATH: "/p.json" }, config())).toBe("/p.json");
  });

  it("learns provider, model and sign-in kind from the selected block only, never a key", () => {
    write(keyFile());
    const saved = savedProvider(env(), config());
    expect(saved).toEqual({ provider: "anthropic", model: "claude-fixture-4", auth: "key" });
    expect(JSON.stringify(saved)).not.toContain(KEY_A);
    expect(savedProviderKey(env(), config())).toBe(KEY_A);
    // the spawn-only hook hands the selected key and nothing else
    expect(clineSupport.secretEnv!(env(), config())).toEqual({ CLINE_API_KEY: KEY_A });
    // a key already in the environment is used as it is
    expect(clineSupport.secretEnv!({ ...env(), CLINE_API_KEY: "fake-env-key" }, config())).toEqual({});
    write(keyFile("cline"));
    expect(savedProvider(env(), config())).toEqual({ provider: "cline", auth: "oauth" });
    expect(savedProviderKey(env(), config())).toBeUndefined();
    expect(clineSupport.secretEnv!(env(), config())).toEqual({});
    expect(clineSupport.pickAuthMethod([{ id: "cline" }, { id: "openai-codex" }], env(), config())).toBe("cline");
    write(keyFile("openrouter"));
    expect(clineSupport.secretEnv!(env(), config())).toEqual({ CLINE_API_KEY: KEY_B });
    expect(clineSupport.pickAuthMethod([{ id: "openrouter" }], env(), config())).toBeNull();
  });

  it("reads a malformed, oversized, version 2 or unselected file as unconfigured", async () => {
    for (const doc of [
      "{not json",
      { ...keyFile(), version: 2 },
      { ...keyFile(), lastUsedProvider: "missing" },
      { version: 1, lastUsedProvider: "anthropic", providers: { anthropic: { settings: { provider: "anthropic", apiKey: 7 } } } },
      JSON.stringify({ ...keyFile(), pad: "x".repeat(CLINE_MAX_SETTINGS_BYTES) }),
    ]) {
      write(doc);
      expect(savedProvider(env(), config())).toBeNull();
      expect(savedProviderKey(env(), config())).toBeUndefined();
      expect(await clineSupport.isAuthenticated(env(), config())).toBe(false);
      expect(clineSupport.spawnFingerprint!(env(), config())).toBe("unconfigured");
    }
    expect(savedProvider({ CLINE_PROVIDER_SETTINGS_PATH: join(scratch, "absent.json") }, config())).toBeNull();
  });

  it("fingerprints the selection and the file's mtime, never the key bytes", () => {
    write(keyFile());
    const at = new Date("2026-01-01T00:00:00Z");
    utimesSync(settings, at, at);
    const first = clineSupport.spawnFingerprint!(env(), config());
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // the same length key, the same mtime: the same fingerprint, so no key byte is in it
    write(keyFile("anthropic", KEY_A.replace("AAAA", "ZZZZ")));
    utimesSync(settings, at, at);
    expect(clineSupport.spawnFingerprint!(env(), config())).toBe(first);
    const later = new Date("2026-01-02T00:00:00Z");
    utimesSync(settings, later, later);
    expect(clineSupport.spawnFingerprint!(env(), config())).not.toBe(first);
    expect(first).not.toContain(fixtureCredentialFingerprint(KEY_A));
  });
});

describe("Cline turns (fake CLI)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  const create = async () => {
    instance = await ClineAgentDriver.create({
      instanceId: "cline-test",
      displayName: "Cline Test",
      environment: env(),
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };
  afterEach(async () => {
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_AUTH_METHODS;
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
  });
  const dumped = (dump: string) => JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string | undefined> };

  it("a key provider: the child gets the selected key, the hand, digests and events never do, and the saved model is pinned", async () => {
    write(keyFile());
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create();
    await instance!.adapter.sendTurn({ threadId: "t-cline-key", text: "hi" });
    const done = await recorder!.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    const state = dumped(dump);
    expect(state.argv).toEqual(expect.arrayContaining(["--acp", "--auto-approve", "false"]));
    expect(state.env.CLINE_API_KEY).toBe(fixtureCredentialFingerprint(KEY_A));
    // no authenticate call for a key provider: null with a signed-in engine is a skip
    expect(existsSync(`${dump}.auth.json`)).toBe(false);
    const configCalls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{ method: string; params: { modelId?: string } }>;
    expect(configCalls).toContainEqual(expect.objectContaining({ method: "session/set_model", params: expect.objectContaining({ modelId: "claude-fixture-4" }) }));
    const hands = JSON.stringify(rememberedHandsForTest());
    const last = rememberedHandsForTest().at(-1)!;
    const permissionTime = JSON.stringify(execEnvHanded(last, scratch, ["/bin/sh", "-c"]));
    for (const text of [hands, permissionTime, JSON.stringify(recorder!.events)]) {
      expect(text).not.toContain(KEY_A);
      expect(text).not.toContain(KEY_B);
      expect(text).not.toContain(fixtureCredentialFingerprint(KEY_B));
    }
    expect(JSON.stringify(state)).not.toContain(fixtureCredentialFingerprint(KEY_B));
  });

  it("an account provider: no key reaches the child and its own method id signs in", async () => {
    write(keyFile("cline"));
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_AUTH_METHODS = "cline,openai-codex";
    await create();
    await instance!.adapter.sendTurn({ threadId: "t-cline-oauth", text: "hi" });
    expect(await recorder!.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(dumped(dump).env.CLINE_API_KEY).toBeUndefined();
    expect(JSON.parse(readFileSync(`${dump}.auth.json`, "utf8"))).toEqual({ methodId: "cline" });
    expect(JSON.stringify(recorder!.events)).not.toContain(TOKEN);
  });

  it("an unconfigured file ends the turn with the sign-in note before anything starts", async () => {
    write({ ...keyFile(), version: 2 });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create();
    await instance!.adapter.sendTurn({ threadId: "t-cline-none", text: "hi" });
    const done = await recorder!.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(recorder!.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: CLINE_LOGIN_NOTE, setup: true }));
    expect(existsSync(dump)).toBe(false);
  });
});

describe("a failing-auth engine with no method to call (Grok's shape)", () => {
  const LOGIN = "Sign in to the fixture engine";
  const support = (extra: Partial<AcpSupport>): AcpSupport => ({
    driverKind: "authSkipFixture", displayName: "Auth Skip Fixture", models: { default: "m", options: [{ id: "m", label: "M" }] },
    defaultCli: FAKE_CLI, nativeSource: "fixture.acp", loginNote: LOGIN, spawnArgs: () => [], pickAuthMethod: () => null,
    authFailure: "fail", isAuthenticated: () => true, ...extra,
  });
  const run = async (extra: Partial<AcpSupport>) => {
    const driver = createAcpDriver(support(extra));
    const instance = await driver.create({ instanceId: "auth-skip", displayName: "Auth Skip", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: "t-auth-skip", text: "hi" });
      return await recorder.until((event) => event.type === "turn.completed");
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  };

  it("fails with the sign-in note when the engine reports signed in but offers no method (the base behaviour)", async () => {
    expect(await run({})).toMatchObject({ ok: false });
  });

  it("proceeds only for an engine that asks to skip while signed in (Cline's saved key)", async () => {
    expect(await run({ skipAuthWhenSignedIn: true })).toMatchObject({ ok: true });
  });
});
