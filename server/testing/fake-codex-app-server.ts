#!/usr/bin/env node
// Fake of the codex CLI's `app-server` JSON-RPC surface, for driver
// tests. Speaks newline-delimited JSON-RPC on stdio: answers the
// initialize/thread/turn handshake, then plays a scripted turn. Like the
// real app-server, it never exits on its own — the driver kills it.
//
//   FAKE_CODEX_MODE   happy (default) | project-propose (the Chief's New project proposal through
//                     the mounted agents server; see fake-mcp-propose.ts) | text-propose (the proposal
//                     as a block in the reply, after a declined command approval) | approval | resume | stream | windows-command |
//                     mcp-elicitation | form-elicitation | user-input | image |
//                     async-question (the turn posts request_user_input_async's agentMessage, then keeps running
//                     until FAKE_CODEX_ASYNC_QUESTION_GATE exists; FAKE_CODEX_ASYNC_QUESTIONS replaces its questions;
//                     with FAKE_CODEX_ASYNC_QUESTION_ONCE, a marker path, only the first turn asks) |
//                     logged-in-stdout | logged-out | unauthorized
//   FAKE_CODEX_DUMP   path to write {argv, env, calls, decision} as JSON
//   FAKE_CUSTOM_TOOL_SERVER / FAKE_CUSTOM_TOOL_LOG  every turn calls the first tool
//                     of that owner server (fake-custom-tool.ts)
//   FAKE_CODEX_MCP_SERVER / FAKE_CODEX_MCP_TOOL  the server and tool an
//                     mcp-elicitation approval names (default agents, list_bots)
//   FAKE_CODEX_LAUNCH_CRASHES  N: die at thread/start (before turn/start is ever sent)
//                     with transient stderr, exit 1, for the first N launches
//   FAKE_CODEX_LAUNCH_KILLS    N: same phase, transient stderr then SIGKILL (a signal
//                     exit; POSIX-shaped — win32 reports exit 1, signal null)
//   FAKE_CODEX_LAUNCH_SILENT   N: same phase, exit 1 with no new stderr. With
//                     FAKE_CODEX_STALE_STDERR_GATE (a gate path) it first writes
//                     transient-looking stderr and answers initialize only once
//                     the test saw that stderr, so the stale line is read before
//                     a later protocol message
//   FAKE_CODEX_PREACK_CRASH    plain | buffered: after turn/start was received and
//                     before its ACK, (buffered: one turn notification, then)
//                     transient stderr and exit 1
//   FAKE_CODEX_ACK_CRASH       gate path: ACK turn/start, then once the test saw the
//                     driver read that ACK, transient stderr and exit 1
//   FAKE_CODEX_EXIT_MID_TURN   gate path: stale websocket-426 stderr; once the test saw
//                     it, ACK plus one reasoning delta; then SIGKILL once
//                     FAKE_CODEX_EXIT_MID_TURN_KILL (gate path) appears
//                     Launch counts for these knobs go to FAKE_CODEX_STATE.
//   (mode transient-503: every turn/start answers a transient 503 error; with FAKE_CODEX_MODE_FILE
//                     it can be switched on for a process that is already running)
//   FAKE_CODEX_CALL_LOG   file: one "<pid> <method>" line per request received
//   (mode late-approval: turn/completed and an approval request arrive in one write)
//   (mode split-approval: turn/completed, then an approval request split across two writes)
//   FAKE_CODEX_RESUME_GATE  gate path: hold the thread/resume answer until that file exists (a slow start)
//   FAKE_CODEX_RESUME_MODEL  thread/resume answers like Codex 0.163: `{thread, model, modelProvider}`, echoing the requested model
//                     (default) | stale: names another model ("stale-model") | none: names no model
//   FAKE_CODEX_TURNSTART_SILENT  plain | buffered | notify-error: turn/start is never answered (buffered: one turn notification is
//                     sent first); notify-error: one turn notification, then a transient 503 error answer
//   FAKE_CODEX_TURNSTART_LATE  "1": turn/start is not answered; the SIGTERM is ignored, and the ACK plus one turn notification are
//                     written only then (a late answer while the process holds its shutdown; the kill escalates)
//   FAKE_CODEX_SPAWN_LOG  file: one line (the pid) per app-server process started
//   FAKE_CODEX_WARM    "1": each turn gets its own turn id and the reported thread
//                     total accumulates (7/4/3 more per turn), as a retained
//                     app-server reports it; the dump also carries the credential
//                     file the agents server was mounted with, read at dump time
//   FAKE_CODEX_STOP_RACE  marker file path: hold turn/start, append one line to
//                     the marker (the launch count, and proof this phase was
//                     reached), and answer the held request with a transient
//                     503 error only from the SIGTERM handler — so the failure
//                     is strictly caused by, and observed after, the driver's
//                     Stop. POSIX-shaped: win32 has no SIGTERM handler.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { fixtureDumpEnvironment } from "./fixture-dump.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import { logProposalTurn, proposalFrom, proposalReply, proposeThroughMcp } from "./fake-mcp-propose.ts";
import { fakeReviewReply } from "./fake-review.ts";
import { callFirstCustomTool, customToolReply, customToolServer } from "./fake-custom-tool.ts";

/** project-propose mode's approval requests, answered by id. */
const proposalAsks = new Map<number, (result: any) => void>();

/** A server as codex mounts it: `-c mcp_servers.<name>.<key>=<json>`
 * overrides, with the named environment variables passed through. */
const mountedServer = (name: string) => {
  const argv = process.argv.slice(2);
  const value = (key: string): unknown => {
    const prefix = `mcp_servers.${name}.${key}=`;
    const arg = argv.find(item => item.startsWith(prefix));
    try { return arg ? JSON.parse(arg.slice(prefix.length)) : undefined; } catch { return undefined; }
  };
  const command = value("command"), args = value("args"), names = value("env_vars");
  if (typeof command !== "string") return null;
  // static values from the server's own `env` table (`-c mcp_servers.<name>.env.KEY="v"`)
  const own: Record<string, string> = {};
  const envPrefix = `mcp_servers.${name}.env.`;
  for (const arg of argv) {
    if (!arg.startsWith(envPrefix)) continue;
    const eq = arg.indexOf("=");
    try { own[arg.slice(envPrefix.length, eq)] = JSON.parse(arg.slice(eq + 1)); } catch {}
  }
  const env = Object.fromEntries((Array.isArray(names) ? names : []).filter((name): name is string => typeof name === "string" && process.env[name] !== undefined).map(name => [name, process.env[name]!]));
  return { command, args: Array.isArray(args) ? args.map(String) : [], env: { ...env, ...own } };
};
const mountedAgents = () => mountedServer("agents");

// FAKE_CODEX_MODE_FILE: a file whose content, when present, replaces the mode
// at every request, so a test can change what a RETAINED process does next.
let mode = process.env.FAKE_CODEX_MODE ?? "happy";
const refreshMode = () => {
  const file = process.env.FAKE_CODEX_MODE_FILE;
  if (!file || !existsSync(file)) return;
  try { mode = readFileSync(file, "utf8").trim() || mode; } catch {}
};

