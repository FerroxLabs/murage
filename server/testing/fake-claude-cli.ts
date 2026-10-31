#!/usr/bin/env node
// Fake of the claude CLI's stream-json surface, for driver tests.
// Reads the prompt from stdin (one stream-json line), then plays a
// scripted session. Failure modes are toggled by env var, mirroring how
// the real thing misbehaves:
//
//   FAKE_CLAUDE_MODE   happy (default) | exit-early | hang | malformed | final-steer
//   FAKE_CLAUDE_ELICIT JSON array of control `request` objects the CLI sends the HOST
//                      before its first turn plays (an MCP elicitation, or any other
//                      subtype); the turn waits until each one has a control_response,
//                      and every response line goes to FAKE_CLAUDE_ELICIT_LOG.
//                      FAKE_CLAUDE_ELICIT_WITHDRAW=1 withdraws the first one at once
//                      (control_cancel_request), as the CLI does when the server cancels.
//                      | stream (partial-message text deltas before the
//                        whole-message frame, plus subagent noise to drop)
//                      | ask-user-question (also: a prompt whose last line
//                        holds __fixture_ask_user_question__) — calls
//                        AskUserQuestion through the real --permission-prompt-tool
//                        MCP server from --mcp-config, the way Claude Code
//                        2.1.268 does, then reports the tool_result text
//                        Claude would see. FAKE_CLAUDE_AUQ_INPUT overrides the
//                        questions (JSON {questions:[…]}).
//   FAKE_CUSTOM_TOOL_SERVER / FAKE_CUSTOM_TOOL_LOG every turn calls the first
//                      tool of that owner server from --mcp-config
//                      (fake-custom-tool.ts)
//   FAKE_CLAUDE_REVIEW_LOG path that gets one line per one-shot review call,
//                      so a test can prove the AI reviewer was never asked.
//   FAKE_CLAUDE_ONE_SHOT_TEXT what every one-shot call answers ({{PROPOSAL_NONCE}} becomes the
//                             prompt's proposal block nonce; default
//                      "fake generated text"), e.g. a New project proposal.
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
//   FAKE_CLAUDE_SLOW_REPLY_LAST=1 slow mode adds no closing "reply to:" text
//                      after the scripted reply unless a steer was folded in.
//   FAKE_CLAUDE_HOLD_MARKER / FAKE_CLAUDE_HOLD_GATE a turn whose prompt contains
//                      the marker waits until the gate file exists, then plays
//                      normally, scripted reply included; FAKE_CLAUDE_HOLD_SEEN
//                      gets the held child's pid, so a test knows it is held.
//   FAKE_CLAUDE_REPLY_GATE_STEERS With the gate: also wait until this many
//                      mid-turn steers have been read, so a gate opened right
//                      after a steer was acknowledged cannot be seen first
//                      (timers run before pipe reads in the event loop).
//   FAKE_CLAUDE_DUMP_LOG path that gets one JSON line per turn: the MCP
//                      server names it was handed and the agents server's
//                      bot, thread, depth and skill-authoring switch, plus
//                      the prompt text, so a test can tell turns apart.
//   FAKE_CLAUDE_MENTION_MARKER / FAKE_CLAUDE_MENTION_REPLY a turn whose prompt
//                      contains the marker answers the reply text (a room
//                      reply that @mentions teammates).
//   FAKE_CLAUDE_AUTH   in (default) | out | unsupported | malformed |
//                      inherited-api-key — what `auth status` reports
//   FAKE_CLAUDE_AUTH_METHOD the signed-in `authMethod` (default claude.ai); "omit" leaves the field out
//   FAKE_CLAUDE_VERSION what `--version` prints before " (Claude Code)" (default 2.1.295)
//   FAKE_CLAUDE_ONE_SHOT_FAIL after-init — a one-shot helper starts (`init`), then exits 1 with a
//                      stderr line quoting a launch-flag refusal
//   FAKE_CLAUDE_REFUSE unknown-option | managed-mcp — the CLI refuses Murage's launch flags, on a
//                      turn and on the flagged auth probe alike
//   FAKE_CLAUDE_SIGTERM_DELAY_MS a CLI that takes this long to close after
//                      SIGTERM (the real CLI tears down MCP children and
//                      flushes before exiting). The turn's writer lease is
//                      released only at that close, so a test can stand
//                      inside the Stop → close window deterministically.
//
//   FAKE_CLAUDE_IGNORE_TERM=1 a wedged CLI: ignores SIGTERM and stdin EOF,
//                      so only SIGKILL of its tree ends it.
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
//   Every successful turn's total_cost_usd is the process's running total
//   (0.01 per turn), the way the real CLI reports it: read the latest, never
//   sum. Its modelUsage is the same running count per model.
//   FAKE_CLAUDE_COST_STATE dir: the real CLI restores a session's running
//                      cost on --resume, so a resumed process's first total
//                      already counts the earlier turns. The fake saves its
//                      running cost per session id here, and a --resume
//                      launch starts from it.
//   FAKE_CLAUDE_RESUMED_API_ERROR 1: a --resume launch plays its first turn
//                      the `api-error` way (an error result with no cost
//                      figure) and its later turns normally.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { fixtureDumpEnvironment } from "./fixture-dump.ts";
import { fakeReviewReply } from "./fake-review.ts";
import { callFirstCustomTool, claudeMcpLaunch, customToolReply, customToolServer, lostServerEnv } from "./fake-custom-tool.ts";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

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

// The real CLI reads --mcp-config once, at start, and keeps its servers for
// the life of the process. The driver deletes the file once the CLI is
// running, so a warm process's later turn must not go back to disk for it.
const startupMcpConfig: unknown = (() => {
  const path = argAfter("--mcp-config");
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
})();

// Claude Code's own "/" commands, as 2.1.x reports them: names on every
// `init` (`slash_commands`, with the terminal-bound subset in
// `terminal_slash_commands`), descriptions in the answer to the SDK's
// `initialize` control request. Off unless FAKE_CLAUDE_COMMANDS is set ("1"
// for this set, or a JSON array of its own), so the exact event sequences
// the older tests pin stay as they were.
const FAKE_COMMANDS: Array<{ name: string; description: string; argumentHint: string }> = !process.env.FAKE_CLAUDE_COMMANDS
  ? []
  : process.env.FAKE_CLAUDE_COMMANDS !== "1"
  ? JSON.parse(process.env.FAKE_CLAUDE_COMMANDS)
  : [
      { name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "<optional custom summarization instructions>" },
      { name: "context", description: "Show current context usage", argumentHint: "" },
      { name: "review", description: "Review a pull request", argumentHint: "" },
      { name: "statusline", description: "Set up Claude Code's status line UI", argumentHint: "" },
      { name: "clear", description: "Clear conversation history and free up context", argumentHint: "" },
    ];
