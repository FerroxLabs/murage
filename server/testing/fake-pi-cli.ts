#!/usr/bin/env node
// Fake of the pi coding agent's `--mode rpc --no-session` stdio surface, for
// driver contract tests of server/drivers/pi.ts. Speaks pi's JSON-RPC-over-
// stdio protocol: answers get_available_models / new_session / switch_session
// / set_model, and streams a scripted turn in response to `prompt`. Failure
// modes mirror how the real CLI misbehaves:
//
//   FAKE_PI_MODE   happy (default) | project-propose (the Chief's New project proposal through
//                  the agents server in MURAGE_MCP_CONFIG; see fake-mcp-propose.ts) | text-propose (the
//                  proposal as a block in the reply, after a gated read) | tooluse | permission | host-confirm | gate | question | editor | interleave | todo | turn-error | no-models | exit-early | exit-127 | close-before-ready | crash-mid-turn | stream
//                  stream = long work that keeps streaming: one text delta every FAKE_PI_STREAM_EVERY_MS
//                  (default 500) for FAKE_PI_STREAM_FOR_MS (default 8000), then "long reply done" and a clean turn_end
//                  permission = a `select` ask ("Run bash: echo hi?", Allow once / Deny) — since 0.1.52 ASK3 a select
//                  is a QUESTION for the owner (its answer is {value}); host-confirm = a `confirm` ask, the permission
//                  shape; question = an `input` ask; editor = an `editor` ask with prefill
//   FAKE_CUSTOM_TOOL_SERVER / FAKE_CUSTOM_TOOL_LOG  every prompt calls the first tool of that
//                  owner server from MURAGE_MCP_CONFIG (fake-custom-tool.ts)
//   FAKE_PI_MODELS comma-separated provider/model pairs (default "ollama-cloud/glm-5.2,openai/gpt-4o")
//   FAKE_PI_SET_MODEL ok (default) | reject (success:false with pi's error text) | silent (never answers)
//   FAKE_PI_SESSION   ok (default) | reject (new_session / switch_session answer success:false)
//   FAKE_PI_NO_SESSION  set: new_session answers as real pi does under --no-session, {cancelled:false} and no sessionFile.
//                  Without it the fake invents a session file, which only suites about stored cursors want.
//   FAKE_PI_SESSION_GATE  path: hold the new_session / switch_session answer until
//                  this file exists (writes its launch nonce to `<path>.waiting` while held, polls
//                  every 25 ms). The driver's sendTurn awaits that answer, so a
//                  test gets a deterministic window in which the harness has
//                  called sendTurn but the provider turn is not yet accepted.
//   FAKE_PI_DUMP   path to append {argv, env} JSON, so a test can assert argv shape
//                  and env hygiene (no leaked secrets into the pi child). Model
//                  pins, thinking levels, received prompts and every
//                  extension_ui_response ({uiResponse}) are appended too.
//   FAKE_PI_COMMAND_LOG  path to append every command received, one JSON line each (new_session, switch_session with its
//                  sessionPath, prompt with its message), so a test can see whether a session was resumed
//   FAKE_PI_VERSION    the version `--version` reports (default 0.84.2)
//   FAKE_PI_SCRIPT     path to a JSON array of frames played on prompt (playScript)
//   FAKE_PI_PROMPT_RESPONSE  JSON merged into the prompt's response, then nothing more: {"success":false,"error":..} or {"data":{"disposition":"handled"}}
//   FAKE_PI_ABORT_DIALOG=1  a gate ask lands between the abort and its reply
//   FAKE_PI_PID_FILE   write this child's pid (close-confirmed stop tests)
//   FAKE_PI_UNIQUE  set: each happy reply ends with a fresh word ("Hello from
//                  pi 3f9a2c"), so a test can tell replies apart and find one's
//                  words in a later prompt; and each new session gets an id no
//                  other process reuses, as the real CLI's are (without it a
//                  restarted child names its first session pi-session-1 again,
//                  and memory receipts link every such turn as one session)
//   FAKE_PI_LINGER_MS  stay alive this long after SIGTERM or stdin end (max
//                  10 s). POSIX-only observation: Windows taskkill /F runs no handler.
//   FAKE_PI_ABORT_MS / FAKE_PI_ABORT_MARKER delay the abort reply, then write the session-flush marker in this engine.
//   FAKE_PI_ABORT_SILENT=1 never completes abort, for the bounded wait test.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { logProposalTurn, proposalReply, proposeThroughMcp, type McpServerEntry } from "./fake-mcp-propose.ts";
import { fakeReviewReply } from "./fake-review.ts";
import { callFirstCustomTool, customToolReply, customToolServer } from "./fake-custom-tool.ts";
import { PI_GATE_TITLE_PREFIX, piGateMessage } from "../drivers/pi-permission-gate.ts";