// stdout and stderr are separate pipes, so the writer cannot order them for
// the reader, and a fixed sleep only pretends to. A gated write waits until
// the test, watching the driver consume the earlier stream, creates the gate
// file. It gives up after a long bound so a broken gate fails the test rather
// than hanging it.
/** async-question: whether this turn asks (always, or once per FAKE_CODEX_ASYNC_QUESTION_ONCE marker). */
const askAsyncOnce = (): boolean => {
  const marker = process.env.FAKE_CODEX_ASYNC_QUESTION_ONCE;
  if (!marker) return true;
  if (existsSync(marker)) return false;
  writeFileSync(marker, "asked\n");
  return true;
};

const waitForGate = (path: string | undefined, timeoutMs = 15_000): Promise<void> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if ((path !== undefined && existsSync(path)) || Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 2);
  });

/** Records one turn launch in FAKE_CODEX_STATE; returns the prior count. */
const countLaunch = (): number => {
  const stateFile = process.env.FAKE_CODEX_STATE;
  if (!stateFile) return 0;
  let launched = 0;
  try {
    launched = Number(readFileSync(stateFile, "utf8")) || 0;
  } catch {}
  writeFileSync(stateFile, String(launched + 1));
  return launched;
};
const TRANSIENT_STDERR = "Error: connection reset by peer\n";

if (process.argv[2] === "--version") {
  // FAKE_CODEX_VERSION_LOG counts probes; FAKE_CODEX_VERSION overrides the version, "fail" makes the probe fail.
  if (process.env.FAKE_CODEX_VERSION_LOG) appendFileSync(process.env.FAKE_CODEX_VERSION_LOG, "probe\n");
  if (process.env.FAKE_CODEX_VERSION === "fail") process.exit(1);
  process.stdout.write(`${process.env.FAKE_CODEX_VERSION ?? "codex-cli 0.147.0"}\n`);
  process.exit(0);
}
if (process.argv[2] === "login" && process.argv[3] === "status") {
  if (mode === "logged-out") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  // Codex 0.147.0 reports a successful login on stderr; retain a mode for
  // older versions that wrote the same status on stdout.
  const statusStream = mode === "logged-in-stdout" ? process.stdout : process.stderr;
  statusStream.write("Logged in using ChatGPT\n");
  process.exit(0);
}
/** `__fixture_subagents__`: the parent spawns three helpers (collabAgentToolCall
 * items, schema of codex-cli 0.14x), its turn completes while they run, each
 * helper thread then asks to run a command, and they finish.
 *   FAKE_CODEX_BG_ASKS  asks raised after the parent's turn/completed (default 2)
 *   FAKE_CODEX_BG_HOLD  "1": the helpers never finish
 *   FAKE_CODEX_BG_WAKE  "1": the parent starts a second turn that answers them
 *   FAKE_CODEX_BG_LOG   one line per ask verdict and per finish */
const bgLog = (line: string) => { if (process.env.FAKE_CODEX_BG_LOG) appendFileSync(process.env.FAKE_CODEX_BG_LOG, `${line}\n`); };
async function playSubagents(ask: (id: number, method: string, params: Record<string, unknown>) => Promise<any>) {
  const kids = ["child-1", "child-2", "child-3"];
  const states = (status: string) => Object.fromEntries(kids.map(id => [id, { status, message: null }]));
  const collab = (type: string, status: string) => ({ id: "spawn-1", type: "collabAgentToolCall", tool: "spawnAgent", status, senderThreadId: nativeThreadId, receiverThreadIds: kids, prompt: "Read the handoff files", agentsStates: states(type) });
  notify("item/started", { item: collab("pendingInit", "inProgress") });
  notify("item/completed", { item: collab("running", "completed") });
  notify("item/completed", { item: { id: "m1", type: "agentMessage", text: "Three helpers are reading." } });
  notify("turn/completed", { turn: { status: "completed" } });
  const asks = Number(process.env.FAKE_CODEX_BG_ASKS ?? "2");
  for (let i = 0; i < asks; i += 1) {
    out({ jsonrpc: "2.0", method: "item/started", params: { threadId: "child-1", turnId: "child-turn", item: { id: `c${i}`, type: "commandExecution", command: "cat file" } } });
    const answer = await ask(9500 + i, "item/commandExecution/requestApproval", { threadId: "child-1", turnId: "child-turn", itemId: `c${i}`, command: `cat /outside/cwd/file-${i}.md` });
    bgLog(`verdict:${answer?.decision ?? JSON.stringify(answer)}`);
  }
  if (process.env.FAKE_CODEX_BG_HOLD === "1") { bgLog("held"); return; }
  for (const id of kids) out({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: id, turn: { id: "child-turn", status: "completed", items: [], error: null } } });
  if (process.env.FAKE_CODEX_BG_WAKE === "1") {
    await new Promise(resolve => setTimeout(resolve, 30));
    out({ jsonrpc: "2.0", method: "turn/started", params: { threadId: nativeThreadId, turn: { id: "turn-2", status: "inProgress", items: [], error: null } } });
    out({ jsonrpc: "2.0", method: "item/completed", params: { threadId: nativeThreadId, turnId: "turn-2", item: { id: "m2", type: "agentMessage", text: "All helpers reported." } } });
    out({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: nativeThreadId, turn: { id: "turn-2", status: "completed", items: [], error: null } } });
  }
  bgLog("finished");
}

if (process.argv[2] === "app-server" && process.env.FAKE_CODEX_SPAWN_LOG) appendFileSync(process.env.FAKE_CODEX_SPAWN_LOG, `${process.pid}\n`);
const warmMode = process.env.FAKE_CODEX_WARM === "1";
let turnSeq = 0;
const accumulated = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
const calls: Array<{ method: string; params: unknown }> = [];
let decision: unknown = null;
/** What each PreToolUse hook run answered, for the tests (id, tool name, input, verdict, reason), and whether the turn was interrupted. */
const hookLog: Array<{ id: string; name: string; input: unknown; verdict: string; reason?: string }> = [];
let interrupted = false;

// FAKE_CODEX_SKILLS_BATCHED holds every line from the skills/list answer
// through turn/completed and writes them in ONE chunk, the way a busy pipe
// coalesces them: the driver then reads the answer and the turn's end in the
// same pass, before any promise callback runs.
let batched: string[] | null = null;
const out = (obj: unknown) => {
  const line = JSON.stringify(obj) + "\n";
  if (!batched) return process.stdout.write(line);
  batched.push(line);
  if ((obj as { method?: string }).method === "turn/completed") {
    process.stdout.write(batched.join(""));
    batched = null;
  }
  return true;
};
let nativeThreadId = "codex-thread-1";
let nativeTurnId = "turn-1";
// v2 schema generated by codex-cli 0.144.4: items/usage/errors carry
// threadId+turnId; turn lifecycle carries threadId+turn.id.
const notification = (method: string, params: Record<string, any>) => ({
  jsonrpc: "2.0", method,
  params: method.startsWith("turn/")
    ? { threadId: nativeThreadId, ...params, turn: { id: nativeTurnId, items: [], error: null, ...params.turn } }
    : { threadId: nativeThreadId, turnId: nativeTurnId, ...params },
});
const notify = (method: string, params: Record<string, any>) => out(notification(method, params));
const turnResult = () => ({ turn: { id: nativeTurnId, status: "inProgress", items: [], error: null } });
// Mirrors ENGINE_FRAME_MAX_BYTES in server/drivers/bounded-lines.ts. "é" is
// two UTF-8 bytes: the text alone is one KiB over the limit.
const FIXTURE_FRAME_LIMIT = 32 * 1024 * 1024;
const fixtureOversizeText = () => "é".repeat(FIXTURE_FRAME_LIMIT / 2 + 512);
// 1x1 rasters for the MCP tool-result image fixture: one from a custom
// server (a deliverable), one from Murage's own computer surface (not).
const FIXTURE_TOOL_IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const FIXTURE_SCREEN_IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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

