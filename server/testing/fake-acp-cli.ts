#!/usr/bin/env node
// Fake of an ACP (Agent Client Protocol) CLI's stdio surface, for driver
// tests of acp/core.ts + its harness shims (grok, gemini). Speaks JSON-RPC
// 2.0 over stdin/stdout: answers initialize / authenticate / session/new /
// session/prompt, and streams session/update notifications for a scripted
// turn. Failure modes mirror how real ACP agents misbehave:
//
//   FAKE_ACP_LOAD_NULL  answer session/load with null, the way a real agent
//                       reports a session it no longer has, so the resume
//                       cursor is dropped and the driver falls to session/new
//   FAKE_ACP_MODE   happy (default) | image | empty-reply | exit-early | fail-after-text | hang | no-auth | auth-required | permission
//                   | permission-session-first (same ask, but the options are
//                     ordered the way Fuigo's edit prompt really orders them:
//                     `allow_always` "allow all edits this session" BEFORE
//                     `allow_once`; the client's reply is written to
//                     FAKE_ACP_DUMP as `decision`)
//                   | question-tool (AskUserQuestion routed through request_permission)
//                   | fuigo-question (Fuigo's `_fuigo/ask_user_question` ext request)
//                   | fuigo-elicit (Fuigo's `_fuigo/mcp/elicit` bridge of an MCP form elicitation)
//                   | folder-trust (Fuigo 1.0.13's folder-trust gate: with
//                     `--trust` in argv the folder is trusted and the reply
//                     quotes ./AGENTS.md; without it the fake sends
//                     `_fuigo/folder_trust/request` after session/new IF the
//                     client advertised `fuigo/folderTrust.interactive`, writes
//                     the answer to FAKE_ACP_DUMP as `decision`, and — like the
//                     real engine, which reads instructions at session build —
//                     still replies with AGENTS.md withheld this session.
//                     Like the engine it also reads the user's own store,
//                     `<FUIGO_HOME | ~/.fuigo>/trusted_folders.toml`: a
//                     `[folders."<cwd>"]` table with `trusted = true` trusts
//                     the folder at build without `--trust` (a linked git
//                     worktree is keyed on its main checkout, like the
//                     engine's workspace_key). With
//                     FAKE_ACP_TRUST_PROMPT_FIRST=1 the prompt completes at
//                     once while its trust request is still open — the real
//                     engine's timing when the turn outruns the card. With
//                     FAKE_ACP_TRUST_STORE_REJECTED=1 the store reads as
//                     EMPTY whatever it says — the engine's `toml` crate
//                     rejecting a hand-edited document — so the fake asks
//                     although Murage's own reader may have accepted it.
//                     With FAKE_ACP_TRUST_FAIL_PROMPT=1 the prompt FAILS
//                     with a JSON-RPC error while its trust request is
//                     still open — a turn that fails under a late card)
//                   | elicitation-form | elicitation-url | elicitation-legacy
//                     (ACP `elicitation/create` form / url, and the older
//                     `session/elicitation` spelling); the client's reply is
//                     written to FAKE_ACP_DUMP as `decision`
//                   | exit-on-cancel | exit-on-prompt | exit-with-ansi
//                   | interleave (message → tool → message → tool → message)
//                   | no-session-config (reject session/set_mode + set_model
//                     with -32601, i.e. an agent predating those methods)
//                   | ask-peer (spawn the injected "agents" MCP server from
//                     session/new's mcpServers, call list_bots + ask_bot on a
//                     peer, and reply with what the peer said — the comms e2e)
//                   | delegate-peer (same as ask-peer but uses delegate_bot —
//                     returns immediately, the peer runs after our turn)
//                   | chief-delegate (delegates only for an ASSIGN_TO_PEER
//                     prompt; ordinary follow-ups stay responsive)
//                   | create-peer (a Chief creates a specialist, then delegates
//                     work to it through the returned id)
//                   | echo-gated (reply by echoing the full prompt, and when
//                     FAKE_ACP_GATE_FILE is set hold the turn open until that
//                     file exists — a deterministic busy window for the
//                     steer-queue e2e, with the echo pinning exactly what a
//                     drained turn was sent)
//   FAKE_ACP_DUMP   path to write {argv, env} as JSON, so a test can assert
//                   argv shape (agent/stdio flags) and env hygiene
//   FAKE_ACP_MODELS      comma-separated model ids. Enables the opencode-shaped
//                        surface: session/new and session/load return
//                        configOptions, and session/set_config_option switches
//                        the model (rejecting an unadvertised one with -32602).
//   FAKE_ACP_MODEL_STICKS  session/set_config_option succeeds but leaves the
//                        model where it was, so the confirmation guard in
//                        core.ts has something to catch
//   FAKE_ACP_USAGE_ROOT  put the prompt result's usage at the root instead of
//                        under _meta (what opencode 1.18.18 actually does)
//
// Close-confirmed stop fixtures (A2):
//   FAKE_ACP_MODE=cancel-ack  hold session/prompt open; answer it with
//                        stopReason "cancelled" on session/cancel and stay alive
//   FAKE_ACP_PID_FILE    write this child's pid (after probe branches exit)
//   FAKE_ACP_TERM        ignore | linger | gate: SIGTERM handling. POSIX-only
//                        observation — Windows taskkill /F runs no handler
//   FAKE_ACP_TERM_MS     linger delay before exiting (default 400, max 10 s)
//   FAKE_ACP_TERM_MARK   path written when SIGTERM arrives
//   FAKE_ACP_EXIT_GATE   with TERM=gate, exit once this file exists (max 10 s)
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const mode = process.env.FAKE_ACP_MODE ?? "happy";
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
// opencode-shaped surface: the session carries its own model catalog and the
// model is chosen with session/set_config_option, because `opencode acp` takes
// no -m. Off unless FAKE_ACP_MODELS is set, so every existing mode is byte-
// identical to before.
const models = (process.env.FAKE_ACP_MODELS ?? "").split(",").filter(Boolean);
let currentModel: string | null = models[0] ?? null;
const configOptions = () =>
  models.length
    ? [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: currentModel,
          options: models.map((value) => ({ value, name: value })),
        },
      ]
    : null;
