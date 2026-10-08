// Fuigo × Murage. Four things are pinned here, and each of them is a bug
// this driver would otherwise ship:
//
//  1. ARGV ORDER. `-m` before the `agent` subcommand is silently accepted by
//     the real CLI and then ignored (the Grok Build bug, inherited by the
//     fork). Asserting the flat array is not enough — the assertions below
//     assert the POSITIONS relative to `agent` and `stdio`, because that is
//     what the CLI actually reads.
//  2. WHICH ENV HOOK. Fuigo's credential must reach the CATALOG spawn and the
//     SNAPSHOT, not just the turn, so it lives in `transformEnv`. The catalog
//     spawn's env is dumped separately from the turn's precisely so a move to
//     `applyTurnEnv` (core.ts:323, the hook the other Flux drivers use) fails
//     loudly instead of degrading the picker in silence.
//  3. NO `applyFluxSurface`. Fuigo is a native FluxRouter client; writing
//     OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL here would be a lie in the
//     env. Their ABSENCE is asserted, which is the only way a copy-paste from
//     qwen.ts gets caught.
//  4. THE BUNDLED BINARY IS ACTUALLY REACHABLE. `resolveFuigoCli` had zero
//     callers before this driver; the test with no `fuigo` on PATH and a
//     staged `MURAGE_FUIGO_DIR` is the one that proves the 165MB engine
//     Murage ships can be spawned at all.
//
// These read the child's real argv and env off a purpose-built fake rather
// than calling the hooks directly, because the interesting failures are
// ordering ones: the credential strip runs between the driver and the spawn
// (core.ts:204-212). The shared `fake-acp-cli.ts` cannot be used for the env
// half — its dump carries a fixed allowlist of variable names that does not
// include FUIGO_API_KEY, so every assertion here would pass vacuously.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

// core.ts reads MURAGE_ACP_SESSION_CONFIG_MS once at import, so it has to be
// set before the imports below run. Short enough for the hung set_model test,
// long enough that a loaded machine never trips it on the fake's instant reply.
vi.hoisted(() => { process.env.MURAGE_ACP_SESSION_CONFIG_MS = "1500"; });

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { resetPathCacheForTests, restrictInstallScanDirsForTests } from "../../env-path.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { fixtureCredentialFingerprint } from "../../testing/fixture-dump.ts";
import { ensureFuigoLocalModel, FuigoAgentDriver, fuigoLocalKeyEnv, fuigoLocalSlug, FUIGO_EXTERNAL_MCP_GATES, isolateFuigoFromExternalMcp, parseFuigoModels, scrubFuigoCredentialEnv, STATIC_FUIGO_MODELS } from "./fuigo.ts";
import { noteFluxKeyRefused, resetFluxKeyHealthForTests } from "../../flux-key-health.ts";
import { fluxKeyState } from "../../flux-config.ts";
import { acpVersionFailureDetail, createAcpDriver, FALLBACK_CAP_LINE, MCP_OWN_READY_WAIT_MS, MCP_READY_WAIT_MS, type AcpSupport } from "./core.ts";
import { configureLocalServerStore, writeLocalServers } from "../../local-servers.ts";
import { localHost } from "../local-inject.ts";

// The pinned bundle version, read from the packaging script (one source of truth).
const FUIGO_VERSION = /FUIGO_VERSION = "(\d+\.\d+\.\d+)"/.exec(readFileSync(new URL("../../../scripts/prepare-fuigo.mjs", import.meta.url), "utf8"))![1]!;

/** Shape only, never a live credential. */
const FLUX_KEY = "sk-flux-Ffffffffffffffffffffffffffffffffffffffffff";
/** A user's own Flux key, set in their shell rather than in Murage. Shape only. */
const USER_OWN_FLUX_KEY = "sk-flux-Uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu";

/** Verbatim `fuigo models` stdout (1.0.2), trimmed to one row per family. */
const REAL_MODELS_OUTPUT = `You are using FUIGO_API_KEY.

Default model: flux-auto

Available models:
  - claude-opus-5
  - claude-sonnet-5
  * flux-auto (default)
  - flux-fast
  - flux-image-nano-banana-pro
  - flux-pinned-claude-opus-5
  - flux-pinned-gpt-5
  - flux-reasoning
  - flux-standard
  - flux-voice-fast
  - gpt-image-med
  - nano-banana-pro-4k
`;

/**
 * A stand-in `fuigo` binary.
 *
 * Dumps `{argv, env}` per SUBCOMMAND — `models.json`, `version.json`,
 * `agent.json` — so a test can tell the catalog spawn's env apart from the
 * turn's. That separation is the whole point: it is what turns "the wrong env
 * hook" from a silent picker regression into a failing assertion.
 *
 * Spawned as `"<node>" "<script>"` rather than through a shebang. That form is
 * a first-class `cli` value (`splitCliString` / `resolveCliSpawn`,
 * env-path.ts:321-343 — the Engines panel's wrapper-script case), it needs no
 * executable bit, and it is the only shape that behaves identically on Windows,
 * where there is no shebang at all.
 */
const FAKE_SOURCE = `import { appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";
const argv = process.argv.slice(2);
const kind = argv.includes("--version") ? "version" : argv[0] === "models" ? "models" : "agent";
// Explicit fields only; credentials are fixture-dump.ts fingerprints, never values.
const PLAIN = ["FUIGO_ALLOW_UPSTREAM_HOSTS", "PATH", "HOME", "FUIGO_HOME", "FUIGO_MEMORY", "FUIGO_CLAUDE_SKILLS_ENABLED", "FUIGO_CLAUDE_RULES_ENABLED", "FUIGO_CLAUDE_AGENTS_ENABLED", "FUIGO_CLAUDE_MCPS_ENABLED", "FUIGO_CLAUDE_HOOKS_ENABLED", "FUIGO_CLAUDE_SESSIONS_ENABLED", "FUIGO_CURSOR_SKILLS_ENABLED", "FUIGO_CURSOR_RULES_ENABLED", "FUIGO_CURSOR_AGENTS_ENABLED", "FUIGO_CURSOR_MCPS_ENABLED", "FUIGO_CURSOR_HOOKS_ENABLED", "FUIGO_CURSOR_SESSIONS_ENABLED", "FUIGO_CODEX_SKILLS_ENABLED", "FUIGO_CODEX_RULES_ENABLED", "FUIGO_CODEX_AGENTS_ENABLED", "FUIGO_CODEX_MCPS_ENABLED", "FUIGO_CODEX_HOOKS_ENABLED", "FUIGO_CODEX_SESSIONS_ENABLED", "FUIGO_AGENTS_SKILLS_ENABLED", "OPENAI_BASE_URL", "OPENAI_MODEL"];
const CREDENTIALS = ["FUIGO_API_KEY", "FUIGO_CODE_API_KEY", "FLUX_API_KEY", "MURAGE_FLUX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY",
  ...Object.keys(process.env).filter((key) => /^MURAGE_LOCAL_[A-Z0-9_]+_API_KEY$/.test(key))];
const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
const dumpEnv = Object.fromEntries([...PLAIN.map((key) => [key, process.env[key]]), ...CREDENTIALS.map((key) => [key, process.env[key] === undefined ? undefined : fingerprint(process.env[key])])]
  .filter(([, value]) => value !== undefined));
if (process.env.FUIGO_FAKE_DUMP_DIR) {
  writeFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, kind + ".json"), JSON.stringify({ argv, env: dumpEnv }));
}
if (kind === "version") { console.log("fuigo 1.0.4 (fake)"); process.exit(0); }
if (kind === "models") {
  // One line per catalog spawn: each is a GET /v1/models (and /api-key) at Flux.
  if (process.env.FUIGO_FAKE_DUMP_DIR) appendFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "models.log"), "spawn\\n");
  if (process.env.FUIGO_FAKE_MODELS_STDERR) process.stderr.write(process.env.FUIGO_FAKE_MODELS_STDERR);
  process.stdout.write(process.env.FUIGO_FAKE_MODELS ?? "");
  process.exit(Number(process.env.FUIGO_FAKE_MODELS_EXIT ?? 0));
}
const SID = "fake-fuigo-session";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (process.env.FUIGO_FAKE_DUMP_DIR) appendFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "spawns.log"), process.pid + "\\n");
// MCP readiness, as 1.0.19/1.0.20 report it: session/new answers first and
// \`_fuigo/mcp_initialized\` follows once the handed servers settle.
// FUIGO_FAKE_MCP: "ready" (default, after the response), "before" (ahead of
// the response), "never". Only sent when mcpServers is non-empty.
const mcpMode = process.env.FUIGO_FAKE_MCP ?? "ready";
const order = (event) => {
  if (process.env.FUIGO_FAKE_DUMP_DIR) appendFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "order.log"), event + " " + Date.now() + "\\n");
};
const mcpReady = (sessionId) => {
  order("mcp-ready:" + sessionId);
  send({ jsonrpc: "2.0", method: "_fuigo/mcp_initialized", params: { sessionId, mcpToolCount: 1, elapsedMs: 1 } });
};
// Interjections that missed the running turn's final drain. Fuigo runs each
// as its own interject-fallback turn once the prompt result is out.
const stranded = [];
let promptRunning = false;
let fallbacks = 0;
// FUIGO_FAKE_FALLBACK_HELPER=1: the fallback starts a background helper that
// outlives it, asks for a permission and reports after FUIGO_FAKE_HELPER_MS.
// FUIGO_FAKE_FALLBACK_EXIT=1: the process exits in the middle of the fallback.
const runFallback = (text, delayMs = 100) => {
  const promptId = "interject-fallback-000" + (++fallbacks);
  setTimeout(() => {
    order("fallback-start");
    send({ jsonrpc: "2.0", method: "_fuigo/queue/changed", params: { sessionId: SID, entries: [], runningPromptId: promptId, runningText: text, runningKind: "prompt" } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " fallback reply #" + fallbacks } } } });
    if (process.env.FUIGO_FAKE_FALLBACK_EXIT === "1") setTimeout(() => { order("fallback-exit"); process.exit(3); }, 100);
    if (process.env.FUIGO_FAKE_FALLBACK_HELPER === "1") {
      send({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: SID,
        update: { sessionUpdate: "subagent_spawned", subagent_id: "helper-1", description: "Background check" } } });
      setTimeout(() => {
        order("helper-ask");
        send({ jsonrpc: "2.0", id: "helper-permission", method: "session/request_permission", params: { sessionId: SID,
          toolCall: { toolCallId: "helper-tool", kind: "execute", title: "helper write" },
          options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }] } });
      }, Number(process.env.FUIGO_FAKE_HELPER_MS ?? 1200));
    }
    setTimeout(() => {
      order("fallback-end");
      send({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: SID,
        update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" } } });
      send({ jsonrpc: "2.0", method: "_fuigo/queue/changed", params: { sessionId: SID, entries: [] } });
    }, Number(process.env.FUIGO_FAKE_FALLBACK_MS ?? 600));
  }, delayMs);
};
const helperAnswered = (decision) => {
  if (process.env.FUIGO_FAKE_DUMP_DIR) appendFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "helper.log"), JSON.stringify(decision) + "\\n");
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " helper result" } } } });
  setTimeout(() => {
    order("helper-end");
    send({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: SID,
      update: { sessionUpdate: "subagent_finished", subagent_id: "helper-1", status: "completed" } } });
  }, 200);
};
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const ok = (r) => send({ jsonrpc: "2.0", id: m.id, result: r });
    if (m.id === "helper-permission" && !m.method) { helperAnswered(m.result); continue; }
    if (m.method === "initialize") ok({ protocolVersion: 1, authMethods: [{ id: "fuigo.api_key" }], ...(process.env.FUIGO_FAKE_RETRY_DISCARD ? { agentCapabilities: { _meta: { "fuigo/capabilities": { retryDiscard: { version: 1 } } } } } : {}) });
    else if (m.method === "authenticate") ok({});
    else if (m.method === "session/new") {
      if (process.env.FUIGO_FAKE_DUMP_DIR) writeFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "session.json"), JSON.stringify(m.params));
      const hasMcp = Array.isArray(m.params?.mcpServers) && m.params.mcpServers.length > 0;
      if (hasMcp) send({ jsonrpc: "2.0", method: "_fuigo/mcp/init_progress", params: { sessionId: SID, total: 1, connected: 0 } });
      if (hasMcp && mcpMode === "before") mcpReady(SID);
      ok(process.env.FUIGO_FAKE_NEW_MODEL ? { sessionId: SID, models: { currentModelId: process.env.FUIGO_FAKE_NEW_MODEL, availableModels: [] } } : { sessionId: SID });
      order("new-response");
      // 1.0.x advertises its "/" commands right after session/new
      // (session_setup.rs send_available_commands_update), before any prompt.
      if (process.env.FUIGO_FAKE_COMMANDS) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID,
        update: { sessionUpdate: "available_commands_update", availableCommands: JSON.parse(process.env.FUIGO_FAKE_COMMANDS) } } });
      // An external (plugin) server is hung: the engine counts it in total
      // and never sends mcp_initialized. "external": Murage's own mount (1 of
      // 2) connects after 150 ms. "stuck": nothing ever connects.
      if (hasMcp && (mcpMode === "external" || mcpMode === "stuck")) {
        send({ jsonrpc: "2.0", method: "_fuigo/mcp/init_progress", params: { sessionId: SID, total: 2, connected: 0 } });
        if (mcpMode === "external") setTimeout(() => send({ jsonrpc: "2.0", method: "_fuigo/mcp/init_progress", params: { sessionId: SID, total: 2, connected: 1 } }), 150);
      }
      // "late": another server connects at once (the count reaches Murage's
      // mounts), but the all-settled notification only comes after 1.2 s.
      if (hasMcp && mcpMode === "late") {
        setTimeout(() => send({ jsonrpc: "2.0", method: "_fuigo/mcp/init_progress", params: { sessionId: SID, total: 2, connected: 1 } }), 150);
        setTimeout(() => mcpReady(SID), 1200);
      }
      if (hasMcp && mcpMode === "ready") {
        // Another session's readiness must not release this one.
        mcpReady("some-other-session");
        setTimeout(() => mcpReady(SID), Number(process.env.FUIGO_FAKE_MCP_DELAY_MS ?? 0));
      }
    }
    else if (m.method === "session/load") {
      // A session this process already holds (the pool's reuse, #1575):
      // re-applied servers are announced again, as 1.0.20 does.
      if (process.env.FUIGO_FAKE_DUMP_DIR) appendFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "loads.log"), JSON.stringify(m.params) + "\\n");
      ok(process.env.FUIGO_FAKE_CURRENT_MODEL ? { models: { currentModelId: process.env.FUIGO_FAKE_CURRENT_MODEL, availableModels: [] } } : {});
      if (Array.isArray(m.params?.mcpServers) && m.params.mcpServers.length) mcpReady(m.params.sessionId);
    }
    else if (m.method === "session/set_model") {
      order("set-model");
      if (process.env.FUIGO_FAKE_DUMP_DIR) appendFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "set-model.log"), JSON.stringify(m.params) + "\\n");
      if (process.env.FUIGO_FAKE_SET_MODEL_HANG) { /* never answers */ }
      else if (process.env.FUIGO_FAKE_SET_MODEL_ERROR) send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: process.env.FUIGO_FAKE_SET_MODEL_ERROR } });
      else ok({});
    }
    else if (m.method === "session/prompt") {
      order("prompt");
      if (process.env.FUIGO_FAKE_DUMP_DIR) writeFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "prompt.json"), JSON.stringify(m.params));
      if (process.env.FUIGO_FAKE_DUMP_DIR) appendFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "prompts.log"), JSON.stringify(m.params) + "\\n");
      // FUIGO_FAKE_SCRIPT: a JSON array of raw messages sent in place of the "ok" chunk.
      if (process.env.FUIGO_FAKE_SCRIPT) for (const raw of JSON.parse(process.env.FUIGO_FAKE_SCRIPT)) send(raw);
      else send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
      // FUIGO_FAKE_HOLD_MS keeps the turn running so a test can steer it.
      const holdMs = Number(process.env.FUIGO_FAKE_HOLD_MS ?? 0);
      promptRunning = true;
      const finish = () => {
        promptRunning = false;
        // FUIGO_FAKE_PROMPT_HELPER=1: a background helper is still open when the prompt ends.
        if (process.env.FUIGO_FAKE_PROMPT_HELPER === "1") send({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: SID,
          update: { sessionUpdate: "subagent_spawned", subagent_id: "prompt-helper", description: "Background check" } } });
        // The prompt's own durable turn end, ahead of its result.
        send({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: SID,
          update: { sessionUpdate: "turn_completed", prompt_id: "prompt-original", stop_reason: "end_turn" } } });
        ok({ stopReason: "end_turn" });
        // FUIGO_FAKE_AFTER_SCRIPT: raw messages sent 150 ms after the prompt result.
        if (process.env.FUIGO_FAKE_AFTER_SCRIPT) setTimeout(() => { for (const raw of JSON.parse(process.env.FUIGO_FAKE_AFTER_SCRIPT)) send(raw); }, 150);
        if (process.env.FUIGO_FAKE_PROMPT_EXIT_MS) setTimeout(() => { order("prompt-exit"); process.exit(3); }, Number(process.env.FUIGO_FAKE_PROMPT_EXIT_MS));
        if (stranded.length) runFallback(stranded.shift());
      };
      if (holdMs > 0) setTimeout(finish, holdMs); else finish();
    } else if (m.method === "_fuigo/interject") {
      // FUIGO_FAKE_INTERJECT: "ok" (default) queues and echoes; "nomethod" is
      // method-not-found, as a build without the extension answers;
      // "fallback" queues and echoes, misses the final drain and runs as an
      // interject-fallback turn after the prompt result; "slowack" echoes at
      // once and answers after FUIGO_FAKE_ACK_DELAY_MS; "silent" answers
      // nothing and echoes after FUIGO_FAKE_LATE_ECHO_MS.
      if (process.env.FUIGO_FAKE_DUMP_DIR) appendFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "interjects.log"), JSON.stringify(m.params) + "\\n");
      const mode = process.env.FUIGO_FAKE_INTERJECT ?? "ok";
      const echo = () => send({ jsonrpc: "2.0", method: "_fuigo/session/interjection", params: { sessionId: m.params.sessionId, text: m.params.text, interjectionId: m.params.interjectionId } });
      if (mode === "nomethod") send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
      else if (mode === "slowack") {
        echo();
        const id = m.id;
        setTimeout(() => send({ jsonrpc: "2.0", id, result: { result: { status: "queued" } } }), Number(process.env.FUIGO_FAKE_ACK_DELAY_MS ?? 6000));
      } else if (mode === "silent") {
        setTimeout(echo, Number(process.env.FUIGO_FAKE_LATE_ECHO_MS ?? 2000));
      } else {
        // real Fuigo 1.0.21 double-wraps ext results: {"result":{"result":{"status":"queued"}}}
        ok(mode === "flat" ? { status: "queued" } : { result: { status: "queued" } });
        echo();
        // FUIGO_FAKE_POST_ECHO_TEXT: the reply keeps streaming after the echo.
        if (process.env.FUIGO_FAKE_POST_ECHO_TEXT) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.FUIGO_FAKE_POST_ECHO_TEXT } } } });
        // One arriving while no prompt runs becomes a fallback turn at once
        // (after FUIGO_FAKE_IDLE_FALLBACK_DELAY_MS); one inside the prompt
        // misses its final drain and runs after the result.
        if (mode === "fallback" && promptRunning) stranded.push(m.params.text);
        else if (mode === "fallback") runFallback(m.params.text, Number(process.env.FUIGO_FAKE_IDLE_FALLBACK_DELAY_MS ?? 100));
      }
    } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nm" } });
  }
});
`;

