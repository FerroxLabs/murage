// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolation-all round 7: a bot's engine isolation FAILS CLOSED. When the bot's own engine folder cannot be established
// (another process holds it past the retry bound, or the build fails), the turn is rejected before any spawn; the engine is
// never started in the owner's own home, and a bot never keeps the shared probe scope.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR, ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { createAcpDriver, type AcpSupport } from "./acp/core.ts";
import { scopeDroidHome } from "./acp/droid.ts";
import { isolateGeminiFromPersonalSetup } from "./acp/gemini-isolation.ts";
import { scopeGrokHome } from "./acp/grok-scope.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { scopedCodexHome } from "./codex-isolation.ts";
import {
  ScopeUnavailableError, resetScopeBookkeeping, scopeLockPath, scopedCliHomeRoot, setScopeRetryBoundMs, withScopeRetry,
} from "./scoped-cli-home.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");
const FAKE_AGY = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");
const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
/** Another live process (the test runner's parent) holds this scope's lease. */
const hold = (root: string) => writeFileSync(scopeLockPath(root), JSON.stringify({ pid: process.ppid, id: null }));
const release = (root: string) => rmSync(scopeLockPath(root), { force: true });

beforeEach(() => { ensureDirs(); resetScopeBookkeeping(); setScopeRetryBoundMs(250); });
afterEach(() => {
  setScopeRetryBoundMs(10_000);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("withScopeRetry", () => {
  it("retries a busy folder within the bound and succeeds once it clears", async () => {
    let calls = 0;
    const value = await withScopeRetry(() => { calls += 1; if (calls < 3) throw new ScopeUnavailableError("busy", true); return "ok"; });
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rejects with the user-facing reason once the bound passes", async () => {
    const started = Date.now();
    await expect(withScopeRetry(() => { throw new ScopeUnavailableError("busy now", true); })).rejects.toThrow(/busy now/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it("rejects any other setup failure at once, as a scope error, never as an ordinary fall-through", async () => {
    let calls = 0;
    const error = await withScopeRetry(() => { calls += 1; throw new Error("EACCES"); }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScopeUnavailableError);
    expect(calls).toBe(1);
  });
});

describe("every engine's scope setup throws when the folder stays busy (no swallow, env untouched)", () => {
  it("codex", () => {
    const real = tmp("iso7-codex-");
    writeFileSync(join(real, "auth.json"), "LOGIN");
    const root = scopedCodexHome({ HOME: real, CODEX_HOME: real }, "0.150.0", "bot-c")!;
    hold(root);
    expect(() => scopedCodexHome({ HOME: real, CODEX_HOME: real }, "0.150.0", "bot-c")).toThrow(ScopeUnavailableError);
    release(root);
    expect(scopedCodexHome({ HOME: real, CODEX_HOME: real }, "0.150.0", "bot-c")).toBe(root);
  });

  it("grok", () => {
    const real = tmp("iso7-grok-");
    writeFileSync(join(real, "auth.json"), "LOGIN");
    const first: Record<string, string | undefined> = { HOME: real, GROK_HOME: real };
    scopeGrokHome(first, "1.0.60", "bot-g");
    const root = first.GROK_HOME!;
    expect(root.startsWith(scopedCliHomeRoot("grok"))).toBe(true);
    hold(root);
    const env: Record<string, string | undefined> = { HOME: real, GROK_HOME: real };
    expect(() => scopeGrokHome(env, "1.0.60", "bot-g")).toThrow(ScopeUnavailableError);
    expect(env.GROK_HOME).toBe(real); // never silently left to start; the turn path rejects
    release(root);
  });

  it("droid", () => {
    const real = tmp("iso7-droid-");
    mkdirSync(join(real, ".factory"), { recursive: true });
    writeFileSync(join(real, ".factory", "auth.v2.file"), "LOGIN");
    const first: Record<string, string | undefined> = { HOME: real };
    scopeDroidHome(first, "0.250.0", "bot-d");
    const root = first.FACTORY_HOME_OVERRIDE!;
    hold(root);
    expect(() => scopeDroidHome({ HOME: real }, "0.250.0", "bot-d")).toThrow(ScopeUnavailableError);
    release(root);
  });

  it("gemini: a bot turn never keeps the shared probe scope, and always ends with its own scoped home", () => {
    const home = tmp("iso7-gemini-");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
    writeFileSync(join(home, ".gemini", "oauth_creds.json"), "LOGIN");
    const env: Record<string, string | undefined> = { HOME: home };
    isolateGeminiFromPersonalSetup(env); // the probe's shared scope
    const probe = env.GEMINI_CLI_HOME!;
    expect(probe.startsWith(scopedCliHomeRoot("gemini"))).toBe(true);
    isolateGeminiFromPersonalSetup(env, "bot-iso7", true);
    const botScope = env.GEMINI_CLI_HOME!;
    expect(botScope).not.toBe(probe);
    // contention on a fresh build: the strict path throws and the turn is rejected; it must never go on with the probe scope
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } }, ui: { theme: "x" } }));
    hold(botScope);
    const retry: Record<string, string | undefined> = { HOME: home, GEMINI_CLI_HOME: probe };
    expect(() => isolateGeminiFromPersonalSetup(retry, "bot-iso7", true)).toThrow(ScopeUnavailableError);
    release(botScope);
  });

  it("gemini: contention through the whole bound rejects (withScopeRetry), and a clear mid-bound succeeds with the scoped HOME var set", async () => {
    const home = tmp("iso7-gemini-b-");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), "{}");
    writeFileSync(join(home, ".gemini", "oauth_creds.json"), "LOGIN");
    const first: Record<string, string | undefined> = { HOME: home };
    isolateGeminiFromPersonalSetup(first, "bot-b", true);
    const botScope = first.GEMINI_CLI_HOME!;
    writeFileSync(join(home, ".gemini", "settings.json"), '{"ui":{"theme":"y"}}');
    hold(botScope);
    const env: Record<string, string | undefined> = { HOME: home };
    await expect(withScopeRetry(() => isolateGeminiFromPersonalSetup(env, "bot-b", true))).rejects.toBeInstanceOf(ScopeUnavailableError);
    expect(env.GEMINI_CLI_HOME).toBeUndefined();
    setScopeRetryBoundMs(5_000);
    setTimeout(() => release(botScope), 300);
    await withScopeRetry(() => isolateGeminiFromPersonalSetup(env, "bot-b", true));
    expect(env.GEMINI_CLI_HOME).toBe(botScope);
  });

  it("gemini: an unreadable settings.json gives the scope empty settings, never the owner's own file", () => {
    const home = tmp("iso7-gemini-c-");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), "{ not json");
    writeFileSync(join(home, ".gemini", "oauth_creds.json"), "LOGIN");
    const env: Record<string, string | undefined> = { HOME: home };
    isolateGeminiFromPersonalSetup(env, "bot-c", true);
    expect(env.GEMINI_CLI_HOME!.startsWith(scopedCliHomeRoot("gemini"))).toBe(true);
    expect(readFileSync(join(env.GEMINI_CLI_HOME!, ".gemini", "settings.json"), "utf8")).not.toContain("not json");
  });
});