/** Whether the real gate asks for this call in these fixtures: the reads here are outside the folder, so every call asks, except the one tool a proposal-only turn runs (Rule 14). */
const gateAsks = (toolName: string, only?: string): boolean => (only ? toolName !== only : true);

/** project-propose mode's gate asks, answered by extension_ui_response id. */
const proposalAsks = new Map<string, (confirmed: boolean) => void>();

const mode = process.env.FAKE_PI_MODE ?? "happy";
// Namespace PIDs repeat across wrapped launches; attribution uses this nonce.
const launchId = randomUUID();
const modelPairs = (process.env.FAKE_PI_MODELS ?? "ollama-cloud/glm-5.2,openai/gpt-4o")
  .split(",")
  .filter(Boolean)
  .map((pair) => {
    const [provider, id] = pair.split("/");
    return { provider: provider ?? "x", id: id ?? "m", name: id ?? "m" };
  });

const argv = process.argv.slice(2);

// The driver probes `<cli> --version` for snapshot(); answer and exit clean.
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(`pi ${process.env.FAKE_PI_VERSION ?? "0.84.2"} (fake)\n`);
  process.exit(0);
}

const lingerMs = Math.min(10_000, Number(process.env.FAKE_PI_LINGER_MS) || 0);
const lingerThenExit = () => setTimeout(() => process.exit(0), lingerMs);
if (lingerMs > 0) process.on("SIGTERM", lingerThenExit);

if (process.env.FAKE_PI_DUMP) {
  try {
    // When the driver mounts integrations it hands the MCP config through
    // MURAGE_MCP_CONFIG; read it here so a test can assert the mount contract
    // (servers, proxy wrap, credential hygiene) without racing the temp file
    // cleanup the driver runs at turn settle.
    let mcpConfig: unknown = null;
    if (process.env.MURAGE_MCP_CONFIG) {
      try {
        mcpConfig = JSON.parse(readFileSync(process.env.MURAGE_MCP_CONFIG, "utf8"));
      } catch {
        /* unreadable config dumps as null */
      }
    }
    appendFileSync(
      process.env.FAKE_PI_DUMP,
      JSON.stringify({
        argv,
        launchId,
        envConfigured: [
          "PATH",
          "HOME",
          "ANTHROPIC_API_KEY",
          "OPENAI_API_KEY",
          "XAI_API_KEY",
          "BOX_TOKEN",
          // routing switches a leftover shell would use to redirect the turn
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_MODEL",
          "OPENAI_BASE_URL",
          "OPENAI_MODEL",
        ].filter(
          (k) => process.env[k] !== undefined,
        ),
        mcpConfig,
        gate: process.env.MURAGE_PI_GATE ? { secretLength: process.env.MURAGE_PI_GATE.length, only: process.env.MURAGE_PI_GATE_ONLY ?? null } : null,
      }) + "\n",
    );
  } catch {
    /* never let dumping break a run */
  }
}

// exit-early: die before saying anything — a failed spawn surfaces as a
// runtime.error + failed turn, never a hang.
if (mode === "exit-early") {
  process.exit(1);
}
// exit-127: the shape of a launcher whose runtime is missing (`/usr/bin/env: 'node': No such file or directory`, exit 127).
if (mode === "exit-127") {
  process.stderr.write("/usr/bin/env: 'node': No such file or directory\n", () => process.exit(127));
}