let root: string;
let home: string;
let dumps: string;
let fakeCli: string;
let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;

function dump(kind: "models" | "version" | "agent"): { argv: string[]; env: Record<string, string> } {
  return JSON.parse(readFileSync(join(dumps, `${kind}.json`), "utf8"));
}

/** Run one turn and hand back exactly what the CLI was spawned with. */
async function runTurn(
  options: { resumeCursor?: string; images?: Array<{ mimeType: string; data: string }>; model?: string; effort?: "low" | "high"; fullAuto?: boolean; environment?: Record<string, string>; integrations?: SendTurnInput["integrations"]; text?: string; system?: string; engineCommand?: SendTurnInput["engineCommand"] } = {},
): Promise<EventRecorder> {
  instance = await FuigoAgentDriver.create({
    instanceId: "fuigo-test",
    displayName: "Fuigo",
    environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps, ...options.environment },
    enabled: true,
    config: { cli: fakeCli, fullAuto: options.fullAuto === true },
  });
  recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({
    threadId: "t-fuigo",
    text: options.text ?? "hi",
    ...(options.system ? { system: options.system } : {}),
    ...(options.engineCommand ? { engineCommand: options.engineCommand } : {}),
    ...("images" in options ? { images: options.images } : {}),
    ...(options.resumeCursor ? { resumeCursor: options.resumeCursor } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.integrations ? { integrations: options.integrations } : {}),
  });
  await recorder.until((e) => e.type === "turn.completed");
  return recorder;
}

beforeEach(() => {
  ensureDirs();
  root = mkdtempSync(join(tmpdir(), "murage-fuigo-"));
  home = join(root, "home");
  dumps = join(root, "dumps");
  mkdirSync(home, { recursive: true });
  mkdirSync(dumps, { recursive: true });
  const script = join(root, "fake-fuigo.mjs");
  writeFileSync(script, FAKE_SOURCE);
  fakeCli = `"${process.execPath}" "${script}"`;
  process.env.FLUX_API_KEY = FLUX_KEY;
  process.env.FUIGO_FAKE_MODELS = REAL_MODELS_OUTPUT;
});

afterEach(async () => {
  delete process.env.FLUX_API_KEY;
  delete process.env.FUIGO_FAKE_MODELS;
  delete process.env.FUIGO_FAKE_MODELS_EXIT;
  delete process.env.FUIGO_FAKE_MODELS_STDERR;
  resetFluxKeyHealthForTests();
  delete process.env.FUIGO_API_KEY;
  delete process.env.FUIGO_CODE_API_KEY;
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  recorder = undefined;
  await removeTempDir(root);
});

describe("engine commands", () => {
  // Verbatim shape of fuigo-shell's AvailableCommandsUpdate (agent-client-
  // protocol AvailableCommand: name, description, optional input.hint).
  const COMMANDS = [
    { name: "compact", description: "Compact the conversation", input: { hint: "optional focus" } },
    { name: "always-approve", description: "Approve every tool call without asking" },
    { name: "context", description: "Show context usage" },
  ];

  it("reports the commands Fuigo advertises before the prompt, minus the ones Murage keeps out", async () => {
    const events = await runTurn({ environment: { FUIGO_FAKE_COMMANDS: JSON.stringify(COMMANDS) } });
    const reported = events.events.filter((e) => e.type === "engine.commands");
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      provider: "fuigoAgent",
      threadId: "t-fuigo",
      commands: [
        { name: "compact", description: "Compact the conversation", hint: "optional focus" },
        { name: "context", description: "Show context usage" },
      ],
    });
  });

  it("sends a command turn as the command alone, so Fuigo reads it as one", async () => {
    await runTurn({ text: "/compact keep the plan", system: "You are Moss.", engineCommand: { name: "compact", args: "keep the plan" } });
    const prompt = JSON.parse(readFileSync(join(dumps, "prompt.json"), "utf8")).prompt as Array<{ type: string; text?: string }>;
    expect(prompt[0]).toEqual({ type: "text", text: "/compact keep the plan" });
  });

  it("still puts the persona in front of an ordinary turn", async () => {
    await runTurn({ text: "/not-a-command", system: "You are Moss." });
    const prompt = JSON.parse(readFileSync(join(dumps, "prompt.json"), "utf8")).prompt as Array<{ type: string; text?: string }>;
    expect(prompt[0]!.text).toBe("You are Moss.\n\n/not-a-command");
  });
});