describe("the turn is rejected before any spawn", () => {
  function supportWith(applyMountEnv: AcpSupport["applyMountEnv"]): AcpSupport {
    return {
      driverKind: "scopeFailClosedTest",
      displayName: "Scope Test",
      models: { default: "m", options: [{ id: "m", label: "M" }] },
      defaultCli: FAKE_ACP,
      nativeSource: "scope-test.acp",
      loginNote: "never reached",
      scopeKind: "scopefailtest",
      spawnArgs: () => [],
      pickAuthMethod: () => null,
      authFailure: "continue",
      isAuthenticated: () => true,
      applyMountEnv,
    };
  }
  async function run(support: AcpSupport, dump: string) {
    chmodSync(FAKE_ACP, 0o755);
    const driver = createAcpDriver(support);
    const instance = await driver.create({ instanceId: "scope", displayName: "scope", enabled: true,
      config: driver.decodeConfig({ cli: FAKE_ACP, fullAuto: true }),
      environment: { FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump } });
    const recorder = recordEvents(instance.adapter);
    try {
      const result = await instance.adapter.sendTurn({ threadId: "scope-1", text: "hi", cwd: dirname(dump), warmIdentity: { botId: "bot-scope", audience: "owner" } })
        .then(() => ({ rejected: null as string | null }), (error: unknown) => ({ rejected: (error as Error).message }));
      if (result.rejected === null) await recorder.until((event) => event.type === "turn.completed", 15_000);
      return { ...result, events: recorder.events };
    } finally { recorder.stop(); await instance.dispose(); }
  }

  it("a scope that stays busy through the bound: no process is started and the reason is shown", async () => {
    const dir = tmp("iso7-core-");
    const dump = join(dir, "spawn.json");
    const out = await run(supportWith(() => { throw new ScopeUnavailableError("This bot's engine files are being tidied up right now. Try again in a moment.", true); }), dump);
    expect(existsSync(dump)).toBe(false);
    const text = out.rejected ?? JSON.stringify(out.events);
    expect(text).toMatch(/tidied up/);
    expect(out.events.some((event) => event.type === "turn.completed" && event.ok === true)).toBe(false);
  });

  it("a scope that fails to build (not busy): no process is started", async () => {
    const dir = tmp("iso7-core-b-");
    const dump = join(dir, "spawn.json");
    const out = await run(supportWith(() => { throw new Error("EACCES: permission denied"); }), dump);
    expect(existsSync(dump)).toBe(false);
    expect(out.rejected ?? JSON.stringify(out.events)).toMatch(/could not be set up/);
  });

  it("a scope that clears within the bound: the turn starts with the scoped home in its env", async () => {
    const dir = tmp("iso7-core-c-");
    const dump = join(dir, "spawn.json");
    let attempts = 0;
    const out = await run(supportWith((env) => {
      attempts += 1;
      if (attempts < 3) throw new ScopeUnavailableError("busy", true);
      env.HOME = "/scoped/home";
    }), dump);
    expect(out.rejected).toBeNull();
    expect(attempts).toBe(3);
    expect((JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string> }).env.HOME).toBe("/scoped/home");
  });
});

describe("Antigravity: a scope that cannot be built rejects the turn, never runs in the real home", () => {
  it("rejects before any spawn", async () => {
    chmodSync(FAKE_AGY, 0o755);
    const scopeRoot = join(DATA_DIR, "native", "antigravity-scope");
    mkdirSync(dirname(scopeRoot), { recursive: true });
    rmSync(scopeRoot, { recursive: true, force: true });
    writeFileSync(scopeRoot, "not a folder"); // the scope root cannot be created
    const home = tmp("iso7-agy-");
    const instance = await AntigravityDriver.create({ instanceId: "agy-iso7", displayName: "Antigravity", enabled: true,
      environment: { HOME: home }, config: { cli: FAKE_AGY, fullAuto: true } });
    try {
      const error = await instance.adapter.sendTurn({ threadId: "agy-iso7", text: "hi" }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ScopeUnavailableError);
      // a structured code, rendered in the owner's language by the chat; the English line is only for logs
      expect(error).toMatchObject({ code: "unavailable", engine: "Antigravity", busy: false });
    } finally {
      await instance.dispose();
      rmSync(scopeRoot, { force: true });
    }
  });
});
