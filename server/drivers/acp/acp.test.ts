// ACP driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts. Covers the shared acp/core.ts runtime via
// its two harness shims (grok = fail-closed auth, gemini = lenient auth):
// normalize the ACP handshake into canonical events, keep argv/env hygiene,
// broker permission asks, and settle interrupts/crashes cleanly.
//
// The fake CLI is a shebang script Windows cannot exec directly —
// resolveCliSpawn turns it into `node <script>`, so these run everywhere.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import { scanFolderTrustSources } from "../../folder-trust.ts";
import type { ProviderTurnRoute } from "../../provider-routing.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { acpErrorDiagnostic, acpEngineErrorText, acpEngineExitStderrText, acpEngineStderrCapture, acpRpcErrorDetails, acpRpcErrorMessage, createAcpDriver, LOCATORS, skipSubscriptionAuthForLocalInject, type AcpSupport } from "./core.ts";
import { redactSecretsInText } from "../../redact.ts";
import { redactSecretsInText as redactSecretsInTextShipped } from "../../testing/redact-release-0.1.53.ts";
import { ERROR_MESSAGE_MAX, ENGINE_ERROR_CATEGORIES } from "../../../shared/provider-error.ts";
import { GrokAgentDriver } from "./grok.ts";
import { FuigoAgentDriver } from "./fuigo.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { DroidAgentDriver } from "./droid.ts";
import { CursorAgentDriver } from "./cursor.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { QUESTION_TIMEOUT_MS } from "../../../shared/questions.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

/** Signal 0 probes existence without touching the process. */
const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** A harness that exists only in tests: it exercises the opt-in session-config
 *  model hook so PR 1 can prove the core capability without shipping a visible
 *  engine. Real harnesses live in their own file. */
const SELECT_MODEL_SUPPORT: AcpSupport = {
  driverKind: "selectModelTest",
  displayName: "Select Model Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }, { id: "m-two", label: "Two" }] },
  defaultCli: "fake-select-model",
  nativeSource: "test.acp",
  loginNote: "never reached",
  selectModel: { configId: "model" },
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
};
const SelectModelDriver = createAcpDriver(SELECT_MODEL_SUPPORT);
const FuigoDiagnosticDriver = createAcpDriver({ ...SELECT_MODEL_SUPPORT, nativeSource: "fuigo.acp", selectModel: undefined });

/** Proves transformEnv can vary with the instance config, which is how the
 *  opencode driver picks its permission policy from `fullAuto`. */
const EnvPolicyDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "envPolicyTest",
  selectModel: undefined,
  transformEnv: (env, config) => {
    env.TEST_POLICY = config.fullAuto ? "auto" : "ask";
  },
});

/** Proves snapshot() awaits an async isAuthenticated, which is how the
 *  opencode driver answers from a discovered catalog. */
const AsyncAuthDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "asyncAuthTest",
  selectModel: undefined,
  isAuthenticated: async () => true,
});

const ClassifiedErrorDriver = createAcpDriver({
  ...SELECT_MODEL_SUPPORT,
  driverKind: "classifiedErrorTest",
  selectModel: undefined,
  classifyError: (error) =>
    error && typeof error === "object" && (error as { code?: unknown }).code === -32000
      ? "invalid_credentials"
      : undefined,
});

describe("skipSubscriptionAuthForLocalInject", () => {
  it("is true only for a host:: inject id", () => {
    expect(skipSubscriptionAuthForLocalInject("omlx::MiniMax-M3-4bit")).toBe(true);
    expect(skipSubscriptionAuthForLocalInject("unsloth::orcarouter/Qwen3.8-27B-Uncensored-GGUF")).toBe(true);
    expect(skipSubscriptionAuthForLocalInject("grok-4.6")).toBe(false);
    expect(skipSubscriptionAuthForLocalInject(undefined)).toBe(false);
  });
});

