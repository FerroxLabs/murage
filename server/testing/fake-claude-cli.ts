#!/usr/bin/env node
// Fake of the claude CLI's stream-json surface, for driver tests.
// Reads the prompt from stdin (one stream-json line), then plays a
// scripted session. Failure modes are toggled by env var, mirroring how
// the real thing misbehaves:
//
//   FAKE_CLAUDE_MODE   happy (default) | exit-early | hang | malformed
//                      | stream (partial-message text deltas before the
//                        whole-message frame, plus subagent noise to drop)
//                      | ask-user-question (also: a prompt whose last line
//                        holds __fixture_ask_user_question__) — calls
//                        AskUserQuestion through the real --permission-prompt-tool
//                        MCP server from --mcp-config, the way Claude Code
//                        2.1.268 does, then reports the tool_result text
//                        Claude would see. FAKE_CLAUDE_AUQ_INPUT overrides the
//                        questions (JSON {questions:[…]}).
//   FAKE_CLAUDE_REVIEW_LOG path that gets one line per one-shot review call,
//                      so a test can prove the AI reviewer was never asked.
//   FAKE_CLAUDE_DUMP   path to write {argv, env, prompt, systemPrompt,
//                      mcpConfig} as JSON,
//                      so the test can assert on argv shape and env hygiene.
//                      mcpConfig is read back from the --mcp-config file the
//                      way the real CLI reads it — the driver writes it to a
//                      private temp file and deletes it when the turn settles,
//                      so a test cannot open it after the fact.
//   FAKE_CLAUDE_REPLIES JSON array of strings (or string arrays for multiple
//                      assistant items) used in order across turns. This makes
//                      bounded multi-turn orchestration deterministic.
//   FAKE_CLAUDE_REPLY_STATE Optional counter file shared by fresh CLI
//                      processes so scripted replies keep their order.
//   FAKE_CLAUDE_REPLY_GATE Optional file whose creation releases slow replies.
//   FAKE_CLAUDE_REPLY_GATE_STEERS With the gate: also wait until this many
//                      mid-turn steers have been read, so a gate opened right
//                      after a steer was acknowledged cannot be seen first
//                      (timers run before pipe reads in the event loop).
//   FAKE_CLAUDE_AUTH   in (default) | out | unsupported | malformed |
//                      inherited-api-key — what `auth status` reports
//   FAKE_CLAUDE_SIGTERM_DELAY_MS a CLI that takes this long to close after
//                      SIGTERM (the real CLI tears down MCP children and
//                      flushes before exiting). The turn's writer lease is
//                      released only at that close, so a test can stand
//                      inside the Stop → close window deterministically.
//
//   FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS how many launches die with transient
//                      stderr at startup WITHOUT reading stdin (counted in
//                      FAKE_CLAUDE_STATE). The driver only sees its write
//                      refused when the prompt cannot fit in the OS pipe
//                      buffer, so tests pair it with a very large prompt.
//   FAKE_CLAUDE_FAIL_AFTER tool | text | reasoning — every launch accepts the
//                      prompt, does that work, then dies with ECONNRESET.
//                      FAKE_CLAUDE_STATE counts launches and
//                      FAKE_CLAUDE_SIDE_EFFECTS gets one line per sentinel
//                      tool action, so a replay is directly observable.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const mode = process.env.FAKE_CLAUDE_MODE ?? "happy";
const scriptedReplies = (() => {
  try {
    const parsed = JSON.parse(process.env.FAKE_CLAUDE_REPLIES ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string | string[] =>
      typeof value === "string" || (Array.isArray(value) && value.every((part) => typeof part === "string"))
    );
  } catch {
    return [];
  }
})();
let scriptedReplyIndex = 0;
const nextScriptedReply = (): string[] => {
  const stateFile = process.env.FAKE_CLAUDE_REPLY_STATE;
  let index = scriptedReplyIndex;
  if (stateFile) {
    try {
      index = Number(readFileSync(stateFile, "utf8")) || 0;
    } catch {}
    writeFileSync(stateFile, String(index + 1));
  } else {
    scriptedReplyIndex += 1;
  }
  const reply = scriptedReplies[index] ?? "hello from fake claude";
  return Array.isArray(reply) ? reply : [reply];
};