// F4: the system stack rode every turn's message and Fuigo stored each copy in
// its session, so the prompt grew by one stack per turn. It is sent once per
// native session now, and again only when it changes.
describe("the system stack", () => {
  async function turns(steps: Array<{ text: string; system: string; integrations?: SendTurnInput["integrations"] }>, threadId = "t-fuigo-stack"): Promise<string[]> {
    instance = await FuigoAgentDriver.create({
      instanceId: "fuigo-stack",
      displayName: "Fuigo",
      environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps },
      enabled: true,
      config: { cli: fakeCli, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    let done = 0;
    for (const step of steps) {
      await instance.adapter.sendTurn({ threadId, text: step.text, system: step.system, ...(done > 0 ? { resumeCursor: "fake-fuigo-session" } : {}), ...(step.integrations ? { integrations: step.integrations } : {}) });
      done += 1;
      const n = done;
      let seen = 0;
      await recorder.until((e) => e.type === "turn.completed" && ++seen === n);
    }
    return readFileSync(join(dumps, "prompts.log"), "utf8").trim().split("\n")
      .map((line) => (JSON.parse(line).prompt as Array<{ text: string }>)[0]!.text);
  }

  it("goes out with the first turn, not with the next one that has not changed", async () => {
    const sent = await turns([
      { text: "one", system: "You are Moss. Rules: be brief." },
      { text: "two", system: "You are Moss. Rules: be brief." },
      { text: "three", system: "You are Moss. Rules: be brief." },
    ]);
    expect(sent).toEqual(["You are Moss. Rules: be brief.\n\none", "two", "three"]);
  });

  it("goes out again when it changes, and then holds still again", async () => {
    const sent = await turns([
      { text: "one", system: "You are Moss." },
      { text: "two", system: "You are Moss. New rule: no lists." },
      { text: "three", system: "You are Moss. New rule: no lists." },
    ]);
    expect(sent).toEqual(["You are Moss.\n\none", "You are Moss. New rule: no lists.\n\ntwo", "three"]);
  });

  it("is alias-free with memory mounted, so it is sent once while each turn's body carries that turn's own alias", async () => {
    const memory = (): SendTurnInput["integrations"] => ({ memory: { command: process.execPath, args: ["memory"], env: {} } });
    const system = "You are Moss.";
    const sent = await turns([
      { text: "one", system, integrations: memory() },
      { text: "two", system, integrations: memory() },
      { text: "three", system, integrations: memory() },
    ]);
    const alias = /murage-memory-[a-f0-9]{20}/;
    const [body1, body2, body3] = sent.map((text) => text.slice(text.lastIndexOf("For this turn only")));
    // Turn 1 carries the system stack, and the stack names no rotating alias.
    expect(sent[0]).toMatch(/^You are Moss\.\n\n/);
    const stack1 = sent[0]!.slice(0, sent[0]!.indexOf("For this turn only"));
    expect(stack1).toContain("murage-memory__memory_search");
    expect(stack1).not.toMatch(alias);
    // Turn 2 and 3 do not re-send it: the cache hits even though memory is mounted.
    expect(sent[1]).not.toContain("You are Moss.");
    expect(sent[1]).not.toContain("Murage tools are MCP tools");
    expect(sent[1]).toMatch(/\n\ntwo$/);
    expect(sent[2]).toMatch(/\n\nthree$/);
    // The body still names the concrete alias for THIS turn, and it rotates.
    const aliases = [body1, body2, body3].map((body) => body.match(alias)?.[0]);
    expect(aliases.every(Boolean)).toBe(true);
    expect(new Set(aliases).size).toBe(3);
  });
});

// 0.1.60 Windows pass D6: Fuigo cuts a prompt over 25,000 bytes, keeps the
// head and tail, and tells the model to read the rest from a file in its own
// sessions folder (outside the bot's folder). A long routine instruction then
// reached the bot cut off, and under No limits it went reading other
// conversations' session files. Murage sends its prompt verbatim, so the
// whole instruction is what the model reads.
describe("a long prompt", () => {
  it("is sent whole and marked verbatim, so Fuigo never cuts or offloads it", async () => {
    const text = `Routine instruction start. ${"Do this step carefully. ".repeat(2_000)}Routine instruction end.`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(25_000);
    await runTurn({ text });
    const params = JSON.parse(readFileSync(join(dumps, "prompt.json"), "utf8"));
    expect(params._meta).toMatchObject({ verbatim: true });
    expect(params.prompt[0].text).toContain(text);
  });
});

describe("incoming image transport", () => {
  it("delivers exact inline images to ACP and excludes bytes from native logs", async () => {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=";
    await runTurn({ images: [{ mimeType: "image/png", data }] });
    expect(JSON.parse(readFileSync(join(dumps, "prompt.json"), "utf8")).prompt).toEqual([
      { type: "text", text: "hi" }, { type: "image", mimeType: "image/png", data },
    ]);
    expect(readFileSync(join(NATIVE_DIR, "t-fuigo.ndjson"), "utf8")).not.toContain(data);
    expect(instance!.adapter.capabilities.images).toBe(true);
  });
});

describe("parseFuigoModels", () => {
  it("reads the real `fuigo models` layout and honours the (default) tag", () => {
    const catalog = parseFuigoModels(REAL_MODELS_OUTPUT);
    expect(catalog.default).toBe("flux-auto");
    expect(catalog.options.map((o) => o.id)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "flux-auto",
      "flux-fast",
      "flux-pinned-claude-opus-5",
      "flux-pinned-gpt-5",
      "flux-reasoning",
      "flux-standard",
    ]);
  });

  it("drops image and speech rows — they cannot answer a coding turn", () => {
    const ids = parseFuigoModels(REAL_MODELS_OUTPUT).options.map((o) => o.id);
    for (const dropped of [
      "flux-image-nano-banana-pro",
      "flux-voice-fast",
      "gpt-image-med",
      "nano-banana-pro-4k",
    ]) {
      expect(ids).not.toContain(dropped);
    }
  });

  it("treats the unauthenticated banner as no catalog at all", () => {
    // The placeholder rows an unkeyed install prints (claude-opus, gpt-5,
    // gemini-pro) are NOT ids the CLI will accept — offering them would
    // guarantee a failed turn.
    const catalog = parseFuigoModels(
      "You are not authenticated.\n\nDefault model: flux-auto\n\nAvailable models:\n  * flux-auto (default)\n  - claude-opus\n  - gpt-5\n  - gemini-pro\n",
    );
    expect(catalog).toEqual({ default: "", options: [] });
  });

  it("falls back to the `Default model:` header when no row is tagged", () => {
    expect(parseFuigoModels("Default model: flux-fast\n\nAvailable models:\n  - flux-auto\n  - flux-fast\n").default)
      .toBe("flux-fast");
  });

  it("never selects a default that the non-chat filter removed", () => {
    const catalog = parseFuigoModels("Default model: gpt-image-med\n\nAvailable models:\n  - gpt-image-med\n  - flux-auto\n");
    expect(catalog.default).toBe("flux-auto");
  });
});

describe("ACP version diagnostics", () => {
  it("distinguishes a timeout, errno, exit, and empty successful response", () => {
    expect(acpVersionFailureDetail(Object.assign(new Error("private"), { killed: true, signal: "SIGTERM" }))).toContain("within 8 seconds");
    expect(acpVersionFailureDetail(Object.assign(new Error("private"), { code: "EACCES" }))).toBe("is not executable; check its file permissions");
    expect(acpVersionFailureDetail(Object.assign(new Error("private"), { code: 7 }))).toBe("did not start when Murage checked its version; check the engine installation");
    expect(acpVersionFailureDetail(Object.assign(new Error("private"), { code: "ENOENT" }))).toBe("is not installed, or Murage cannot find it on this computer");
    expect(acpVersionFailureDetail(null)).toContain("gave no version");
    // 0.1.60 Linux D13: no raw code reaches Settings > Engines
    for (const error of [null, { code: "ENOENT" }, { code: "EACCES" }, { code: "EPERM" }, { code: 7 }, { code: "ENOSPC" }, { killed: true, signal: "SIGTERM" }])
      expect(acpVersionFailureDetail(error && Object.assign(new Error("private"), error))).not.toMatch(/\(E[A-Z]+\)|\bexit \d|--version|private/);
  });
});

describe("fuigo argv — the ordering trap", () => {
  it("puts -m and --reasoning-effort AFTER `agent` and BEFORE `stdio`", async () => {
    // `fuigo -m X agent stdio` is accepted and then ignored: verified live
    // against 1.0.2, where session/new stayed on flux-auto. Positions, not
    // membership, are what the CLI reads.
    await runTurn({ model: "claude-opus-5", effort: "low" });
    const { argv } = dump("agent");
    expect(argv).toEqual([
      "--permission-mode",
      "default",
      "--no-memory",
      "agent",
      "--no-leader",
      "-m",
      "claude-opus-5",
      "--reasoning-effort",
      "low",
      "stdio",
    ]);
    // --no-leader is not decoration: `[cli] use_leader = true` in the user's own
    // config.toml makes `fuigo agent` attach to a running leader whose
    // permission mode, model and credential are whatever started it.
    expect(argv).toContain("--no-leader");
    const agentAt = argv.indexOf("agent");
    const stdioAt = argv.indexOf("stdio");
    expect(argv.indexOf("-m")).toBeGreaterThan(agentAt);
    expect(argv.indexOf("-m")).toBeLessThan(stdioAt);
    expect(argv.indexOf("--reasoning-effort")).toBeGreaterThan(agentAt);
    expect(argv.indexOf("--reasoning-effort")).toBeLessThan(stdioAt);
  });

  it.each(["0", "1"])("Murage owns memory despite FUIGO_MEMORY=%s", async (value) => {
    await runTurn({ environment: { FUIGO_MEMORY: value } });
    const { argv, env } = dump("agent");
    expect(argv.filter(arg => arg === "--no-memory")).toHaveLength(1);
    expect(argv.indexOf("--no-memory")).toBeLessThan(argv.indexOf("agent"));
    expect(env.FUIGO_MEMORY).toBe(value);
  });

  it("keeps --permission-mode BEFORE `agent` — it is a top-level flag", async () => {
    await runTurn({ model: "flux-auto" });
    const { argv } = dump("agent");
    expect(argv.indexOf("--permission-mode")).toBeLessThan(argv.indexOf("agent"));
  });

  it("asks for permission by default", async () => {
    await runTurn({ model: "flux-auto" });
    expect(dump("agent").argv[1]).toBe("default");
  });

  it("bypasses permissions only under fullAuto", async () => {
    await runTurn({ model: "flux-auto", fullAuto: true });
    expect(dump("agent").argv[1]).toBe("bypassPermissions");
  });

  it("omits -m entirely when the turn names no model", async () => {
    await runTurn({});
    expect(dump("agent").argv).toEqual(["--permission-mode", "default", "--no-memory", "agent", "--no-leader", "stdio"]);
  });
});

describe("fuigo model pick over the wire", () => {
  const lines = (file: string) =>
    existsSync(join(dumps, file)) ? readFileSync(join(dumps, file), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const orderOf = () => readFileSync(join(dumps, "order.log"), "utf8").trim().split("\n").map((l) => l.split(" ")[0]);

  it("sets the model after session/load, before the prompt, because -m is ignored on a loaded session", async () => {
    await runTurn({ model: "flux-auto", resumeCursor: "fake-fuigo-session" });
    expect(lines("loads.log")).toHaveLength(1);
    expect(lines("set-model.log")).toEqual([{ sessionId: "fake-fuigo-session", modelId: "flux-auto" }]);
    const order = orderOf();
    expect(order.indexOf("set-model")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("set-model")).toBeLessThan(order.indexOf("prompt"));
  });

  it("sends the changed model on a reattached turn, the same id -m carries", async () => {
    await runTurn({ model: "flux-fast", resumeCursor: "fake-fuigo-session" });
    expect(lines("set-model.log")).toEqual([{ sessionId: "fake-fuigo-session", modelId: "flux-fast" }]);
    expect(dump("agent").argv).toContain("flux-fast");
  });

  it("fails the turn with a clear message when set_model is refused", async () => {
    instance = await FuigoAgentDriver.create({
      instanceId: "fuigo-test", displayName: "Fuigo",
      environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps, FUIGO_FAKE_SET_MODEL_ERROR: "unknown model" },
      enabled: true, config: { cli: fakeCli, fullAuto: false },
    });
    const rec = recordEvents(instance.adapter);
    recorder = rec;
    await instance.adapter.sendTurn({ threadId: "t-fuigo", text: "hi", model: "flux-fast", resumeCursor: "fake-fuigo-session" });
    const err = await rec.until((e) => e.type === "runtime.error");
    const text = JSON.stringify(err);
    expect(text).toContain("could not switch to the model");
    expect(text).toContain("flux-fast");
    expect(text).not.toMatch(/\u2014|\bsafe|safety/i);
    expect(orderOf()).not.toContain("prompt");
  });

  it("skips set_model when the loaded session already runs the picked model", async () => {
    await runTurn({ model: "flux-auto", resumeCursor: "fake-fuigo-session", environment: { FUIGO_FAKE_CURRENT_MODEL: "flux-auto" } });
    expect(lines("loads.log")).toHaveLength(1);
    expect(lines("set-model.log")).toEqual([]);
  });

  it("still sends set_model when the loaded session runs a different model", async () => {
    await runTurn({ model: "flux-fast", resumeCursor: "fake-fuigo-session", environment: { FUIGO_FAKE_CURRENT_MODEL: "flux-auto" } });
    expect(lines("set-model.log")).toEqual([{ sessionId: "fake-fuigo-session", modelId: "flux-fast" }]);
  });

  it("sends nothing when no model is picked", async () => {
    await runTurn({ resumeCursor: "fake-fuigo-session" });
    expect(lines("set-model.log")).toEqual([]);
  });

  it("session/new advertising the picked model as current sends no set_model", async () => {
    await runTurn({ model: "flux-fast", environment: { FUIGO_FAKE_NEW_MODEL: "flux-fast" } });
    expect(lines("set-model.log")).toEqual([]);
    expect(orderOf()).toContain("prompt");
  });

  it("session/new advertising a different current model sends set_model before the prompt", async () => {
    await runTurn({ model: "flux-fast", environment: { FUIGO_FAKE_NEW_MODEL: "flux-auto" } });
    expect(lines("set-model.log")).toEqual([{ sessionId: "fake-fuigo-session", modelId: "flux-fast" }]);
    const order = orderOf();
    expect(order.indexOf("set-model")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("set-model")).toBeLessThan(order.indexOf("prompt"));
  });

  it("fails the turn and sends no prompt when set_model never answers", async () => {
    instance = await FuigoAgentDriver.create({
      instanceId: "fuigo-test", displayName: "Fuigo",
      environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps, FUIGO_FAKE_SET_MODEL_HANG: "1" },
      enabled: true, config: { cli: fakeCli, fullAuto: false },
    });
    const rec = recordEvents(instance.adapter);
    recorder = rec;
    await instance.adapter.sendTurn({ threadId: "t-fuigo", text: "hi", model: "flux-fast", resumeCursor: "fake-fuigo-session" });
    const err = await rec.until((e) => e.type === "runtime.error");
    expect(JSON.stringify(err)).toContain("could not switch to the model");
    expect(lines("set-model.log")).toHaveLength(1);
    expect(orderOf()).not.toContain("prompt");
  });
});