const FAKE_TERMINAL_COMMANDS = ["statusline"];
const out = (obj: unknown) => {
  const frame = obj as { type?: string; subtype?: string };
  const decorated = FAKE_COMMANDS.length && frame?.type === "system" && frame.subtype === "init"
    ? { ...frame, slash_commands: FAKE_COMMANDS.map((command) => command.name), terminal_slash_commands: FAKE_TERMINAL_COMMANDS }
    : obj;
  process.stdout.write(JSON.stringify(decorated) + "\n");
};
// Mirrors ENGINE_FRAME_MAX_BYTES in server/drivers/bounded-lines.ts. "é" is
// two UTF-8 bytes: the oversize text alone is one KiB over the limit, and the
// large text is 14 MiB, the size of a 10 MiB image as base64.
const FIXTURE_FRAME_LIMIT = 32 * 1024 * 1024;
const fixtureOversizeText = () => "é".repeat(FIXTURE_FRAME_LIMIT / 2 + 512);
const fixtureLargeText = () => "é".repeat(7 * 1024 * 1024);
// 1x1 rasters for the MCP tool-result image fixture: one from a custom
// server (a deliverable), one from Murage's own computer surface (not).
const FIXTURE_TOOL_IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const FIXTURE_SCREEN_IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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

// What a real CLI prints when it refuses the isolation flags (rig, 2.1.281 and 2.1.295: stderr, exit 1).
function refuseLaunchFlags(): void {
  if (process.env.FAKE_CLAUDE_REFUSE === "unknown-option") {
    process.stderr.write("error: unknown option '--strict-mcp-config'\n");
    process.exit(1);
  }
  if (process.env.FAKE_CLAUDE_REFUSE === "managed-mcp") {
    process.stderr.write("You cannot use --strict-mcp-config when an enterprise MCP config is present\n");
    process.exit(1);
  }
}

// FAKE_CLAUDE_PROBE_LOG: one JSON line per probe (--version, auth status) with the pinned names it was handed, and only those: never
// the whole inherited environment, which holds the owner's credentials (fixture-dump.test.ts). A name the probe was not handed is absent.
const PROBE_LOG_NAMES = ["BASH_ENV", "CLAUDE_ENV_FILE", "GIT_EDITOR", "GIT_SSH", "PAGER"] as const;
if (process.env.FAKE_CLAUDE_PROBE_LOG && (argv[0] === "--version" || (argv.includes("auth") && argv[argv.indexOf("auth") + 1] === "status"))) {
  const pinned = Object.fromEntries(PROBE_LOG_NAMES.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  appendFileSync(process.env.FAKE_CLAUDE_PROBE_LOG, JSON.stringify({ probe: argv[0] === "--version" ? "version" : "auth", env: pinned }) + "\n");
}

// Snapshot probes: both answer on argv alone and exit without reading stdin.
if (argv[0] === "--version") {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.295"} (Claude Code)\n`);
  process.exit(0);
}

// The auth probe carries the isolation flags a turn gets, ahead of the subcommand.
const authAt = argv.indexOf("auth");
if (authAt > 0 && argv[authAt + 1] === "status") {
  if (process.env.FAKE_CLAUDE_AUTH_ARGV) writeFileSync(process.env.FAKE_CLAUDE_AUTH_ARGV, JSON.stringify(argv.slice(0, authAt)));
  // A CLI that refuses the flags refuses them ahead of `auth` too (rig, 2.1.281 and 2.1.295:
  // `claude --no-such-flag auth status --json` prints the commander error on stderr, exit 1).
  refuseLaunchFlags();
  argv.splice(0, authAt);
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
    JSON.stringify({ loggedIn, ...(process.env.FAKE_CLAUDE_AUTH_METHOD === "omit" ? {} : { authMethod: loggedIn ? process.env.FAKE_CLAUDE_AUTH_METHOD ?? "claude.ai" : "none" }), apiProvider: "firstParty" }) + "\n",
    () => process.exit(auth === "out" ? 1 : 0),
  );
}

refuseLaunchFlags();

// One-shot helper mode used by generateText/reviewPermission. The prompt is
// deliberately read from stdin so sensitive review text never appears in
// argv or process listings.
// Helpers ask for stream-json (init, then one result frame); text is the older shape.
if (argAfter("--output-format") === "text" || (argv.includes("-p") && argAfter("--input-format") === null && !argv.includes("--json-schema"))) {
  const prompt = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
  if (process.env.FAKE_CLAUDE_DUMP) {
    writeFileSync(
      process.env.FAKE_CLAUDE_DUMP,
      JSON.stringify({ pid: process.pid, argv, env: fixtureDumpEnvironment(), prompt, mcpConfig: null, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()) }, null, 2),
    );
  }
  if (process.env.FAKE_CLAUDE_REVIEW_LOG) appendFileSync(process.env.FAKE_CLAUDE_REVIEW_LOG, "one-shot\n");
  // {{PROPOSAL_NONCE}}: the New project proposal block's nonce, read from the prompt as a model does
  const nonce = /<murage-project-proposal nonce="([a-f0-9]{32})">/.exec(prompt)?.[1] ?? "";
  const answer = (process.env.FAKE_CLAUDE_ONE_SHOT_TEXT ?? "fake generated text").replaceAll("{{PROPOSAL_NONCE}}", nonce);
  if (argAfter("--output-format") !== "stream-json") {
    process.stdout.write(`${answer}\n`);
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "one-shot", tools: [], mcp_servers: [] }) + "\n");
  // FAKE_CLAUDE_ONE_SHOT_FAIL=after-init: the CLI started, then a later diagnostic happens to quote
  // a launch-flag refusal before a nonzero exit (that is not a refusal of Murage's flags)
  if (process.env.FAKE_CLAUDE_ONE_SHOT_FAIL === "after-init") {
    process.stderr.write("error: unknown option '--settings'\n", () => process.exit(1));
    await new Promise(() => {});
  }
  // FAKE_CLAUDE_ONE_SHOT_ERROR: the one-shot ends in an error result with this text (a usage limit, a signed-out login)
  if (process.env.FAKE_CLAUDE_ONE_SHOT_ERROR) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: process.env.FAKE_CLAUDE_ONE_SHOT_ERROR }) + "\n", () => process.exit(1));
    await new Promise(() => {});
  }
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer }) + "\n", () => process.exit(0));
  await new Promise(() => {});
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

