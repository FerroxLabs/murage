// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Codex pre-execution gate (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md Rules 67 and 68).
//
// Codex runs a `PreToolUse` hook BEFORE a tool call executes and obeys its answer. Murage writes one matcher-free
// `PreToolUse` handler and one `SessionStart` handler into a bot's scoped CODEX_HOME. Both run the same small script, which
// talks to a socket Murage listens on; the script can only print allow, print deny, or exit 2. Murage maps every delivery to
// an allow, a deny, or an ordinary ask through the same `request.opened` path the approval requests use.
//
// This module holds everything that does not need a running turn: the version policy, the files written into the scope, the
// owner-hook strip of the config copy, the trust handshake, the socket, the delivery mapping, the apply_patch reader and the
// Rule 67 tripwire table. codex.ts wires them to a turn.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { inProjectCheck, realPathInOrder } from "../../shared/in-project.ts";
import { isOwnUnasked } from "../../shared/own-servers.ts";
import { ABSENT_PINS } from "../../shared/arg-vocabulary.ts";
import { GATE_MESSAGE_BYTES, HOOK_LIVENESS_MS } from "../../shared/scan-limits.ts";
import type { McpMountRecord } from "../../shared/mount-identity.ts";

export { HOOK_LIVENESS_MS };

/** Rule 68g: the oldest Codex whose hooks Murage builds the gate on. Probed offline (lane ag103-cx3, 2026-10-18): 0.129.0 and 0.163.0
 *  list a `hooks.json` handler pair from the scoped home, take the trust write through `config/batchWrite` and list both as trusted. */
export const CODEX_GATE_MIN = [0, 129, 0] as const;

/** The first Codex that refuses the retired ask-for-everything approval policy (`untrusted`). Probed offline on the npm builds, no
 *  login, no network (lane ag103-cx3, 2026-10-18): 0.129.0, 0.140.0..0.148.0 start with `-c approval_policy="untrusted"`; 0.149.0 (and
 *  0.150.0, 0.156.0, 0.163.0) exit before `initialize` with `approval_policy = "untrusted" is no longer supported; remove this
 *  setting`. The app-server's own `thread/start` still takes the value on every one of those builds (it is the config file and `-c` that
 *  refuse), so the retirement shows at spawn, which is where Murage's pin lives. */
export const CODEX_UNTRUSTED_RETIRED_MIN = [0, 149, 0] as const;

/** Rule 68e: the only local tool Murage lets through without a judgment. Admission rule: its input schema carries no leaf Rule 56
 *  classifies path-shaped, command-shaped, URL-shaped or addressing (T100d enumerates the local tools against it). */
export const CODEX_LOCAL_ORDINARY: readonly string[] = ["update_plan"];

/** Rule 74: the shell-form features pinned off, read from `codex features list` on 0.129.0, 0.149.0 and 0.163.0. A snapshot sources the
 *  owner's startup files into every shell, a zsh fork starts its own shell, and the login-shell package path adds login-shell paths:
 *  each would make the shell form differ from the pinned non-login form the F12 check compares against. `unified_exec` and
 *  `shell_tool` cannot be turned off by Murage ("User opt-outs are ignored"); Rule 68f settles what a session can do at the decision. */
export const CODEX_SHELL_FORM_FEATURES: readonly string[] = [
  "shell_snapshot", "shell_snapshot_v2", "shell_zsh_fork", "unified_exec_zsh_fork", "login_shell_package_path",
];

const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;

/** Rule 74 for Codex, per turn: no login shell, the process environment handed whole (`inherit = "all"`), the hand's resolved
 *  pin map as `set` (the ssh transport pins included, HandedEnv.pins) and the absence pins as `exclude` (the map Murage hands
 *  already lacks them; this makes a shell Codex starts on its own agree), and the shell-form features off. Probed accepted on
 *  0.129.0, 0.149.0 and 0.163.0. */
export function codexShellFormArgs(pins: ReadonlyMap<string, string>): string[] {
  const set = [...pins].map(([name, value]) => `${BARE_TOML_KEY.test(name) ? name : JSON.stringify(name)}=${JSON.stringify(value)}`);
  return [
    "-c", "allow_login_shell=false",
    "-c", "shell_environment_policy.inherit=\"all\"",
    "-c", `shell_environment_policy.set={${set.join(",")}}`,
    "-c", `shell_environment_policy.exclude=${JSON.stringify([...ABSENT_PINS])}`,
    ...CODEX_SHELL_FORM_FEATURES.flatMap((name) => ["-c", `features.${name}=false`]),
  ];
}

