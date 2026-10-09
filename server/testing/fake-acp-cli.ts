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
//   FAKE_CUSTOM_TOOL_SERVER / FAKE_CUSTOM_TOOL_LOG  every prompt calls the first
//                   tool of that owner server from session/new's mcpServers
//                   (fake-custom-tool.ts)
//   FAKE_ACP_MODE   happy (default) | project-propose (the Chief's New project
//                   proposal through the mounted agents server; see fake-mcp-propose.ts) | text-propose
//                   (the proposal as a block in the reply, after a refused shell ask) | lead-delegate | lead-loop | image | empty-reply | reasoning-only | exit-early | fail-after-text | hang | stall-after-text | no-auth | auth-required | permission
//                   | slow-tool (start a tool call and send nothing while it
//                     "runs" for FAKE_ACP_TOOL_MS, default 600, a quiet
//                     `sleep` or build, then finish it and answer)
//                   | stall-after-tool (finish a tool call, then go fully
//                     silent forever: the guard must still fire once no tool
//                     is running)
//                   | stall-after-text (stream one message chunk, then go
//                     fully silent forever — no update, no result, no exit:
//                     a wedged agent mid-answer. Nothing else will arrive, so
//                     the driver's prompt idle guard must fail the turn)
//                     | wrapped-tool  one tool call made through a "use a tool"
//                     wrapper, failing with a reason in its content
//                   | tool-image  two completed tool calls whose output carries
//                     an image: a custom MCP server's, and the computer
//                     surface's (a live frame, not a deliverable)
//                   | computer-exec-image  the computer surface called with a
//                     shell command in its arguments, answering with a frame
//                   | wrapped-tool-image  a custom MCP server's screenshot made
//                     through a "use a tool" wrapper, answering with an image
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
//                   | exit-hostile-stderr (exit before the prompt result with
//                     stderr the driver must sanitise: a bidi override, a BEL,
//                     an https URL with a ?key= and a user:pass@IP authority)
//                   | exit-noisy-stderr (exit before the prompt result after
//                     writing what a real CLI agent writes on the way down:
//                     kilobytes of structured NDJSON records, with the fatal
//                     line LAST)
//                   | interleave (message → tool → message → tool → message)
//                   | no-session-config (reject session/set_mode + set_model
//                     with -32601, i.e. an agent predating those methods)
//                   | ask-peer (spawn the injected "agents" MCP server from
//                     session/new's mcpServers, call list_bots + ask_bot on a
//                     peer, and reply with what the peer said — the comms e2e)
//                   | delegate-peer (same as ask-peer but uses delegate_bot —
//                     returns immediately, the peer runs after our turn)
//                     (FAKE_ACP_DELEGATE_MESSAGE overrides the task text, default
//                     "delegated task")
//                   | chief-delegate (delegates only for an ASSIGN_TO_PEER
//                     prompt; ordinary follow-ups stay responsive)
//                   | create-peer (a Chief creates a specialist, then delegates
//                     work to it through the returned id)
//                   | echo-gated (reply by echoing the full prompt, and when
//                     FAKE_ACP_GATE_FILE is set hold the turn open until that
//                     file exists — a deterministic busy window for the
//                     steer-queue e2e, with the echo pinning exactly what a
//                     drained turn was sent)
//   FAKE_ACP_PERMISSION_COMMAND  the command a permission-mode ask names
//                   (default "echo hi")
//   FAKE_ACP_PERMISSION_TOOLCALL  JSON tool call a permission-mode ask sends
//                   verbatim instead of the default shell command
//   FAKE_ACP_DUMP   path to write {argv, env} as JSON, so a test can assert
//                   argv shape (agent/stdio flags) and env hygiene
//   FAKE_ACP_LOAD_ERROR  JSON-RPC error object session/load answers with
//                   (a refusal, or OpenCode's session-not-found shape)
//   FAKE_ACP_PROMPT_DUMP  path to write the last session/prompt's content
//                   blocks as JSON, so a test can assert what reached the
//                   engine (text, and any inline image parts)
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
// Process pool fixtures (#1575):
//   FAKE_ACP_SPAWN_LOG   append this child's pid, one line per process start,
//                        so a test can count spawns across turns
//   FAKE_ACP_RPC_LOG     append one JSON line per request or notification this
//                        child receives,
//                        {pid, method, noReplay?, agentsToken?}; unlike
//                        FAKE_ACP_RPC_DUMP it survives a respawn. The
//                        token is a fingerprint (fixture-dump.ts), as are
//                        credential-named MCP env entries in every dump
//   FAKE_ACP_AGENTS_CAPABILITY  path to write the agents server's env as
//                        handed, for the one test that must call Murage
//                        with the turn's own capability; never a dump
//   FAKE_ACP_UNIQUE_SESSIONS=1  every session/new opens its own session id
//                        (`fake-acp-session-<pid>-<n>`), the way a real engine does
//   FAKE_ACP_LATE_FRAMES_MS  N: N ms after this process's FIRST prompt completes,
//                        send that session's late output (an agent_message_chunk
//                        "LATE FRAME FROM THE EARLIER SESSION") and a
//                        session/request_permission (id 9300) naming it; the
//                        client's reply is appended to FAKE_ACP_LATE_REPLY_LOG
//   FAKE_ACP_REJECT_LIVE_LOAD  refuse session/load of a session that is
//                        already live in this process (an engine that cannot
//                        re-establish a resident session)
//   FAKE_ACP_MCP_READY=1  announce `_fuigo/mcp_initialized {sessionId}` after
//                        session/new or session/load hands it servers, and —
//                        like Fuigo — after a resident load only when the
//                        servers actually changed
//   FAKE_ACP_MCP_READY_NEW_ONLY=1  announce readiness after session/new only,
//                        never after session/load (servers that never report
//                        ready on a reused process)
//   FAKE_ACP_MCP_CHILD_LOG  run each handed server set as a real child
//                        process (the first server's command and args, as
//                        handed; `sleep 300` when none), the way Fuigo starts its MCP
//                        servers: session/new starts one, and a resident
//                        session/load with changed servers stops it and starts
//                        a replacement (a new pid). Each pid is appended to the log
//   __fixture_cancel_ack__  (prompt marker) hold THIS prompt open and answer
//                        it "cancelled" on session/cancel, staying alive: a
//                        cooperative cancel on a process that is otherwise
//                        in its ordinary mode
//   FAKE_ACP_NAMED_UPDATES=1  every session/update the fixture sends names the
//                        live session (a real engine always does)
//   FAKE_ACP_LATE_SHAPE  with FAKE_ACP_LATE_FRAMES_MS: "sessionless" sends the
//                        late chunk and permission request naming no session;
//                        "helper" announces a helper (child_session_id
//                        "late-helper") under the earlier session, then sends
//                        the permission request from that helper's session
//   __fixture_tool_after_turn__  (prompt marker) finish the turn, then report a
//                        tool call (and its progress) 150 ms later, while idle
//   __fixture_wake_after_turn__  (prompt marker) finish the turn, then 2 s later
//                        report turn_completed on _fuigo/session_notification,
//                        the way Fuigo starts a turn of its own after end_turn
//   FAKE_ACP_INIT_DELAY_MS  answer initialize only after this long: a startup
//                        cost, so a reused process's saving is measurable
//   __fixture_child_later__  (prompt marker) finish the turn, then start
//                        `sleep 30` as its own child FAKE_ACP_CHILD_DELAY_MS
//                        (default 800) later and write its pid to
//                        FAKE_ACP_CHILD_PID_FILE: a child that appears after
//                        the park check passed
//   __fixture_child_after_turn__  (prompt marker) start `sleep 30` as its own
//                        child, write its pid to FAKE_ACP_CHILD_PID_FILE, then
//                        finish the turn with the child still running
//   __fixture_request_after_turn__  (prompt marker) finish the turn, then
//                        ask for a permission 150 ms later, while idle
//   Like Fuigo, session/load of the session this process already holds
//   re-applies the `mcpServers` it carries (the agents server a peer-comms
//   mode calls is the new one); a load on a fresh process is unchanged.
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
// Engine error fixtures (MU):
//   FAKE_ACP_MODE=engine-error-data:object|string|hostile  fail session/prompt
//   FAKE_ACP_MODE=engine-error-message:hostile|plain  fail session/prompt with
//     the content in the JSON-RPC message instead of `error.data`
//                        with -32603 whose data is Fuigo 1.0.18's typed object
//                        ({message, error_kind}), Fuigo <=1.0.17's plain string,
//                        or hostile text the driver must sanitise
//   FAKE_ACP_MODE=cancel-reject  hold session/prompt open like cancel-ack, but
//                        answer session/cancel by REJECTING the prompt (-32603,
//                        error_kind cancelled) and stay alive
//   FAKE_ACP_MODE=cancel-other-reason  hold session/prompt open like cancel-ack,
//                        but answer session/cancel by RESOLVING the prompt with
//                        a stop reason that is not "cancelled" ("refusal")
//   FAKE_ACP_MODE=stderr-rpc-error|stderr-happy  write more than 8 KiB of stderr
//                        (ANSI styling, a key-shaped canary, a known last line),
//                        then fail session/prompt with -32603 or complete it
//   FAKE_ACP_MODE=retry-status-thought  Fuigo 1.0.18's retry progress: an
//                        agent_thought_chunk tagged _meta["fuigo/retryStatus"],
//                        then ordinary reasoning and the answer
//   FAKE_ACP_MODE=plan   ACP `plan` session updates (the protocol's to-do list):
//                        a first plan, a malformed one, an update that ticks
//                        an entry off, then the answer
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { once } from "node:events";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fixtureCredentialFingerprint } from "./fixture-dump.ts";
import { logProposalTurn, proposalFrom, proposalReply, proposeThroughMcp } from "./fake-mcp-propose.ts";
import { fakeReviewByTool, fakeReviewReply, fakeReviewToolArgs } from "./fake-review.ts";
import { callFirstCustomTool, customToolReply, customToolServer } from "./fake-custom-tool.ts";