/** The credential file the mounted agents server would read this turn, as the proxy reads it. */
const readMountedCredFile = () => {
  const agents = mountedAgents();
  const path = agents?.env.MURAGE_CRED_FILE;
  if (!path) return null;
  try { return { path, server: agents!.env.MURAGE_CRED_SERVER, content: JSON.parse(readFileSync(path, "utf8")) }; } catch { return { path, content: null }; }
};

const dump = () => {
  if (process.env.FAKE_CODEX_DUMP) {
    writeFileAtomic(
      process.env.FAKE_CODEX_DUMP,
      JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), env: fixtureDumpEnvironment(), calls, decision, hookLog, interrupted, ...(warmMode ? { credFile: readMountedCredFile() } : {}) }, null, 2),
    );
  }
};

if (mode === "late-output") {
  process.on("SIGTERM", () => {
    setTimeout(() => {
      notify("item/agentMessage/delta", { itemId: "late-chunk", delta: "late chunk must be ignored" });
    }, 20);
    setTimeout(() => process.exit(0), Number(process.env.FAKE_CODEX_SHUTDOWN_DELAY_MS ?? 150));
  });
}

const finishTurn = () => {
  notify("item/completed", { item: { id: "i1", type: "commandExecution", status: "completed", exitCode: 0, aggregatedOutput: "" } });
  notify("item/completed", { item: { id: "w1", type: "webSearch", status: "completed" } });
  if (mode === "stream") {
    // token deltas, then the whole message — the driver must not double-emit
    notify("item/agentMessage/delta", { itemId: "m1", delta: "done from " });
    notify("item/agentMessage/delta", { itemId: "m1", delta: "fake codex" });
  }
  if (mode === "image") {
    notify("item/completed", {
      item: {
        id: "img1",
        type: "imageGeneration",
        status: "completed",
        result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        revisedPrompt: "a tiny green mouse",
        savedPath: "/tmp/provider-owned-path-must-not-be-read.png",
      },
    });
  }
  // Publish PID/state before the observable message used by lifecycle tests.
  dump();
  notify("item/completed", { item: { id: "m1", type: "agentMessage", text: "done from fake codex" } });
  if (warmMode) {
    accumulated.inputTokens += 7; accumulated.cachedInputTokens += 4; accumulated.outputTokens += 3;
    notify("thread/tokenUsage/updated", { tokenUsage: { total: { ...accumulated } } });
  } else notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 7, cachedInputTokens: 4, outputTokens: 3 } } });
  dump();
  if (mode === "late-output") {
    // One write ensures the completion and late frame share the parser buffer.
    process.stdout.write([
      notification("turn/completed", { turn: { status: "completed" } }),
      notification("item/agentMessage/delta", { itemId: "late-buffer", delta: "late buffered text must be ignored" }),
    ].map((message) => JSON.stringify(message)).join("\n") + "\n");
  } else if (mode === "late-approval") {
    // The completion and an approval request in ONE write: the request arrives after the turn ended
    process.stdout.write([
      notification("turn/completed", { turn: { status: "completed" } }),
      { jsonrpc: "2.0", id: 4242, method: "item/commandExecution/requestApproval", params: { threadId: nativeThreadId, turnId: nativeTurnId, itemId: "late", command: "rm -rf /" } },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n");
  } else if (mode === "split-approval") {
    // The completion plus the FIRST HALF of an approval request, then the rest 400 ms later:
    // the frame begins under this turn and would finish after it ended
    const request = JSON.stringify({ jsonrpc: "2.0", id: 4343, method: "item/commandExecution/requestApproval", params: { threadId: nativeThreadId, turnId: nativeTurnId, itemId: "split", command: "rm -rf /" } });
    const cut = Math.floor(request.length / 2);
    process.stdout.write(JSON.stringify(notification("turn/completed", { turn: { status: "completed" } })) + "\n" + request.slice(0, cut));
    setTimeout(() => process.stdout.write(request.slice(cut) + "\n"), 400);
  } else notify("turn/completed", { turn: { status: "completed" } });
};

// ---- Approval policy and hooks, the way the real app-server honours them (Rules 67, 68) ----------------------------------------
//   FAKE_CODEX_HOOKS       normal (default) | none (hooks/list is not a method: an old build) | dead (the handlers never run: no
//                          SessionStart, no PreToolUse) | dead-runs (the same, but the turn still runs its calls and completes, as a
//                          Codex that carries on past a hook that never ran would) | untrusted-stays (config/batchWrite answers ok and trusts nothing)
//   FAKE_CODEX_TOOLS       JSON array of tool calls the turn makes: {kind: shell|apply_patch|mcp|update_plan|view_image|other, id,
//                          command?, cwd?, patch?, server?, tool?, input?, name?, hook?: false (Codex skips the hook, as when it
//                          fails open), escalate?: true (a sandbox escalation: asked about whatever the hook said)}
//   FAKE_CODEX_ESCALATION  "0": the scripted approval modes (approval, windows-command) are NOT sandbox escalations, so `on-request` asks
//                          nothing for them, as the real one does; by default they stand for an escalation and still ask.
// Under `on-request` a command or file call runs without an approval request; the PreToolUse hook (when hooks.json is trusted and
// features.hooks is on) runs before it. Under `untrusted` and the other policies the approvals are emitted as before.
const escalationAsks = () => process.env.FAKE_CODEX_ESCALATION !== "0";
let policyNow = "";
const noteExecutionPolicy = (params: any) => { if (typeof params?.approvalPolicy === "string") policyNow = params.approvalPolicy; };
const onRequestPolicy = () => policyNow === "on-request" || policyNow === "onRequest";
let hooksListCalls = 0;
const hooksOn = () => process.argv.includes("features.hooks=true") && process.env.FAKE_CODEX_HOOKS !== "none" && Boolean(process.env.CODEX_HOME);
const snakeEvent = (event: string) => event.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase());
type FakeHook = { event: string; key: string; command: string; timeout: number; hash: string; path: string };
const readFakeHooks = (): FakeHook[] => {
  if (!hooksOn()) return [];
  const path = join(process.env.CODEX_HOME!, "hooks.json");
  let doc: any;
  try { doc = JSON.parse(readFileSync(path, "utf8")); } catch { return []; }
  const found: FakeHook[] = [];
  for (const [event, groups] of Object.entries(doc?.hooks ?? {})) {
    (Array.isArray(groups) ? groups : []).forEach((group: any, gi: number) => (Array.isArray(group?.hooks) ? group.hooks : []).forEach((handler: any, hi: number) => {
      if (handler?.type !== "command" || typeof handler.command !== "string") return;
      // Codex runs `command_windows` on Windows when the handler names one
      const command = process.platform === "win32" && typeof handler.command_windows === "string" ? handler.command_windows : handler.command;
      found.push({ event, key: `${path}:${snakeEvent(event)}:${gi}:${hi}`, command, timeout: Number(handler.timeout) || 600, path,
        hash: "sha256:" + createHash("sha256").update(JSON.stringify([event, handler.command, handler.command_windows ?? null, handler.timeout ?? null])).digest("hex") });
    }));
  }
  return found;
};
const hookStatePath = () => join(process.env.CODEX_HOME ?? "", "fake-hooks-state.json");
const readHookState = (): Record<string, { trusted_hash?: string }> => { try { return JSON.parse(readFileSync(hookStatePath(), "utf8")); } catch { return {}; } };
const trustOf = (hook: FakeHook, state = readHookState()) => (state[hook.key]?.trusted_hash === hook.hash ? "trusted" : state[hook.key] ? "modified" : "untrusted");
type HookResult = { kind: "allow" | "deny" | "block" | "none"; reason?: string };
/** Runs every trusted handler of an event, the way Codex does: the payload on stdin, exit 2 blocks, a clean exit allows (or denies when it prints a
 *  deny), anything else is a failed run that Codex continues past. */