describe("ACP decodeConfig", () => {
  it("resolves a dynamic model catalog when a support provides one", async () => {
    const support: AcpSupport = {
      driverKind: "dynamic-test",
      displayName: "Dynamic Test",
      models: { default: "fallback", options: [{ id: "fallback", label: "Fallback" }] },
      defaultCli: FAKE_CLI,
      nativeSource: "dynamic-test.acp",
      loginNote: "not authenticated",
      spawnArgs: () => [],
      pickAuthMethod: () => null,
      authFailure: "continue",
      isAuthenticated: () => true,
      resolveModels: async () => ({
        default: "dynamic-model",
        options: [{ id: "dynamic-model", label: "Dynamic model" }],
      }),
    };
    const driver = createAcpDriver(support);
    const instance = await driver.create({
      instanceId: "dynamic-test",
      displayName: "Dynamic Test",
      environment: {},
      enabled: true,
      config: driver.defaultConfig(),
    });
    expect(instance.models).toEqual({
      default: "dynamic-model",
      options: [{ id: "dynamic-model", label: "Dynamic model" }],
    });
    await instance.dispose();
  });
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
  it("cursor defaults to its unambiguous binary and declares cross-platform setup", () => {
    expect(CursorAgentDriver.decodeConfig(undefined)).toEqual({
      cli: "cursor-agent",
      fullAuto: false,
      workspace: undefined,
    });
    expect(CursorAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("cursor.com/install"),
      linux: expect.stringContaining("cursor.com/install"),
      win32: expect.stringContaining("cursor.com/install"),
    });
    expect(CursorAgentDriver.install?.signInCommand).toBe("cursor-agent login");
  });
  it("fullAuto only when explicitly true", () => {
    expect(GrokAgentDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
    expect(GrokAgentDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });

  it("does not advertise or accept local CUA in full-auto mode", async () => {
    const fullAuto = await GrokAgentDriver.create({
      instanceId: "grok-full-auto",
      displayName: "Grok Full Auto",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    expect(fullAuto.adapter.capabilities.localComputerMcp).toBe(false);
    await expect(
      fullAuto.adapter.sendTurn({
        threadId: "t-full-auto-local",
        text: "click",
        integrations: {
          localComputer: {
            command: "/cua-driver",
            args: ["mcp"],
            env: {},
            platform: "linux",
            scope: "local-computer",
          },
        },
      }),
    ).rejects.toThrow(/interactive provider approvals/);
    await fullAuto.dispose();
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
    scratch = mkdtempSync(join(tmpdir(), "murage-acp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.FAKE_ACP_PID_FILE;
    delete process.env.FAKE_ACP_TERM;
    delete process.env.FAKE_ACP_TERM_MS;
    delete process.env.MURAGE_PROVIDER_CLOSE_MS;
    delete process.env.XAI_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_AUTH_TOKEN;
    delete process.env.BOX_TOKEN;
    delete process.env.MURAGE_TTS_KEY;
    delete process.env.FAKE_ACP_MODELS;
    delete process.env.FAKE_ACP_MODEL_STICKS;
    delete process.env.FAKE_ACP_USAGE_ROOT;
    delete process.env.FAKE_ACP_LOAD_NULL;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
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
      "item.completed", // assistant_text before the tool, not summed on settle
      "item.started", // tool tc-1
      "item.completed", // tool tc-1 done
      "thread.token-usage.updated",
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

  it("emits each assistant text block before the tool that follows it", async () => {
    await create(GrokAgentDriver, "interleave");
    await instance.adapter.sendTurn({ threadId: "t-interleave", text: "go", model: "grok-4.5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // before one
      "item.started", // tc-1
      "item.completed", // tc-1
      "content.delta",
      "item.completed", // before two
      "item.started", // tc-2
      "item.completed", // tc-2
      "content.delta",
      "thread.token-usage.updated",
      "item.completed", // after — no following tool, so settle flushes
      "turn.completed",
    ]);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before one", "before two", "after"]);
  });

  it("normalizes a structured ACP image block without treating it as text", async () => {
    await create(GeminiAgentDriver, "image");
    await instance.adapter.sendTurn({ threadId: "t-image", text: "draw it" });
    await recorder.until((e) => e.type === "turn.completed");

    const image = recorder.events.find(
      (e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_image",
    );
    expect(image).toMatchObject({
      type: "item.completed",
      itemType: "assistant_image",
      alt: "Generated image",
    });
    expect(image && "data" in image ? (image as { data: string }).data : "").toMatch(/^iVBOR/);
    expect(
      recorder.events.some(
        (e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text",
      ),
    ).toBe(false);
  });

  // The native tee is a plain 0644-adjacent file people paste into bug
  // reports, and an image block is megabytes of base64. The bytes must reach
  // the normalizer and nothing else.
  it("keeps the image bytes out of the provider-native log", async () => {
    await create(GeminiAgentDriver, "image");
    await instance.adapter.sendTurn({ threadId: "t-image-log", text: "draw it" });
    await recorder.until((e) => e.type === "turn.completed");

    const log = readFileSync(join(NATIVE_DIR, "t-image-log.ndjson"), "utf8");
    expect(log).toContain("agent_message_chunk");
    expect(log).toContain("[image data: ");
    expect(log).not.toContain("iVBOR");
  });

  it("reads token usage from the root of the prompt result", async () => {
    process.env.FAKE_ACP_USAGE_ROOT = "1";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-usage-root", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated");
    expect(usage).toMatchObject({ input: 10, output: 5 });
  });

  it("passes ACP stdio flags and strips foreign provider keys from the child env", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.XAI_API_KEY = "xai-should-not-leak";
    process.env.OPENCODE_API_KEY = "opencode-should-not-leak";
    process.env.CURSOR_API_KEY = "cursor-should-not-leak";
    process.env.CURSOR_AUTH_TOKEN = "cursor-token-should-not-leak";
    // workspace credentials with no CLI consumer at all — held by the
    // harness (env-injected at boot by the desktop shell), used in-process
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.MURAGE_TTS_KEY = "tts-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("agent");
    expect(seen.argv).toContain("stdio");
    expect(seen.argv).toContain("--permission-mode");
    expect(seen.env.XAI_API_KEY).toBeUndefined();
    expect(seen.env.OPENCODE_API_KEY).toBeUndefined();
    expect(seen.env.CURSOR_API_KEY).toBeUndefined();
    expect(seen.env.CURSOR_AUTH_TOKEN).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.MURAGE_TTS_KEY).toBeUndefined();
  });

  it("strips ambient routing switches, which no credentialEnv allowlist can grant", async () => {
    // The credential loop above is filtered by `support.credentialEnv`; a
    // routing switch must never be grantable that way, so it is stripped
    // unconditionally — a driver allowed a key still cannot be redirected.
    const ambient = {
      OPENAI_BASE_URL: "https://leftover.example/v1",
      OPENAI_MODEL: "leftover-openai-model",
      ANTHROPIC_BASE_URL: "https://leftover.example",
      ANTHROPIC_AUTH_TOKEN: "sk-leftover-should-not-route",
      ANTHROPIC_MODEL: "leftover-model",
    } as const;
    const saved = Object.fromEntries(Object.keys(ambient).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ambient);
    try {
      await create();
      const dump = join(scratch, "dump-routing.json");
      process.env.FAKE_ACP_DUMP = dump;

      await instance.adapter.sendTurn({ threadId: "t-routing", text: "go" });
      await recorder.until((e) => e.type === "turn.completed");

      const seen = JSON.parse(readFileSync(dump, "utf8"));
      for (const name of Object.keys(ambient)) expect(seen.env[name]).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  // ACP session/new accepts stdio MCP entries, so connected apps use the
  // same harness-owned bridge as Claude and Codex.
  it("mounts connected apps as a stdio MCP server", async () => {
    await create();
    const dump = join(scratch, "composio.json");
    process.env.FAKE_ACP_DUMP = dump;
    expect(instance.adapter.capabilities.composioMcp).toBe(true);
    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "go",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: { MURAGE_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"))).toContainEqual({
      name: "composio",
      command: process.execPath,
      args: ["/tmp/connector-proxy.js"],
      env: [{ name: "MURAGE_CONNECTOR_UPSTREAM_URL", value: "http://127.0.0.1:8799/api/internal/connectors/mcp" }],
    });
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

  it("mounts local CUA only on an approval-capable ACP instance", async () => {
    await create();
    const dump = join(scratch, "local-dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "inspect",
      integrations: {
        localComputer: {
          command: "/opt/cua driver/cua-driver",
          args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
          env: { CUA_DRIVER_EMBEDDED: "1" },
          platform: "linux",
          generation: "generation-1",
          scope: "local-computer",
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpServers).toContainEqual({
      name: "computer",
      command: "/opt/cua driver/cua-driver",
      args: ["mcp", "--embedded", "--socket", "/run/user/1000/driver.sock"],
      env: [{ name: "CUA_DRIVER_EMBEDDED", value: "1" }],
    });
    expect(instance.adapter.capabilities.localComputerMcp).toBe(true);
  });

  it("mounts dedicated memory without agents and rejects custom replacement", async () => {
    await create();
    const dump=join(scratch,"memory-dump.json");process.env.FAKE_ACP_DUMP=dump;
    await instance.adapter.sendTurn({threadId:"memory-only",text:"recall",integrations:{
      memory:{command:process.execPath,args:["/fake/memory-proxy.js"],env:{MURAGE_HARNESS_URL:"http://127.0.0.1:1",MURAGE_MEMORY_TOKEN:"memory-fixture-secret"}},
      custom:{"murage-memory":{command:"attacker-mcp",args:[],env:{}},forged:{command:"attacker-mcp",args:[],env:{MURAGE_MEMORY_TOKEN:"forged"}}},
    }});
    await recorder.until(event=>event.type==="turn.completed");
    const seen=JSON.parse(readFileSync(dump,"utf8"));
    expect(instance.adapter.capabilities.memoryMcp).toBe(true);
    expect(seen.mcpServers).toEqual([{name:"murage-memory",command:process.execPath,args:["/fake/memory-proxy.js"],env:[
      {name:"MURAGE_HARNESS_URL",value:"http://127.0.0.1:1"},{name:"MURAGE_MEMORY_TOKEN",value:"memory-fixture-secret"},
    ]}]);
  });

  it("skips custom MCP entries with reserved env names while preserving built-ins and ordinary custom mounts", async () => {
    await create();
    const dump = join(scratch, "custom-dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    const blocked = Object.fromEntries([
      "MURAGE_COMMS_TOKEN", "murage_harness_url", "MURAGEBOX_TOKEN", "muragebox_url",
      "ELECTRON_RUN_AS_NODE", "electron_run_as_node", "DWEB_URL", "dweb_url",
      "PH_ANDROID_SERIAL", "ph_android_serial",
    ].map((key, index) => [`blocked${index}`, {
      command: "attacker-mcp", args: [], env: { [key]: "attacker-value", CUSTOM_REJECTED_MARKER: "must-not-copy" },
    }]));
    await instance.adapter.sendTurn({
      threadId: "t-custom-mcp",
      text: "go",
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { MURAGE_HARNESS_URL: "http://127.0.0.1:1", MURAGE_COMMS_TOKEN: "built-in-token" },
        },
        custom: {
          ...blocked,
          bearer_request: { command: "attacker-mcp", args: [], env: { MURAGE_COMMS_TOKEN: "" } },
          notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: { NOTES_TOKEN: "tok-1" } },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpServers.map((server: { name: string }) => server.name)).toEqual(["agents", "notes"]);
    expect(JSON.stringify(seen.mcpServers)).not.toContain("attacker-mcp");
    expect(seen.mcpServers).toContainEqual({
      name: "agents", command: process.execPath, args: ["/fake/agents-proxy.js"],
      env: [
        { name: "MURAGE_HARNESS_URL", value: "http://127.0.0.1:1" },
        { name: "MURAGE_COMMS_TOKEN", value: "built-in-token" },
      ],
    });
    expect(seen.mcpServers).toContainEqual({
      name: "notes",
      command: "npx",
      args: ["-y", "@x/notes-mcp"],
      env: [{ name: "NOTES_TOKEN", value: "tok-1" }],
    });
    expect(instance.adapter.capabilities.customMcp).toBe(true);
  });

  it("surfaces a permission ask as request.opened and completes once allowed", async () => {
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({
      threadId: "t-perm",
      text: "go",
      integrations: {
        localComputer: {
          command: "/cua-driver",
          args: ["mcp"],
          env: {},
          platform: "linux",
          scope: "local-computer",
        },
      },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "shell",
      approvalScope: "local-computer",
    });

    await instance.adapter.respondToRequest("t-perm", (opened as any).requestId, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({
      behavior: "allow",
      source: "user",
      approvalScope: "local-computer",
    });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("answers a card 'Yes' with the ONE-TIME option even when the engine lists 'allow always' first (LFU2)", async () => {
    // Fuigo's real edit prompt (1.0.11 and 1.0.12, read off the wire) puts
    // `allow_always` "allow all edits during this session" ahead of
    // `allow_once`. A card answer is one decision; taking the first `allow*`
    // handed the engine a session-wide grant that Murage's approval layer
    // never saw again.
    const dump = join(scratch, "decision.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GrokAgentDriver, "permission-session-first");
    await instance.adapter.sendTurn({ threadId: "t-perm-once", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });

    await instance.adapter.respondToRequest("t-perm-once", (opened as any).requestId, { behavior: "allow" });
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "allow", source: "user" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  it("answers a card 'No' with the one-time reject, never a standing one (LFU2)", async () => {
    const dump = join(scratch, "decision.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GrokAgentDriver, "permission-session-first");
    await instance.adapter.sendTurn({ threadId: "t-perm-deny-once", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-perm-deny-once", (opened as any).requestId, { behavior: "deny" });
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "user" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
  });

  it.each(["allow", "deny", "full-auto"] as const)("never widens a one-request answer to always-only options: %s", async (behavior) => {
    const dump = join(scratch, "always-only.json"), cli = join(scratch, "always-only.mjs");
    // A scripted ACP child offers only standing decisions and records the real
    // response. It executes no tools and has no model or network connection.
    writeFileSync(cli, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
let promptId;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === "always-only" && message.result) {
    writeFileSync(${JSON.stringify(dump)}, JSON.stringify(message.result));
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  } else if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "synthetic" } });
  else if (message.method === "session/prompt") {
    promptId = message.id;
    send({ jsonrpc: "2.0", id: "always-only", method: "session/request_permission", params: {
      toolCall: { kind: "execute", title: "synthetic action" },
      options: [{ optionId: "allow-standing", kind: "allow_always" }, { optionId: "reject-standing", kind: "reject_always" }]
    } });
  }
});
`);
    chmodSync(cli, 0o755);
    instance = await SelectModelDriver.create({ instanceId: "always-only", displayName: "Always only", environment: {}, enabled: true,
      config: { cli, fullAuto: behavior === "full-auto" } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "always-only", text: "go" });
    if (behavior !== "full-auto") {
      const opened = await recorder.until(event => event.type === "request.opened");
      expect(await instance.adapter.respondToRequest("always-only", (opened as any).requestId, { behavior })).toBe("unavailable");
      expect(await recorder.until(event => event.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "system" });
      expect(recorder.events.some(event => event.type === "runtime.error" && event.message.includes("cancelling the request"))).toBe(true);
    }
    await recorder.until(event => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8"))).toEqual(behavior === "full-auto"
      ? { outcome: { outcome: "selected", optionId: "allow-standing" } }
      : { outcome: { outcome: "cancelled" } });
  });

  it.each(["deny", "allow", "cancel", "timeout", "teardown", "other-engine", "question", "reject-always", "full-auto"] as const)(
    "Fuigo denial continuation wire boundary: %s", async (scenario) => {
      const dump = join(scratch, "fuigo-denial.json");
      const cli = join(scratch, "denial-cli.mjs");
      // One scripted permission request, no tool execution or model call.
      // The dump captures the actual response and prompt count on the wire.
      writeFileSync(cli, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
let promptId, prompts = 0;
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === "permission" && message.result) {
    writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ decision: message.result, prompts }));
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  } else if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "synthetic" } });
  else if (message.method === "session/prompt") {
    promptId = message.id; prompts++;
    send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: {
      toolCall: { kind: "execute", title: ${JSON.stringify(scenario === "question" ? "AskUserQuestion" : "synthetic write")} },
      options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: ${JSON.stringify(scenario === "reject-always" ? "reject_always" : "reject_once")} }]
    } });
  }
});
`);
      chmodSync(cli, 0o755);
      const driver = createAcpDriver({ ...SELECT_MODEL_SUPPORT,
        driverKind: scenario === "other-engine" ? "other-test" : FuigoAgentDriver.driverKind,
        selectModel: undefined,
      });
      instance = await driver.create({ instanceId: "denial-test", displayName: "Denial Test", environment: {}, enabled: true,
        config: { cli, fullAuto: scenario === "full-auto" } });
      recorder = recordEvents(instance.adapter);
      // Shorten only this exact production permission deadline; real child I/O
      // and every other timer keep their ordinary behavior.
      const originalTimeout = globalThis.setTimeout;
      const timerSpy = scenario === "timeout" ? vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) =>
        originalTimeout(callback, delay === 15 * 60_000 ? 100 : delay, ...args)) as typeof setTimeout) : null;
      try {
        const { turnId } = await instance.adapter.sendTurn({ threadId: "denial-wire", text: "go" });
        if (scenario !== "full-auto") {
          const opened = await recorder.until(event => event.type === "request.opened");
          if (scenario === "cancel") await instance.adapter.interruptTurn("denial-wire", turnId);
          else if (scenario === "teardown") await instance.dispose();
          else if (scenario !== "timeout") await instance.adapter.respondToRequest("denial-wire", (opened as any).requestId,
            { behavior: scenario === "allow" ? "allow" : "deny" });
        }
        await recorder.until(event => event.type === "turn.completed");
        // settle may kill the child immediately after cancelling its pending ask;
        // wait for its dump only when the response reached the scripted child.
        if (scenario === "cancel" || scenario === "teardown") {
          const native = readFileSync(join(NATIVE_DIR, "denial-wire.ndjson"), "utf8").split("\n").filter(Boolean)
            .map(line => JSON.parse(line)).filter(entry => entry.dir === "out" && entry.msg?.id === "permission");
          expect(native.at(-1)?.msg.result).toEqual({ outcome: { outcome: "cancelled" } });
          return;
        }
        const observed = JSON.parse(readFileSync(dump, "utf8"));
        expect(observed.prompts).toBe(1);
        const expected = { outcome: { outcome: "selected", optionId: scenario === "allow" || scenario === "full-auto" ? "allow-once" : "reject-once" } };
        if (scenario === "deny") {
          expect(observed.decision).toEqual({ ...expected, _meta: { followup_message: "The user denied this operation. Do not retry it, bypass the denial, or perform an equivalent action through another tool. Keep the operation unexecuted and explain the limitation and any safe alternatives without taking further action." } });
          expect(recorder.events.find(event => event.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "user" });
        } else expect(observed.decision).toEqual(scenario === "reject-always" ? { outcome: { outcome: "cancelled" } } : expected);
      } finally { timerSpy?.mockRestore(); }
    },
  );

  it("never lets fullAuto answer a question tool routed through request_permission (ASK1)", async () => {
    process.env.FAKE_ACP_MODE = "question-tool";
    instance = await GrokAgentDriver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-question-tool", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "AskUserQuestion", questionTool: true });

    await instance.adapter.respondToRequest("t-question-tool", (opened as any).requestId, { behavior: "deny" });
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "user" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("advertises form and URL elicitation in initialize (ASK3)", async () => {
    const dump = join(scratch, "init.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GrokAgentDriver);
    await instance.adapter.sendTurn({ threadId: "t-init-caps", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");
    const init = JSON.parse(readFileSync(dump, "utf8")).initialize;
    expect(init).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, elicitation: { form: {}, url: {} } },
    });
  });

  it("maps Fuigo's _fuigo/ask_user_question to a question card and answers {outcome:accepted} by question text (ASK3)", async () => {
    const dump = join(scratch, "fuigo-q.json");
    process.env.FAKE_ACP_DUMP = dump;
    // fullAuto on: a question is never auto-answered
    process.env.FAKE_ACP_MODE = "fuigo-question";
    instance = await GrokAgentDriver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-fuigo-q", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "question",
      tool: "ask_user_question",
      summary: "Which database?",
      choices: ["Redis", "Postgres"],
      questions: [
        { id: "q1", question: "Which database?", options: [{ label: "Redis", description: "In-memory" }, { label: "Postgres", description: "Relational" }], multiSelect: false, allowOther: true },
        { id: "q2", question: "Which frameworks?", options: [{ label: "React" }, { label: "Vue" }], multiSelect: true, allowOther: true },
      ],
    });
    expect(opened).not.toHaveProperty("questionTool");

    await expect(
      instance.adapter.respondToRequest("t-fuigo-q", (opened as any).requestId, {
        behavior: "answer",
        message: "Redis; React, Vue; and Svelte",
        answers: [
          { id: "q1", selected: ["Redis"] },
          { id: "q2", selected: ["React", "Vue"], other: "and Svelte" },
        ],
      }),
    ).resolves.toBe("answered");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "answer", source: "user" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
      outcome: "accepted",
      answers: { "Which database?": ["Redis"], "Which frameworks?": ["React", "Vue"] },
      annotations: { "Which frameworks?": { notes: "and Svelte" } },
    });
  });

  it("answers a dismissed Fuigo question with {outcome:cancelled}, and the same when the turn is stopped (ASK3)", async () => {
    const dump = join(scratch, "fuigo-cancel.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GrokAgentDriver, "fuigo-question");
    await instance.adapter.sendTurn({ threadId: "t-fuigo-skip", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.respondToRequest("t-fuigo-skip", (opened as any).requestId, { behavior: "deny" })).resolves.toBe("rejected");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "user" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ outcome: "cancelled" });
    recorder.stop();
    await instance.dispose();

    // A stopped turn resolves the open question as a system non-answer (the
    // cancelled reply is written before the child is torn down; whether a
    // dying child still reads it is not something a test can pin).
    await create(GrokAgentDriver, "fuigo-question");
    await instance.adapter.sendTurn({ threadId: "t-fuigo-stop", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.interruptTurn("t-fuigo-stop");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "system" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("answers Fuigo's MCP elicitation bridge with its outcome-tagged reply (ASK3)", async () => {
    const dump = join(scratch, "fuigo-elicit.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GrokAgentDriver, "fuigo-elicit");
    await instance.adapter.sendTurn({ threadId: "t-fuigo-elicit", text: "deploy" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "question",
      tool: "elicitation",
      questions: [{ id: "environment", question: "Which environment?", options: [{ label: "staging" }, { label: "production" }], allowOther: false }],
    });
    await expect(
      instance.adapter.respondToRequest("t-fuigo-elicit", (opened as any).requestId, {
        behavior: "answer", message: "staging", answers: [{ id: "environment", selected: ["staging"] }],
      }),
    ).resolves.toBe("answered");
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ outcome: "accept", content: { environment: "staging" } });
    recorder.stop();
    await instance.dispose();

    const dump2 = join(scratch, "fuigo-elicit-decline.json");
    process.env.FAKE_ACP_DUMP = dump2;
    await create(GrokAgentDriver, "fuigo-elicit");
    await instance.adapter.sendTurn({ threadId: "t-fuigo-elicit-skip", text: "deploy" });
    const skipped = await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.respondToRequest("t-fuigo-elicit-skip", (skipped as any).requestId, { behavior: "deny" })).resolves.toBe("rejected");
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump2, "utf8")).decision).toEqual({ outcome: "decline" });
  });

  it("maps an ACP form elicitation to questions and accepts typed content, under both method spellings (ASK3)", async () => {
    for (const mode of ["elicitation-form", "elicitation-legacy"] as const) {
      const dump = join(scratch, `${mode}.json`);
      process.env.FAKE_ACP_DUMP = dump;
      await create(GrokAgentDriver, mode);
      const threadId = `t-${mode}`;
      await instance.adapter.sendTurn({ threadId, text: "deploy" });
      const opened = await recorder.until((e) => e.type === "request.opened");
      expect(opened).toMatchObject({
        requestType: "question",
        tool: "elicitation",
        summary: "Deploy settings\nEnvironment",
        questions: [
          { id: "environment", header: "Environment", options: [{ label: "staging" }, { label: "production" }], multiSelect: false, allowOther: false },
          { id: "features", header: "Features", options: [{ label: "cache" }, { label: "cdn" }], multiSelect: true, allowOther: false },
          { id: "confirm", header: "Really?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: false },
        ],
      });
      await expect(
        instance.adapter.respondToRequest(threadId, (opened as any).requestId, {
          behavior: "answer",
          message: "production; cdn; Yes",
          answers: [
            { id: "environment", selected: ["production"] },
            { id: "features", selected: ["cdn"] },
            { id: "confirm", selected: ["Yes"] },
          ],
        }),
      ).resolves.toBe("answered");
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
        action: "accept",
        content: { environment: "production", features: ["cdn"], confirm: true },
      });
      recorder.stop();
      await instance.dispose();
    }
  });

  it("declines a skipped elicitation and cancels one the turn outlives (ASK3)", async () => {
    const dump = join(scratch, "elicit-decline.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GrokAgentDriver, "elicitation-form");
    await instance.adapter.sendTurn({ threadId: "t-elicit-skip", text: "deploy" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.respondToRequest("t-elicit-skip", (opened as any).requestId, { behavior: "deny" })).resolves.toBe("rejected");
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "decline" });
    recorder.stop();
    await instance.dispose();

    await create(GrokAgentDriver, "elicitation-form");
    await instance.adapter.sendTurn({ threadId: "t-elicit-stop", text: "deploy" });
    await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.interruptTurn("t-elicit-stop");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "system" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("shows a URL elicitation as a link the owner opens, never fetches it, and accepts only after the explicit tap (ASK3)", async () => {
    const dump = join(scratch, "elicit-url.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GrokAgentDriver, "elicitation-url");
    await instance.adapter.sendTurn({ threadId: "t-elicit-url", text: "deploy" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "question",
      questions: [{
        id: "url",
        question: "Sign in to the deploy service to continue\nhttps://example.com/authorize?state=abc",
        options: [{ label: "I opened the link", description: "https://example.com/authorize?state=abc" }],
        allowOther: false,
      }],
    });
    // nothing was fetched: the fake would have to be asked, and it never is
    // (the driver has no HTTP client for this; the card only shows text)
    await expect(
      instance.adapter.respondToRequest("t-elicit-url", (opened as any).requestId, {
        behavior: "answer",
        message: "I opened the link",
        answers: [{ id: "url", selected: ["I opened the link"] }],
      }),
    ).resolves.toBe("answered");
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "accept" });
  });

  it("grok fails closed when the CLI advertises no cached_token (needs login)", async () => {
    await create(GrokAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/not signed in/);
  });

  it("grok local inject does not require grok.com login", async () => {
    process.env.FAKE_ACP_MODE = "no-auth";
    mkdirSync(join(scratch, ".grok"), { recursive: true });
    instance = await GrokAgentDriver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: { HOME: scratch, GROK_HOME: join(scratch, ".grok") },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({
      threadId: "t-local-auth",
      text: "go",
      model: "omlx::MiniMax-M3-4bit",
    });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
  });

  it("gemini proceeds through a missing auth method (lenient login)", async () => {
    await create(GeminiAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-lenient", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.provider === "geminiAgent")).toBe(true);
  });

  it("starts Gemini CLI on its stable ACP surface", async () => {
    const dump = join(scratch, "gemini-acp.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GeminiAgentDriver);
    await instance.adapter.sendTurn({ threadId: "t-gemini-acp", text: "go", model: "gemini-test" });
    await recorder.until((e) => e.type === "turn.completed");

    const argv = JSON.parse(readFileSync(dump, "utf8")).argv as string[];
    expect(argv).toEqual(["--acp", "-m", "gemini-test"]);
    expect(argv).not.toContain("--experimental-acp");
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

  it("cancellation-close regression: exit on cancellation is not an unexpected failure", async () => {
    await create(GrokAgentDriver, "exit-on-cancel");
    const threadId = "t-cancel-close";
    await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    await recorder.until(event => event.type === "content.delta" && event.delta === "fixture cancellation ready");
    const started = performance.now();
    await instance.adapter.interruptTurn(threadId);
    const done = await recorder.until(event => event.type === "turn.completed", 4000);
    const raw = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(raw.some(row => row.dir === "out" && row.msg.method === "session/cancel")).toBe(true);
    const errors = recorder.events.filter(event => event.type === "runtime.error");
    console.log(JSON.stringify({ cancellationCloseObserved: { elapsedMs: Math.round(performance.now() - started), terminal: done.type === "turn.completed" ? { ok: done.ok, stopReason: done.stopReason } : null, runtimeErrors: errors.length, cancelRequestRecorded: true } }));
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(errors).toEqual([]);
    expect(recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
    expect(instance.adapter.hasSession(threadId)).toBe(false);
  });

  it("a prompt rejected after Stop sent session/cancel settles as a cancellation, not an engine error", async () => {
    await create(GrokAgentDriver, "cancel-reject");
    const threadId = `t-cancel-reject-${Date.now()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    await recorder.until(event => event.type === "content.delta" && event.delta === "fixture cancellation ready");
    await instance.adapter.interruptTurn(threadId);
    const done = await recorder.until(event => event.type === "turn.completed", 4000);
    expect(done).toMatchObject({ turnId, ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter(event => event.type === "runtime.error")).toEqual([]);
    // The rejection reached the driver after session/cancel and before the
    // turn settled: the cancellation is not the grace timer winning a race.
    const rows = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const cancelAt = rows.findIndex(row => row.dir === "out" && row.msg?.method === "session/cancel");
    const rejectedAt = rows.findIndex(row => row.dir === "lifecycle" && row.msg?.event === "rpc_rejected" && row.msg?.method === "session/prompt");
    const settledAt = rows.findIndex(row => row.dir === "lifecycle" && row.msg?.event === "turn_settled");
    expect(cancelAt).toBeGreaterThan(-1);
    expect(rejectedAt).toBeGreaterThan(cancelAt);
    expect(settledAt).toBeGreaterThan(rejectedAt);
  });

  it("a prompt that ends with another stop reason after Stop settles as a cancellation, not an engine error", async () => {
    await create(GrokAgentDriver, "cancel-other-reason");
    const threadId = `t-cancel-other-${Date.now()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    await recorder.until(event => event.type === "content.delta" && event.delta === "fixture cancellation ready");
    await instance.adapter.interruptTurn(threadId);
    const done = await recorder.until(event => event.type === "turn.completed", 4000);
    expect(done).toMatchObject({ turnId, ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter(event => event.type === "runtime.error")).toEqual([]);
    // The result reached the driver after session/cancel and before the turn
    // settled: the cancellation is not the grace timer winning a race.
    const rows = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const cancelAt = rows.findIndex(row => row.dir === "out" && row.msg?.method === "session/cancel");
    const resultAt = rows.findIndex(row => row.dir === "in" && row.msg?.result?.stopReason === "refusal");
    const settledAt = rows.findIndex(row => row.dir === "lifecycle" && row.msg?.event === "turn_settled");
    expect(cancelAt).toBeGreaterThan(-1);
    expect(resultAt).toBeGreaterThan(cancelAt);
    expect(settledAt).toBeGreaterThan(resultAt);
  });

  // The cancel guards are deliberately broad. `interruptTurn` is one call for
  // every interrupter: a user's Stop, the stall watchdog (server/index.ts
  // ~2507) and a provider-settings change (~512) all reach it identically, and
  // the driver records the requested stop as `unspecified` precisely because it
  // cannot tell them apart. A turn that was interrupted is a cancellation
  // whoever interrupted it — reporting it as an engine error would be the same
  // false failure these guards exist to remove.
  it("an interrupt Murage raised itself settles as a cancellation, exactly as a user's Stop does", async () => {
    await create(GrokAgentDriver, "cancel-other-reason");
    const threadId = `t-cancel-watchdog-${Date.now()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    await recorder.until(event => event.type === "content.delta" && event.delta === "fixture cancellation ready");
    // The exact call the stall watchdog and the provider-connection subscriber
    // make: no argument tells the driver a user asked for this.
    await instance.adapter.interruptTurn(threadId);
    const done = await recorder.until(event => event.type === "turn.completed", 4000);
    expect(done).toMatchObject({ turnId, ok: true, stopReason: "cancelled" });
    expect(recorder.events.filter(event => event.type === "runtime.error")).toEqual([]);
    const rows = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    // Nothing in the driver's own record names an initiator, so the guard that
    // reads `cancelRequested` cannot be narrowed to a user's Stop without
    // losing the watchdog and settings-change interrupts entirely.
    expect(rows.find(row => row.dir === "lifecycle" && row.msg?.event === "stop_requested")?.msg)
      .toMatchObject({ reason: "unspecified" });
  });

  const engineStderrRecords = (threadId: string) =>
    readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { dir: string; msg: Record<string, any> })
      .filter((row) => row.msg?.engineStderr !== undefined);

  it("an engine failure writes its last stderr lines to the native log as one bounded, redacted record", async () => {
    await create(GrokAgentDriver, "stderr-rpc-error");
    const threadId = `t-stderr-rpc-error-${Date.now()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ turnId, ok: false, stopReason: "rpc_error" });
    await instance.adapter.awaitTurnTeardown!(threadId, turnId);
    const records = engineStderrRecords(threadId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ dir: "in", msg: { engineStderr: { stopReason: "rpc_error", truncated: true } } });
    const lines: string[] = records[0].msg.engineStderr.lines;
    expect(lines.at(-1)).toBe("STDERR_LAST_LINE retry 15/15 gave up");
    expect(lines.at(-2)).toMatch(/^auth header «redacted \d+ chars»$/);
    expect(lines.length).toBeLessThanOrEqual(100);
    const encoded = JSON.stringify(records[0]);
    expect(encoded).not.toMatch(/\\u001b|SYNTHETICKEYCANARY|STDERR_EVICTED_FIRST_LINE/);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(16 * 1024);
  });

  it("an engine exit before the prompt result also keeps its stderr in the native log", async () => {
    await create(GrokAgentDriver, "exit-with-ansi");
    const threadId = `t-stderr-exit-${Date.now()}`;
    await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const records = engineStderrRecords(threadId);
    expect(records).toHaveLength(1);
    expect(records[0].msg.engineStderr).toMatchObject({ stopReason: "exit_before_result", truncated: false });
    expect(records[0].msg.engineStderr.lines).toContain("STDERR_VISIBLE_END");
    expect(JSON.stringify(records[0])).not.toMatch(/\\u001b|SYNTHETICKEYCANARY/);
  });

  it("a successful turn keeps its stderr out of the native log", async () => {
    await create(GrokAgentDriver, "stderr-happy");
    const threadId = `t-stderr-happy-${Date.now()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ turnId, ok: true });
    await instance.adapter.awaitTurnTeardown!(threadId, turnId);
    expect(engineStderrRecords(threadId)).toEqual([]);
  });

  it("Fuigo retry progress arrives as reasoning and never joins the answer", async () => {
    await create(GrokAgentDriver, "retry-status-thought");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-retry-status-thought", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ turnId, ok: true, stopReason: null });
    const stream = (kind: "assistant_text" | "reasoning_text") =>
      recorder.events.flatMap(event => event.type === "content.delta" && event.streamKind === kind ? [event.delta] : []).join("");
    expect(stream("reasoning_text")).toBe("Retrying the model (1/2): empty response from model (reasoning_only)\n\nfixture reasoning");
    expect(stream("assistant_text")).toBe("fixture final answer");
    expect(recorder.events.flatMap(event => event.type === "item.completed" && event.itemType === "assistant_text" ? [event.text] : [])).toEqual(["fixture final answer"]);
    expect(recorder.events.some(event => event.type === "runtime.error")).toBe(false);
  });

  it("ACP plan updates arrive as whole plans, never as answer text", async () => {
    await create(GrokAgentDriver, "plan");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-plan", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ turnId, ok: true });
    const plans = recorder.events.flatMap(event => event.type === "plan.updated" ? [event] : []);
    expect(plans.map(event => event.entries)).toEqual([
      [
        { content: "Read the folder", status: "in_progress" },
        { content: "Fix the bug", status: "pending" },
      ],
      [
        { content: "Read the folder", status: "completed" },
        { content: "Fix the bug", status: "in_progress" },
        { content: "Report back", status: "pending" },
      ],
    ]);
    expect(plans.every(event => event.turnId === turnId && event.threadId === "t-plan")).toBe(true);
    const answer = recorder.events.flatMap(event => event.type === "item.completed" && event.itemType === "assistant_text" ? [event.text] : []);
    expect(answer).toEqual(["fixture plan answer"]);
  });

  it("close-confirmed stop: interruptTurn resolves only after the ACP child has exited", async () => {
    const pidFile = join(scratch, "acp.pid");
    process.env.FAKE_ACP_PID_FILE = pidFile;
    process.env.FAKE_ACP_TERM = "linger";
    process.env.FAKE_ACP_TERM_MS = "400";
    await create(GrokAgentDriver, "cancel-ack");
    const threadId = "t-close-confirmed";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    await recorder.until((e) => e.type === "content.delta" && e.delta === "fixture cancellation ready");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(processAlive(pid)).toBe(true);
    // The agent acknowledges the cancel at once; the child keeps running until
    // it is terminated. Returning here used to hand its workspace away early.
    await expect(instance.adapter.interruptTurn(threadId)).resolves.toEqual({ closeConfirmed: true });
    expect(processAlive(pid)).toBe(false);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toEqual([
      expect.objectContaining({ turnId, ok: true, stopReason: "cancelled" }),
    ]);
    await expect(instance.adapter.awaitTurnTeardown!(threadId, turnId)).resolves.toEqual({ closeConfirmed: true });
  });

  it("close-confirmed stop: a child still alive at the deadline stays owned", async () => {
    const pidFile = join(scratch, "acp.pid");
    process.env.FAKE_ACP_PID_FILE = pidFile;
    process.env.FAKE_ACP_TERM = "ignore";
    process.env.MURAGE_PROVIDER_CLOSE_MS = "300";
    await create(GrokAgentDriver, "cancel-ack");
    const threadId = "t-close-unconfirmed";
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    await recorder.until((e) => e.type === "content.delta" && e.delta === "fixture cancellation ready");
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      if (process.platform === "win32") {
        // taskkill /T /F cannot be intercepted by the child: the real Windows
        // route ends it, so the stop is confirmed there.
        await expect(instance.adapter.interruptTurn(threadId)).resolves.toEqual({ closeConfirmed: true });
        return;
      }
      await expect(instance.adapter.interruptTurn(threadId)).rejects.toMatchObject({
        code: "provider_stop_unconfirmed",
        stopResult: { closeConfirmed: false, reason: "timeout" },
      });
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      expect(instance.adapter.hasSession(threadId)).toBe(false);
      expect(processAlive(pid)).toBe(true);
      await expect(instance.adapter.awaitTurnTeardown!(threadId, turnId)).resolves.toEqual({
        closeConfirmed: false,
        reason: "timeout",
      });
      process.kill(pid, "SIGKILL");
      // the child stayed tracked, so its late close is still observed
      await expect(instance.adapter.awaitTurnTeardown!(threadId, turnId)).resolves.toEqual({ closeConfirmed: true });
    } finally {
      if (processAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("close-confirmed stop: awaitTurnTeardown follows the exact turn's child, not a newer one", async () => {
    const pidFile = join(scratch, "acp.pid");
    process.env.FAKE_ACP_PID_FILE = pidFile;
    await create();
    const threadId = "t-teardown-generation";
    const first = await instance.adapter.sendTurn({ threadId, text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const firstPid = Number(readFileSync(pidFile, "utf8"));
    await expect(instance.adapter.awaitTurnTeardown!(threadId, first.turnId)).resolves.toEqual({ closeConfirmed: true });
    expect(processAlive(firstPid)).toBe(false);

    process.env.FAKE_ACP_MODE = "cancel-ack";
    const second = await instance.adapter.sendTurn({ threadId, text: "again" });
    await recorder.until((e) => e.type === "content.delta" && e.turnId === second.turnId);
    const secondPid = Number(readFileSync(pidFile, "utf8"));
    expect(secondPid).not.toBe(firstPid);
    // The closed older generation is confirmed without waiting on, or
    // vouching for, the live replacement.
    await expect(instance.adapter.awaitTurnTeardown!(threadId, first.turnId)).resolves.toEqual({ closeConfirmed: true });
    expect(processAlive(secondPid)).toBe(true);
    await expect(instance.adapter.interruptTurn(threadId)).resolves.toEqual({ closeConfirmed: true });
    expect(processAlive(secondPid)).toBe(false);
  });

  const lifecycleRows = (threadId: string) =>
    readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { dir: string; msg: Record<string, any> })
      .filter((row) => row.dir === "lifecycle")
      .map((row) => row.msg);

  it("lifecycle diagnostics: a completed turn traces one generation from spawn to close", async () => {
    await create();
    const threadId = `t-lifecycle-complete-${Date.now()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "LIFECYCLE_PROMPT_CANARY" });
    await recorder.until((e) => e.type === "turn.completed");
    await expect(instance.adapter.awaitTurnTeardown!(threadId, turnId)).resolves.toEqual({ closeConfirmed: true });
    const rows = lifecycleRows(threadId);
    const events = rows.map((row) => row.event);
    expect(events[0]).toBe("spawn_requested");
    expect(rows.filter((row) => row.event === "rpc_requested").map((row) => row.method)).toEqual(
      expect.arrayContaining(["initialize", "session/new", "session/prompt"]),
    );
    const at = (name: string) => events.indexOf(name);
    expect(at("spawned")).toBeGreaterThan(-1);
    expect(at("turn_settled")).toBeLessThan(at("stop_requested"));
    expect(at("stop_requested")).toBeLessThan(at("stop_route"));
    expect(at("stop_route")).toBeLessThan(at("closed"));
    expect(rows[at("turn_settled")]).toMatchObject({ reason: "turn_complete", settled: true, promptSent: true, cancelRequested: false });
    expect(rows[at("stop_requested")]).toMatchObject({ reason: "turn_complete" });
    expect(rows[at("stop_route")]).toMatchObject({
      route: process.platform === "win32" ? "windows_taskkill" : "posix_group_sigterm",
      result: "requested",
    });
    const closed = rows[at("closed")];
    expect(closed).toMatchObject({ settled: true, pendingMethods: [], pendingCount: 0, pid: rows[at("spawned")].pid });
    expect(closed).toHaveProperty("code");
    expect(closed).toHaveProperty("signal");
    expect(typeof closed.code === "number" || typeof closed.signal === "string").toBe(true);
    expect(new Set(rows.map((row) => row.processGeneration)).size).toBe(1);
    expect(rows.every((row) => row.type === "engine_lifecycle" && row.schema === 1 && row.turnId === turnId && row.driver === "grokAgent")).toBe(true);
    const sequences = rows.map((row) => row.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(JSON.stringify(rows)).not.toContain("LIFECYCLE_PROMPT_CANARY");
  });

  it("lifecycle diagnostics: an unsolicited close is recorded before settlement with no stop request", async () => {
    await create(GrokAgentDriver, "exit-on-prompt");
    const threadId = `t-lifecycle-unsolicited-${Date.now()}`;
    await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    await recorder.until((e) => e.type === "turn.completed");
    const rows = lifecycleRows(threadId);
    const events = rows.map((row) => row.event);
    const closedAt = events.indexOf("closed");
    expect(closedAt).toBeGreaterThan(-1);
    expect(events.slice(0, closedAt)).not.toContain("stop_requested");
    expect(events.indexOf("turn_settled")).toBeGreaterThan(closedAt);
    expect(rows[closedAt]).toMatchObject({
      code: process.platform === "win32" ? 1073807364 : 4,
      signal: null,
      settled: false,
      cancelRequested: false,
      promptSent: true,
      pendingMethods: ["session/prompt"],
      pendingCount: 1,
    });
    expect(rows.find((row) => row.event === "turn_settled")).toMatchObject({ reason: "turn_failure" });
    // later cleanup appends; it does not rewrite the close
    expect(rows.filter((row) => row.event === "stop_route_result").at(-1)).toMatchObject({ route: "already_exited" });
  });

  it("lifecycle diagnostics: a requested cancel is recorded before the close it preceded", async () => {
    await create(GrokAgentDriver, "exit-on-cancel");
    const threadId = `t-lifecycle-cancel-${Date.now()}`;
    await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    await recorder.until((e) => e.type === "content.delta" && e.delta === "fixture cancellation ready");
    await expect(instance.adapter.interruptTurn(threadId)).resolves.toEqual({ closeConfirmed: true });
    const rows = lifecycleRows(threadId);
    const events = rows.map((row) => row.event);
    const stopAt = events.indexOf("stop_requested");
    const closedAt = events.indexOf("closed");
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(closedAt);
    expect(rows[stopAt]).toMatchObject({ reason: "unspecified", cancelRequested: true, settled: false });
    expect(rows[closedAt]).toMatchObject({ cancelRequested: true, settled: false, pendingMethods: ["session/prompt"], pendingCount: 1 });
  });

  it("lifecycle diagnostics: an RPC rejection is attributed to its pending method before close", async () => {
    await create(GrokAgentDriver, "rpc-error:session/new");
    const threadId = `t-lifecycle-rejected-${Date.now()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    await recorder.until((e) => e.type === "turn.completed");
    await instance.adapter.awaitTurnTeardown!(threadId, turnId);
    const rows = lifecycleRows(threadId);
    const rejectedAt = rows.findIndex((row) => row.event === "rpc_rejected");
    expect(rows[rejectedAt]).toMatchObject({ method: "session/new", rpcCode: -32603, httpStatus: 500 });
    expect(typeof rows[rejectedAt].rpcId).toBe("number");
    expect(rejectedAt).toBeLessThan(rows.findIndex((row) => row.event === "closed"));
    expect(rows.find((row) => row.event === "turn_settled")).toMatchObject({ reason: "turn_failure" });
    expect(JSON.stringify(rows)).not.toMatch(/fake-private|fake-secret|billing\.invalid|Internal error/);
  });

  it("lifecycle diagnostics: a rejection with an unknown RPC id names no method", async () => {
    await create(GrokAgentDriver, "unknown-rpc-error");
    const threadId = `t-lifecycle-unknown-id-${Date.now()}`;
    await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    await recorder.until((e) => e.type === "turn.completed");
    const rejected = lifecycleRows(threadId).filter((row) => row.event === "rpc_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ rpcCode: -32603, httpStatus: 500 });
    expect(rejected[0]).not.toHaveProperty("method");
    expect(rejected[0]).not.toHaveProperty("rpcId");
    expect(JSON.stringify(rejected)).not.toContain("fake-secret-canary");
  });

  it("lifecycle diagnostics: consecutive children on one thread keep distinct generations", async () => {
    await create();
    const threadId = `t-lifecycle-generations-${Date.now()}`;
    for (const text of ["one", "two"]) {
      const { turnId } = await instance.adapter.sendTurn({ threadId, text });
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
      await expect(instance.adapter.awaitTurnTeardown!(threadId, turnId)).resolves.toEqual({ closeConfirmed: true });
    }
    const rows = lifecycleRows(threadId);
    const generations = [...new Set(rows.map((row) => row.processGeneration))];
    expect(generations).toHaveLength(2);
    for (const generation of generations) {
      const own = rows.filter((row) => row.processGeneration === generation);
      expect(own.filter((row) => row.event === "closed")).toHaveLength(1);
      expect(new Set(own.map((row) => row.turnId)).size).toBe(1);
    }
  });

  it.each(["string", "object"])("terminal compatibility: reasoning-only %s data is visible and classified without invented HTTP status", async shape => {
    await create(GrokAgentDriver, `reasoning-only:${shape}`);
    const threadId = `t-reasoning-${shape}`, { turnId } = await instance.adapter.sendTurn({ threadId, text: "fixture only" });
    const done = await recorder.until(event => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "rpc_error" });
    const error = recorder.events.find(event => event.type === "runtime.error");
    expect(error).toMatchObject({ message: shape === "string" ? "The model returned reasoning without a visible answer. No reply was produced." : "empty response from model (reasoning_only)", details: expect.stringContaining(shape === "string" ? "Engine failure category: empty_response" : "Engine error kind: empty_response"), diagnostic: { terminalKind: "empty_response" } });
    expect(error?.type === "runtime.error" ? error.details : "").not.toContain("HTTP");
    await instance.adapter.awaitTurnTeardown!(threadId, turnId);
  });

  it("terminal compatibility: unknown nested text stays private", () => {
    for (const data of ["private request fake-secret-canary", {message:"private request fake-secret-canary"}]) {
      expect(acpRpcErrorMessage({message:"Internal error",data})).toBe("Internal error");
      expect(acpRpcErrorDetails({code:-32603,data})).toBe("Engine error code: -32603");
    }
  });

  it("terminal compatibility: requested cancel wins a late prompt RPC rejection", async () => {
    await create(GrokAgentDriver, "cancel-rpc-error");
    const threadId = "t-cancel-rpc-error";
    await instance.adapter.sendTurn({threadId,text:"fixture only"});
    await recorder.until(event => event.type === "content.delta" && event.delta === "fixture cancellation ready");
    await instance.adapter.interruptTurn(threadId);
    const done = await recorder.until(event => event.type === "turn.completed");
    expect(done).toMatchObject({ok:true,stopReason:"cancelled"});
    expect(recorder.events.filter(event => event.type === "runtime.error")).toEqual([]);
    expect(recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
  });

  it("terminal compatibility: stderr before the 8KiB tail survives in redacted native diagnostics", async () => {
    await create(GrokAgentDriver, "exit-with-stderr-history");
    const threadId = "t-stderr-history", {turnId} = await instance.adapter.sendTurn({threadId,text:"fixture only"});
    await recorder.until(event => event.type === "turn.completed");
    await instance.adapter.awaitTurnTeardown!(threadId,turnId);
    const records=readFileSync(join(NATIVE_DIR,`${threadId}.ndjson`),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    const stderr=records.filter(row=>row.msg?.type==="engine_stderr").map(row=>row.msg.text).join("");
    expect(stderr).toContain("STDERR_EARLY_CANARY");expect(stderr).toContain("STDERR_VISIBLE_END");
    expect(stderr.length).toBeGreaterThan(8192);expect(stderr).not.toContain("SYNTHETICKEYCANARY");
    expect(stderr.length).toBeLessThanOrEqual(256*1024);
  });

  it("cancellation-close regression: unsolicited prompt exit remains a failure", async () => {
    await create(GrokAgentDriver, "exit-on-prompt");
    await instance.adapter.sendTurn({ threadId: "t-unsolicited-close", text: "fixture only" });
    const done = await recorder.until(event => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder.events.find(event => event.type === "runtime.error");
    const code = process.platform === "win32" ? 1073807364 : 4;
    expect(error).toMatchObject({ message: expect.stringContaining(`exited ${code} before the prompt result`) });
  });

  it("cancellation-close regression: unsolicited stderr is plain redacted bounded text", async () => {
    await create(GrokAgentDriver, "exit-with-ansi");
    await instance.adapter.sendTurn({ threadId: "t-ansi-close", text: "fixture only" });
    const done = await recorder.until(event => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder.events.find(event => event.type === "runtime.error");
    expect(error?.type).toBe("runtime.error");
    if (error?.type !== "runtime.error") throw new Error("Expected runtime failure");
    expect(error.message).toContain("STDERR_VISIBLE_END");
    expect(error.message).not.toContain("\u001b");
    expect(error.message).not.toContain("SYNTHETICKEYCANARY");
    expect(error.message.split("before the prompt result: ")[1].length).toBeLessThanOrEqual(300);
  });

  // Engine stderr is engine-controlled text, and this exit line is the last
  // path in core.ts that quoted it with nothing but a secret scrub: a
  // credential-bearing URL, a user:pass@IP authority, a bidi override and a
  // BEL all reached the card and messages.db. It now goes through the same
  // sanitiser `error.data.message` and the JSON-RPC `error.message` use.
  it("sanitises hostile engine stderr on the exit-before-result line", async () => {
    await create(GrokAgentDriver, "exit-hostile-stderr");
    await instance.adapter.sendTurn({ threadId: "t-hostile-stderr", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder.events.find(event => event.type === "runtime.error");
    if (error?.type !== "runtime.error") throw new Error("Expected runtime failure");
    expect(error.message).toContain("tool_error: fixture failure");
    expect(error.message).toContain("[link removed]");
    for (const leaked of ["billing.invalid", "fake-secret-canary", "fakepass", "10.1.2.3", "https://", "\u001b", "\u202e", "\u0007"]) {
      expect(error.message, leaked).not.toContain(leaked);
    }
    expect(error.message.split("before the prompt result: ")[1].length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
  });

  // …and sanitising must not cost the diagnostic it exists to carry. The
  // fixture is the shape that can actually lose one: four kilobytes of
  // structured NDJSON records with the fatal line LAST, which is how a CLI
  // agent goes down. A one-line fixture reads the same whatever the code does
  // and proves nothing. This one fails if the JSON rule empties the quote
  // (MU-R7-1) and fails again if the quote is taken from the front of the
  // window instead of its end (MU-R7-2).
  it("keeps the fatal last line of a noisy engine readable on the exit-before-result line", async () => {
    await create(GrokAgentDriver, "exit-noisy-stderr");
    await instance.adapter.sendTurn({ threadId: "t-noisy-stderr", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder.events.find(event => event.type === "runtime.error");
    if (error?.type !== "runtime.error") throw new Error("Expected runtime failure");
    const detail = error.message.split("before the prompt result: ")[1];
    expect(detail).toBeTruthy();
    expect(detail.endsWith("FATAL: engine could not open the model file: permission denied")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
  });

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create(GrokAgentDriver, "exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  });

  it("preserves ACP error codes for provider setup classification", async () => {
    await create(ClassifiedErrorDriver, "auth-required");
    await instance.adapter.sendTurn({ threadId: "t-auth-required", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({ setup: true });
  });

  it("explains nested credit exhaustion without exposing provider data", async () => {
    await create(GrokAgentDriver, "credit-exhausted");
    await instance.adapter.sendTurn({ threadId: "t-credit-exhausted", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(recorder.events.find(event => event.type === "runtime.error")).toMatchObject({ message: "Your model provider's credit balance is exhausted (HTTP 402). Review billing with your provider or choose another configured engine.", providerError: { kind: "credits", httpStatus: 402 }, details: expect.stringContaining("Provider response: HTTP 402") });
    expect(JSON.stringify(recorder.events)).not.toMatch(/fake-secret-canary|billing\.invalid/);
  });

  it("retains only safe ACP diagnostic facts for customer error details", () => {
    expect(acpRpcErrorDetails({ code: -32603, data: { http_status: 500, message: "fake-private-response", token: "fake-secret-canary" } })).toBe("Provider response: HTTP 500\nEngine error code: -32603");
    expect(acpRpcErrorDetails({ code: "fake-secret-canary", data: { http_status: "500", message: "private" } })).toBeUndefined();
    expect(acpRpcErrorDetails({ code: Infinity, data: { http_status: 999 } })).toBeUndefined();
  });
  it.each(["missing","private","flux-url"])("classifies payment-required %s without exhaustion claims, setup or replay",async variant=>{
    await create(GrokAgentDriver,`payment-required:${variant}`);
    const threadId=`t-payment-${variant}`;
    const {turnId}=await instance.adapter.sendTurn({threadId,text:"fixture only"});
    expect(await recorder.until(event=>event.type==="turn.completed")).toMatchObject({ok:false,stopReason:"rpc_error"});
    await expect(instance.adapter.awaitTurnTeardown!(threadId,turnId)).resolves.toEqual({closeConfirmed:true});
    const errors=recorder.events.filter(event=>event.type==="runtime.error");expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({message:"Your model provider rejected this request with HTTP 402. Check its billing and account access; this response does not establish that credits are exhausted.",providerError:{kind:"payment",httpStatus:402},details:"ACP request: session/prompt\nProvider response: HTTP 402\nEngine error code: -32603"});
    expect(errors[0].setup).not.toBe(true);expect(errors[0].providerError?.provider).toBeUndefined();
    expect(recorder.events.filter(event=>event.type==="turn.completed")).toHaveLength(1);
    expect(lifecycleRows(threadId).filter(row=>row.event==="rpc_requested"&&row.method==="session/prompt")).toHaveLength(1);
    expect(JSON.stringify(recorder.events)).not.toMatch(/fake-secret-canary|billing\.invalid|fluxrouter\.ai|private response/);
  });

  it.each([...ENGINE_ERROR_CATEGORIES, "context_length"])("allows typed terminal failure category %s", (error_kind) => {
    expect(acpRpcErrorDetails({ data: { error_kind } })).toBe(`Engine error kind: ${error_kind}`);
    expect(acpErrorDiagnostic({ eventId: "ev-m00001-1", turnId: "11111111-1111-4111-8111-111111111111" }, "22222222-2222-4222-8222-222222222222", { data: { error_kind } })?.terminalKind).toBe(error_kind);
    expect(acpRpcErrorDetails({ data: { error_kind: `${error_kind}\nfake-secret-canary` } })).toBeUndefined();
  });

  it.each(["empty", "success", "blank-http", "untyped-prose", "typed-conflict"])("Fuigo 1.0.18 contract %s uses one prompt, reasoning-only retry progress and authoritative typed failure", async variant => {
    const dump = join(scratch, "fuigo18.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(FuigoDiagnosticDriver, `fuigo18-contract:${variant}`);
    const { turnId } = await instance.adapter.sendTurn({ threadId: `fuigo18-${variant}`, text: "fixture only" });
    const completed = await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId);
    expect(completed).toMatchObject({ ok: variant === "success" });
    expect(recorder.events.filter(event => event.type === "content.delta" && event.streamKind === "reasoning_text")).toHaveLength(2);
    const answer = recorder.events.filter(event => (event.type === "content.delta" && event.streamKind === "assistant_text") || (event.type === "item.completed" && event.itemType === "assistant_text"));
    expect(JSON.stringify(answer)).not.toContain("Retry status");
    const errors = recorder.events.filter(event => event.type === "runtime.error");
    if (variant === "success") {
      expect(errors).toEqual([]);
      expect(answer).toContainEqual(expect.objectContaining({ type: "item.completed", text: "The completed answer." }));
    } else {
      expect(errors).toHaveLength(1);
      const error = errors[0];
      if (variant === "empty") expect(error).toMatchObject({ message: "No visible answer after three attempts", errorKind: "empty_response", diagnostic: { terminalKind: "empty_response" } });
      if (variant === "blank-http") expect(error).toMatchObject({ message: "Internal error", details: expect.stringContaining("HTTP 503"), errorKind: "api", diagnostic: { httpStatus: 503, terminalKind: "api" } });
      if (variant === "untyped-prose") { expect(error.errorKind).toBeUndefined(); expect(error.diagnostic?.terminalKind).toBeUndefined(); }
      if (variant === "typed-conflict") expect(error).toMatchObject({ errorKind: "rate_limited", diagnostic: { terminalKind: "rate_limited" } });
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(JSON.parse(readFileSync(dump, "utf8")).promptRequests).toBe(1);
    expect(recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
  });

  it("structured ACP diagnostics omit malformed facts rather than copying private fields",()=>{
    const base={eventId:"ev-m00001-1",turnId:"11111111-1111-4111-8111-111111111111"},generation="22222222-2222-4222-8222-222222222222";
    const diagnostic=acpErrorDiagnostic(base,generation,{acpRpcId:"1",acpMethod:"session/prompt\nfake-private",code:Infinity,data:{http_status:"402",error_kind:"fake-secret-canary",message:"private body"},fuigoObservedKind:"unknown",sessionId:"private-session"});
    expect(diagnostic).toEqual({version:1,diagnosticId:base.eventId,turnId:base.turnId,processGeneration:generation});
    expect(acpErrorDiagnostic({...base,turnId:"not-a-real-turn"},generation)).toBeUndefined();
  });
  it.each(["valid", "terminal", "foreign", "replay", "old", "missing-time", "future", "malformed", "unbounded", "unknown", "retry", "wrong-source"])("Fuigo diagnostic wire safely handles %s", async variant => {
    await create(variant === "wrong-source" ? GrokAgentDriver : FuigoDiagnosticDriver, `fuigo-diagnostic:${variant}`);
    const {turnId}=await instance.adapter.sendTurn({ threadId: "t-fuigo-diagnostic", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "rpc_error" });
    await expect(instance.adapter.awaitTurnTeardown!("t-fuigo-diagnostic",turnId)).resolves.toEqual({closeConfirmed:true});
    const errors = recorder.events.filter(event => event.type === "runtime.error");
    expect(errors).toHaveLength(1);
    const observed=variant==="valid"||variant==="terminal";
    expect(errors[0]).toMatchObject({ message: "fixture rejection [link removed]", details: "ACP request: session/prompt\nProvider response: HTTP 404"+(variant==="terminal"?"\nEngine error kind: max_tokens_truncation":"")+"\nEngine error code: -32603" + (observed ? "\nFuigo failure category observed during request: api\nFuigo retry state observed during request: failed" : "") });
    const rows=lifecycleRows("t-fuigo-diagnostic").filter(row=>row.turnId===turnId),rejection=rows.find(row=>row.event==="rpc_rejected"&&row.method==="session/prompt")!;
    expect(errors[0].diagnostic).toMatchObject({version:1,diagnosticId:errors[0].eventId,turnId,processGeneration:rejection.processGeneration,rpcId:rejection.rpcId,method:"session/prompt",rpcCode:-32603,httpStatus:404});
    expect(errors[0].diagnostic?.observedKind).toBe(observed?"api":undefined);expect(rejection.observedKind).toBe(observed?"api":undefined);
    expect(errors[0].diagnostic?.terminalKind).toBe(variant==="terminal"?"max_tokens_truncation":undefined);expect(rejection.terminalKind).toBe(variant==="terminal"?"max_tokens_truncation":undefined);
    expect(rows.filter(row=>row.event==="rpc_requested"&&row.method==="session/prompt")).toHaveLength(1);
    expect(JSON.stringify(recorder.events)).not.toMatch(/fake-secret-canary|fake-private|billing\.invalid/);
    expect(errors[0]).not.toHaveProperty("setup");
  });

  it.each(["success", "unmatched"])("Fuigo observations never turn %s into a terminal error", async variant => {
    await create(FuigoDiagnosticDriver, `fuigo-diagnostic:${variant}`);
    await instance.adapter.sendTurn({ threadId: "t-fuigo-observation", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.some(event => event.type === "runtime.error")).toBe(false);
  });

  it.each(["initialize", "authenticate", "session/new", "session/load", "session/prompt", "session/set_mode", "session/set_model", "session/set_config_option"])("allows only known ACP diagnostic method %s", (acpMethod) => {
    expect(acpRpcErrorDetails({ acpMethod, code: -32603 })).toBe(`ACP request: ${acpMethod}\nEngine error code: -32603`);
  });

  it("omits arbitrary method strings and invalid numeric diagnostic fields", () => {
    for (const acpMethod of ["https://billing.invalid/?key=fake-secret-canary", "session/prompt\nfake-secret-canary", "unknown", 123, null]) {
      expect(acpRpcErrorDetails({ acpMethod, code: -32603 })).toBe("Engine error code: -32603");
    }
    for (const code of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "-32603"]) {
      expect(acpRpcErrorDetails({ code })).toBeUndefined();
    }
    for (const http_status of [99, 600, 500.5, NaN, "500"]) {
      expect(acpRpcErrorDetails({ data: { http_status } })).toBeUndefined();
    }
  });

  it("reads the engine's own error text from Fuigo 1.0.18 object data and Fuigo 1.0.17 string data", () => {
    const text = "empty response from model (reasoning_only): model=fixture-model, had_reasoning=true, finish_reason=stop";
    expect(acpEngineErrorText({ message: text, error_kind: "empty_response" })).toBe(text);
    expect(acpEngineErrorText("No response from model for 90s — the model may be stuck")).toBe("No response from model for 90s — the model may be stuck");
  });

  it("never shows raw JSON, non-text data or an empty engine message", () => {
    for (const data of [undefined, null, 42, true, [], ["fake-private-response"], {}, { detail: "fake-private-response" }, { message: 7 }, { message: "   " }, "", "\u0007\u001b[0m",
      '{"error":{"message":"fake-private-response"}}', '[{"fake":"private-response"}]']) {
      expect(acpEngineErrorText(data)).toBeUndefined();
    }
    expect(acpEngineErrorText({ message: 'upstream 500: {"error":{"message":"fake-private-response"}}' })).toBe("upstream 500");
  });

  it("strips control characters, links and secrets from engine error text and caps its length", () => {
    expect(acpEngineErrorText("\u001b[31mfailed\u001b[0m\r\n\tat\u0000 step\u202e two")).toBe("failed at step two");
    expect(acpEngineErrorText("see https://billing.invalid/?key=fake-secret-canary now")).toBe("see [link removed] now");
    expect(acpEngineErrorText(`key sk-test-${"SYNTHETICKEYCANARY".repeat(2)}`)).toMatch(/^key «redacted \d+ chars»$/);
    const long = acpEngineErrorText({ message: "word ".repeat(400) })!;
    expect(long.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
    expect(long.endsWith("…")).toBe(true);
  });

  // The transcript stores a failed turn as `error: <message>` with the message
  // cut at ERROR_MESSAGE_MAX, and the card shows exactly that. Engine text
  // longer than that budget was cut there mid-word with no ellipsis.
  it("ends engine text on a word inside the transcript's own message limit", () => {
    const long = acpEngineErrorText({ message: "word ".repeat(40) })!;
    expect(long.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
    expect(long.endsWith("word…")).toBe(true);
    const unbroken = acpEngineErrorText({ message: "x".repeat(400) })!;
    expect(unbroken.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
    expect(unbroken.endsWith("…")).toBe(true);
  });

  // A hard cut at ERROR_MESSAGE_MAX lands wherever the character happens to be:
  // half of a surrogate pair renders as a replacement glyph, so an unbroken
  // astral token is cut before it, never through it.
  const loneSurrogate = (text: string) =>
    [...text].some((ch) => ch.length === 1 && ch.codePointAt(0)! >= 0xd800 && ch.codePointAt(0)! <= 0xdfff);

  it.each([
    ["an unbroken run of astral characters", "\u{1f642}".repeat(200)],
    ["one word ending in an astral character astride the limit", `${"x".repeat(155)}\u{1f642}\u{1f642}\u{1f642}`],
    ["a musical-symbol run", "\u{1d11e}".repeat(200)],
  ])("cuts %s on a code-point boundary", (_shape, message) => {
    const text = acpEngineErrorText(message)!;
    expect(text.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
    expect(text.endsWith("\u2026")).toBe(true);
    expect(loneSurrogate(text)).toBe(false);
  });

  // A scheme is not what makes a locator dangerous: an engine writes
  // `host/path?api_key=…` and `user:pass@host` as readily as an https:// URL,
  // and both carry the credential into the transcript.
  it("strips credential-bearing locators that carry no scheme", () => {
    expect(acpEngineErrorText("upstream api.internal.invalid/v1/chat?api_key=fake-secret-canary rejected the call"))
      .toBe("upstream [link removed] rejected the call");
    expect(acpEngineErrorText("proxy fixtureuser:fakepass@proxy.internal.invalid:8080 refused the connection"))
      .toBe("proxy [link removed] refused the connection");
    expect(acpEngineErrorText("empty response from model (reasoning_only): model=fixture-model, finish_reason=stop"))
      .toBe("empty response from model (reasoning_only): model=fixture-model, finish_reason=stop");
  });

  // A locator is dangerous because of what it can carry, not because it has a
  // scheme — but "has a dot and a slash" describes a source path as often as a
  // host, and replacing real diagnostic prose with "[link removed]" makes an
  // error less useful. Both halves of that line are pinned here.
  it.each([
    ["scheme-bearing link", "see https://billing.invalid/?key=fake-secret-canary now", "see [link removed] now"],
    ["query that names a value", "upstream api.internal.invalid/v1/chat?api_key=fake-secret-canary rejected the call", "upstream [link removed] rejected the call"],
    ["two-label host with a token query", "gateway internal.invalid:8443/v1?token=fake-secret-canary refused", "gateway [link removed] refused"],
    ["credentials before a dotted host", "proxy fixtureuser:fakepass@proxy.internal.invalid:8080 refused the connection", "proxy [link removed] refused the connection"],
    ["credentials before a dotless host with a path", "login fixtureuser:fakepass@gateway/admin failed", "login [link removed] failed"],
    ["deep host with a plain path", "fetch cdn.assets.internal.invalid/bundle.js timed out", "fetch [link removed] timed out"],
    // A self-hosted provider (Ollama, vLLM, LM Studio on a LAN address) is
    // addressed by IP literal, so an authority with credentials in front of
    // one is exactly where a password reaches the transcript — and from there
    // `tool.name`, `tool.errorDetails` and messages.db. No dotted TLD and no
    // letters: the dotted-host rules cannot see it.
    ["credentials before an IPv4 authority", "dial fixtureuser:fakepass@10.1.2.3:8443/v1 failed", "dial [link removed] failed"],
    ["credentials before an IPv4 authority with no port", "dial fixtureuser:fakepass@10.1.2.3/v1 failed", "dial [link removed] failed"],
    ["credentials before a bracketed IPv6 authority", "dial fixtureuser:fakepass@[fe80::1]:8443/v1 failed", "dial [link removed] failed"],
    // A query that names a value carries one whatever the host looks like.
    // `?api_key=` and `?token=` were caught by the secret-name pass, so only
    // the hosts with no alphabetic TLD and the plainest key name were left.
    ["value-bearing query on an IPv4 host", "dial 10.1.2.3:8443/v1?key=fake-secret-canary failed", "dial [link removed] failed"],
    ["value-bearing query on a dotless host", "dial localhost:11434/api/chat?key=fake-secret-canary failed", "dial [link removed] failed"],
    ["value-bearing query on a bracketed IPv6 host", "dial [fe80::1]:8443/v1?key=fake-secret-canary failed", "dial [link removed] failed"],
  ])("removes a credential-bearing locator written as a %s", (_shape, message, expected) => {
    expect(acpEngineErrorText(message)).toBe(expected);
  });

  it.each([
    ["a source path with a line and a column", "guard missing at src/drivers/acp/core.ts:93/foo"],
    ["an ordinary key:value@thing pair", "queued as retry:2@worker for the next attempt"],
    ["a sentence ending in a filename", "the engine never wrote config.json?"],
    ["a rate written as a fraction", "gave up after 15 retries at 1.5s/attempt"],
    ["Fuigo's own empty-reply detail", "empty response from model (reasoning_only): model=fixture-model, finish_reason=stop"],
    // An address carries a credential only when something in it is one: a
    // bare listen address is the most useful line in a local-engine failure.
    ["a bare IPv4 listen address", "engine bound to 127.0.0.1:11434 and stopped responding"],
    ["a bare IPv6 listen address", "engine bound to [::1]:11434 and stopped responding"],
    ["a counter written like an authority", "gave up at attempt:3@10 per minute"],
    ["a question about a setting", "did the engine send model=fixture? retry to find out"],
    ["a filename before a question", "the engine wrote no config.json? check the folder"],
    // A query is only a locator's query when something in front of it is a
    // HOST. An engine writes `setting?name=value` about its own options far
    // more often than it writes a bare label with a credential on it, and a
    // rule anchored to any two-character token blanks the prose instead.
    ["a setting written like a query", "the engine ignored mode?retry=true and gave up"],
    ["a tool named after a question mark", "did it use tool?name=shell for that step"],
  ])("keeps diagnostic prose that only looks like a locator: %s", (_shape, message) => {
    expect(acpEngineErrorText(message)).toBe(message);
  });

  // Sanitising can consume the whole line: 300 full stops are cut to the
  // length cap and then stripped as trailing punctuation, and a message that
  // is nothing but a link becomes the substitution marker. Either way the card
  // would show less than the RPC's own message did, so nothing is reported and
  // the caller keeps that message.
  it.each([
    ["a line of punctuation past the length cap", ".".repeat(300)],
    ["a message that is only a link", "https://billing.invalid/?t=abc"],
    ["a message that is only a credential", `sk-test-${"SYNTHETICKEYCANARY".repeat(2)}`],
  ])("reports no engine text when sanitising leaves only an artefact: %s", (_shape, message) => {
    expect(acpEngineErrorText(message)).toBeUndefined();
  });

  it("keeps engine text that still says something around the artefact", () => {
    expect(acpEngineErrorText("see https://billing.invalid/?t=abc now")).toBe("see [link removed] now");
    expect(acpEngineErrorText("\u{1f642}\u{1f642}\u{1f642}")).toBe("\u{1f642}\u{1f642}\u{1f642}");
  });

  // The exit line has no fallback text: where `error.data` falls back to the
  // JSON-RPC message when sanitising leaves nothing (core.ts `engineText ??
  // message`), a crash has only its stderr. So the rule MU-R4-4 set for
  // `error.data` — if the sanitised text carries no information, keep the
  // base message — needs a base to keep here, and structured JSON logging on
  // stderr is how ordinary CLI agents write. Without a floor the card renders
  // a bare "<engine> exited N before the prompt result": the
  // generic-error-with-no-explanation this whole change exists to remove.
  it("still quotes a reason when the engine logs its stderr as JSON", () => {
    const record = '{"time":"2026-09-16T03:14:15Z","level":"error","msg":"model load failed"}';
    expect(acpEngineExitStderrText(record)).toContain("model load failed");

    const ndjson = Array.from(
      { length: 60 },
      (_, i) => `{"time":"2026-09-16T03:14:${String(i % 60).padStart(2, "0")}Z","level":"debug","msg":"plugin ${i} registered"}`,
    ).join("\n");
    // A reason at all is what this item owns; which end of a long log the
    // card quotes is the next test's.
    expect(acpEngineExitStderrText(`${ndjson}\nFATAL: model handshake failed`)).toMatch(/\w/);
  });

  // The floor is a floor, not a hole: it keeps the JSON a log line is made of,
  // and nothing else about sanitising changes.
  it("sanitises the JSON it falls back to", () => {
    const text = acpEngineExitStderrText('{"msg":"auth refused","url":"https://billing.invalid/?key=fake-secret-canary"}')!;
    expect(text).toContain("auth refused");
    expect(text).toContain("[link removed]");
    for (const leaked of ["billing.invalid", "fake-secret-canary", "https://"]) expect(text, leaked).not.toContain(leaked);
  });

  // An ordinary one-line stderr still reads exactly as the engine wrote it.
  it("keeps an ordinary stderr line as written", () => {
    expect(acpEngineExitStderrText("fake-acp: simulated prompt exit\n")).toBe("fake-acp: simulated prompt exit");
  });

  // Which END of a crash's stderr the card quotes. The ring holds up to
  // 8 KiB and the display budget is 160 characters — so the line that
  // survives must be cut from the TAIL of the sanitised text, not its front,
  // or the fatal last line of a noisy engine is kilobytes out of frame and
  // the card quotes plugin-loading chatter instead. Both shapes end the same
  // way and neither has a word of it in the first 160 characters.
  it.each([
    ["a noisy engine", () => Array.from({ length: 200 }, (_, i) => `[warn] plugin ${i} loaded from cache with no manifest`).join("\n"), "FATAL: engine could not open the model file: permission denied"],
    ["an engine that logs JSON", () => Array.from({ length: 60 }, (_, i) => `{"time":"2026-09-16T03:14:${String(i % 60).padStart(2, "0")}Z","level":"debug","msg":"plugin ${i} registered"}`).join("\n"), "FATAL: model handshake failed"],
  ])("quotes the last lines of %s, where the fatal one is", (_shape, noise, fatal) => {
    const text = acpEngineExitStderrText(`${noise()}\n${fatal}\n`)!;
    expect(text.endsWith(fatal)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
    expect(text.startsWith("\u2026")).toBe(true);
  });

  // The tail cut lands on a code-point boundary too: an unbroken astral run
  // has no space to cut at from either end.
  it("cuts the tail of an unbroken astral stderr line on a code-point boundary", () => {
    const text = acpEngineExitStderrText("\u{1f642}".repeat(2000))!;
    expect(text.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
    expect(text.startsWith("\u2026")).toBe(true);
    expect(loneSurrogate(text)).toBe(false);
  });

  // Nothing cuts UNREDACTED text. Round 7 cut a crash dump written as one
  // long line from the TAIL before redacting it, which threw away the half
  // of `api_key="…"` that NAMES the credential; `redactSecretsInText` then
  // saw a bare value, masked nothing, and the key itself reached the card,
  // the transcript row, `tool.errorDetails` and, through them, messages.db.
  // The assertion is the dangerous substring's ABSENCE: a mask appearing
  // somewhere else in the line would not prove the key is gone.
  it.each([
    ["a JSON auth record", (key: string) => `booting\n{"event":"auth_failed","status":401,"api_key":"${key}"}\n`],
    ["a key=value line", (key: string) => `engine request failed: api_key=${key}`],
    ["a bearer header", (key: string) => `auth header rejected: Bearer ${key}`],
    ["a bare provider key", (key: string) => `startup: sk-live-${key}`],
    ["a query parameter", (key: string) => `GET /v1?token=${key}`],
  ])("never prints the credential of a long one-line crash dump written as %s", (_shape, dump) => {
    const key = "SYNTHETICKEYCANARY".repeat(250);
    const text = acpEngineExitStderrText(dump(key));
    expect(typeof text).toBe("string");
    expect(text).not.toContain("SYNTHETICKEYCANARY");
  });

  // The JSON rule cuts the text where a record starts, and on the exit path
  // everything after that point is the rest of the crash — including the line
  // that says why. MU-R7-1's floor only catches the case where NOTHING
  // survives the cut: a single line of start-up chatter in front of the first
  // record satisfies it, and the card then quotes the chatter as the reason.
  // A confident wrong reason is worse than the bare line the floor removed.
  it.each([
    [
      "a fatal line after a debug record",
      '[warn] started\n{"level":"debug","msg":"loading model weights"}\nFATAL: engine could not open the model file: permission denied',
      "FATAL: engine could not open the model file: permission denied",
    ],
    [
      "a fatal record after a prose line",
      'Loading model...\n{"level":"fatal","msg":"CUDA out of memory"}',
      '{"level":"fatal","msg":"CUDA out of memory"}',
    ],
    [
      "an error record after a prose line",
      'starting up\n{"level":"error","msg":"model load failed: no such file"}',
      '{"level":"error","msg":"model load failed: no such file"}',
    ],
    // The question is what the cut ACTUALLY discards, so it is asked of the
    // text the cut sees: an invisible control between the brace and the key
    // hides the record from a test run against the raw tail, and the prose
    // in front of it would again be quoted as the reason.
    [
      "a record opened through an invisible control",
      'starting up\n{\u200b"level":"error","msg":"model load failed"}',
      '{ "level":"error","msg":"model load failed"}',
    ],
  ])("keeps the reason a crash ends with when prose precedes it: %s", (_shape, stderr, ending) => {
    const text = acpEngineExitStderrText(`${stderr}\n`)!;
    expect(text.slice(-ending.length)).toBe(ending);
  });

  // The locator pass is quadratic in the length of its input: LOCATORS[0]
  // (`scheme://…`) walks a dotted run forward from every position, fails to
  // find `://`, and backtracks over it. Measured on this file's own
  // `acpEngineErrorText` as round 8 shipped it — 16 KiB 85 ms,
  // 64 KiB 1 272 ms, 128 KiB 8 186 ms, and minutes at 1 MiB. The text is
  // `error.data.message` / the JSON-RPC `error.message` off a frame bounded
  // only by ENGINE_FRAME_MAX_BYTES (32 MiB), sanitised SYNCHRONOUSLY on the
  // server's single event loop, so one large — or merely hostile — provider
  // error body freezes every room in the app for as long as it takes. No
  // correctness assertion can see that, so this test is a clock. Round 9
  // answered it with a bound in front of the locators; round 10 removed the
  // bound (it cut unredacted text) and made the locator linear instead, and
  // the round-10 block below clocks every other hostile shape as well.
  it.each([
    ["16 KiB", 16],
    ["64 KiB", 64],
    ["128 KiB", 128],
  ])("sanitises %s of unbroken dotted text in well under a tenth of a second", (_size, kib) => {
    const hostile = "a.".repeat((kib as number) * 512);
    // CPU time, not wall time: on this Mac under a load average of 118 the
    // wall clock read 15 times the CPU clock, and a clock that fails for
    // reasons that are not the code's is one that gets ignored. A quadratic
    // pass is seconds of CPU whatever else is running.
    const started = process.cpuUsage();
    acpEngineErrorText(hostile);
    const used = process.cpuUsage(started);
    expect((used.user + used.system) / 1000).toBeLessThan(100);
  });

  // The half of `api_key=<value>` that NAMES the credential has to reach
  // `redactSecretsInText` together with the value, which is the property
  // MU-R8-1 took the old pre-redaction tail cut out for. A bound that took
  // the last N characters before redacting would leak here; since round 10
  // nothing is cut before redaction at all. The assertion is the dangerous
  // substring's ABSENCE.
  it.each([
    ["a credential straddling the window", `${"filler ".repeat(20)}api_key=${"SYNTHETICKEYCANARY".repeat(400)}`],
    ["a credential with no whitespace anywhere", `api_key=${"SYNTHETICKEYCANARY".repeat(400)}`],
    ["a bare provider key", `startup: sk-live-${"SYNTHETICKEYCANARY".repeat(400)}`],
  ])("bounds its input without orphaning a credential value: %s", (_shape, message) => {
    for (const keep of ["head", "tail"] as const) {
      const text = acpEngineErrorText(message, { keep });
      expect(typeof text, keep).toBe("string");
      expect(text, keep).not.toContain("SYNTHETICKEYCANARY");
    }
  });

  // The exit path never cuts at a JSON record. Rounds 8 and 9 chose between
  // the `cut` and `keep` forms with a predicate asked of the text the cut
  // would search — `stripVTControlCharacters` is NOT idempotent, and asked of
  // once-stripped text the predicate missed records the second strip
  // revealed, so the prose in front of a record was quoted as the reason
  // with the record thrown away. Round 10 observed that a cut which discards
  // nothing IS the keep form, so the path asks for `keep` outright; these
  // shapes pin that the record and the prose both survive. Round 11 removed
  // the exit path's own strip — the second pass ate the first letter of a
  // credential's name (see the escape-laden differential rows above) — so
  // the renderings are of the once-stripped text: the lone ESC becomes a
  // space and the `A` after the reset sequence stays, as the shipped
  // release rendered it. These are test artefacts of the strip, not
  // product requirements.
  const ESC = "\u001b";
  it.each([
    ["a bare brace and key", `\n0b{ ${ESC}${ESC}[0mA"`, `0b{ A"`],
    [
      "a fatal record behind one line of start-up prose",
      `Loading model...\n{${ESC}${ESC}[0mA"level":"fatal","msg":"CUDA out of memory"}`,
      `Loading model... { A"level":"fatal","msg":"CUDA out of memory"}`,
    ],
    [
      "an error record behind one line of start-up prose",
      `starting up\n{${ESC}${ESC}[0mA"level":"error","msg":"model load failed: no such file"}`,
      `starting up { A"level":"error","msg":"model load failed: no such file"}`,
    ],
  ])("keeps a record behind one line of prose, rather than quoting the prose as the reason: %s", (_shape, stderr, expected) => {
    expect(acpEngineExitStderrText(stderr)).toBe(expected);
  });


  it("names a well-formed engine error kind in the technical details and drops any other", () => {
    expect(acpRpcErrorDetails({ acpMethod: "session/prompt", code: -32603, data: { message: "fixture", error_kind: "empty_response" } }))
      .toBe("ACP request: session/prompt\nEngine error kind: empty_response\nEngine error code: -32603");
    for (const error_kind of ["Empty", "empty response", "http\nEngine error code: 1", "x".repeat(65), 5, null]) {
      expect(acpRpcErrorDetails({ code: -32603, data: { message: "fixture", error_kind } })).toBe("Engine error code: -32603");
    }
    expect(acpRpcErrorDetails({ code: -32603, data: "error_kind: auth" })).toBe("Engine error code: -32603");
  });

  it("redacts PEM before stderr windows, including an unfinished bounded capture", () => {
    const payload = "QUJDREVGUEVNU0VDUkVUUEFZTE9BRENBTkFSWQ==";
    const key = `-----BEGIN PRIVATE KEY-----\n${`${payload}\n`.repeat(256)}-----END PRIVATE KEY-----\nfatal: engine stopped`;
    // Original multiline failure: dropping one line from a headerless ring still exposes the rest.
    const oldRing = key.slice(-8192);
    expect(redactSecretsInText(stripVTControlCharacters(oldRing)).split(/\r?\n/).slice(1).join("\n")).toContain(payload);
    for (const raw of [key, `-----BEGIN PRIVATE KEY-----\n${`${payload}\n`.repeat(10000)}`]) {
      const truncated = raw.length > 256 * 1024;
      const capture = acpEngineStderrCapture(raw.slice(0, 256 * 1024), truncated);
      const persisted = redactSecretsInText(stripVTControlCharacters(capture));
      const card = acpEngineExitStderrText(capture);
      expect(persisted).not.toContain(payload);
      expect(card).not.toContain(payload);
      if (truncated) {
        expect(persisted).toContain("Stderr capture truncated; later output omitted");
        expect(card).toContain("Stderr capture truncated; later output omitted");
      } else {
        expect(persisted).toContain("fatal: engine stopped");
        expect(card).toContain("fatal: engine stopped");
      }
    }
    expect(acpEngineStderrCapture("fatal: ordinary crash", false)).toBe("fatal: ordinary crash");
  });

  it("omits a cap-cut final raw line but retains a complete newline boundary", () => {
    const fragment = "unrecognized-sensitive-fragment";
    const partial = acpEngineStderrCapture(`complete diagnostic\n${fragment}`, true);
    expect(redactSecretsInText(stripVTControlCharacters(partial))).not.toContain(fragment);
    expect(acpEngineExitStderrText(partial)).not.toContain(fragment);
    expect(partial).toContain("complete diagnostic");
    expect(partial).toContain("Stderr capture truncated; later output omitted");
    expect(acpEngineStderrCapture("complete diagnostic\n", true)).toContain("complete diagnostic\n");
    expect(acpEngineStderrCapture(fragment, true)).not.toContain(fragment);
  });

  it.each([
    ["object", "empty response from model (reasoning_only): model=fixture-model, had_reasoning=true, finish_reason=stop", "ACP request: session/prompt\nEngine error kind: empty_response\nEngine error code: -32603"],
    ["string", "No response from model for 90s — the model may be stuck", "ACP request: session/prompt\nEngine error code: -32603"],
  ])("shows the engine's %s error data as the failure message", async (shape, message, details) => {
    await create(GrokAgentDriver, `engine-error-data:${shape}`);
    await instance.adapter.sendTurn({ threadId: `t-engine-error-${shape}`, text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(recorder.events.filter(event => event.type === "runtime.error")).toEqual([expect.objectContaining({ message, details })]);
  });

  // The kind travels as its own event field, decided by the driver from
  // `error.data.error_kind`. Nothing downstream reads it out of text the
  // engine wrote, so an engine cannot name a kind in prose and be believed.
  it("reports the engine's typed kind as its own event field, and none for a malformed one", async () => {
    await create(GrokAgentDriver, "engine-error-data:object");
    await instance.adapter.sendTurn({ threadId: "t-engine-error-kind", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(recorder.events.filter(event => event.type === "runtime.error")).toEqual([expect.objectContaining({ errorKind: "empty_response" })]);
  });

  it("sanitises hostile engine error data before it reaches the transcript", async () => {
    await create(GrokAgentDriver, "engine-error-data:hostile");
    await instance.adapter.sendTurn({ threadId: "t-engine-error-hostile", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "rpc_error" });
    const errors = recorder.events.filter(event => event.type === "runtime.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: expect.stringMatching(/^upstream failed at \[link removed\] via \[link removed\] with «redacted \d+ chars»$/),
      details: "ACP request: session/prompt\nEngine error code: -32603",
    });
    expect(JSON.stringify(recorder.events)).not.toMatch(/fake-secret-canary|billing\.invalid|proxy\.invalid|proxyuser|fake-private|SYNTHETICKEYCANARY|\\u001b/);
  });

  // `error.data.message` is sanitised hard, but the JSON-RPC `error.message`
  // is engine-controlled in exactly the same way and lands on the same card
  // (and in messages.db) — so it goes through the same sanitiser. An ordinary
  // failure line must read exactly as it did.
  it("sanitises the engine's JSON-RPC error message the same way as its error data", async () => {
    await create(GrokAgentDriver, "engine-error-message:hostile");
    await instance.adapter.sendTurn({ threadId: "t-engine-error-message", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "rpc_error" });
    const errors = recorder.events.filter(event => event.type === "runtime.error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("upstream failed at [link removed] via [link removed]");
    expect(errors[0].details).toBe("ACP request: session/prompt\nEngine error code: -32603");
    expect(JSON.stringify(recorder.events)).not.toMatch(/fake-secret-canary|billing\.invalid|proxy\.invalid|proxyuser|\\u001b/);
  });

  it("leaves an ordinary engine failure line exactly as the engine wrote it", async () => {
    await create(GrokAgentDriver, "engine-error-message:plain");
    await instance.adapter.sendTurn({ threadId: "t-engine-error-plain", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(recorder.events.filter(event => event.type === "runtime.error"))
      .toEqual([expect.objectContaining({ message: "fixture provider rejected the request" })]);
  });

  it.each(["initialize", "session/new", "session/prompt"])("correlates failed %s through the CLI without exposing provider data", async (method) => {
    await create(GrokAgentDriver, `rpc-error:${method}`);
    await instance.adapter.sendTurn({ threadId: "t-rpc-diagnostics", text: "fake-private-request" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "rpc_error" });
    const errors = recorder.events.filter(event => event.type === "runtime.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "fixture provider failure [link removed]", details: `ACP request: ${method}\nProvider response: HTTP 500\nEngine error code: -32603` });
    expect(errors[0].diagnostic).toMatchObject({version:1,diagnosticId:errors[0].eventId,turnId:errors[0].turnId,method,rpcCode:-32603,httpStatus:500});
    expect(JSON.stringify(recorder.events)).not.toMatch(/fake-private|fake-secret-canary|billing\.invalid|session\/cancel/);
  });

  it("ignores an unmatched RPC error without attributing it to the pending prompt", async () => {
    await create(GrokAgentDriver, "unknown-rpc-error");
    await instance.adapter.sendTurn({ threadId: "t-unknown-rpc-error", text: "fixture only" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.some(event => event.type === "runtime.error")).toBe(false);
    expect(JSON.stringify(recorder.events)).not.toContain("fake-secret-canary");
  });

  it("does not expose unknown nested ACP error data or misclassify another HTTP status", () => {
    expect(acpRpcErrorMessage({ message: "Internal error", data: { http_status: 500, message: "credit balance is exhausted fake-secret-canary" } })).toBe("Internal error");
    expect(acpRpcErrorMessage({ data: { http_status: 402, message: "unknown provider response fake-secret-canary" } })).toBe("Your model provider rejected this request with HTTP 402. Check its billing and account access; this response does not establish that credits are exhausted.");
    expect(acpRpcErrorMessage({ message: "Authentication required", data: { token: "fake-secret-canary" } })).toBe("Authentication required");
    expect(acpRpcErrorMessage({ message: "Internal error", data: { http_status: 402, message: "Your credit balance is exhausted. Top up at https://fluxrouter.ai/home/billing?token=fake-secret-canary" } })).toBe("Flux Router is out of credits. Add credits in Flux Router, then retry—or choose another configured provider.");
    expect(acpRpcErrorMessage({ message: "Internal error", data: { http_status: 402, message: "Your credit balance is exhausted. https://fluxrouter.ai.evil.invalid/" } })).not.toContain("Flux Router is out of credits");
  });

  // The exact wrapper Fuigo 1.0.20 produced against a live capped Flux Router
  // account on 2026-09-20. Before this, it read as a generic HTTP 402 and the
  // transcript carried the engine's own sentence, sum and support address.
  it("answers a monthly spending limit without the credits advice the provider contradicts", () => {
    const capped = "API error (status 402 Payment Required): This account has reached its $10.00 monthly spend ceiling. The ceiling rises automatically as your account builds payment history — adding credit will not lift it. Email support@fluxrouter.ai if you need it raised sooner.";
    const message = acpRpcErrorMessage({ message: "Internal error", data: { http_status: 402, message: capped } });
    expect(message).toBe("Your Flux Router account has reached its monthly spending limit. Adding credit will not lift it; ask Flux Router to raise it, or use another engine.");
    expect(message.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
    expect(message).not.toMatch(/\$10|support@|Add credits in/);
    // Without a fluxrouter.ai locator the limit is still recognised, but the
    // provider is not named on the strength of provider prose alone.
    const bare = acpRpcErrorMessage({ message: "Internal error", data: { http_status: 402, message: "account_monthly_budget_exhausted" } });
    expect(bare).toBe("This account has reached its monthly spending limit with the model provider. Adding credit will not lift it — ask them to raise it, or use another engine.");
    expect(bare.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
    // A ceiling is not an exhausted balance: the credits copy must not move.
    expect(acpRpcErrorMessage({ message: "Internal error", data: { http_status: 402, message: "Your credit balance is exhausted. https://fluxrouter.ai/home/billing" } })).toContain("Add credits in Flux Router");
  });

  it("selectModel confirms the requested model before prompting", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-model", text: "go", model: "m-two" });

    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ model: "m-two" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("a model the session does not advertise fails the turn instead of running another", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-bad-model", text: "go", model: "m-nope" });

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/model not found/);
    // nothing was generated: the prompt is never sent
    expect(recorder.events.some((e) => e.type === "content.delta")).toBe(false);
  });

  // The unadvertised-model test above rides the fake's -32602, so it settles in
  // `request()` and never reaches the guard. This one is the silent case the
  // guard was written for: the agent acknowledges the switch and keeps its old
  // model, which no error surfaces.
  it("a model switch acknowledged but not applied fails the turn", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    process.env.FAKE_ACP_MODEL_STICKS = "1";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({ threadId: "t-stuck-model", text: "go", model: "m-two" });

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/did not switch to m-two \(still m-one\)/);
    // the whole point: no paid turn is spent on the wrong model
    expect(recorder.events.some((e) => e.type === "content.delta")).toBe(false);
  });

  it("selects the model on a resumed session too, not just a new one", async () => {
    process.env.FAKE_ACP_MODELS = "m-one,m-two";
    await create(SelectModelDriver);
    await instance.adapter.sendTurn({
      threadId: "t-resume-model",
      text: "go",
      model: "m-two",
      // deliberately NOT "fake-acp-session", the id session/new returns: with
      // that cursor a session/load that threw and fell back to session/new
      // would emit the same sessionId and this test could not fail
      resumeCursor: "resumed-thread-1",
    });

    // session/load feeds the same sessionResult as session/new, so the model
    // hook must fire on a resumed thread as well
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "resumed-thread-1", model: "m-two" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  // A resumed thread whose session the agent has forgotten. session/load
  // SUCCEEDS -- it just answers null -- so the catch below it never runs, and
  // before the guard the driver kept the dead cursor, skipped session/new and
  // prompted a session that no longer existed. The fresh id is the assertion:
  // "gone-cursor" would come back as the sessionId if the guard were removed.
  it("falls through to session/new when session/load answers null", async () => {
    process.env.FAKE_ACP_LOAD_NULL = "1";
    await create(GrokAgentDriver);
    await instance.adapter.sendTurn({
      threadId: "t-resume-null",
      text: "go",
      resumeCursor: "gone-cursor",
      transcript: [{ role: "user", text: "Authorized prior history" }],
    });

    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "fake-acp-session" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("applyTurnEnv sees the picker model after resolveTurnModel", async () => {
    const dump = join(scratch, "turn-env.json");
    process.env.FAKE_ACP_DUMP = dump;
    const TurnEnvDriver = createAcpDriver({
      ...SELECT_MODEL_SUPPORT,
      driverKind: "turnEnvTest",
      selectModel: undefined,
      resolveTurnModel: (model) => (model ? `resolved/${model}` : model),
      applyTurnEnv: (env, { model, requestedModel }) => {
        env.TEST_TURN_MODEL = `${model ?? ""}|${requestedModel ?? ""}`;
      },
    });
    instance = await TurnEnvDriver.create({
      instanceId: "turn-env-test",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "t-turn-env",
      text: "go",
      model: "ollama::ornith:35b-bf16",
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).env.TEST_TURN_MODEL).toBe(
      "resolved/ollama::ornith:35b-bf16|ollama::ornith:35b-bf16",
    );
  });

  it("transformEnv sees the instance config", async () => {
    const dump = join(scratch, "policy.json");
    process.env.FAKE_ACP_DUMP = dump;
    instance = await EnvPolicyDriver.create({
      instanceId: "policy-test",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-policy", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).env.TEST_POLICY).toBe("auto");
  });

  it("declares effort levels for Grok only", async () => {
    await create(GrokAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toEqual(["low", "medium", "high"]);

    await create(GeminiAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toBeUndefined();

    await create(KimiAgentDriver);
    expect(instance.adapter.capabilities.effortLevels).toBeUndefined();
  });

  it("passes effort to Grok, and omits the flag when unset", async () => {
    const withEffort = join(scratch, "grok-effort.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = withEffort;
    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "high" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(withEffort, "utf8"));
    expect(seen.argv).toContain("--reasoning-effort");
    expect(seen.argv[seen.argv.indexOf("--reasoning-effort") + 1]).toBe("high");

    const without = join(scratch, "grok-no-effort.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = without;
    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(JSON.parse(readFileSync(without, "utf8")).argv).not.toContain("--reasoning-effort");
  });

  it("puts Grok -m after agent so ACP stdio binds the local slug", async () => {
    const dump = join(scratch, "grok-argv-order.json");
    await create(GrokAgentDriver);
    process.env.FAKE_ACP_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-argv", text: "hi", model: "grok-4.5", effort: "high" });
    await recorder.until((e) => e.type === "turn.completed");

    const argv = JSON.parse(readFileSync(dump, "utf8")).argv as string[];
    const agent = argv.indexOf("agent");
    const modelFlag = argv.indexOf("-m");
    const stdio = argv.indexOf("stdio");
    expect(agent).toBeGreaterThan(-1);
    expect(modelFlag).toBeGreaterThan(agent);
    expect(stdio).toBeGreaterThan(modelFlag);
    expect(argv[modelFlag + 1]).toBe("grok-4.5");
    expect(argv.indexOf("--reasoning-effort")).toBeGreaterThan(agent);
    expect(argv.indexOf("--permission-mode")).toBeLessThan(agent);
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
    const scratch = mkdtempSync(join(tmpdir(), "murage-kimi-auth-"));
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
      await removeTempDir(scratch);
    }
  });

  it("droid resolves the signed-in CLI before falling back to FACTORY_API_KEY", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-droid-auth-"));
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
      await removeTempDir(scratch);
    }
  });

  it("droid reads custom models, favourites order, and the configured default", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-droid-models-"));
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
        { id: "custom:Azure-Opus-0", label: "Azure Opus", custom: true },
        { id: "custom:LMStudio-Qwen-0", label: "Qwen (local)", custom: true },
      ]);
      expect(instance.models.options.some((o) => o.id === "claude-opus-5")).toBe(true);
      expect(instance.models.default).toBe("custom:LMStudio-Qwen-0");
    } finally {
      await instance.dispose();
      await removeTempDir(scratch);
    }
  });

  it("droid falls back to the built-in catalog when settings.json is unreadable", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-droid-nosettings-"));
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
      await removeTempDir(scratch);
    }
  });

  it("kimi resolves default credentials from the child HOME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-kimi-home-"));
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
      await removeTempDir(scratch);
    }
  });

  it("awaits an async isAuthenticated", async () => {
    const instance = await AsyncAuthDriver.create({
      instanceId: "async-auth",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      // without the await this is a Promise: truthy, but not `true`
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
    }
  });
});

// A4: engine stdout is framed with a byte bound before any parse. One engine
// that sends an oversized frame fails its own turn and loses its child; a
// turn on another thread of the same instance completes normally.
describe("ACP bounded ingress (A4)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async () => {
    instance = await GrokAgentDriver.create({
      instanceId: "acp-bounded",
      displayName: "ACP Bounded",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };
  /** No event on the thread may carry the dropped frame's content. */
  const noLargePayload = (threadId: string) =>
    recorder.events.filter((e) => e.threadId === threadId).every((e) => JSON.stringify(e).length < 1024 * 1024);

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-acp-bounded-"));
  });
  afterEach(async () => {
    delete process.env.FAKE_ACP_PID_FILE;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("fails only the turn whose frame is over the limit, even when a clean result follows it", async () => {
    await create();
    const oversized = await instance.adapter.sendTurn({ threadId: "t-oversize", text: "__fixture_oversize_frame__" });
    const ordinary = await instance.adapter.sendTurn({ threadId: "t-ordinary", text: "hi" });
    const failed = await recorder.until((e) => e.type === "turn.completed" && e.turnId === oversized.turnId);
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === ordinary.turnId);

    expect(failed).toMatchObject({ ok: false, stopReason: "frame_too_large" });
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "runtime.error",
      threadId: "t-oversize",
      message: expect.stringMatching(/larger than 32 MiB/),
    }));
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "content.delta", threadId: "t-ordinary" }));
    expect(noLargePayload("t-oversize")).toBe(true);
    expect(recorder.events.filter((e) => e.type === "turn.completed" && e.turnId === oversized.turnId)).toHaveLength(1);
  });

  it("fails an unterminated oversized frame without waiting for a newline, and stops that child", async () => {
    const pidFile = join(scratch, "pid");
    process.env.FAKE_ACP_PID_FILE = pidFile;
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-open", text: "__fixture_oversize_open_frame__" });
    const failed = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(failed).toMatchObject({ ok: false, stopReason: "frame_too_large" });
    expect(noLargePayload("t-open")).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await expect.poll(() => processAlive(pid), { timeout: 5_000 }).toBe(false);
  });

  it("still carries a valid image frame at the 10 MiB image cap", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-large", text: "__fixture_large_frame__" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(done).toMatchObject({ ok: true });
    const image = recorder.events.find((e) => e.type === "item.completed" && e.itemType === "assistant_image");
    expect(image).toMatchObject({ threadId: "t-large", data: expect.any(String) });
    expect((image as { data: string }).data).toHaveLength(4 * Math.ceil((10 * 1024 * 1024) / 3));
  });
});

// Folder trust through Murage (0.1.52 FUIGOTRUST1). Fuigo 1.0.13 gates a
// folder's AGENTS.md / CLAUDE.md, .mcp.json, skills and hooks behind a trust
// decision it cannot ask for over Murage's piped spawn. The core decides
// BEFORE the spawn from the server's record or a question card, passes the
// decision as `--trust`, advertises `fuigo/folderTrust.interactive` and
// answers the engine's own request from the same decision. The fake reads
// ./AGENTS.md into its reply only when it was built trusted — the same
// session-build timing as the real engine.
describe("ACP folder trust (fake CLI in folder-trust mode)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let folder: string;
  let dump: string;
  const CANARY = "canary-say-the-word-pelican";

  const FolderTrustDriver = createAcpDriver({
    ...SELECT_MODEL_SUPPORT,
    driverKind: "folderTrustTest",
    selectModel: undefined,
    folderTrust: true,
    // Fuigo's shape: the flag rides argv, before the subcommand
    spawnArgs: (_config, _turn, ctx) => [...(ctx?.folderTrusted ? ["--trust"] : []), "agent", "stdio"],
  });

  const create = async (driver = FolderTrustDriver) => {
    process.env.FAKE_ACP_MODE = "folder-trust";
    process.env.FAKE_ACP_DUMP = dump;
    instance = await driver.create({
      instanceId: "acp-trust-test",
      displayName: "ACP Trust Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };
  const readDump = () => JSON.parse(readFileSync(dump, "utf8"));
  const assistantText = () =>
    recorder.events
      .filter((e): e is Extract<typeof e, { itemType: "assistant_text" }> => e.type === "item.completed" && (e as any).itemType === "assistant_text")
      .map((e) => e.text)
      .join("\n");
  const chips = () => recorder.events.filter((e) => e.type === "item.started").map((e) => (e as { title?: string }).title ?? "");
  const answer = (threadId: string, requestId: string, label: string) =>
    instance.adapter.respondToRequest(threadId, requestId, {
      behavior: "answer",
      message: label,
      answers: [{ id: "folderTrust", selected: [label] }],
    });

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-acp-trust-"));
    folder = join(scratch, "project");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "AGENTS.md"), `# project\n${CANARY}\n`);
    dump = join(scratch, "dump.json");
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("a remembered trusted folder never sees a card: --trust goes on argv, the capability is advertised, AGENTS.md is read", async () => {
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-trusted",
      text: "go",
      cwd: folder,
      folderTrust: { key: folder, folder, decision: "trust", sources: ["AGENTS.md"] },
    });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.find((e) => e.type === "request.opened")).toBeUndefined();
    expect(assistantText()).toContain(CANARY);
    const wire = readDump();
    expect(wire.argv).toEqual(["--trust", "agent", "stdio"]);
    expect(wire.initialize.clientCapabilities._meta).toEqual({ "fuigo/folderTrust": { interactive: true } });
    // the engine's store is trusted, so it never asked
    expect(wire.folderTrust).toMatchObject({ trustedAtBuild: true, requested: false });
    expect(chips()).toEqual([]);
  });

  it("no record: the card is raised BEFORE anything is spawned; Trust answers it, the engine starts with --trust and reads AGENTS.md", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-ask",
      text: "go",
      cwd: folder,
      folderTrust: { key: folder, folder, sources: ["AGENTS.md", ".mcp.json"] },
    });
    await recorder.until((e) => e.type === "turn.started");
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      turnId,
      requestType: "question",
      tool: "folder_trust",
      choices: ["Trust this folder", "Don't trust"],
      folderTrust: { key: folder, folder, sources: ["AGENTS.md", ".mcp.json"] },
      questions: [
        {
          id: "folderTrust",
          header: "Folder trust",
          multiSelect: false,
          allowOther: false,
          options: [{ label: "Trust this folder" }, { label: "Don't trust" }],
        },
      ],
    });
    expect((opened as any).questions[0].question).toContain(folder);
    expect((opened as any).questions[0].question).toContain("AGENTS.md, .mcp.json");
    // nothing has been spawned: no process, no argv dump
    expect(existsSync(dump)).toBe(false);
    expect(instance.adapter.hasSession("t-ask")).toBe(true);

    await expect(answer("t-ask", (opened as any).requestId, "Trust this folder")).resolves.toBe("answered");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "answer", source: "user" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(assistantText()).toContain(CANARY);
    expect(readDump().argv).toEqual(["--trust", "agent", "stdio"]);
    expect(chips()).toEqual([]);
    // exactly one turn.started for the whole turn, card included
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  });

  it("Don't trust: the engine starts without --trust, its own request is answered reject, the reply has no AGENTS.md, and a chip says what was withheld", async () => {
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-reject",
      text: "go",
      cwd: folder,
      folderTrust: { key: folder, folder, sources: ["AGENTS.md"] },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await expect(answer("t-reject", (opened as any).requestId, "Don't trust")).resolves.toBe("answered");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true, stopReason: null });
    expect(assistantText()).toBe("agents: withheld");
    expect(assistantText()).not.toContain(CANARY);
    const wire = readDump();
    expect(wire.argv).toEqual(["agent", "stdio"]);
    expect(wire.folderTrust).toMatchObject({ trustedAtBuild: false, interactive: true, requested: true });
    expect(wire.decision).toEqual({ outcome: "reject" });
    expect(chips()).toEqual(["untrusted folder: AGENTS.md"]);
    expect(recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "tool")).toMatchObject({ ok: true });
  });

  it("a remembered 'Don't trust' runs untrusted with the chip and no card", async () => {
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-remembered-reject",
      text: "go",
      cwd: folder,
      folderTrust: { key: folder, folder, decision: "reject", sources: ["AGENTS.md", "CLAUDE.md"] },
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.find((e) => e.type === "request.opened")).toBeUndefined();
    expect(assistantText()).toBe("agents: withheld");
    expect(readDump().decision).toEqual({ outcome: "reject" });
    expect(chips()).toEqual(["untrusted folder: AGENTS.md, CLAUDE.md"]);
  });

  it("a skipped card is an honest no-answer: the turn runs untrusted, nothing is remembered by the driver, the chip shows", async () => {
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-skip",
      text: "go",
      cwd: folder,
      folderTrust: { key: folder, folder, sources: ["AGENTS.md"] },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.respondToRequest("t-skip", (opened as any).requestId, { behavior: "deny" })).resolves.toBe("rejected");
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "user" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(assistantText()).toBe("agents: withheld");
    expect(readDump().decision).toEqual({ outcome: "reject" });
    expect(chips()).toEqual(["untrusted folder: AGENTS.md"]);
  });

  it("when the server's scan named nothing but the engine still asks, the card comes from the engine's own kinds and a late Trust is noted as applying next turn", async () => {
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-late",
      text: "go",
      cwd: folder,
      folderTrust: { key: folder, folder, sources: [] },
    });
    // no pre-spawn card: the spawn happened first (argv without --trust)
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(existsSync(dump)).toBe(true);
    expect(readDump().argv).toEqual(["agent", "stdio"]);
    expect(opened).toMatchObject({ requestType: "question", tool: "folder_trust", folderTrust: { sources: ["AGENTS.md / CLAUDE.md"] } });
    await expect(answer("t-late", (opened as any).requestId, "Trust this folder")).resolves.toBe("answered");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(readDump().decision).toEqual({ outcome: "trust" });
    // built untrusted, so this session's reply still lacks the instruction —
    // exactly what the chip says
    expect(assistantText()).toBe("agents: withheld");
    expect(chips()).toEqual(["trusted folder: AGENTS.md / CLAUDE.md"]);
  });

  it("nobody answers: the turn ends as a stopped turn (STOP2), not a hang and not a guess, with nothing spawned", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await create();
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "t-timeout",
        text: "go",
        cwd: folder,
        folderTrust: { key: folder, folder, sources: ["AGENTS.md"] },
      });
      const opened = recorder.events.find((e) => e.type === "request.opened");
      expect(opened).toMatchObject({ tool: "folder_trust" });
      vi.advanceTimersByTime(QUESTION_TIMEOUT_MS);
      const resolved = recorder.events.find((e) => e.type === "request.resolved");
      expect(resolved).toMatchObject({ behavior: "deny", source: "timeout" });
      const done = recorder.events.find((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ turnId, ok: true, stopReason: "cancelled" });
      expect(chips()).toEqual([`stopped: nobody decided whether to trust ${folder} in time; send the message again to be asked`]);
      expect(existsSync(dump)).toBe(false);
      expect(instance.adapter.hasSession("t-timeout")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Stop while the card is open settles the turn as cancelled at once, close-confirmed, with nothing spawned", async () => {
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-stop",
      text: "go",
      cwd: folder,
      folderTrust: { key: folder, folder, sources: ["AGENTS.md"] },
    });
    await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.interruptTurn("t-stop")).resolves.toEqual({ closeConfirmed: true });
    expect(recorder.events.find((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "system" });
    expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(existsSync(dump)).toBe(false);
  });

  // ── FUIGOTRUST2 follow-ups ──────────────────────────────────────────────

  // (1) a provider-routed turn binds a per-turn temp FUIGO_HOME under
  // <DATA_DIR>/native/provider-turns before the card; the close handler that
  // removes it only exists once a child was spawned.
  const providerTurnsDir = () => join(NATIVE_DIR, "provider-turns");
  const providerTurnHomes = () => (existsSync(providerTurnsDir()) ? readdirSync(providerTurnsDir()).filter((n) => n.startsWith("fuigoAgent-")) : []);
  const routedDriver = createAcpDriver({
    ...SELECT_MODEL_SUPPORT,
    driverKind: "fuigoAgent",
    selectModel: undefined,
    folderTrust: true,
    spawnArgs: (_config, _turn, ctx) => [...(ctx?.folderTrusted ? ["--trust"] : []), "agent", "stdio"],
  });
  const route: ProviderTurnRoute = { connectionId: "conn-1", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m", revision: "r1" };

  it("a Stop while the card is open removes the routed turn's temporary FUIGO_HOME (nothing was spawned to clean it up)", async () => {
    await create(routedDriver);
    const before = providerTurnHomes();
    await instance.adapter.sendTurn({
      threadId: "t-routed-stop",
      text: "go",
      cwd: folder,
      providerRoute: route,
      folderTrust: { key: folder, folder, sources: ["AGENTS.md"] },
    });
    await recorder.until((e) => e.type === "request.opened");
    // the binding exists while the card waits
    expect(providerTurnHomes().length).toBe(before.length + 1);
    await expect(instance.adapter.interruptTurn("t-routed-stop")).resolves.toEqual({ closeConfirmed: true });
    expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(providerTurnHomes()).toEqual(before);
    expect(existsSync(dump)).toBe(false);
  });

  it("a card nobody answers removes the routed turn's temporary FUIGO_HOME too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await create(routedDriver);
      const before = providerTurnHomes();
      await instance.adapter.sendTurn({
        threadId: "t-routed-timeout",
        text: "go",
        cwd: folder,
        providerRoute: route,
        folderTrust: { key: folder, folder, sources: ["AGENTS.md"] },
      });
      expect(providerTurnHomes().length).toBe(before.length + 1);
      vi.advanceTimersByTime(QUESTION_TIMEOUT_MS);
      expect(recorder.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true, stopReason: "cancelled" });
      expect(providerTurnHomes()).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a launch that fails after the card is answered removes the temporary FUIGO_HOME", async () => {
    await create(routedDriver);
    const before = providerTurnHomes();
    await instance.adapter.sendTurn({
      threadId: "t-routed-throw",
      text: "go",
      cwd: folder,
      providerRoute: route,
      folderTrust: { key: folder, folder, sources: ["AGENTS.md"] },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(providerTurnHomes().length).toBe(before.length + 1);
    // the cwd vanishes before the answer: the spawn fails (ENOENT) after
    // the card, the turn fails as spawn_error, and the binding still goes
    await removeTempDir(folder);
    mkdirSync(scratch, { recursive: true });
    await expect(answer("t-routed-throw", (opened as any).requestId, "Trust this folder")).resolves.toBe("answered");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "spawn_error" });
    await expect.poll(() => providerTurnHomes(), { timeout: 5_000 }).toEqual(before);
  });

  // (2) the user's own Fuigo store already trusts the folder: the engine
  // answers Trusted from it before it asks, so Murage neither asks nor
  // claims "untrusted" — whatever its own record says.
  it("an upstream-trusted folder never sees a card and never a withheld chip, even over a Murage 'Don't trust'", async () => {
    await create();
    // the fake honours <FUIGO_HOME>/trusted_folders.toml like the engine
    const fuigoHome = join(scratch, "fuigo-home");
    mkdirSync(fuigoHome, { recursive: true });
    // the engine stores canonical keys (realpath), never the spelling it was given
    writeFileSync(join(fuigoHome, "trusted_folders.toml"), `[folders.${JSON.stringify(realpathSync.native(folder))}]\ntrusted = true\ndecided_at = 1789152451\n`);
    process.env.FUIGO_HOME = fuigoHome;
    try {
      await instance.adapter.sendTurn({
        threadId: "t-upstream",
        text: "go",
        cwd: folder,
        folderTrust: { key: folder, folder, sources: ["AGENTS.md"], upstreamTrusted: true },
      });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(recorder.events.find((e) => e.type === "request.opened")).toBeUndefined();
      expect(assistantText()).toContain(CANARY);
      const wire = readDump();
      // no --trust: the engine's own store speaks; Murage rewrites nothing
      expect(wire.argv).toEqual(["agent", "stdio"]);
      expect(wire.folderTrust).toMatchObject({ trustedAtBuild: true, requested: false });
      expect(chips()).toEqual([]);

      recorder.stop();
      recorder = recordEvents(instance.adapter);
      await instance.adapter.sendTurn({
        threadId: "t-upstream-reject",
        text: "go",
        cwd: folder,
        folderTrust: { key: folder, folder, decision: "reject", sources: ["AGENTS.md"], upstreamTrusted: true },
      });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(recorder.events.find((e) => e.type === "request.opened")).toBeUndefined();
      // the turn ran trusted (the engine's store), so no "untrusted folder" chip may claim otherwise
      expect(assistantText()).toContain(CANARY);
      expect(chips()).toEqual([]);
    } finally {
      delete process.env.FUIGO_HOME;
    }
  });

  // (6) the late-request path when the turn completes before anyone answers
  it("late request, turn finishes first: the card closes as finished-untrusted and the withheld chip names what the engine asked about", async () => {
    process.env.FAKE_ACP_TRUST_PROMPT_FIRST = "1";
    try {
      await create();
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "t-late-finished",
        text: "go",
        cwd: folder,
        folderTrust: { key: folder, folder, sources: [] },
      });
      const opened = await recorder.until((e) => e.type === "request.opened");
      expect(opened).toMatchObject({ tool: "folder_trust", folderTrust: { sources: ["AGENTS.md / CLAUDE.md"] } });
      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ turnId, ok: true, stopReason: null });
      // the ask was closed by the turn's own end, and says so
      expect(recorder.events.find((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "system", folderTrustLate: "finished" });
      expect(assistantText()).toBe("agents: withheld");
      expect(chips()).toEqual(["untrusted folder: AGENTS.md / CLAUDE.md"]);
      // the chip is inside the turn, before turn.completed
      const chipAt = recorder.events.findIndex((e) => e.type === "item.started");
      const doneAt = recorder.events.findIndex((e) => e.type === "turn.completed");
      expect(chipAt).toBeGreaterThan(-1);
      expect(chipAt).toBeLessThan(doneAt);
      expect(readDump().decision).toEqual({ outcome: "reject" });
    } finally {
      delete process.env.FAKE_ACP_TRUST_PROMPT_FIRST;
    }
  });

  it("late request, Stop before anyone answers: the card closes as stopped-untrusted with the withheld chip", async () => {
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-late-stopped",
      text: "go",
      cwd: folder,
      folderTrust: { key: folder, folder, sources: [] },
    });
    await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.interruptTurn("t-late-stopped");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(recorder.events.find((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "system", folderTrustLate: "stopped" });
    expect(chips()).toEqual(["untrusted folder: AGENTS.md / CLAUDE.md"]);
  });

  // FUIGOTRUST3 (3): a turn that FAILS while the late card is open is named
  // as failed, never "stopped before anyone answered"
  it("late request, the turn fails before anyone answers: the card closes as failed-untrusted with the withheld chip", async () => {
    process.env.FAKE_ACP_TRUST_FAIL_PROMPT = "1";
    try {
      await create();
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "t-late-failed",
        text: "go",
        cwd: folder,
        folderTrust: { key: folder, folder, sources: [] },
      });
      await recorder.until((e) => e.type === "request.opened");
      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ turnId, ok: false, stopReason: "rpc_error" });
      expect(recorder.events.find((e) => e.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "system", folderTrustLate: "failed" });
      expect(chips()).toEqual(["untrusted folder: AGENTS.md / CLAUDE.md"]);
      // the chip is inside the turn, before turn.completed
      const chipAt = recorder.events.findIndex((e) => e.type === "item.started");
      const doneAt = recorder.events.findIndex((e) => e.type === "turn.completed");
      expect(chipAt).toBeGreaterThan(-1);
      expect(chipAt).toBeLessThan(doneAt);
      await expect.poll(() => readDump().decision, { timeout: 3000 }).toEqual({ outcome: "reject" });
    } finally {
      delete process.env.FAKE_ACP_TRUST_FAIL_PROMPT;
    }
  });

  // FUIGOTRUST3 (1): the engine sends its request ONLY when its own store did
  // not trust the folder, so a request on an upstream-trusted turn means the
  // two readings of trusted_folders.toml disagree (a hand-edited document
  // Murage's parser accepts, the engine's rejects). The engine's reading is
  // the one that runs: no grant on Murage's reading alone.
  it("an upstream-trusted turn whose engine still asks is never granted automatically: Murage's own record answers, else the card", async () => {
    process.env.FAKE_ACP_TRUST_STORE_REJECTED = "1";
    const fuigoHome = join(scratch, "fuigo-home");
    mkdirSync(fuigoHome, { recursive: true });
    // a document Murage's reader accepts (the inline-table spelling)
    writeFileSync(join(fuigoHome, "trusted_folders.toml"), `[folders]\n${JSON.stringify(realpathSync.native(folder))} = { trusted = true, decided_at = 1789152451 }\n`);
    process.env.FUIGO_HOME = fuigoHome;
    try {
      await create();
      // no record: the engine's request raises the card; Don't trust answers it reject
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "t-upstream-asks",
        text: "go",
        cwd: folder,
        folderTrust: { key: folder, folder, sources: ["AGENTS.md"], upstreamTrusted: true },
      });
      const opened = await recorder.until((e) => e.type === "request.opened");
      expect(opened).toMatchObject({ turnId, tool: "folder_trust", folderTrust: { key: folder, folder, sources: ["AGENTS.md"] } });
      // the engine was spawned without --trust and asked
      expect(readDump()).toMatchObject({ argv: ["agent", "stdio"], folderTrust: { trustedAtBuild: false, requested: true } });
      await expect(answer("t-upstream-asks", (opened as any).requestId, "Don't trust")).resolves.toBe("answered");
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(readDump().decision).toEqual({ outcome: "reject" });
      expect(assistantText()).toBe("agents: withheld");
      expect(chips()).toEqual(["untrusted folder: AGENTS.md"]);

      // Murage's own record says reject: it answers the engine, no card,
      // and the chip upstreamTrusted had suppressed is shown after all
      recorder.stop();
      recorder = recordEvents(instance.adapter);
      await instance.adapter.sendTurn({
        threadId: "t-upstream-asks-reject",
        text: "go",
        cwd: folder,
        folderTrust: { key: folder, folder, decision: "reject", sources: ["AGENTS.md"], upstreamTrusted: true },
      });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(recorder.events.find((e) => e.type === "request.opened")).toBeUndefined();
      expect(readDump()).toMatchObject({ argv: ["agent", "stdio"], folderTrust: { trustedAtBuild: false, requested: true }, decision: { outcome: "reject" } });
      expect(assistantText()).toBe("agents: withheld");
      expect(chips()).toEqual(["untrusted folder: AGENTS.md"]);

      // Murage's own record says trust: --trust rides argv, the engine's
      // store is not consulted and it never asks
      recorder.stop();
      recorder = recordEvents(instance.adapter);
      await instance.adapter.sendTurn({
        threadId: "t-upstream-asks-trust",
        text: "go",
        cwd: folder,
        folderTrust: { key: folder, folder, decision: "trust", sources: ["AGENTS.md"], upstreamTrusted: true },
      });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(recorder.events.find((e) => e.type === "request.opened")).toBeUndefined();
      expect(readDump()).toMatchObject({ argv: ["--trust", "agent", "stdio"], folderTrust: { trustedAtBuild: true, requested: false } });
      expect(assistantText()).toContain(CANARY);
      expect(chips()).toEqual([]);
    } finally {
      delete process.env.FUIGO_HOME;
      delete process.env.FAKE_ACP_TRUST_STORE_REJECTED;
    }
  });

  // FUIGOTRUST3 (2): the engine keys a linked git worktree on its main
  // checkout, so a standalone `fuigo --trust` there covers every worktree
  it("a linked git worktree runs under the main checkout's standalone grant: no card, no --trust, no chip, the engine's store speaks", async () => {
    const main = join(scratch, "main");
    mkdirSync(main, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: scratch } });
    git(main, "init", "-q", ".");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const lane = join(scratch, "lane");
    git(main, "worktree", "add", "-q", "-b", "lane", lane);
    writeFileSync(join(lane, "AGENTS.md"), `# lane\n${CANARY}\n`);
    const fuigoHome = join(scratch, "fuigo-home");
    mkdirSync(fuigoHome, { recursive: true });
    // what `fuigo --trust` wrote from the main checkout: its canonical root
    writeFileSync(join(fuigoHome, "trusted_folders.toml"), `[folders.${JSON.stringify(realpathSync.native(main))}]\ntrusted = true\ndecided_at = 1789152451\n`);
    process.env.FUIGO_HOME = fuigoHome;
    try {
      await create();
      const scan = scanFolderTrustSources(lane, { fuigoHome });
      expect(scan).toEqual({ key: realpathSync.native(main), folder: realpathSync.native(lane), sources: ["AGENTS.md"], upstreamTrusted: true });
      await instance.adapter.sendTurn({
        threadId: "t-worktree",
        text: "go",
        cwd: lane,
        folderTrust: { key: scan.key, folder: scan.folder, decision: "reject", sources: scan.sources, upstreamTrusted: true },
      });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(recorder.events.find((e) => e.type === "request.opened")).toBeUndefined();
      expect(readDump()).toMatchObject({ argv: ["agent", "stdio"], folderTrust: { trustedAtBuild: true, requested: false } });
      expect(assistantText()).toContain(CANARY);
      expect(chips()).toEqual([]);
    } finally {
      delete process.env.FUIGO_HOME;
    }
  });

  it("a driver whose engine does not gate folders ignores the record: no card, no capability, no --trust", async () => {
    process.env.FAKE_ACP_MODE = "folder-trust";
    process.env.FAKE_ACP_DUMP = dump;
    instance = await GrokAgentDriver.create({
      instanceId: "acp-trust-test",
      displayName: "ACP Trust Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    expect(instance.adapter.capabilities.folderTrust).toBe(false);
    await instance.adapter.sendTurn({
      threadId: "t-plain",
      text: "go",
      cwd: folder,
      folderTrust: { key: folder, folder, sources: ["AGENTS.md"] },
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.find((e) => e.type === "request.opened")).toBeUndefined();
    const wire = readDump();
    expect(wire.argv).not.toContain("--trust");
    expect(wire.initialize.clientCapabilities._meta).toBeUndefined();
    expect(wire.folderTrust).toMatchObject({ requested: false });
  });
});

// Round 10. Five invariants of the engine-text path, held at once, and the
// proof obligations that go with them. Rounds 7, 8 and 9 each prescribed a
// cut — from the tail, none, on a whitespace boundary — and each was right
// about the case in front of it and wrong about the rule set as a whole:
// the tail cut split a credential's name from its value, no cut hung the
// event loop, and the boundary cut kept `-----BEGIN PRIVATE KEY-----`,
// dropped `-----END PRIVATE KEY-----`, and let a private key through because
// PEM_BLOCK is anchored at BOTH ends. So these tests do not pin a mechanism.
// They pin the properties, over EVERY redaction rule, against the shipped
// release.
describe("ACP engine text: nothing is cut before it is redacted", () => {
  const cpuMs = (run: () => void) => {
    const started = process.cpuUsage();
    run();
    const used = process.cpuUsage(started);
    return (used.user + used.system) / 1000;
  };
  const loneSurrogate = (text: string) =>
    [...text].some((ch) => ch.length === 1 && ch.codePointAt(0)! >= 0xd800 && ch.codePointAt(0)! <= 0xdfff);
  // Credential material is assembled at runtime so no token-shaped literal
  // sits in the source. The alphabet avoids the letters of the redaction
  // markers so a window can never match text the sanitiser itself wrote.
  const material = (length: number, seed = 7) => {
    const alphabet = "QWXZJKVBQWXZJKVB0123456789";
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[(i * 31 + seed * 17 + Math.floor(i / 7)) % alphabet.length];
    return out;
  };
  /** Every 16-character window of `secret`, stepping by 8: a partial leak —
   * 66 characters of a key, say — still contains one. */
  const windows = (secret: string) => {
    if (secret.length <= 16) return [secret];
    const out: string[] = [];
    for (let at = 0; at + 16 <= secret.length; at += 8) out.push(secret.slice(at, at + 16));
    return out;
  };
  /** What the shipped 0.1.53 put on the exit-before-result line: the whole
   * ring redacted, then the last 300 characters (core.ts:1036 at
   * origin/release/v0.1.53). */
  const shippedExitLine = (stderr: string) => redactSecretsInTextShipped(stripVTControlCharacters(stderr)).trim().slice(-300);
  const pem = (label: string, bodyLength: number) => {
    const body = material(bodyLength, 3).replace(/(.{64})/g, "$1\n");
    return { text: `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`, secret: body.replace(/\n/g, "") };
  };
  /** How a leak is looked for: in the body of a PEM the windows are taken
   * of the unwrapped base64, because the sanitiser collapses the newlines. */
  const leaks = (output: string | undefined, secret: string) => windows(secret).filter((w) => output?.includes(w));

  // One row per redaction rule of the shipped release — every KEY_PREFIXES
  // entry, BEARER, KEY_VALUE in its spellings, PEM_BLOCK at several sizes and
  // under several labels — plus the branch's own QUERY_KEY rule, which the
  // shipped release did not have (`shippedMasks: false`). PEM rows sit at
  // 512, 3 000, 5 000 and 7 000 characters of body: past the 2 048-character
  // line window and the 4 096-character working bound that rounds 6-9
  // introduced, and inside the 8 KiB stderr ring the exit path receives.
  // `branchMasks: false` (round 12) marks a row neither masks: the shipped
  // release printed the material and so does the branch, and what the row
  // pins is that equality — the same windows, from every path.
  type Row = { shape: string; stderr: string; secret: string; shippedMasks?: boolean; branchMasks?: boolean };
  const rows: Row[] = [
    { shape: "an OpenAI-style key", stderr: `auth failed for sk-${material(40)}`, secret: `sk-${material(40)}` },
    { shape: "an Anthropic key", stderr: `ANTHROPIC_API_KEY was sk-ant-${material(40)}`, secret: `sk-ant-${material(40)}` },
    { shape: "a GitHub classic token", stderr: `gh: ${"gh" + "p_"}${material(36)} rejected`, secret: material(36) },
    { shape: "a GitHub fine-grained token", stderr: `gh: ${"github_" + "pat_"}${material(40)} rejected`, secret: material(40) },
    { shape: "a Slack token", stderr: `slack: ${"xox" + "b-"}${material(30)}`, secret: material(30) },
    { shape: "an AWS access key id", stderr: `aws: AKIA${material(16, 2).replace(/\d/g, "Q")} denied`, secret: `AKIA${material(16, 2).replace(/\d/g, "Q")}` },
    { shape: "a Google API key", stderr: `google: AIza${material(35)}`, secret: material(35) },
    { shape: "an npm token", stderr: `npm: ${"npm" + "_"}${material(36)}`, secret: material(36) },
    { shape: "an xAI key", stderr: `xai: xai-${material(30)}`, secret: material(30) },
    { shape: "a Groq key", stderr: `groq: gsk_${material(48)}`, secret: material(48) },
    { shape: "a Hugging Face token", stderr: `hf: hf_${material(34)}`, secret: material(34) },
    { shape: "a JWT", stderr: `jwt: eyJ${material(20)}.${material(24, 1)}.${material(24, 2)} expired`, secret: `${material(24, 1)}.${material(24, 2)}` },
    { shape: "a bearer header", stderr: `Authorization: Bearer ${material(40)}`, secret: material(40) },
    { shape: "api_key=value", stderr: `engine request failed: api_key=${material(40)}`, secret: material(40) },
    { shape: `a JSON "token" pair`, stderr: `{"event":"auth","token":"${material(40)}"}`, secret: material(40) },
    { shape: "an upper-case SECRET: value", stderr: `X_SECRET: ${material(40)}`, secret: material(40) },
    { shape: "a single-quoted password", stderr: `password='${material(40)}'`, secret: material(40) },
    { shape: "ACCESS_KEY=value", stderr: `ACCESS_KEY=${material(40)}`, secret: material(40) },
    { shape: "private-key=value", stderr: `private-key=${material(40)}`, secret: material(40) },
    // Two shapes rounds 5-9 leaked and the shipped release did not: the
    // locator pass ran BEFORE redaction and its `\S+` ate the credential's
    // name — `…/oauth/token:` — or a PEM's `-----BEGIN` header, leaving the
    // value or the key body for `redactSecretsInText` to not recognise.
    { shape: "a token value after a locator that ends in its name", stderr: `curl https://api.internal.invalid/oauth/token: ${material(40)} failed`, secret: material(40) },
    { shape: "a PEM block glued to a locator", stderr: `error at https://x.invalid/${pem("PRIVATE KEY", 300).text}`, secret: pem("PRIVATE KEY", 300).secret },
    { shape: "a query key on a bare host", stderr: `GET localhost:11434/api/chat?key=${material(20)} 401`, secret: material(20), shippedMasks: false },
    { shape: "a query token on an IP literal", stderr: `GET 10.0.0.2:8080/v1?token=${material(20)} 401`, secret: material(20), shippedMasks: false },
    // Round 11: escape-laden lines. `stripVTControlCharacters` is not
    // idempotent — a lone ESC that one pass leaves is consumed together with
    // the character after it by a second pass, when that character is in
    // `[\dA-PR-TZcf-nq-uy=><~]` — and the exit path stripped twice, so
    // `ESC ESC[0mtoken=…` reached redaction as `oken=…`, which no rule
    // names. The shipped release stripped once. One row per prefix whose
    // first character a second strip eats, and the 8-bit CSI form.
    ...([
      ["token=", material(40)], ["TOKEN=", material(40)], ["secret=", material(40)], ["sk-", material(40)],
      ["AKIA", material(16, 2).replace(/\d/g, "Q")], ["gh" + "p_", material(36)], ["hf_", material(34)], ["npm" + "_", material(36)],
      ["AIza", material(35)], ["gsk_", material(48)],
    ] as const).map(([prefix, value]) => ({ shape: `${prefix} behind a lone escape and a reset sequence`, stderr: `\u001b\u001b[0m${prefix}${value}`, secret: value })),
    { shape: "token= behind a lone escape and an 8-bit CSI sequence", stderr: `\u001b\u009b0mtoken=${material(40)}`, secret: material(40) },
    // Round 12: the strip equality, pinned. A single strip still consumes a
    // lone ESC together with a following letter in `[\dA-PR-TZcf-nq-uy=><~]`
    // — `ESC sk-<v>` reaches redaction as `k-<v>`, which no rule names — and
    // the shipped release, which stripped once too, printed the same: 0 of
    // 52 728 texts printed a window 0.1.53 masked (round-11 audit). Not a
    // fix; the row holds the equality so no later round re-derives it.
    { shape: "sk- behind a lone escape, which one strip consumes together with the s", stderr: `\u001bsk-${material(40)}`, secret: material(40), shippedMasks: false, branchMasks: false },
    ...([["PRIVATE KEY", 512], ["RSA PRIVATE KEY", 3000], ["EC PRIVATE KEY", 5000], ["OPENSSH PRIVATE KEY", 7000], ["PRIVATE KEY", 7000]] as const).flatMap(([label, size]) => {
      const block = pem(label, size);
      return [
        { shape: `a ${size}-character ${label} block as the last thing written`, stderr: `loading credentials\n${block.text}\n`, secret: block.secret },
        { shape: `a ${size}-character ${label} block before a fatal line`, stderr: `loading credentials\n${block.text}\nFATAL: key rejected\n`, secret: block.secret },
      ];
    }),
  ];

  // The differential itself. For each row the shipped exit line is the
  // oracle: it masked the secret (or, for QUERY_KEY, is known not to have),
  // and the branch's every output must not contain a window of it — the exit
  // line, and the error-data path from both ends. The assertion is the
  // dangerous substring's ABSENCE; a mask appearing somewhere else in the
  // line proves nothing about the material next to it.
  it.each(rows.map((row) => [row.shape, row] as const))("never prints material the shipped release masked: %s", (_shape, row) => {
    if (row.branchMasks === false) {
      const printed = leaks(shippedExitLine(row.stderr), row.secret);
      expect(printed, "the shipped release printed this row").not.toEqual([]);
      expect(leaks(acpEngineExitStderrText(row.stderr), row.secret), "exit line").toEqual(printed);
      expect(leaks(acpEngineErrorText(row.stderr), row.secret), "error data, head").toEqual(printed);
      expect(leaks(acpEngineErrorText(row.stderr, { keep: "tail" }), row.secret), "error data, tail").toEqual(printed);
      expect(leaks(acpEngineErrorText({ message: row.stderr, error_kind: "http" }), row.secret), "typed error data").toEqual(printed);
      return;
    }
    if (row.shippedMasks !== false) expect(leaks(shippedExitLine(row.stderr), row.secret), "the shipped release masked this row").toEqual([]);
    expect(leaks(acpEngineExitStderrText(row.stderr), row.secret), "exit line").toEqual([]);
    expect(leaks(acpEngineErrorText(row.stderr), row.secret), "error data, head").toEqual([]);
    expect(leaks(acpEngineErrorText(row.stderr, { keep: "tail" }), row.secret), "error data, tail").toEqual([]);
    expect(leaks(acpEngineErrorText({ message: row.stderr, error_kind: "http" }), row.secret), "typed error data").toEqual([]);
  });

  // The same both-end-anchored rule at sizes no window could hold: the
  // error-data path is bounded by the engine frame, not the stderr ring.
  it.each([
    ["a 20 000-character PEM body", 20_000],
    ["a 200 000-character PEM body", 200_000],
  ])("never prints %s from error data, from either end", (_shape, size) => {
    const block = pem("PRIVATE KEY", size);
    const message = `request failed: ${block.text} (HTTP 401)`;
    for (const keep of ["head", "tail"] as const) {
      const text = acpEngineErrorText(message, { keep });
      expect(typeof text, keep).toBe("string");
      expect(leaks(text, block.secret), keep).toEqual([]);
    }
  });

  // Bounded. The text is `error.data.message` / the JSON-RPC `error.message`
  // off a frame of up to ENGINE_FRAME_MAX_BYTES (32 MiB), sanitised
  // synchronously on the server's single event loop. Round 9 measured the
  // unbounded locator pass at 4.3 s for 128 KiB and 312 s for 1 MiB of
  // dotted text; without a cut in front of it, every regex on the path has
  // to be linear on every shape that makes a backtracking engine rescan —
  // dotted and hyphenated runs for the scheme locator and KEY_VALUE,
  // `eyJ-` runs for the JWT rule, headers without footers for PEM_BLOCK —
  // and on a mix of them. CPU time, so a loaded machine cannot fail this for
  // reasons that are not the code's; a quadratic pass is seconds of CPU.
  const hostile: Array<[string, (n: number) => string]> = [
    ["dotted labels", (n) => "a.".repeat(n / 2)],
    ["dotted labels ending in a scheme", (n) => `${"a.".repeat(n / 2 - 4)}://x.y`],
    ["hyphenated words", (n) => "a-".repeat(n / 2)],
    ["hyphenated words ending in a key name", (n) => `${"a-".repeat(n / 2)}api_key=${material(24)}`],
    ["hyphenated JWT prefixes", (n) => "eyJ-".repeat(n / 4)],
    ["PEM headers with no footer", (n) => "-----BEGIN PRIVATE KEY-----".repeat(Math.ceil(n / 27)).slice(0, n)],
    ["a mix of all of them", (n) => Array.from({ length: n / 64 }, (_, i) => ["a.a.a.a.", "a-a-a-a-", "eyJ-eyJ-", "://x.y/?", "-----BEG", "IN PRIVA", "TE KEY--", "api_key="][i % 8]).join("").slice(0, n)],
    ["one unbroken word", (n) => "x".repeat(n)],
    // Round 11. The user:pass@ rule's token class was wider than its
    // lookbehind, so every `%`, `~` and `+` was a fresh start that rescanned
    // the run (2.7-4.3 s at 64 KiB, 40-47 s at 256 KiB); the host?query rule
    // retried `\S*=` from every `?` after a path (3.2 s at 64 KiB).
    ["a run of percent signs", (n) => "%".repeat(n)],
    ["a run of tildes", (n) => "~".repeat(n)],
    ["a run of plus signs", (n) => "+".repeat(n)],
    ["a URL-encoded blob", (n) => "%41%42%2F".repeat(Math.ceil(n / 9)).slice(0, n)],
    ["a host and path, then a run of question marks", (n) => `host.com/${"?".repeat(n)}`],
    // And the shapes the fix for those two would itself have left: a rule
    // that may start at every `/` or `?` and scans to the end of the word
    // before it fails is quadratic in the number of starts, not of `?`s.
    ["dotted hosts with paths", (n) => "ab.cd/".repeat(n / 6)],
    ["dotted hosts with paths after question marks", (n) => "?ab.cd/".repeat(n / 7)],
    ["an early ?=, then dotted hosts with paths and question marks", (n) => `?=${"ab.cd/?".repeat(n / 7)}`],
    ["bare labels with paths and question marks", (n) => "ab/?".repeat(n / 4)],
    ["an early ?=, then bare labels with ports and question marks", (n) => `?=${"ab:1?".repeat(n / 5)}`],
    ["tilde-led words, then a user:pass@ with no host", (n) => `${"~a".repeat(n / 2)}:p@x`],
    ["an @, tilde-led words, then a user:pass@ with a host", (n) => `@${"~a".repeat(n / 2)}:p@h.io`],
    ["colon-separated words", (n) => "a:b:".repeat(n / 4)],
    ["hyphenated words, then a user:pass@host", (n) => `${"a-".repeat(n / 2)}:p@x.y`],
    ["a user:pass@, then a run of question marks", (n) => `u:p@x.y/${"?".repeat(n)}`],
    // Round 12. The user:pass@ rule gained a second start — the first `~`,
    // `%` or `+` after an `@host`, for the authority that directly follows
    // another — whose lookbehind walks back over host and token characters
    // to the `@`. Shapes that make that walk long, make it happen often, or
    // make the lookahead it admits fail after scanning a long run.
    ["adjacent authorities joined by tildes", (n) => "u:p@h.io~".repeat(n / 9)],
    ["adjacent authorities with ports joined by percent signs", (n) => "u:p@h.io:81%".repeat(n / 12)],
    ["adjacent IP authorities joined by plus signs", (n) => "u:p@10.0.0.1+".repeat(n / 13)],
    ["authorities each followed by a run of tildes", (n) => "u:p@h.io~~~~~~~~".repeat(n / 16)],
    ["an authority, then a run of tildes and a user:pass@ with no host", (n) => `u:p@h.io${"~".repeat(n)}v:q@x`],
    ["an authority, then tilde-led words and a user:pass@ with no host", (n) => `u:p@h.io${"~a".repeat(n / 2)}:q@x`],
    ["an @, then tilde-led words", (n) => `@${"~a".repeat(n / 2)}`],
    ["at-signs and tildes alternating", (n) => "@~".repeat(n / 2)],
    ["at-sign-led words joined by tildes, then a user:pass@ with no host", (n) => `${"@a~".repeat(n / 3)}:p@x`],
    ["an @, a run of colons, then a tilde and a user:pass@ with no host", (n) => `@${":".repeat(n)}~u:p@x`],
    ["an @, a run of brackets and colons, then a tilde and a user:pass@ with no host", (n) => `@${"[:]".repeat(n / 3)}~u:p@x`],
    ["an @, then dotted labels, a tilde, and a user:pass@ with no host", (n) => `@${"a.".repeat(n / 2)}~u:p@x`],
    // Round 12, found by the shape above: the trailing-punctuation trim,
    // anchored at `$` alone, was tried from every character of a run of its
    // own characters that did not reach the end (1.9 s at 64 KiB). One shape
    // per character of its class that `\s+` does not already collapse.
    ["a run of colons, then a word", (n) => `${":".repeat(n)}x`],
    ["a run of semicolons, then a word", (n) => `${";".repeat(n)}x`],
    ["a run of commas, then a word", (n) => `${",".repeat(n)}x`],
    ["a run of hyphens, then a word", (n) => `${"-".repeat(n)}x`],
    ["a run of en dashes, then a word", (n) => `${"–".repeat(n)}x`],
    ["a run of em dashes, then a word", (n) => `${"—".repeat(n)}x`],
  ];
  it.each([
    ["64 KiB", 64, 50],
    ["128 KiB", 128, 100],
  ])("sanitises %s of every hostile shape inside its budget, as error data and as exit stderr", (_size, kib, budgetMs) => {
    for (const [shape, make] of hostile) {
      const text = make(kib * 1024);
      expect(cpuMs(() => acpEngineErrorText(text)), `${shape}, head`).toBeLessThan(budgetMs);
      expect(cpuMs(() => acpEngineErrorText(text, { keep: "tail" })), `${shape}, tail`).toBeLessThan(budgetMs);
      expect(cpuMs(() => acpEngineExitStderrText(text)), `${shape}, exit`).toBeLessThan(budgetMs);
    }
  });
  // Same 1 MiB inputs and 800 ms per-call CPU ceiling, one shape per test so
  // cumulative work does not compete with Vitest's unchanged 20 s timeout.
  it.each(hostile)("sanitises 1 MiB hostile shape %s inside its budget, as error data and as exit stderr", (shape, make) => {
    const text = make(1024 * 1024);
    expect(cpuMs(() => acpEngineErrorText(text)), `${shape}, head`).toBeLessThan(800);
    expect(cpuMs(() => acpEngineErrorText(text, { keep: "tail" })), `${shape}, tail`).toBeLessThan(800);
    expect(cpuMs(() => acpEngineExitStderrText(text)), `${shape}, exit`).toBeLessThan(800);
  });

  // Round 11's rule: no rule is called linear without a measured number for
  // THAT rule. Round 10 clocked the path and wrote "four are as written"
  // of the locators it had not clocked; two of the four were quadratic.
  // Each locator, alone, on every hostile shape, at every size.
  it.each([
    ["64 KiB", 64, 50],
    ["128 KiB", 128, 100],
    ["1 MiB", 1024, 800],
  ])("each locator on its own sanitises %s of every hostile shape inside its budget", (_size, kib, budgetMs) => {
    for (const [shape, make] of hostile) {
      const text = make(kib * 1024);
      LOCATORS.forEach(([locator, replacement], index) => {
        expect(cpuMs(() => text.replace(locator, replacement)), `locator ${index}, ${shape}`).toBeLessThan(budgetMs);
      });
    }
  });

  // A non-empty reason always survives. Round 9's boundary cut could return
  // the empty string from its tail branch — when the only whitespace in the
  // window was the final character — so a long unbroken crash line ending in
  // a newline produced NO reason at all, and the card read `<engine> exited
  // 1 before the prompt result` with nothing after it: the bare line MU-R7-1
  // removed. Whatever cuts, the reason the engine wrote must reach the card.
  it.each([
    ["an unbroken line longer than any bound, then a newline", `${"x".repeat(5000)}\n`],
    ["an unbroken line longer than any bound, then a space", `${"x".repeat(5000)} `],
    ["a newline, then an unbroken line, then a newline", `\n${"y".repeat(4100)}\n`],
    ["an unbroken line exactly one past the old bound, then a newline", `${"z".repeat(4097)}\n`],
  ])("still quotes a reason for %s", (_shape, stderr) => {
    const exit = acpEngineExitStderrText(stderr);
    expect(typeof exit).toBe("string");
    expect(exit).toMatch(/\w/);
    for (const keep of ["head", "tail"] as const) {
      const data = acpEngineErrorText(stderr, { keep });
      expect(typeof data, keep).toBe("string");
      expect(data, keep).toMatch(/\w/);
    }
  });

  // Round 11: the display cut's floor. The cut keeps the last (or first)
  // 80-159 characters, strips punctuation from the cut edge, and asks whether
  // what is left says anything; when the kept end was a progress bar of `#`,
  // `.` or `-` — ordinary stderr before a crash — nothing was, and the card
  // showed no reason at all, though the text carried one. The floor: when
  // the preferred end carries nothing, the run of punctuation at that end is
  // what is cut, and the reason in front of (or behind) it is what is kept.
  it.each([
    ["a progress bar of hashes after a line", `Loading model ${"#".repeat(200)}`, "tail", "Loading model…"],
    ["a run of dots after a reason", `error: disk full ${".".repeat(200)}`, "tail", "error: disk full…"],
    ["a run of asterisks and spaces after a reason", `error: disk full ${"* ".repeat(100)}`, "tail", "error: disk full…"],
    ["a run of dots before a reason", `${".".repeat(200)} error: disk full`, "head", "…error: disk full"],
    ["a progress bar of hashes before a reason", `${"#".repeat(200)} FATAL: key rejected`, "head", "…FATAL: key rejected"],
  ] as const)("keeps the reason when the kept end of the display cut is only punctuation: %s", (_shape, text, keep, expected) => {
    expect(acpEngineErrorText(text, { keep })).toBe(expected);
    if (keep === "tail") expect(acpEngineExitStderrText(text)).toBe(expected);
  });

  it("cuts a long run-up from the front and a progress bar from the back, and keeps the reason between them", () => {
    const text = `${"the run-up ".repeat(30)}FATAL: key rejected ${"#".repeat(200)}`;
    for (const line of [acpEngineErrorText(text, { keep: "tail" }), acpEngineExitStderrText(text)]) {
      expect(line).toMatch(/^…(the )?run-up .*FATAL: key rejected…$/);
      expect(line).not.toContain("#");
      expect(line!.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
    }
  });

  // No surrogate pair is split. The boundary cut's backward scan stopped on
  // a lone low surrogate (not a token character) and sliced the text on the
  // orphaned high surrogate in front of it; from the tail that orphan was
  // the last thing on the card. An astral run longer than every bound,
  // offset by one so its pairs straddle even indices, from both ends.
  it.each([
    ["an astral run offset by one", `a${"\u{1f642}".repeat(3000)}`],
    ["an astral run", "\u{1f642}".repeat(3000)],
    ["astral words", `${"\u{1d11e}\u{1d11e}\u{1d11e} ".repeat(1500)}`],
    ["an astral run offset by one, then a newline", `a${"\u{1f642}".repeat(3000)}\n`],
  ])("never splits a surrogate pair in %s", (_shape, text) => {
    expect(loneSurrogate(acpEngineExitStderrText(text)!)).toBe(false);
    for (const keep of ["head", "tail"] as const) {
      const out = acpEngineErrorText(text, { keep })!;
      expect(typeof out, keep).toBe("string");
      expect(loneSurrogate(out), keep).toBe(false);
    }
  });

  // The scheme locator's matching is settled; only its cost may change. The
  // rule as round 9 shipped it, run against the rule as it stands, over the
  // shapes the rewrite was reasoned about on and a fixed fuzz corpus: same
  // spans, same output.
  const OLD_SCHEME = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
  const ATOMS = ["a", "b", "Z", "1", "-", "_", ".", ":", "/", "@", "?", "=", " ", "\n", "+", "%", "://", "http", "https", "x.y", "«redacted 8 chars»", "«redacted-8-chars»", "\u{1f642}", "É"];
  let seed = 4242;
  const next = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const random = () => Array.from({ length: 1 + next(20) }, () => ATOMS[next(ATOMS.length)]).join("");
  it("removes exactly the scheme locators round 9 removed", () => {
    const [scheme, replacement] = LOCATORS[0]!;
    const shapes = ["-https://x", "2.https://x", "_https://x", "+https://x", "a.b.https://x", "Xhttps://x y", "://x", "a://", "a:// b", "git+https://x.y/z", "see https://x.y/?k=v now", "_abc://def://ghi", "a.a.a.a://b c.c.c://d"];
    for (let i = 0; i < 20_000; i++) shapes.push(random());
    for (const text of shapes) expect(text.replace(scheme, replacement), JSON.stringify(text)).toBe(text.replace(OLD_SCHEME, "[link removed]"));
  });

  // Round 11: the same settlement for the three rules it rewrote. The rules
  // as round 10 shipped them (3acbf28e), verbatim, are the oracle; the atoms
  // are the characters those rules' classes disagree about (`~`, `%`, `+`,
  // `@`, `?`, `=`), the host shapes they name, and the shapes reasoned about
  // by hand — including `x@~u:p@h.io`, where a start after a `~` inside a
  // run that an `@` precedes is the one the round-10 rule took and a wider
  // lookbehind alone would not.
  const IP = String.raw`(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]{2,45}\])`;
  const OLD_USER_PASS = new RegExp(
    String.raw`(?<![\w.@-])[\w.~%+-]+:[^\s:@/\\]+@(?:(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d{1,5})?(?:[/?]\S*)?|${IP}(?::\d{1,5})?(?:[/?]\S*)?|[a-z0-9-]+(?::\d{1,5})?[/?]\S*)`,
    "gi",
  );
  const OLD_HOST_QUERY = /(?<![\w.@-])(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d{1,5})?(?:\/\S*)?\?\S*=\S*/gi;
  const OLD_BARE_HOST_QUERY = new RegExp(
    String.raw`(?<![\w.@-])(?:${IP}(?::\d{1,5})?(?:\/[^\s?]*)?|[a-z0-9-]{2,}(?::\d{1,5}(?:\/[^\s?]*)?|\/[^\s?]*))\?\S*=\S*`,
    "gi",
  );
  const LOCATOR_ATOMS = ["a", "b", "Z", "1", "-", "_", ".", ":", "/", "@", "?", "=", "&", " ", "\n", "+", "%", "~", "\\", "x.y", "a.b.cd", "10.0.0.2", "[::1]", "localhost", ":8080", "key=v", "?k=", "user:pass@", "«redacted-8-chars»", "\u{1f642}", "É"];
  const randomLocator = () => Array.from({ length: 1 + next(20) }, () => LOCATOR_ATOMS[next(LOCATOR_ATOMS.length)]).join("");
  // Round 12: the shape round 11 broke was a second authority directly after
  // a first — `u:p@h.io~v:q@k.io` — and 32 atoms drawn 1-20 at random build
  // one about once in a million draws, so the corpus above was green while
  // the property was false. This generator builds nothing else: 17 complete
  // authorities, every ordered pair of them joined by each of the 95
  // printable ASCII characters and by nothing at all (17 × 17 × 96 = 27 744
  // texts), and 100 000 chains of two to four joined by random separators.
  // What it reaches that the atom corpus could not: a second, third or fourth
  // `user:pass@host` that begins inside the token run the previous host
  // ended in, behind every separator there is.
  const AUTHORITY_SHAPES = [
    "u:p@h.io", "u:p@h.io:81", "u:p@h.io/path", "u:p@h.io?k=v", "u:p@a.b.cd", "u:p@10.0.0.1", "u:p@10.0.0.1:8080", "u:p@10.0.0.1/x",
    "u:p@[::1]", "u:p@[::1]:80", "u:p@[fe80::1]/x", "u:p@localhost/x", "u:p@localhost:11434/api", "~u:p@h.io", "x@~u:p@h.io", "a.b:c@h.io", "u%1:p+2@h.io:1/p?q=1",
  ];
  const SEPARATORS = ["", ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i))];
  const joinedAuthorities = () => {
    const out: string[] = [];
    for (const first of AUTHORITY_SHAPES) for (const second of AUTHORITY_SHAPES) for (const separator of SEPARATORS) out.push(first + separator + second);
    for (let i = 0; i < 100_000; i++) {
      const count = 2 + next(3);
      let text = AUTHORITY_SHAPES[next(AUTHORITY_SHAPES.length)]!;
      for (let j = 1; j < count; j++) text += SEPARATORS[next(SEPARATORS.length)]! + AUTHORITY_SHAPES[next(AUTHORITY_SHAPES.length)]!;
      out.push(text);
    }
    return out;
  };
  it.each([
    ["user:pass@", 1, OLD_USER_PASS],
    ["host?query", 3, OLD_HOST_QUERY],
    ["bare-host?query", 4, OLD_BARE_HOST_QUERY],
  ])("removes exactly the %s locators round 10 removed", (_rule, index, previous) => {
    const [locator, replacement] = LOCATORS[index]!;
    const shapes = [
      "x@~u:p@h.io", "@~a:b@x.y", "~user:pass@host.com", "%~user:pass@host.com", "a~b:c@host.com", "u:p@x.y", "a:b:c@x.y", "~:x@x.y",
      "u:p@localhost/x", "u:p@10.0.0.2", "u:p@[::1]:80", "u:p@a.bc.d/x", "\\u:p@x.y", "a-b:c@x.y",
      "?a.bc/?k=v", "a.bc/?k=v", "a.bc/x/y?z&k=v", "a.bc/?=", "?=a.bc/?", "a.bc/?a.bc/?k=v", "a.bc:1?k=v", "a.bc:99999999?k=v",
      "a.b.cd.ef?k=v", "localhost:1?k=v", "localhost?k=v", "ab/?k=v", "ab/?ab/?k=v", "10.0.0.2?k=v", "10.0.0.2:1/x?k=v", "[::1]/x?k=v",
      "x/a.bc/?k=v", "a.bc/=?", "a.bc/?k", "-a.bc/?k=v", "_a.bc/?k=v", "a.bc/x?y?k=v", "a.bc/x=?k", "a.bc?x=1?y=2", "z a.bc/?k=v z",
      // Round 12: the second authority begins in the run the first host ended
      // in — after a TLD, an IPv4 octet, a port — and a third after the second.
      "u:p@h.io~v:q@k.io", "u:p@10.0.0.1+v:q@k.io", "u:p@h.io:81%v:q@k.io/path", "u:p@h.io~v:q@k.io~w:r@m.io",
    ];
    seed = 4242;
    for (let i = 0; i < 20_000; i++) shapes.push(randomLocator());
    for (const text of joinedAuthorities()) shapes.push(text);
    for (const text of shapes) expect(text.replace(locator, replacement), JSON.stringify(text)).toBe(text.replace(previous, "[link removed]"));
  });
});
