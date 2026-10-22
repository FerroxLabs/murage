// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Antigravity at Auto and Full access (lanes/release103/AGY-AUTO-DESIGN.md). agy's print mode has no permission
// channel, so these turns run `--dangerously-skip-permissions` with one Murage hooks.json PreToolUse hook (matcher
// "*") that relays every tool call to Murage before it runs. The driver files each call as an ordinary
// `request.opened` permission ask, so the same broker that answers Cursor's asks decides it (stop line, key guard,
// grants, cards), and the hook prints that answer. Proven on agy 1.4.4: the hook runs before run_command, read_file
// and call_mcp_tool; a deny keeps the tool from running; a hook that fails blocks the tool; a hooks.json agy cannot
// parse loads no hooks at all, so the turn's prompt is written only after agy's log shows the hook loaded.
import { lstatSync, readdirSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { McpMountRecord } from "../../shared/mount-identity.ts";
import { SENSITIVE_PATHS } from "../../shared/sensitive-paths.ts";
import { removeTreeWithoutFollowing } from "../link-removal.ts";
import { CodexHookGate, HOOK_ASK_BOUND_MS, HOOK_SCRIPT_DEADLINE_MS, HOOK_TIMEOUT_SEC, hookSocketPath, newHookToken, type HookAnswer, type HookDelivery } from "./codex-hook.ts";

export { HOOK_ASK_BOUND_MS as ANTIGRAVITY_RELAY_ASK_MS };

const RELAY_SCRIPT = "murage-agy-relay.cjs";
const RELAY_ENV = "murage-agy-relay.env";
export const ANTIGRAVITY_RELAY_LOG = "agy.log";

/** The relay hook program. It can only print allow, or deny with a reason: anything it cannot finish is a deny,
 *  and agy blocks a tool whose hook denies or fails. The socket and the turn's token come from the env file beside
 *  it, never from argv or hooks.json. */
export const ANTIGRAVITY_RELAY_SCRIPT = `"use strict";
// Murage pre-tool relay for Antigravity. Generated; do not edit.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const out = (answer) => { try { process.stdout.write(JSON.stringify(answer)); } catch {} process.exit(0); };
const deny = (why) => out({ decision: "deny", reason: "Murage did not allow this call: " + String(why).slice(0, 300) });
try {
  setTimeout(() => deny("the check took too long"), ${HOOK_SCRIPT_DEADLINE_MS}).unref();
  const env = {};
  for (const line of fs.readFileSync(path.join(__dirname, ${JSON.stringify(RELAY_ENV)}), "utf8").split("\\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  if (!env.SOCKET || !env.TOKEN) deny("no socket");
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("error", () => deny("no input"));
  process.stdin.on("end", () => {
    let call;
    try { call = JSON.parse(raw); } catch { return deny("the call could not be read"); }
    const tool = call && call.toolCall;
    if (!tool || typeof tool.name !== "string") return deny("the call names no tool");
    const message = { kind: "pretool", token: env.TOKEN, tool_name: tool.name, tool_input: tool.args, tool_use_id: String(call.conversationId) + ":" + String(call.stepIdx), turn_id: call.conversationId };
    const socket = net.connect(env.SOCKET);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\\n"));
    socket.on("data", (d) => {
      data += d;
      const at = data.indexOf("\\n");
      if (at < 0) return;
      socket.destroy();
      let answer;
      try { answer = JSON.parse(data.slice(0, at)); } catch { return deny("no usable answer"); }
      if (answer && answer.decision === "allow") return out({ decision: "allow" });
      if (answer && answer.decision === "deny") return out({ decision: "deny", reason: String(answer.reason || "Murage did not allow this call").slice(0, 2000) });
      deny("no usable answer");
    });
    socket.on("error", () => deny("Murage could not be reached"));
    socket.on("close", () => deny("Murage could not be reached"));
  });
} catch (error) {
  deny(error && error.message ? error.message : "failed");
}
`;

/** The hooks.json a relayed turn's scoped home carries. Same launch form as the Ask hook (antigravity.ts): agy runs
 *  a hook through `sh -c` (Windows `cmd /c`, which keeps an outer pair of quotes). */
export function antigravityRelayHooksJson(scriptPath: string, execPath = process.execPath, platform: NodeJS.Platform = process.platform): string {
  const forward = (p: string) => (platform === "win32" ? p.replace(/\\/g, "/") : p);
  const quoted = `"${forward(execPath)}" "${forward(scriptPath)}"`;
  const command = platform === "win32" ? `"${quoted}"` : quoted;
  return `${JSON.stringify({ "murage-relay": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SEC }] }] } }, null, 2)}\n`;
}

/** agy's own start-up line (hooks_manager.go, agy 1.4.4): how many named hooks it loaded, from how many files. */
const LOADED_LINE = /loaded (\d+) named hooks from (\d+) hooks\.json file\(s\)/;
/** agy's lines for a hooks.json it could not read, find or parse. One that names Murage's own hooks.json refuses the
 *  turn. */
const HOOK_FILE_FAILED = /(?:failed to parse hooks\.json|failed to read hooks\.json|Failed to load JSON config file[^\n]*hooks\.json|Failed to parse hooks file|No hooks\.json found at)[^\n]*/gi;
/** Any hooks.json path agy's log names. */
const HOOK_PATH = /(?:[A-Za-z]:)?[\\/][^\s"'`:;,()<>]*hooks\.json/gi;

/** The customization roots agy 1.4.4 reads in a workspace folder (the turn's folder and every `--add-dir`). */
export const ANTIGRAVITY_WORKSPACE_ROOTS = [".agents", ".agent", "_agents", "_agent"] as const;

/** Does a custom agent file carry a `hooks:` key in its front matter? A file that cannot be read, or whose front
 *  matter never closes, is read as one that does. */
function agentFileHasHooks(path: string): boolean {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return true; }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return false;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  const front = close < 0 ? lines.slice(1) : lines.slice(1, close);
  return front.some((line) => /^\s*["']?hooks["']?\s*:/i.test(line));
}

/** Every hooks source agy 1.4.4 reads in these workspace folders (the turn's folder and every `--add-dir`) beside
 *  Murage's own hook: in each customization root, its hooks.json; its plugins.json (every path it names is read as a
 *  plugin folder, anywhere on disk); plugins/<name>/hooks.json where plugins/<name>/plugin.json is present; and a
 *  custom agent, agents/*.md, whose front matter carries `hooks:`. A link, even one that leads nowhere, counts, and
 *  a folder Murage cannot list counts as holding one. agy has no switch to leave these out, so a turn that finds one
 *  does not run at Auto or Full access. */
export function antigravityWorkspaceHookFiles(dirs: readonly string[]): string[] {
  const present = (path: string) => {
    try { lstatSync(path); return true; } catch { return false; }
  };
  const list = (path: string): string[] | null => {
    try { return readdirSync(path); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? [] : null;
    }
  };
  const found: string[] = [];
  for (const dir of new Set(dirs.map((d) => resolve(d)))) {
    for (const root of ANTIGRAVITY_WORKSPACE_ROOTS) {
      const at = join(dir, root);
      if (!present(at)) continue;
      for (const name of ["hooks.json", "plugins.json"]) if (present(join(at, name))) found.push(join(at, name));
      const plugins = list(join(at, "plugins"));
      if (plugins === null) found.push(join(at, "plugins"));
      for (const plugin of plugins ?? []) {
        const hooks = join(at, "plugins", plugin, "hooks.json");
        if (present(hooks) && present(join(at, "plugins", plugin, "plugin.json"))) found.push(hooks);
      }
      const agents = list(join(at, "agents"));
      if (agents === null) found.push(join(at, "agents"));
      for (const name of agents ?? []) {
        if (name.toLowerCase().endsWith(".md") && agentFileHasHooks(join(at, "agents", name))) found.push(join(at, "agents", name));
      }
    }
  }
  return found;
}

/** What the hook-load check expects: Murage's own hooks.json, and the workspace folders agy reads hooks from. */
export interface RelayHookExpect { hooksPath: string; workspaceDirs: readonly string[] }

/** "foreign": a hooks file that is not Murage's is in a workspace folder, or agy's log names one; `file` names it. */
export type RelayHookLoad = { state: "loaded" | "refused" | "pending" } | { state: "foreign"; file: string };

const sameFileText = (text: string) => text.replace(/\\/g, "/").toLowerCase();

/** What agy's log says about the hook so far. Exact: agy loaded exactly one named hook from exactly one hooks.json,
 *  every hooks.json path the log names is Murage's own, nothing names a failure of Murage's file, and no other hooks
 *  file is in a workspace folder agy reads (checked again here, as the log is read). A count alone never passes:
 *  a project's `.agents/hooks.json` by itself also logs "loaded 1 named hooks from 1 hooks.json file(s)". */
export function relayHookLoadState(log: string, expect: RelayHookExpect): RelayHookLoad {
  const own = sameFileText(expect.hooksPath);
  if ((log.match(HOOK_FILE_FAILED) ?? []).some((line) => sameFileText(line).includes(own))) return { state: "refused" };
  // a path with a space in it is read from its last space on, so a tail of Murage's own path is Murage's
  const named = (log.match(HOOK_PATH) ?? []).find((path) => !own.endsWith(sameFileText(path)));
  if (named) return { state: "foreign", file: named };
  const workspace = antigravityWorkspaceHookFiles(expect.workspaceDirs);
  if (workspace.length) return { state: "foreign", file: workspace[0]! };
  const loaded = LOADED_LINE.exec(log);
  if (!loaded) return { state: "pending" };
  return { state: Number(loaded[1]) === 1 && Number(loaded[2]) === 1 ? "loaded" : "refused" };
}

/** How long a relayed turn waits for agy's log to show the hook loaded before it refuses the turn. */
export const ANTIGRAVITY_HOOK_LOAD_MS = 30_000;

/** Wait for agy's log to show the hook loaded. Resolves with anything else it shows, or "refused" when it shows
 *  nothing in time. */
export function awaitRelayHookLoaded(logPath: string, expect: RelayHookExpect, isGone: () => boolean, limitMs = ANTIGRAVITY_HOOK_LOAD_MS): Promise<Exclude<RelayHookLoad, { state: "pending" }>> {
  const started = Date.now();
  return new Promise((done) => {
    const look = () => {
      let log = "";
      try { log = readFileSync(logPath, "utf8"); } catch { log = ""; }
      const result = relayHookLoadState(log, expect);
      if (result.state !== "pending") return done(result as Exclude<RelayHookLoad, { state: "pending" }>);
      if (isGone() || Date.now() - started >= limitMs) return done({ state: "refused" });
      setTimeout(look, 50).unref?.();
    };
    look();
  });
}

/** The tools whose arguments Murage reads as they are: reads, and file edits by path. Anything else agy may run
 *  (a renamed tool in a new agy, browser, notebook, subagent, workflow tools) is filed unread, so the broker holds
 *  it for the owner at every level. */
const READ_TOOLS = new Set([
  "read_file", "view_file", "list_dir", "list_directory", "grep_search", "find_by_name", "view_file_outline",
  "view_code_item", "view_content_chunk", "search_web", "read_url_content", "read_resource", "list_resources",
  "command_status", "list_permissions", "wait", "wait_5_seconds", "finish",
]);
const EDIT_TOOLS = new Set(["write_to_file", "write_file", "replace_file_content", "multi_replace_file_content"]);
const PATH_KEYS = ["TargetFile", "AbsolutePath", "Path", "FilePath", "File", "DirectoryPath", "SearchPath"];

export interface RelayAsk {
  tool: string;
  summary: string;
  toolCall: { name: string; input: unknown };
  toolIdentity?: { namespace: string; name: string };
  filePaths?: string[];
  /** Set when Murage cannot read the call whole: the broker then holds it for the owner (Rule 55). */
  toolInputMissing?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const firstString = (o: Record<string, unknown>, keys: readonly string[]) => keys.map((k) => o[k]).find((v): v is string => typeof v === "string" && v !== "");

/** A folder agy was told to run a command in, judged against the bot's folder. Inside it (links followed) the stop
 *  line reads the command from the bot's folder no less strictly; anywhere else, or unreadable, it is held. */
function cwdInside(dir: string, cwd: string): boolean {
  try {
    const real = realpathSync(isAbsolute(dir) ? dir : resolve(cwd, dir));
    const root = realpathSync(cwd);
    const rel = relative(root, real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

/** A path as the self-guard compares it: `/` separators, lower case, no trailing separator. */
const guardForm = (text: string) => text.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");

/** The spellings of the relay's own folder a call must not name: the turn's folder, the folder every turn's relay
 *  lives in, each as written and where links land, that folder's own name, and the hook's own file names. */
function ownNeedles(ownDir: string): string[] {
  const dirs = [ownDir, dirname(ownDir)];
  for (const dir of [...dirs]) {
    try { dirs.push(realpathSync(dir)); } catch { /* not there yet: the written spelling still counts */ }
  }
  return [...new Set([...dirs.map(guardForm), "native/antigravity-relay", guardForm(RELAY_SCRIPT), guardForm(RELAY_ENV)])].filter((needle) => needle.length > 0);
}

/** A workspace hooks file agy would load on the next turn (antigravityWorkspaceHookFiles), or its root folder named as
 *  a target: the agy-workspace-hooks row of shared/sensitive-paths.ts itself. */
const WORKSPACE_HOOK_TEXT = SENSITIVE_PATHS.find((row) => row.id === "agy-workspace-hooks")!.re;

/** How many strings of a call's arguments the self-guard reads before it calls the call unread. */
const OWN_SCAN_STRINGS = 10_000;

/** Does any string in the call's arguments name the relay's own folder or files? `null` when the arguments run past
 *  what it reads, which is held the same way. */
function namesOwnDir(args: unknown, needles: readonly string[]): boolean | null {
  const stack: unknown[] = [args];
  let seen = 0;
  while (stack.length) {
    const value = stack.pop();
    if (++seen > OWN_SCAN_STRINGS) return null;
    if (typeof value === "string") {
      const text = guardForm(value);
      if (needles.some((needle) => text.includes(needle)) || WORKSPACE_HOOK_TEXT.test(value)) return true;
    } else if (Array.isArray(value)) stack.push(...value);
    else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) stack.push(key, inner);
  }
  return false;
}

/** One relayed call as the permission ask the broker reads (server/stop-line.ts, server/auto-approve.ts). `ownDir`
 *  is this turn's relay folder: a call whose arguments name it (or the relay's files) could replace the check that
 *  judges every later call, so it is filed unread and the broker holds it for the owner at every level. So is a call
 *  that names a workspace hooks file agy would load beside Murage's on the next turn. */
export function antigravityRelayAsk(delivery: HookDelivery, cwd: string, ownDir?: string): RelayAsk {
  const name = typeof delivery.tool_name === "string" ? delivery.tool_name : "";
  const args = delivery.tool_input;
  const unread = (why: string, summary = name || "a tool"): RelayAsk => ({ tool: name || "unknown", summary, toolCall: { name: name || "unknown", input: isObject(args) ? args : {} }, toolInputMissing: why });
  if (!name) return unread("the tool's name");
  if (!isObject(args)) return unread("the tool's arguments");
  if (ownDir !== undefined) {
    const named = namesOwnDir(args, ownNeedles(ownDir));
    const summary = (typeof args.CommandLine === "string" && args.CommandLine) || name;
    if (named === null) return unread("the call's arguments run past what Murage's self-check reads", summary);
    if (named) return unread("a path that holds Murage's check, or a hooks file Antigravity would load beside it", summary);
  }
  if (name === "run_command") {
    const command = args.CommandLine;
    if (typeof command !== "string" || !command) return unread("CommandLine");
    const dir = firstString(args, ["Cwd", "cwd", "WorkingDirectory"]);
    if (dir !== undefined && !cwdInside(dir, cwd)) return { ...unread(`a command folder outside the bot's folder (${dir.slice(0, 200)})`, command), tool: "run_command", toolCall: { name: "run_command", input: { command, cwd: dir } } };
    return { tool: "run_command", summary: command, toolCall: { name: "run_command", input: { command } } };
  }
  if (name === "send_command_input") {
    // text typed into a command that is already running is read as a command of its own
    const text = firstString(args, ["Input", "input", "Text", "text"]);
    if (text === undefined) return unread("Input");
    return { tool: "run_command", summary: text, toolCall: { name: "run_command", input: { command: text } } };
  }
  if (name === "call_mcp_tool") {
    const server = args.ServerName;
    const tool = args.ToolName;
    if (typeof server !== "string" || !server || typeof tool !== "string" || !tool) return unread("ServerName and ToolName");
    const input = args.Arguments === undefined ? {} : args.Arguments;
    if (!isObject(input)) return unread("Arguments");
    const full = `mcp__${server}__${tool}`;
    return { tool: full, summary: `${server}: ${tool}`, toolCall: { name: full, input }, toolIdentity: { namespace: "mcp", name: `${server}__${tool}` } };
  }
  if (READ_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
    const paths = PATH_KEYS.map((k) => args[k]).filter((v): v is string => typeof v === "string" && v !== "");
    const summary = paths.length ? `${name} ${paths.join(" ")}` : name;
    return { tool: name, summary, toolCall: { name, input: args }, ...(EDIT_TOOLS.has(name) && paths.length ? { filePaths: paths } : {}) };
  }
  return unread(`a tool Murage does not read (${name})`);
}

/** Rule 54: one record per server this turn mounted into agy. */
export function antigravityMountRecords(servers: Record<string, unknown>, keys: { computer: string; agents: string }): McpMountRecord[] {
  const records: McpMountRecord[] = [];
  for (const name of Object.keys(servers)) {
    if (name.includes("__")) continue;
    if (name === keys.computer) records.push({ engineName: name, mountId: "own:computer", provenance: "own" });
    else if (name === keys.agents) records.push({ engineName: name, mountId: "own:agents", provenance: "own" });
    else records.push({ engineName: name, mountId: `custom:${name}`, provenance: "custom" });
  }
  return records;
}

/** The folder every turn's relay folder lives in, under DATA_DIR/native. */
const RELAY_ROOT_NAME = "antigravity-relay";

/** Remove one turn's relay folder: only a single plain segment directly inside a folder named antigravity-relay
 *  (DATA_DIR/native/antigravity-relay/<thread>-<turn>), so a wrong `dir` can never reach DATA_DIR or anything above
 *  it. Nothing is handed to a recursive remove that follows links: a link inside is removed as a link. */
function removeRelayDir(dir: string): void {
  const own = resolve(dir);
  if (basename(dirname(own)) !== RELAY_ROOT_NAME || !/^[\w-]{1,120}$/.test(basename(own))) throw new Error(`the relay folder is not one turn's folder under ${RELAY_ROOT_NAME}: ${dir}`);
  removeTreeWithoutFollowing(own);
}

export interface AntigravityRelay {
  /** The hooks.json the scoped home carries. */
  hooksJson: string;
  /** agy's `--log-file` for this turn, read for the hook-load line. */
  logPath: string;
  /** Whether the relay answered this step (`<conversation>:<step>`) before agy ran it. */
  answered(step: string): boolean;
  close(): void;
}

/** Open one turn's relay: the socket, the hook program and its env file, written under `dir` (Murage's own folder,
 *  outside the scoped home, so nothing of it is ever adopted into the owner's home) and read back byte for byte.
 *  Throws when any of that fails; the caller then runs the turn in accept-edits with no tools. */
export async function openAntigravityRelay(dir: string, onPreTool: (delivery: HookDelivery) => Promise<HookAnswer>, execPath = process.execPath): Promise<AntigravityRelay> {
  const token = newHookToken();
  const gate = new CodexHookGate(hookSocketPath());
  const seen = new Set<string>();
  removeRelayDir(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    await gate.listen();
    const script = join(dir, RELAY_SCRIPT);
    const env = join(dir, RELAY_ENV);
    const envText = `SOCKET=${gate.path}\nTOKEN=${token}\n`;
    writeFileSync(script, ANTIGRAVITY_RELAY_SCRIPT, { mode: 0o600 });
    writeFileSync(env, envText, { mode: 0o600 });
    if (readFileSync(script, "utf8") !== ANTIGRAVITY_RELAY_SCRIPT || readFileSync(env, "utf8") !== envText) throw new Error("the relay hook did not read back as written");
    gate.arm({
      token,
      onSession: () => {},
      onPreTool: (delivery) => {
        if (typeof delivery.tool_use_id === "string" && seen.size < 100_000) seen.add(delivery.tool_use_id);
        return onPreTool(delivery);
      },
    });
    return {
      hooksJson: antigravityRelayHooksJson(script, execPath),
      logPath: join(dir, ANTIGRAVITY_RELAY_LOG),
      answered: (step) => seen.has(step),
      close: () => {
        gate.close();
        removeRelayDir(dir);
      },
    };
  } catch (error) {
    gate.close();
    try { removeRelayDir(dir); } catch { /* the open failure below is the one to report */ }
    throw error;
  }
}
