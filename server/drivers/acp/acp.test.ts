// ACP driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts. Covers the shared acp/core.ts runtime via
// its two harness shims (grok = fail-closed auth, gemini = lenient auth):
// normalize the ACP handshake into canonical events, keep argv/env hygiene,
// broker permission asks, and settle interrupts/crashes cleanly.
//
// The fake CLI is a shebang script Windows cannot exec directly —
// resolveCliSpawn turns it into `node <script>`, so these run everywhere.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { GrokAgentDriver } from "./grok.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { DroidAgentDriver } from "./droid.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("ACP decodeConfig", () => {
  it("grok defaults to the grok binary", () => {
    expect(GrokAgentDriver.decodeConfig({})).toEqual({ cli: "grok", fullAuto: false, workspace: undefined });
  });
  it("gemini defaults to the gemini binary", () => {
    expect(GeminiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "gemini", fullAuto: false, workspace: undefined });
  });
  it("kimi defaults to the kimi binary and declares cross-platform setup", () => {
    expect(KimiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "kimi", fullAuto: false, workspace: undefined });
    expect(KimiAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("install.sh"),
      linux: expect.stringContaining("install.sh"),
      win32: expect.stringContaining("install.ps1"),
    });
    expect(KimiAgentDriver.install?.signInCommand).toBe("kimi login");
  });
  it("droid defaults to the droid binary and declares cross-platform setup", () => {
    expect(DroidAgentDriver.decodeConfig(undefined)).toEqual({ cli: "droid", fullAuto: false, workspace: undefined });
    expect(DroidAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("factory.ai/cli"),
      linux: expect.stringContaining("factory.ai/cli"),
      win32: expect.stringContaining("factory.ai/cli"),
    });
    expect(DroidAgentDriver.install?.signInCommand).toBe("droid");
  });
  it("fullAuto only when explicitly true", () => {
    expect(GrokAgentDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
    expect(GrokAgentDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });
});