// cursor-shaped surface: the session advertises `models.availableModels` with
// parameterised ids (`default[]`) that differ from the argv `--model` slugs
// (`auto`). Off unless FAKE_ACP_SESSION_MODELS is set, so every existing mode
// stays byte-identical. Format: "id|Name,id|Name" — the name is optional.
const acpModels = (process.env.FAKE_ACP_SESSION_MODELS ?? "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const [modelId, name] = entry.split("|");
    return name ? { modelId, name } : { modelId };
  });
const sessionModels = () =>
  acpModels.length ? { currentModelId: acpModels[0].modelId, availableModels: acpModels } : null;

const argv = process.argv.slice(2);
const dumpEnv = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "FAKE_ACP_MODE",
    "FAKE_ACP_RPC_DUMP",
    "TEST_POLICY",
    "OPENCODE_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "BOX_TOKEN",
    "MURAGE_TTS_KEY",
    "FACTORY_API_KEY",
    "UNSLOTH_STUDIO_AUTH_TOKEN",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_API_KEY",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_DISPLAY_NAME",
    "TEST_TURN_MODEL",
    "FUIGO_HOME",
    "HERMES_HOME",
    "MURAGE_PROVIDER_API_KEY",
    "MY_AGENT_TOKEN",
    // routing switches: stripped unconditionally, never allowlistable
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]] as const)),
);
const dumpState: Record<string, unknown> = { argv, env: dumpEnv };
if (process.env.FAKE_ACP_DUMP) {
  writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify({ argv, env: dumpEnv }, null, 2));
}
async function printProbeAndExit(text: string): Promise<never> {
  // Forced exit can discard pending pipe output. Probe callers must receive
  // the complete response before this short-lived fixture terminates.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${text}\n`, error => error ? reject(error) : resolve());
  });
  process.exit(0);
}
if (argv.includes("--version")) {
  await printProbeAndExit("fake-acp 1.0.0");
}
// Cursor's driver probes `agent status` / `agent models` on the same binary
// it later spawns for ACP. Answer those without entering the JSON-RPC loop
// so catalog/auth tests do not hang on stdin.
if (argv[0] === "status" || argv[0] === "whoami") {
  const authenticated = process.env.FAKE_ACP_AUTH !== "0";
  await printProbeAndExit(JSON.stringify({ isAuthenticated: authenticated }));
}
if (argv[0] === "models" || argv.includes("--list-models")) {
  if (models.length) {
    const verbose = argv.includes("--verbose");
    await printProbeAndExit(
      models.flatMap((slug) => verbose
        ? [
            slug,
            JSON.stringify({
              id: slug.slice(slug.indexOf("/") + 1),
              providerID: slug.slice(0, slug.indexOf("/")),
              name: slug,
              status: "active",
              limit: { context: 200_000 },
            }, null, 2),
          ]
        : [slug]).join("\n"),
    );
  }
  await printProbeAndExit(
    [
      "Available models",
      "",
      "auto - Auto (default)",
      "composer-2.5 - Composer 2.5 (current)",
      "gpt-5.3-codex - Codex 5.3",
      "cursor-live - Cursor Live",
    ].join("\n"),
  );
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
// Mirrors ENGINE_FRAME_MAX_BYTES in server/drivers/bounded-lines.ts (this
// fake stays dependency-free). "é" is two UTF-8 bytes: the text alone is one
// KiB over the limit, so the limit is counted in bytes, not characters.
const FIXTURE_FRAME_LIMIT = 32 * 1024 * 1024;
const fixtureOversizeText = () => "é".repeat(FIXTURE_FRAME_LIMIT / 2 + 512);
const fixtureLargeImageBase64 = () => Buffer.alloc(10 * 1024 * 1024, 7).toString("base64");
// Markers count only on the prompt's last line (the current request): the
// harness replays earlier messages into a fresh process's prompt, and an old
// marker there must not re-trigger a fixture on a later, ordinary turn.
const fixtureRequested = (text: string, marker: string) => (text.trimEnd().split("\n").pop() ?? "").includes(marker);
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });
const rpcMethods: string[] = [];
const recordMethod = (method: string) => {
  rpcMethods.push(method);
  if (process.env.FAKE_ACP_RPC_DUMP) writeFileSync(process.env.FAKE_ACP_RPC_DUMP, JSON.stringify(rpcMethods));
};