// FAKE_CLAUDE_LAUNCH_WRITE (+ FAKE_CLAUDE_LAUNCH_WRITE_TEXT): every launch writes this text to this file first, the way a
// settings change can land between a launch and its relaunch.
if (process.env.FAKE_CLAUDE_LAUNCH_WRITE) writeFileSync(process.env.FAKE_CLAUDE_LAUNCH_WRITE, process.env.FAKE_CLAUDE_LAUNCH_WRITE_TEXT ?? "");

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
// `final-steer`: the turn's final answer is being written. Input that arrives
// now is not read by it; Claude Code (2.1.309, probed on a real sign-in)
// answers it in a turn of its own, started with `init` right after `result`,
// with every message queued by then joined into that one turn.
let foldOpen = true;
let followUpTurn = false;
const queuedPrompts: JsonValue[] = [];
// the running cost behind total_cost_usd and modelUsage; a --resume launch
// starts from the session's saved one (FAKE_CLAUDE_COST_STATE)
type FakeModelUsage = { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number };
const costStateFile = process.env.FAKE_CLAUDE_COST_STATE ? join(process.env.FAKE_CLAUDE_COST_STATE, `${sessionId}.json`) : null;
const runningCost: { total: number; modelUsage: Record<string, FakeModelUsage> } = (() => {
  if (costStateFile && process.argv.includes("--resume")) {
    try {
      return JSON.parse(readFileSync(costStateFile, "utf8"));
    } catch {}
  }
  return { total: 0, modelUsage: {} };
})();
let resumedErrorPlayed = false;
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
  // `content` is a bare string for a text-only turn and an array of content
  // blocks once the turn carries images. Fixtures keyed on the prompt text
  // must still find it in the second shape.
  if (typeof m?.content === "string") return m.content;
  if (Array.isArray(m?.content)) {
    return (m.content as Array<{ type?: unknown; text?: unknown }>)
      .filter(block => block?.type === "text" && typeof block.text === "string")
      .map(block => block.text as string)
      .join("\n");
  }
  return "";
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
  const config = (startupMcpConfig ?? JSON.parse(readFileSync(configPath, "utf8"))) as { mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> };
  const mounted = config.mcpServers?.[match[1]!];
  if (!mounted) return Promise.resolve(null);
  // FAKE_CLAUDE_PERM_SOCKET: the proxy is handed a broker path nothing listens on (a broker outage, or a path the
  // launcher's shell mangled on the way, as Git Bash did to the Windows pipe in 1.0.3).
  const lostBroker = process.env.FAKE_CLAUDE_PERM_SOCKET;
  const server = lostBroker && mounted.args?.length ? { ...mounted, args: [...mounted.args.slice(0, -1), lostBroker] } : mounted;
  return new Promise((resolve, reject) => {
    // started as the real CLI starts it: through CLAUDE_CODE_SHELL_PREFIX when one is set (claudeMcpLaunch)
    const launch = claudeMcpLaunch({ command: server.command, args: server.args ?? [], env: server.env ?? {} });
    const child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ["pipe", "pipe", "pipe"] });
    let buffered = "";
    let stderr = "";
    let answered = false;
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", reject);
    // The server must answer `initialize` promptly; a tool call after that may wait on a person for as long as it likes.
    // One that never answers fails the call with the reason, instead of holding the turn until the suite's own timeout.
    const startDeadline = setTimeout(() => {
      if (answered) return;
      answered = true;
      child.kill();
      reject(new Error(`the ${match[1]} server did not answer initialize within ${Number(process.env.FAKE_CLAUDE_MCP_START_MS) || 30_000} ms${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    }, Number(process.env.FAKE_CLAUDE_MCP_START_MS) || 30_000);
    startDeadline.unref();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    // A server that exits before answering fails the call, as the real CLI reports a server that did not come up:
    // the turn ends with the reason instead of waiting on a reply that cannot come.
    child.on("exit", (code, signal) => {
      if (!answered) reject(new Error(`the ${match[1]} server exited before answering (${signal ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
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
          clearTimeout(startDeadline);
          // what the real CLI reports when the server's own env was lost on the way (1.0.3: no MCP server came up)
          const lost = lostServerEnv(child.pid, server.env ?? {});
          if (lost.length) {
            answered = true;
            child.kill();
            process.stderr.write(`Error: MCP tool ${promptTool} not found. Available MCP tools: none (the ${match[1]} server lost ${lost.join(", ")})\n`, () => process.exit(1));
            return;
          }
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: match[2], arguments: args } });
        } else if (message.id === 2) {
          answered = true;
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

/** `__fixture_permission_tool__`: ask the permission prompt tool about one
 * ordinary tool call (FAKE_CLAUDE_PERM_TOOL / FAKE_CLAUDE_PERM_INPUT), the
 * way the CLI does for anything its permission mode does not cover, and say
 * what came back. Without a prompt tool the CLI would just run it (bypass). */
const playPermissionTool = async (): Promise<void> => {
  const tool = process.env.FAKE_CLAUDE_PERM_TOOL ?? "Bash";
  const input = process.env.FAKE_CLAUDE_PERM_INPUT ? (JSON.parse(process.env.FAKE_CLAUDE_PERM_INPUT) as Record<string, unknown>) : { command: ["rm", "-rf", "~/Documents"].join(" ") };
  const toolUseId = `toolu_fake_perm_${process.pid}_${Date.now()}`;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: tool, input }] } });
  let verdict = "ran without asking";
  // the real CLI puts a deny's message in the tool result, as the model reads it
  let resultText = verdict;
  try {
    const reply = await callPermissionPromptTool({ tool_name: tool, input, tool_use_id: toolUseId });
    if (reply !== null) {
      const decision = JSON.parse(reply) as { behavior?: string; message?: string };
      verdict = decision.behavior === "allow" ? "allowed" : "denied";
      resultText = verdict === "denied" && decision.message ? decision.message : verdict;
    }
  } catch (error) {
    verdict = `failed: ${error instanceof Error ? error.message : String(error)}`;
    resultText = verdict;
  }
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: verdict !== "allowed" && verdict !== "ran without asking", content: resultText }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: `permission: ${verdict}` }] } });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  turnRunning = false;
  finishIfDone();
};

/** The custom-tool mode's turn: tool_use, the call through the mounted server,
 * its tool_result, then the reply. */
const playCustomTool = async (name: string, prompt: JsonValue): Promise<void> => {
  const configPath = argAfter("--mcp-config");
  let server: { command: string; args?: string[]; env?: Record<string, string> } | undefined;
  // A real CLI reads its MCP config once at start; a warm process keeps serving
  // after the driver removes the temp file, so prefer the copy read at startup.
  try {
    server = (startupMcpConfig as { mcpServers?: Record<string, typeof server> } | null)?.mcpServers?.[name]
      ?? (configPath ? (JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, typeof server> }).mcpServers?.[name] : undefined);
  } catch {
    server = undefined;
  }
  const toolUseId = `toolu_fake_custom_${process.pid}_${Date.now()}`;
  const outcome = server
    ? await callFirstCustomTool("claude", name, { command: server.command, args: server.args ?? [], env: server.env ?? {} }, promptText(prompt),
      claudeMcpLaunch({ command: server.command, args: server.args ?? [], env: server.env ?? {} }))
    : { tools: [], text: `no ${name} server was mounted`, isError: true };
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: `mcp__${name}__${outcome.tool ?? "unknown"}`, input: {} }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: outcome.isError, content: outcome.text }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: customToolReply(outcome) }] } });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  turnRunning = false;
  finishIfDone();
};