describe("fuigo engine isolation from the owner's global MCP config", () => {
  // The engine merges $HOME/.claude.json and $HOME/.cursor/mcp.json into the
  // session's MCP set behind two env-resolved compat cells (verified against
  // the 1.0.18 binary, see isolateFuigoFromExternalMcp). Murage must close both
  // for the turn, the catalog spawn, and leave an explicit opt-in alone.
  const poisonOwnerHome = () => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "owner-notion": { command: "/nonexistent/notion", args: [] } } }));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "owner-cursor": { command: "/nonexistent/cursor", args: [] } } }));
  };

  it("turns the Claude Code and Cursor MCP imports off for the engine turn, with the owner's config on disk", async () => {
    poisonOwnerHome();
    await runTurn({ model: "flux-auto" });
    const { env } = dump("agent");
    for (const gate of FUIGO_EXTERNAL_MCP_GATES) expect(env[gate], gate).toBe("0");
    expect(FUIGO_EXTERNAL_MCP_GATES).toHaveLength(19);
  });

  it("applies the same isolation to the catalog spawn, which shares transformEnv", async () => {
    poisonOwnerHome();
    await runTurn({ model: "flux-auto" });
    for (const gate of FUIGO_EXTERNAL_MCP_GATES) expect(dump("models").env[gate], gate).toBe("0");
  });

  it("leaves Murage's own mounts as the only MCP set the engine is handed", () => {
    // The session's mcpServers come from acpMcpServers (core.ts), which never
    // reads the owner's files; the engine-side import is what the gates close.
    const env: Record<string, string | undefined> = {};
    isolateFuigoFromExternalMcp(env);
    expect(Object.keys(env).sort()).toEqual([...FUIGO_EXTERNAL_MCP_GATES].sort());
    expect(Object.values(env).every((value) => value === "0")).toBe(true);
  });

  it("respects an owner who opts back in, in any casing, and does not touch other names", () => {
    const env: Record<string, string | undefined> = { FUIGO_CLAUDE_MCPS_ENABLED: "1", fuigo_cursor_mcps_enabled: "true", FUIGO_HOME: "/x" };
    isolateFuigoFromExternalMcp(env);
    expect(env.FUIGO_CLAUDE_MCPS_ENABLED).toBe("1");
    expect(env.fuigo_cursor_mcps_enabled).toBe("true");
    expect(env.FUIGO_CURSOR_MCPS_ENABLED).toBeUndefined();
    expect(env.FUIGO_HOME).toBe("/x");
    expect(env.FUIGO_CLAUDE_HOOKS_ENABLED).toBe("0");
  });

  it("an explicit opt-in on the engine environment reaches the child", async () => {
    await runTurn({ model: "flux-auto", environment: { FUIGO_CLAUDE_MCPS_ENABLED: "1" } });
    expect(dump("agent").env.FUIGO_CLAUDE_MCPS_ENABLED).toBe("1");
    expect(dump("agent").env.FUIGO_CURSOR_MCPS_ENABLED).toBe("0");
    expect(dump("agent").env.FUIGO_CLAUDE_HOOKS_ENABLED).toBe("0");
  });
});

describe("fuigo credential — transformEnv, not applyTurnEnv", () => {
  it("hands the turn the workspace key under FUIGO_API_KEY", async () => {
    await runTurn({ model: "flux-auto" });
    expect(dump("agent").env.FUIGO_API_KEY).toBe(fixtureCredentialFingerprint(FLUX_KEY));
  });

  it("hands the CATALOG spawn the same key — this is why it is not applyTurnEnv", async () => {
    // `fuigo models` answers with a four-row unauthenticated placeholder when
    // the key is missing. applyTurnEnv (core.ts:323) never runs for the
    // catalog refresh (core.ts:220), so this assertion is the one that fails
    // if the hook is moved.
    await runTurn({ model: "flux-auto" });
    expect(dump("models").env.FUIGO_API_KEY).toBe(fixtureCredentialFingerprint(FLUX_KEY));
    expect(dump("models").argv).toEqual(["models"]);
  });

  it("never lets the raw workspace key ride under its own name", async () => {
    await runTurn({ model: "flux-auto" });
    const { env } = dump("agent");
    expect(env.FLUX_API_KEY).toBeUndefined();
    expect(Object.keys(env).filter((k) => env[k] === fixtureCredentialFingerprint(FLUX_KEY))).toEqual(["FUIGO_API_KEY"]);
  });

  it("writes no OPENAI_* surface — fuigo is already a FluxRouter client", async () => {
    // A copy-paste of qwen's applyFluxSurface call would set all three and
    // point fuigo at a surface it does not read.
    await runTurn({ model: "flux-auto" });
    const { env } = dump("agent");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_MODEL).toBeUndefined();
  });

  it("overrides an ambient FUIGO_CODE_API_KEY so a stale account cannot win", async () => {
    // key_discovery.rs:60-70 reads FUIGO_API_KEY, FUIGO_CODE_API_KEY and
    // FLUX_API_KEY off the same provider row.
    process.env.FUIGO_CODE_API_KEY = "sk-someone-elses-account";
    await runTurn({ model: "flux-auto" });
    const { env } = dump("agent");
    expect(env.FUIGO_CODE_API_KEY).toBeUndefined();
    expect(env.FUIGO_API_KEY).toBe(fixtureCredentialFingerprint(FLUX_KEY));
  });

  it("does not pass an inherited FUIGO_ALLOW_UPSTREAM_HOSTS to an ordinary Flux turn", async () => {
    process.env.FUIGO_ALLOW_UPSTREAM_HOSTS = "1";
    try {
      await runTurn({ model: "flux-auto" });
      expect(dump("models").env.FUIGO_ALLOW_UPSTREAM_HOSTS).toBeUndefined();
      expect(dump("agent").env.FUIGO_ALLOW_UPSTREAM_HOSTS).toBeUndefined();
    } finally { delete process.env.FUIGO_ALLOW_UPSTREAM_HOSTS; }
  });

  it("leaves a user's own credential alone when Murage has no key", async () => {
    // Degrade to the CLI's native auth rather than half-write an env. An
    // install carrying its own FUIGO_API_KEY is a WORKING install.
    delete process.env.FLUX_API_KEY;
    await runTurn({ model: "flux-auto", environment: { FUIGO_API_KEY: USER_OWN_FLUX_KEY } });
    // The CATALOG spawn is asserted first because it happens before the auth
    // gate: it holds the direct evidence even when a regression also stops the
    // turn from spawning at all.
    expect(dump("models").env.FUIGO_API_KEY).toBe(fixtureCredentialFingerprint(USER_OWN_FLUX_KEY));
    expect(dump("agent").env.FUIGO_API_KEY).toBe(fixtureCredentialFingerprint(USER_OWN_FLUX_KEY));
  });
});

describe("fuigo auth gate", () => {
  it("refuses before spawning when there is no key and no ~/.fuigo/auth.json", async () => {
    delete process.env.FLUX_API_KEY;
    const events = await runTurn({ model: "flux-auto" });
    const error = events.events.find((e) => e.type === "runtime.error");
    expect(error).toMatchObject({ setup: true });
    expect(events.events.find((e) => e.type === "turn.completed")).toMatchObject({
      ok: false,
      stopReason: "auth_required",
    });
    // The gate is worth nothing if the CLI ran anyway. `models.json` exists
    // (the catalog refresh always runs); `agent.json` must not.
    expect(existsSync(join(dumps, "agent.json"))).toBe(false);
  });

  it("accepts a `fuigo login` install with no key at all", async () => {
    delete process.env.FLUX_API_KEY;
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    const events = await runTurn({ model: "flux-auto" });
    expect(events.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(existsSync(join(dumps, "agent.json"))).toBe(true);
  });

  it("honours FUIGO_HOME over HOME when looking for the login", async () => {
    // Proven live: `FUIGO_HOME=<dir> fuigo models` wrote config.toml/sessions
    // into that dir and left $HOME untouched, so a HOME-only check would
    // report a scoped install as signed out.
    delete process.env.FLUX_API_KEY;
    const scoped = join(root, "scoped-fuigo");
    mkdirSync(scoped, { recursive: true });
    writeFileSync(join(scoped, "auth.json"), "{}");
    const events = await runTurn({ model: "flux-auto", environment: { FUIGO_HOME: scoped } });
    expect(events.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });
});

describe("fuigo catalog", () => {
  it("takes the live `fuigo models` list over the static fallback", async () => {
    instance = await FuigoAgentDriver.create({
      instanceId: "fuigo-catalog",
      displayName: "Fuigo",
      environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps },
      enabled: true,
      config: { cli: fakeCli, fullAuto: false },
    });
    const ids = instance.models.options.map((o) => o.id);
    // `claude-opus-5` is not a `flux-` id, so it survives `mergeFluxCatalog`'s
    // gate whether or not fuigoAgent is in FLUX_SURFACE yet — which keeps this
    // assertion stable across the orchestrator's wiring change.
    expect(ids).toContain("claude-opus-5");
    expect(ids).not.toContain("gpt-image-med");
    expect(ids).not.toContain("flux-voice-fast");
  });

  it("keeps the static tier list when the CLI cannot answer", async () => {
    process.env.FUIGO_FAKE_MODELS = "You are not authenticated.\n";
    instance = await FuigoAgentDriver.create({
      instanceId: "fuigo-catalog-empty",
      displayName: "Fuigo",
      environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps },
      enabled: true,
      config: { cli: fakeCli, fullAuto: false },
    });
    // Whatever the Flux gate does to the rows, the driver must not have
    // adopted the placeholder ids an unkeyed CLI prints.
    expect(instance.models.options.map((o) => o.id)).not.toContain("gemini-pro");
    expect(STATIC_FUIGO_MODELS.options.map((o) => o.id)).toEqual([
      "flux-auto",
      "flux-reasoning",
      "flux-standard",
      "flux-fast",
    ]);
  });
});