export function versionAtLeast(version: string | undefined, min: readonly number[]): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  return v[0]! !== min[0]! ? v[0]! > min[0]! : v[1]! !== min[1]! ? v[1]! > min[1]! : v[2]! >= min[2]!;
}

export interface CodexFloors { retired: readonly number[]; gate: readonly number[] }
export const CODEX_FLOORS: CodexFloors = { retired: CODEX_UNTRUSTED_RETIRED_MIN, gate: CODEX_GATE_MIN };
let activeFloors: CodexFloors = CODEX_FLOORS;
/** Tests only: a retirement version and a gate floor other than the probed ones (the real numbers leave no build between them). */
export function setCodexFloorsForTests(floors?: CodexFloors): void { activeFloors = floors ?? CODEX_FLOORS; }
export const currentCodexFloors = (): CodexFloors => activeFloors;

export type CodexGatePlan =
  /** The retired policy still exists on this build: the driver sends what it sent before the pin, and no hook is needed. */
  | { mode: "legacy" }
  /** `on-request` with the Rule 68 gate established and verified for the turn. */
  | { mode: "gated" }
  /** The gate cannot be established on this build: the turn is refused before `turn/start`. */
  | { mode: "refuse"; why: "update-codex" };

/** Item 1: the per-version policy. An unknown version is never legacy: the gate is attempted and its handshake decides. */
export function codexGatePlan(version: string | undefined, floors: CodexFloors = activeFloors): CodexGatePlan {
  const known = /(\d+)\.(\d+)\.(\d+)/.test(version ?? "");
  if (known && !versionAtLeast(version, floors.retired)) return { mode: "legacy" };
  if (known && !versionAtLeast(version, floors.gate)) return { mode: "refuse", why: "update-codex" };
  return { mode: "gated" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Files written into the scoped CODEX_HOME

export const HOOKS_JSON_FILE = "hooks.json";
export const HOOK_SCRIPT_FILE = "murage-hook.mjs";
export const HOOK_ENV_FILE = "murage-hook.env";

/** The ask bound a hook waits for the owner (the driver's permission deny, codex.ts). */
export const HOOK_ASK_BOUND_MS = 15 * 60_000;
/** `timeout` of both handlers: the ask bound plus 30 s, in seconds (Rule 68a). */
export const HOOK_TIMEOUT_SEC = Math.ceil(HOOK_ASK_BOUND_MS / 1000) + 30;
/** The script's own deadline: shorter than the handler timeout, so Codex never times the hook out while the script is alive. */
export const HOOK_SCRIPT_DEADLINE_MS = HOOK_ASK_BOUND_MS + 10_000;

/** Rule 68d. Whole body in one `try`; the only outcomes are an allow (a clean exit, silent), a deny (printed, with its reason), or exit 2 with the reason on stderr. The socket path and
 *  the per-turn token are read from the env file beside this script (never argv, never hooks.json). The script runs with whatever
 *  environment Codex gives a hook, so it touches nothing but its own folder and the socket. */
export const CODEX_HOOK_SCRIPT = `// Murage pre-execution hook. Generated; do not edit.
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEADLINE_MS = ${HOOK_SCRIPT_DEADLINE_MS};
const block = (why) => {
  try { process.stderr.write("Murage blocked this call: " + String(why).slice(0, 300) + "\\n"); } catch {}
  process.exit(2);
};
try {
  const timer = setTimeout(() => block("the check took too long"), DEADLINE_MS);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const here = dirname(fileURLToPath(import.meta.url));
  const env = {};
  for (const line of readFileSync(join(here, ${JSON.stringify(HOOK_ENV_FILE)}), "utf8").split("\\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  if (!env.SOCKET || !env.TOKEN) block("no socket");
  const event = input.hook_event_name;
  const message = event === "SessionStart"
    ? { kind: "session", token: env.TOKEN, session_id: input.session_id }
    : event === "PreToolUse"
      ? { kind: "pretool", token: env.TOKEN, tool_name: input.tool_name, tool_input: input.tool_input, tool_use_id: input.tool_use_id, turn_id: input.turn_id, cwd: input.cwd }
      : null;
  if (!message) block("unknown event");
  const answer = await new Promise((resolve, reject) => {
    const socket = net.connect(env.SOCKET);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\\n"));
    socket.on("data", (d) => { data += d; const at = data.indexOf("\\n"); if (at >= 0) { socket.destroy(); try { resolve(JSON.parse(data.slice(0, at))); } catch (e) { reject(e); } } });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("the socket closed")));
  });
  clearTimeout(timer);
  if (event === "SessionStart") process.exit(0);
  if (answer && answer.decision === "allow") {
    // A plain allow prints nothing and exits 0: rig, Codex 0.163.0 lists a printed permissionDecision allow as "unsupported" and marks
    // the run failed, while a silent clean exit is a completed run and the call proceeds. Only a rewrite (Rule 73) prints.
    const out = { hookEventName: "PreToolUse", permissionDecision: "allow" };
    if (answer.updatedInput && typeof answer.updatedInput === "object") out.updatedInput = answer.updatedInput;
    if (typeof answer.additionalContext === "string") out.additionalContext = answer.additionalContext;
    if (out.updatedInput || out.additionalContext) process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
    process.exit(0);
  }
  if (answer && answer.decision === "deny") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: String(answer.reason ?? "Murage did not allow this call").slice(0, 2000) } }));
    process.exit(0);
  }
  block("no usable answer");
} catch (error) {
  block(error && error.message ? error.message : "failed");
}
`;

/** The hook's launch line: Murage's node running the script, each path quoted. */
export const hookLaunchLine = (execPath: string, scriptPath: string): string => `"${execPath}" "${scriptPath}"`;

/** Windows (F3, 1.0.3 gate): Codex picks the shell a hook runs in, and Murage cannot. Every gated build (0.149.0 .. 0.163.0, source
 *  hooks/src/engine/command_runner.rs `build_command`, core/src/session/mod.rs `build_hooks_config`) runs the handler string under the
 *  turn's user shell, which on Windows is PowerShell (`pwsh`, else `powershell`) as `-NoProfile -Command <command>`, with cmd.exe
 *  `/c` when no PowerShell is found, and `%COMSPEC% /C "<command>"` when the turn has no environment. There is no argv form: the
 *  handler is a string. So the string must mean the same thing in cmd and in PowerShell:
 *  - its program is cmd.exe by a bare absolute path with no space, no quote and no variable (both shells run a bare path the same way;
 *    an absolute path keeps cmd's current-folder lookup out of it, so a project cannot plant a `cmd.exe` of its own);
 *  - its arguments hold no character either shell treats specially, except the one `%MURAGE_CODEX_HOOK%`, which PowerShell hands to
 *    cmd unread and cmd expands (the old bare `%MURAGE_CODEX_HOOK%` was a cmd-only string: PowerShell never expanded it, so the hook
 *    never started and every Codex turn was refused);
 *  - `/d` skips the AutoRun commands of the registry, `/v:off` keeps a `!` in a path literal.
 *  The variable holds the launch line behind an `@` (hookWindowsLaunchValue): when the OUTER shell is cmd it expands the variable
 *  first, and a line that started with a quote would lose its first and last quote to the inner cmd's `/c` rule. */
export const CODEX_HOOK_LAUNCH_ENV = "MURAGE_CODEX_HOOK";
const PLAIN_SYSTEM_ROOT = /^[A-Za-z]:\\[A-Za-z0-9_.-]+(?:\\[A-Za-z0-9_.-]+)*$/;
/** The system cmd.exe by absolute path. A system folder that is not a plain path falls back to the default one, which then fails
 *  closed (no hook starts, no SessionStart proof, the turn is refused) rather than putting a space or a quote in the command. */
export function windowsCmdPath(systemRoot: string | undefined = process.env.SystemRoot ?? process.env.SYSTEMROOT): string {
  return `${systemRoot && PLAIN_SYSTEM_ROOT.test(systemRoot) ? systemRoot : "C:\\Windows"}\\System32\\cmd.exe`;
}
export function codexHookWindowsCommand(systemRoot?: string): string {
  return `${windowsCmdPath(systemRoot)} /d /v:off /c %${CODEX_HOOK_LAUNCH_ENV}%`;
}
/** The value of MURAGE_CODEX_HOOK: the launch line, led by `@` so it never starts with a quote. */
export const hookWindowsLaunchValue = (execPath: string, scriptPath: string): string => `@${hookLaunchLine(execPath, scriptPath)}`;

/** Rule 68a: the hooks.json of the scope. One matcher-free PreToolUse handler and one SessionStart handler, each a `command`
 *  handler running the script with Murage's own node. The content never changes between turns (the hash stays stable), so trust
 *  survives; the socket path and the token live in the env file. */
export function codexHooksJson(execPath: string, scriptPath: string): string {
  const command = hookLaunchLine(execPath, scriptPath);
  const handler = { type: "command", command, command_windows: codexHookWindowsCommand(), timeout: HOOK_TIMEOUT_SEC };
  return JSON.stringify({ hooks: { PreToolUse: [{ hooks: [handler] }], SessionStart: [{ hooks: [handler] }] } }, null, 2) + "\n";
}

export interface HookFiles { hooksJson: string; script: string; envFile: string }

/** Rule 68c: what a SessionStart proof was given under. A kept process's proof carries to the next turn only while this is unchanged. */
export function hookConfigOf(scopedHome: string, execPath = process.execPath): string {
  return createHash("sha256").update(codexHooksJson(execPath, join(scopedHome, HOOK_SCRIPT_FILE))).update("\0").update(CODEX_HOOK_SCRIPT).digest("hex");
}

/** Writes hooks.json and the script (unchanged content is not rewritten) and the turn's env file (0600). */
export function writeHookFiles(scopedHome: string, socketPath: string, token: string, execPath = process.execPath): HookFiles {
  mkdirSync(scopedHome, { recursive: true });
  const script = join(scopedHome, HOOK_SCRIPT_FILE);
  const hooksJson = join(scopedHome, HOOKS_JSON_FILE);
  const envFile = join(scopedHome, HOOK_ENV_FILE);
  writeIfChanged(script, CODEX_HOOK_SCRIPT, 0o600);
  writeIfChanged(hooksJson, codexHooksJson(execPath, script), 0o600);
  try { if (existsSync(envFile)) unlinkSync(envFile); } catch { /* replaced below */ }
  writeFileSync(envFile, `SOCKET=${socketPath}\nTOKEN=${token}\n`, { mode: 0o600 });
  try { chmodSync(envFile, 0o600); } catch { /* the mode was set at creation where chmod is not honoured */ }
  return { hooksJson, script, envFile };
}

function writeIfChanged(path: string, content: string, mode: number): void {
  try { if (existsSync(path) && readFileSync(path, "utf8") === content) return; } catch { /* rewritten below */ }
  writeFileSync(path, content, { mode });
}

/** Rule 68a: the config.toml copy without the owner's `hooks` table (the `[hooks]` definitions, `[hooks.state]`, the owner's trust
 *  records, and any top-level `hooks.*` key or inline `hooks = {...}`), so no owner hook is defined, trusted or runnable in a bot's
 *  scope. Murage's own trust write lands in the copy afterwards. Everything else is kept byte for byte. */
export function stripOwnerHooks(toml: string): string {
  const lines = toml.split("\n");
  const out: string[] = [];
  let dropping = false;
  let inTable = false;
  let depth = 0; // open brackets of a multi-line value being dropped
  const isHooksHeader = (header: string) => /^(hooks)(\s*\.|\s*$)/.test(header.trim().replace(/^\[+|\]+$/g, "").trim());
  for (const raw of lines) {
    const line = raw.trim();
    if (depth > 0) {
      depth += bracketBalance(line);
      continue;
    }
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      inTable = true;
      dropping = isHooksHeader(header[1]!);
      if (dropping) continue;
      out.push(raw);
      continue;
    }
    if (dropping) continue;
    if (!inTable && /^hooks(\s*\.|\s*=)/.test(line)) {
      depth = Math.max(0, bracketBalance(line.slice(line.indexOf("=") + 1)));
      continue;
    }
    out.push(raw);
  }
  return out.join("\n");
}

function bracketBalance(text: string): number {
  let depth = 0, quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === "\\" && quote === "\"") i++; else if (c === quote) quote = ""; continue; }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "#") break;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rule 68b: trust through hooks/list and config/batchWrite