const runFakeHooks = async (event: string, payload: Record<string, unknown>): Promise<HookResult> => {
  if (process.env.FAKE_CODEX_HOOKS === "dead" || process.env.FAKE_CODEX_HOOKS === "dead-runs") return { kind: "none" };
  const state = readHookState();
  let result: HookResult = { kind: "none" };
  for (const hook of readFakeHooks().filter((h) => h.event === event && trustOf(h, state) === "trusted")) {
    const outcome = await new Promise<HookResult>((resolve) => {
      // as Codex 0.153.3 does: `%COMSPEC% /C <command>` with the command escaped as one ordinary argument (inner quotes become \")
      const child = spawn(process.platform === "win32" ? process.env.COMSPEC ?? "cmd.exe" : "sh", [process.platform === "win32" ? "/C" : "-c", hook.command], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", () => resolve({ kind: "none" }));
      child.on("close", (code) => {
        if (code === 2) return resolve({ kind: "block", reason: stderr.trim() });
        if (code !== 0) return resolve({ kind: "none" });
        try {
          const out = JSON.parse(stdout)?.hookSpecificOutput;
          if (out?.permissionDecision === "deny") return resolve({ kind: "deny", reason: String(out.permissionDecisionReason ?? "") });
        } catch { /* nothing printed */ }
        // a clean exit is a completed run and the call proceeds (rig, Codex 0.129.0 and 0.163.0: a printed allow is "unsupported", a silent exit is not)
        resolve({ kind: "allow" });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ session_id: nativeThreadId, transcript_path: null, cwd: process.cwd(), hook_event_name: event, model: "fake-codex-model", permission_mode: "default", ...payload }));
    });
    if (outcome.kind === "block" || outcome.kind === "deny") return outcome;
    if (outcome.kind === "allow") result = outcome;
  }
  return result;
};
let sessionStartedFor = "";
/** The SessionStart handlers run when the first turn of a session begins, after the turn/start answer (rig: Codex 0.129.0, 0.163.0). */
//   FAKE_CODEX_SESSION_DELAY_MS  the SessionStart handlers run this long after the turn begins (a late proof)
//   FAKE_CODEX_SESSION_LOG       a line is appended each time the SessionStart handlers run (counted across processes)
//   FAKE_CODEX_INTERRUPT_DELAY_MS  turn/interrupt is answered this long after it arrives (the interrupt stays pending)
//   FAKE_CODEX_EARLY_ITEM        a reasoning item starts before the SessionStart handlers run
const fakeSessionStart = async () => {
  if (!hooksOn() || sessionStartedFor === nativeThreadId) return;
  sessionStartedFor = nativeThreadId;
  if (process.env.FAKE_CODEX_EARLY_ITEM) notify("item/started", { item: { id: "r0", type: "reasoning" } });
  const delay = Number(process.env.FAKE_CODEX_SESSION_DELAY_MS) || 0;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (process.env.FAKE_CODEX_SESSION_LOG) appendFileSync(process.env.FAKE_CODEX_SESSION_LOG, `${process.pid} SessionStart\n`);
  await runFakeHooks("SessionStart", { source: "startup" });
};
type FakeCall = { concurrent?: boolean; delayMs?: number; runAnyway?: boolean; kind: string; id: string; command?: string; cwd?: string; patch?: string; server?: string; tool?: string; input?: unknown; name?: string; hook?: boolean; escalate?: boolean };
const hookNameOf = (call: FakeCall) => call.kind === "shell" ? "Bash" : call.kind === "mcp" ? `mcp__${call.server}__${call.tool}` : call.kind === "other" ? String(call.name) : call.kind;
const hookInputOf = (call: FakeCall): unknown => call.kind === "shell" ? { command: call.command } : call.kind === "apply_patch" ? { command: call.patch } : call.kind === "mcp" ? (call.input ?? {}) : (call.input ?? {});
/** One tool call: the hook first (when it is live and the call is not marked to skip it), then item/started and item/completed.
 *  A denied or blocked call never starts. Returns whether it ran. */