const mode = process.env.FAKE_ACP_MODE ?? "happy";
// permission modes: the command the approval asks about (default "echo hi")
const permissionCommand = process.env.FAKE_ACP_PERMISSION_COMMAND || "echo hi";
// A whole tool call (JSON) for a permission-mode ask, verbatim, so a test can
// replay the exact shape an engine sent (an MCP tool through use_tool).
const permissionToolCall = process.env.FAKE_ACP_PERMISSION_TOOLCALL ? JSON.parse(process.env.FAKE_ACP_PERMISSION_TOOLCALL) : null;
const permissionFile = process.env.FAKE_ACP_PERMISSION_FILE || "/tmp/fake-acp-edit.md";
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
// A second, distinguishable 1x1 raster: the computer surface's frame.
const SCREEN_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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
// Explicit assertion fields only, never the inherited environment.
// Credentials are fingerprints (fixture-dump.ts), never values.
const dumpCredentials = new Set([
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
  "KIMI_MODEL_API_KEY",
  "MURAGE_PROVIDER_API_KEY",
  "MY_AGENT_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
]);
const dumpEnv = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "FAKE_ACP_MODE",
    "FAKE_ACP_RPC_DUMP",
    "TEST_POLICY",
    "KIMI_MODEL_NAME",
    "KIMI_MODEL_BASE_URL",
    "KIMI_MODEL_PROVIDER_TYPE",
    "KIMI_MODEL_DISPLAY_NAME",
    "TEST_TURN_MODEL",
    "FUIGO_HOME",
    "HERMES_HOME",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    // Flux Memory headers: config overlays and settings paths, no secret
    "FUIGO_CONFIG",
    "GROK_CONFIG",
    "QWEN_CODE_SYSTEM_SETTINGS_PATH",
    "OPENCODE_CONFIG_CONTENT",
    // routing switches: stripped unconditionally, never allowlistable
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    ...dumpCredentials,
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, dumpCredentials.has(key) ? fixtureCredentialFingerprint(process.env[key]!) : process.env[key]]] as const)),
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

const rawOut = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
// FAKE_ACP_NAMED_UPDATES=1: every session/update names the live session, as the
// ACP spec has a real engine do (the fixture's own shorthand frames omit it).
const out = (obj: unknown) => {
  const frame = obj as { method?: unknown; params?: { sessionId?: unknown } } | null;
  if (process.env.FAKE_ACP_NAMED_UPDATES === "1" && frame?.method === "session/update" && frame.params && frame.params.sessionId === undefined && liveSession) {
    return rawOut({ ...frame, params: { sessionId: liveSession, ...frame.params } });
  }
  return rawOut(obj);
};
// Mirrors ENGINE_FRAME_MAX_BYTES in server/drivers/bounded-lines.ts (this
// fake stays dependency-free). "é" is two UTF-8 bytes: the text alone is one
// KiB over the limit, so the limit is counted in bytes, not characters.
const FIXTURE_FRAME_LIMIT = 32 * 1024 * 1024;
const fixtureOversizeText = () => "é".repeat(FIXTURE_FRAME_LIMIT / 2 + 512);
const fixtureLargeImageBase64 = () => Buffer.alloc(10 * 1024 * 1024, 7).toString("base64");
// Markers count only on the prompt's last line (the current request): the
// harness replays earlier messages into a fresh process's prompt, and an old
// marker there must not re-trigger a fixture on a later, ordinary turn.
// A room turn's prompt is the room transcript followed by the harness's
// "(Reply to the conversation above as NAME.)" trailer, so its current request
// is the last transcript line before that trailer.
const ROOM_REPLY_TRAILER = /^\(Reply to the conversation above as .+\.\)$/;
const fixtureRequested = (text: string, marker: string) => {
  const lines = text.trimEnd().split("\n");
  if (lines.length > 1 && ROOM_REPLY_TRAILER.test(lines.at(-1) ?? "")) { lines.pop(); while (lines.length > 1 && !lines.at(-1)?.trim()) lines.pop(); }
  return (lines.pop() ?? "").includes(marker);
};
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });
// `_fuigo/interject`, Fuigo's steer into a running prompt. FAKE_ACP_INTERJECT:
// "fallback" answers queued and echoes it, then runs it as its own
// `interject-fallback-` turn after the prompt result (a steer that missed the
// turn's final drain); "silent" answers nothing and echoes it after
// FAKE_ACP_LATE_ECHO_MS. Unset: method not found, as other engines answer.
const strandedInterjections: string[] = [];
let fallbackTurns = 0;
const runStrandedInterjection = () => {
  const text = strandedInterjections.shift();
  if (text === undefined) return;
  const promptId = `interject-fallback-${++fallbackTurns}`;
  setTimeout(() => {
    out({ jsonrpc: "2.0", method: "_fuigo/queue/changed", params: { entries: [], runningPromptId: promptId, runningText: text, runningKind: "prompt" } });
    out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: ` fallback reply #${fallbackTurns}` } } } });
    setTimeout(() => {
      out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" } } });
      out({ jsonrpc: "2.0", method: "_fuigo/queue/changed", params: { entries: [] } });
    }, 300);
  }, 100);
};
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
/** project-propose mode's own permission asks, answered by id. */
const proposalAsks = new Map<number, (result: any) => void>();
let onPermissionAnswered: (() => void) | null = null;
// folder-trust mode: what the client advertised and whether the folder was
// trusted when the session was built (argv --trust, the way `fuigo --trust`
// grants the process cwd up front)
let folderTrustInteractive = false;
// the engine's own store (fuigo-workspace/src/trust.rs): an exact match on
// the workspace key is enough for a fixture — the server's reader mirrors
// the real cascade. The key is the cwd's git root, collapsed onto the main
// checkout's root for a linked worktree (`workspace_key`; the conventional
// `<main>/.git` layout only), else the cwd itself — canonical either way,
// as the engine's dunce::canonicalize keeps it (a cwd handed over as an 8.3
// short name on Windows is stored under its long one).
const fakeWorkspaceKey = (): string => {
  const cwd = process.cwd();
  const canonical = (path: string) => { try { return realpathSync.native(path); } catch { return path; } };
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const common = resolve(cwd, execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    const gitDir = resolve(cwd, execFileSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    if (top && realpathSync.native(common) !== realpathSync.native(gitDir) && basename(common) === ".git") return realpathSync.native(dirname(common));
    return top ? realpathSync.native(top) : canonical(cwd);
  } catch {
    return canonical(cwd);
  }
};
const storeTrustsCwd = (): boolean => {
  if (process.env.FAKE_ACP_TRUST_STORE_REJECTED === "1") return false;
  const home = process.env.FUIGO_HOME || join(process.env.HOME || process.env.USERPROFILE || homedir(), ".fuigo");
  try {
    const text = readFileSync(join(home, "trusted_folders.toml"), "utf8");
    // the key as the engine's `toml` crate writes it: a basic string, so a
    // Windows path's backslashes are escaped
    const table = text.indexOf(`[folders.${JSON.stringify(fakeWorkspaceKey())}]`);
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
type McpEntry = { name?: string; command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;
/** The session this process built or loaded, as Fuigo keeps it resident. */
let liveSession: string | null = null;
/** The serialized servers the live session was last handed. */
let liveServers: string | null = null;
let markerCancelAck = false;
/** FAKE_ACP_MCP_CHILD_LOG: the running stand-in for the session's MCP servers. */
let mcpChild: ReturnType<typeof spawn> | null = null;
const startMcpChild = (servers: unknown) => {
  const log = process.env.FAKE_ACP_MCP_CHILD_LOG;
  if (!log) return;
  mcpChild?.kill("SIGKILL");
  const first = Array.isArray(servers) ? servers[0] as { command?: unknown; args?: unknown } | undefined : undefined;
  mcpChild = typeof first?.command === "string"
    ? spawn(first.command, Array.isArray(first.args) ? first.args.map(String) : [], { stdio: "ignore" })
    : spawn("sleep", ["300"], { stdio: "ignore" });
  appendFileSync(log, `${mcpChild.pid}\n`);
};
const announceMcpReady = (sessionId: string, servers: unknown) => {
  if (process.env.FAKE_ACP_MCP_READY !== "1" || !Array.isArray(servers) || !servers.length) return;
  out({ jsonrpc: "2.0", method: "_fuigo/mcp_initialized", params: { sessionId, mcpToolCount: servers.length, elapsedMs: 1 } });
};
const agentsTokenOf = (servers: unknown): string | undefined => {
  if (!Array.isArray(servers)) return undefined;
  const agents = servers.find((s: any) => s?.name === "agents") as McpEntry | undefined;
  const token = agents?.env?.find(entry => entry.name === "MURAGE_COMMS_TOKEN")?.value;
  return token === undefined ? undefined : fixtureCredentialFingerprint(token);
};
/** The handed MCP servers as the dumps record them: a credential-named env
 * entry or header is a fingerprint (fixture-dump.ts), never its value. */
const CREDENTIAL_NAME = /token|key|secret|password|passwd|auth|credential|cookie/i;
const dumpedServers = (servers: unknown): unknown => {
  if (!Array.isArray(servers)) return servers;
  const rows = (list: unknown) => Array.isArray(list)
    ? list.map((row: any) => typeof row?.name === "string" && typeof row?.value === "string" && CREDENTIAL_NAME.test(row.name) ? { ...row, value: fixtureCredentialFingerprint(row.value) } : row)
    : list;
  return servers.map((server: any) => server && typeof server === "object"
    ? { ...server, ...(server.env !== undefined ? { env: rows(server.env) } : {}), ...(server.headers !== undefined ? { headers: rows(server.headers) } : {}) }
    : server);
};
if (process.env.FAKE_ACP_SPAWN_LOG) appendFileSync(process.env.FAKE_ACP_SPAWN_LOG, `${process.pid}\n`);

/** Minimal one-shot MCP stdio client: initialize, call each tool in
 * sequence, return the text of the last result. Dependency-free. */
function driveMcp(entry: McpEntry, calls: Array<{ name: string; args: (prev: string) => object }>): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command, entry.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", reject);
    // FAKE_ACP_MCP_TIMEOUT_MS: the engine gives up on a tool call that long
    // after it started (the tool's own connection closes), as a real engine's
    // tool timeout does; the turn then goes on
    const timer = setTimeout(() => (child.kill(), reject(new Error("mcp timeout"))), Number(process.env.FAKE_ACP_MCP_TIMEOUT_MS) || 60_000);
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

/** Scripted reasoning-only turn: thought chunks and nothing else, the shape
 * of a provider that never leaves its thinking stream yet still answers
 * end_turn, which the driver must report as a lost turn, not a success. */
function playReasoningTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: "considering the request at length" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { text: " without ever producing an answer" } } } });
}

function playTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hello from fake acp" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
}

/** A wrapper-tool turn: the engine exposes one "use a tool" tool and passes
 * the real call through in its arguments, then fails it with a reason. Both
 * halves are what a chip has to survive — the wrapper name and the reason. */
function playWrappedToolTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-w", title: "use_tool",
    rawInput: { tool_name: "murage-memory-1f83c2b455279a599bd7__memory_search", tool_input: { query: "quarterly plan" } } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-w", status: "failed",
    content: [{ type: "content", content: { type: "text", text: "Memory is not available for this turn.\nsearch timed out after 5s" } }] } } });
}

/** Two completed tool calls whose output carries an image: one from a custom
 * MCP server (a deliverable) and one from Murage's own computer surface
 * (a live frame that must not be retained). ACP wraps each output part as
 * `{type:"content", content:<block>}`. */
function playToolImageTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-img", title: "mcp__omarchy__screenshot" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-img", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "captured" } }, { type: "content", content: { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" } }] } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-screen", title: "mcp__computer__screenshot" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-screen", status: "completed",
    content: [{ type: "content", content: { type: "image", data: SCREEN_PIXEL_PNG, mimeType: "image/png" } }] } } });
}

/** Murage's own computer surface, reached through ACP with a shell command in
 * its arguments (`computer_exec`). The chip deliberately reads as the command
 * — that is what a person wants to see — but the frame the call answers with
 * is still a live screen preview, not a deliverable. */
function playComputerExecImageTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-exec", title: "mcp__computer__computer_exec",
    rawInput: { command: "firefox", observe: true } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-exec", status: "completed",
    content: [{ type: "content", content: { type: "text", text: "exit 0" } }, { type: "content", content: { type: "image", data: SCREEN_PIXEL_PNG, mimeType: "image/png" } }] } } });
}

/** A custom MCP server's screenshot reached through a wrapper tool. The chip
 * drops the server namespace — the person cares about the tool — so the
 * retention decision must not be taken on the chip's name: `screenshot` alone
 * looks like Murage's own screen surface, and this image is a deliverable. */
function playWrappedToolImageTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-wimg", title: "use_tool",
    rawInput: { tool_name: "mcp__omarchy-bridge__screenshot", tool_input: { window: "editor" } } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-wimg", status: "completed",
    content: [{ type: "content", content: { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" } }] } } });
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

/** `__fixture_subagents__` (Fuigo's shape): three sub agents are announced on
 * `_fuigo/session_notification`, the prompt ends `end_turn` while they run,
 * then each raises permission asks of its own, then they finish.
 *   FAKE_ACP_BG_ASKS  asks raised after the prompt result (default 2)
 *   FAKE_ACP_BG_HOLD  "1": the sub agents never finish (Stop and cap tests)
 *   FAKE_ACP_BG_WAKE  "1": the last finish says will_wake, and a reply plus
 *                     turn_completed follow it
 *   FAKE_ACP_BG_LOG   one line per ask verdict and per finish */
const bgAnswers = new Map<number, (outcome: any) => void>();
const bgLog = (line: string) => { if (process.env.FAKE_ACP_BG_LOG) appendFileSync(process.env.FAKE_ACP_BG_LOG, `${line}\n`); };
async function playSubagents(promptMsg: any) {
  const sessionId = promptMsg.params?.sessionId;
  const note = (update: Record<string, unknown>) => out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId, update } });
  const chunk = (text: string) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  const ids = ["sub-1", "sub-2", "sub-3"];
  chunk("Three helpers are reading.");
  for (const id of ids) note({ sessionUpdate: "subagent_spawned", subagent_id: id, parent_session_id: sessionId, child_session_id: `child-${id}`, subagent_type: "explore", description: `Helper ${id}` });
  result(promptMsg.id, { stopReason: "end_turn", _meta: { inputTokens: 1, outputTokens: 1 } });
  const asks = Number(process.env.FAKE_ACP_BG_ASKS ?? "2");
  for (let i = 0; i < asks; i += 1) {
    note({ sessionUpdate: "subagent_progress", subagent_id: ids[0], parent_session_id: sessionId, child_session_id: "child-sub-1", duration_ms: 5, turn_count: 1, tool_call_count: i + 1, tokens_used: 1, context_window_tokens: 100, context_usage_pct: 1, tools_used: ["read"], error_count: 0 });
    const id = 9200 + i;
    const answered = new Promise<any>((resolve) => bgAnswers.set(id, resolve));
    out({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: `child-sub-1`, toolCall: { toolCallId: `bg-${i}`, title: "Read /outside/cwd/file.md", kind: "read" }, options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } });
    const outcome = (await answered)?.outcome;
    bgLog(`verdict:${outcome?.outcome === "selected" ? outcome.optionId : String(outcome?.outcome)}`);
  }
  if (process.env.FAKE_ACP_BG_HOLD === "1") { bgLog("held"); return; }
  ids.forEach((id, index) => {
    const last = index === ids.length - 1;
    note({ sessionUpdate: "subagent_finished", subagent_id: id, child_session_id: `child-${id}`, status: "completed", tool_calls: 1, turns: 1, duration_ms: 9, tokens_used: 1, will_wake: last && process.env.FAKE_ACP_BG_WAKE === "1" });
  });
  if (process.env.FAKE_ACP_BG_WAKE === "1") {
    await new Promise((resolve) => setTimeout(resolve, 30));
    chunk("All helpers reported.");
    note({ sessionUpdate: "turn_completed", prompt_id: "wake-1", stop_reason: "end_turn" });
  }
  bgLog("finished");
}

let sessionSeq = 0;
let lateScheduled = false;
function scheduleLateFrames(sessionId: unknown) {
  const ms = Number(process.env.FAKE_ACP_LATE_FRAMES_MS);
  if (lateScheduled || !Number.isFinite(ms) || ms <= 0 || typeof sessionId !== "string") return;
  lateScheduled = true;
  setTimeout(() => {
    const shape = process.env.FAKE_ACP_LATE_SHAPE;
    const named = shape === "sessionless" ? {} : { sessionId };
    if (shape === "helper") {
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "subagent_spawned", subagent_id: "late", parent_session_id: sessionId, child_session_id: "late-helper", subagent_type: "explore", description: "Late helper" } } });
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "late-helper", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE FRAME FROM THE EARLIER SESSION" } } } });
      out({ jsonrpc: "2.0", id: 9300, method: "session/request_permission", params: { sessionId: "late-helper", toolCall: { toolCallId: "late-1", title: "Late ask from the earlier session", kind: "execute" }, options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } });
      return;
    }
    rawOut({ jsonrpc: "2.0", method: "session/update", params: { ...named, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE FRAME FROM THE EARLIER SESSION" } } } });
    rawOut({ jsonrpc: "2.0", id: 9300, method: "session/request_permission", params: { ...named, toolCall: { toolCallId: "late-1", title: "Late ask from the earlier session", kind: "execute" }, options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } });
  }, ms);
}

