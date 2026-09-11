// pi driver contract tests, run against the scripted fake `pi` CLI in
// server/testing/fake-pi-cli.ts: parse the live catalog, normalize a full
// RPC turn into canonical events, ride the toolUse→end_turn auto-continue,
// broker a permission ask, and report availability from `pi --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly; spawnCli
// resolves it to `node <script>`, so these run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approvalKey, autoVerdict } from "../auto-approve.ts";
import { shouldReview } from "../auto-review.ts";
import { ensureDirs, NATIVE_DIR } from "../config.ts";
import { newId, type ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { encodeInjectId, localHost } from "./local-inject.ts";
import {
  applyPiLocalCatalog,
  buildMcpServers,
  ensurePiInjectModel,
  fetchPiModels,
  parsePiCatalog,
  PiDriver,
  preferPiInjectRows,
  splitPiModel,
} from "./pi.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-pi-cli.ts");
const MODELS_LINE =
  '{"type":"response","command":"get_available_models","success":true,"data":{"models":[{"provider":"ollama-cloud","id":"glm-5.2","name":"glm-5.2"},{"provider":"openai","id":"gpt-4o","name":"GPT-4o"}]}}';

describe("parsePiCatalog", () => {
  it("turns a get_available_models response into custom composite-id options", () => {
    const catalog = parsePiCatalog(MODELS_LINE + "\n");
    expect(catalog.default).toBe("ollama-cloud/glm-5.2");
    expect(catalog.options).toEqual([
      { id: "ollama-cloud/glm-5.2", label: "glm-5.2", custom: true, provider: "ollama-cloud" },
      { id: "openai/gpt-4o", label: "GPT-4o", custom: true, provider: "openai" },
    ]);
  });

  it("uses the fallback default when the response omits one and a settings file is absent", () => {
    const catalog = parsePiCatalog(MODELS_LINE + "\n", "openai/gpt-4o");
    expect(catalog.default).toBe("openai/gpt-4o");
  });

  it("reports the provider so BYOK duplicates of one model stay distinguishable", () => {
    const line =
      '{"type":"response","command":"get_available_models","success":true,"data":{"models":[' +
      '{"provider":"zai","id":"glm-5.3","name":"GLM-5.3"},' +
      '{"provider":"nous","id":"glm-5.3","name":"GLM-5.3"}]}}\n';
    const catalog = parsePiCatalog(line);
    expect(catalog.options.map((o) => [o.id, o.provider])).toEqual([
      ["zai/glm-5.3", "zai"],
      ["nous/glm-5.3", "nous"],
    ]);
  });

  it("keeps an empty catalog when the probe fails or reports no models", () => {
    expect(parsePiCatalog("not json\n")).toEqual({ default: "", options: [] });
    expect(parsePiCatalog('{"type":"response","command":"get_available_models","success":false}\n')).toEqual({
      default: "",
      options: [],
    });
    expect(
      parsePiCatalog('{"type":"response","command":"get_available_models","success":true,"data":{"models":[]}}\n'),
    ).toEqual({ default: "", options: [] });
  });

  it("ignores non-response lines (pi emits TUI bookkeeping on stdout too)", () => {
    const stdout =
      '{"type":"extension_ui_request","id":"x","method":"setStatus","statusKey":"loops"}\n' + MODELS_LINE + "\n";
    const catalog = parsePiCatalog(stdout);
    expect(catalog.options).toHaveLength(2);
  });
});

describe("buildMcpServers", () => {
  it("returns null when there are no integrations", () => {
    expect(buildMcpServers({ threadId: "t", text: "hi" })).toBeNull();
  });

  it("passes composio/agents/phone through as stdio servers", () => {
    const servers = buildMcpServers({
      threadId: "t",
      text: "hi",
      integrations: {
        composio: { command: "node", args: ["c"], env: { A: "1" } },
        agents: { command: "node", args: ["a"], env: { B: "2" } },
        phone: { command: "node", args: ["p"], env: {} },
      },
    });
    expect(servers).toEqual({
      composio: { command: "node", args: ["c"], env: { A: "1" } },
      agents: { command: "node", args: ["a"], env: { B: "2" } },
      phone: { command: "node", args: ["p"], env: {} },
    });
  });

  it("wraps the cloud computer in the computer-proxy spawn contract", () => {
    const servers = buildMcpServers({
      threadId: "t",
      text: "hi",
      integrations: {
        computer: { kind: "box", boxId: "b1", token: "tok", control: { url: "http://c", token: "ct" } },
      },
    });
    expect(servers?.computer).toMatchObject({
      command: process.execPath,
      args: [expect.stringContaining("computer-proxy")],
      env: expect.objectContaining({ MURAGEBOX_BOX_ID: "b1", MURAGEBOX_BOX_TOKEN: "tok" }),
    });
  });

  it("passes a local computer (Cua/VPS) through as a direct stdio server", () => {
    const servers = buildMcpServers({
      threadId: "t",
      text: "hi",
      integrations: {
        localComputer: { command: "node", args: ["mcp"], env: { X: "y" } },
      },
    });
    expect(servers?.computer).toEqual({ command: "node", args: ["mcp"], env: { X: "y" } });
  });

  it("marks a host computer with scope so the extension gates its tools", () => {
    const servers = buildMcpServers({
      threadId: "t",
      text: "hi",
      integrations: {
        localComputer: { command: "node", args: ["mcp"], env: {}, scope: "local-computer" },
      },
    });
    expect(servers?.computer).toMatchObject({ scope: "local-computer" });
  });
});