const argv = process.argv.slice(2);
const argAfter = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
// Mirrors ENGINE_FRAME_MAX_BYTES in server/drivers/bounded-lines.ts. "é" is
// two UTF-8 bytes: the oversize text alone is one KiB over the limit, and the
// large text is 14 MiB, the size of a 10 MiB image as base64.
const FIXTURE_FRAME_LIMIT = 32 * 1024 * 1024;
const fixtureOversizeText = () => "é".repeat(FIXTURE_FRAME_LIMIT / 2 + 512);
const fixtureLargeText = () => "é".repeat(7 * 1024 * 1024);
// Markers count only on the prompt's last line (the current request): the
// harness replays earlier messages into a fresh process's prompt, and an old
// marker there must not re-trigger a fixture on a later, ordinary turn.
const fixtureRequested = (text: string, marker: string) => (text.trimEnd().split("\n").pop() ?? "").includes(marker);

// Snapshot probes: both answer on argv alone and exit without reading stdin.
if (argv[0] === "--version") {
  process.stdout.write("2.1.232 (Claude Code)\n");
  process.exit(0);
}

if (argv[0] === "auth" && argv[1] === "status") {
  const auth = process.env.FAKE_CLAUDE_AUTH ?? "in";
  if (auth === "unsupported") {
    process.stderr.write("error: unknown command 'auth'\n");
    process.exit(1);
  }
  if (auth === "malformed") {
    process.stdout.write("not json\n");
    process.exit(0);
  }
  const loggedIn = auth === "in" || (auth === "inherited-api-key" && Boolean(process.env.ANTHROPIC_API_KEY));
  process.stdout.write(
    JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" }) + "\n",
    () => process.exit(auth === "out" ? 1 : 0),
  );
}

// One-shot helper mode used by generateText/reviewPermission. The prompt is
// deliberately read from stdin so sensitive review text never appears in
// argv or process listings.
if (argAfter("--output-format") === "text") {
  const prompt = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
  if (process.env.FAKE_CLAUDE_DUMP) {
    writeFileSync(
      process.env.FAKE_CLAUDE_DUMP,
      JSON.stringify({ pid: process.pid, argv, env: process.env, prompt, mcpConfig: null }, null, 2),
    );
  }
  if (process.env.FAKE_CLAUDE_REVIEW_LOG) appendFileSync(process.env.FAKE_CLAUDE_REVIEW_LOG, "one-shot\n");
  process.stdout.write("fake generated text\n");
  process.exit(0);
}

const countLaunch = (): number => {
  const stateFile = process.env.FAKE_CLAUDE_STATE;
  if (!stateFile) return 0;
  let launched = 0;
  try {
    launched = Number(readFileSync(stateFile, "utf8")) || 0;
  } catch {}
  writeFileSync(stateFile, String(launched + 1));
  return launched;
};

// Pre-accept transient failure (U-17): die before ever reading stdin, the way
// a CLI that fails during startup behaves. The stdin reader below is never
// attached, so the driver's prompt is never consumed.
if (process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS && process.env.FAKE_CLAUDE_STATE) {
  const launched = countLaunch();
  if (launched < (Number(process.env.FAKE_CLAUDE_PRE_ACCEPT_TRANSIENTS) || 0)) {
    process.stderr.write("claude: API error: read ECONNRESET\n", () => process.exit(5));
    await new Promise(() => {});
  }
}

// Line-driven, like the real CLI under --input-format stream-json: each user
// message starts a turn; a message that arrives WHILE a turn is playing is
// folded into it (the real CLI delivers it before the next model call — the
// harness calls that a steer); the process stays alive with stdin open and
// exits only when stdin ends. `slow` leaves a gap between the tool result
// and the reply so a test can steer into it.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "fake-session";
const model = argAfter("--model") ?? "claude-fake";
let dumped = false;
let turnRunning = false;
let steered: string[] = [];
let stdinEnded = false;
let steerGateArmed = false;

// Ownership-race fixture: after accepting the first prompt, stop consuming
// stdin until the test creates this file. A large second write then leaves
// adapter.steer() genuinely pending while the first turn settles and another
// HTTP request deletes or switches the bot.
const armSteerGate = () => {
  const gate = process.env.FAKE_CLAUDE_STEER_GATE;
  if (!gate || steerGateArmed) return;
  steerGateArmed = true;
  process.stdin.pause();
  const poll = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(poll);
    process.stdin.resume();
  }, 10);
};

const promptText = (prompt: JsonValue): string => {
  const m = prompt && typeof prompt === "object" && !Array.isArray(prompt) ? (prompt as { message?: { content?: unknown } }).message : undefined;
  return typeof m?.content === "string" ? m.content : "";
};