function handle(msg: any) {
  if (msg.id === 9300 && !msg.method) {
    if (process.env.FAKE_ACP_LATE_REPLY_LOG) appendFileSync(process.env.FAKE_ACP_LATE_REPLY_LOG, JSON.stringify({ result: msg.result, error: msg.error }) + "\n");
    return;
  }
  if (msg.id !== undefined && !msg.method && bgAnswers.has(msg.id)) {
    const answered = bgAnswers.get(msg.id)!;
    bgAnswers.delete(msg.id);
    answered(msg.result ?? { outcome: { outcome: "error" } });
    return;
  }
  if (msg.id !== undefined && !msg.method && proposalAsks.has(msg.id)) {
    const answered = proposalAsks.get(msg.id)!;
    proposalAsks.delete(msg.id);
    answered(msg.result ?? { error: msg.error });
    return;
  }
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
  if (process.env.FAKE_ACP_RPC_LOG) {
    const agentsToken = agentsTokenOf(msg.params?.mcpServers);
    appendFileSync(process.env.FAKE_ACP_RPC_LOG, JSON.stringify({
      pid: process.pid, method: msg.method,
      ...(msg.params?._meta?.noReplay === true ? { noReplay: true } : {}),
      ...(agentsToken !== undefined ? { agentsToken } : {}),
    }) + "\n");
  }

  // Synthetic diagnostics: use the real request ID, but a spoofed provider
  // method and private canaries that must never enter runtime.error details.
  if (mode === `rpc-error:${msg.method}`) {
    return out({ jsonrpc: "2.0", id: msg.id, error: {
      code: -32603, message: "Internal error", acpMethod: "session/cancel",
      data: { http_status: 500, message: "fixture provider failure https://billing.invalid/?key=fake-secret-canary", request: "fake-private-request", url: "https://billing.invalid/?key=fake-secret-canary" },
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
      const initDelay = Number(process.env.FAKE_ACP_INIT_DELAY_MS) || 0;
      const answer = () => result(msg.id, { protocolVersion: 1, authMethods, ...(mode.startsWith("fuigo-retry:disc-") ? { agentCapabilities: { _meta: { "fuigo/capabilities": { retryDiscard: { version: 1 } } } } } : {}), _meta: { modelState: { currentModelId: "fake-acp-model" } } });
      if (initDelay > 0) setTimeout(answer, initDelay); else answer();
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
        dumpState.mcpServers = dumpedServers(servers);
        writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState, null, 2));
      }
      agentsMcp = servers.find((s: any) => s?.name === "agents" || /^murage-agents-[a-f0-9]{20}$/.test(String(s?.name))) ?? null;
      if (process.env.FAKE_ACP_DUMP) {
        writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(dumpedServers(servers), null, 2));
      }
      if (process.env.FAKE_ACP_AGENTS_CAPABILITY && agentsMcp) {
        // always a new owner-only file: a stale file or a link left at the
        // path is removed first, never written through
        const path = process.env.FAKE_ACP_AGENTS_CAPABILITY;
        try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { writeSync(fd, JSON.stringify(agentsMcp.env ?? [])); } finally { closeSync(fd); }
      }
      const opts = configOptions();
      const mdls = sessionModels();
      const newSessionId = process.env.FAKE_ACP_UNIQUE_SESSIONS ? `fake-acp-session-${process.pid}-${++sessionSeq}` : "fake-acp-session";
      liveSession = newSessionId;
      liveServers = JSON.stringify(servers);
      startMcpChild(servers);
      result(msg.id, {
        sessionId: newSessionId,
        ...(opts ? { configOptions: opts } : {}),
        ...(mdls ? { models: mdls } : {}),
      });
      announceMcpReady(newSessionId, servers);
      // Fuigo 1.0.x and Grok Build advertise their "/" commands right after
      // session/new, before any prompt (session_setup.rs
      // send_available_commands_update). JSON array of ACP AvailableCommand.
      if (process.env.FAKE_ACP_COMMANDS) {
        out({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: newSessionId,
            update: { sessionUpdate: "available_commands_update", availableCommands: JSON.parse(process.env.FAKE_ACP_COMMANDS) },
          },
        });
      }
      afterSessionBuilt();
      break;
    }
    case "session/load": {
      const resident = liveSession !== null && msg.params?.sessionId === liveSession;
      if (resident && process.env.FAKE_ACP_REJECT_LIVE_LOAD) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "session is already loaded" } });
        break;
      }
      const loadServers = JSON.stringify(msg.params?.mcpServers ?? []);
      const serversChanged = !resident || loadServers !== liveServers;
      if (resident && Array.isArray(msg.params?.mcpServers)) {
        // Fuigo's reconnect: the resident session takes the new servers
        const servers: McpEntry[] = msg.params.mcpServers;
        agentsMcp = servers.find((s: any) => s?.name === "agents" || /^murage-agents-[a-f0-9]{20}$/.test(String(s?.name))) ?? null;
        if (process.env.FAKE_ACP_DUMP) writeFileSync(`${process.env.FAKE_ACP_DUMP}.mcp.json`, JSON.stringify(dumpedServers(servers), null, 2));
        if (serversChanged) startMcpChild(servers);
      }
      if (process.env.FAKE_ACP_LOAD_ERROR) {
        out({ jsonrpc: "2.0", id: msg.id, error: JSON.parse(process.env.FAKE_ACP_LOAD_ERROR) });
        break;
      }
      if (process.env.FAKE_ACP_LOAD_NULL) {
        result(msg.id, null);
        break;
      }
      const opts = configOptions();
      const mdls = sessionModels();
      if (typeof msg.params?.sessionId === "string") liveSession = msg.params.sessionId;
      liveServers = loadServers;
      result(msg.id, { ...(opts ? { configOptions: opts } : {}), ...(mdls ? { models: mdls } : {}) });
      if (serversChanged && typeof msg.params?.sessionId === "string" && process.env.FAKE_ACP_MCP_READY_NEW_ONLY !== "1") announceMcpReady(msg.params.sessionId, msg.params?.mcpServers);
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
      if (mode === "parallel-card-retry" && process.env.FAKE_ACP_FAIL_ONCE_FILE && !existsSync(process.env.FAKE_ACP_FAIL_ONCE_FILE)) {
        writeFileSync(process.env.FAKE_ACP_FAIL_ONCE_FILE, "failed launch");
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "429 too many requests", data: { http_status: 429, error_kind: "rate_limited" } } });
        return;
      }
      // A marker is observable before the held prompt has a terminal message.
      if (process.env.FAKE_ACP_ACCEPT_DIR && ["parallel-card", "parallel-card-retry", "cancel-ack"].includes(mode)) {
        writeFileSync(join(process.env.FAKE_ACP_ACCEPT_DIR, `${process.pid}-${msg.id}.accepted`), String(Date.now()));
      }
      if (process.env.FAKE_ACP_PROMPT_DUMP) writeFileSync(process.env.FAKE_ACP_PROMPT_DUMP, JSON.stringify(msg.params?.prompt ?? null));
      // FAKE_CUSTOM_TOOL_SERVER (fake-custom-tool.ts): call the first tool of
      // that owner server, started from the session's mcpServers entry.
      const customPrompt = (Array.isArray(msg.params?.prompt) ? msg.params.prompt : []).map((part: { text?: unknown }) => String(part?.text ?? "")).join("\n");
      const customServer = customToolServer(customPrompt);
      if (customServer) {
        let servers: McpEntry[] = [];
        try { servers = JSON.parse(liveServers ?? "[]") as McpEntry[]; } catch { servers = []; }
        const entry = servers.find((server) => server?.name === customServer);
        const promptText = customPrompt;
        void (async () => {
          const outcome = entry
            ? await callFirstCustomTool("acp", customServer, { command: entry.command, args: entry.args ?? [], env: Object.fromEntries((entry.env ?? []).map(({ name, value }) => [name, value])) }, promptText)
            : { tools: [], text: `no ${customServer} server was mounted`, isError: true };
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: customToolReply(outcome) } } } });
          result(msg.id, { stopReason: "end_turn" });
        })();
        return;
      }
      if (mode.startsWith("fuigo18-contract:")) {
        const variant = mode.slice("fuigo18-contract:".length);
        dumpState.promptRequests = Number(dumpState.promptRequests ?? 0) + 1;
        if (process.env.FAKE_ACP_DUMP) writeFileSync(process.env.FAKE_ACP_DUMP, JSON.stringify(dumpState));
        const retry = (attempt: number, message: string) => out({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: message },
            _meta: { "fuigo/retryStatus": { type: "retrying", attempt, error_type: variant === "success" ? "api" : "empty_response", http_status: 503 } } },
        } });
        retry(1, "Retry status: HTTP 503, retrying request.\n\n");
        retry(2, "Retry status: final engine attempt.\n\n");
        if (variant === "success") {
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The completed answer." } } } });
          result(msg.id, { stopReason: "end_turn", _meta: { pending_attempts: ["superseded-503-attempt"] } });
        } else {
          const data = variant === "empty" ? { message: "No visible answer after three attempts", error_kind: "empty_response" }
            : variant === "blank-http" ? { message: "   ", error_kind: "api", http_status: 503 }
              : variant === "untyped-prose" ? { message: "empty response from model (reasoning_only)" }
                : { message: "empty response from model (reasoning_only)", error_kind: "rate_limited" };
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data } });
        }
        return;
      }
      if (mode === "reasoning-only:string" || mode === "reasoning-only:object") {
        const message = "empty response from model (reasoning_only)";
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: mode.endsWith(":string") ? message : { message, error_kind: "empty_response" } } });
        return;
      }
      if (mode === "exit-with-stderr-history") {
        process.stderr.write("STDERR_EARLY_CANARY\nsk-test-" + "SYNTHETICKEYCANARY".repeat(24) + "\n" + ("x".repeat(4000) + "\n").repeat(4) + "STDERR_VISIBLE_END\n", () => process.exit(4));
        return;
      }
      if (mode === "fuigo-retry:restream" || mode === "fuigo-retry:tool") {
        // Fuigo resends the request after a mid-stream failure: the same
        // answer streams again from the start, announced by retry_state.
        const sid = msg.params.sessionId;
        const chunk = (text: string) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
        const retrying = (n: number) => out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: sid, update: { sessionUpdate: "retry_state", type: "retrying", attempt: n }, _meta: { eventId: `retry-${n}`, agentTimestampMs: Date.now() } } });
        if (mode === "fuigo-retry:restream") {
          chunk("A1"); retrying(1); chunk("A2"); retrying(2); chunk("A3");
        } else {
          chunk("Before. ");
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "tc-retry", title: "run", kind: "execute" } } });
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-retry", status: "completed", rawOutput: "done" } } });
          chunk("After one. "); retrying(1); chunk("Final answer.");
        }
        result(msg.id, { stopReason: "end_turn" });
        return;
      }
      if (mode.startsWith("fuigo-retry:disc-")) {
        // Fuigo 1.0.22: retryDiscard advertised at initialize; the discarding
        // retry_state carries discardEmitted and streamStartMs, the dead
        // attempt's chunks carry _meta.streamStartMs.
        const sid = msg.params.sessionId;
        const chunk = (text: string, startMs?: number, kind = "agent_message_chunk", extra: any = {}) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: kind, content: { type: "text", text } }, ...(startMs !== undefined || extra.meta ? { _meta: { ...(startMs !== undefined ? { streamStartMs: startMs } : {}), ...(extra.meta ?? {}) } } : {}) } });
        const retry = (update: any, method = "_fuigo/session_notification", meta: any = {}) => out({ jsonrpc: "2.0", method, params: { sessionId: sid, update: { sessionUpdate: "retry_state", type: "retrying", attempt: 1, ...update }, _meta: { eventId: `r-${Math.random().toString(36).slice(2)}`, agentTimestampMs: Date.now(), ...meta } } });
        const completed = () => out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: sid, update: { sessionUpdate: "response_completed", stop_reason: "end_turn" }, _meta: {} } });
        const variant = mode.slice("fuigo-retry:disc-".length);
        if (variant === "exact") {
          chunk("Earlier. ", 100); completed(); chunk("BAD", 200); retry({ discardEmitted: true, streamStartMs: 200 }); chunk("Final", 300);
        } else if (variant === "nodiscard") {
          chunk("A", 1); retry({}); chunk("B", 2); retry({ streamStartMs: 2 }); chunk("C", 3);
        } else if (variant === "boundary") {
          chunk("R1 "); completed(); chunk("R2bad"); retry({ discardEmitted: true }); chunk("R2ok");
        } else if (variant === "status") {
          chunk("Think. ", 1, "agent_thought_chunk"); chunk("BAD", 1); retry({ discardEmitted: true, streamStartMs: 1 });
          chunk("Retrying after a hiccup", undefined, "agent_thought_chunk", { meta: { "fuigo/retryStatus": { attempt: 1 } } });
          chunk("Final", 2);
        } else if (variant === "resurrect") {
          chunk("Old ", 1, "agent_thought_chunk"); chunk("Done.", 1);
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "t-res", title: "look", kind: "read", status: "completed" } } });
          chunk("New", 2, "agent_thought_chunk"); retry({ discardEmitted: true, streamStartMs: 2 }); chunk("Final", 3);
        } else if (variant.startsWith("hosted")) {
          // Responses-path hosted tools: the row streams inside the attempt,
          // tagged with its streamStartMs and `_meta.backend`.
          const tool = (id: string, startMs: number, backend = true) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: id, title: backend ? "web_search" : "read", kind: backend ? "fetch" : "read", status: "in_progress" }, _meta: { streamStartMs: startMs, ...(backend ? { backend: true } : {}) } } });
          const done = (id: string, startMs: number, backend = true) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: "ok" }, _meta: { streamStartMs: startMs, ...(backend ? { backend: true } : {}) } } });
          if (variant === "hosted") {
            chunk("A", 1); tool("ws-1", 1); done("ws-1", 1); retry({ discardEmitted: true, streamStartMs: 1 });
            chunk("A2", 2); tool("ws-2", 2); done("ws-2", 2); chunk(" Answer.", 2); completed();
          } else if (variant === "hosted-open") {
            chunk("A", 1); tool("ws-1", 1); retry({ discardEmitted: true, streamStartMs: 1 });
            chunk("A2", 2); tool("ws-2", 2); done("ws-2", 2); completed();
          } else if (variant === "hosted-nodiscard") {
            chunk("A", 1); tool("ws-1", 1); retry({}); chunk("B", 1); done("ws-1", 1); completed();
          } else if (variant === "hosted-ok") {
            // an ordinary successful hosted search; the untagged thought after
            // response_completed marks when the text was saved
            chunk("Let me search.", 1); tool("ws-1", 1); done("ws-1", 1); chunk("Here is what I found.", 1); completed();
            chunk("mark", undefined, "agent_thought_chunk");
          } else if (variant === "hosted-twin") {
            chunk("Let me search.", 1); tool("ws-1", 1); tool("ws-2", 1); done("ws-1", 1); done("ws-2", 1); chunk("Found.", 1); completed();
          } else if (variant === "hosted-local") {
            // a client-executed row (tagged, not backend), then a backend row
            // without streamStartMs: the text before each is committed first
            chunk("Let me read.", 1); tool("rd-1", 1, false); done("rd-1", 1, false); chunk("A", 1);
            out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "ws-1", title: "web_search", kind: "fetch", status: "in_progress" }, _meta: { backend: true } } });
            done("ws-1", 1); chunk("B", 1); completed();
          } else if (variant === "hosted-epoch") {
            // the discarding retry_state carries no streamStartMs
            chunk("A", 1); tool("ws-1", 1); retry({ discardEmitted: true }); chunk("A2", 2); completed();
          } else if (variant === "hosted-rowonly") {
            // the discarded attempt streamed only a running row, no text, and
            // the discarding retry_state carries no streamStartMs
            tool("ws-1", 1); retry({ discardEmitted: true }); tool("ws-2", 2); done("ws-2", 2); chunk("A2", 2); completed();
          } else if (variant === "hosted-rowonly-done") {
            // a row of a response that already completed is not that attempt's
            tool("ws-1", 1); completed(); retry({ discardEmitted: true }); done("ws-1", 1); chunk("B", 2); completed();
          } else if (variant === "hosted-many") {
            // a discarded attempt with 600 hosted rows still running: more
            // than the 512 the driver once tracked
            for (let index = 1; index <= 600; index++) tool(`ws-${index}`, 1);
            retry({ discardEmitted: true, streamStartMs: 1 }); chunk("A2", 2); completed();
          } else if (variant === "hosted-client") {
            chunk("R", 1); completed(); tool("rd-1", 1, false);
            chunk("X", 2); tool("ws-2", 2); retry({ discardEmitted: true, streamStartMs: 2 });
            done("rd-1", 1, false); chunk("Y", 3); completed();
          }
        } else if (variant === "carrier") {
          chunk("X", 5);
          retry({ discardEmitted: true, streamStartMs: 5 }, "_fuigo/session/update", { isReplay: true });
          chunk("Y", 6);
          retry({ discardEmitted: true, streamStartMs: 5 }, "_fuigo/session/update");
        }
        result(msg.id, { stopReason: "end_turn" });
        return;
      }
      if (mode.startsWith("fuigo-diagnostic:")) {
        const variant = mode.slice("fuigo-diagnostic:".length);
        const params: any = {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: "retry_state", type: "failed", error_type: "api", message: "fake-secret-canary", reason: "fake-private-reason", url: "https://billing.invalid/?key=fake-secret-canary", promptUsage: "fake-private-prompt" },
          _meta: { eventId: "fixture-event-1", agentTimestampMs: Date.now() },
        };
        if (variant === "foreign") params.sessionId = "foreign-session";
        if (variant === "replay") params._meta.isReplay = true;
        if (variant === "old") params._meta.agentTimestampMs = 1;
        if (variant === "missing-time") delete params._meta.agentTimestampMs;
        if (variant === "future") params._meta.agentTimestampMs += 60_000;
        if (variant === "malformed") params.update = [params.update];
        if (variant === "unbounded") params.update.message = "x".repeat(9000);
        if (variant === "unknown") params.update.error_type = "fake-secret-canary";
        if (variant === "retry") params.update.type = "retrying";
        out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params });
        if (variant === "success" || variant === "unmatched") {
          if (variant === "unmatched") out({ jsonrpc: "2.0", id: -999, error: { code: -32603, message: "Internal error" } });
          // a success answers with something; a bare end_turn is a lost turn
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture reply" } } } });
          result(msg.id, { stopReason: "end_turn" });
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: { http_status: 404, message: "fixture rejection https://billing.invalid/?key=fake-secret-canary",...(variant==="terminal"?{error_kind:"max_tokens_truncation"}:{}) } } });
        }
        return;
      }
      if (mode === "cancel-ack" || mode === "cancel-rpc-error" || mode === "cancel-reject" || mode === "cancel-other-reason") {
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
      if (mode === "exit-on-prompt" || mode === "exit-with-ansi" || mode === "exit-hostile-stderr" || mode === "exit-noisy-stderr") {
        // Four kilobytes of structured debug records with the fatal line
        // last: how a CLI agent actually goes down, and the shape that says
        // whether the card quotes the END of a crash or its run-up.
        const noisy = `${Array.from({ length: 40 }, (_, i) =>
          `{"time":"2026-09-16T03:14:${String(i).padStart(2, "0")}Z","level":"debug","msg":"plugin ${i} registered from the model cache"}`).join("\n")
          }\nFATAL: engine could not open the model file: permission denied\n`;
        const diagnostic = mode === "exit-with-ansi"
          ? `\u001b[31mtool_error: fixture failure\u001b[0m\nsk-test-${"SYNTHETICKEYCANARY".repeat(24)}\n\u001b[32mSTDERR_VISIBLE_END\u001b[0m\n`
          // A bidi override, a BEL, a credential-bearing https URL and a
          // user:pass@IP-literal authority — the content the engine-error
          // fixtures put in `error.data`, written to stderr instead.
          : mode === "exit-hostile-stderr"
            ? `\u001b[31mtool_error: fixture failure\u001b[0m\n\u202ereached https://billing.invalid/?key=fake-secret-canary\u0007\nvia proxyuser:fakepass@10.1.2.3:8443/v1 and gave up\n`
            : mode === "exit-noisy-stderr" ? noisy : "fake-acp: simulated prompt exit\n";
        process.stderr.write(diagnostic, () => process.exit(1073807364));
        return;
      }
      if (mode === "load-proof") {
        void loadProof(msg.id, msg.params?.sessionId).catch(() => { process.exitCode = 1; });
        return;
      }
      if (mode.startsWith("engine-error-data:")) {
        const data = {
          object: { message: "empty response from model (reasoning_only): model=fixture-model, had_reasoning=true, finish_reason=stop", error_kind: "empty_response" },
          string: "No response from model for 90s — the model may be stuck",
          hostile: {
            message: `\u001b[31mupstream failed\u001b[0m\r\n\u0007at https://billing.invalid/?key=fake-secret-canary via proxyuser:fake-secret-canary@proxy.invalid:8080 with sk-test-${"SYNTHETICKEYCANARY".repeat(2)}: {"error":{"request":"fake-private-request"}}`,
            error_kind: "http\nEngine error code: 1",
            token: "fake-secret-canary",
          },
        }[mode.slice("engine-error-data:".length)];
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data } });
        return;
      }
      // The same hostile content in the JSON-RPC `error.message` instead of
      // `error.data`: an engine controls both, and both reach the card.
      if (mode.startsWith("engine-error-message:")) {
        const message = {
          hostile: `\u001b[31mupstream\u001b[0m\u0007 failed at https://billing.invalid/?key=fake-secret-canary via proxyuser:fake-secret-canary@proxy.invalid:8080`,
          plain: "fixture provider rejected the request",
        }[mode.slice("engine-error-message:".length)];
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message } });
        return;
      }
      if (mode === "fuigo-live-notices") {
        process.stderr.write("ordinary diagnostic\nfuigo: lowercase log line\nFu");
        setTimeout(() => {
          process.stderr.write("igo: found memory from an older version at /home/u/.fuigo/memory/old. It belongs to another repository. Memory for this repository now lives at /home/u/.fuigo/memory/new. Nothing was deleted.\r\nFuigo: the feedback session archive was NOT uploaded. token=fixture-secret-canary\nFuigo: " + "x".repeat(1400) + "\nFuigo: fourth omitted\n");
          // A live output marker lets tests observe delivery without an exit.
          setTimeout(() => out({ jsonrpc: "2.0", method: "session/update", params: {
            update: { sessionUpdate: "agent_message_chunk", content: { text: "notices written" } },
          } }), 25);
          // Stay live until interrupted so the test cannot pass on exit capture.
        }, 25);
        return;
      }
      if (mode === "stderr-rpc-error" || mode === "stderr-happy") {
        const lines = ["STDERR_EVICTED_FIRST_LINE"];
        for (let i = 0; i < 200; i++) lines.push(`\u001b[2mretry ${i}: empty response from model (reasoning_only), waiting\u001b[0m`);
        lines.push(`auth header sk-test-${"SYNTHETICKEYCANARY".repeat(2)}`);
        lines.push("\u001b[33mSTDERR_LAST_LINE retry 15/15 gave up\u001b[0m");
        process.stderr.write(`${lines.join("\n")}\n`, () => {
          // let the driver read stderr before the prompt settles
          setTimeout(() => {
            if (mode === "stderr-happy") {
              // a success answers with something; a bare end_turn is a lost turn
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture reply" } } } });
              result(msg.id, { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } });
            }
            else out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: { message: "fixture engine failure" } } });
          }, 200);
        });
        return;
      }
      if (mode === "credit-exhausted") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: {
          http_status: 402,
          // Fuigo 1.0.18 tags a provider rejection `api`. The typed kind rides
          // the whole path here: driver event -> bus -> store -> API -> card.
          error_kind: "api",
          message: "API error (status 402 Payment Required): Your credit balance is exhausted. https://billing.invalid/?token=fake-secret-canary",
        } } });
        return;
      }
      if (["payment-required:missing","payment-required:private","payment-required:flux-url"].includes(mode)) {
        out({ jsonrpc:"2.0", id:msg.id, error:{code:-32603,message:"Internal error",data:{http_status:402,
          ...(mode==="payment-required:missing"?{}:{message:mode==="payment-required:flux-url"?"Account access unavailable. https://fluxrouter.ai/home/billing?token=fake-secret-canary":"private response fake-secret-canary https://billing.invalid/private"}),
        }} });
        return;
      }
      if (fixtureRequested(String(msg.params?.prompt?.[0]?.text ?? ""), "__fixture_cancel_ack__")) {
        markerCancelAck = true;
        pendingCancelAckPrompt = msg.id;
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "fixture cancellation ready" } } } });
        return;
      }
      if (mode === "hang") {
        // never resolve the prompt — lets tests exercise interrupt
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "slow-tool" || mode === "stall-after-tool") {
        const tool = (update: Record<string, unknown>) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { toolCallId: "tc-slow", ...update } } });
        // ACP's default status is pending: this tool_call carries none.
        tool({ sessionUpdate: "tool_call", title: "sleep", rawInput: { command: "sleep 45 && echo done" } });
        tool({ sessionUpdate: "tool_call_update", status: "in_progress" });
        const finishTool = () => tool({ sessionUpdate: "tool_call_update", status: "completed", rawOutput: { output: "done" } });
        if (mode === "stall-after-tool") {
          // FAKE_ACP_TOOL_NEVER_FINISHES: an engine that never reports the
          // tool as finished (the guard's tool cap is the only bound).
          if (!process.env.FAKE_ACP_TOOL_NEVER_FINISHES) finishTool();
          setInterval(() => {}, 1_000);
          return;
        }
        setTimeout(() => {
          finishTool();
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } });
          result(msg.id, { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } });
        }, Number(process.env.FAKE_ACP_TOOL_MS ?? 600));
        return;
      }
      if (mode === "stall-after-text") {
        // Stream a chunk, then go fully silent forever: no further update, no
        // result, no exit. The shape of a wedged OpenCode agent that stopped
        // mid-answer. Nothing else will ever arrive, so only the driver's own
        // prompt idle guard can end this turn.
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "half an answer, then silence" } } } });
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
        setImmediate(runStrandedInterjection);
        scheduleLateFrames(msg.params?.sessionId);
        result(
          msg.id,
          // FAKE_ACP_USAGE_ROOT reproduces opencode 1.18.18's shape: usage at
          // the result root with an empty _meta, instead of usage under _meta.
          process.env.FAKE_ACP_USAGE_ROOT === "fuigo"
            ? { stopReason: "end_turn", _meta: { inputTokens: 1, outputTokens: 2, usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 30, costUsdTicks: 2500000000 } } }
            : process.env.FAKE_ACP_USAGE_ROOT
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, _meta: {} }
            : { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } },
        );
      };
      const promptText = String(msg.params?.prompt?.[0]?.text ?? "");
      // lane review: a review run answers with its verdict (fake-review.ts)
      const reviewText = fakeReviewReply(promptText);
      if (reviewText !== null) {
        const say = (text: string) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } }); complete(); };
        if (fakeReviewByTool() && agentsMcp) {
          void driveMcp(agentsMcp, [{ name: "project_review_result", args: () => fakeReviewToolArgs(promptText) }])
            .then(reply => say(`Reviewed with the tool: ${reply}`)).catch((e: Error) => say(`review tool error: ${e.message}`));
          return;
        }
        say(reviewText);
        return;
      }
      if (mode === "retry-status-thought") {
        // Wire shape of fuigo-shell retry_status_update (1.0.18): a thought, never answer text.
        const retryStatus = { type: "retrying", attempt: 1, max_retries: 2, reason: "empty response from model (reasoning_only)", error_type: "empty_response" };
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Retrying the model (1/2): empty response from model (reasoning_only)\n\n" }, _meta: { "fuigo/retryStatus": retryStatus } } } });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "fixture reasoning" } } } });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture final answer" } } } });
        complete();
        return;
      }
      if (mode === "plan") {
        // Wire shape of SessionUpdate::Plan (agent-client-protocol-schema 0.11):
        // every update carries the whole list; the client replaces its copy.
        const plan = (entries: unknown) => out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "plan", entries } } });
        plan([
          { content: "Read the folder", priority: "high", status: "in_progress" },
          { content: "Fix the bug", priority: "medium", status: "pending" },
        ]);
        plan("not a list");
        plan([
          { content: "Read the folder", priority: "high", status: "completed" },
          { content: "Fix the bug", priority: "medium", status: "in_progress" },
          { content: "", priority: "low", status: "pending" },
          { content: "Report back", priority: "low", status: "someday" },
        ]);
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture plan answer" } } } });
        complete();
        return;
      }
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
      if (fixtureRequested(promptText, "__fixture_subagents__")) {
        void playSubagents(msg);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_tool_after_turn__")) {
        // a background task that keeps working after end_turn
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "handed to a background task" } } } });
        complete();
        setTimeout(() => {
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "bg-1", title: "make clean", kind: "execute" } } });
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "in_progress" } } });
        }, 150);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_summary_with_work__")) {
        // a trailing-allowed update type that smuggles a tool call or a prompt
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
        complete();
        const sid = msg.params?.sessionId;
        const extra = process.env.FAKE_ACP_SMUGGLE === "prompt"
          ? { prompt: [{ type: "text", text: "continue" }] }
          : { toolCall: { toolCallId: "late-tool", kind: "execute" } };
        setTimeout(() => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "last_turn_summary" }, ...extra } }), 100);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_summary_after_turn__")) {
        // what real Fuigo sends after end_turn: last_turn_summary ~0.3 s, then title metadata
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
        complete();
        const sid = msg.params?.sessionId;
        setTimeout(() => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "last_turn_summary", summary: "did a thing" } } }), 300);
        setTimeout(() => {
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "session_summary_generated", title: "A title" } } });
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "session_info_update", title: "A title" } } });
        }, 900);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_wake_after_turn__")) {
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "will wake later" } } } });
        complete();
        setTimeout(() => out({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "turn_completed", prompt_id: "self-1", stop_reason: "end_turn" } } }), 2_000);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_child_later__")) {
        // background work that starts its own child only after the turn ended
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a shell will start later" } } } });
        complete();
        setTimeout(() => {
          const later = spawn("sleep", ["30"], { stdio: "ignore" });
          if (process.env.FAKE_ACP_CHILD_PID_FILE) writeFileSync(process.env.FAKE_ACP_CHILD_PID_FILE, String(later.pid));
        }, Number(process.env.FAKE_ACP_CHILD_DELAY_MS) || 800);
        return;
      }
      if (fixtureRequested(promptText, "__fixture_child_after_turn__")) {
        // a shell a tool started during the turn and left running past end_turn
        const leftover = spawn("sleep", ["30"], { stdio: "ignore" });
        if (process.env.FAKE_ACP_CHILD_PID_FILE) writeFileSync(process.env.FAKE_ACP_CHILD_PID_FILE, String(leftover.pid));
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "left a shell running" } } } });
        complete();
        return;
      }
      if (fixtureRequested(promptText, "__fixture_request_after_turn__")) {
        // background work that outlives the turn and asks for permission once
        // the turn is over (a Fuigo background task or subagent)
        out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "started in the background" } } } });
        complete();
        setTimeout(() => out({
          jsonrpc: "2.0", id: 9100, method: "session/request_permission",
          params: { sessionId: msg.params?.sessionId, toolCall: { toolCallId: "late-1", title: "make clean", kind: "execute" },
            options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] },
        }), 150);
        return;
      }
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
      if (mode === "text-propose" && promptText.includes("<murage-project-proposal")) {
        // Lane N2: the Chief answers with the proposal block in its reply. First the model
        // tries a native shell command, as a gated engine asks for it; the answer is logged.
        const options = [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }];
        void new Promise<string>(resolve => {
          proposalAsks.set(9401, result => resolve(String(result?.outcome?.optionId ?? result?.outcome?.outcome ?? "none")));
          out({ jsonrpc: "2.0", id: 9401, method: "session/request_permission", params: { sessionId: msg.params?.sessionId, toolCall: { toolCallId: "t-shell", title: "cat /etc/hosts", kind: "execute", rawInput: { command: "cat /etc/hosts" } }, options } });
        }).then(shell => {
          logProposalTurn({ engine: process.env.FAKE_PROPOSE_ENGINE ?? "acp", asks: { shell }, agentsMounted: Boolean(agentsMcp) });
          // "[fail]" in the owner's words: half a reply, then the turn fails; "[stall]": a whole block, then silence
          if (promptText.includes("[fail]")) {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Half a thought about the report" } } } });
            out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "fake acp: turn failed after streaming" } });
            return;
          }
          if (promptText.includes("[tool-stall]")) {
            // a line, a tool (the engine closes the text item there), then the whole block streams and the engine goes silent
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Let me look first." } } } });
            out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t-think", title: "Thinking", kind: "think", status: "completed" } } });
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: proposalReply(promptText) } } } });
            return;
          }
          if (promptText.includes("[stall]")) {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: proposalReply(promptText) } } } });
            return;
          }
          // an engine that searches the web on its own, no ask (not on Fuigo or Grok Build, where it stops the turn)
          if (!agentsMcp) out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t-search", title: "Web search", kind: "search", status: "completed", rawInput: { query: "quarterly report" } } } });
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: proposalReply(promptText) } } } });
          complete();
        });
        return;
      }
      if (mode === "project-propose" && agentsMcp && promptText.includes("project_propose")) {
        // The Chief's New project proposal (lane N): through the mounted agents server only.
        // First the engine asks, as a gated engine does: a native shell command, a native
        // edit dressed up as the propose tool, and Fuigo's own use_tool call of project_propose.
        const entry = agentsMcp;
        const options = [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }];
        const ask = (id: number, toolCall: Record<string, unknown>) => new Promise<string>(resolve => {
          proposalAsks.set(id, result => resolve(String(result?.outcome?.optionId ?? result?.outcome?.outcome ?? "none")));
          out({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: msg.params?.sessionId, toolCall, options } });
        });
        const toolName = `${(entry as { name?: string }).name ?? "agents"}__project_propose`;
        const proposal = proposalFrom(promptText);
        const fuigoUseTool = { "fuigo/tool": { version: 1, namespace: "fuigo_build", name: "use_tool", kind: "use_tool", read_only: false } };
        if (process.env.FAKE_ACP_PROPOSE_UNASKED === "1") {
          // An engine that reads a file on its own, with no ask, then proposes a second later.
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "p-unasked", title: "Read", kind: "read", status: "pending", rawInput: { path: "/etc/hosts" } } } });
          void new Promise(resolve => setTimeout(resolve, 1000))
            .then(() => proposeThroughMcp({ command: entry.command, args: entry.args, env: Object.fromEntries((entry.env ?? []).map(({ name, value }) => [name, value])) }, promptText, { unasked: true }))
            .then(text => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } }); complete(); })
            .catch(() => complete());
          return;
        }
        // Fuigo's own tool items before the asks, as it stamps them: the catalog search (kind read) and the
        // use_tool call of project_propose, labelled by the inner name and carrying the model's input (R9-4)
        const item = (toolCallId: string, title: string, kind: string, rawInput: unknown, name: string) =>
          out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update: { sessionUpdate: "tool_call", toolCallId, title, kind, status: "pending", rawInput, _meta: { "fuigo/tool": { version: 1, namespace: "fuigo_build", name, kind: name, read_only: name === "search_tool" } } } } });
        item("p-search", "search_tool", "read", { query: "project_propose" }, "search_tool");
        item("p-use-item", toolName, "other", { variant: "UseTool", tool_name: toolName, tool_input: proposal }, "use_tool");
        void (async () => ({
          shell: await ask(9201, { toolCallId: "p-shell", title: "echo proposal > ./notes.txt", kind: "execute", rawInput: { command: "echo proposal > ./notes.txt" } }),
          disguised: await ask(9202, { toolCallId: "p-edit", title: "use_tool", kind: "edit", rawInput: { tool_name: toolName, input: proposal } }),
          read: await ask(9204, { toolCallId: "p-read", title: "use_tool", kind: "read", rawInput: proposal }),
          titled: await ask(9205, { toolCallId: "p-title", title: toolName, kind: "other", rawInput: { path: "/etc/hosts" } }),
          otherMount: await ask(9206, { toolCallId: "p-mount", title: "use_tool", kind: "other", rawInput: { variant: "UseTool", tool_name: "agents__project_propose", tool_input: proposal }, _meta: fuigoUseTool }),
          propose: await ask(9203, { toolCallId: "p-use", title: "use_tool", kind: "other", rawInput: { variant: "UseTool", tool_name: toolName, tool_input: proposal }, _meta: fuigoUseTool }),
        }))()
          .then(asks => proposeThroughMcp({ command: entry.command, args: entry.args, env: Object.fromEntries((entry.env ?? []).map(({ name, value }) => [name, value])) }, promptText, { asks }))
          .then(text => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } }); complete(); })
          .catch(error => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `propose error: ${(error as Error).message}` } } } }); complete(); });
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
      if (mode === "fuigo-surface" && agentsMcp) {
        // Emulate Fuigo's model surface: no MCP tool is callable bare. Follow
        // the prompt's qualified use_tool instruction, then dispatch via MCP.
        const qualified = /use_tool with tool_name "(agents__ask_bot)"/.exec(promptText)?.[1];
        const reply = (text: string) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } }); complete(); };
        if (!qualified) { reply("Tool not found: ask_bot"); return; }
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          { name: qualified.slice("agents__".length), args: list => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "PF qualified tool reached you" }) },
        ]).then(result => reply(`qualified MCP result: ${result}`)).catch(error => reply(`qualified MCP error: ${error.message}`));
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
        // a refused create surfaces its own words, not the empty delegate that follows it
        let createdReply = "";
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
              bot_id: /id: ([\w-]+)/.exec(createdReply = created)?.[1] ?? "",
              message: "Review the new onboarding flow.",
              reason: "design review",
            }),
          },
        ])
          .then((reply) => {
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: /id: [\w-]+/.test(createdReply) ? `team created: ${reply}` : `create error: ${createdReply}` } } } });
            complete();
          })
          .catch((e) => {
            const message = e instanceof Error ? e.message : String(e);
            out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `create error: ${message}` } } } });
            complete();
          });
        return;
      }
      if (mode === "echo-gated" || mode === "parallel-card" || mode === "parallel-card-retry") {
        // Parallel-card protocol: prove prompt acceptance, hold all workers at
        // the test's file barrier, then return one result. No network services.
        if (mode === "parallel-card" || mode === "parallel-card-retry") out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "PARALLEL_CARD_ACCEPTED\n" } } } });
        // echoing the WHOLE prompt (system + turn text) lets a test assert
        // both what a drained turn was sent and what it was NOT sent (e.g.
        // the webhook untrusted-data paragraph a steered turn must not get)
        const finish = () => {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: mode !== "echo-gated" ? "Independent card finished." : `echo: ${promptText}` } } } });
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
      if (mode === "project-image" && agentsMcp) {
        // a card run asks for an image through the mounted agents server and
        // waits on the owner's approval card (image-operations project hold)
        void driveMcp(agentsMcp, [{ name: "generate_image", args: () => ({ request_id: "late-allow-image", prompt: "A red cube on a white table" }) }])
          .then(reply => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `image: ${reply}` } } } }); complete(); })
          .catch((e: Error) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `image error: ${e.message}` } } } }); complete(); });
        return;
      }
      if (mode === "project-card-lead") {
        const woken = promptText.includes("Results came back for work you handed over");
        const assignee = /E2A_ASSIGN:([\w-]+)/.exec(promptText)?.[1];
        // lane review: a review that ended without a verdict leaves the lead to decide; this lead accepts
        const decide = /ended without a verdict, so you decide now \(card_id "([^"]+)"\)/.exec(promptText)?.[1];
        const text = decide ? `REVIEW_DECIDED\n<murage-goal>${JSON.stringify({ v: 2, status: "accept", card: decide })}</murage-goal>`
          : woken ? "CARD_RESULT_RECEIVED" : assignee
          ? `Assigning one card.\n<murage-goal>${JSON.stringify({ v: 2, status: "assign", cards: [{ key: "payments", assignee, title: "Assigned payments", description: "Count the payments and report the result", writes: false }] })}</murage-goal>`
          : "Waiting for the card assignment.";
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } });
        complete(); return;
      }
      if ((mode === "lead-delegate" || mode === "lead-loop") && agentsMcp) {
        // turn-engine e2e (lane E1): a room lead hands work over with
        // delegate_bot; the teammate's result comes back as a wake whose
        // prompt says "Results came back". lead-delegate then reports what it
        // saw; lead-loop hands over again on every wake (the step cap test).
        const woken = promptText.includes("Results came back for work you handed over");
        const sawResult = woken && /<result from="[^"]+">/.test(promptText);
        if (woken && mode === "lead-delegate") {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: sawResult ? "lead saw the result and is done" : "lead was woken without a result" } } } });
          complete();
          return;
        }
        if (!promptText.includes("LEAD_ASSIGN")) {
          out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "lead has nothing to hand over" } } } });
          complete();
          return;
        }
        void driveMcp(agentsMcp, [
          { name: "list_bots", args: () => ({}) },
          { name: "delegate_bot", args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "LEAD_TASK please do the work", reason: "handover" }) },
        ])
          .then((reply) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `lead handed over: ${reply}` } } } }); complete(); })
          .catch((e) => { out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `lead error: ${(e as Error).message}` } } } }); complete(); });
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
              message: process.env.FAKE_ACP_DELEGATE_MESSAGE ?? "delegated task",
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
      else if (mode === "action-guard") {
        for (const update of [
          { sessionUpdate: "tool_call", toolCallId: "shell", title: "printf hello > notes.txt", kind: "execute", status: "in_progress", rawInput: { command: "printf hello > notes.txt" } },
          { sessionUpdate: "tool_call_update", toolCallId: "shell", status: "completed", rawOutput: { exitCode: 0, stdout: "" } },
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I saved the file." } },
        ]) out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params?.sessionId, update } });
      }
      else if (mode === "wrapped-tool") playWrappedToolTurn();
      else if (mode === "tool-image") playToolImageTurn();
      else if (mode === "computer-exec-image") playComputerExecImageTurn();
      else if (mode === "wrapped-tool-image") playWrappedToolImageTurn();
      else if (mode === "reasoning-only") playReasoningTurn();
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
            sessionId: msg.params?.sessionId ?? "fake-acp-session",
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
            sessionId: msg.params?.sessionId ?? "fake-acp-session",
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
            sessionId: msg.params?.sessionId ?? "fake-acp-session",
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
            sessionId: msg.params?.sessionId ?? "fake-acp-session",
            mode: "url",
            elicitationId: "el-1",
            url: "https://example.com/authorize?state=abc",
            message: "Sign in to the deploy service to continue",
          },
        });
        return;
      }
      if (mode === "permission" || mode === "question-tool" || mode === "permission-session-first" || mode === "permission-edit-file") {
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
            toolCall: permissionToolCall && mode === "permission"
              ? permissionToolCall
              : mode === "question-tool"
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
              : mode === "permission-edit-file"
              // An edit naming a file, the way an ACP engine reports one:
              // the protocol's `locations` plus the engine's structured
              // `rawInput`. FAKE_ACP_PERMISSION_FILE names the file.
              ? {
                  kind: "edit",
                  title: "Edit " + permissionFile,
                  rawInput: { file_path: permissionFile },
                  locations: [{ path: permissionFile }],
                }
              : { kind: "execute", rawInput: { command: permissionCommand }, title: permissionCommand },
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
    case "_fuigo/interject": {
      const interjectMode = process.env.FAKE_ACP_INTERJECT;
      const echo = () => out({ jsonrpc: "2.0", method: "_fuigo/session/interjection", params: { sessionId: msg.params?.sessionId, text: msg.params?.text, interjectionId: msg.params?.interjectionId } });
      if (interjectMode === "fallback") {
        result(msg.id, { result: { status: "queued" } });
        echo();
        strandedInterjections.push(String(msg.params?.text ?? ""));
      } else if (interjectMode === "silent") {
        setTimeout(echo, Number(process.env.FAKE_ACP_LATE_ECHO_MS ?? 1000));
      } else if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      break;
    }
    case "session/cancel":
      if (markerCancelAck && pendingCancelAckPrompt !== null) {
        const id = pendingCancelAckPrompt;
        pendingCancelAckPrompt = null;
        markerCancelAck = false;
        result(id, { stopReason: "cancelled" });
        break;
      }
      if (mode === "cancel-rpc-error" && pendingCancelAckPrompt !== null) {
        out({ jsonrpc: "2.0", id: pendingCancelAckPrompt, error: { code: -32603, message: "Internal error", data: "empty response from model (reasoning_only)" } });
        pendingCancelAckPrompt = null;
        break;
      }
      if (mode === "cancel-ack" && pendingCancelAckPrompt !== null) {
        // A cooperative agent acknowledges promptly but only exits when the
        // client terminates it — the gap close-confirmed stop must cover.
        const id = pendingCancelAckPrompt;
        pendingCancelAckPrompt = null;
        result(id, { stopReason: "cancelled" });
        break;
      }
      if (mode === "cancel-reject" && pendingCancelAckPrompt !== null) {
        // The engine ends the cancelled prompt with a JSON-RPC error instead of
        // stopReason "cancelled", and keeps running until it is terminated.
        const id = pendingCancelAckPrompt;
        pendingCancelAckPrompt = null;
        out({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error", data: { message: "turn cancelled by client", error_kind: "cancelled" } } });
        break;
      }
      if (mode === "cancel-other-reason" && pendingCancelAckPrompt !== null) {
        // The engine ends the cancelled prompt with its own stop reason rather
        // than "cancelled", and keeps running until it is terminated.
        const id = pendingCancelAckPrompt;
        pendingCancelAckPrompt = null;
        result(id, { stopReason: "refusal" });
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
