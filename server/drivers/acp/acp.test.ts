// ACP driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts. Covers the shared acp/core.ts runtime via
// its two harness shims (grok = fail-closed auth, gemini = lenient auth):
// normalize the ACP handshake into canonical events, keep argv/env hygiene,
// broker permission asks, and settle interrupts/crashes cleanly.
//
// The fake CLI is a shebang script Windows cannot exec directly —
// resolveCliSpawn turns it into `node <script>`, so these run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { acpRpcErrorDetails, acpRpcErrorMessage, createAcpDriver, skipSubscriptionAuthForLocalInject, type AcpSupport } from "./core.ts";
import { GrokAgentDriver } from "./grok.ts";
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

  it.each(["initialize", "session/new", "session/prompt"])("correlates failed %s through the CLI without exposing provider data", async (method) => {
    await create(GrokAgentDriver, `rpc-error:${method}`);
    await instance.adapter.sendTurn({ threadId: "t-rpc-diagnostics", text: "fake-private-request" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: false, stopReason: "rpc_error" });
    const errors = recorder.events.filter(event => event.type === "runtime.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "Internal error", details: `ACP request: ${method}\nProvider response: HTTP 500\nEngine error code: -32603` });
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
    expect(acpRpcErrorMessage({ data: { http_status: 402, message: "unknown provider response fake-secret-canary" } })).toBe("ACP request failed");
    expect(acpRpcErrorMessage({ message: "Authentication required", data: { token: "fake-secret-canary" } })).toBe("Authentication required");
    expect(acpRpcErrorMessage({ message: "Internal error", data: { http_status: 402, message: "Your credit balance is exhausted. Top up at https://fluxrouter.ai/home/billing?token=fake-secret-canary" } })).toBe("Flux Router is out of credits. Add credits in Flux Router, then retry—or choose another configured provider.");
    expect(acpRpcErrorMessage({ message: "Internal error", data: { http_status: 402, message: "Your credit balance is exhausted. https://fluxrouter.ai.evil.invalid/" } })).not.toContain("Flux Router is out of credits");
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