const send = (obj: any) => process.stdout.write(JSON.stringify(obj) + "\n");
// Mirrors ENGINE_FRAME_MAX_BYTES in server/drivers/bounded-lines.ts. "é" is
// two UTF-8 bytes: the oversize text alone is one KiB over the limit, and the
// large text is 14 MiB, the size of a 10 MiB image as base64.
const FIXTURE_FRAME_LIMIT = 32 * 1024 * 1024;
const fixtureOversizeText = () => "é".repeat(FIXTURE_FRAME_LIMIT / 2 + 512);
const fixtureLargeText = () => "é".repeat(7 * 1024 * 1024);
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
let sessionCounter = 0;
let currentSessionFile: string | null = null;

// The end of a run as real pi writes it (pi 1.4.0 traces, reports-1012/pi-settle/r2-evidence).
const finishRun = (input: number, output: number) => {
  const message = { role: "assistant", stopReason: "stop", usage: { input, output } };
  send({ type: "message_end", message });
  send({ type: "turn_end", message, toolResults: [] });
  send({ type: "agent_end", willRetry: false });
  send({ type: "agent_settled", aborted: false });
};

// FAKE_PI_SCRIPT: a JSON array played on prompt. Each entry is a pi frame, or {wait: ms}, {exit: code},
// {closeStdout: true}. The arrays in pi-settle.test.ts are recorded real pi orders.
const playScript = async (file: string) => {
  for (const step of JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>) {
    if (typeof step.wait === "number") await new Promise((resolve) => setTimeout(resolve, step.wait as number));
    else if (typeof step.exit === "number") { process.exit(step.exit); }
    else if (step.closeStdout === true) { process.stdout.end(); }
    else send(step);
  }
};

// A faithful happy turn: a couple of text deltas then a terminal turn_end.
const streamTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  for (const delta of ["Hello", " from", " pi", ...(process.env.FAKE_PI_UNIQUE ? [` ${randomUUID().slice(0, 6)}`] : [])]) {
    send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  }
  finishRun(12, 3);
};

/** A whole turn that says `text` (project-propose mode's outcome). */
const streamTextTurn = (text: string) => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  finishRun(12, 3);
};

const streamErrorTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  const message = { role: "assistant", stopReason: "error", errorMessage: "Invalid schema for function 'computer_browser_prepare'", usage: { input: 0, output: 0 } };
  send({ type: "message_end", message });
  send({ type: "turn_end", message, toolResults: [] });
  send({ type: "agent_end", willRetry: false });
  send({ type: "agent_settled", aborted: false });
};

// tooluse: one tool turn (stopReason toolUse, pi auto-continues) then a text
// turn — exactly the sequence that broke the settle-on-toolUse bug.
const streamToolTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  const toolRound = { role: "assistant", stopReason: "toolUse", usage: { input: 5, output: 1 } };
  send({ type: "message_end", message: toolRound });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  send({ type: "turn_end", message: toolRound, toolResults: [{}] });
  // pi auto-continues within the same prompt to synthesize the reply
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" } });
  finishRun(12, 2);
};

// permission: open a select ask, hold the turn until extension_ui_response
// arrives, then stream the reply.
const streamPermissionTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "extension_ui_request", id: "ask-1", method: "select", title: "Run bash: echo hi?", options: ["Allow once", "Deny"] });
  // wait for the answer before finishing
};

// host-confirm: the pi-mcp-extension's gate before a host computer tool runs —
// a `ctx.ui.confirm` ask whose title the extension composes. Held like
// permission until extension_ui_response arrives.
const streamHostConfirmTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "extension_ui_request", id: "ask-host", method: "confirm", title: "Allow click on your computer?", message: "Run computer:click" });
};