// ── AskUserQuestion through the real permission host ─────────────────────
type AuqQuestion = { question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean };
const DEFAULT_AUQ: { questions: AuqQuestion[] } = {
  questions: [
    {
      question: "Which format should the report use?",
      header: "Format",
      options: [
        { label: "Summary", description: "A short overview" },
        { label: "Detailed", description: "Every finding with its evidence" },
      ],
      multiSelect: false,
    },
    {
      question: "Which sections should it include?",
      header: "Sections",
      options: [
        { label: "Intro", description: "Opening context" },
        { label: "Findings", description: "What was found" },
        { label: "Outro", description: "Next steps" },
      ],
      multiSelect: true,
    },
  ],
};

/** The tool_result text Claude Code 2.1.268 builds from an AskUserQuestion
 * allow (mapToolResultToToolResultBlockParam in the shipped binary). The
 * per-answer list is formatted `"Q"="A"` here; the three sentence templates
 * and the label check are the binary's own. */
const auqResultText = (questions: AuqQuestion[], answers: Record<string, unknown>, response?: unknown): string => {
  if (typeof response === "string" && response.trim()) return `The user responded: ${response}`;
  const given = questions.filter((q) => answers[q.question] !== undefined && answers[q.question] !== "");
  if (!given.length) return "The user did not answer the questions.";
  const list = given
    .map((q) => {
      const a = answers[q.question];
      return `"${q.question}"="${Array.isArray(a) ? a.join(", ") : String(a)}"`;
    })
    .join(", ");
  const labelsOnly = given.every((q) => {
    const a = answers[q.question];
    const labels = new Set(q.options.map((option) => option.label));
    if (Array.isArray(a)) return q.multiSelect === true && a.length > 0 && a.every((label) => labels.has(String(label)));
    if (labels.has(String(a))) return true;
    return q.multiSelect === true && String(a).split(", ").every((label) => labels.has(label));
  });
  return labelsOnly
    ? `Your questions have been answered: ${list}. You can now continue with these answers in mind.`
    : `The user answered: ${list}. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`;
};

/** Call the --permission-prompt-tool exactly as the CLI does: spawn its MCP
 * server from --mcp-config, initialize, tools/call, read the text result. */
const callPermissionPromptTool = (args: Record<string, unknown>): Promise<string | null> => {
  const promptTool = argAfter("--permission-prompt-tool");
  const configPath = argAfter("--mcp-config");
  const match = promptTool ? /^mcp__(.+?)__(.+)$/.exec(promptTool) : null;
  if (!match || !configPath) return Promise.resolve(null);
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> };
  const server = config.mcpServers?.[match[1]!];
  if (!server) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "ignore"] });
    let buffered = "";
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", reject);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let nl;
      while ((nl = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        let message: { id?: number; result?: { content?: Array<{ text?: string }> } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: match[2], arguments: args } });
        } else if (message.id === 2) {
          child.stdin.end();
          resolve(message.result?.content?.[0]?.text ?? "");
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } } });
  });
};

const playAskUserQuestion = async (): Promise<void> => {
  const input = process.env.FAKE_CLAUDE_AUQ_INPUT ? (JSON.parse(process.env.FAKE_CLAUDE_AUQ_INPUT) as { questions: AuqQuestion[] }) : DEFAULT_AUQ;
  const toolUseId = `toolu_fake_auq_${process.pid}_${Date.now()}`;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input }] } });
  let content: string;
  let isError = false;
  try {
    const reply = await callPermissionPromptTool({ tool_name: "AskUserQuestion", input, tool_use_id: toolUseId });
    if (reply === null) {
      // the real CLI denies a permission-gated tool when no host is mounted
      content = "AskUserQuestion needs a permission prompt tool, and none is configured.";
      isError = true;
    } else {
      const decision = JSON.parse(reply) as { behavior?: string; message?: string; updatedInput?: { answers?: Record<string, unknown>; response?: unknown } };
      if (decision.behavior === "allow") content = auqResultText(input.questions, decision.updatedInput?.answers ?? {}, decision.updatedInput?.response);
      else {
        content = String(decision.message ?? "Permission denied");
        isError = true;
      }
    }
  } catch (error) {
    content = `permission prompt tool failed: ${error instanceof Error ? error.message : String(error)}`;
    isError = true;
  }
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: `AskUserQuestion result: ${content}` }] } });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  turnRunning = false;
  finishIfDone();
};