// 2026-10-01: three Windows installs of Murage 0.1.61 sent GET /v1/api-key
// and GET /v1/models to api.fluxrouter.ai every 60-65 s, forever, with the
// base URL as the bearer, a short non-sk value, an empty bearer, or another
// provider's sk- key. Each `fuigo models` spawn is one of those pairs.
describe("fuigo never aims a credential that is not a Flux key at Flux", () => {
  const spawns = () => (existsSync(join(dumps, "models.log")) ? readFileSync(join(dumps, "models.log"), "utf8").split("\n").filter(Boolean).length : 0);
  const create = (environment: Record<string, string> = {}) => FuigoAgentDriver.create({
    instanceId: "fuigo-flux-shape",
    displayName: "Fuigo",
    environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps, ...environment },
    enabled: true,
    config: { cli: fakeCli, fullAuto: false },
  });

  for (const [name, value] of [["the base URL", "https://api.fluxrouter.ai/v1"], ["a short non-sk value", "abc12345xyz"], ["another provider's sk- key", "sk-0123456789abcdef0123456789abcdef"]] as const) {
    it(`asks Flux for nothing when the Flux slot holds ${name}`, async () => {
      process.env.FLUX_API_KEY = value;
      instance = await create();
      expect(spawns()).toBe(0);
      expect(instance.models.options.map((o) => o.id)).not.toContain("gemini-pro");
    });
  }

  it("runs no catalog spawn at all when there is no key", async () => {
    delete process.env.FLUX_API_KEY;
    instance = await create();
    expect(spawns()).toBe(0);
  });

  it("drops an ambient empty or non-Flux FUIGO key instead of passing it on", async () => {
    delete process.env.FLUX_API_KEY;
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    await runTurn({ model: "flux-auto", environment: { FUIGO_API_KEY: "", FUIGO_CODE_API_KEY: "https://api.fluxrouter.ai/v1" } });
    const { env } = dump("agent");
    expect(env.FUIGO_API_KEY).toBeUndefined();
    expect(env.FUIGO_CODE_API_KEY).toBeUndefined();
  });

  it("on Windows, removes every casing of the Fuigo key names before setting its own", () => {
    const env: Record<string, string | undefined> = { Fuigo_Api_Key: "https://api.fluxrouter.ai/v1", fuigo_code_api_key: "sk-0123456789abcdef0123456789abcdef", Path: "C:\\Windows" };
    scrubFuigoCredentialEnv(env, FLUX_KEY, "win32");
    expect(env).toEqual({ Path: "C:\\Windows", FUIGO_API_KEY: FLUX_KEY });
  });

  it("on Windows with no Murage key, keeps a Flux-shaped user key and drops the rest", () => {
    const env: Record<string, string | undefined> = { fuigo_api_key: USER_OWN_FLUX_KEY, FUIGO_CODE_API_KEY: "" };
    scrubFuigoCredentialEnv(env, null, "win32");
    expect(env).toEqual({ fuigo_api_key: USER_OWN_FLUX_KEY });
  });

  it("stops asking after Murage's own Flux call says the key was refused, until the key changes", async () => {
    // Real Fuigo 1.0.20 answers a 401 by falling back to its bundled models
    // and exiting 0, so the fake does the same: the exit code says nothing.
    process.env.FUIGO_FAKE_MODELS = REAL_MODELS_OUTPUT;
    process.env.FUIGO_FAKE_MODELS_EXIT = "0";
    process.env.FUIGO_FAKE_MODELS_STDERR = "warning: models/list failed: HTTP 401 Unauthorized, using bundled models\n";
    instance = await create();
    expect(spawns()).toBe(1);
    expect(fluxKeyState()).toBe("ok");
    noteFluxKeyRefused(FLUX_KEY);
    expect(fluxKeyState()).toBe("refused");
    await instance.refreshModels?.();
    await instance.refreshModels?.({ manual: true });
    expect(spawns()).toBe(1);
    process.env.FLUX_API_KEY = "sk-flux-Nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn";
    expect(fluxKeyState()).toBe("ok");
    await instance.refreshModels?.();
    expect(spawns()).toBe(2);
  });

  it("backs off after a catalog failure that is not a refusal, and a person-initiated refresh skips the wait", async () => {
    process.env.FUIGO_FAKE_MODELS = "";
    process.env.FUIGO_FAKE_MODELS_EXIT = "1";
    instance = await create();
    await instance.refreshModels?.();
    expect(spawns()).toBe(1);
    expect(fluxKeyState()).toBe("ok");
    await instance.refreshModels?.({ manual: true });
    expect(spawns()).toBe(2);
  });

  it("five ordinary failures do not switch the live list off", async () => {
    process.env.FUIGO_FAKE_MODELS = "";
    process.env.FUIGO_FAKE_MODELS_EXIT = "1";
    instance = await create();
    for (let i = 0; i < 6; i++) await instance.refreshModels?.({ manual: true });
    expect(spawns()).toBe(7);
    process.env.FUIGO_FAKE_MODELS = REAL_MODELS_OUTPUT;
    process.env.FUIGO_FAKE_MODELS_EXIT = "0";
    await instance.refreshModels?.({ manual: true });
    expect(spawns()).toBe(8);
  });
});

describe("Fuigo config writer on Windows", () => {
  const SERVER = { id: "srv_win0123456ab", name: "WinBox", kind: "llamacpp" as const, apiBase: "http://127.0.0.1:18080/v1", apiKey: "local-win-key", createdAt: 1, updatedAt: 1 };
  beforeEach(() => {
    configureLocalServerStore(join(root, "data"));
    writeLocalServers([SERVER]);
  });
  afterEach(() => configureLocalServerStore(null));

  it("writes under USERPROFILE with no HOME, base URL in base_url and the key only in the env", () => {
    const profile = join(root, "Users", "Some One");
    mkdirSync(profile, { recursive: true });
    const env: Record<string, string | undefined> = { USERPROFILE: profile };
    const slug = ensureFuigoLocalModel(`${SERVER.id}::Qwen3`, env);
    const host = localHost(SERVER.id)!;
    const toml = readFileSync(join(profile, ".fuigo", "config.toml"), "utf8");
    expect(toml).toContain(`[model."${slug}"]`);
    expect(toml).toContain(`base_url = "${SERVER.apiBase}"`);
    expect(toml).toContain(`env_key = "${fuigoLocalKeyEnv(host)}"`);
    expect(toml).not.toContain(SERVER.apiKey);
    expect(toml).not.toMatch(/^api_key/m);
    expect(env[fuigoLocalKeyEnv(host)]).toBe(SERVER.apiKey);
  });
});