export interface ListedHook {
  key: string; eventName: string; trustStatus: string; enabled: boolean; isManaged: boolean; sourcePath: string; currentHash: string;
  /** Rules 2, 68b: `enabled` is only an explicit true; anything but an explicit false may still run, so another handler is judged on this */
  mayRun: boolean;
}

export type HandshakeResult =
  | { ok: true; managed: number }
  | { ok: false; why: string };

type Rpc = (method: string, params: unknown, timeoutMs?: number) => Promise<any>;

const listedHooks = (result: any, cwd: string): ListedHook[] | null => {
  const entries = Array.isArray(result?.data) ? result.data : null;
  if (!entries) return null;
  const entry = entries.find((e: any) => e?.cwd === cwd) ?? entries[0];
  if (!entry || !Array.isArray(entry.hooks)) return null;
  const hooks: ListedHook[] = [];
  for (const h of entry.hooks) {
    if (!h || typeof h.key !== "string" || typeof h.eventName !== "string" || typeof h.trustStatus !== "string") return null;
    hooks.push({ key: h.key, eventName: h.eventName, trustStatus: h.trustStatus, enabled: h.enabled === true, mayRun: h.enabled !== false, isManaged: h.isManaged === true,
      sourcePath: String(h.sourcePath ?? ""), currentHash: String(h.currentHash ?? "") });
  }
  return hooks;
};

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
/** Rule 67: the destinations a hook allowed against the paths a started file change names, as one set each, every relative path placed
 *  from the delivery's folder. Both sides are resolved in order (shared/in-project.ts), so `link/../x` is where the link leads, never a
 *  lexical `x`; a path that cannot be placed on either side matches nothing. */