// gate: pi-permission-gate asking before a bash call runs. The title carries
// the per-turn secret the driver handed over in MURAGE_PI_GATE (as the real
// gate does), and the message the call as JSON. FAKE_PI_GATE_CALL overrides
// the call; FAKE_PI_GATE_FORGE sends a wrong secret instead, as any other
// extension would have to.
const streamGateTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  const secret = process.env.FAKE_PI_GATE_FORGE ? "not-the-secret" : process.env.MURAGE_PI_GATE ?? "";
  const call = process.env.FAKE_PI_GATE_CALL ?? JSON.stringify({ tool: "bash", input: { command: [["r", "m"].join(""), "-rf", "~/Documents/old"].join(" ") } });
  // FAKE_PI_GATE_FORGE is any other extension's `confirm` carrying the gate's title shape (Rule 13).
  if (process.env.FAKE_PI_GATE_FORGE) send({ type: "extension_ui_request", id: "ask-host", method: "confirm", title: `murage-gate:${secret}`, message: call });
  else sendGateAsk("ask-host", call);
};
const sendGateAsk = (id: string, call: string) => send({ type: "extension_ui_request", id, method: "editor", title: `murage-gate:${process.env.MURAGE_PI_GATE ?? ""}`, prefill: call });

// question: an `input` ask, which is a question for the human, not a permission.
const streamQuestionTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "extension_ui_request", id: "ask-q", method: "input", title: "Which branch should I use?", placeholder: "branch name" });
};

// editor: a multi-line `editor` ask with prefilled text (docs/rpc.md).
const streamEditorTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "extension_ui_request", id: "ask-e", method: "editor", title: "Edit the release notes", prefill: "Line 1\nLine 2" });
};

/** Scripted text → tool → text → tool → text turn for order-contract tests. */
const streamInterleaveTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before one" } });
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo one" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before two" } });
  send({ type: "tool_execution_start", toolCallId: "call_2", toolName: "bash", args: { command: "echo two" } });
  send({ type: "tool_execution_end", toolCallId: "call_2", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "after" } });
  finishRun(12, 3);
};

/** A local model writing its to-do list into the answer (issue #7), split
 * mid-tag, with a tool call after it. */
const streamTodoTurn = () => {
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  for (const delta of ["On it.\n\n<to", "do>\n- [ ] List the folder\n- [ ] Rep", "ort back\n</todo>\n\nListing now."]) {
    send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  }
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "<todo>\n- [x] List the folder\n- [ ] Report back\n</todo>\nFound two files." } });
  finishRun(12, 3);
};

/** stream: a long reply that keeps working, a delta at a steady beat, then
 * a clean finish. Room-turn silence tests run it past the old fixed limit. */
let aborted = false;
const streamLongTurn = () => {
  aborted = false;
  const every = Math.max(10, Number(process.env.FAKE_PI_STREAM_EVERY_MS) || 500);
  const total = Math.max(every, Number(process.env.FAKE_PI_STREAM_FOR_MS) || 8_000);
  const startedAt = Date.now();
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant" } });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  const beat = setInterval(() => {
    if (aborted) { clearInterval(beat); return; }
    if (Date.now() - startedAt < total) {
      send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "." } });
      return;
    }
    clearInterval(beat);
    send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " long reply done" } });
    finishRun(12, 3);
  }, every);
};

const finishPermissionTurn = () => {
  send({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } });
  send({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", isError: false });
  send({ type: "message_update", usage: { input: 0, output: 0 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } });
  finishRun(8, 1);
};

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    handle(cmd);
  }
});
if (process.env.FAKE_PI_PID_FILE) writeFileSync(process.env.FAKE_PI_PID_FILE, String(process.pid));
process.stdin.on("end", () => (lingerMs > 0 ? lingerThenExit() : process.exit(0)));

// FAKE_PI_SESSION_GATE: answer the session handshake only once the gate file
// exists, so the driver's sendTurn stays pending until the test releases it.
const afterSessionGate = (answer: () => void) => {
  const gate = process.env.FAKE_PI_SESSION_GATE;
  if (!gate || existsSync(gate)) return answer();
  writeFileSync(`${gate}.waiting`, launchId);
  const poll = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(poll);
    answer();
  }, 25);
};