if (process.env.FAKE_ACP_PID_FILE) writeFileSync(process.env.FAKE_ACP_PID_FILE, String(process.pid));
const termBehavior = process.env.FAKE_ACP_TERM;
if (termBehavior === "ignore" || termBehavior === "linger" || termBehavior === "gate") {
  process.on("SIGTERM", () => {
    if (process.env.FAKE_ACP_TERM_MARK) writeFileSync(process.env.FAKE_ACP_TERM_MARK, String(Date.now()));
    if (termBehavior === "ignore") return;
    if (termBehavior === "linger") {
      setTimeout(() => process.exit(0), Math.min(10_000, Math.max(1, Number(process.env.FAKE_ACP_TERM_MS) || 400)));
      return;
    }
    const gate = process.env.FAKE_ACP_EXIT_GATE;
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (!gate || existsSync(gate) || Date.now() >= deadline) process.exit(0);
      else setTimeout(poll, 20);
    };
    poll();
  });
}
let pendingCancelAckPrompt: unknown = null;

/** Test-only resource fixture. Existing modes retain their exact output.
 * The gate and PNG are explicit task-owned paths; nothing is fetched. */
async function loadProof(id: unknown, sessionId: unknown) {
  const write = async (frame: unknown) => {
    if (!process.stdout.write(JSON.stringify(frame) + "\n")) await once(process.stdout, "drain");
  };
  const update = (content: object) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content } } });
  try {
    const gate = process.env.FAKE_LOAD_GATE, image = process.env.FAKE_LOAD_IMAGE;
    if (!gate || !image || !isAbsolute(gate) || !isAbsolute(image)) throw new Error("INVALID_INPUT");
    const timeout = Math.min(30000, Math.max(1, Number(process.env.FAKE_LOAD_TIMEOUT_MS) || 30000));
    await update({ type: "text", text: "LOAD_PROOF_READY" });
    const deadline = performance.now() + timeout;
    while (!existsSync(gate)) {
      if (performance.now() >= deadline) throw new Error("GATE_TIMEOUT");
      await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, deadline - performance.now()))));
    }
    const before = lstatSync(image);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) throw new Error("IMAGE_LIMIT");
    const fd = openSync(image, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error("IMAGE_CHANGED");
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, null);
        if (!count) throw new Error("IMAGE_CHANGED");
        offset += count;
      }
      const after = fstatSync(fd);
      if (readSync(fd, Buffer.alloc(1), 0, 1, null) || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("IMAGE_CHANGED");
    } finally { closeSync(fd); }
    const text = "L".repeat(1024);
    for (let n = 0; n < 64; n++) await update({ type: "text", text });
    const data = bytes.toString("base64");
    for (let n = 0; n < 3; n++) await update({ type: "image", data, mimeType: "image/png" });
    recordMethod("session/prompt.result");
    await write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 16384 } } });
  } catch (error) {
    const code = error instanceof Error && ["INVALID_INPUT", "GATE_TIMEOUT", "IMAGE_LIMIT", "IMAGE_CHANGED"].includes(error.message) ? error.message : "IO_FAILED";
    await write({ jsonrpc: "2.0", id, error: { code: -32000, message: `fake acp load-proof failed (${code})` } });
  }
}