/** `__fixture_background__`: the CLI's real shape when it runs subagents as
 * background tasks (native.ndjson of the 2026-10-02 "turn ended" report):
 * background_tasks_changed + task_started per task, an ordinary `result`
 * while they still run (subagent_stats.started_in_background > 0), the
 * subagents' own permission asks after it, then per-task task_updated +
 * task_notification + background_tasks_changed and a synthetic follow-up turn
 * (init, assistant text, `result` with origin task-notification).
 *   FAKE_CLAUDE_BG_TASKS  number of tasks (default 3)
 *   FAKE_CLAUDE_BG_ASKS   asks the subagents raise after the first result (default 2)
 *   FAKE_CLAUDE_BG_HOLD   "1": the tasks never finish (Stop and cap tests)
 *   FAKE_CLAUDE_BG_LOG    file that gets one line per ask verdict and per finish
 *   FAKE_CLAUDE_BG_STAGGER_DIR  rendered-proof mode: each helper has its own label and
 *                       reports task_progress (2, 4, 6 tools); helper N then finishes only
 *                       when the file `finish-N` (1-based) appears in this folder (it is consumed), so
 *                       they end at different times, as real ones do. No tool asks. */
const playBackground = async (): Promise<void> => {
  const count = Number(process.env.FAKE_CLAUDE_BG_TASKS ?? "3");
  const askCount = Number(process.env.FAKE_CLAUDE_BG_ASKS ?? (process.env.FAKE_CLAUDE_BG_STAGGER_DIR ? "0" : "2"));
  const log = (line: string) => {
    if (process.env.FAKE_CLAUDE_BG_LOG) appendFileSync(process.env.FAKE_CLAUDE_BG_LOG, `${line}\n`);
  };
  const ids = Array.from({ length: count }, (_, i) => `bgtask${i + 1}`);
  const helperLabels = ["Check the billing logs", "Read the onboarding docs", "Compare the pricing pages"];
  const labelOf = (id: string) => (process.env.FAKE_CLAUDE_BG_STAGGER_DIR ? helperLabels[ids.indexOf(id) % helperLabels.length]! : `Helper ${id}`);
  const live = new Set<string>();
  const changed = () => out({ type: "system", subtype: "background_tasks_changed", tasks: [...live].map((id) => ({ task_id: id, task_type: "local_agent", description: labelOf(id) })) });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Three helpers are reading." }] } });
  for (const id of ids) {
    live.add(id);
    changed();
    out({ type: "system", subtype: "task_started", task_id: id, tool_use_id: `toolu_${id}`, description: labelOf(id), subagent_type: "Explore", is_backgrounded: true, spawn_depth: 1, task_type: "local_agent" });
  }
  out({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", terminal_reason: "completed", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 },
    subagent_stats: { spawned: count, started_in_background: count, completed: 0, failed: 0 } });
  for (let i = 0; i < askCount; i += 1) {
    const toolUseId = `toolu_fake_bg_${process.pid}_${i}`;
    out({ type: "system", subtype: "task_progress", task_id: ids[0], tool_use_id: `toolu_${ids[0]}`, description: "Reading", usage: { total_tokens: 10, tool_uses: i + 1, duration_ms: 5 }, last_tool_name: "Read" });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: "Read", input: { file_path: `/outside/cwd/file-${i}.md` } }] } });
    let verdict = "ran without asking";
    try {
      const reply = await callPermissionPromptTool({ tool_name: "Read", input: { file_path: `/outside/cwd/file-${i}.md` }, tool_use_id: toolUseId });
      if (reply !== null) {
        const decision = JSON.parse(reply) as { behavior?: string; message?: string };
        verdict = decision.behavior === "allow" ? "allowed" : `denied: ${decision.message ?? ""}`;
      }
    } catch (error) {
      verdict = `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    log(`verdict:${verdict}`);
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: !verdict.startsWith("allowed") && verdict !== "ran without asking", content: verdict }] } });
  }
  const staggerDir = process.env.FAKE_CLAUDE_BG_STAGGER_DIR;
  if (staggerDir) {
    ids.forEach((id, i) => out({ type: "system", subtype: "task_progress", task_id: id, tool_use_id: `toolu_${id}`, description: labelOf(id), usage: { total_tokens: 100 * (i + 1), tool_uses: 2 * (i + 1), duration_ms: 50 }, last_tool_name: "Read" }));
  }
  if (process.env.FAKE_CLAUDE_BG_HOLD === "1") {
    log("held");
    return;
  }
  for (const [index, id] of ids.entries()) {
    if (staggerDir) {
      while (!existsSync(join(staggerDir, `finish-${index + 1}`))) await new Promise((resolve) => setTimeout(resolve, 40));
      unlinkSync(join(staggerDir, `finish-${index + 1}`)); // consumed, so the next run waits again
      log(`finish:${id}`);
    }
    live.delete(id);
    changed();
    out({ type: "system", subtype: "task_updated", task_id: id, patch: { status: "completed", end_time: Date.now() } });
    out({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: `toolu_${id}`, status: "completed", output_file: "", summary: `Helper ${id} done` });
  }
  out({ type: "system", subtype: "init", session_id: "fake-bg-session", cwd: process.cwd(), tools: [], model: "fake" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "All helpers reported." }] } });
  out({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", terminal_reason: "completed", total_cost_usd: 0, origin: { kind: "task-notification", producer: "session-task" },
    usage: { input_tokens: 1, output_tokens: 1 }, subagent_stats: { spawned: count, started_in_background: count, completed: count, failed: 0 } });
  log("finished");
  turnRunning = false;
  finishIfDone();
};

let exitGateTimer: ReturnType<typeof setInterval> | undefined;
// FAKE_CLAUDE_FOLLOWUP_DELAY_MS: the follow-up starts this long after `result`
// (input arriving meanwhile joins it); FAKE_CLAUDE_FOLLOWUP_NOTICE=1: a
// background task's synthetic result comes first.
let followUpTimer: ReturnType<typeof setTimeout> | undefined;
const finishIfDone = () => {
  if (!turnRunning && queuedPrompts.length) {
    if (followUpTimer) return;
    const startFollowUp = () => {
      followUpTimer = undefined;
      // every message queued by now becomes one follow-up turn, joined (as the real CLI does)
      followUpTurn = true;
      const joined = queuedPrompts.splice(0).map((queued) => promptText(queued)).join("\n");
      playTurn({ type: "user", message: { role: "user", content: joined } });
    };
    if (process.env.FAKE_CLAUDE_FOLLOWUP_NOTICE === "1") {
      out({ type: "result", subtype: "success", is_error: false, origin: { kind: "task-notification" }, result: "background task done",
        usage: { input_tokens: 1, output_tokens: 1 } });
    }
    const delay = Number(process.env.FAKE_CLAUDE_FOLLOWUP_DELAY_MS) || 0;
    if (delay > 0) followUpTimer = setTimeout(startFollowUp, delay);
    else startFollowUp();
    return;
  }
  if (!stdinEnded || turnRunning || followUpTimer) return;
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

/** The credential file the driver wired into the mcp config, read as the
 * engine's MCP proxies would read it at this moment (per turn). */
let credPath: string | null = null;
let firstMcpConfig: unknown = null;
let firstSystemPrompt: string | null = null;
const readCredFile = (): { path: string | null; content: unknown } => {
  const configPath = argAfter("--mcp-config");
  try {
    if (!credPath) {
      // the mcp config is deleted when the first turn settles; the path is kept
      const servers = configPath ? (JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, { env?: Record<string, string> }> }).mcpServers ?? {} : {};
      credPath = Object.values(servers).map((server) => server.env?.MURAGE_CRED_FILE).find(Boolean) ?? null;
    }
  } catch { /* no config to read */ }
  try { return { path: credPath, content: credPath ? JSON.parse(readFileSync(credPath, "utf8")) : null }; } catch { return { path: credPath, content: "unreadable" }; }
};
/** The provider turn the server wrote into this turn's credential file (MURAGE_TURN_ID beside the agents token). */
const credTurnId = (): string | null => {
  const content = readCredFile().content as { agents?: { MURAGE_TURN_ID?: unknown } } | null;
  return typeof content?.agents?.MURAGE_TURN_ID === "string" ? content.agents.MURAGE_TURN_ID : null;
};

let elicitSent = false;
const elicitWaiting = new Set<string>();
let elicitResume: (() => void) | null = null;
const playTurn = (prompt: JsonValue) => {
  turnRunning = true;
  steered = [];
  foldOpen = true;
  if ((!dumped || process.env.FAKE_CLAUDE_DUMP_EACH_TURN === "1") && process.env.FAKE_CLAUDE_DUMP) {
    dumped = true;
    const configPath = argAfter("--mcp-config");
    let mcpConfig: unknown = null;
    if (configPath) {
      try {
        mcpConfig = JSON.parse(readFileSync(configPath, "utf8"));
        firstMcpConfig ??= mcpConfig;
      } catch {
        // a warm process's later turn: the driver deleted the file after the
        // first turn, and the process still runs on what it read then
        mcpConfig = firstMcpConfig;
      }
    }
    const systemPromptPath = argAfter("--append-system-prompt-file");
    let systemPrompt: string | null = null;
    if (systemPromptPath) {
      try {
        systemPrompt = readFileSync(systemPromptPath, "utf8");
        firstSystemPrompt ??= systemPrompt;
      } catch {
        // a warm process's later turn: the driver removed the file after launch, and the process still runs on the prompt it
        // read then (as the real CLI does); a process that never read it leaves null, which the test will see
        systemPrompt = firstSystemPrompt;
      }
    }
    let procedureProbe: {cwd:string;explicit:string|null;native:string|null}|undefined;
    if (JSON.stringify(prompt).includes("__fixture_procedure_probe__")) {
      const encoded = /^- pinned-fixture: .* Read (".*")\.$/m.exec(systemPrompt ?? "")?.[1];
      const read = (path:string) => { try { return readFileSync(path,"utf8"); } catch { return null; } };
      procedureProbe = {cwd:process.cwd(),explicit:encoded?read(JSON.parse(encoded)):null,native:read(join(process.cwd(),".agents","skills","pinned-fixture","SKILL.md"))};
    }
    // every --settings file as the CLI read it at start (the driver removes its private overlay when the process ends)
    const settingsFiles = argv.flatMap((arg, i) => (arg === "--settings" && argv[i + 1] ? [argv[i + 1]!] : [])).map((path) => { try { return JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { return null; } });
    const dump = { pid: process.pid, argv, env: fixtureDumpEnvironment(), prompt, systemPrompt, mcpConfig, settingsFiles, credFile: readCredFile(), promptWallMs: Date.now(), cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), ...(procedureProbe?{procedureProbe}:{}), ...(process.env.FAKE_CLAUDE_MCP_READY_MS ? { mcpAtPrompt: mcpStates(), promptAtMs: Date.now() - mcpStartedAt } : {}) };
    writeFileSync(process.env.FAKE_CLAUDE_DUMP, JSON.stringify(dump, null, 2));
    // FAKE_CLAUDE_DUMP_HISTORY: the same dump as one line per dumped turn, so a spec waits for its own turn even when a later
    // turn (another bot's, or a redispatch) has already replaced the single latest-turn file
    if (process.env.FAKE_CLAUDE_DUMP_HISTORY) appendFileSync(process.env.FAKE_CLAUDE_DUMP_HISTORY, `${JSON.stringify(dump)}\n`);
  }

  if (process.env.FAKE_CLAUDE_DUMP_LOG) {
    let servers: Record<string, { env?: Record<string, string> }> = {};
    const configPath = argAfter("--mcp-config");
    try { servers = configPath ? (JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: typeof servers }).mcpServers ?? {} : {}; } catch { /* none */ }
    const agents = servers.agents?.env ?? {};
    appendFileSync(process.env.FAKE_CLAUDE_DUMP_LOG, `${JSON.stringify({
      servers: Object.keys(servers).sort(), botId: agents.MURAGE_BOT_ID ?? null, threadId: agents.MURAGE_THREAD_ID ?? null,
      depth: agents.MURAGE_TURN_DEPTH ?? null, skillAuthoring: agents.MURAGE_SKILL_AUTHORING_ENABLED ?? null, prompt: promptText(prompt), credFile: readCredFile(),
      turnId: credTurnId(),
    })}\n`);
  }

  // FAKE_CLAUDE_ELICIT: the host is asked first, and the turn waits for every answer.
  if (process.env.FAKE_CLAUDE_ELICIT && !elicitSent) {
    elicitSent = true;
    const requests = JSON.parse(process.env.FAKE_CLAUDE_ELICIT) as Array<Record<string, unknown>>;
    requests.forEach((request, index) => {
      const id = `cli-ctl-${index + 1}`;
      elicitWaiting.add(id);
      out({ type: "control_request", request_id: id, request });
    });
    if (process.env.FAKE_CLAUDE_ELICIT_WITHDRAW === "1" && requests.length) {
      elicitWaiting.delete("cli-ctl-1");
      out({ type: "control_cancel_request", request_id: "cli-ctl-1" });
    }
    elicitResume = () => playTurn(prompt);
    if (elicitWaiting.size === 0) { const resume = elicitResume; elicitResume = null; setTimeout(resume, 50); }
    return;
  }

  // A turn whose prompt carries FAKE_CLAUDE_HOLD_MARKER waits for
  // FAKE_CLAUDE_HOLD_GATE, then plays as usual (its scripted reply included).
  const holdMarker = process.env.FAKE_CLAUDE_HOLD_MARKER, holdGate = process.env.FAKE_CLAUDE_HOLD_GATE;
  if (holdMarker && holdGate && promptText(prompt).includes(holdMarker) && !existsSync(holdGate)) {
    if (process.env.FAKE_CLAUDE_HOLD_SEEN) appendFileSync(process.env.FAKE_CLAUDE_HOLD_SEEN, `${process.pid}\n`);
    const timer = setInterval(() => { if (!existsSync(holdGate)) return; clearInterval(timer); playTurn(prompt); }, 10);
    return;
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
  // An MCP tool answering with an image. The Claude CLI rewrites MCP image
  // content into Anthropic Messages shape before a driver sees it; the
  // computer surface's frame rides along to prove it is not retained.
  if (fixtureRequested(promptText(prompt), "__fixture_mcp_tool_image__")) {
    out({ type: "system", subtype: "init", session_id: sessionId, model });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-mcp", name: "mcp__omarchy__screenshot" }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-mcp", is_error: false, content: [
      { type: "text", text: "captured" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: FIXTURE_TOOL_IMAGE } },
    ] }] } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu-screen", name: "mcp__computer__screenshot" }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-screen", is_error: false, content: [
      { type: "image", data: FIXTURE_SCREEN_IMAGE, mimeType: "image/png" },
    ] }] } });
    out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
    turnRunning = false;
    finishIfDone();
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

  // FAKE_CUSTOM_TOOL_SERVER (fake-custom-tool.ts): every turn calls the first
  // tool of that owner server, started from --mcp-config as the CLI would.
  const customServer = customToolServer(promptText(prompt));
  if (customServer) {
    void playCustomTool(customServer, prompt);
    return;
  }

  // A local command (/context) answers in `result` alone, with no assistant
  // message: print mode returns the command's resultText there.
  if (promptText(prompt).trim() === "/context") {
    out({ type: "result", subtype: "success", is_error: false, result: "FAKE_CONTEXT 12k of 200k tokens used", stop_reason: null, total_cost_usd: 0, session_id: sessionId });
    turnRunning = false;
    finishIfDone();
    return;
  }

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
  // B11 ordinary request: consume the actual appended system destination,
  // including resumed CLI sessions. No implicit outputs/ fallback.
  const destinationRequest = [...promptText(prompt).matchAll(/Create HTML, MD and TXT files named (b11-[a-z0-9-]+)/g)].at(-1);
  if (destinationRequest) {
    const systemFile = argAfter("--append-system-prompt-file");
    const system = systemFile ? readFileSync(systemFile, "utf8") : "";
    const encoded = /^Murage file destination: (.+)$/m.exec(system)?.[1];
    if (!encoded) throw new Error("Fixture did not receive a file destination");
    const destination: string = JSON.parse(encoded);
    // The launcher makes HOME equal to its task-owned fixture. Never let
    // this fixture instruction name any real profile or arbitrary folder.
    const fixtureRoot = process.env.MURAGE_DATA_DIR;
    if (!fixtureRoot || !destination.startsWith(realpathSync.native(fixtureRoot) + sep)) throw new Error("Fixture destination is outside its isolated data");
    mkdirSync(destination, { recursive: true });
    for (const [extension, contents] of [["html", "<!doctype html><h1>B11</h1>"], ["md", "# B11\n"], ["txt", "B11 text\n"]]) {
      writeFileSync(join(destination, `${destinationRequest[1]}.${extension}`), contents);
    }
    appendFileSync(join(fixtureRoot, "b11-destinations.jsonl"), JSON.stringify({ destination, cwd: process.cwd(), resumed: Boolean(argAfter("--resume")), name: destinationRequest[1] }) + "\n");
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
  if ((mode === "hang" && !finishNow) || fixtureRequested(promptText(prompt), "__fixture_hold_authority__")) {
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
      // Gate release models a completed reply. An empty result deliberately
      // exercises the product's empty-turn error and cannot model settlement.
      out({ type: "assistant", message: { content: [{ type: "text", text: "Fixture turn finished." }] } });
      out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
      turnRunning = false;
      finishIfDone();
    }, gate ? 10 : 1_000);
    return;
  }

  if (mode === "ask-user-question" || fixtureRequested(promptText(prompt), "__fixture_ask_user_question__")) {
    void playAskUserQuestion();
    return;
  }

  if (fixtureRequested(promptText(prompt), "__fixture_background__")) {
    void playBackground();
    return;
  }

  if (fixtureRequested(promptText(prompt), "__fixture_permission_tool__")) {
    void playPermissionTool();
    return;
  }

  // `__fixture_spawn_child__`: the CLI leaves a child process of its own
  // running past the turn (a dev server a Bash call started). The test reads its
  // pid from FAKE_CLAUDE_CHILD_PID and the child dies with this process.
  if (promptText(prompt).includes("__fixture_spawn_child__")) {
    // A real tool starts a model round trip after init. Give the driver time to
    // take its init-time snapshot first (init is already on the pipe).
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    const kid = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    if (process.env.FAKE_CLAUDE_CHILD_PID && kid.pid) writeFileSync(process.env.FAKE_CLAUDE_CHILD_PID, String(kid.pid));
    process.on("exit", () => { try { kid.kill("SIGKILL"); } catch { /* already gone */ } });
  }
  // `__fixture_shell_task__`: a background shell task is still running when the
  // turn's result arrives, and nothing ever reports it done.
  if (promptText(prompt).includes("__fixture_shell_task__")) {
    out({ type: "system", subtype: "task_started", task_id: "shell1", tool_use_id: "toolu_shell1", description: "npm run dev", task_type: "local_bash" });
  }

  if (mode === "malformed") {
    process.stdout.write("this is not json\n{broken\n");
  }

  // Upstream signed-out protocol capture; the success-result variant ensures
  // a flagged auth failure cannot be mislabeled as successful completion.
  if (mode === "org-login-off") {
    out({ type: "assistant", error: "api_error", is_api_error_message: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: "Your organization has disabled subscription access for Claude Code. (oauth_org_not_allowed)" }] } });
    out({ type: "result", is_error: true, stop_reason: "stop_sequence", terminal_reason: "api_error" });
    turnRunning = false; finishIfDone(); return;
  }
  if (mode === "not-logged-in" || mode === "not-logged-in-success-result") {
    out({ type: "assistant", error: "authentication_failed", is_api_error_message: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
    out({ type: "result", is_error: mode === "not-logged-in", stop_reason: "stop_sequence", terminal_reason: "api_error" });
    turnRunning = false; finishIfDone(); return;
  }

  // A model newer than this install: the API refuses it and the CLI relays
  // the refusal as an api-error frame (upstream #1840 capture).
  // The same refusal from a build that exits without a result frame.
  if (mode === "api-error-exit") {
    out({ type: "assistant", is_api_error_message: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: process.env.FAKE_CLAUDE_API_ERROR ?? "API Error: 400 fixture" }] } });
    setTimeout(() => process.exit(1), 20);
    return;
  }
  const resumedError = process.env.FAKE_CLAUDE_RESUMED_API_ERROR === "1" && process.argv.includes("--resume") && !resumedErrorPlayed;
  if (resumedError) resumedErrorPlayed = true;
  if (mode === "api-error" || resumedError) {
    out({ type: "assistant", is_api_error_message: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: process.env.FAKE_CLAUDE_API_ERROR ?? "API Error: 400 fixture" }] } });
    out({ type: "result", is_error: true, stop_reason: "stop_sequence", terminal_reason: "api_error" });
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

  // lane review: a review run answers with its verdict (fake-review.ts)
  const reviewText = fakeReviewReply(promptText(prompt));
  const mentionMarker = process.env.FAKE_CLAUDE_MENTION_MARKER;
  const mentionReply = mentionMarker && process.env.FAKE_CLAUDE_MENTION_REPLY && promptText(prompt).includes(mentionMarker) ? process.env.FAKE_CLAUDE_MENTION_REPLY : null;
  const replyParts = reviewText !== null ? [reviewText] : mentionReply !== null ? [mentionReply] : nextScriptedReply();
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
  if (mode === "tool-heartbeat") {
    // Upstream #3328: Claude Code sends this every 30 s while a tool runs.
    out({ type: "tool_progress", tool_use_id: "tu-1-heartbeat-0", tool_name: "Bash",
      parent_tool_use_id: "tu-1", elapsed_time_seconds: 30, heartbeat: true });
  }
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: false }] } });

  const finish = () => {
    runningCost.total = Number((runningCost.total + 0.01).toFixed(2));
    const counted = (runningCost.modelUsage[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 });
    counted.inputTokens += 10;
    counted.cacheReadInputTokens += 2;
    counted.outputTokens += 5;
    counted.costUSD = Number((counted.costUSD + 0.01).toFixed(2));
    if (costStateFile) writeFileSync(costStateFile, JSON.stringify(runningCost));
    out({
      type: "result",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: runningCost.total,
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
      modelUsage: runningCost.modelUsage,
    });
    // A background task's heartbeat after the turn settled: nothing is open
    // for it to keep alive.
    if (mode === "tool-heartbeat-late") {
      out({ type: "tool_progress", tool_use_id: "tu-bg-heartbeat-0", tool_name: "Bash",
        parent_tool_use_id: "tu-bg", elapsed_time_seconds: 30, heartbeat: true });
    }
    turnRunning = false;
    finishIfDone();
  };
  if (mode === "final-steer" && followUpTurn) {
    out({ type: "assistant", message: { content: [{ type: "text", text: `reply to: ${promptText(prompt)}` }] } });
    finish();
  } else if (mode === "final-steer") {
    foldOpen = false;
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Writing the final answer" } } });
    // the answer ends once a message has arrived during it (or after 3 s)
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (queuedPrompts.length < (Number(process.env.FAKE_CLAUDE_FINAL_STEERS) || 1) && Date.now() - startedAt < 3_000) return;
      clearInterval(timer);
      out({ type: "assistant", message: { content: [{ type: "text", text: `reply to: ${promptText(prompt)}` }] } });
      finish();
    }, 10);
  } else if (mode === "slow") {
    // a gap a test can steer into; the closing reply carries anything that
    // was folded in, the way the real CLI includes a mid-turn message in
    // the same turn's next model call
    const finishSlow = () => {
      const tail = steered.length ? ` + steered: ${steered.join(" | ")}` : "";
      // FAKE_CLAUDE_SLOW_REPLY_LAST=1: the scripted reply stays the turn's last text (a goal lead's closing envelope)
      if (process.env.FAKE_CLAUDE_SLOW_REPLY_LAST !== "1" || steered.length) {
        out({ type: "assistant", message: { content: [{ type: "text", text: `reply to: ${promptText(prompt)}${tail}` }] } });
      }
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
// A wedged CLI: SIGTERM and stdin EOF are both ignored, so only SIGKILL ends
// it.
const wedged = process.env.FAKE_CLAUDE_IGNORE_TERM === "1";
if (wedged) {
  process.on("SIGTERM", () => { /* ignored */ });
  setInterval(() => { /* stays alive after stdin EOF */ }, 60_000);
  // FAKE_CLAUDE_LATE_INIT=1: a retired session's straggler, a system/init
  // frame written after Murage closed its stdin.
  if (process.env.FAKE_CLAUDE_LATE_INIT === "1") {
    process.stdin.on("end", () => setTimeout(() => out({ type: "system", subtype: "init", session_id: "late-retired-session", model: "fake" }), 100));
  }
}

// A slow start (a wrapper, a loaded machine): nothing is read or written for
// FAKE_CLAUDE_START_DELAY_MS, then the CLI reads its --mcp-config and
// --append-system-prompt-file, the way the real one does at startup, and
// appends "mcp=<ok|missing|none> system=<ok|missing|none>" to FAKE_CLAUDE_START_LOG.
const startDelayMs = Number(process.env.FAKE_CLAUDE_START_DELAY_MS);
// A launcher wrapper's banner: plain lines (and a JSON line with no protocol
// type) on stdout at once, before the CLI has read anything.
if (process.env.FAKE_CLAUDE_START_BANNER) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_START_BANNER}\n{"launcher":"wrapper","ready":true}\n`);
}
// FAKE_CLAUDE_START_FRAMES: a JSON array of frames written to stdout at once, before the CLI
// has read anything (frames that look like protocol but are not a startup signal, or are).
if (process.env.FAKE_CLAUDE_START_FRAMES) {
  for (const frame of JSON.parse(process.env.FAKE_CLAUDE_START_FRAMES) as unknown[]) process.stdout.write(`${JSON.stringify(frame)}\n`);
}
if (Number.isFinite(startDelayMs) && startDelayMs > 0) {
  process.stdin.pause();
  setTimeout(() => {
    const state = (path: string | null) => (path === null ? "none" : existsSync(path) ? "ok" : "missing");
    if (process.env.FAKE_CLAUDE_START_LOG) {
      appendFileSync(process.env.FAKE_CLAUDE_START_LOG, `mcp=${state(argAfter("--mcp-config"))} system=${state(argAfter("--append-system-prompt-file"))}\n`);
    }
    process.stdin.resume();
  }, startDelayMs);
}

