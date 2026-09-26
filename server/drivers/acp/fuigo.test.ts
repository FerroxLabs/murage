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
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { resetPathCacheForTests, restrictInstallScanDirsForTests } from "../../env-path.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { FuigoAgentDriver, fuigoLocalSlug, parseFuigoModels, STATIC_FUIGO_MODELS } from "./fuigo.ts";
import { acpVersionFailureDetail, createAcpDriver, MCP_READY_WAIT_MS, type AcpSupport } from "./core.ts";
import { configureLocalServerStore, writeLocalServers } from "../../local-servers.ts";
import { localHost } from "../local-inject.ts";

/** Shape only, never a live credential. */
const FLUX_KEY = "sk-flux-Ffffffffffffffffffffffffffffffffffffffffff";

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
import { delimiter, join } from "node:path";
const argv = process.argv.slice(2);
const kind = argv.includes("--version") ? "version" : argv[0] === "models" ? "models" : "agent";
if (process.env.FUIGO_FAKE_DUMP_DIR) {
  writeFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, kind + ".json"), JSON.stringify({ argv, env: process.env }));
}
if (kind === "version") { console.log("fuigo 1.0.4 (fake)"); process.exit(0); }
if (kind === "models") { process.stdout.write(process.env.FUIGO_FAKE_MODELS ?? ""); process.exit(0); }
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
    if (m.method === "initialize") ok({ protocolVersion: 1, authMethods: [{ id: "fuigo.api_key" }] });
    else if (m.method === "authenticate") ok({});
    else if (m.method === "session/new") {
      if (process.env.FUIGO_FAKE_DUMP_DIR) writeFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "session.json"), JSON.stringify(m.params));
      const hasMcp = Array.isArray(m.params?.mcpServers) && m.params.mcpServers.length > 0;
      if (hasMcp) send({ jsonrpc: "2.0", method: "_fuigo/mcp/init_progress", params: { sessionId: SID, total: 1, connected: 0 } });
      if (hasMcp && mcpMode === "before") mcpReady(SID);
      ok({ sessionId: SID });
      order("new-response");
      // 1.0.x advertises its "/" commands right after session/new
      // (session_setup.rs send_available_commands_update), before any prompt.
      if (process.env.FUIGO_FAKE_COMMANDS) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID,
        update: { sessionUpdate: "available_commands_update", availableCommands: JSON.parse(process.env.FUIGO_FAKE_COMMANDS) } } });
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
      ok({});
      if (Array.isArray(m.params?.mcpServers) && m.params.mcpServers.length) mcpReady(m.params.sessionId);
    }
    else if (m.method === "session/prompt") {
      order("prompt");
      if (process.env.FUIGO_FAKE_DUMP_DIR) writeFileSync(join(process.env.FUIGO_FAKE_DUMP_DIR, "prompt.json"), JSON.stringify(m.params));
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
      ok({ stopReason: "end_turn" });
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
  options: { images?: Array<{ mimeType: string; data: string }>; model?: string; effort?: "low" | "high"; fullAuto?: boolean; environment?: Record<string, string>; integrations?: SendTurnInput["integrations"]; text?: string; system?: string; engineCommand?: SendTurnInput["engineCommand"] } = {},
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

describe("fuigo credential — transformEnv, not applyTurnEnv", () => {
  it("hands the turn the workspace key under FUIGO_API_KEY", async () => {
    await runTurn({ model: "flux-auto" });
    expect(dump("agent").env.FUIGO_API_KEY).toBe(FLUX_KEY);
  });

  it("hands the CATALOG spawn the same key — this is why it is not applyTurnEnv", async () => {
    // `fuigo models` answers with a four-row unauthenticated placeholder when
    // the key is missing. applyTurnEnv (core.ts:323) never runs for the
    // catalog refresh (core.ts:220), so this assertion is the one that fails
    // if the hook is moved.
    await runTurn({ model: "flux-auto" });
    expect(dump("models").env.FUIGO_API_KEY).toBe(FLUX_KEY);
    expect(dump("models").argv).toEqual(["models"]);
  });

  it("never lets the raw workspace key ride under its own name", async () => {
    await runTurn({ model: "flux-auto" });
    const { env } = dump("agent");
    expect(env.FLUX_API_KEY).toBeUndefined();
    expect(Object.keys(env).filter((k) => env[k] === FLUX_KEY)).toEqual(["FUIGO_API_KEY"]);
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
    expect(env.FUIGO_API_KEY).toBe(FLUX_KEY);
  });

  it("leaves a user's own credential alone when Murage has no key", async () => {
    // Degrade to the CLI's native auth rather than half-write an env. An
    // install carrying its own FUIGO_API_KEY is a WORKING install.
    delete process.env.FLUX_API_KEY;
    await runTurn({ model: "flux-auto", environment: { FUIGO_API_KEY: "sk-user-own-key" } });
    // The CATALOG spawn is asserted first because it happens before the auth
    // gate: it holds the direct evidence even when a regression also stops the
    // turn from spawning at all.
    expect(dump("models").env.FUIGO_API_KEY).toBe("sk-user-own-key");
    expect(dump("agent").env.FUIGO_API_KEY).toBe("sk-user-own-key");
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

  it("does NOT touch PATH when the user has their own fuigo installed", async () => {
    // resolveFuigoCli prefers a fuigo on PATH over the bundled copy on
    // purpose (env-path.ts:382-388) — the app should agree with the user's
    // terminal. This is the control that proves the branch above is a branch
    // and not an unconditional prepend.
    const userBin = join(root, "user-bin");
    mkdirSync(userBin, { recursive: true });
    const binary = join(userBin, process.platform === "win32" ? "fuigo.exe" : "fuigo");
    writeFileSync(binary, "");
    chmodSync(binary, 0o755);
    process.env.PATH = userBin;
    resetPathCacheForTests();

    await runTurn({ model: "flux-auto" });
    expect(dump("agent").env.PATH.split(delimiter)).not.toContain(bundleDir);
    expect(dump("agent").env.PATH.split(delimiter)[0]).toBe(userBin);
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
    expect(env[KEY_ENV]).toBe(SERVER.apiKey);
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

describe("Fuigo keeps one engine process per thread (upstream #1575)", () => {
  it("a second turn on the thread reuses the process and hands it the new turn's tokens", async () => {
    // the pool ships off (MURAGE_ACP_POOL=1 turns it on)
    process.env.MURAGE_ACP_POOL = "1";
    onTestFinished(() => { delete process.env.MURAGE_ACP_POOL; });
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
});