const sameDestinations = (allowed: readonly string[], changed: readonly string[], cwd: string): boolean => {
  const real = (path: string) => {
    const placed = realPathInOrder(path, cwd, { home: homedir() });
    if ("cannot" in placed) return undefined;
    return process.platform === "win32" ? placed.real.toLowerCase() : placed.real;
  };
  const a = allowed.map(real);
  const b = changed.map(real);
  if (a.some((x) => x === undefined) || b.some((x) => x === undefined)) return false;
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

/** After `initialize` and before the first `thread/start`: list the hooks for the turn's cwd, find the two handlers by their source
 *  path and event, trust them (`hooks.state` through `config/batchWrite` with `reloadUserConfig`) when untrusted or modified, list
 *  again. The turn proceeds only when BOTH are trusted and enabled and no other non-managed handler is runnable. */
export async function trustHooks(rpc: Rpc, hooksJsonPath: string, cwd: string): Promise<HandshakeResult> {
  const read = async () => {
    let result: any;
    try { result = await rpc("hooks/list", { cwds: [cwd] }, 15_000); } catch { return null; }
    return listedHooks(result, cwd);
  };
  let hooks = await read();
  if (!hooks) return { ok: false, why: "hooks/list is missing or unreadable" };
  const ours = (list: ListedHook[], event: string) => list.filter((h) => samePath(h.sourcePath, hooksJsonPath) && h.eventName === event);
  const needed = (list: ListedHook[]) => [...ours(list, "preToolUse"), ...ours(list, "sessionStart")];
  if (ours(hooks, "preToolUse").length !== 1 || ours(hooks, "sessionStart").length !== 1) return { ok: false, why: "Murage's two handlers are not listed" };
  const stale = needed(hooks).filter((h) => h.trustStatus === "untrusted" || h.trustStatus === "modified");
  if (stale.length) {
    const state: Record<string, { trusted_hash: string }> = {};
    for (const h of stale) state[h.key] = { trusted_hash: h.currentHash };
    try {
      await rpc("config/batchWrite", { edits: [{ keyPath: "hooks.state", value: state, mergeStrategy: "upsert" }], reloadUserConfig: true }, 15_000);
    } catch { return { ok: false, why: "the trust write was refused" }; }
    hooks = await read();
    if (!hooks) return { ok: false, why: "hooks/list failed after the trust write" };
  }
  const mine = needed(hooks);
  if (mine.length !== 2 || mine.some((h) => h.trustStatus !== "trusted" || !h.enabled)) return { ok: false, why: "Murage's handlers are not trusted and enabled" };
  const other = hooks.filter((h) => !mine.includes(h) && !h.isManaged && h.mayRun && h.trustStatus === "trusted");
  if (other.length) return { ok: false, why: "another hook would run in this scope" };
  return { ok: true, managed: hooks.filter((h) => h.isManaged && h.enabled).length };
}

// ---------------------------------------------------------------------------------------------------------------------
// The socket

export interface HookDelivery {
  tool_name: unknown;
  tool_input: unknown;
  tool_use_id: unknown;
  turn_id?: unknown;
  cwd?: unknown;
}

export type HookAnswer =
  | { decision: "allow"; updatedInput?: Record<string, unknown>; additionalContext?: string }
  | { decision: "deny"; reason: string };

export interface HookTurn {
  token: string;
  onSession(sessionId: string): void;
  onPreTool(delivery: HookDelivery): Promise<HookAnswer>;
}

export const hookSocketPath = (id = randomBytes(6).toString("hex")): string =>
  process.platform === "win32" ? `\\\\.\\pipe\\murage-hook-${id}` : join(tmpdir(), `murage-hk-${id}.sock`);

/** One socket per app-server process, armed with one turn's token and handlers at a time. A message with another token is refused. */
export class CodexHookGate {
  private server: net.Server | null = null;
  private turn: HookTurn | null = null;
  readonly path: string;

  constructor(path = hookSocketPath()) { this.path = path; }

  async listen(): Promise<void> {
    const server = net.createServer((socket) => this.serve(socket));
    this.server = server;
    await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(this.path, () => { server.off("error", fail); ok(); }); });
    server.on("error", () => { /* a failed accept never reaches the engine */ });
    if (process.platform !== "win32") { try { chmodSync(this.path, 0o600); } catch { /* the token still guards it */ } }
  }

  arm(turn: HookTurn): void { this.turn = turn; }
  disarm(token?: string): void { if (!token || this.turn?.token === token) this.turn = null; }

  close(): void {
    this.turn = null;
    try { this.server?.close(); } catch { /* closing */ }
    this.server = null;
    if (process.platform !== "win32") { try { unlinkSync(this.path); } catch { /* gone already */ } }
  }

  private serve(socket: net.Socket): void {
    let data = "";
    let done = false;
    socket.setEncoding("utf8");
    const reply = (value: unknown) => { if (!done) { done = true; try { socket.end(JSON.stringify(value) + "\n"); } catch { /* peer gone */ } } };
    socket.on("error", () => { done = true; });
    socket.on("data", (chunk: string) => {
      if (done) return;
      data += chunk;
      if (data.length > GATE_MESSAGE_BYTES) return reply({ error: "too large" });
      const at = data.indexOf("\n");
      if (at < 0) return;
      let message: any;
      try { message = JSON.parse(data.slice(0, at)); } catch { return reply({ error: "malformed" }); }
      const turn = this.turn;
      if (!turn || typeof message?.token !== "string" || message.token !== turn.token) return reply({ error: "token" });
      if (message.kind === "session") {
        turn.onSession(typeof message.session_id === "string" ? message.session_id : "");
        return reply({ ok: true });
      }
      if (message.kind !== "pretool") return reply({ error: "kind" });
      turn.onPreTool({ tool_name: message.tool_name, tool_input: message.tool_input, tool_use_id: message.tool_use_id, turn_id: message.turn_id, cwd: message.cwd })
        .then((answer) => reply(answer), () => reply({ decision: "deny", reason: "Murage could not check this call" }));
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Rule 68e: the delivery as a decision

/** apply_patch destinations: `*** Add File:`, `*** Update File:`, `*** Delete File:` and `*** Move to:` headers. A patch that is not
 *  one whole well-formed envelope is unread (null). */
export function parseApplyPatch(patch: unknown): { destinations: string[]; added: Map<string, string> } | null {
  if (typeof patch !== "string" || Buffer.byteLength(patch, "utf8") > GATE_MESSAGE_BYTES) return null;
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines[0] !== "*** Begin Patch" || lines[lines.length - 1] !== "*** End Patch") return null;
  const destinations: string[] = [];
  const added = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (header) {
      const path = header[2]!;
      if (!path.trim()) return null;
      destinations.push(path);
      // Rule 64: every body a destination receives is read (an Update's added lines too, and a Move carries the update's body to
      // its new name), so a template file is never written unread
      if (header[1] === "Move to" && current) { added.set(path, added.get(current)!); continue; }
      current = header[1] === "Delete File" ? null : path;
      if (current && !added.has(current)) added.set(current, []);
      continue;
    }
    if (line.startsWith("*** ")) return null;
    if (line === "" || line.startsWith("@@") || line === "*** End of File" || /^[ +\-]/.test(line)) {
      if (current && line.startsWith("+")) added.get(current)!.push(line.slice(1));
      continue;
    }
    return null;
  }
  if (!destinations.length) return null;
  return { destinations, added: new Map([...added].map(([k, v]) => [k, v.join("\n")])) };
}

export type HookRoute =
  | { route: "allow"; final: boolean; why: string; destinations?: string[]; cwd?: string }
  | { route: "deny"; reason: string }
  | { route: "ask"; tool: string; summary: string; toolCall: { name: string; input?: unknown }; toolInputMissing?: string; cwd?: string; destinations?: string[]; command?: string };

export interface RouteContext {
  /** F4: the mounts this app-server loads; undefined = unstated, so no MCP call is proven. */
  mounts: readonly McpMountRecord[] | undefined;
  /** The project folder the turn runs in. */
  project: string;
  home?: string;
}

/** SEAM for build step 4 (the shell walker `targetsOf`, Rules 70/71/73b): the targets of a command. Today it states "not available",
 *  so a command delivery goes to the verdict as an ask, exactly as an approval did before the gate. */
export function shellTargetsSeam(_command: string, _cwd: string): { available: false } {
  return { available: false };
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

/** Rule 68e. Never throws: an input that cannot be read is an ask that says which field was absent (F5), never a stand-in. */
/** A mount's name as Codex writes it inside a tool name (`mcp__<server>__<tool>`): every character outside
 *  [A-Za-z0-9_] becomes `_`. */
export function codexToolServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

export function routeDelivery(delivery: HookDelivery, ctx: RouteContext): HookRoute {
  const name = str(delivery.tool_name);
  const cwd = str(delivery.cwd) ?? ctx.project;
  const input = record(delivery.tool_input);
  if (!name) return { route: "deny", reason: "Murage does not know this tool" };

  if (name === "Bash" || name === "exec_command") {
    const command = str(input?.command) ?? str(input?.cmd);
    const workdir = str(input?.workdir) ?? str(input?.cwd) ?? cwd;
    // the seam: today it never proves targets, so the command is judged as an ask
    shellTargetsSeam(command ?? "", workdir);
    if (command === undefined) return { route: "ask", tool: "shell", summary: "shell", toolCall: { name: "shell" }, toolInputMissing: "command", cwd: workdir };
    return { route: "ask", tool: "shell", summary: command, command, cwd: workdir, toolCall: { name: "shell", input: { command, cwd: workdir } } };
  }

  if (name === "apply_patch") {
    const patch = typeof delivery.tool_input === "string" ? delivery.tool_input : str(input?.input) ?? str(input?.patch) ?? str(input?.command);
    const parsed = parseApplyPatch(patch);
    if (!parsed) return { route: "ask", tool: "edit", summary: "edit", toolCall: { name: "edit" }, toolInputMissing: "patch", cwd };
    // Rules 63.2, 75d: each destination is placed in order from the delivery's folder (shared/in-project.ts), never lexically
    const reals: string[] = [];
    for (const destination of parsed.destinations) {
      const checked = inProjectCheck(destination, ctx.project, parsed.added.get(destination), { home: ctx.home ?? homedir(), base: cwd });
      if (!checked.ok) break;
      reals.push(checked.real);
    }
    // the destinations travel with the allow, stored real, so the tripwire matches the started change on where it lands (Rule 67)
    if (reals.length === parsed.destinations.length) return { route: "allow", final: true, why: "own-workspace", destinations: reals, cwd };
    return { route: "ask", tool: "edit", summary: parsed.destinations.join(", "), destinations: parsed.destinations, cwd,
      toolCall: { name: "edit", input: { paths: parsed.destinations, cwd } } };
  }

  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const at = rest.indexOf("__");
    const server = at > 0 ? rest.slice(0, at) : "";
    const tool = at > 0 ? rest.slice(at + 2) : "";
    // Codex writes a server's name into its tool names with every character outside [A-Za-z0-9_] as `_` (real codex:
    // the `murage-memory` mount's tool arrives as `mcp__murage_memory__memory_search`), so a record matches by its
    // name as mounted or as Codex writes it. Two records that fit the same written name prove nothing.
    const matches = (ctx.mounts ?? []).filter((r) => r.engineName === server || codexToolServerName(r.engineName) === server);
    const ask = (asName = name): HookRoute => ({ route: "ask", tool: tool || name, summary: tool || name, toolCall: { name: asName, ...(delivery.tool_input === undefined ? {} : { input: delivery.tool_input }) },
      ...(delivery.tool_input === undefined ? { toolInputMissing: "tool_input" } : {}) });
    if (!server || !tool || matches.length !== 1) return ask();
    const mount = matches[0]!;
    // asked under the mount's own name, so the verdict proves the call on this turn's record (Rule 11)
    if (mount.provenance === "own") return isOwnUnasked(mount.mountId, tool) ? { route: "allow", final: true, why: "own-unasked" } : ask(`mcp__${mount.engineName}__${tool}`);
    // a custom or external mount: allowed here, judged by the approval path Codex still raises for it
    return { route: "allow", final: false, why: mount.provenance };
  }

  if (CODEX_LOCAL_ORDINARY.includes(name)) return { route: "allow", final: true, why: "local-ordinary" };

  if (name === "view_image" || name === "read_file") {
    const path = str(input?.path) ?? str(input?.file_path) ?? str(input?.filePath);
    if (!path) return { route: "ask", tool: name, summary: name, toolCall: { name }, toolInputMissing: "path", cwd };
    const checked = inProjectCheck(path, ctx.project, undefined, { home: ctx.home ?? homedir(), base: cwd });
    if (checked.ok) return { route: "allow", final: true, why: "own-workspace" };
    return { route: "ask", tool: name, summary: path, cwd, toolCall: { name, input: { path } } };
  }

  // Native search tools: judged by the verdict until the walk of build step 4 reads their roots.
  if (name === "list_dir" || name === "grep_files") {
    return { route: "ask", tool: name, summary: name, cwd, toolCall: { name, ...(input ? { input } : {}) }, ...(input ? {} : { toolInputMissing: "tool_input" }) };
  }

  return { route: "deny", reason: "Murage does not know this tool" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rule 67: the tripwire table

export interface IssuedDecision {
  toolUseId: string;
  turnId?: string;
  decision: "allow" | "deny";
  /** true when the hook's answer is the whole judgment, so the same call arriving on the approval path takes it */
  final: boolean;
  command?: string;
  cwd?: string;
  destinations?: string[];
  name?: string;
  consumed?: boolean;
}

export interface StartedItem { id?: unknown; type?: unknown; command?: unknown; cwd?: unknown; changes?: unknown; tool?: unknown; server?: unknown }

export type TripwireVerdict =
  | { ok: true; entry: IssuedDecision }
  | { ok: false; why: "denied" | "unmatched" | "ambiguous"; command: string };

export class HookDecisionTable {
  private readonly byId = new Map<string, IssuedDecision>();
  private readonly order: IssuedDecision[] = [];

  record(entry: IssuedDecision): void {
    if (entry.toolUseId) this.byId.set(entry.toolUseId, entry);
    this.order.push(entry);
  }

  get(toolUseId: string): IssuedDecision | undefined { return this.byId.get(toolUseId); }

  /** Match an `item/started` (commandExecution, fileChange, mcpToolCall) against the table: by id; failing an id match, by command and
   *  cwd in order of issue, where more than one candidate is a mismatch. Matched to an allow is ordinary. */
  match(item: StartedItem, turnId?: string): TripwireVerdict {
    const label = typeof item.command === "string" ? item.command : typeof item.tool === "string" ? item.tool : String(item.type ?? "a tool call");
    const id = typeof item.id === "string" ? item.id : "";
    const byId = id ? this.byId.get(id) : undefined;
    if (byId) {
      byId.consumed = true;
      // a change matched by id must still land where the hook placed it, when the hook read its destinations
      if (item.type === "fileChange" && byId.destinations && byId.cwd) {
        const changed = Array.isArray(item.changes) ? item.changes.map((c) => (c && typeof c === "object" && typeof (c as { path?: unknown }).path === "string" ? (c as { path: string }).path : "")) : [];
        if (!changed.length || !changed.every(Boolean) || !sameDestinations(byId.destinations, changed, byId.cwd)) return { ok: false, why: "unmatched", command: label };
      }
      return byId.decision === "allow" ? { ok: true, entry: byId } : { ok: false, why: "denied", command: label };
    }
    // Rule 67: the fallback matches EXACTLY: the same turn, both turn ids stated; a command on the same text in the same folder, both
    // folders stated; a file change on the same destinations; an MCP call on the same server and tool. A missing field matches nothing.
    const sameTurn = (e: IssuedDecision) => e.turnId !== undefined && turnId !== undefined && e.turnId === turnId;
    const take = (candidates: IssuedDecision[]): TripwireVerdict | undefined => {
      if (candidates.length > 1) return { ok: false, why: "ambiguous", command: label };
      if (candidates.length !== 1) return undefined;
      candidates[0]!.consumed = true;
      return candidates[0]!.decision === "allow" ? { ok: true, entry: candidates[0]! } : { ok: false, why: "denied", command: label };
    };
    if (item.type === "commandExecution" && typeof item.command === "string") {
      const cwd = typeof item.cwd === "string" ? item.cwd : undefined;
      const found = take(this.order.filter((e) => !e.consumed && sameTurn(e) && e.command === item.command && e.cwd !== undefined && cwd !== undefined && samePath(e.cwd, cwd)));
      if (found) return found;
    }
    if (item.type === "fileChange") {
      const changed = Array.isArray(item.changes) ? item.changes.map((c) => (c && typeof c === "object" && typeof (c as { path?: unknown }).path === "string" ? (c as { path: string }).path : "")) : [];
      if (changed.length && changed.every(Boolean)) {
        const found = take(this.order.filter((e) => !e.consumed && sameTurn(e) && e.name === "apply_patch" && e.destinations !== undefined && e.cwd !== undefined
          && sameDestinations(e.destinations, changed, e.cwd)));
        if (found) return found;
      }
    }
    if (item.type === "mcpToolCall" && typeof item.server === "string" && typeof item.tool === "string") {
      const name = `mcp__${item.server}__${item.tool}`;
      const found = take(this.order.filter((e) => !e.consumed && sameTurn(e) && e.name === name));
      if (found) return found;
    }
    return { ok: false, why: "unmatched", command: label };
  }
}

/** The owner-facing line of an incident (Rule 67). */
export const tripwireLine = (command: string): string => `Codex ran \`${command}\` without Murage's check; the turn was stopped`;

/** A short random token for one turn. */
export const newHookToken = (): string => randomBytes(24).toString("hex");
