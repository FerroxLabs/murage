#!/usr/bin/env node
// Fake of the Antigravity `agy` CLI's print-mode stdio surface, for driver
// tests of drivers/antigravity.ts. On `--version` it prints a version; in
// stream-json input mode it reads one user event from stdin, then emits a
// canned NDJSON turn: init → tool
// step (ACTIVE then DONE) → agent_response step with usage → result with
// status SUCCESS. Deterministic, no network.
//
//   FAKE_AGY_MODE=text-propose
//     answers the Chief's New project proposal turn with the proposal block
//     (fake-mcp-propose.ts proposalReply) and logs whether it ran gated.
//
//   FAKE_AGY_MODE=ask-peer
//     reads Murage's temporary `murage-agents` entry from agy's
//     global MCP config, calls list_bots then ask_bot, and returns the peer's
//     real reply. This pins the Antigravity/Gemini comms path end to end.
//
//   FAKE_AGY_TOOL=<name>
//     the tool step's name (default write_to_file).
//   FAKE_AGY_TOOL_CALLS=<json [{name, args}]>
//     the tool steps, in order (step_index 0..n-1), in place of the one FAKE_AGY_TOOL step; with FAKE_AGY_RUN_HOOKS=1
//     each runs the hooks first, and an allowed run_command really runs its CommandLine (sh -c, in the cwd).
//   FAKE_AGY_SKIP_HOOKS=1
//     agy runs the tools without its hooks (an agy that ignored them).
//   --log-file <path>
//     agy's start-up hooks_manager line, from HOME/.gemini/config/hooks.json and the project's <cwd>/.agents/hooks.json,
//     written before stdin is read (FAKE_AGY_HOOKS_IGNORED=1: it loads none from HOME). A file it cannot parse is
//     named in a "failed to parse hooks.json at <path>" line and adds no hooks.
//   FAKE_AGY_CREATE_REPO_HOOK=1
//     writes a project <cwd>/.agents/hooks.json at start-up, before the hook-load line (one that appeared after
//     Murage looked).
//   FAKE_AGY_UNHOOKED_ERROR=1
//     each tool step ends in ERROR (the tool failed) without its hooks having run.
//   FAKE_AGY_RUN_HOOKS=1
//     before the tool runs, run every PreToolUse hook in HOME/.gemini/config/hooks.json as agy does (`sh -c`,
//     Windows `cmd /c`, JSON on stdin, cwd the hooks.json folder); a "deny" (or a hook that fails) ends the step in
//     ERROR "tool call denied by pre-tool hook: <reason>", as agy 1.4.4 does.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { fixtureDumpEnvironment } from "./fixture-dump.ts";
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logProposalTurn, proposalReply } from "./fake-mcp-propose.ts";
import { fakeReviewReply } from "./fake-review.ts";

const mode = process.env.FAKE_AGY_MODE ?? "happy";

type McpEntry = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

function agentsMcpEntry(): McpEntry | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  try {
    const config = JSON.parse(
      readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8"),
    );
    const entry = config.mcpServers?.["murage-agents"];
    if (!entry?.command) return null;
    return {
      command: String(entry.command),
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: Object.fromEntries(
        Object.entries(entry.env ?? {}).map(([name, value]) => [name, String(value)]),
      ),
    };
  } catch {
    return null;
  }
}

/** Minimal MCP stdio client matching the real config shape used by agy. */
function driveMcp(
  entry: McpEntry,
  calls: Array<{ name: string; args: (previous: string) => object }>,
  /** agy's PreToolUse hooks for each call (a relayed turn): a refusal ends the run with it. */
  gate?: (name: string, args: object, index: number) => string | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...entry.env };
    const child = spawn(entry.command, entry.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let settled = false;
    let step = -1; // -1 = initialize in flight
    let last = "";

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(last);
    };
    const timer = setTimeout(() => finish(new Error("mcp timeout")), 60_000);
    const write = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const next = () => {
      step += 1;
      if (step >= calls.length) return finish();
      const call = calls[step];
      const refused = gate?.(call.name, call.args(last), step);
      if (refused) return finish(new Error(`denied by pre-tool hook: ${refused}`));
      write({
        jsonrpc: "2.0",
        id: step + 2,
        method: "tools/call",
        params: { name: call.name, arguments: call.args(last) },
      });
    };

    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`mcp exited before completing (code ${code ?? "unknown"})`));
    });
    child.stdin.on("error", (error) => finish(error));
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined) continue;
        if (message.error) {
          finish(new Error(String(message.error.message ?? "MCP call failed")));
          return;
        }
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(message.result?.content?.[0]?.text ?? "");
        next();
      }
    });
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "murage-fake-antigravity", version: "1.0.0" },
      },
    });
  });
}

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}
if (process.env.FAKE_AGY_DUMP) {
  writeFileSync(process.env.FAKE_AGY_DUMP, JSON.stringify({ argv, env: fixtureDumpEnvironment() }, null, 2));
}
if (argv.includes("--version")) {
  const versionDelayMs = Number(process.env.FAKE_AGY_VERSION_DELAY_MS ?? 0);
  if (Number.isFinite(versionDelayMs) && versionDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, versionDelayMs));
  console.log(process.env.FAKE_AGY_VERSION ?? "1.1.22");
  process.exit(0);
}
if (process.env.FAKE_AGY_READY_FILE) {
  writeFileSync(process.env.FAKE_AGY_READY_FILE, "ready");
}