// session/set_mode + session/set_model calls seen this run
const configCalls: Array<{ method: string; params: unknown }> = [];

// pending server→client permission request id → resolver
let pendingPermissionId: number | null = null;
let onPermissionAnswered: (() => void) | null = null;
// folder-trust mode: what the client advertised and whether the folder was
// trusted when the session was built (argv --trust, the way `fuigo --trust`
// grants the process cwd up front)
let folderTrustInteractive = false;
// the engine's own store (fuigo-workspace/src/trust.rs): an exact match on
// the workspace key is enough for a fixture — the server's reader mirrors
// the real cascade. The key is the cwd's git root, collapsed onto the main
// checkout's root for a linked worktree (`workspace_key`; the conventional
// `<main>/.git` layout only), else the cwd itself.
const fakeWorkspaceKey = (): string => {
  const cwd = process.cwd();
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const common = resolve(cwd, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    const gitDir = resolve(cwd, execFileSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    if (top && realpathSync.native(common) !== realpathSync.native(gitDir) && basename(common) === ".git") return realpathSync.native(dirname(common));
    return top ? realpathSync.native(top) : cwd;
  } catch {
    return cwd;
  }
};
const storeTrustsCwd = (): boolean => {
  if (process.env.FAKE_ACP_TRUST_STORE_REJECTED === "1") return false;
  const home = process.env.FUIGO_HOME || join(process.env.HOME || process.env.USERPROFILE || homedir(), ".fuigo");
  try {
    const text = readFileSync(join(home, "trusted_folders.toml"), "utf8");
    const table = text.indexOf(`[folders."${fakeWorkspaceKey()}"]`);
    if (table < 0) return false;
    const body = text.slice(table).split("\n").slice(1).join("\n");
    const next = body.search(/^\[/m);
    return /^trusted = true$/m.test(next < 0 ? body : body.slice(0, next));
  } catch {
    return false;
  }
};
const folderTrustedAtBuild = argv.includes("--trust") || (mode === "folder-trust" && storeTrustsCwd());
const agentsMdForReply = () => {
  if (!folderTrustedAtBuild) return "withheld";
  try {
    return readFileSync("AGENTS.md", "utf8").trim();
  } catch {
    return "absent";
  }
};

// ask-peer mode: the "agents" MCP server entry from session/new's mcpServers
type McpEntry = { command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;

/** Minimal one-shot MCP stdio client: initialize, call each tool in
 * sequence, return the text of the last result. Dependency-free. */
function driveMcp(entry: McpEntry, calls: Array<{ name: string; args: (prev: string) => object }>): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command, entry.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", reject);
    const timer = setTimeout(() => (child.kill(), reject(new Error("mcp timeout"))), 60_000);
    let step = -1; // -1 = initialize in flight
    let last = "";
    const write = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
    const next = () => {
      step += 1;
      if (step >= calls.length) {
        clearTimeout(timer);
        child.kill();
        return resolve(last);
      }
      const call = calls[step];
      write({ jsonrpc: "2.0", id: step + 2, method: "tools/call", params: { name: call.name, arguments: call.args(last) } });
    };
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined) continue;
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(msg.result?.content?.[0]?.text ?? "");
        next();
      }
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  });
}

function playTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hello from fake acp" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
}

/** Scripted text → tool → text → tool → text turn for order-contract tests. */
function playInterleaveTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before one" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "before two" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-2", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "completed" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "after" } } } });
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

// folder-trust mode, after session/new OR session/load: Fuigo's
// `maybe_spawn_interactive_trust_prompt` runs after either session reply
// (session_setup.rs `new_session_inner` / `load_session_inner`), only for an
// interactive client, only when the store has no grant. Detached from the
// prompt: the client may answer it before or after it sends session/prompt.
// (FUIGOTRUST3: the session/load branch was missing, so a second turn on a
// thread — resumed through its cursor — neither asked nor recorded
// `folderTrust` in the dump, and a test reading it after such a turn was
// timing-dependent.)
function afterSessionBuilt() {
  if (mode !== "folder-trust") return;
  dumpState.folderTrust = { trustedAtBuild: folderTrustedAtBuild, interactive: folderTrustInteractive, requested: false };
  if (process.env.FAKE_ACP_DUMP) writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
  if (!folderTrustedAtBuild && folderTrustInteractive) {
    (dumpState.folderTrust as { requested: boolean }).requested = true;
    if (process.env.FAKE_ACP_DUMP) writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
    pendingPermissionId = 9006;
    out({
      jsonrpc: "2.0",
      id: pendingPermissionId,
      method: "_fuigo/folder_trust/request",
      params: { sessionId: "fake-acp-session", cwd: process.cwd(), workspace: process.cwd(), configKinds: ["instructions"] },
    });
  }
}