const playFakeCall = async (call: FakeCall): Promise<boolean> => {
  if (hooksOn() && call.hook !== false && onRequestPolicy()) {
    const verdict = await runFakeHooks("PreToolUse", { turn_id: nativeTurnId, tool_name: hookNameOf(call), tool_input: hookInputOf(call), tool_use_id: call.id, cwd: call.cwd ?? process.cwd() });
    hookLog.push({ id: call.id, name: hookNameOf(call), input: hookInputOf(call), verdict: verdict.kind, ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) });
    if ((verdict.kind === "deny" || verdict.kind === "block") && !call.runAnyway) {
      notify("item/completed", { item: { id: call.id, type: call.kind === "shell" ? "commandExecution" : "fileChange", status: "declined", aggregatedOutput: verdict.reason ?? "" } });
      return false;
    }
  }
  const started = call.kind === "shell" ? { id: call.id, type: "commandExecution", command: call.command, cwd: call.cwd ?? process.cwd() }
    : call.kind === "apply_patch" ? { id: call.id, type: "fileChange", changes: [{ path: (/\*\*\* (?:Add|Update|Delete) File: (.+)/.exec(call.patch ?? "")?.[1]) ?? "file", kind: "update" }] }
    : call.kind === "mcp" ? { id: call.id, type: "mcpToolCall", server: call.server, tool: call.tool }
    : null;
  if (started) notify("item/started", { item: started });
  if (call.escalate && started) {
    const answer = await new Promise<any>((resolve) => {
      proposalAsks.set(7000, resolve);
      out({ jsonrpc: "2.0", id: 7000, method: call.kind === "apply_patch" ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval",
        params: { threadId: nativeThreadId, turnId: nativeTurnId, itemId: call.id, ...(call.command ? { command: call.command } : {}), cwd: call.cwd ?? process.cwd(), reason: "needs to leave the sandbox" } });
    });
    decision = answer;
    if (answer?.decision !== "accept") { notify("item/completed", { item: { id: call.id, type: started.type, status: "declined" } }); return false; }
  }
  if (started) notify("item/completed", { item: { id: call.id, type: started.type, status: "completed", exitCode: 0, aggregatedOutput: "" } });
  return true;
};
const playScriptedTurn = async () => {
  await fakeSessionStart();
  // handlers that never ran mean no model request is ever made: the turn just waits for the driver to give up on it
  if (process.env.FAKE_CODEX_HOOKS === "dead" && hooksOn()) return;
  for (const call of JSON.parse(process.env.FAKE_CODEX_TOOLS ?? "[]") as FakeCall[]) {
    if (call.delayMs) await new Promise((resolve) => setTimeout(resolve, call.delayMs));
    // a concurrent call is not waited for: the next one starts while its hook (and any card) is still open
    if (call.concurrent) void playFakeCall(call).then(() => dump());
    else await playFakeCall(call);
  }
  dump();
  notify("item/completed", { item: { id: "m1", type: "agentMessage", text: "done from fake codex" } });
  dump();
  notify("turn/completed", { turn: { status: "completed" } });
};

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
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

    if (!msg.method && proposalAsks.has(msg.id)) { const answered = proposalAsks.get(msg.id)!; proposalAsks.delete(msg.id); answered(msg.result ?? { error: msg.error }); continue; }
    // response to our own server->client request (approval decision)
    if ((msg.id === 100 || msg.id === 101) && (msg.result !== undefined || msg.error !== undefined)) {
      decision = msg.result ?? { error: msg.error };
      finishTurn();
      continue;
    }

    if (msg.method) calls.push({ method: msg.method, params: msg.params ?? null });
    if (msg.method && process.env.FAKE_CODEX_CALL_LOG) appendFileSync(process.env.FAKE_CODEX_CALL_LOG, `${process.pid} ${msg.method}\n`);
    refreshMode();

    switch (msg.method) {
      case "initialize":
        if (process.env.FAKE_CODEX_LAUNCH_SILENT && process.env.FAKE_CODEX_STALE_STDERR_GATE) {
          const initializeId = msg.id;
          process.stderr.write(TRANSIENT_STDERR);
          void waitForGate(process.env.FAKE_CODEX_STALE_STDERR_GATE).then(() => {
            out({ jsonrpc: "2.0", id: initializeId, result: { ok: true } });
          });
          break;
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        break;
      case "hooks/list": {
        if (process.env.FAKE_CODEX_HOOKS === "none") { out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }); break; }
        const cwd = msg.params?.cwds?.[0] ?? process.cwd();
        const listId = msg.id;
        const answerList = () => {
          const state = readHookState();
          out({ jsonrpc: "2.0", id: listId, result: { data: [{ cwd, errors: [], warnings: [], hooks: readFakeHooks().map((h, i) => ({
            key: h.key, eventName: h.event.replace(/^./, (c) => c.toLowerCase()), handlerType: "command", command: h.command, async: false, matcher: null, timeoutSec: h.timeout,
            statusMessage: null, additionalContextLimit: null, sourcePath: h.path, source: "user", pluginId: null, displayOrder: i, enabled: true, isManaged: false,
            currentHash: h.hash, trustStatus: trustOf(h, state) })) }] } });
        };
        // B13: a slow hooks/list (a loaded Windows box). FAKE_CODEX_HOOKS_DELAY_MS delays the answer; FAKE_CODEX_HOOKS_DELAY_COUNT
        // (default: every one) limits it to the first N hooks/list calls of this process.
        hooksListCalls++;
        const listDelay = Number(process.env.FAKE_CODEX_HOOKS_DELAY_MS) || 0;
        const delayedCalls = process.env.FAKE_CODEX_HOOKS_DELAY_COUNT === undefined ? Infinity : Number(process.env.FAKE_CODEX_HOOKS_DELAY_COUNT);
        if (listDelay > 0 && hooksListCalls <= delayedCalls) setTimeout(answerList, listDelay);
        else answerList();
        break;
      }
      case "config/batchWrite": {
        if (process.env.FAKE_CODEX_HOOKS !== "untrusted-stays") {
          const next = readHookState();
          for (const edit of msg.params?.edits ?? []) if (edit?.keyPath === "hooks.state" && edit.value && typeof edit.value === "object") Object.assign(next, edit.value);
          writeFileSync(hookStatePath(), JSON.stringify(next));
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { status: "ok", version: "sha256:fake", filePath: join(process.env.CODEX_HOME ?? "", "config.toml"), overriddenMetadata: null } });
        break;
      }
      case "turn/interrupt": {
        interrupted = true;
        const interruptId = msg.id;
        const answerInterrupt = () => { dump(); out({ jsonrpc: "2.0", id: interruptId, result: {} }); };
        const interruptDelay = Number(process.env.FAKE_CODEX_INTERRUPT_DELAY_MS) || 0;
        if (interruptDelay > 0) setTimeout(answerInterrupt, interruptDelay);
        else answerInterrupt();
        break;
      }
      case "model/list":
        if (msg.params?.cursor === "page-2") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                { id: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false },
                { id: "gpt-page-two", displayName: "GPT Page Two", hidden: false, isDefault: false },
              ],
              nextCursor: null,
            },
          });
        } else {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              data: [
                { id: "gpt-fake-default", displayName: "GPT Fake Default", hidden: false, isDefault: true },
              ],
              nextCursor: "page-2",
            },
          });
        }
        break;
      case "thread/resume": {
        noteExecutionPolicy(msg.params);
        // the effective model and provider, as ThreadResumeResponse requires them (codex 0.163 schema)
        const resumeAnswer = (threadId: unknown) => ({
          thread: { id: threadId },
          ...(process.env.FAKE_CODEX_RESUME_MODEL === "none" ? {} : { model: process.env.FAKE_CODEX_RESUME_MODEL === "stale" ? "stale-model" : msg.params?.model ?? "fake-codex-model" }),
          modelProvider: msg.params?.modelProvider ?? "openai",
        });
        if (process.env.FAKE_CODEX_RESUME_GATE && !existsSync(process.env.FAKE_CODEX_RESUME_GATE)) {
          // a slow start: answer only once the gate file exists
          const resumeId = msg.id, resumeThread = msg.params?.threadId;
          void waitForGate(process.env.FAKE_CODEX_RESUME_GATE).then(() => out({ jsonrpc: "2.0", id: resumeId, result: resumeAnswer(resumeThread) }));
          break;
        }
        if (mode === "resume") {
          out({ jsonrpc: "2.0", id: msg.id, result: resumeAnswer(msg.params?.threadId) });
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "no such thread" } });
        }
        break;
      }
      case "thread/start":
        noteExecutionPolicy(msg.params);
        if (process.env.FAKE_CODEX_LAUNCH_CRASHES || process.env.FAKE_CODEX_LAUNCH_KILLS || process.env.FAKE_CODEX_LAUNCH_SILENT) {
          const launched = countLaunch();
          if (launched < (Number(process.env.FAKE_CODEX_LAUNCH_CRASHES) || 0)) {
            process.stderr.write(TRANSIENT_STDERR, () => process.exit(1));
            break;
          }
          if (launched < (Number(process.env.FAKE_CODEX_LAUNCH_KILLS) || 0)) {
            process.stderr.write(TRANSIENT_STDERR, () => process.kill(process.pid, "SIGKILL"));
            break;
          }
          if (launched < (Number(process.env.FAKE_CODEX_LAUNCH_SILENT) || 0)) {
            process.exit(1);
          }
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "codex-thread-1" }, model: "fake-codex-model" } });
        break;
      case "turn/start": {
        nativeThreadId = msg.params.threadId;
        noteExecutionPolicy(msg.params);
        if (warmMode) nativeTurnId = `turn-${++turnSeq}`;
        if (process.env.FAKE_CODEX_STOP_RACE) {
          const heldId = msg.id;
          process.once("SIGTERM", () => {
            process.stdout.write(
              JSON.stringify({ jsonrpc: "2.0", id: heldId, error: { code: -32603, message: "provider returned 503: upstream capacity exceeded" } }) + "\n",
              () => process.exit(0),
            );
          });
          appendFileSync(process.env.FAKE_CODEX_STOP_RACE, "turn/start\n");
          break;
        }
        if (process.env.FAKE_CODEX_TURNSTART_SILENT) {
          countLaunch();
          const knob = process.env.FAKE_CODEX_TURNSTART_SILENT;
          if (knob === "buffered" || knob === "notify-error") notify("item/reasoning/textDelta", { itemId: "early", delta: "thinking" });
          if (knob === "notify-error") out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "provider returned 503: upstream capacity exceeded" } });
          dump();
          break;
        }
        if (process.env.FAKE_CODEX_TURNSTART_LATE) {
          countLaunch();
          const lateId = msg.id;
          let answered = false;
          process.on("SIGTERM", () => {
            if (answered) return;
            answered = true;
            out({ jsonrpc: "2.0", id: lateId, result: turnResult() });
            notify("item/reasoning/textDelta", { itemId: "late", delta: "late" });
          });
          dump();
          break;
        }
        if (process.env.FAKE_CODEX_PREACK_CRASH) {
          countLaunch();
          const crash = () => process.stderr.write(TRANSIENT_STDERR, () => process.exit(1));
          if (process.env.FAKE_CODEX_PREACK_CRASH === "buffered") {
            process.stdout.write(JSON.stringify(notification("item/agentMessage/delta", { itemId: "early", delta: "early" })) + "\n", crash);
          } else crash();
          break;
        }
        if (process.env.FAKE_CODEX_ACK_CRASH) {
          countLaunch();
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: turnResult() }) + "\n");
          void waitForGate(process.env.FAKE_CODEX_ACK_CRASH).then(() => {
            process.stderr.write(TRANSIENT_STDERR, () => process.exit(1));
          });
          break;
        }
        if (process.env.FAKE_CODEX_EXIT_MID_TURN) {
          countLaunch();
          const ackId = msg.id;
          process.stderr.write("2026-09-14T20:24:19Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 426 Upgrade Required\n");
          void waitForGate(process.env.FAKE_CODEX_EXIT_MID_TURN).then(() => {
            out({ jsonrpc: "2.0", id: ackId, result: turnResult() });
            notify("item/reasoning/textDelta", { itemId: "m1", delta: "still thinking" });
            void waitForGate(process.env.FAKE_CODEX_EXIT_MID_TURN_KILL).then(() => process.kill(process.pid, "SIGKILL"));
          });
          break;
        }
        if (mode.startsWith("parent-")) {
          const ack = { jsonrpc: "2.0", id: msg.id, result: mode === "parent-invalid-ack" ? { ok: true } : turnResult() };
          const foreign = (threadId: string, turnId: string) => [
            notification("item/agentMessage/delta", { threadId, turnId, itemId: "foreign", delta: "FOREIGN" }),
            notification("item/reasoning/textDelta", { threadId, turnId, delta: "FOREIGN" }),
            notification("item/started", { threadId, turnId, item: { id: "foreign", type: "commandExecution", command: "FOREIGN" } }),
            notification("item/completed", { threadId, turnId, item: { id: "foreign", type: "agentMessage", text: "FOREIGN" } }),
            notification("item/completed", { threadId, turnId, item: { id: "foreign", type: "imageGeneration", result: "FOREIGN" } }),
            notification("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { last: { inputTokens: 999, outputTokens: 999 }, total: { inputTokens: 999, outputTokens: 999 } } }),
            notification("error", { threadId, turnId, error: { message: "FOREIGN" } }),
            notification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } }),
          ];
          const parent = [
            notification("item/completed", { item: { id: "parent", type: "agentMessage", text: "parent reply" } }),
            notification("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 11, outputTokens: 2 }, total: { inputTokens: 20, outputTokens: 5 } } }),
            notification("turn/completed", { turn: { status: "completed" } }),
          ];
          let frames: unknown[];
          if (mode === "parent-early") frames = [...parent, ack];
          else if (mode === "parent-overflow") frames = [...Array.from({ length: 257 }, () => parent[0]), ack];
          else if (mode === "parent-invalid-ack") frames = [ack, ...parent];
          // a tool item announced ahead of a turn/start that then fails (OpenMausBot 7045f15a1, adapted)
          else if (mode === "parent-early-tool-fail" || mode === "parent-early-text-fail") {
            const early = mode === "parent-early-tool-fail"
              ? notification("item/started", { item: { id: "early-tool", type: "commandExecution", command: "touch report.md" } })
              : notification("item/agentMessage/delta", { itemId: "early-text", delta: "early words" });
            frames = [early, { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "turn could not start" } }];
          }
          else {
            frames = [
              ...foreign("helper-thread", "helper-turn"),
              ...foreign(nativeThreadId, "old-turn"),
              ack,
              ...foreign("helper-thread", nativeTurnId),
              ...foreign(nativeThreadId, "helper-turn"),
              { method: "item/agentMessage/delta", params: { delta: "UNIDENTIFIED" } },
              { method: "turn/completed", params: { turn: { status: "completed" } } },
              { method: "error", params: { message: "connection diagnostic" } },
            ];
            if (mode === "parent-approval") {
              frames.push({ id: 100, method: "item/commandExecution/requestApproval", params: { threadId: "helper-thread", turnId: "helper-turn", itemId: "helper-command", command: "helper command" } });
            } else frames.push(...parent);
          }
          dump();
          // Deliberately one write: Promise continuation cannot be used to
          // bind identity before the parser consumes the following frame.
          process.stdout.write(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
          break;
        }
        if (mode === "transient-503") {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "provider returned 503: upstream capacity exceeded" } });
          break;
        }
        if (mode === "safety-rejection") {
          dump();
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "429 request blocked by our safety systems" } });
          break;
        }
        if (mode === "unauthorized") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
            },
          });
          break;
        }
        if (mode === "terminal-error" || mode === "terminal-error-duplicate") {
          out({ jsonrpc: "2.0", id: msg.id, result: turnResult() });
          const message = "Provider rejected the request";
          if (mode === "terminal-error-duplicate") notify("error", { message });
          notify("turn/completed", { turn: { status: "failed", error: { message } } });
          break;
        }
        // transient-failure script for retry tests. FAKE_CODEX_TRANSIENTS is
        // how many launches fail transiently; the launch count lives in a
        // state FILE because child processes cannot mutate the parent's env.
        // FAKE_CODEX_PARTIAL_FAILS makes the FIRST failing turn stream a text
        // delta first, so the partial-output guard has something to see.
        if (process.env.FAKE_CODEX_TRANSIENTS && process.env.FAKE_CODEX_STATE) {
          let launched = 0;
          try {
            launched = Number(readFileSync(process.env.FAKE_CODEX_STATE, "utf8")) || 0;
          } catch {}
          const quota = Number(process.env.FAKE_CODEX_TRANSIENTS) || 0;
          writeFileSync(process.env.FAKE_CODEX_STATE, String(launched + 1));
          if (launched < quota) {
            if (process.env.FAKE_CODEX_PARTIAL_FAILS) {
              out({ jsonrpc: "2.0", id: msg.id, result: turnResult() });
              notify("item/agentMessage/delta", { itemId: "m1", delta: "half an answer" });
              notify("turn/completed", { turn: { status: "failed", error: { message: "provider overloaded, try again" } } });
              break;
            }
            out({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32603, message: "provider returned 503: upstream capacity exceeded" },
            });
            break;
          }
        }
        out({ jsonrpc: "2.0", id: msg.id, result: turnResult() });
        if (process.env.FAKE_CODEX_TOOLS) { void playScriptedTurn(); break; }
        // the SessionStart handlers run as the first turn of a session begins, on every turn shape (once per session)
        void fakeSessionStart();
        // Bounded-ingress fixtures (A4), keyed on the prompt text.
        const promptText = String(msg.params?.input?.[0]?.text ?? "");
        // lane review: a review run answers with its verdict (fake-review.ts)
        const reviewText = fakeReviewReply(promptText);
        if (reviewText !== null) {
          notify("item/completed", { item: { id: "m1", type: "agentMessage", text: reviewText } });
          notify("turn/completed", { turn: { status: "completed" } });
          break;
        }
        if (fixtureRequested(promptText, "__fixture_subagents__")) {
          void playSubagents((id, method, params) => new Promise<any>(resolve => { proposalAsks.set(id, resolve); out({ jsonrpc: "2.0", id, method, params }); }));
          break;
        }
        // FAKE_CUSTOM_TOOL_SERVER (fake-custom-tool.ts): call the first tool of
        // that owner server, started from its -c mcp_servers overrides.
        const customServer = customToolServer(promptText);
        if (customServer) {
          const launch = mountedServer(customServer);
          void (async () => {
            const outcome = launch
              ? await callFirstCustomTool("codex", customServer, launch, promptText)
              : { tools: [], text: `no ${customServer} server was mounted`, isError: true };
            notify("item/completed", { item: { id: "m1", type: "agentMessage", text: customToolReply(outcome) } });
            notify("turn/completed", { turn: { status: "completed" } });
          })();
          break;
        }
        if (mode === "text-propose" && promptText.includes("<murage-project-proposal")) {
          // Lane N2: the Chief answers with the proposal block, after asking to run a command
          dump();
          void new Promise<unknown>(resolve => {
            proposalAsks.set(9401, resolve);
            out({ jsonrpc: "2.0", id: 9401, method: "item/commandExecution/requestApproval", params: { threadId: nativeThreadId, turnId: nativeTurnId, itemId: "t-cmd", command: "cat /etc/hosts" } });
          }).then(command => {
            logProposalTurn({ engine: "codex", asks: { command }, agentsMounted: mountedAgents() !== null });
            notify("item/completed", { item: { id: "m1", type: "agentMessage", text: proposalReply(promptText) } });
            dump();
            notify("turn/completed", { turn: { status: "completed" } });
          });
          break;
        }
        if (mode === "project-propose" && promptText.includes("project_propose")) {
          // The Chief's New project proposal (lane N), through the mounted agents server
          const agents = mountedAgents();
          dump();
          const say = (text: string) => { notify("item/completed", { item: { id: "m1", type: "agentMessage", text } }); dump(); notify("turn/completed", { turn: { status: "completed" } }); };
          if (!agents) { say("propose error: no agents server"); break; }
          // As codex asks under `untrusted`: a command, then the MCP tool approval for the propose call.
          const ask = (id: number, method: string, params: Record<string, unknown>) => new Promise<unknown>(resolve => {
            proposalAsks.set(id, resolve);
            out({ jsonrpc: "2.0", id, method, params });
          });
          void (async () => ({
            command: await ask(9301, "item/commandExecution/requestApproval", { threadId: nativeThreadId, turnId: nativeTurnId, itemId: "p-cmd", command: "cat /etc/hosts" }),
            mcp: await ask(9302, "mcpServer/elicitation/request", { threadId: nativeThreadId, turnId: nativeTurnId, serverName: "agents", mode: "form",
              message: 'Allow the agents MCP server to run tool "project_propose"?', requestedSchema: { type: "object", properties: {} },
              _meta: { codex_approval_kind: "mcp_tool_call", tool_params: proposalFrom(promptText) } }),
          }))()
            .then(asks => proposeThroughMcp(agents, promptText, { asks }))
            .then(say, (error: Error) => say(`propose error: ${error.message}`));
          break;
        }
        if (fixtureRequested(promptText, "__fixture_oversize_frame__")) {
          // a VALID frame one KiB over the limit, then a clean completion
          notify("item/agentMessage/delta", { itemId: "big", delta: fixtureOversizeText() });
          finishTurn();
          break;
        }
        if (fixtureRequested(promptText, "__fixture_oversize_open_frame__")) {
          process.stdout.write(`{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"itemId":"big","delta":"${fixtureOversizeText()}`);
          break;
        }
        // An MCP tool answering with an image, MCP-native shape, alongside
        // Murage's own computer surface — whose frame must not be retained.
        if (fixtureRequested(promptText, "__fixture_mcp_tool_image__")) {
          notify("item/completed", {
            item: { id: "mcp1", type: "mcpToolCall", status: "completed", server: "omarchy", tool: "screenshot",
              result: { content: [{ type: "text", text: "captured" }, { type: "image", data: FIXTURE_TOOL_IMAGE, mimeType: "image/png" }] } },
          });
          notify("item/completed", {
            item: { id: "mcp2", type: "mcpToolCall", status: "completed", server: "computer", tool: "screenshot",
              result: { content: [{ type: "image", data: FIXTURE_SCREEN_IMAGE, mimeType: "image/png" }] } },
          });
          finishTurn();
          break;
        }
        if (fixtureRequested(promptText, "__fixture_large_frame__")) {
          notify("item/completed", {
            item: { id: "img-large", type: "imageGeneration", status: "completed", result: fixtureLargeImageBase64(), revisedPrompt: "large" },
          });
          finishTurn();
          break;
        }
        const command = mode === "windows-command"
          ? [
              "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
              "-Command",
              `\"Get-Content -Raw -LiteralPath 'C:\\Users\\Ada\\workspaces\\${"very-long-folder\\".repeat(8)}NOTES.md'\"`,
            ].join(" ")
          : mode === "action-guard" ? "printf hello > notes.txt" : "ls -la";
        // Gated: the call goes through the hook first, as Codex runs it; a command Codex would ask about is a sandbox escalation only.
        if (onRequestPolicy() && hooksOn() && !["mcp-elicitation", "form-elicitation", "user-input"].includes(mode)) {
          const approvalMode = mode === "approval" || mode === "windows-command";
          void (async () => {
            await fakeSessionStart();
            await playFakeCall({ kind: "shell", id: "i1", command: approvalMode && mode !== "windows-command" ? "rm -rf scratch" : command, escalate: approvalMode && escalationAsks() });
            notify("item/started", { item: { id: "w1", type: "webSearch", query: "Murage" } });
            finishTurn();
          })();
          break;
        }
        notify("item/started", { item: { id: "i1", type: "commandExecution", command } });
        notify("item/started", { item: { id: "w1", type: "webSearch", query: "Murage" } });
        if (mode === "mcp-elicitation") {
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: process.env.FAKE_CODEX_MCP_SERVER ?? "agents",
              mode: "form",
              _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { bot: "lena", limit: 3 } },
              message: `Allow the ${process.env.FAKE_CODEX_MCP_SERVER ?? "agents"} MCP server to run tool "${process.env.FAKE_CODEX_MCP_TOOL ?? "list_bots"}"?`,
              requestedSchema: { type: "object", properties: {} },
            },
          });
        } else if (mode === "form-elicitation") {
          // A plain MCP form elicitation: the server asks the OWNER for input
          // (no codex_approval_kind), which is a question, not a tool approval.
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "deployer",
              mode: "form",
              message: "Which environment should I deploy to?",
              requestedSchema: {
                type: "object",
                properties: { environment: { type: "string", enum: ["staging", "production"] } },
                required: ["environment"],
              },
            },
          });
        } else if (mode === "user-input") {
          // EXPERIMENTAL item/tool/requestUserInput exactly as codex-rs
          // v2/item.rs shapes it: several questions, each with its own id,
          // header and options; one secret, one free-text-only, one that
          // also takes the owner's own words.
          out({
            jsonrpc: "2.0",
            id: 101,
            method: "item/tool/requestUserInput",
            params: {
              threadId: "codex-thread-1",
              turnId: "turn-1",
              itemId: "call-rui-1",
              isBlocking: true,
              questions: [
                {
                  id: "db",
                  header: "Database",
                  question: "Which database should the service use?",
                  isOther: false,
                  isSecret: false,
                  options: [
                    { label: "Postgres", description: "Relational, durable" },
                    { label: "Redis", description: "In-memory, fast" },
                  ],
                },
                {
                  id: "token",
                  header: "Token",
                  question: "Paste the deploy token",
                  isOther: false,
                  isSecret: true,
                  options: null,
                },
                {
                  id: "region",
                  header: "Region",
                  question: "Which region?",
                  isOther: true,
                  isSecret: false,
                  options: [{ label: "eu-west", description: "Ireland" }],
                },
              ],
            },
          });
        } else if (mode === "async-question" && askAsyncOnce()) {
          // request_user_input_async as codex-cli 0.163.0 sends it: an agentMessage with `delivery: "async"` and
          // `questions: [{title, options}]`; no server request follows and the turn keeps running.
          const item = {
            type: "agentMessage",
            id: "call_async_question",
            text: "Which source should I use?",
            phase: "final_answer",
            memoryCitation: null,
            delivery: "async",
            questions: process.env.FAKE_CODEX_ASYNC_QUESTIONS
              ? JSON.parse(process.env.FAKE_CODEX_ASYNC_QUESTIONS)
              : [{ title: "Which source should I use?", options: ["The docs", "The code"] }],
          };
          notify("item/started", { item, startedAtMs: Date.now() });
          notify("item/completed", { item, completedAtMs: Date.now() });
          const gate = process.env.FAKE_CODEX_ASYNC_QUESTION_GATE;
          void waitForGate(gate, gate ? 30_000 : 300).then(() => finishTurn());
        } else if ((mode === "approval" || mode === "windows-command") && (!onRequestPolicy() || escalationAsks())) {
          const approvalCommand = mode === "windows-command" ? command : "rm -rf scratch";
          // FAKE_CODEX_APPROVAL = {method, params} replaces the default legacy shell ask
          const custom = process.env.FAKE_CODEX_APPROVAL ? JSON.parse(process.env.FAKE_CODEX_APPROVAL) : null;
          out({ jsonrpc: "2.0", id: 100, method: custom?.method ?? "execCommandApproval", params: custom?.params ?? { command: approvalCommand } });
          // turn continues from the approval response handler above
        } else {
          finishTurn();
        }
        break;
      }
      // Command turns (codex-cli 0.156 v2 protocol, `codex app-server
      // generate-ts`). skills/list answers `{}` unless FAKE_CODEX_SKILLS
      // (a JSON SkillMetadata[]) is set, so older tests see no report.
      case "skills/list":
        if (process.env.FAKE_CODEX_SKILLS_BATCHED) batched = [];
        out({
          jsonrpc: "2.0",
          id: msg.id,
          result: process.env.FAKE_CODEX_SKILLS
            ? { data: [{ cwd: msg.params?.cwds?.[0] ?? "", skills: JSON.parse(process.env.FAKE_CODEX_SKILLS), errors: [] }] }
            : {},
        });
        break;
      case "review/start":
        nativeThreadId = msg.params.threadId;
        out({ jsonrpc: "2.0", id: msg.id, result: { ...turnResult(), reviewThreadId: nativeThreadId } });
        notify("item/started", { item: { id: "rv1", type: "enteredReviewMode", review: "current changes" } });
        notify("item/completed", { item: { id: "rv2", type: "exitedReviewMode", review: "FAKE_REVIEW no issues found" } });
        dump();
        notify("turn/completed", { turn: { status: "completed" } });
        break;
      case "thread/compact/start":
        nativeThreadId = msg.params.threadId;
        out({ jsonrpc: "2.0", id: msg.id, result: {} });
        notify("turn/started", { turn: { status: "inProgress" } });
        notify("item/started", { item: { id: "cc1", type: "contextCompaction" } });
        notify("item/completed", { item: { id: "cc1", type: "contextCompaction" } });
        dump();
        notify("turn/completed", { turn: { status: "completed" } });
        break;
      default:
        if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});

// match the real app-server: stay alive until killed
setInterval(() => {}, 1_000);