describe("PiDriver config + install", () => {
  it("defaults to the `pi` binary", () => {
    expect(PiDriver.decodeConfig({})).toEqual({ cli: "pi", fullAuto: false });
    expect(PiDriver.decodeConfig(undefined)).toEqual({ cli: "pi", fullAuto: false });
    expect(PiDriver.decodeConfig(null)).toEqual({ cli: "pi", fullAuto: false });
    expect(PiDriver.decodeConfig({ cli: "  " })).toEqual({ cli: "pi", fullAuto: false });
  });

  it("rejects invalid config (throws → shadow snapshot)", () => {
    expect(() => PiDriver.decodeConfig(5)).toThrow(/object/);
    expect(() => PiDriver.decodeConfig({ cli: 5 })).toThrow(/string/);
    expect(() => PiDriver.decodeConfig({ fullAuto: "yes" })).toThrow(/boolean/);
  });

  it("publishes the npm installer on every platform and points docs at pi.dev", () => {
    expect(PiDriver.install).toMatchObject({
      command: {
        darwin: "npm install -g @earendil-works/pi-coding-agent",
        linux: "npm install -g @earendil-works/pi-coding-agent",
        win32: "npm install -g @earendil-works/pi-coding-agent",
      },
      docsUrl: "https://pi.dev",
      needsNode: true,
    });
    expect(PiDriver.metadata).toMatchObject({ displayName: "pi", access: "custom" });
  });
});

describe("PiDriver catalog (fake CLI)", () => {
  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  it("probes the live catalog and flags every option custom", async () => {
    const catalog = await fetchPiModels(FAKE_CLI, { PATH: process.env.PATH ?? "", HOME: join(tmpdir(), "murage-pi-no-settings") });
    expect(catalog.options).toEqual([
      { id: "ollama-cloud/glm-5.2", label: "glm-5.2", custom: true, provider: "ollama-cloud" },
      { id: "openai/gpt-4o", label: "gpt-4o", custom: true, provider: "openai" },
    ]);
    // no ~/.pi/agent/settings.json in the throwaway home → first option wins
    expect(catalog.default).toBe("ollama-cloud/glm-5.2");
  });

  it("keeps an empty catalog when the probe reports no models", async () => {
    const catalog = await fetchPiModels(FAKE_CLI, {
      PATH: process.env.PATH ?? "",
      HOME: join(tmpdir(), "murage-pi-empty"),
      FAKE_PI_MODE: "no-models",
    });
    expect(catalog.options).toEqual([]);
  });
});