// MCP start-up as Claude Code 2.1.280+ reports it (rig, 2026-10-10): every
// --mcp-config server starts "pending" and becomes "connected" after
// FAKE_CLAUDE_MCP_READY_MS[name] ms (default 0; -1 never), or "failed" at
// MCP_TIMEOUT. `mcp_status` answers the states; `mcp_reconnect` answers after
// FAKE_CLAUDE_MCP_RECONNECT_MS[name] ms (default 0; -1: the timeout error at
// MCP_TIMEOUT), and, as in the real CLI, nothing else on stdin is read until it has.
const mcpStartedAt = Date.now();
const mcpTimeoutMs = Number(process.env.MCP_TIMEOUT) > 0 ? Number(process.env.MCP_TIMEOUT) : 30_000;
const mcpReadyMs: Record<string, number> = process.env.FAKE_CLAUDE_MCP_READY_MS ? JSON.parse(process.env.FAKE_CLAUDE_MCP_READY_MS) : {};
const mcpReconnectMs: Record<string, number> = process.env.FAKE_CLAUDE_MCP_RECONNECT_MS ? JSON.parse(process.env.FAKE_CLAUDE_MCP_RECONNECT_MS) : {};
const mcpOverride = new Map<string, "connected" | "failed">();
const mcpServerNames = (): string[] => Object.keys((startupMcpConfig as { mcpServers?: Record<string, unknown> } | null)?.mcpServers ?? {});
const mcpState = (name: string): string => {
  const forced = mcpOverride.get(name);
  if (forced) return forced;
  const elapsed = Date.now() - mcpStartedAt;
  const ready = mcpReadyMs[name] ?? 0;
  if (ready >= 0 && elapsed >= ready) return "connected";
  return elapsed >= mcpTimeoutMs ? "failed" : "pending";
};
const mcpStates = (): Record<string, string> => Object.fromEntries(mcpServerNames().map((name) => [name, mcpState(name)]));
let stdinHeld = false;