function handle(msg: any) {
  // client's response to our permission request
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingPermissionId) {
    pendingPermissionId = null;
    if (process.env.FAKE_ACP_DUMP) {
      dumpState.decision = msg.result ?? { error: msg.error };
      writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
    }
    onPermissionAnswered?.();
    return;
  }
  if (!msg.method) return;
  recordMethod(msg.method);

  // Synthetic diagnostics: use the real request ID, but a spoofed provider
  // method and private canaries that must never enter runtime.error details.
  if (mode === `rpc-error:${msg.method}`) {
    return out({ jsonrpc: "2.0", id: msg.id, error: {
      code: -32603, message: "Internal error", acpMethod: "session/cancel",
      data: { http_status: 500, message: "fake-private-response", request: "fake-private-request", url: "https://billing.invalid/?key=fake-secret-canary" },
    } });
  }
  if (mode === "unknown-rpc-error" && msg.method === "session/prompt") {
    out({ jsonrpc: "2.0", id: -999, error: { code: -32603, message: "fake-secret-canary", data: { http_status: 500 } } });
  }

  switch (msg.method) {
    case "initialize": {
      if (mode === "exit-early") {
        process.stderr.write("fake-acp: simulated crash before result\n");
        process.exit(3);
      }
      const authMethods = mode === "no-auth" ? [] : [{ id: "cached_token" }];
      folderTrustInteractive = msg.params?.clientCapabilities?._meta?.["fuigo/folderTrust"]?.interactive === true;
      if (process.env.FAKE_ACP_DUMP) {
        dumpState.initialize = msg.params ?? null;
        writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
      }
      result(msg.id, { protocolVersion: 1, authMethods, _meta: { modelState: { currentModelId: "fake-acp-model" } } });
      break;
    }
    case "authenticate":
      result(msg.id, {});
      break;
    case "session/new": {
      if (mode === "auth-required") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "Authentication required", data: { providerId: "opencode-go" } },
        });
        break;
      }
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      if (process.env.FAKE_ACP_DUMP) {
        dumpState.mcpServers = servers;
        writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
      }
      agentsMcp = servers.find((s: any) => s?.name === "agents") ?? null;
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(servers, null, 2));
      }
      const opts = configOptions();
      const mdls = sessionModels();
      result(msg.id, {
        sessionId: "fake-acp-session",
        ...(opts ? { configOptions: opts } : {}),
        ...(mdls ? { models: mdls } : {}),
      });
      afterSessionBuilt();
      break;
    }
    case "session/load": {
      if (process.env.FAKE_ACP_LOAD_NULL) {
        result(msg.id, null);
        break;
      }
      const opts = configOptions();
      const mdls = sessionModels();
      result(msg.id, { ...(opts ? { configOptions: opts } : {}), ...(mdls ? { models: mdls } : {}) });
      // the real engine runs the trust prompt after session/load too
      // (`load_session_inner`), so a resumed turn is gated like a new one
      afterSessionBuilt();
      break;
    }
    // per-session settings (droid sets model/autonomy here, not via argv).
    // Recorded next to FAKE_ACP_DUMP so a test can assert what was applied.
    // NOTE: last writer wins — each turn spawns a fresh child, so a two-turn
    // test would only ever see the final turn's calls.
    case "session/set_mode":
    case "session/set_model": {
      if (mode === "no-session-config") {
        // an older agent that predates these methods
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
      if (mode === "set-model-invalid-params" && msg.method === "session/set_model") {
        // an agent whose ACP model namespace does not contain the id it was
        // sent — Cursor's answer when handed an argv slug like `auto`.
        return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params" } });
      }
      const settingId = msg.method === "session/set_mode" ? "modeId" : "modelId";
      if (typeof msg.params?.sessionId !== "string" || typeof msg.params?.[settingId] !== "string") {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: sessionId and ${settingId} must be strings` },
        });
        break;
      }
      configCalls.push({ method: msg.method, params: msg.params });
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.config.json`, JSON.stringify(configCalls, null, 2));
      }
      result(msg.id, {});
      break;
    }
    case "session/set_config_option": {
      const { configId, value } = msg.params ?? {};
      if (configId !== "model" || !models.includes(value)) {
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: `Invalid params: model not found: ${value}`, data: { modelId: value } },
        });
        break;
      }
      // FAKE_ACP_MODEL_STICKS: answer OK and keep the old model anyway. Nothing
      // in the protocol forbids it, and it is the shape core.ts's confirmation
      // guard exists for — an error is loud, this is silent.
      if (!process.env.FAKE_ACP_MODEL_STICKS) currentModel = value;
      result(msg.id, { configOptions: configOptions() });
      break;
    }
    case "session/prompt": {
      if (mode === "cancel-ack") {
        pendingCancelAckPrompt = msg.id;
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture cancellation ready" } } } });
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "exit-on-cancel") {
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture cancellation ready" } } } });
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "exit-on-prompt" || mode === "exit-with-ansi") {
        const diagnostic = mode === "exit-with-ansi"
          ? `\u001b[31mtool_error: fixture failure\u001b[0m\nsk-test-${"SYNTHETICKEYCANARY".repeat(24)}\n\u001b[32mSTDERR_VISIBLE_END\u001b[0m\n`
          : "fake-acp: simulated prompt exit\n";
        process.stderr.write(diagnostic, () => process.exit(1073807364));
        return;
      }
      if (mode === "load-proof") {
        void loadProof(msg.id, msg.params?.sessionId).catch(() => { process.exitCode = 1; });
        return;
      }
      if (mode === "credit-exhausted") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: {
          http_status: 402,
          message: "API error (status 402 Payment Required): Your credit balance is exhausted. https://billing.invalid/?token=fake-secret-canary",
        } } });
        return;
      }
      if (mode === "hang") {
        // never resolve the prompt — lets tests exercise interrupt
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "fail-after-text") {
        // Stream real text, THEN fail the turn — the shape of a crash
        // mid-answer. This is the one case where the routine-failed/done
        // notification dedup is load-bearing: the reply is non-empty, so
        // nothing else suppresses the generic done.
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half a report, then a crash" } } } });
        recordMethod("session/prompt.error");
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "fake acp: turn failed after streaming" } });
        return;
      }
      const complete = () => {
        recordMethod("session/prompt.result");
        result(
          msg.id,
          // FAKE_ACP_USAGE_ROOT reproduces opencode 1.18.18's shape: usage at
          // the result root with an empty _meta, instead of usage under _meta.
          process.env.FAKE_ACP_USAGE_ROOT
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, _meta: {} }
            : { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } },
        );
      };
      const promptText = String(msg.params?.prompt?.[0]?.text ?? "");
      if (mode === "folder-trust") {
        // the reply says what the session was built with, the way a real
        // turn's answer would (or would not) carry an AGENTS.md instruction
        const answer = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `agents: ${agentsMdForReply()}` } } } });
          complete();
        };
        // The real engine's prompt runs gated while its request is open; the
        // fake instead finishes the turn only once the client has answered,
        // so a test can read the answer from the dump before the driver
        // tears the child down (the client always answers: a known decision
        // at once, a card when the owner does, and a cancel when the turn
        // ends).
        if (pendingPermissionId === 9006 && process.env.FAKE_ACP_TRUST_FAIL_PROMPT === "1") {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "fake-acp: simulated prompt failure while the trust request is open" } });
          return;
        }
        if (pendingPermissionId === 9006 && !process.env.FAKE_ACP_TRUST_PROMPT_FIRST) {
          onPermissionAnswered = answer;
          return;
        }
        answer();
        return;
      }
      // Bounded-ingress fixtures (A4), keyed on the prompt so one fake can
      // run an oversized turn beside an ordinary one.
      if (fixtureRequested(promptText, "__fixture_oversize_frame__")) {
        // a VALID frame one KiB over the limit, then a clean success: the
        // driver must fail the turn rather than read past the dropped frame
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: fixtureOversizeText() } } } });
        complete();
        return;
      }
      if (fixtureRequested(promptText, "__fixture_oversize_open_frame__")) {
        // an oversized frame that never ends; stay alive until stopped
        process.stdout.write(`{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"${fixtureOversizeText()}`);
        setInterval(() => {}, 1_000);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_large_frame__")) {
        // an inline image at the harness's 10 MiB image cap: near the size a
        // real frame reaches, and well inside the frame limit
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "image", data: fixtureLargeImageBase64(), mimeType: "image/png" } } } });
        complete();
        return;
      }
      if (mode === "chief-delegate" && promptText.includes("CHIEF_RESULT_CONTEXT")) {
        const sawDelegatedResult =
          promptText.includes("@LongWorker replied to the delegated task")
          && promptText.includes("long delegated task");
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                text: sawDelegatedResult
                  ? "chief saw delegated result: long delegated task"
                  : "chief did not see delegated result",
              },
            },
          },
        });
        complete();
        return;
      }
      if (
        mode === "chief-delegate"
        && agentsMcp
        && promptText.includes("ASSIGN_TO_PEER")
        && !promptText.includes("CHIEF_FOLLOW_UP")
      ) {
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "delegate_bot",
            args: (list) => ({
              bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
              message: "long delegated task",
              reason: "background assignment",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `assigned: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${message}` } } } });
            complete();
          });
        return;
      }
      if ((mode === "ask-peer" || mode === "create-peer") && agentsMcp && Number(agentsMcp.env?.find(entry => entry.name === "MURAGE_TURN_DEPTH")?.value ?? "0") > 0) {
        // A nested helper answers its assignment, while proving that the
        // actual injected MCP server still supplies its scoped directory.
        const depth = agentsMcp.env?.find(entry => entry.name === "MURAGE_TURN_DEPTH")?.value;
        void driveMcp(agentsMcp, [{ name: "list_bots", args: () => ({}) }]).then(list => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `hello from fake acp; agents tools available at depth ${depth}\n${list}` } } } });
          complete();
        }).catch(error => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${error.message}` } } } }); complete(); });
        return;
      }
      if (mode === "batch-delegate" && agentsMcp) {
        let targets: string[] = [];
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          ...Array.from({ length: 8 }, (_, index) => ({ name: "delegate_bot", args: (previous: string) => {
            if (index === 0) targets = previous.split("\n").filter(line => line.startsWith("- Batch helper ")).map(line => /id: ([\w-]+)/.exec(line)?.[1] ?? "");
            if (targets.length !== 8) throw new Error("batch fixture requires exactly eight helpers");
            return { bot_id: targets[index], message: `batch work ${index}` };
          } })),
        ]).then(reply => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `eight assignments queued: ${reply}` } } } }); complete(); })
          .catch(error => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `batch error: ${error.message}` } } } }); complete(); });
        return;
      }
      if (mode === "ask-peer" && agentsMcp) {
        // the comms e2e: reach a peer bot through the injected agents proxy
        // and reply with whatever it said (the peer's fake runs plain happy
        // — its depth-1 turn gets no agents server, so no recursion)
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "ask_bot",
            args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "ping from fake" }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer says: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "create-peer" && agentsMcp) {
        void driveMcp(agentsMcp, [
          {
            name: "create_bot",
            args: () => ({
              name: "Pixel",
              role: "Product designer",
              instructions: "Design and review the user experience.",
            }),
          },
          {
            name: "delegate_bot",
            args: (created) => ({
              bot_id: /id: ([\w-]+)/.exec(created)?.[1] ?? "",
              message: "Review the new onboarding flow.",
              reason: "design review",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `team created: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `create error: ${message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "echo-gated") {
        // echoing the WHOLE prompt (system + turn text) lets a test assert
        // both what a drained turn was sent and what it was NOT sent (e.g.
        // the webhook untrusted-data paragraph a steered turn must not get)
        const finish = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `echo: ${promptText}` } } } });
          complete();
        };
        const gate = process.env.FAKE_ACP_GATE_FILE;
        if (gate && !existsSync(gate)) {
          const poll = setInterval(() => {
            if (!existsSync(gate)) return;
            clearInterval(poll);
            finish();
          }, 50);
          return;
        }
        finish();
        return;
      }
      if (mode === "delegate-peer" && agentsMcp) {
        // async peer-handoff e2e: queue the delegation and return
        // immediately; the harness fires the peer's depth-1 turn after our
        // turn settles. We don't need the peer's reply in our text — the
        // comms e2e verifies the channel mirroring on its own.
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          {
            name: "delegate_bot",
            args: (list) => ({
              bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
              message: "delegated task",
              reason: "followup",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegated: ${reply}` } } } });
            complete();
          })
          .catch((e) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `delegate error: ${(e as Error).message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "image") {
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
            },
          },
        });
      } else if (mode === "interleave") playInterleaveTurn();
      else if (mode !== "empty-reply") playTurn();
      if (mode === "fuigo-question") {
        // Fuigo's AskUserQuestion over ACP: `_fuigo/ask_user_question` with
        // the exact AskUserQuestionExtRequest shape (types.rs), two
        // questions, one multi-select. Held until the client answers.
        pendingPermissionId = 9002;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "_fuigo/ask_user_question",
          params: {
            sessionId: "fake-session",
            toolCallId: "tc-1",
            mode: "default",
            questions: [
              { question: "Which database?", options: [{ label: "Redis", description: "In-memory", preview: "<div/>" }, { label: "Postgres", description: "Relational" }] },
              { question: "Which frameworks?", options: [{ label: "React", description: "" }, { label: "Vue", description: "" }], multiSelect: true },
            ],
          },
        });
        return;
      }
      if (mode === "fuigo-elicit") {
        // Fuigo's bridge of an MCP server's elicitation (McpElicitExtRequest):
        // ACP form fields plus serverName; the reply is tagged `outcome`.
        pendingPermissionId = 9005;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "_fuigo/mcp/elicit",
          params: {
            sessionId: "fake-session",
            toolCallId: "mcp-elicit-1",
            serverName: "deployer",
            message: "Which environment?",
            mode: "form",
            requestedSchema: { type: "object", properties: { environment: { type: "string", enum: ["staging", "production"] } }, required: ["environment"] },
          },
        });
        return;
      }
      if (mode === "elicitation-form" || mode === "elicitation-legacy") {
        // ACP v1 elicitation/create in form mode (CreateElicitationRequest),
        // or the older Rust-crate spelling of the same request.
        pendingPermissionId = 9003;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: mode === "elicitation-legacy" ? "session/elicitation" : "elicitation/create",
          params: {
            sessionId: "fake-session",
            toolCallId: "tc-2",
            mode: "form",
            message: "Deploy settings",
            requestedSchema: {
              type: "object",
              properties: {
                environment: { type: "string", title: "Environment", enum: ["staging", "production"] },
                features: { type: "array", title: "Features", items: { type: "string", enum: ["cache", "cdn"] } },
                confirm: { type: "boolean", title: "Really?" },
              },
              required: ["environment", "confirm"],
            },
          },
        });
        return;
      }
      if (mode === "elicitation-url") {
        pendingPermissionId = 9004;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "elicitation/create",
          params: {
            sessionId: "fake-session",
            mode: "url",
            elicitationId: "el-1",
            url: "https://example.com/authorize?state=abc",
            message: "Sign in to the deploy service to continue",
          },
        });
        return;
      }
      if (mode === "permission" || mode === "question-tool" || mode === "permission-session-first") {
        // ask the client to approve a tool, then complete once answered.
        // question-tool: the agent routes its AskUserQuestion tool through
        // request_permission (named in the tool call), exactly the shape a
        // question must never be auto-approved from.
        pendingPermissionId = 9001;
        onPermissionAnswered = complete;
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: mode === "question-tool"
              ? {
                  kind: "other",
                  title: "AskUserQuestion",
                  rawInput: {
                    questions: [{
                      question: "Which branch should I use?",
                      header: "Branch",
                      options: [{ label: "main" }, { label: "develop" }],
                      multiSelect: false,
                    }],
                  },
                }
              : { kind: "execute", rawInput: { command: "echo hi" }, title: "echo hi" },
            options: mode === "permission-session-first"
              // verbatim order and ids from a Fuigo 1.0.12 `Write` prompt
              ? [
                  { optionId: "allow-edits-session", kind: "allow_always", name: "Yes, allow all edits during this session" },
                  { optionId: "allow-once", kind: "allow_once", name: "Yes" },
                  { optionId: "reject-once", kind: "reject_once", name: "No, and tell Fuigo what to do differently" },
                ]
              : [
                  { optionId: "allow-once", kind: "allow_once" },
                  { optionId: "reject", kind: "reject_once" },
                ],
          },
        });
        return;
      }
      complete();
      break;
    }
    case "session/cancel":
      if (mode === "cancel-ack" && pendingCancelAckPrompt !== null) {
        // A cooperative agent acknowledges promptly but only exits when the
        // client terminates it — the gap close-confirmed stop must cover.
        const id = pendingCancelAckPrompt;
        pendingCancelAckPrompt = null;
        result(id, { stopReason: "cancelled" });
        break;
      }
      if (mode === "exit-on-cancel") {
        // Exit before replying to the outstanding prompt, inside the driver's
        // cancellation grace. POSIX truncates this Windows exit value to 4.
        process.exit(1073807364);
      }
      // the interrupted prompt resolves as cancelled
      break;
    default:
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