const delayMs = Number(process.env.FAKE_AGY_DELAY_MS ?? 0);
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
if (process.env.FAKE_AGY_MCP_DUMP) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let config = "null";
  try {
    config = readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8");
  } catch {}
  writeFileSync(process.env.FAKE_AGY_MCP_DUMP, config);
}

// FAKE_AGY_HOME_DUMP: what the child sees under its HOME/.gemini (every path,
// symlinks followed), plus where the login file really lives. Lets a test prove
// the owner's personal items are absent and the login still resolves.
if (process.env.FAKE_AGY_HOME_DUMP) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const seen: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      seen.push(path.slice(home.length + 1));
      if (depth < 4) walk(path, depth + 1);
    }
  };
  walk(join(home, ".gemini"), 0);
  const login = join(home, ".gemini", "antigravity-cli", "auth.json");
  writeFileSync(process.env.FAKE_AGY_HOME_DUMP, JSON.stringify({
    home,
    seen: seen.sort(),
    loginReal: existsSync(login) ? realpathSync(login) : null,
    loginText: existsSync(login) ? readFileSync(login, "utf8") : null,
  }));
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const CONV = "conv-fake-123";

// agy 1.4.4 logs which hooks it loaded at start-up, before it reads the prompt (hooks_manager.go).
const logAt = argv.indexOf("--log-file");
if (logAt !== -1 && argv[logAt + 1]) {
  // FAKE_AGY_HOME_OVERRIDE: the HOME agy really ends up with (a Cloud launcher replaces the turn's HOME)
  const home = process.env.FAKE_AGY_HOME_OVERRIDE || process.env.HOME || process.env.USERPROFILE || "";
  // FAKE_AGY_CREATE_REPO_HOOK=1: a project hooks file appears after Murage looked (written here, before agy loads)
  if (process.env.FAKE_AGY_CREATE_REPO_HOOK === "1") {
    mkdirSync(join(process.cwd(), ".agents"), { recursive: true });
    writeFileSync(join(process.cwd(), ".agents", "hooks.json"), JSON.stringify({ "repo-allow": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo '{\"decision\":\"allow\"}'" }] }] } }));
  }
  const files = [...(process.env.FAKE_AGY_HOOKS_IGNORED === "1" ? [] : [join(home, ".gemini", "config", "hooks.json")]), join(process.cwd(), ".agents", "hooks.json")];
  const lines: string[] = [];
  let named = 0;
  let loadedFiles = 0;
  for (const file of files.filter((path) => existsSync(path))) {
    try {
      named += Object.keys(JSON.parse(readFileSync(file, "utf8"))).length;
      loadedFiles++;
    } catch (error) {
      lines.push(`failed to parse hooks.json at ${file}: ${(error as Error).message}`);
    }
  }
  lines.push(`loaded ${named} named hooks from ${loadedFiles} hooks.json file(s)`);
  writeFileSync(argv[logAt + 1]!, lines.map((line) => `I1022 00:00:00.000000       1 hooks_manager.go:53] ${line}\n`).join(""));
}

const streamInput = argv[argv.indexOf("--input-format") + 1] === "stream-json";
let prompt: string | undefined;
if (streamInput) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  const line = input.split("\n").find((candidate) => candidate.trim());
  try {
    const message = line ? JSON.parse(line) : null;
    const content = message?.event === "user" ? message.message?.content : undefined;
    prompt = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((block) => block?.type === "text").map((block) => block.text).join("")
        : undefined;
  } catch {}
} else {
  // Retained for tests of old callers; production prompt paths use stdin.
  const printIdx = Math.max(argv.indexOf("--print"), argv.indexOf("-p"));
  prompt = printIdx !== -1 ? argv[printIdx + 1] : undefined;
}
if (!prompt) process.exit(0);
if (process.env.FAKE_AGY_DUMP) {
  writeFileSync(process.env.FAKE_AGY_DUMP, JSON.stringify({ argv, env: fixtureDumpEnvironment(), prompt }, null, 2));
}

const toolName = process.env.FAKE_AGY_TOOL || (mode === "ask-peer" ? "ask_bot" : "write_to_file");
/** agy's PreToolUse hooks for this tool: the first deny (or failed hook) wins. */
function hookDenial(name: string, args: unknown = {}, stepIdx = 0, always = false): string | null {
  if ((!always && process.env.FAKE_AGY_RUN_HOOKS !== "1") || process.env.FAKE_AGY_SKIP_HOOKS === "1") return null;
  const home = process.env.FAKE_AGY_HOME_OVERRIDE || process.env.HOME || process.env.USERPROFILE || "";
  const file = join(home, ".gemini", "config", "hooks.json");
  if (!existsSync(file)) return null;
  const spec = JSON.parse(readFileSync(file, "utf8")) as Record<string, { enabled?: boolean; PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command: string }> }> }>;
  for (const hook of Object.values(spec)) {
    if (hook.enabled === false) continue;
    for (const group of hook.PreToolUse ?? []) {
      const matcher = group.matcher ?? "";
      if (!(matcher === "*" || matcher === "" || new RegExp(`^(?:${matcher})$`).test(name))) continue;
      for (const handler of group.hooks ?? []) {
        let answer = "";
        try {
          const input = JSON.stringify({ toolCall: { name, args }, stepIdx, conversationId: CONV }), cwd = join(home, ".gemini", "config");
          // agy runs a hook command through `sh -c`, and on Windows through `cmd /c` with the command line as written
          // (cmd drops the outer pair of quotes Murage adds). execSync would run `cmd /d /s /c "<command>"`, which
          // wraps it in one more pair, so the Windows form is spelled out here.
          if (process.platform === "win32") {
            const run = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", handler.command], { input, cwd, encoding: "utf8", timeout: 15_000, windowsVerbatimArguments: true });
            if (run.error) throw run.error;
            if (run.status !== 0) throw new Error(`Command failed: ${handler.command} (exit ${run.status}) ${String(run.stderr ?? "").trim()}`.replace(/\n/g, " "));
            answer = run.stdout;
          } else answer = execSync(handler.command, { input, cwd, encoding: "utf8", timeout: 15_000 });
        } catch (error) {
          return `hook failed (${(error as Error).message.split("\n")[0]})`;
        }
        const decision = JSON.parse(answer || "{}") as { decision?: string; reason?: string };
        if (decision.decision === "deny") return decision.reason ?? "denied";
      }
    }
  }
  return null;
}
out({ event: "init", conversation_id: CONV, init: { cwd: process.cwd(), tools: ["run_command", "write_to_file", ...(mode === "ask-peer" ? ["list_bots", "ask_bot"] : [])], permission_mode: "accept-edits" } });
// A relayed ask-peer turn's tools are its MCP calls (call_mcp_tool steps, below): no step of its own.
const toolCalls: Array<{ name: string; args: Record<string, unknown> }> | null = process.env.FAKE_AGY_TOOL_CALLS
  ? JSON.parse(process.env.FAKE_AGY_TOOL_CALLS)
  : mode === "ask-peer" && argv.includes("--log-file") ? [] : null;