let buf = "";
const drainStdin = () => {
  let nl;
  while (!stdinHeld && (nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let prompt: JsonValue = null;
    try {
      prompt = JSON.parse(line);
    } catch {
      continue;
    }
    const control = prompt as { type?: string; request_id?: string; request?: { subtype?: string; serverName?: string } } | null;
    // The host's answer to a request this CLI sent it (FAKE_CLAUDE_ELICIT).
    if ((control as { type?: string } | null)?.type === "control_response") {
      if (process.env.FAKE_CLAUDE_ELICIT_LOG) appendFileSync(process.env.FAKE_CLAUDE_ELICIT_LOG, `${line}\n`);
      const answered = (control as { response?: { request_id?: string } }).response?.request_id;
      if (answered && elicitWaiting.delete(answered) && elicitWaiting.size === 0 && elicitResume) {
        const resume = elicitResume;
        elicitResume = null;
        resume();
      }
      continue;
    }
    if (control?.type === "control_request") {
      if (process.env.FAKE_CLAUDE_CONTROL_LOG) appendFileSync(process.env.FAKE_CLAUDE_CONTROL_LOG, `${JSON.stringify({ ...control, at: Date.now() - mcpStartedAt })}\n`);
      // FAKE_CLAUDE_MCP_STATUS: "error" refuses mcp_status as an unknown
      // request (an older build); "silent" never answers it.
      if (control.request?.subtype === "mcp_status" && process.env.FAKE_CLAUDE_MCP_STATUS === "silent") continue;
      if (control.request?.subtype === "mcp_status" && process.env.FAKE_CLAUDE_MCP_STATUS === "error") {
        out({ type: "control_response", response: { subtype: "error", request_id: control.request_id, error: "Unsupported control request subtype: mcp_status" } });
        continue;
      }
      if (control.request?.subtype === "mcp_status") {
        // A server whose bridge died between turns (the test writes its name
        // into FAKE_CLAUDE_MCP_KILL_FILE): "failed" from now on, until reconnected.
        const killFile = process.env.FAKE_CLAUDE_MCP_KILL_FILE;
        if (killFile && existsSync(killFile)) {
          for (const name of readFileSync(killFile, "utf8").split(/\s+/).filter(Boolean)) mcpOverride.set(name, "failed");
          try { unlinkSync(killFile); } catch { /* already gone */ }
        }
        out({ type: "control_response", response: { subtype: "success", request_id: control.request_id, response: { mcpServers: Object.entries(mcpStates()).map(([name, status]) => ({ name, status })) } } });
        continue;
      }
      if (control.request?.subtype === "mcp_reconnect") {
        const name = String(control.request.serverName ?? "");
        const after = mcpReconnectMs[name] ?? 0;
        stdinHeld = true;
        setTimeout(() => {
          // FAKE_CLAUDE_MCP_RECONNECT_NEEDS_CRED=1: the restarted bridge lists
          // its tools with the credential file as it is now; an empty file is
          // refused, as the harness refuses a tools/list without a token.
          const cred = process.env.FAKE_CLAUDE_MCP_RECONNECT_NEEDS_CRED === "1" ? readCredFile().content : null;
          const unauthorized = process.env.FAKE_CLAUDE_MCP_RECONNECT_NEEDS_CRED === "1"
            && !(cred && typeof cred === "object" && Object.keys((cred as Record<string, Record<string, string>>)[name] ?? {}).length);
          if (process.env.FAKE_CLAUDE_CONTROL_LOG) appendFileSync(process.env.FAKE_CLAUDE_CONTROL_LOG, `${JSON.stringify({ reconnected: name, unauthorized, at: Date.now() - mcpStartedAt })}\n`);
          const fails = after < 0 || unauthorized;
          mcpOverride.set(name, fails ? "failed" : "connected");
          out(fails
            ? { type: "control_response", response: { subtype: "error", request_id: control.request_id, error: unauthorized ? `MCP server "${name}": tools/list unauthorized` : `MCP server "${name}" connection timed out after ${mcpTimeoutMs}ms` } }
            : { type: "control_response", response: { subtype: "success", request_id: control.request_id, response: {} } });
          stdinHeld = false;
          drainStdin();
        }, after < 0 ? mcpTimeoutMs : after);
        continue;
      }
      out(control.request?.subtype === "initialize" && process.env.FAKE_CLAUDE_INIT_ERROR === "1"
        ? { type: "control_response", response: { subtype: "error", request_id: control.request_id, error: "initialize refused" } }
        : control.request?.subtype === "initialize"
        ? { type: "control_response", response: { subtype: "success", request_id: control.request_id, response: { commands: FAKE_COMMANDS, output_style: "default", available_output_styles: ["default"], models: [], account: {} } } }
        : { type: "control_response", response: { subtype: "error", request_id: control.request_id, error: "unsupported" } });
      continue;
    }
    if ((turnRunning && !foldOpen) || followUpTimer) queuedPrompts.push(prompt);
    else if (turnRunning) {
      steered.push(promptText(prompt));
      // a steer line names the turn it went into, so a spec can tell it from a launch
      if (process.env.FAKE_CLAUDE_DUMP_LOG) appendFileSync(process.env.FAKE_CLAUDE_DUMP_LOG, `${JSON.stringify({ turnId: credTurnId(), steer: promptText(prompt) })}\n`);
    }
    else {
      playTurn(prompt);
      armSteerGate();
    }
  }
};
process.stdin.on("data", (c) => {
  buf += c;
  drainStdin();
});
process.stdin.on("end", () => {
  if (wedged) return;
  stdinEnded = true;
  finishIfDone();
});