describe("fuigo binary resolution — the bundled engine", () => {
  const saved: Record<string, string | undefined> = {};
  let bundleDir: string;
  let emptyBin: string;

  beforeEach(() => {
    for (const key of ["PATH", "HOME", "MURAGE_FUIGO_DIR"]) saved[key] = process.env[key];
    bundleDir = join(root, "resources-fuigo");
    emptyBin = join(root, "empty-bin");
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(emptyBin, { recursive: true });
    const binary = join(bundleDir, process.platform === "win32" ? "fuigo.exe" : "fuigo");
    writeFileSync(binary, "");
    chmodSync(binary, 0o755);
    // HOME moves too: augmentedPath() scans ~/.fuigo/bin unconditionally
    // (env-path.ts:38), and a developer machine has a real fuigo there — which
    // would make this assert the opposite of what it means to.
    process.env.PATH = emptyBin;
    process.env.HOME = home;
    process.env.MURAGE_FUIGO_DIR = bundleDir;
    // ...and moving HOME is still not enough. augmentedPath() also scans
    // ABSOLUTE system directories — /opt/homebrew/bin, /usr/local/bin — that
    // no environment variable can redirect, so on any machine with a
    // brew-installed fuigo these cases found the developer's engine,
    // resolveFuigoCli correctly answered `source: "path"`, and every
    // assertion below tested the opposite of what it claims. The product is
    // right to prefer a user's own install; the tests simply could not reach
    // the "nothing is installed" precondition they assert under. This is how
    // they reach it. `[]` — not an empty directory — so nothing on this
    // machine can satisfy the scan by accident.
    restrictInstallScanDirsForTests([]);
    resetPathCacheForTests();
  });

  afterEach(() => {
    restrictInstallScanDirsForTests(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetPathCacheForTests();
  });

  it("puts the staged engine's directory on the child PATH when nothing is installed", async () => {
    // The reason this driver exists: `resolveFuigoCli` had zero callers, so
    // the engine Murage ships was unreachable — `defaultCli` is the bare name
    // "fuigo", and MURAGE_FUIGO_DIR is on nobody's PATH. `env.PATH` is what
    // libuv resolves that bare name against, and it is the same mechanism
    // every other engine here already relies on (env-path.ts:8-11).
    await runTurn({ model: "flux-auto" });
    expect(dump("agent").env.PATH.split(delimiter)[0]).toBe(bundleDir);
    // and the catalog spawn, which only ever sees transformEnv, gets it too
    expect(dump("models").env.PATH.split(delimiter)[0]).toBe(bundleDir);
  });

  it("keeps bundled PATH when a browser MCP environment has its own PATH", async () => {
    const browser = { command: process.execPath, args: ["browser-proxy.mjs"], env: { PATH: emptyBin, ELECTRON_RUN_AS_NODE: "1" } };
    const events = await runTurn({ model: "flux-auto", integrations: { browser } });
    expect(events.events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(dump("agent").env.PATH.split(delimiter)[0]).toBe(bundleDir);
    const session = JSON.parse(readFileSync(join(dumps, "session.json"), "utf8"));
    expect(session.mcpServers).toContainEqual({ name: "browser", command: browser.command, args: browser.args,
      env: [{ name: "PATH", value: emptyBin }, { name: "ELECTRON_RUN_AS_NODE", value: "1" }] });
  });

  const snapshotDefault = async (cli = "fuigo") => {
    instance = await FuigoAgentDriver.create({ instanceId: "bundle-probe", displayName: "Fuigo",
      environment: { HOME: home }, enabled: true, config: { cli, fullAuto: false } });
    return instance.snapshot();
  };

  it.skipIf(process.platform === "win32")("executes the default bundled CLI with no Node/npm in its PATH", async () => {
    // Absolute /bin/sh is the fixture interpreter, never env node or npm.
    writeFileSync(join(bundleDir, "fuigo"), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "fuigo fixture\\n"; fi\n');
    expect(await snapshotDefault()).toMatchObject({ state: "available", version: "fuigo fixture" });
  });

  it("reports a missing declared bundle as a repair, not a missing npm installation", async () => {
    process.env.MURAGE_FUIGO_DIR = join(root, "missing-bundle");
    expect(await snapshotDefault()).toMatchObject({ state: "unavailable", setupAction: "repair", reason: expect.stringMatching(/bundled engine is missing.*Repair or reinstall Murage.*Node\/npm is not required/s) });
  });

  it.skipIf(process.platform === "win32")("reports bundle permissions separately", async () => {
    chmodSync(join(bundleDir, "fuigo"), 0o644);
    expect(await snapshotDefault()).toMatchObject({ state: "unavailable", setupAction: "repair", reason: expect.stringContaining("is not executable") });
  });

  it.skipIf(process.platform === "win32")("reports a bundled version exit without copying stderr", async () => {
    writeFileSync(join(bundleDir, "fuigo"), '#!/bin/sh\nprintf "secret-fixture-output" >&2\nexit 7\n');
    const snapshot = await snapshotDefault();
    expect(snapshot).toMatchObject({ state: "unavailable", setupAction: "repair", reason: expect.stringContaining("did not start when Murage checked its version") });
    expect(snapshot.reason).not.toContain("secret-fixture-output");
    expect(snapshot.reason).toContain("Repair or reinstall Murage");
  });

  it("does not prescribe bundle repair for a missing custom CLI", async () => {
    const snapshot = await snapshotDefault(join(root, "missing-custom-cli"));
    expect(snapshot).toMatchObject({ state: "unavailable", reason: expect.stringContaining("is not installed, or Murage cannot find it on this computer") });
    expect(snapshot.reason).not.toContain("Repair or reinstall");
    expect(snapshot).not.toHaveProperty("setupAction");
  });

  // Real version probes use a POSIX executable fixture, like env-path.test.ts.
  function userFuigo(version: string): string {
    const userBin = join(root, "user-bin");
    mkdirSync(userBin, { recursive: true });
    for (const [directory, reported] of [[userBin, version], [bundleDir, FUIGO_VERSION]]) {
      const binary = join(directory, "fuigo");
      writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo fuigo ${reported}; fi\n`);
      chmodSync(binary, 0o755);
    }
    process.env.PATH = userBin;
    resetPathCacheForTests();
    return userBin;
  }

  it.skipIf(process.platform === "win32")("does NOT touch PATH when the user has a newer fuigo installed", async () => {
    const [major, minor, patch] = FUIGO_VERSION.split(".").map(Number);
    const userBin = userFuigo(`${major}.${minor}.${patch + 1}`);
    await runTurn({ model: "flux-auto" });
    for (const kind of ["agent", "models"] as const) {
      expect(dump(kind).env.PATH.split(delimiter)).not.toContain(bundleDir);
      expect(dump(kind).env.PATH.split(delimiter)[0]).toBe(userBin);
    }
  });

  it.skipIf(process.platform === "win32")("puts the bundled fuigo before an older user copy on PATH", async () => {
    const [major, minor, patch] = FUIGO_VERSION.split(".").map(Number);
    const userBin = userFuigo(`${major}.${minor}.${patch - 1}`);
    await runTurn({ model: "flux-auto" });
    for (const kind of ["agent", "models"] as const) {
      const path = dump(kind).env.PATH.split(delimiter);
      expect(path[0]).toBe(bundleDir);
      expect(path).toContain(userBin);
    }
  });

  it("leaves PATH alone when there is no fuigo anywhere — the spawn reports it", async () => {
    // resolveFuigoCli THROWS here. Swallowing it is deliberate: this hook also
    // runs for the catalog refresh inside create(), and a throw would downgrade
    // the whole instance to a shadow instead of letting snapshot() say
    // "`fuigo` CLI not found".
    delete process.env.MURAGE_FUIGO_DIR;
    resetPathCacheForTests();
    await runTurn({ model: "flux-auto" });
    expect(dump("agent").env.PATH.split(delimiter)).not.toContain(bundleDir);
  });
});

// 0.1.52 spec E1: a local pick becomes a Murage-owned `[model.*]` entry in the
// config.toml under Fuigo's home, and `-m` names that entry. Flux and cloud
// picks are untouched; the server key travels in the env, never in the file.
describe("fuigo local models (spec E1)", () => {
  const SERVER = {
    id: "srv_0123456789ab",
    name: "SeanBeast",
    kind: "llamacpp" as const,
    apiBase: "http://127.0.0.1:18080/v1",
    apiKey: "sk-beast-local",
    createdAt: 1,
    updatedAt: 1,
  };
  const PICK = `${SERVER.id}::Qwen3.8-27B`;
  const KEY_ENV = "MURAGE_LOCAL_SRV_0123456789AB_API_KEY";

  beforeEach(() => {
    configureLocalServerStore(join(root, "data"));
    writeLocalServers([SERVER]);
  });
  afterEach(() => configureLocalServerStore(null));

  it("writes a [model.*] entry and passes -m <entry> between `agent` and `stdio`", async () => {
    await runTurn({ model: PICK });
    const { argv, env } = dump("agent");
    const slug = fuigoLocalSlug(localHost(SERVER.id)!, "Qwen3.8-27B");
    const m = argv.indexOf("-m");
    expect(argv[m + 1]).toBe(slug);
    expect(argv.indexOf("agent")).toBeLessThan(m);
    expect(m).toBeLessThan(argv.indexOf("stdio"));
    expect(env[KEY_ENV]).toBe(fixtureCredentialFingerprint(SERVER.apiKey));
    const toml = readFileSync(join(home, ".fuigo", "config.toml"), "utf8");
    expect(toml).toContain(`[model."${slug}"]`);
    expect(toml).toContain('model = "Qwen3.8-27B"');
    expect(toml).toContain(`base_url = "${SERVER.apiBase}"`);
    expect(toml).toContain(`env_key = "${KEY_ENV}"`);
    expect(toml).toContain('api_backend = "chat_completions"');
    expect(toml).not.toContain(SERVER.apiKey);
  });

  it("keeps the user's own config and does not duplicate or rewrite an identical entry", async () => {
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    const own = '[cli]\nuse_leader = true\n\n[model.my-cloud]\nmodel = "gpt-5"\n';
    writeFileSync(join(home, ".fuigo", "config.toml"), own);
    await runTurn({ model: PICK });
    await instance?.dispose();
    instance = undefined;
    recorder?.stop();
    const first = readFileSync(join(home, ".fuigo", "config.toml"), "utf8");
    await runTurn({ model: PICK });
    const second = readFileSync(join(home, ".fuigo", "config.toml"), "utf8");
    expect(second).toBe(first);
    expect(second.startsWith(own)).toBe(true);
    expect(second.match(/\[model\."murage-local-/g)).toHaveLength(1);
  });

  it("runs a local pick with no Flux key and no fuigo login", async () => {
    delete process.env.FLUX_API_KEY;
    const events = await runTurn({ model: PICK });
    expect(events.events.some((event) => event.type === "runtime.error")).toBe(false);
    expect(events.events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(dump("agent").argv).toContain(fuigoLocalSlug(localHost(SERVER.id)!, "Qwen3.8-27B"));
  });

  it("leaves Flux and cloud picks exactly as they were", async () => {
    await runTurn({ model: "claude-opus-5" });
    const { argv, env } = dump("agent");
    expect(argv[argv.indexOf("-m") + 1]).toBe("claude-opus-5");
    expect(env[KEY_ENV]).toBeUndefined();
    expect(existsSync(join(home, ".fuigo", "config.toml"))).toBe(false);
  });
});

describe("fuigo waits for MCP readiness before the first prompt", () => {
  // Fuigo 1.0.19/1.0.20 answer session/new before the handed mcpServers are
  // connected and tell the model "MCP servers currently connecting … do not
  // use" if prompted at once. The driver holds the prompt for
  // `_fuigo/mcp_initialized`, bounded by MCP_READY_WAIT_MS.
  const AGENTS = { agents: { command: process.execPath, args: ["/fake/agents-proxy.js"], env: {} } };

  afterEach(() => {
    delete process.env.MURAGE_ACP_MCP_READY_MS;
  });

  const readOrder = () => {
    const path = join(dumps, "order.log");
    if (!existsSync(path)) return [] as Array<{ event: string; at: number }>;
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => {
      const [event, at] = line.split(" ");
      return { event: event!, at: Number(at) };
    });
  };
  const lifecycleEvents = (threadId: string, turnId: string) =>
    readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { dir: string; msg: Record<string, any> })
      .filter((row) => row.dir === "lifecycle" && row.msg.turnId === turnId)
      .map((row) => row.msg);

  async function start(
    environment: Record<string, string>,
    integrations: SendTurnInput["integrations"] | undefined,
    driver: typeof FuigoAgentDriver = FuigoAgentDriver,
  ) {
    instance = await driver.create({
      instanceId: "fuigo-mcp-ready",
      displayName: "Fuigo",
      environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps, ...environment },
      enabled: true,
      config: { cli: fakeCli, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const threadId = `t-fuigo-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const startedAt = Date.now();
    const { turnId } = await instance.adapter.sendTurn({ threadId, text: "hi", ...(integrations ? { integrations } : {}) });
    return { threadId, turnId, startedAt };
  }

  it("keeps the bound at 15 s", () => {
    expect(MCP_READY_WAIT_MS).toBe(15_000);
  });

  it("(a) sends no prompt until mcp_initialized names this session, then sends it at once", async () => {
    const { threadId, turnId } = await start({ FUIGO_FAKE_MCP: "ready", FUIGO_FAKE_MCP_DELAY_MS: "700" }, AGENTS);
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    const order = readOrder();
    const events = order.map((row) => row.event);
    // the other session's readiness came first and did not release the prompt
    expect(events).toEqual(["new-response", "mcp-ready:some-other-session", "mcp-ready:fake-fuigo-session", "prompt"]);
    const response = order[0]!.at, ready = order[2]!.at, prompt = order[3]!.at;
    expect(ready - response).toBeGreaterThanOrEqual(600);
    expect(prompt - ready).toBeLessThan(1_000);
    const lifecycle = lifecycleEvents(threadId, turnId).map((row) => row.event);
    expect(lifecycle).toContain("mcp_ready");
    expect(lifecycle).not.toContain("mcp_ready_timeout");
  });

  it("(b) a readiness notification that arrives BEFORE the session/new response still releases the wait", async () => {
    const { startedAt } = await start({ FUIGO_FAKE_MCP: "before" }, AGENTS);
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(readOrder().map((row) => row.event)).toEqual(["mcp-ready:fake-fuigo-session", "new-response", "prompt"]);
    expect(Date.now() - startedAt).toBeLessThan(MCP_READY_WAIT_MS);
  });

  it("(c) never ready: the prompt goes out after the bound, with an mcp_ready_timeout lifecycle row", async () => {
    process.env.MURAGE_ACP_MCP_READY_MS = "400";
    const { threadId, turnId } = await start({ FUIGO_FAKE_MCP: "never" }, AGENTS);
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    const order = readOrder();
    expect(order.map((row) => row.event)).toEqual(["new-response", "prompt"]);
    expect(order[1]!.at - order[0]!.at).toBeGreaterThanOrEqual(350);
    const rows = lifecycleEvents(threadId, turnId);
    const timeoutAt = rows.findIndex((row) => row.event === "mcp_ready_timeout");
    expect(timeoutAt).toBeGreaterThan(-1);
    const promptAt = rows.findIndex((row) => row.event === "rpc_requested" && row.method === "session/prompt");
    expect(timeoutAt).toBeLessThan(promptAt);
    expect(rows.map((row) => row.event)).not.toContain("mcp_ready");
  });

  it("(g) R3: a hung external server does not hold the prompt once Murage's own mount is connected", async () => {
    const { threadId, turnId, startedAt } = await start({ FUIGO_FAKE_MCP: "external" }, AGENTS);
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    const order = readOrder();
    expect(order.map((row) => row.event)).toEqual(["new-response", "prompt"]);
    // released by the own-mount progress report, not by any timeout
    expect(order[1]!.at - order[0]!.at).toBeLessThan(2_000);
    expect(Date.now() - startedAt).toBeLessThan(MCP_OWN_READY_WAIT_MS);
    const events = lifecycleEvents(threadId, turnId).map((row) => row.event);
    expect(events).toContain("mcp_ready_own");
    expect(events).not.toContain("mcp_ready_timeout");
    expect(existsSync(join(dumps, "prompt.json"))).toBe(true);
  });

  it("(h) R3: nothing connecting at all is bounded by the short own-mount cap, not 15 s", async () => {
    process.env.MURAGE_ACP_MCP_OWN_READY_MS = "500";
    try {
      const { threadId, turnId, startedAt } = await start({ FUIGO_FAKE_MCP: "stuck" }, AGENTS);
      const done = await recorder!.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ ok: true });
      const order = readOrder();
      expect(order.map((row) => row.event)).toEqual(["new-response", "prompt"]);
      expect(order[1]!.at - order[0]!.at).toBeGreaterThanOrEqual(450);
      expect(Date.now() - startedAt).toBeLessThan(MCP_OWN_READY_WAIT_MS);
      expect(lifecycleEvents(threadId, turnId).map((row) => row.event)).toContain("mcp_ready_timeout");
    } finally { delete process.env.MURAGE_ACP_MCP_OWN_READY_MS; }
  });

  const COMPOSIO = { composio: { command: process.execPath, args: ["/fake/composio-mcp.js"], env: {} } };

  it("(h2) a connector turn is not released by another server connecting first; it waits for all-settled", async () => {
    const { threadId, turnId } = await start({ FUIGO_FAKE_MCP: "late" }, COMPOSIO);
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    const order = readOrder();
    expect(order.map((row) => row.event)).toEqual(["new-response", "mcp-ready:fake-fuigo-session", "prompt"]);
    expect(order[2]!.at - order[0]!.at).toBeGreaterThanOrEqual(1_000);
    const events = lifecycleEvents(threadId, turnId).map((row) => row.event);
    expect(events).toContain("mcp_ready");
    expect(events).not.toContain("mcp_ready_own");
  });

  it("(h3) a non-connector turn keeps the early own-mount release in the same situation", async () => {
    const { threadId, turnId } = await start({ FUIGO_FAKE_MCP: "late" }, AGENTS);
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    const order = readOrder();
    expect(order[0]!.event).toBe("new-response");
    expect(order[1]!.event).toBe("prompt");
    expect(order[1]!.at - order[0]!.at).toBeLessThan(1_000);
    expect(lifecycleEvents(threadId, turnId).map((row) => row.event)).toContain("mcp_ready_own");
  });

  it("(h4) a connector turn whose servers never settle is bounded by the full wait: one wait, one prompt, no hang", async () => {
    process.env.MURAGE_ACP_MCP_READY_MS = "600";
    const { threadId, turnId, startedAt } = await start({ FUIGO_FAKE_MCP: "external" }, COMPOSIO);
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    const order = readOrder();
    expect(order.map((row) => row.event)).toEqual(["new-response", "prompt"]);
    expect(order[1]!.at - order[0]!.at).toBeGreaterThanOrEqual(550);
    expect(Date.now() - startedAt).toBeLessThan(MCP_OWN_READY_WAIT_MS);
    const events = lifecycleEvents(threadId, turnId).map((row) => row.event);
    expect(events.filter((e) => e === "mcp_ready_timeout")).toHaveLength(1);
    expect(events).not.toContain("mcp_ready_own");
  });

  it("(d) a Stop during the wait sends no prompt and ends the turn as cancelled, promptly", async () => {
    const { threadId, turnId } = await start({ FUIGO_FAKE_MCP: "never" }, AGENTS);
    await recorder!.until((e) => e.type === "session.started");
    const stoppedAt = Date.now();
    await instance!.adapter.interruptTurn(threadId, turnId);
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(Date.now() - stoppedAt).toBeLessThan(3_000);
    expect(readOrder().map((row) => row.event)).not.toContain("prompt");
    expect(existsSync(join(dumps, "prompt.json"))).toBe(false);
    await expect(instance!.adapter.awaitTurnTeardown!(threadId, turnId)).resolves.toEqual({ closeConfirmed: true });
    const rows = lifecycleEvents(threadId, turnId);
    expect(rows.filter((row) => row.event === "rpc_requested").map((row) => row.method)).not.toContain("session/prompt");
    expect(rows.find((row) => row.event === "turn_settled")).toMatchObject({ promptSent: false, cancelRequested: true });
  });

  it("(e) an empty mcpServers list does not wait at all", async () => {
    const { startedAt } = await start({ FUIGO_FAKE_MCP: "never" }, undefined);
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(dumps, "session.json"), "utf8")).mcpServers).toEqual([]);
    expect(readOrder().map((row) => row.event)).toEqual(["new-response", "prompt"]);
    expect(Date.now() - startedAt).toBeLessThan(MCP_READY_WAIT_MS);
  });

  it("(f) an ACP engine without the readiness notification prompts at once, servers or not", async () => {
    const other: AcpSupport = {
      driverKind: "otherAcpTest",
      displayName: "Other ACP",
      models: { default: "", options: [] },
      defaultCli: "other-acp",
      nativeSource: "other.acp",
      loginNote: "never reached",
      spawnArgs: () => [],
      pickAuthMethod: () => null,
      authFailure: "continue",
      isAuthenticated: () => true,
    };
    const { threadId, turnId, startedAt } = await start({ FUIGO_FAKE_MCP: "never" }, AGENTS, createAcpDriver(other));
    const done = await recorder!.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(dumps, "session.json"), "utf8")).mcpServers).toHaveLength(1);
    expect(readOrder().map((row) => row.event)).toEqual(["new-response", "prompt"]);
    expect(Date.now() - startedAt).toBeLessThan(MCP_READY_WAIT_MS);
    const events = lifecycleEvents(threadId, turnId).map((row) => row.event);
    expect(events).not.toContain("mcp_ready");
    expect(events).not.toContain("mcp_ready_timeout");
  });
});