let exitGateTimer: ReturnType<typeof setInterval> | undefined;
const finishIfDone = () => {
  if (!stdinEnded || turnRunning) return;
  const exitGateDir = process.env.FAKE_CLAUDE_EXIT_GATE_DIR;
  if (exitGateDir && !existsSync(join(exitGateDir, String(process.pid)))) {
    // Hold EOF independently of turn completion so replacement-broker tests
    // can release the old child's close after its successor is serving asks.
    exitGateTimer ??= setInterval(finishIfDone, 10);
    return;
  }
  if (exitGateTimer) clearInterval(exitGateTimer);
  process.exit(0);
};

const playTurn = (prompt: JsonValue) => {
  turnRunning = true;
  steered = [];
  if ((!dumped || process.env.FAKE_CLAUDE_DUMP_EACH_TURN === "1") && process.env.FAKE_CLAUDE_DUMP) {
    dumped = true;
    const configPath = argAfter("--mcp-config");
    let mcpConfig: unknown = null;
    if (configPath) {
      try {
        mcpConfig = JSON.parse(readFileSync(configPath, "utf8"));
      } catch {
        /* leave null — the test will see it */
      }
    }
    const systemPromptPath = argAfter("--append-system-prompt-file");
    let systemPrompt: string | null = null;
    if (systemPromptPath) {
      try {
        systemPrompt = readFileSync(systemPromptPath, "utf8");
      } catch {
        /* leave null — the test will see it */
      }
    }
    writeFileSync(
      process.env.FAKE_CLAUDE_DUMP,
      JSON.stringify({ pid: process.pid, argv, env: process.env, prompt, systemPrompt, mcpConfig }, null, 2),
    );
  }

  if (mode === "exit-early") {
    process.stderr.write("fake-claude: simulated crash before result\n");
    process.exit(3);
  }
  // Bounded-ingress fixtures (A4), keyed on the prompt text.
  if (fixtureRequested(promptText(prompt), "__fixture_oversize_frame__")) {
    // a VALID frame one KiB over the limit, then a clean success result:
    // the driver must fail the turn rather than read past the dropped frame
    out({ type: "system", subtype: "init", session_id: sessionId, model });
    out({ type: "assistant", message: { content: [{ type: "text", text: fixtureOversizeText() }] } });
    out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
    turnRunning = false;
    finishIfDone();
    return;
  }
  if (fixtureRequested(promptText(prompt), "__fixture_oversize_open_frame__")) {
    out({ type: "system", subtype: "init", session_id: sessionId, model });
    process.stdout.write(`{"type":"assistant","message":{"content":[{"type":"text","text":"${fixtureOversizeText()}`);
    return;
  }
  if (fixtureRequested(promptText(prompt), "__fixture_large_frame__")) {
    out({ type: "system", subtype: "init", session_id: sessionId, model });
    out({ type: "assistant", message: { content: [{ type: "text", text: fixtureLargeText() }] } });
    out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
    turnRunning = false;
    finishIfDone();
    return;
  }
  // transient-failure script for retry tests. FAKE_CLAUDE_TRANSIENTS is how
  // many launches fail transiently (503-shaped stderr, exit 5); the count of
  // launches so far lives in a state FILE because child processes cannot
  // mutate the parent's environment. When the quota is exhausted (or
  // FAKE_CLAUDE_STATE is unset) the turn completes normally.
  // FAKE_CLAUDE_PARTIAL_FAILS makes the FIRST launch emit a text delta
  // before failing — the partial-output guard must forbid retrying it.
  if (process.env.FAKE_CLAUDE_TRANSIENTS && process.env.FAKE_CLAUDE_STATE) {
    let launched = 0;
    try {
      launched = Number(readFileSync(process.env.FAKE_CLAUDE_STATE, "utf8")) || 0;
    } catch {}
    const quota = Number(process.env.FAKE_CLAUDE_TRANSIENTS) || 0;
    writeFileSync(process.env.FAKE_CLAUDE_STATE, String(launched + 1));
    out({ type: "system", subtype: "init", session_id: sessionId, model });
    if (launched < quota) {
      if (process.env.FAKE_CLAUDE_PARTIAL_FAILS) {
        out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "half an answer" } } });
      }
      process.stderr.write("claude: API error (503): service temporarily unavailable\n");
      process.exit(5);
    }
  }

  // Post-accept failure (A1): the prompt was read and work happened, then
  // the connection dropped before the result. Every launch fails the same
  // way, so a replay shows up as a second launch and, for `tool`, a second
  // sentinel side effect. The final frame's write callback gates exit so no
  // stdout is lost.
  const failAfter = process.env.FAKE_CLAUDE_FAIL_AFTER;
  if (failAfter === "tool" || failAfter === "text" || failAfter === "reasoning") {
    countLaunch();
    out({ type: "system", subtype: "init", session_id: sessionId, model });
    const delta = (d: unknown) => ({ type: "stream_event", event: { type: "content_block_delta", delta: d } });
    let last: unknown;
    if (failAfter === "tool") {
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-sentinel", name: "Bash" }] } });
      if (process.env.FAKE_CLAUDE_SIDE_EFFECTS) {
        appendFileSync(process.env.FAKE_CLAUDE_SIDE_EFFECTS, `${promptText(prompt).length}\n`);
      }
      last = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-sentinel", is_error: false }] } };
    } else if (failAfter === "text") {
      out(delta({ type: "text_delta", text: "partial answer" }));
      // the completed block resets the driver's UI de-dup flag
      last = { type: "assistant", message: { content: [{ type: "text", text: "partial answer" }] } };
    } else {
      last = delta({ type: "thinking_delta", thinking: "weighing the options" });
    }
    process.stdout.write(JSON.stringify(last) + "\n", () => {
      process.stderr.write("claude: API error: read ECONNRESET\n", () => process.exit(5));
    });
    return;
  }

  // the real CLI re-announces init on every turn of a live process
  out({ type: "system", subtype: "init", session_id: sessionId, model });

  if (mode === "background-result") {
    // Actual installed 0.1.49 capture: stopped task notification, init,
    // task-notification result, then init and the user's assistant/tool work.
    // The gate only makes the tool-approval check deterministic; it does not
    // invent a new result shape or grant an unsolicited background turn.
    out({ type: "system", subtype: "task_notification", task_id: "fixture-task", status: "stopped", output_file: "fixture-output", summary: "Background task stopped", session_id: sessionId });
    out({ type: "result", subtype: "success", is_error: false, origin: { kind: "task-notification" }, session_id: sessionId });
    out({ type: "system", subtype: "init", session_id: sessionId, model });
    out({ type: "assistant", message: { content: [{ type: "text", text: "continuing submitted user work" }] } });
    const gate = process.env.FAKE_CLAUDE_REPLY_GATE;
    const timer = setInterval(() => {
      if (!gate || !existsSync(gate)) return;
      clearInterval(timer);
      out({ type: "result", subtype: "success", is_error: false, origin: { kind: "human" }, session_id: sessionId, stop_reason: "end_turn", total_cost_usd: 0 });
      turnRunning = false;
      finishIfDone();
    }, 10);
    return;
  }

  // Shell-output fixture: writes a real file inside the turn's working folder
  // the way a Bash/Write tool would, without ever calling register_artifact.
  // Runs before the hang branch so held turns write too. A Markdown path gets
  // a Markdown report (the workspace editor's format); anything else HTML.
  const writeOutput = /__fixture_write_output__:([A-Za-z0-9_./-]{1,200})/.exec(promptText(prompt));
  // Create-only: a prompt that repeats earlier conversation text must not
  // rewrite a report a previous turn already produced.
  if (writeOutput && !writeOutput[1]!.split("/").some((part) => part === "" || part === "." || part === "..")) {
    const target = join(process.cwd(), ...writeOutput[1]!.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    const markdown = /\.(md|markdown)$/i.test(writeOutput[1]!);
    const body = markdown
      ? `# Weekly report\n\nThree updates this week.\n\n- Written by the fixture engine to ${writeOutput[1]}\n`
      : `<!doctype html><h1>Fixture report</h1><p>${writeOutput[1]}</p>\n`;
    if (!existsSync(target)) writeFileSync(target, body, { flag: "wx" });
  }
  if (promptText(prompt).includes("__fixture_fail_turn__")) {
    out({ type: "assistant", message: { content: [{ type: "text", text: "fixture turn failed after writing" }] } });
    out({ type: "result", is_error: true, stop_reason: "error", total_cost_usd: 0 });
    turnRunning = false;
    finishIfDone();
    return;
  }

  // `__fixture_finish_turn__` completes normally even when the suite runs
  // the fake in hang mode, so a test can observe a real terminal turn.
  const finishNow = promptText(prompt).includes("__fixture_finish_turn__");
  if ((mode === "hang" && !finishNow) || promptText(prompt).includes("__fixture_hold_authority__")) {
    // stay alive until killed — lets tests exercise interrupt + the
    // permission broker while a turn is officially in flight
    if (promptText(prompt).includes("__fixture_error_result_on_stop__")) {
      // A CLI that reports its own interruption: on SIGTERM it writes an
      // error result for the running turn, then exits.
      process.once("SIGTERM", () => {
        process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: null, total_cost_usd: 0 }) + "\n", () => process.exit(143));
      });
    }
    const gateDir = process.env.FAKE_CLAUDE_FINISH_GATE_DIR;
    const gate = gateDir ? join(gateDir, String(process.pid)) : undefined;
    const timer = setInterval(() => {
      if (!gate || !existsSync(gate)) return;
      unlinkSync(gate);
      clearInterval(timer);
      out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 0 } });
      turnRunning = false;
      finishIfDone();
    }, gate ? 10 : 1_000);
    return;
  }

  if (mode === "ask-user-question" || fixtureRequested(promptText(prompt), "__fixture_ask_user_question__")) {
    void playAskUserQuestion();
    return;
  }

  if (mode === "malformed") {
    process.stdout.write("this is not json\n{broken\n");
  }

  // Upstream signed-out protocol capture; the success-result variant ensures
  // a flagged auth failure cannot be mislabeled as successful completion.
  if (mode === "not-logged-in" || mode === "not-logged-in-success-result") {
    out({ type: "assistant", error: "authentication_failed", is_api_error_message: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
    out({ type: "result", is_error: mode === "not-logged-in", stop_reason: "stop_sequence", terminal_reason: "api_error" });
    turnRunning = false; finishIfDone(); return;
  }

  if (mode === "stream") {
    const delta = (d: unknown) => out({ type: "stream_event", event: { type: "content_block_delta", delta: d } });
    delta({ type: "thinking_delta", thinking: "hmm" });
    delta({ type: "text_delta", text: "hello from " });
    delta({ type: "text_delta", text: "fake claude" });
    // subagent narration — the driver must drop this, not render it
    out({
      type: "stream_event",
      parent_tool_use_id: "task-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBAGENT NOISE" } },
    });
  }

  const replyParts = nextScriptedReply();
  replyParts.forEach((text, index) => {
    const content: Array<
      { type: "text"; text: string } | { type: "tool_use"; id: string; name: string }
    > = [{ type: "text", text }];
    if (index === replyParts.length - 1) content.push({ type: "tool_use", id: "tu-1", name: "Bash" });
    out({
      type: "assistant",
      message: {
        content,
        usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
      },
    });
  });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: false }] } });

  const finish = () => {
    out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 } });
    turnRunning = false;
    finishIfDone();
  };
  if (mode === "slow") {
    // a gap a test can steer into; the closing reply carries anything that
    // was folded in, the way the real CLI includes a mid-turn message in
    // the same turn's next model call
    const finishSlow = () => {
      const tail = steered.length ? ` + steered: ${steered.join(" | ")}` : "";
      out({ type: "assistant", message: { content: [{ type: "text", text: `reply to: ${promptText(prompt)}${tail}` }] } });
      finish();
    };
    const gate = process.env.FAKE_CLAUDE_REPLY_GATE;
    const gateSteers = Number(process.env.FAKE_CLAUDE_REPLY_GATE_STEERS ?? 0) || 0;
    if (gate) {
      const timer = setInterval(() => {
        if (!existsSync(gate) || steered.length < gateSteers) return;
        clearInterval(timer);
        finishSlow();
      }, 10);
    } else setTimeout(finishSlow, 800);
  } else {
    finish();
  }
};

// Slow close: keep running for the configured delay after SIGTERM, then exit
// the way a signalled process does. Without the variable Node's default
// handler exits at once, as before.
const sigtermDelayMs = Number(process.env.FAKE_CLAUDE_SIGTERM_DELAY_MS);
if (Number.isFinite(sigtermDelayMs) && sigtermDelayMs > 0) {
  process.on("SIGTERM", () => { setTimeout(() => process.exit(143), sigtermDelayMs); });
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let prompt: JsonValue = null;
    try {
      prompt = JSON.parse(line);
    } catch {
      continue;
    }
    if (turnRunning) steered.push(promptText(prompt));
    else {
      playTurn(prompt);
      armSteerGate();
    }
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  finishIfDone();
});