if (!toolCalls) out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "ACTIVE", step_type: "tool", tool_name: toolName, tool_info: { name: toolName, parameters: {} } } });
// FAKE_AGY_EXTRA_STEPS=1: steps agy streams that carry no chat content
// (planning, a response still being written), as a long model step does.
// The same step repeated (a stuck retry loop re-sending its state) is not
// new work.
if (process.env.FAKE_AGY_EXTRA_STEPS === "1") {
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "ACTIVE", step_type: "planner_response" } });
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "ACTIVE", step_type: "planner_response" } });
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 2, state: "ACTIVE", step_type: "agent_response" } });
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "ACTIVE", step_type: "planner_response" } });
  // one long step whose content keeps growing is still working
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 2, state: "ACTIVE", step_type: "agent_response", partial: "ab" } });
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 2, state: "ACTIVE", step_type: "agent_response", partial: "abc" } });
}

// A genuine crash: the child dies mid-turn with no `result` and nobody
// asked it to stop (STOP1 pins this as exit_before_result, unlike a Stop).
if (process.env.FAKE_AGY_CRASH_BEFORE_RESULT === "1") {
  process.stderr.write("fake agy: simulated crash\n");
  process.exit(3);
}

let response = "done from fake agy";
// Lane N2: the Chief's proposal as a block in the reply; agy runs gated when it
// was not handed --dangerously-skip-permissions.
// lane review: a review run answers with its verdict (fake-review.ts)
if (fakeReviewReply(prompt) !== null) response = fakeReviewReply(prompt)!;
if (mode === "text-propose" && prompt.includes("<murage-project-proposal")) {
  logProposalTurn({ engine: "antigravityAgent", skipPermissions: argv.includes("--dangerously-skip-permissions"), agentsMounted: agentsMcpEntry() !== null });
  response = proposalReply(prompt);
}
if (mode === "ask-peer") {
  const agents = agentsMcpEntry();
  if (!agents) {
    response = "peer error: agents MCP not mounted";
  } else {
    try {
      // A relayed turn (Auto, Full access): each MCP call is a call_mcp_tool step that runs agy's hooks first.
      const relayed = argv.includes("--log-file");
      const gate = relayed ? (name: string, args: object, index: number) => {
        const tool = { ServerName: "murage-agents", ToolName: name, Arguments: args };
        out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 10 + index, state: "ACTIVE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters: tool } } });
        const refused = hookDenial("call_mcp_tool", tool, 10 + index, true);
        out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 10 + index, state: refused === null ? "DONE" : "ERROR", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters: tool } } });
        return refused;
      } : undefined;
      const reply = await driveMcp(agents, [
        { name: "list_bots", args: () => ({}) },
        {
          name: "ask_bot",
          args: (list) => ({
            bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "",
            message: "ping from fake Gemini",
          }),
        },
      ], gate);
      response = `peer says: ${reply}`;
    } catch (error) {
      response = `peer error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

const calls = toolCalls ?? [];
for (const [index, call] of calls.entries()) {
  const step = (state: string, extra: Record<string, unknown> = {}) =>
    out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: index, state, step_type: "tool", tool_name: call.name, tool_info: { name: call.name, parameters: call.args, ...extra } } });
  step("ACTIVE");
  if (process.env.FAKE_AGY_UNHOOKED_ERROR === "1") {
    step("ERROR", { error: { type: "TOOL_ERROR", message: "the tool failed" } });
    continue;
  }
  const refused = hookDenial(call.name, call.args, index);
  if (refused !== null) {
    step("ERROR", { error: { type: "TOOL_ERROR", message: `tool call denied by pre-tool hook: ${refused}` } });
    continue;
  }
  if (call.name === "run_command" && typeof call.args.CommandLine === "string") {
    // The platform's own command shell: there is no /bin/sh on Windows, so a run_command there must go through cmd.exe
    // (ComSpec), or the step "ran" without running anything and a test's file never appears.
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    try { execSync(call.args.CommandLine, { cwd: process.cwd(), stdio: "ignore", shell }); } catch { /* the step still ran */ }
  }
  step("DONE");
}
if (process.env.FAKE_AGY_DUMP && toolCalls) writeFileSync(`${process.env.FAKE_AGY_DUMP}.calls.json`, JSON.stringify(calls.length));
const denial = toolCalls ? null : hookDenial(toolName);
if (toolCalls) {
  // the tool steps ran above
} else if (denial !== null) {
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "ERROR", step_type: "tool", tool_name: toolName, tool_info: { name: toolName, parameters: {}, error: { type: "TOOL_ERROR", message: `tool call denied by pre-tool hook: ${denial}` } } } });
  if (process.env.FAKE_AGY_DUMP) writeFileSync(`${process.env.FAKE_AGY_DUMP}.hook.json`, JSON.stringify({ tool: toolName, denial }));
} else {
  if (process.env.FAKE_AGY_DUMP && process.env.FAKE_AGY_RUN_HOOKS === "1") writeFileSync(`${process.env.FAKE_AGY_DUMP}.hook.json`, JSON.stringify({ tool: toolName, denial: null }));
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "DONE", step_type: "tool", tool_name: toolName, tool_info: { name: toolName, parameters: {} } } });
}
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
// FAKE_AGY_DENIED_COMMAND=1: accept-edits denied run_command and agy wrote no reply (agy result.denied_actions).
const deniedCommand = process.env.FAKE_AGY_DENIED_COMMAND === "1";
if (deniedCommand) response = "";
out({ event: "result", conversation_id: CONV, result: { conversation_id: CONV, status: "SUCCESS", response, ...(deniedCommand ? { denied_actions: ["RunCommand"] } : {}), duration_seconds: 1, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
// FAKE_AGY_POST_RESULT_STEP=1: a step line written after the result, while
// the process is still closing
if (process.env.FAKE_AGY_POST_RESULT_STEP === "1") {
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 9, state: "ACTIVE", step_type: "planner_response" } });
}
const postResultDelayMs = Number(process.env.FAKE_AGY_POST_RESULT_DELAY_MS ?? 0);
if (Number.isFinite(postResultDelayMs) && postResultDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
}
process.exit(0);