function handle(cmd: any) {
  if (process.env.FAKE_PI_COMMAND_LOG) {
    try { appendFileSync(process.env.FAKE_PI_COMMAND_LOG, JSON.stringify(cmd) + "\n"); } catch { /* never let logging break a run */ }
  }
  switch (cmd.type) {
    case "get_available_models":
      if (mode === "oversize-catalog") {
        // an oversized catalog frame that never ends (A4); stay alive
        process.stdout.write(`{"type":"response","command":"get_available_models","success":true,"data":{"note":"${fixtureOversizeText()}`);
        setInterval(() => {}, 1_000);
        return;
      }
      send({
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: mode === "no-models" ? [] : modelPairs },
      });
      return;
    case "new_session":
      // close-before-ready: read the handshake, never answer it, and exit (a pi that dies under a wrapper holding stdin open)
      if (mode === "close-before-ready") {
        process.stderr.write("pi could not load its settings\n", () => process.exit(1));
        return;
      }
      if (process.env.FAKE_PI_SESSION === "reject") {
        send({ type: "response", command: "new_session", success: false, error: "Could not create session directory" });
        return;
      }
      if (process.env.FAKE_PI_NO_SESSION) {
        afterSessionGate(() => send({ type: "response", command: "new_session", success: true, data: { cancelled: false } }));
        return;
      }
      sessionCounter += 1;
      currentSessionFile = `/fake/pi-session-${process.env.FAKE_PI_UNIQUE ? `${randomUUID()}-` : ""}${sessionCounter}.json`;
      afterSessionGate(() =>
        send({ type: "response", command: "new_session", success: true, data: { sessionId: `s-${sessionCounter}`, sessionFile: currentSessionFile } }),
      );
      return;
    case "switch_session":
      if (process.env.FAKE_PI_SESSION === "reject") {
        send({ type: "response", command: "switch_session", success: false, error: `Session file not found: ${cmd.sessionPath}` });
        return;
      }
      currentSessionFile = cmd.sessionPath ?? currentSessionFile;
      afterSessionGate(() =>
        send({ type: "response", command: "switch_session", success: true, data: { sessionId: "s-resumed", sessionFile: currentSessionFile } }),
      );
      return;
    case "set_model": {
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ setModel: { provider: cmd.provider, modelId: cmd.modelId } }) + "\n");
        } catch {
          /* never let dumping break a run */
        }
      }
      // pi answers an unknown provider/model with success:false and its own
      // error text; a wedged pi never answers at all.
      if (process.env.FAKE_PI_SET_MODEL === "silent") return;
      if (process.env.FAKE_PI_SET_MODEL === "reject") {
        send({ type: "response", command: "set_model", success: false, error: `Model not found: ${cmd.provider}/${cmd.modelId}` });
        return;
      }
      send({ type: "response", command: "set_model", success: true, data: { id: cmd.modelId, provider: cmd.provider } });
      return;
    }
    case "set_thinking_level":
      // record the level so a test can assert what the driver pinned
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ thinkingLevel: cmd.level }) + "\n");
        } catch {
          /* never let dumping break a run */
        }
      }
      send({ type: "response", command: "set_thinking_level", success: true });
      return;
    case "prompt":
      // crash-mid-turn: take the prompt and exit with no terminal event (a pi that crashes after the first write)
      if (mode === "crash-mid-turn") {
        process.stderr.write("pi crashed while answering\n", () => process.exit(1));
        return;
      }
      // record receipt so a test can prove a prompt was (or was never) sent
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ prompt: true, action: true, pid: process.pid, launchId, message: cmd.message }) + "\n");
        } catch {
          /* never let dumping break a run */
        }
      }
      // acknowledge acceptance; the completion comes via events. FAKE_PI_PROMPT_RESPONSE replaces the answer, as a refused or handled prompt.
      send({ type: "response", command: "prompt", success: true, ...(process.env.FAKE_PI_PROMPT_RESPONSE ? JSON.parse(process.env.FAKE_PI_PROMPT_RESPONSE) : {}) });
      if (process.env.FAKE_PI_PROMPT_RESPONSE) return;
      if (process.env.FAKE_PI_SCRIPT) { void playScript(process.env.FAKE_PI_SCRIPT); return; }
      // Bounded-ingress fixtures (A4), keyed on the prompt text.
      if (fixtureRequested(String(cmd.message ?? ""), "__fixture_oversize_frame__")) {
        // a VALID frame one KiB over the limit, then a clean turn_end
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: fixtureOversizeText() } });
        streamTurn();
        return;
      }
      if (fixtureRequested(String(cmd.message ?? ""), "__fixture_oversize_open_frame__")) {
        process.stdout.write(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"${fixtureOversizeText()}`);
        return;
      }
      if (fixtureRequested(String(cmd.message ?? ""), "__fixture_large_frame__")) {
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: fixtureLargeText() } });
        streamTurn();
        return;
      }
      // CR2: accepted prompt remains active until the owned fixture is stopped.
      if (mode === "hold") return;
      // FAKE_CUSTOM_TOOL_SERVER (fake-custom-tool.ts): call the first tool of
      // that owner server, from the MURAGE_MCP_CONFIG pi-mcp-extension reads.
      {
        const customServer = customToolServer(String(cmd.message ?? ""));
        if (customServer) {
          let entry: McpServerEntry | undefined;
          try { entry = (JSON.parse(readFileSync(process.env.MURAGE_MCP_CONFIG ?? "", "utf8")) as { mcpServers?: Record<string, McpServerEntry> }).mcpServers?.[customServer]; } catch { entry = undefined; }
          void (async () => {
            const outcome = entry
              ? await callFirstCustomTool("pi", customServer, { command: entry.command, args: entry.args ?? [], env: entry.env ?? {} }, String(cmd.message ?? ""))
              : { tools: [], text: `no ${customServer} server was mounted`, isError: true };
            streamTextTurn(customToolReply(outcome));
          })();
          return;
        }
      }
      // lane review: a review run answers with its verdict (fake-review.ts)
      const reviewText = fakeReviewReply(String(cmd.message ?? ""));
      if (reviewText !== null) { streamTextTurn(reviewText); return; }
      if (mode === "text-propose" && String(cmd.message ?? "").includes("<murage-project-proposal")) {
        // Lane N2: the Chief answers with the proposal block, after reading /etc/hosts
        // exactly as the gate decides for that call.
        const secret = process.env.MURAGE_PI_GATE ?? "", only = process.env.MURAGE_PI_GATE_ONLY || undefined;
        void new Promise<string>(resolve => {
          if (!secret || !gateAsks("read", only)) return resolve("ran unasked");
          proposalAsks.set("ask-read", confirmed => resolve(confirmed ? "allowed" : "denied"));
          send({ type: "extension_ui_request", id: "ask-read", method: "editor", title: `${PI_GATE_TITLE_PREFIX}${secret}`, prefill: piGateMessage("read", { path: "/etc/hosts" }) });
        }).then(read => {
          logProposalTurn({ engine: "piAgent", asks: { read }, agentsMounted: Boolean(process.env.MURAGE_MCP_CONFIG) });
          streamTextTurn(proposalReply(String(cmd.message)));
        });
        return;
      }
      if (mode === "project-propose" && String(cmd.message ?? "").includes("project_propose")) {
        // The Chief's New project proposal (lane N), through the agents server
        // pi-mcp-extension would mount from MURAGE_MCP_CONFIG.
        let agents: McpServerEntry | undefined;
        try { agents = (JSON.parse(readFileSync(process.env.MURAGE_MCP_CONFIG ?? "", "utf8")) as { mcpServers?: Record<string, McpServerEntry> }).mcpServers?.agents; } catch { agents = undefined; }
        if (!agents) { streamTextTurn("propose error: no agents server"); return; }
        // Before proposing, the model reads /etc/hosts: exactly what pi-permission-gate.ts
        // decides for that call with this process's gate settings, asked the way it asks.
        const secret = process.env.MURAGE_PI_GATE ?? "", only = process.env.MURAGE_PI_GATE_ONLY || undefined;
        const gateAsk = (id: string, toolName: string, input: Record<string, unknown>) => new Promise<string>(resolve => {
          if (!secret || !gateAsks(toolName, only)) return resolve("ran unasked");
          proposalAsks.set(id, confirmed => resolve(confirmed ? "allowed" : "denied"));
          send({ type: "extension_ui_request", id, method: "editor", title: `${PI_GATE_TITLE_PREFIX}${secret}`, prefill: piGateMessage(toolName, input) });
        });
        void (async () => ({ read: await gateAsk("ask-read", "read", { path: "/etc/hosts" }), propose: await gateAsk("ask-propose", "agents_project_propose", {}) }))()
          .then(asks => proposeThroughMcp(agents!, String(cmd.message), { asks }))
          .then(streamTextTurn, (error: Error) => streamTextTurn(`propose error: ${error.message}`));
        return;
      }
      if (mode === "action-guard") {
        send({ type: "tool_execution_start", toolCallId: "wrapper", toolName: "MULTI_EXECUTE_TOOL", args: { tools: [
          { tool_slug: "GMAIL_SEND_EMAIL", call_id: "first" }, { tool_slug: "GMAIL_SEND_EMAIL", call_id: "second" },
        ] } });
        send({ type: "tool_execution_end", toolCallId: "wrapper", toolName: "MULTI_EXECUTE_TOOL", isError: false,
          result: { content: [{ type: "text", text: JSON.stringify({ results: [
            { tool_slug: "GMAIL_SEND_EMAIL", call_id: "second", response: { successful: false } },
            { tool_slug: "GMAIL_SEND_EMAIL", call_id: "first", response: { successful: true } },
          ] }) }] } });
        streamTextTurn("I sent it. I paid it.");
      }
      else if (mode === "tooluse") streamToolTurn();
      else if (mode === "permission") streamPermissionTurn();
      else if (mode === "host-confirm") streamHostConfirmTurn();
      else if (mode === "gate") streamGateTurn();
      else if (mode === "question") streamQuestionTurn();
      else if (mode === "editor") streamEditorTurn();
      else if (mode === "interleave") streamInterleaveTurn();
      else if (mode === "todo") streamTodoTurn();
      else if (mode === "turn-error") streamErrorTurn();
      else if (mode === "stream") streamLongTurn();
      else streamTurn();
      return;
    case "extension_ui_response":
      // record the exact reply shape so a test can assert {value} vs {confirmed} vs {cancelled}
      if (process.env.FAKE_PI_DUMP) {
        try {
          appendFileSync(process.env.FAKE_PI_DUMP, JSON.stringify({ uiResponse: cmd }) + "\n");
        } catch {
          /* never let dumping break a run */
        }
      }
      if (proposalAsks.has(cmd.id)) { const answered = proposalAsks.get(cmd.id)!; proposalAsks.delete(cmd.id); answered(cmd.confirmed === true || (typeof cmd.value === "string" && cmd.value.includes('"allow":true'))); return; }
      // FAKE_PI_GATE_TWICE=1: the gate asks a second time in the same turn (ask-host-2) before the turn finishes
      if (cmd.id === "ask-host" && process.env.FAKE_PI_GATE_TWICE === "1") { sendGateAsk("ask-host-2", JSON.stringify({ tool: "bash", input: { command: "ls" } })); return; }
      // pi stops at the abort: a cancelled gate answer runs no tool
      if (aborted) return;
      if (cmd.id === "ask-1" || cmd.id === "ask-host" || cmd.id === "ask-host-2" || cmd.id === "ask-q" || cmd.id === "ask-e") finishPermissionTurn();
      return;
    case "abort":
      aborted = true;
      {
        const message = { role: "assistant", stopReason: "aborted", usage: { input: 0, output: 0 } };
        send({ type: "message_end", message });
        send({ type: "turn_end", message, toolResults: [] });
        send({ type: "agent_end", willRetry: false });
      }
      // FAKE_PI_ABORT_DIALOG: a gate ask lands in the abort grace, as a tool hook already in flight would.
      if (process.env.FAKE_PI_ABORT_DIALOG === "1") sendGateAsk("ask-late", JSON.stringify({ tool: "bash", input: { command: "ls" } }));
      send({ type: "agent_settled", aborted: true });
      if (process.env.FAKE_PI_ABORT_SILENT === "1") return;
      setTimeout(() => {
        if (process.env.FAKE_PI_ABORT_MARKER) writeFileSync(process.env.FAKE_PI_ABORT_MARKER, "session flushed");
        send({ type: "response", command: "abort", success: true });
      }, Math.min(10_000, Number(process.env.FAKE_PI_ABORT_MS) || 0));
      return;
    default:
      return;
  }
}