describe("PiDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (mode?: string, environment: Record<string, string> = {}) => {
    instance = await PiDriver.create({
      instanceId: "pi-test",
      displayName: "pi Test",
      environment: { ...environment, ...(mode ? { FAKE_PI_MODE: mode } : {}) },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "hi",
      model: "ollama-cloud/glm-5.2",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "content.delta",
      "content.delta",
      "item.completed", // assistant_text
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "piAgent")).toBe(true);

    const session = recorder.events.find((e) => e.type === "session.started")!;
    expect((session as { sessionId: string }).sessionId).toMatch(/\/fake\/pi-session-\d+\.json/);

    const text = recorder.events.find(
      (e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text",
    )!;
    expect((text as { text: string }).text).toBe("Hello from pi");

    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true, stopReason: "end_turn", usage: { input: 12, output: 3 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("resumes a prior pi session using the sessionFile resume cursor", async () => {
    await create();
    const first = await instance.adapter.sendTurn({ threadId: "t-resume", text: "first" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const firstSession = recorder.events.find((e) => e.type === "session.started" && e.turnId === first.turnId) as
      | { sessionId: string }
      | undefined;
    expect(firstSession?.sessionId).toMatch(/\/fake\/pi-session-\d+\.json/);

    const second = await instance.adapter.sendTurn({
      threadId: "t-resume",
      text: "second",
      resumeCursor: firstSession!.sessionId,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const secondSession = recorder.events.find((e) => e.type === "session.started" && e.turnId === second.turnId) as
      | { sessionId: string }
      | undefined;
    expect(secondSession?.sessionId).toBe(firstSession?.sessionId);
  });

  it("fails promptly when the pi process exits before replying", async () => {
    await create("exit-early");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-exit", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "failed" });
    expect(instance.adapter.hasSession("t-exit")).toBe(false);
  });

  it("surfaces a pi turn error instead of reporting an empty success", async () => {
    await create("turn-error");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-turn-error", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "failed", usage: { input: 0, output: 0 } });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({
      message: "Invalid schema for function 'computer_browser_prepare'",
    });
    expect(instance.adapter.hasSession("t-turn-error")).toBe(false);
  });

  /** Every RPC command the driver wrote to this thread's pi child, in order,
   * read back from the driver's own native trace (not the child's side). */
  const outboundCommands = (threadId: string) => {
    const file = join(NATIVE_DIR, `${threadId}.ndjson`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { dir?: string; source?: string; msg?: { type?: string } })
      .filter((row) => row.dir === "out" && row.source === "pi.rpc")
      .map((row) => row.msg?.type);
  };
  const dumpRows = (dump: string) =>
    existsSync(dump)
      ? readFileSync(dump, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { setModel?: { provider: string; modelId: string }; prompt?: boolean })
      : [];
  const turnEventTypes = (turnId: string) => recorder.events.filter((e) => e.turnId === turnId).map((e) => e.type);

  it("fails before the prompt when pi rejects the selected model", async () => {
    const dump = join(mkdtempSync(join(tmpdir(), "murage-pi-model-reject-")), "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump, FAKE_PI_SET_MODEL: "reject" });
    const threadId = `t-model-reject-${newId()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi", model: "openai/gpt-4o" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(done).toMatchObject({ ok: false, stopReason: "failed" });
    expect(turnEventTypes(turnId)).toEqual(["turn.started", "session.started", "runtime.error", "turn.completed"]);
    expect(recorder.events.find((e) => e.type === "runtime.error" && e.turnId === turnId)).toMatchObject({
      message: 'pi could not select model "openai/gpt-4o": pi set_model failed: Model not found: openai/gpt-4o',
    });
    expect(outboundCommands(threadId)).toEqual(["new_session", "set_model"]);
    expect(dumpRows(dump).filter((row) => row.setModel)).toEqual([{ setModel: { provider: "openai", modelId: "gpt-4o" } }]);
    expect(dumpRows(dump).filter((row) => row.prompt)).toEqual([]);
    expect(instance.adapter.hasSession(threadId)).toBe(false);
  });

  it("fails before the prompt when set_model never answers", async () => {
    await create(undefined, { FAKE_PI_SET_MODEL: "silent" });
    const threadId = `t-model-timeout-${newId()}`;
    // Only the driver's RPC timers are faked; child-process I/O stays real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const sent = instance.adapter.sendTurn({ threadId, text: "hi", model: "ollama-cloud/glm-5.2" });
      // session.started is emitted in the same synchronous continuation that
      // arms the set_model response timer and writes set_model.
      await recorder.until((e) => e.type === "session.started" && e.threadId === threadId);
      expect(outboundCommands(threadId)).toEqual(["new_session", "set_model"]);
      await vi.advanceTimersByTimeAsync(20_000);
      const { turnId } = await sent;
      const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

      expect(done).toMatchObject({ ok: false, stopReason: "failed" });
      expect(recorder.events.find((e) => e.type === "runtime.error" && e.turnId === turnId)).toMatchObject({
        message: 'pi could not select model "ollama-cloud/glm-5.2": pi set_model timed out',
      });
      expect(outboundCommands(threadId)).toEqual(["new_session", "set_model"]);
      expect(recorder.events.filter((e) => e.type === "turn.completed" && e.turnId === turnId)).toHaveLength(1);
      expect(instance.adapter.hasSession(threadId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails before model selection or the prompt when a new session cannot start", async () => {
    await create(undefined, { FAKE_PI_SESSION: "reject" });
    const threadId = `t-session-reject-${newId()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi", model: "openai/gpt-4o" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(done).toMatchObject({ ok: false, stopReason: "failed" });
    expect(turnEventTypes(turnId)).toEqual(["turn.started", "runtime.error", "turn.completed"]);
    expect(recorder.events.find((e) => e.type === "runtime.error" && e.turnId === turnId)).toMatchObject({
      message: "pi could not start a session: pi new_session failed: Could not create session directory",
    });
    expect(outboundCommands(threadId)).toEqual(["new_session"]);
  });

  it("fails instead of silently dropping history when a saved session cannot be resumed", async () => {
    await create(undefined, { FAKE_PI_SESSION: "reject" });
    const threadId = `t-resume-reject-${newId()}`;
    const { turnId } = await instance.adapter.sendTurn({
      threadId,
      text: "hi",
      resumeCursor: "/fake/missing-session.json",
    });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(done).toMatchObject({ ok: false, stopReason: "failed" });
    expect(recorder.events.find((e) => e.type === "runtime.error" && e.turnId === turnId)).toMatchObject({
      message:
        "pi could not resume this thread's session: pi switch_session failed: Session file not found: /fake/missing-session.json",
    });
    expect(outboundCommands(threadId)).toEqual(["switch_session"]);
  });

  it("fails a bare model id before spawning instead of running pi's default", async () => {
    const dump = join(mkdtempSync(join(tmpdir(), "murage-pi-bare-model-")), "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const rowsAfterCatalogProbe = dumpRows(dump).length;
    const threadId = `t-bare-model-${newId()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi", model: "gpt-4o" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(done).toMatchObject({ ok: false, stopReason: "failed" });
    expect(turnEventTypes(turnId)).toEqual(["turn.started", "runtime.error", "turn.completed"]);
    expect(recorder.events.find((e) => e.type === "runtime.error" && e.turnId === turnId)).toMatchObject({
      message: expect.stringContaining('pi could not select model "gpt-4o": pi needs a provider/model id'),
    });
    expect(outboundCommands(threadId)).toEqual([]);
    // no pi child was spawned for the turn, so nothing new reached the fake
    expect(dumpRows(dump)).toHaveLength(rowsAfterCatalogProbe);
    expect(instance.adapter.hasSession(threadId)).toBe(false);
  });

  it("pins a selected model once before one prompt, and leaves an unselected turn on pi's default", async () => {
    const dump = join(mkdtempSync(join(tmpdir(), "murage-pi-model-ok-")), "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const picked = `t-model-picked-${newId()}`;
    const first = await instance.adapter.sendTurn({ threadId: picked, text: "hi", model: "openai/gpt-4o" });
    expect(await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId)).toMatchObject({ ok: true });
    expect(outboundCommands(picked)).toEqual(["new_session", "set_model", "prompt"]);

    const plain = `t-model-default-${newId()}`;
    const second = await instance.adapter.sendTurn({ threadId: plain, text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId)).toMatchObject({ ok: true });
    expect(outboundCommands(plain)).toEqual(["new_session", "prompt"]);

    expect(dumpRows(dump).filter((row) => row.setModel)).toEqual([{ setModel: { provider: "openai", modelId: "gpt-4o" } }]);
    expect(dumpRows(dump).filter((row) => row.prompt)).toHaveLength(2);
  });

  it("advertises images and every harness effort level", async () => {
    await create();
    expect(instance.adapter.capabilities.images).toBe(true);
    expect(instance.adapter.capabilities.effortLevels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("pins reasoning effort via set_thinking_level after the model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-pi-effort-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-effort",
      text: "hi",
      model: "ollama-cloud/glm-5.2",
      effort: "high",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const levels = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { thinkingLevel?: string })
      .filter((record) => record.thinkingLevel !== undefined)
      .map((record) => record.thinkingLevel!);
    expect(levels).toEqual(["high"]);
  });

  it("maps the none effort to pi's off and sends nothing without effort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-pi-effort-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const none = await instance.adapter.sendTurn({ threadId: "t-none", text: "hi", effort: "none" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === none.turnId);
    const plain = await instance.adapter.sendTurn({ threadId: "t-plain", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === plain.turnId);
    const levels = readFileSync(dump, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { thinkingLevel?: string })
      .filter((record) => record.thinkingLevel !== undefined)
      .map((record) => record.thinkingLevel!);
    // exactly one pin across both turns: the "none" turn's off — a plain turn
    // must not touch the thinking level at all
    expect(levels).toEqual(["off"]);
  });

  it("scrubs provider and workspace credentials from every pi child env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-pi-dump-"));
    const dump = join(dir, "dump.jsonl");
    // Plant a workspace credential on the harness process itself — the leak
    // path is `...process.env`, not just input.environment.
    const savedBox = process.env.BOX_TOKEN;
    const savedXai = process.env.XAI_API_KEY;
    process.env.BOX_TOKEN = "box-secret-value";
    process.env.XAI_API_KEY = "xai-secret-value";
    try {
      await create(undefined, {
        FAKE_PI_DUMP: dump,
        ANTHROPIC_API_KEY: "anthropic-secret-value",
        OPENAI_API_KEY: "openai-secret-value",
      });
      await instance.dispose();
    } finally {
      if (savedBox === undefined) delete process.env.BOX_TOKEN;
      else process.env.BOX_TOKEN = savedBox;
      if (savedXai === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = savedXai;
    }

    const rows = readFileSync(dump, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; envConfigured: string[] });
    expect(rows.some((row) => row.argv.join(" ") === "--mode rpc --no-session")).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.envConfigured).toContain("PATH");
      expect(row.envConfigured).not.toContain("ANTHROPIC_API_KEY");
      expect(row.envConfigured).not.toContain("OPENAI_API_KEY");
      expect(row.envConfigured).not.toContain("XAI_API_KEY");
      expect(row.envConfigured).not.toContain("BOX_TOKEN");
    }
    expect(JSON.stringify(rows)).not.toContain("anthropic-secret-value");
    expect(JSON.stringify(rows)).not.toContain("openai-secret-value");
  });

  it("scrubs ambient routing switches from every pi child env", async () => {
    // pi is OpenAI-compatible: a leftover OPENAI_BASE_URL from a provider
    // switcher in the user's shell would redirect every turn off pi's own
    // settings. Planted on the harness process — the leak path is
    // `...process.env`, not just input.environment.
    const dir = mkdtempSync(join(tmpdir(), "murage-pi-routing-"));
    const dump = join(dir, "dump.jsonl");
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
      await create(undefined, { FAKE_PI_DUMP: dump });
      await instance.dispose();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    const rows = readFileSync(dump, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { envConfigured: string[] });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.envConfigured).toContain("PATH");
      for (const name of Object.keys(ambient)) expect(row.envConfigured).not.toContain(name);
    }
  });

  it("mounts integrations as stdio MCP servers and loads the pi-mcp-extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-pi-mcp-dump-"));
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-mcp",
      text: "hi",
      integrations: {
        memory: { command: "node", args: ["memory-proxy.js"], env: { MURAGE_MEMORY_TOKEN: "fixture-memory" } },
        composio: { command: "node", args: ["connector-proxy.js"], env: { COMPOSIO_KEY: "ck" } },
        computer: { kind: "box", boxId: "b1", token: "bt", control: { url: "http://c", token: "ct" } },
      },
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const rows = readFileSync(dump, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; mcpConfig?: { mcpServers?: Record<string, any> } | null });
    const mcpRow = rows.find((r) => r.mcpConfig != null);
    expect(mcpRow).toBeTruthy();

    // the extension rides `-e` so the external pi process mounts the servers
    const extIndex = mcpRow!.argv.indexOf("-e");
    expect(extIndex).toBeGreaterThanOrEqual(0);
    expect(mcpRow!.argv[extIndex + 1]).toContain("pi-mcp-extension");

    const servers = mcpRow!.mcpConfig!.mcpServers!;
    expect(servers["murage-memory"]).toEqual({ command: "node", args: ["memory-proxy.js"], env: { MURAGE_MEMORY_TOKEN: "fixture-memory" } });
    expect(JSON.stringify(mcpRow!.argv)).not.toContain("fixture-memory");
    // composio passes through verbatim as a stdio server
    expect(servers.composio).toMatchObject({ command: "node", args: ["connector-proxy.js"], env: { COMPOSIO_KEY: "ck" } });
    // the cloud computer wraps in the computer-proxy spawn contract
    expect(servers.computer.args[0]).toContain("computer-proxy");
    expect(servers.computer.env).toMatchObject({ MURAGEBOX_BOX_ID: "b1", MURAGEBOX_BOX_TOKEN: "bt" });
    // the box token lives in the 0600 config file, never in argv
    expect(JSON.stringify(mcpRow!.argv)).not.toContain("bt");
  });

  it("rides the toolUse auto-continue and only settles on the final end_turn", async () => {
    await create("tooluse");
    await instance.adapter.sendTurn({ threadId: "t-tool", text: "run it" });
    const done = await recorder.until((e) => e.type === "turn.completed");

    // a tool ran and completed, then pi auto-continued to synthesize the reply
    expect(recorder.events.filter((e) => e.type === "item.started").length).toBe(1);
    expect(recorder.events.filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "tool").length).toBe(1);
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect((done as { usage: { input: number; output: number } }).usage).toEqual({ input: 12, output: 2 });
    const text = recorder.events.find(
      (e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text",
    ) as { text: string } | undefined;
    expect(text?.text).toBe("done");
    expect(instance.adapter.hasSession("t-tool")).toBe(false);
  });

  it("emits each assistant text block before the tool that follows it", async () => {
    await create("interleave");
    await instance.adapter.sendTurn({ threadId: "t-interleave", text: "go", model: "ollama-cloud/glm-5.2" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // before one
      "item.started",
      "item.completed", // tool
      "content.delta",
      "item.completed", // before two
      "item.started",
      "item.completed", // tool
      "content.delta",
      "item.completed", // after
      "turn.completed",
    ]);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["before one", "before two", "after"]);
  });

  it("brokers a permission ask (a pi confirm) through request.opened → respondToRequest", async () => {
    // Before 0.1.52 ASK3 this used the select fixture; a select is now a
    // question, so the permission path is pi's confirm dialog.
    await create("host-confirm");
    await instance.adapter.sendTurn({ threadId: "t-perm", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(true);

    const outcome = await instance.adapter.respondToRequest("t-perm", "ask-host", { behavior: "allow" });
    expect(outcome).toBe("allowed-once");

    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(recorder.events.some((e) => e.type === "request.resolved")).toBe(true);
  });

  it("registers an ask before emitting it so synchronous auto-approval works", async () => {
    await create("host-confirm");
    let unsubscribe = () => {};
    const outcome = new Promise<string>((resolve) => {
      unsubscribe = instance.adapter.onEvent((event) => {
        if (event.type !== "request.opened" || !event.requestId) return;
        // This mirrors the harness's auto-approve listener: emit() invokes it
        // synchronously, so the ask must already be in pending here.
        void instance.adapter
          .respondToRequest(event.threadId, event.requestId, { behavior: "allow" })
          .then(resolve);
      });
    });
    await instance.adapter.sendTurn({ threadId: "t-sync-auto", text: "go" });
    expect(await outcome).toBe("allowed-once");
    unsubscribe();
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
  });

  type OpenedAsk = { requestId: string; requestType: string; tool: string; summary: string; approvalScope?: "local-computer" };
  const hostControl = {
    localComputer: { command: process.execPath, args: ["host-mcp.js"], env: {}, scope: "local-computer" as const },
  };

  it("carries local-computer scope on a host-control confirmation from open through resolve", async () => {
    await create("host-confirm");
    const threadId = `t-host-scope-${newId()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "click it", integrations: hostControl });
    const opened = await recorder.until((e) => e.type === "request.opened" && e.turnId === turnId);
    expect(opened).toMatchObject({
      requestId: "ask-host",
      requestType: "permission",
      tool: "Allow click on your computer?",
      approvalScope: "local-computer",
    });

    await expect(instance.adapter.respondToRequest(threadId, "ask-host", { behavior: "allow" })).resolves.toBe("allowed-once");
    expect(await recorder.until((e) => e.type === "request.resolved" && e.turnId === turnId)).toMatchObject({
      behavior: "allow",
      source: "user",
      approvalScope: "local-computer",
    });
    expect(await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)).toMatchObject({ ok: true });
  });

  it("keeps remembered grants from auto-approving a Pi host action and keeps it out of AI review", async () => {
    await create("host-confirm");
    const threadId = `t-host-policy-${newId()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "click it", integrations: hostControl });
    const opened = (await recorder.until((e) => e.type === "request.opened" && e.turnId === turnId)) as unknown as OpenedAsk;

    // Every grant a user could have remembered for this card, with Auto off —
    // run through the same join server/index.ts applies to request.opened.
    const remembered = {
      autoApprove: false,
      alwaysAllow: [
        opened.tool,
        approvalKey(opened.tool, opened.summary)!,
        approvalKey(opened.tool, opened.summary, "local-computer")!,
      ],
    };
    const verdict = autoVerdict(remembered, opened.tool, opened.summary, { scope: opened.approvalScope });
    expect(verdict).toMatchObject({ approve: null, source: "local-computer-block" });
    expect(shouldReview({ source: verdict.source, mode: "enforce", unattended: false, approvalScope: opened.approvalScope })).toBe(false);
    expect(shouldReview({ source: "no-grant", mode: "enforce", unattended: false, approvalScope: opened.approvalScope })).toBe(false);
    // Explicit Auto on this computer keeps its separate, warned-about behavior.
    expect(autoVerdict({ autoApprove: true }, opened.tool, opened.summary, { scope: opened.approvalScope }).approve).toBe(
      `auto-approved ${opened.tool}`,
    );

    await expect(instance.adapter.respondToRequest(threadId, "ask-host", { behavior: "deny" })).resolves.toBe("rejected");
    expect(await recorder.until((e) => e.type === "request.resolved" && e.turnId === turnId)).toMatchObject({
      behavior: "deny",
      approvalScope: "local-computer",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
  });

  it("cards a select as a question with its own options and answers pi with {value} (ASK1, ASK3)", async () => {
    // R1-T6 (L03) and ASK1 carded a select as a permission with a question
    // flag; ASK3 makes it the question it is. This deliberately changes that
    // expectation: requestType is "question", the card carries the select's
    // options, and pi receives {value: <label>} — its select reply shape —
    // never {confirmed: true}.
    const dump = join(tmpdir(), `murage-pi-select-${newId()}.jsonl`);
    await create("permission", { FAKE_PI_DUMP: dump });
    const threadId = `t-select-question-${newId()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "go" });
    const opened = (await recorder.until((e) => e.type === "request.opened" && e.turnId === turnId)) as unknown as OpenedAsk & {
      questionTool?: true;
      choices?: string[];
      questions?: unknown;
    };
    expect(opened).toMatchObject({
      requestType: "question",
      tool: "select",
      summary: "Run bash: echo hi?",
      choices: ["Allow once", "Deny"],
      questions: [{ id: "q1", question: "Run bash: echo hi?", options: [{ label: "Allow once" }, { label: "Deny" }], multiSelect: false, allowOther: false }],
    });
    expect(opened).not.toHaveProperty("approvalScope");
    expect(opened).not.toHaveProperty("questionTool");

    // Still never a machine's to answer, whatever grants a user holds.
    const everything = { autoApprove: true, alwaysAllow: [opened.tool, `local-computer:${opened.tool}`] };
    expect(autoVerdict(everything, opened.tool, opened.summary, { scope: opened.approvalScope, question: true })).toEqual({ approve: null, source: "question-tool" });

    await expect(
      instance.adapter.respondToRequest(threadId, "ask-1", { behavior: "answer", message: "Allow once", answers: [{ id: "q1", selected: ["Allow once"] }] }),
    ).resolves.toBe("answered");
    expect(await recorder.until((e) => e.type === "request.resolved" && e.turnId === turnId)).toMatchObject({ behavior: "answer", source: "user" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const replies = readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.uiResponse);
    expect(replies).toEqual([{ uiResponse: { type: "extension_ui_response", id: "ask-1", value: "Allow once" } }]);
    rmSync(dump, { force: true });
    recorder.stop();
    await instance.dispose();

    // A confirm stays an ordinary permission: no question, {confirmed:true} on allow.
    const dump2 = join(tmpdir(), `murage-pi-confirm-${newId()}.jsonl`);
    await create("host-confirm", { FAKE_PI_DUMP: dump2 });
    const plain = `t-confirm-plain-${newId()}`;
    const second = await instance.adapter.sendTurn({ threadId: plain, text: "click it" });
    const confirm = await recorder.until((e) => e.type === "request.opened" && e.turnId === second.turnId);
    expect(confirm).toMatchObject({ requestType: "permission" });
    expect(confirm).not.toHaveProperty("questionTool");
    expect(confirm).not.toHaveProperty("questions");
    await instance.adapter.respondToRequest(plain, "ask-host", { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const confirmReplies = readFileSync(dump2, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.uiResponse);
    expect(confirmReplies).toEqual([{ uiResponse: { type: "extension_ui_response", id: "ask-host", confirmed: true } }]);
    rmSync(dump2, { force: true });
  });

  it("answers input and editor asks with the owner's text as {value}, and a skip as {cancelled:true} (ASK3)", async () => {
    const dump = join(tmpdir(), `murage-pi-editor-${newId()}.jsonl`);
    await create("editor", { FAKE_PI_DUMP: dump });
    const threadId = `t-editor-${newId()}`;
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened" && e.turnId === turnId);
    expect(opened).toMatchObject({
      requestType: "question",
      tool: "editor",
      questions: [{ id: "q1", question: "Edit the release notes\nCurrent text:\nLine 1\nLine 2", options: [], multiSelect: false, allowOther: true }],
    });
    await expect(
      instance.adapter.respondToRequest(threadId, "ask-e", { behavior: "answer", message: "Line 1 edited", answers: [{ id: "q1", selected: [], other: "Line 1 edited" }] }),
    ).resolves.toBe("answered");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.uiResponse)).toEqual([
      { uiResponse: { type: "extension_ui_response", id: "ask-e", value: "Line 1 edited" } },
    ]);
    rmSync(dump, { force: true });
    recorder.stop();
    await instance.dispose();

    const dump2 = join(tmpdir(), `murage-pi-input-skip-${newId()}.jsonl`);
    await create("question", { FAKE_PI_DUMP: dump2 });
    const skipped = `t-input-skip-${newId()}`;
    const second = await instance.adapter.sendTurn({ threadId: skipped, text: "go" });
    const input = await recorder.until((e) => e.type === "request.opened" && e.turnId === second.turnId);
    expect(input).toMatchObject({ requestType: "question", tool: "input", questions: [{ id: "q1", question: "Which branch should I use?", header: "branch name", allowOther: true }] });
    await expect(instance.adapter.respondToRequest(skipped, "ask-q", { behavior: "deny" })).resolves.toBe("rejected");
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(readFileSync(dump2, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.uiResponse)).toEqual([
      { uiResponse: { type: "extension_ui_response", id: "ask-q", cancelled: true } },
    ]);
    rmSync(dump2, { force: true });
  });

  it("leaves ordinary asks, isolated computers and questions unscoped so ordinary grants still work", async () => {
    // An ordinary permission ask (a confirm) with no host control.
    await create("host-confirm");
    const plain = `t-plain-scope-${newId()}`;
    const first = await instance.adapter.sendTurn({ threadId: plain, text: "go" });
    const ordinary = (await recorder.until((e) => e.type === "request.opened" && e.turnId === first.turnId)) as unknown as OpenedAsk;
    expect(ordinary).not.toHaveProperty("approvalScope");
    expect(
      autoVerdict({ alwaysAllow: [approvalKey(ordinary.tool, ordinary.summary)!] }, ordinary.tool, ordinary.summary, {
        scope: ordinary.approvalScope,
      }),
    ).toMatchObject({ source: "always-allow" });
    await instance.adapter.respondToRequest(plain, "ask-host", { behavior: "allow" });
    expect(await recorder.until((e) => e.type === "request.resolved" && e.turnId === first.turnId)).not.toHaveProperty(
      "approvalScope",
    );
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    recorder.stop();
    await instance.dispose();

    // An isolated computer (Cua VM / VPS) mounts without host-control scope.
    await create("host-confirm");
    const vm = `t-vm-scope-${newId()}`;
    const second = await instance.adapter.sendTurn({
      threadId: vm,
      text: "click it",
      integrations: { localComputer: { command: process.execPath, args: ["vm-mcp.js"], env: {} } },
    });
    expect(await recorder.until((e) => e.type === "request.opened" && e.turnId === second.turnId)).not.toHaveProperty(
      "approvalScope",
    );
    await instance.adapter.respondToRequest(vm, "ask-host", { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    recorder.stop();
    await instance.dispose();

    // A question on a host-controlling turn is not a permission.
    await create("question");
    const asked = `t-question-scope-${newId()}`;
    const third = await instance.adapter.sendTurn({ threadId: asked, text: "go", integrations: hostControl });
    const question = await recorder.until((e) => e.type === "request.opened" && e.turnId === third.turnId);
    expect(question).toMatchObject({ requestType: "question" });
    expect(question).not.toHaveProperty("approvalScope");
    await expect(
      instance.adapter.respondToRequest(asked, "ask-q", { behavior: "answer", message: "main" }),
    ).resolves.toBe("answered");
    expect(await recorder.until((e) => e.type === "request.resolved" && e.turnId === third.turnId)).not.toHaveProperty(
      "approvalScope",
    );
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === third.turnId);
  });

  it("respondToRequest is unavailable for an ask that is not pending", async () => {
    await create();
    await expect(instance.adapter.respondToRequest("t-none", "nope", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("interruptTurn cancels a running turn", async () => {
    await create("permission");
    await instance.adapter.sendTurn({ threadId: "t-interrupt", text: "go" });
    await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.interruptTurn("t-interrupt");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    // a user Stop never surfaces as a runtime error card (STOP1)
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toEqual([]);
  });

  it("close-confirmed stop: interruptTurn resolves only after the pi child has exited", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "murage-pi-close-"));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    try {
      const pidFile = join(scratch, "pi.pid");
      await create("permission", { FAKE_PI_PID_FILE: pidFile, FAKE_PI_LINGER_MS: "400" });
      const threadId = "t-close-confirmed";
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: "go" });
      await recorder.until((e) => e.type === "request.opened");
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(alive(pid)).toBe(true);
      await expect(instance.adapter.interruptTurn(threadId)).resolves.toEqual({ closeConfirmed: true });
      expect(alive(pid)).toBe(false);
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toEqual([
        expect.objectContaining({ turnId, ok: true, stopReason: "cancelled" }),
      ]);
      await expect(instance.adapter.awaitTurnTeardown!(threadId, turnId)).resolves.toEqual({ closeConfirmed: true });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("writes models.json and set_model for a host::model inject pick", async () => {
    const home = mkdtempSync(join(tmpdir(), "murage-pi-turn-inject-"));
    const dump = join(home, "dump.jsonl");
    await create(undefined, { HOME: home, FAKE_PI_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-inject",
      text: "hi",
      model: encodeInjectId("omlx", "MiniMax-M3-4bit"),
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const dumps = readFileSync(dump, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { setModel?: { provider: string; modelId: string } });
    expect(dumps.some((row) => row.setModel?.provider === "omlx" && row.setModel?.modelId === "MiniMax-M3-4bit")).toBe(
      true,
    );
    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8")) as {
      providers: { omlx: { baseUrl: string; models: Array<{ id: string }> } };
    };
    expect(written.providers.omlx.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(written.providers.omlx.models.some((m) => m.id === "MiniMax-M3-4bit")).toBe(true);
  });
});

describe("splitPiModel", () => {
  it("splits native provider/model composites, including slashes in the model id", () => {
    expect(splitPiModel("ollama-cloud/glm-5.2")).toEqual({ provider: "ollama-cloud", modelId: "glm-5.2" });
    expect(splitPiModel("openai/gpt-4o")).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(splitPiModel("openrouter/qwen/qwen3-coder-next")).toEqual({
      provider: "openrouter",
      modelId: "qwen/qwen3-coder-next",
    });
  });

  it("splits live-host inject ids on ::, not /", () => {
    expect(splitPiModel("omlx::MiniMax-M3-4bit")).toEqual({ provider: "omlx", modelId: "MiniMax-M3-4bit" });
    expect(splitPiModel("ollama::llama3.1:70b")).toEqual({ provider: "ollama", modelId: "llama3.1:70b" });
    expect(splitPiModel("unsloth::unsloth/gemma-4-26B-A4B-it-GGUF")).toEqual({
      provider: "unsloth",
      modelId: "unsloth/gemma-4-26B-A4B-it-GGUF",
    });
  });

  it("returns null for empty or unstructured ids", () => {
    expect(splitPiModel("")).toBeNull();
    expect(splitPiModel("glm-5.2")).toBeNull();
  });
});

describe("preferPiInjectRows", () => {
  it("drops host/model rows when the same live host::model is present", () => {
    const catalog = preferPiInjectRows({
      default: "omlx/MiniMax-M3-4bit",
      options: [
        { id: "omlx/MiniMax-M3-4bit", label: "MiniMax-M3-4bit", custom: true },
        { id: "openai/gpt-4o", label: "GPT-4o", custom: true },
        { id: "omlx::MiniMax-M3-4bit", label: "MiniMax-M3-4bit (oMLX)", custom: true, loaded: true },
      ],
    });
    expect(catalog.options.map((o) => o.id)).toEqual(["openai/gpt-4o", "omlx::MiniMax-M3-4bit"]);
    expect(catalog.default).toBe("omlx::MiniMax-M3-4bit");
  });

  it("leaves the catalog alone when there are no inject rows", () => {
    const catalog = {
      default: "omlx/keep",
      options: [{ id: "omlx/keep", label: "keep", custom: true as const }],
    };
    expect(preferPiInjectRows(catalog)).toEqual(catalog);
  });
});

describe("ensurePiInjectModel", () => {
  it("upserts a provider into ~/.pi/agent/models.json without dropping existing models", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-pi-inject-"));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "models.json"),
      JSON.stringify({
        providers: {
          omlx: {
            baseUrl: "http://127.0.0.1:8080/v1",
            api: "openai-completions",
            apiKey: "omlx",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
            models: [{ id: "keep-me", name: "Keep me", contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      }),
    );
    const split = ensurePiInjectModel("omlx::MiniMax-M3-4bit", { HOME: home });
    expect(split).toEqual({ provider: "omlx", modelId: "MiniMax-M3-4bit" });
    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8")) as {
      providers: {
        omlx: {
          baseUrl: string;
          api: string;
          apiKey: string;
          models: Array<{ id: string; contextWindow?: number }>;
        };
      };
    };
    expect(written.providers.omlx.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(written.providers.omlx.api).toBe("openai-completions");
    expect(written.providers.omlx.apiKey).toBe("omlx");
    expect(written.providers.omlx.models.map((m) => m.id)).toEqual(["keep-me", "MiniMax-M3-4bit"]);
    expect(written.providers.omlx.models[0]).toMatchObject({ id: "keep-me", contextWindow: 8192 });
  });

  it("writes Unsloth's studio token, not the placeholder", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-pi-unsloth-"));
    const split = ensurePiInjectModel("unsloth::Qwen3.8-27B", {
      HOME: home,
      UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret",
    });
    expect(split).toEqual({ provider: "unsloth", modelId: "Qwen3.8-27B" });
    const written = JSON.parse(readFileSync(join(home, ".pi", "agent", "models.json"), "utf8")) as {
      providers: { unsloth: { apiKey: string; baseUrl: string } };
    };
    expect(written.providers.unsloth.apiKey).toBe("unsloth-secret");
    expect(written.providers.unsloth.baseUrl).toBe(localHost("unsloth")!.baseUrl);
  });

  it("leaves official slugs and the models.json file untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-pi-cloud-"));
    expect(ensurePiInjectModel("openai/gpt-4o", { HOME: home })).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(() => readFileSync(join(home, ".pi", "agent", "models.json"))).toThrow();
  });

  it("does not destroy a malformed models.json", () => {
    const home = mkdtempSync(join(tmpdir(), "murage-pi-badjson-"));
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const path = join(home, ".pi", "agent", "models.json");
    writeFileSync(path, "not json");
    expect(ensurePiInjectModel("omlx::MiniMax-M3-4bit", { HOME: home })).toEqual({
      provider: "omlx",
      modelId: "MiniMax-M3-4bit",
    });
    expect(readFileSync(path, "utf8")).toBe("not json");
  });
});

describe("applyPiLocalCatalog", () => {
  it("merges live inject rows onto the probed catalog", async () => {
    const catalog = await applyPiLocalCatalog(
      {
        default: "openai/gpt-4o",
        options: [
          { id: "openai/gpt-4o", label: "GPT-4o", custom: true },
          { id: "omlx/MiniMax-M3-4bit", label: "MiniMax-M3-4bit", custom: true },
        ],
      },
      { VITEST: "true", MURAGE_PROBE_LOCAL_INJECT: "1" },
      async (url) => {
        if (String(url).includes(":8080")) {
          return new Response(JSON.stringify({ data: [{ id: "MiniMax-M3-4bit" }] }), { status: 200 });
        }
        return new Response("nope", { status: 500 });
      },
    );
    expect(catalog.options.some((o) => o.id === "omlx::MiniMax-M3-4bit")).toBe(true);
    expect(catalog.options.some((o) => o.id === "omlx/MiniMax-M3-4bit")).toBe(false);
    expect(catalog.options.some((o) => o.id === "openai/gpt-4o")).toBe(true);
  });
});

describe("PiDriver snapshot", () => {
  beforeEach(() => chmodSync(FAKE_CLI, 0o755));

  it("reports available with the CLI version against the fake", async () => {
    const instance = await PiDriver.create({
      instanceId: "pi-snap",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.version).toBe("pi 0.84.2 (fake)");
    expect(snap.authenticated).toBe(true);
    await instance.dispose();
  });

  it("reports unavailable with a reason when the CLI is missing", async () => {
    const instance = await PiDriver.create({
      instanceId: "pi-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "pi-definitely-not-on-path-xyz", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toMatch(/not found/);
    await instance.dispose();
  });
});
// A4: pi RPC stdout is framed with a byte bound before any parse.
describe("PiDriver bounded ingress (A4)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async () => {
    instance = await PiDriver.create({
      instanceId: "pi-bounded",
      displayName: "pi Bounded",
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
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("fails only the turn whose frame is over the limit, even when turn_end follows it", async () => {
    await create();
    const oversized = await instance.adapter.sendTurn({ threadId: "t-oversize", text: "__fixture_oversize_frame__", model: "ollama-cloud/glm-5.2" });
    const ordinary = await instance.adapter.sendTurn({ threadId: "t-ordinary", text: "hi", model: "ollama-cloud/glm-5.2" });
    const failed = await recorder.until((e) => e.type === "turn.completed" && e.turnId === oversized.turnId);
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === ordinary.turnId);

    expect(failed).toMatchObject({ ok: false, stopReason: "frame_too_large" });
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "runtime.error",
      threadId: "t-oversize",
      message: expect.stringMatching(/^pi sent a protocol message larger than 32 MiB/),
    }));
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "item.completed", itemType: "assistant_text", threadId: "t-ordinary", text: "Hello from pi",
    }));
    expect(noLargePayload("t-oversize")).toBe(true);
    expect(recorder.events.filter((e) => e.type === "turn.completed" && e.turnId === oversized.turnId)).toHaveLength(1);
  });

  it("fails an unterminated oversized frame without waiting for a newline", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-open", text: "__fixture_oversize_open_frame__", model: "ollama-cloud/glm-5.2" });
    const failed = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(failed).toMatchObject({ ok: false, stopReason: "frame_too_large" });
    expect(noLargePayload("t-open")).toBe(true);
  });

  it("still carries a valid 14 MiB multibyte frame intact", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-large", text: "__fixture_large_frame__", model: "ollama-cloud/glm-5.2" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect(done).toMatchObject({ ok: true });
    const reply = recorder.events.find((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.threadId === "t-large");
    const text = (reply as { text: string } | undefined)?.text ?? "";
    expect(text.startsWith("éé")).toBe(true);
    expect(Buffer.byteLength(text)).toBe(14 * 1024 * 1024 + Buffer.byteLength("Hello from pi"));
  });

  it("resolves the catalog probe empty on an oversized frame instead of waiting for its timeout", async () => {
    const started = Date.now();
    const catalog = await fetchPiModels(FAKE_CLI, {
      PATH: process.env.PATH ?? "",
      HOME: join(tmpdir(), "murage-pi-oversize"),
      FAKE_PI_MODE: "oversize-catalog",
    });
    expect(catalog).toEqual({ default: "", options: [] });
    // the probe's own fallback timer is 15 s; the frame bound answers first
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