describe("ACP turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (driver = GrokAgentDriver, mode?: string) => {
    if (mode) process.env.FAKE_ACP_MODE = mode;
    instance = await driver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.XAI_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "grok-4.5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.started", // tool tc-1
      "item.completed", // tool tc-1 done
      "thread.token-usage.updated",
      "item.completed", // assistant_text (summed) on settle
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "grokAgent")).toBe(true);
    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 10, output: 5 });
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("hello from fake acp");
    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("passes ACP stdio flags and strips XAI_API_KEY from the child env", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.XAI_API_KEY = "xai-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("agent");
    expect(seen.argv).toContain("stdio");
    expect(seen.argv).toContain("--permission-mode");
    expect(seen.env.XAI_API_KEY).toBeUndefined();
  });

  it("droid takes model and autonomy over the wire, never through argv", async () => {
    // `droid exec -m <id> -o acp` ignores the flag (verified against 0.196.0),
    // so a model that only reached argv would silently run the CLI's own pick.
    instance = await DroidAgentDriver.create({
      instanceId: "droid-test",
      displayName: "Droid Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const dump = join(scratch, "droid-dump.json");
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-droid", text: "go", model: "claude-sonnet-5" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toEqual(["exec", "-o", "acp"]);
    expect(seen.argv).not.toContain("-m");

    const applied = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
    expect(applied).toEqual([
      { method: "session/set_mode", params: { sessionId: "fake-acp-session", modeId: "auto-high" } },
      { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "claude-sonnet-5" } },
    ]);
  });

  it("droid pins read-only mode when fullAuto is off", async () => {
    instance = await DroidAgentDriver.create({
      instanceId: "droid-safe",
      displayName: "Droid Safe",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const dump = join(scratch, "droid-safe.json");
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-droid-safe", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    // Both settings are explicit even with nothing on the turn: whatever
    // ~/.factory/settings.json pinned (including a `custom:` provider with its
    // own endpoint) must never be what the session silently runs on.
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toEqual([
      { method: "session/set_mode", params: { sessionId: "fake-acp-session", modeId: "normal" } },
      { method: "session/set_model", params: { sessionId: "fake-acp-session", modelId: "claude-opus-5" } },
    ]);
  });

  it("droid names the rejected setting when the agent predates session config", async () => {
    // The realistic failure is version skew: an older droid answers -32601 to
    // session/set_mode, and core surfaces the RPC message verbatim. A bare
    // "method not found" tells the user nothing, so the driver wraps it.
    process.env.FAKE_ACP_MODE = "no-session-config";
    instance = await DroidAgentDriver.create({
      instanceId: "droid-old-cli",
      displayName: "Droid Old CLI",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-droid-skew", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "rpc_error" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain("session/set_mode");
    expect(err.message).toContain('autonomy mode "normal"');
    expect(err.message).toMatch(/`droid` is current/);
    // The session id still reached the client, so the thread can resume rather
    // than orphaning the session droid just created.
    expect(recorder.events.some((e) => e.type === "session.started")).toBe(true);
  });

  it("surfaces a permission ask as request.opened and completes once allowed", async () => {
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({ threadId: "t-perm", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });

    await instance.adapter.respondToRequest("t-perm", (opened as any).requestId, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("grok fails closed when the CLI advertises no cached_token (needs login)", async () => {
    await create(GrokAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/not signed in/);
  });

  it("gemini proceeds through a missing auth method (lenient login)", async () => {
    await create(GeminiAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-lenient", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.provider === "geminiAgent")).toBe(true);
  });

  it("rejects a second turn while one is in flight", async () => {
    await create(GrokAgentDriver, "hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "session.started");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("interrupt settles a hung turn as cancelled", async () => {
    await create(GrokAgentDriver, "hang");
    await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ type: "turn.completed" });
  });

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create(GrokAgentDriver, "exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  });
});

describe("ACP snapshot", () => {
  it("a missing binary is unavailable", async () => {
    const instance = await GrokAgentDriver.create({
      instanceId: "grok-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-grok-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    await instance.dispose();
  });

  it("kimi checks KIMI_CODE_HOME before the child HOME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-kimi-auth-"));
    const kimiHome = join(scratch, "custom-kimi-home");
    const childHome = join(scratch, "child-home");
    mkdirSync(join(childHome, ".kimi-code", "credentials"), { recursive: true });
    writeFileSync(join(childHome, ".kimi-code", "credentials", "kimi-code.json"), "{}");

    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-custom-home",
      displayName: undefined,
      environment: { KIMI_CODE_HOME: kimiHome, HOME: childHome },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(false);
      mkdirSync(join(kimiHome, "credentials"), { recursive: true });
      writeFileSync(join(kimiHome, "credentials", "kimi-code.json"), "{}");
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("droid resolves the signed-in CLI before falling back to FACTORY_API_KEY", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-auth-"));
    // FACTORY_HOME_OVERRIDE replaces the CLI's HOME, not its data root: droid
    // writes <home>/.factory/auth.v2.file either way (verified against 0.196.0).
    const overrideHome = join(scratch, "custom-home");
    const childHome = join(scratch, "child-home");
    mkdirSync(join(childHome, ".factory"), { recursive: true });
    writeFileSync(join(childHome, ".factory", "auth.v2.file"), "{}");

    // The child env inherits process.env (core.ts childEnv), so a developer
    // machine with a real FACTORY_API_KEY exported would otherwise satisfy
    // every case here and prove nothing about the on-disk lookup.
    const make = (environment: Record<string, string>) =>
      DroidAgentDriver.create({
        instanceId: "droid-auth",
        displayName: undefined,
        environment: { FACTORY_API_KEY: "", ...environment },
        enabled: true,
        config: { cli: FAKE_CLI, fullAuto: false },
      });

    const instances: ProviderInstance[] = [];
    try {
      // FACTORY_HOME_OVERRIDE wins: the child HOME's credential must not count.
      const overridden = await make({ FACTORY_HOME_OVERRIDE: overrideHome, HOME: childHome });
      instances.push(overridden);
      expect((await overridden.snapshot()).authenticated).toBe(false);
      mkdirSync(join(overrideHome, ".factory"), { recursive: true });
      writeFileSync(join(overrideHome, ".factory", "auth.v2.file"), "{}");
      expect((await overridden.snapshot()).authenticated).toBe(true);

      // A logged-out override is not rescued by a key on the way past it, but
      // the key alone still authenticates when nothing is signed in on disk.
      const loggedOutWithKey = await make({
        FACTORY_HOME_OVERRIDE: join(scratch, "empty-home"),
        HOME: childHome,
        FACTORY_API_KEY: "fk-test",
      });
      instances.push(loggedOutWithKey);
      expect((await loggedOutWithKey.snapshot()).authenticated).toBe(true);

      const fromHome = await make({ HOME: childHome });
      instances.push(fromHome);
      expect((await fromHome.snapshot()).authenticated).toBe(true);

      // secure_auth_storage writes the keychain/keyring variant instead of
      // auth.v2.file, so a fresh macOS login has only this one.
      const keychainHome = join(scratch, "keychain-home");
      mkdirSync(join(keychainHome, ".factory"), { recursive: true });
      writeFileSync(join(keychainHome, ".factory", "auth.v2.loginkeychain"), "{}");
      const fromKeychain = await make({ HOME: keychainHome });
      instances.push(fromKeychain);
      expect((await fromKeychain.snapshot()).authenticated).toBe(true);

      const neither = await make({ HOME: join(scratch, "empty") });
      instances.push(neither);
      expect((await neither.snapshot()).authenticated).toBe(false);
    } finally {
      for (const i of instances) await i.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("droid reads custom models, favourites order, and the configured default", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-models-"));
    mkdirSync(join(scratch, ".factory"), { recursive: true });
    writeFileSync(
      join(scratch, ".factory", "settings.json"),
      JSON.stringify({
        customModels: [
          { id: "custom:LMStudio-Qwen-0", displayName: "Qwen (local)" },
          { id: "custom:Azure-Opus-0", displayName: "Azure Opus" },
        ],
        modelFavorites: ["custom:Azure-Opus-0", "custom:LMStudio-Qwen-0"],
        sessionDefaultSettings: { model: "custom:LMStudio-Qwen-0" },
      }),
    );

    const instance = await DroidAgentDriver.create({
      instanceId: "droid-models",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      // favourites first in the user's own order, then the built-in slice
      expect(instance.models.options.slice(0, 2)).toEqual([
        { id: "custom:Azure-Opus-0", label: "Azure Opus" },
        { id: "custom:LMStudio-Qwen-0", label: "Qwen (local)" },
      ]);
      expect(instance.models.options.some((o) => o.id === "claude-opus-5")).toBe(true);
      expect(instance.models.default).toBe("custom:LMStudio-Qwen-0");
    } finally {
      await instance.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("droid falls back to the built-in catalog when settings.json is unreadable", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-droid-nosettings-"));
    mkdirSync(join(scratch, ".factory"), { recursive: true });
    writeFileSync(join(scratch, ".factory", "settings.json"), "{ not json");

    const instance = await DroidAgentDriver.create({
      instanceId: "droid-models-fallback",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(instance.models.default).toBe("claude-opus-5");
      expect(instance.models.options.every((o) => !o.id.startsWith("custom:"))).toBe(true);
    } finally {
      await instance.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("kimi resolves default credentials from the child HOME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-kimi-home-"));
    const credentialDir = join(scratch, ".kimi-code", "credentials");
    mkdirSync(credentialDir, { recursive: true });
    writeFileSync(join(credentialDir, "kimi-code.json"), "{}");

    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-child-home",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