describe("Fuigo keeps one engine process per thread, opt-in (upstream #1575, MURAGE_ACP_POOL=1)", () => {
  // per-turn is the default for 1.0 (FUIGO-LIVE-EVIDENCE.md): the pool is an opt-in
  beforeEach(() => { process.env.MURAGE_ACP_POOL = "1"; });
  afterEach(() => { delete process.env.MURAGE_ACP_POOL; });
  it("by default each turn is its own process: nothing is kept after end_turn", async () => {
    delete process.env.MURAGE_ACP_POOL;
    instance = await FuigoAgentDriver.create({
      instanceId: "fuigo-pool-default",
      displayName: "Fuigo",
      environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps },
      enabled: true,
      config: { cli: fakeCli, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const first = await instance.adapter.sendTurn({ threadId: "t-fuigo-default", text: "one" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const second = await instance.adapter.sendTurn({ threadId: "t-fuigo-default", text: "two", resumeCursor: "fake-fuigo-session" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(readFileSync(join(dumps, "spawns.log"), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });
  // Windows ignores MURAGE_ACP_POOL (acpPoolingEnabled): each turn there is its own process.
  it.skipIf(process.platform === "win32")("a second turn on the thread reuses the process and hands it the new turn's tokens", async () => {
    instance = await FuigoAgentDriver.create({
      instanceId: "fuigo-pool",
      displayName: "Fuigo",
      environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps },
      enabled: true,
      config: { cli: fakeCli, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const agents = (token: string): SendTurnInput["integrations"] => ({
      agents: { command: process.execPath, args: ["never-started.js"], env: { MURAGE_COMMS_TOKEN: token } },
    });
    const first = await instance.adapter.sendTurn({ threadId: "t-fuigo-pool", text: "one", integrations: agents("turn-one") });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const second = await instance.adapter.sendTurn({
      threadId: "t-fuigo-pool", text: "two", resumeCursor: "fake-fuigo-session", integrations: agents("turn-two"),
    });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(done).toMatchObject({ ok: true });

    const lines = (name: string) => readFileSync(join(dumps, name), "utf8").split("\n").filter(Boolean);
    expect(lines("spawns.log")).toHaveLength(1);
    const [load] = lines("loads.log").map((line) => JSON.parse(line));
    expect(lines("loads.log")).toHaveLength(1);
    expect(load).toMatchObject({ sessionId: "fake-fuigo-session", _meta: { noReplay: true } });
    const token = (load.mcpServers as Array<{ name: string; env: Array<{ name: string; value: string }> }>)
      .find((server) => server.name === "agents")?.env.find((entry) => entry.name === "MURAGE_COMMS_TOKEN")?.value;
    expect(token).toBe("turn-two");
  });

  it("a warm second turn that picks a different model sends set_model with the new id before its prompt", async () => {
    process.env.MURAGE_ACP_POOL = "1";
    onTestFinished(() => { delete process.env.MURAGE_ACP_POOL; });
    instance = await FuigoAgentDriver.create({
      instanceId: "fuigo-pool-model",
      displayName: "Fuigo",
      // the fake reports flux-auto as current on both session/new and session/load
      environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps, FUIGO_FAKE_NEW_MODEL: "flux-auto", FUIGO_FAKE_CURRENT_MODEL: "flux-auto" },
      enabled: true,
      config: { cli: fakeCli, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    const first = await instance.adapter.sendTurn({ threadId: "t-fuigo-pool-model", text: "one", model: "flux-auto" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const second = await instance.adapter.sendTurn({
      threadId: "t-fuigo-pool-model", text: "two", model: "flux-fast", resumeCursor: "fake-fuigo-session",
    });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(done).toMatchObject({ ok: true });

    const lines = (name: string) => readFileSync(join(dumps, name), "utf8").split("\n").filter(Boolean);
    // -m is part of the spawn contract, so a changed pick parks the old
    // process and loads the session in a fresh one; either way the new id must
    // reach the engine through set_model.
    expect(lines("loads.log")).toHaveLength(1);
    expect(lines("set-model.log").map((l) => JSON.parse(l))).toEqual([{ sessionId: "fake-fuigo-session", modelId: "flux-fast" }]);
    const order = lines("order.log").map((l) => l.split(" ")[0]);
    expect(order.lastIndexOf("set-model")).toBeLessThan(order.lastIndexOf("prompt"));
    expect(order.lastIndexOf("set-model")).toBeGreaterThan(order.indexOf("prompt"));
  });
});

describe("steer (fuigo/interject)", () => {
  const interjects = () => {
    try { return readFileSync(join(dumps, "interjects.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  async function startHeld(environment: Record<string, string> = {}) {
    instance = await FuigoAgentDriver.create({
      instanceId: "fuigo-test", displayName: "Fuigo", enabled: true,
      environment: { HOME: home, FUIGO_FAKE_DUMP_DIR: dumps, FUIGO_FAKE_HOLD_MS: "700", ...environment },
      config: { cli: fakeCli, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-fuigo", text: "work" });
    await recorder.until((e) => e.type === "turn.started");
    for (let i = 0; i < 400 && !existsSync(join(dumps, "prompts.log")); i++) await new Promise((r) => setTimeout(r, 20));
    return instance.adapter;
  }

  it("declares queueing and steer for Fuigo only", async () => {
    instance = await FuigoAgentDriver.create({ instanceId: "fuigo-test", displayName: "Fuigo", enabled: true, environment: { HOME: home }, config: { cli: fakeCli, fullAuto: false } });
    expect(instance.adapter.capabilities.queueing).toBe(true);
    expect(typeof instance.adapter.steer).toBe("function");
  });

  it("sends _fuigo/interject into a running turn and returns delivered, with no duplicate user message", async () => {
    const adapter = await startHeld();
    expect(await adapter.steer!("t-fuigo", "also check the totals")).toBe("delivered");
    const sent = interjects();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId: "fake-fuigo-session", text: "also check the totals" });
    expect(typeof sent[0].interjectionId).toBe("string");
    await recorder!.until((e) => e.type === "turn.completed");
    // Murage records the steered message itself; the echo adds nothing.
    expect(recorder!.events.filter((e) => /user/i.test(e.type) || JSON.stringify(e).includes("also check the totals"))).toEqual([]);
    expect(recorder!.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  });

  it("runs the steer's fence right before the _fuigo/interject write: a refusal writes nothing and returns rejected", async () => {
    const adapter = await startHeld();
    let fenceCalls = 0;
    expect(await adapter.steer!("t-fuigo", "stale session line", () => { fenceCalls++; throw new Error("MEMORY_CONTEXT_REVOKED"); })).toBe("rejected");
    expect(fenceCalls).toBe(1);
    expect(interjects()).toEqual([]);
    expect(await adapter.steer!("t-fuigo", "valid session line", () => { fenceCalls++; })).toBe("delivered");
    expect(fenceCalls).toBe(2);
    expect(interjects()).toHaveLength(1);
    await recorder!.until((e) => e.type === "turn.completed");
  });

  it("returns rejected after the turn settled and sends nothing", async () => {
    await runTurn({});
    expect(await instance!.adapter.steer!("t-fuigo", "late")).toBe("rejected");
    expect(interjects()).toEqual([]);
  });

  it("method-not-found returns rejected and is never tried a second time", async () => {
    const adapter = await startHeld({ FUIGO_FAKE_INTERJECT: "nomethod" });
    expect(await adapter.steer!("t-fuigo", "one")).toBe("rejected");
    expect(await adapter.steer!("t-fuigo", "two")).toBe("rejected");
    expect(interjects()).toHaveLength(1);
    await recorder!.until((e) => e.type === "turn.completed");
  });

  // Murage stores the steered message itself when steer() says true, and the
  // server queue stores it when steer() says false. Either way that is the one
  // persisted user message, so the driver must never add a second.
  const userCopies = (text: string) => recorder!.events.filter((e) => /user/i.test(e.type) || JSON.stringify(e).includes(text));
  const readOrder = () => existsSync(join(dumps, "order.log"))
    ? readFileSync(join(dumps, "order.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => ({ event: line.split(" ")[0]!, at: Number(line.split(" ")[1]) }))
    : [];
  const withEnv = (vars: Record<string, string>) => {
    for (const [key, value] of Object.entries(vars)) process.env[key] = value;
    onTestFinished(() => { for (const key of Object.keys(vars)) delete process.env[key]; });
  };

  it("an older Fuigo (no streamStartMs) keeps today's text: the echo never commits or splits it", async () => {
    const adapter = await startHeld({ FUIGO_FAKE_POST_ECHO_TEXT: "Part two." });
    expect(await adapter.steer!("t-fuigo", "also check the totals")).toBe("delivered");
    await recorder!.until((e) => e.type === "turn.completed");
    const texts = recorder!.events
      .filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text")
      .map((e) => (e as unknown as { text: string }).text);
    expect(texts).toEqual(["okPart two."]);
  });

  describe("assistant text is split by response, never at the interjection echo", () => {
    const sid = "fake-fuigo-session";
    const chunk = (text: string, startMs?: number) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, ...(startMs !== undefined ? { _meta: { streamStartMs: startMs } } : {}), update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    const echo = (replay: boolean) => ({ jsonrpc: "2.0", method: "_fuigo/session/interjection", params: { sessionId: sid, text: "steer", interjectionId: "echo-1", ...(replay ? { _meta: { isReplay: true } } : {}) } });
    const discard = (startMs: number) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "retry_state", type: "retrying", discardEmitted: true, streamStartMs: startMs } } });
    const completed = () => ({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: sid, update: { sessionUpdate: "response_completed", stop_reason: "end_turn" }, _meta: {} } });
    const items = (rec: EventRecorder) => rec.events
      .filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text")
      .map((e) => (e as unknown as { text: string }).text);
    const script = (messages: unknown[], extra: Record<string, string> = {}) =>
      runTurn({ environment: { FUIGO_FAKE_RETRY_DISCARD: "1", FUIGO_FAKE_SCRIPT: JSON.stringify(messages), ...extra } });

    it("a live echo mid-response, then the steered reply in a new response: two items, never glued", async () => {
      const rec = await script([chunk("A", 1), echo(false), chunk(" more", 1), completed(), chunk("B", 2)]);
      expect(items(rec)).toEqual(["A more", "B"]);
    });

    it("a live echo mid-response whose attempt then fails: the discarded text never survives the resend", async () => {
      const rec = await script([chunk("A", 1), echo(false), discard(1), chunk("A'", 3), completed(), chunk("B", 4)]);
      expect(items(rec)).toEqual(["A'", "B"]);
    });

    it("a response not yet completed is never closed by a new streamStartMs, so its discard still reaches it", async () => {
      const rec = await script([chunk("A", 1), chunk("X", 2), discard(2), discard(1), chunk("A'", 3)]);
      expect(items(rec)).toEqual(["A'"]);
    });

    it("a replayed echo changes nothing: text stays one discardable item", async () => {
      expect(items(await script([chunk("A", 1), echo(true), chunk("B", 1)]))).toEqual(["AB"]);
      expect(items(await script([chunk("A", 1), echo(true), chunk("B", 1), discard(1), chunk("C", 2)]))).toEqual(["C"]);
    });

    it("chunks without streamStartMs never split, even across a live echo and a completed response", async () => {
      const rec = await script([chunk("A"), echo(false), completed(), chunk("B")]);
      expect(items(rec)).toEqual(["AB"]);
    });

    it("an echo arriving after the turn settled adds no item", async () => {
      const rec = await script([chunk("A", 1)], { FUIGO_FAKE_AFTER_SCRIPT: JSON.stringify([echo(false), chunk("late", 3)]) });
      await new Promise((r) => setTimeout(r, 500));
      expect(items(rec)).toEqual(["A"]);
      expect(rec.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    });
  });

  it("keeps the turn open through an interject-fallback turn and lands its reply in the same turn", async () => {
    withEnv({ MURAGE_FUIGO_FALLBACK_GRACE_MS: "400" });
    const adapter = await startHeld({ FUIGO_FAKE_INTERJECT: "fallback" });
    expect(await adapter.steer!("t-fuigo", "also check the totals")).toBe("delivered");
    const done = await recorder!.until((e) => e.type === "turn.completed", 15_000);
    const settledAt = Date.now();
    const end = readOrder().find((o) => o.event === "fallback-end");
    expect(end).toBeDefined();
    expect(settledAt).toBeGreaterThanOrEqual(end!.at);
    expect(done).toMatchObject({ ok: true, stopReason: null });
    // The fallback's reply is part of this turn, before it completed.
    const index = recorder!.events.indexOf(done);
    const before = recorder!.events.slice(0, index);
    expect(before.some((e) => JSON.stringify(e).includes("fallback reply") && (e as { turnId?: string }).turnId === (done as { turnId?: string }).turnId)).toBe(true);
    expect(recorder!.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder!.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    // One delivery, one persisted user message (the caller's).
    expect(interjects()).toHaveLength(1);
    expect(userCopies("also check the totals")).toEqual([]);
  }, 20_000);

  it("a turn with no accepted interjection still settles at the prompt result", async () => {
    const events = await runTurn({ environment: { FUIGO_FAKE_INTERJECT: "fallback" } });
    expect(events.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(readOrder().some((o) => o.event === "fallback-start")).toBe(false);
  });

  it("a delayed response with an early echo is delivered, one delivery, one user message", async () => {
    const adapter = await startHeld({ FUIGO_FAKE_INTERJECT: "slowack", FUIGO_FAKE_ACK_DELAY_MS: "6000", FUIGO_FAKE_HOLD_MS: "1500" });
    const startedAt = Date.now();
    expect(await adapter.steer!("t-fuigo", "and the tax line")).toBe("delivered");
    // The echo decided it; the 6 s response was not waited for.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await recorder!.until((e) => e.type === "turn.completed", 15_000);
    expect(interjects()).toHaveLength(1);
    expect(userCopies("and the tax line")).toEqual([]);
  }, 20_000);

  it("neither a response nor an echo within the budget is uncertain (the caller queues no copy), and a late echo confirms it", async () => {
    withEnv({ MURAGE_FUIGO_INTERJECT_ACK_MS: "500", MURAGE_FUIGO_FALLBACK_GRACE_MS: "300" });
    const adapter = await startHeld({ FUIGO_FAKE_INTERJECT: "silent", FUIGO_FAKE_LATE_ECHO_MS: "900", FUIGO_FAKE_HOLD_MS: "2000" });
    expect(await adapter.steer!("t-fuigo", "one more thing")).toBe("uncertain");
    const confirmed = await recorder!.until((e) => e.type === "steer.confirmed", 5_000);
    const done = await recorder!.until((e) => e.type === "turn.completed", 15_000);
    expect(recorder!.events.indexOf(confirmed)).toBeLessThan(recorder!.events.indexOf(done));
    expect((confirmed as { turnId?: string }).turnId).toBe((done as { turnId?: string }).turnId);
    const native = readFileSync(join(NATIVE_DIR, "t-fuigo.ndjson"), "utf8");
    expect(native).toContain('"fuigoInterjection":"ack_timeout"');
    expect(native).toContain('"fuigoInterjection":"late_echo_confirmed"');
    expect(interjects()).toHaveLength(1);
    expect(userCopies("one more thing")).toEqual([]);
  }, 20_000);

  it("a second steer accepted right at grace expiry keeps the turn open for its later fallback, and its reply lands in the same turn", async () => {
    withEnv({ MURAGE_FUIGO_FALLBACK_GRACE_MS: "600" });
    const adapter = await startHeld({ FUIGO_FAKE_INTERJECT: "fallback", FUIGO_FAKE_FALLBACK_MS: "300", FUIGO_FAKE_IDLE_FALLBACK_DELAY_MS: "400" });
    expect(await adapter.steer!("t-fuigo", "first follow-up")).toBe("delivered");
    // The first fallback ends and the 600 ms grace starts; steer again just before it runs out.
    for (let i = 0; i < 500 && !readOrder().some((o) => o.event === "fallback-end"); i++) await new Promise((r) => setTimeout(r, 10));
    const firstEnd = readOrder().find((o) => o.event === "fallback-end")!.at;
    await new Promise((r) => setTimeout(r, Math.max(0, firstEnd + 550 - Date.now())));
    expect(recorder!.events.some((e) => e.type === "turn.completed")).toBe(false);
    expect(await adapter.steer!("t-fuigo", "second follow-up")).toBe("delivered");
    const done = await recorder!.until((e) => e.type === "turn.completed", 15_000);
    const settledAt = Date.now();
    const ends = readOrder().filter((o) => o.event === "fallback-end");
    expect(ends).toHaveLength(2);
    // The second fallback started after the first grace would have run out.
    expect(readOrder().filter((o) => o.event === "fallback-start")[1]!.at).toBeGreaterThan(firstEnd + 600);
    expect(settledAt).toBeGreaterThanOrEqual(ends[1]!.at);
    expect(done).toMatchObject({ ok: true, stopReason: null });
    const before = recorder!.events.slice(0, recorder!.events.indexOf(done));
    const turnId = (done as { turnId?: string }).turnId;
    expect(before.some((e) => JSON.stringify(e).includes("fallback reply #2") && (e as { turnId?: string }).turnId === turnId)).toBe(true);
    expect(recorder!.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(interjects()).toHaveLength(2);
  }, 20_000);

  it("a fallback that starts a background helper keeps the process owned until the helper finishes; its approval and result are kept", async () => {
    withEnv({ MURAGE_FUIGO_FALLBACK_GRACE_MS: "400" });
    const adapter = await startHeld({ FUIGO_FAKE_INTERJECT: "fallback", FUIGO_FAKE_FALLBACK_HELPER: "1", FUIGO_FAKE_HELPER_MS: "1200" });
    expect(await adapter.steer!("t-fuigo", "check in the background")).toBe("delivered");
    // The fallback ends first; the helper asks well after the grace would have run out.
    const opened = await recorder!.until((e) => e.type === "request.opened", 15_000);
    expect(recorder!.events.some((e) => e.type === "turn.completed")).toBe(false);
    expect(await adapter.respondToRequest("t-fuigo", (opened as { requestId: string }).requestId, { behavior: "allow" })).not.toBe("unavailable");
    const done = await recorder!.until((e) => e.type === "turn.completed", 15_000);
    const settledAt = Date.now();
    const helperEnd = readOrder().find((o) => o.event === "helper-end");
    expect(helperEnd).toBeDefined();
    expect(settledAt).toBeGreaterThanOrEqual(helperEnd!.at);
    expect(readOrder().find((o) => o.event === "fallback-end")!.at).toBeLessThan(helperEnd!.at);
    expect(done).toMatchObject({ ok: true, stopReason: null });
    const before = recorder!.events.slice(0, recorder!.events.indexOf(done));
    expect(before.some((e) => JSON.stringify(e).includes("helper result"))).toBe(true);
    expect(readFileSync(join(dumps, "helper.log"), "utf8")).toContain("allow-once");
  }, 20_000);

  it("a fallback still running at the cap settles failed with a visible reason", async () => {
    withEnv({ MURAGE_FUIGO_FALLBACK_GRACE_MS: "300", MURAGE_FUIGO_FALLBACK_CAP_MS: "900" });
    const adapter = await startHeld({ FUIGO_FAKE_INTERJECT: "fallback", FUIGO_FAKE_FALLBACK_MS: "8000" });
    expect(await adapter.steer!("t-fuigo", "a long follow-up")).toBe("delivered");
    const done = await recorder!.until((e) => e.type === "turn.completed", 15_000);
    expect(done).toMatchObject({ ok: false, stopReason: "interject_fallback_cap" });
    expect(recorder!.events.some((e) => e.type === "runtime.error" && (e as { message?: string }).message === FALLBACK_CAP_LINE)).toBe(true);
  }, 20_000);

  it("the engine exiting during the fallback hold settles failed with the engine-exit line", async () => {
    withEnv({ MURAGE_FUIGO_FALLBACK_GRACE_MS: "300" });
    const adapter = await startHeld({ FUIGO_FAKE_INTERJECT: "fallback", FUIGO_FAKE_FALLBACK_EXIT: "1", FUIGO_FAKE_FALLBACK_MS: "5000" });
    expect(await adapter.steer!("t-fuigo", "follow-up before a crash")).toBe("delivered");
    const done = await recorder!.until((e) => e.type === "turn.completed", 15_000);
    expect(readOrder().some((o) => o.event === "fallback-exit")).toBe(true);
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder!.events.find((e) => e.type === "runtime.error") as { message?: string } | undefined;
    expect(error?.message).toMatch(/closed \(exit code 3\) before it finished its reply/);
  }, 20_000);

  it("the cap firing while a helper is still open settles failed with the visible reason", async () => {
    withEnv({ MURAGE_FUIGO_FALLBACK_GRACE_MS: "300", MURAGE_FUIGO_FALLBACK_CAP_MS: "1500" });
    const adapter = await startHeld({ FUIGO_FAKE_INTERJECT: "fallback", FUIGO_FAKE_FALLBACK_HELPER: "1", FUIGO_FAKE_HELPER_MS: "20000", FUIGO_FAKE_FALLBACK_MS: "300" });
    expect(await adapter.steer!("t-fuigo", "follow-up with a helper")).toBe("delivered");
    const done = await recorder!.until((e) => e.type === "turn.completed", 15_000);
    expect(done).toMatchObject({ ok: false, stopReason: "interject_fallback_cap" });
    expect(recorder!.events.some((e) => e.type === "runtime.error" && (e as { message?: string }).message === FALLBACK_CAP_LINE)).toBe(true);
  }, 25_000);

  it("the engine exiting while the turn waits on a helper, after a steer was accepted, settles failed", async () => {
    withEnv({ MURAGE_FUIGO_FALLBACK_GRACE_MS: "300" });
    const adapter = await startHeld({ FUIGO_FAKE_PROMPT_HELPER: "1", FUIGO_FAKE_PROMPT_EXIT_MS: "300", FUIGO_FAKE_HOLD_MS: "1500" });
    expect(await adapter.steer!("t-fuigo", "follow-up before the engine dies")).toBe("delivered");
    const done = await recorder!.until((e) => e.type === "turn.completed", 15_000);
    expect(readOrder().some((o) => o.event === "prompt-exit")).toBe(true);
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder!.events.find((e) => e.type === "runtime.error") as { message?: string } | undefined;
    expect(error?.message).toMatch(/closed \(exit code 3\)/);
  }, 20_000);

  it("the helper wait cap ending a turn whose accepted follow-up is still running settles failed", async () => {
    withEnv({ MURAGE_FUIGO_FALLBACK_GRACE_MS: "300", MURAGE_FUIGO_FALLBACK_CAP_MS: "30000", MURAGE_BACKGROUND_CAP_MS: "1500", MURAGE_BACKGROUND_CAP_MIN_MS: "500" });
    const adapter = await startHeld({ FUIGO_FAKE_PROMPT_HELPER: "1", FUIGO_FAKE_INTERJECT: "fallback", FUIGO_FAKE_FALLBACK_MS: "20000" });
    expect(await adapter.steer!("t-fuigo", "a follow-up the helper cap overtakes")).toBe("delivered");
    const done = await recorder!.until((e) => e.type === "turn.completed", 15_000);
    expect(done).toMatchObject({ ok: false, stopReason: "interject_fallback_cap" });
    expect(recorder!.events.some((e) => e.type === "runtime.error" && (e as { message?: string }).message === FALLBACK_CAP_LINE)).toBe(true);
  }, 20_000);

  it("the helper wait cap with the follow-up's own helper still open settles failed", async () => {
    withEnv({ MURAGE_FUIGO_FALLBACK_GRACE_MS: "300", MURAGE_FUIGO_FALLBACK_CAP_MS: "30000", MURAGE_BACKGROUND_CAP_MS: "2500", MURAGE_BACKGROUND_CAP_MIN_MS: "500" });
    const adapter = await startHeld({ FUIGO_FAKE_PROMPT_HELPER: "1", FUIGO_FAKE_INTERJECT: "fallback", FUIGO_FAKE_FALLBACK_HELPER: "1", FUIGO_FAKE_HELPER_MS: "20000", FUIGO_FAKE_FALLBACK_MS: "300" });
    expect(await adapter.steer!("t-fuigo", "a follow-up whose helper outlives the cap")).toBe("delivered");
    const done = await recorder!.until((e) => e.type === "turn.completed", 15_000);
    expect(done).toMatchObject({ ok: false, stopReason: "interject_fallback_cap" });
  }, 20_000);

  it("steer.confirmed names the id the caller sent the steer under", async () => {
    withEnv({ MURAGE_FUIGO_INTERJECT_ACK_MS: "500", MURAGE_FUIGO_FALLBACK_GRACE_MS: "300" });
    const adapter = await startHeld({ FUIGO_FAKE_INTERJECT: "silent", FUIGO_FAKE_LATE_ECHO_MS: "900", FUIGO_FAKE_HOLD_MS: "2000" });
    expect(await adapter.steer!("t-fuigo", "one more thing", undefined, "steer-id-7")).toBe("uncertain");
    const confirmed = await recorder!.until((e) => e.type === "steer.confirmed", 5_000);
    expect(confirmed).toMatchObject({ interjectionId: "steer-id-7" });
    expect(interjects()[0]).toMatchObject({ interjectionId: "steer-id-7" });
    await recorder!.until((e) => e.type === "turn.completed", 15_000);
  }, 20_000);
});
