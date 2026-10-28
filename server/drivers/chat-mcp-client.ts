// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The hardened stdio MCP client the chat-completions engines mount their tools through (OPENAI-TOOLS-109 section 3).
// JSON-RPC 2.0 over newline-delimited frames. pi-mcp-extension.ts StdioMcp is a framing reference only and is not reused:
// every child here is started by spawnCli under an engine job (tree kill, Windows job objects), gets an ALLOWLIST-built
// environment (never process.env stripped), is tracked by a ChildTeardown from the moment it exists, and is stopped by
// markStopRequested then killCliTree. Nothing a server writes to stderr is ever read, and no server error text or stderr
// reaches a caller: every failure carries one of the fixed ChatMcpError messages (section 8).
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

import { augmentedPath } from "../env-path.ts";
import {
  awaitCliTreeStopped, CLI_FORCE_WAIT_MS, CLI_TERM_GRACE_MS, cliStopDelivery, cliTreeStoppedSignal, engineJob, killCliTree, spawnCli,
} from "../procs.ts";
import { ChildTeardown } from "./child-teardown.ts";
import { descendantIdentitiesKeepingUnknown, processParentsAndArgs, type ProcessIdentities } from "./process-tree.ts";

export const CHAT_MCP_PROTOCOL_VERSION = "2025-06-18";
/** One frame (one line) may hold at most this many bytes; a longer line kills the session. */
export const CHAT_MCP_FRAME_CAP_BYTES = 2 * 1024 * 1024;
/** Frames one session may receive in its whole life. */
export const CHAT_MCP_MAX_FRAMES = 10_000;
/** initialize through the last tools/list page, per server. */
export const CHAT_MCP_STARTUP_MS = 8_000;
export const CHAT_MCP_CALL_TIMEOUT_MS = 10 * 60_000;
export const CHAT_MCP_MAX_LIST_PAGES = 100;

export const CHAT_MCP_FAILED_MESSAGE = "MCP request failed; inspect the configured integration";
const MESSAGES = {
  failed: CHAT_MCP_FAILED_MESSAGE,
  timeout: "MCP request timed out; inspect the configured integration",
  aborted: "MCP request was stopped",
} as const;
export type ChatMcpErrorKind = keyof typeof MESSAGES;

/** Every failure of this client. The message is always one of the fixed texts above, never a server's own. */
export class ChatMcpError extends Error {
  readonly kind: ChatMcpErrorKind;
  constructor(kind: ChatMcpErrorKind = "failed") {
    super(MESSAGES[kind]);
    this.name = "ChatMcpError";
    this.kind = kind;
  }
}

export interface ChatMcpToolDef { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface ChatMcpCallResult { isError: boolean; text: string; droppedImages: number }
/** Section 8: scrubs a parsed content block (every string leaf) before it is serialized; never JSON text, where escaping
 *  (`"` -> `\"`, `\` -> `\\`) would change a secret's bytes. */
export type ChatMcpResultScrub = (value: unknown) => unknown;
export interface ChatMcpCallOptions { signal?: AbortSignal; timeoutMs?: number; scrub?: ChatMcpResultScrub }
export interface ChatMcpSession {
  readonly server: string;
  readonly tools: ChatMcpToolDef[];
  readonly teardown: ChildTeardown;
  callTool(name: string, args: Record<string, unknown>, opts: ChatMcpCallOptions): Promise<ChatMcpCallResult>;
  close(): void;
  readonly closed: boolean;
}
export interface OpenChatMcpOptions {
  signal?: AbortSignal;
  startupMs?: number;
  /** Called synchronously for every child the moment it is spawned, before any await, so the caller tracks even a child
   *  whose startup then fails. */
  onSpawn?(server: string, teardown: ChildTeardown): void;
  /** Test hook. Default: spawnCli under engineJob(). */
  spawn?: (command: string, args: string[], env: Record<string, string>) => ChildProcess;
}

export const SECRET_ENV_NAME = /key|token|password|secret|authorization|cookie/i;

const POSIX_ENV_ALLOW = new Set(["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TERM"]);
const WINDOWS_ENV_ALLOW = new Set([
  "SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "HOMEDRIVE", "HOMEPATH", "USERNAME", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "OS",
].map((name) => name.toLowerCase()));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// A name spawn would refuse, or one that would touch the record's prototype, is never copied.
const usableEnvName = (name: string): boolean => name !== "" && name !== "__proto__" && !name.includes("=") && !name.includes("\0");

/** The child's whole environment: the fixed non-secret system allowlist copied from `source` when present, PATH from
 *  augmentedPath(), then the mount entry's own env LAST (the only way a token reaches a server). Names compare
 *  case-insensitively on Windows, where a later name replaces an earlier one of any case. */
export function chatMcpChildEnv(
  entryEnv: unknown,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const windows = platform === "win32";
  const out: Record<string, string> = {};
  const put = (name: string, value: string) => {
    if (!usableEnvName(name) || value.includes("\0")) return;
    if (windows) {
      const lower = name.toLowerCase();
      for (const existing of Object.keys(out)) if (existing.toLowerCase() === lower) delete out[existing];
    }
    out[name] = value;
  };
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (windows ? WINDOWS_ENV_ALLOW.has(name.toLowerCase()) : POSIX_ENV_ALLOW.has(name)) put(name, value);
  }
  put("PATH", augmentedPath());
  if (isRecord(entryEnv)) for (const [name, value] of Object.entries(entryEnv)) if (typeof value === "string") put(name, value);
  return out;
}

/** The env values (4+ characters) of every mounted server whose name looks secret, deduped: the scrub set (section 8). */
export function mountSecrets(servers: Record<string, unknown> | null): string[] {
  const found = new Set<string>();
  for (const entry of Object.values(servers ?? {})) {
    const env = isRecord(entry) ? entry.env : undefined;
    if (!isRecord(env)) continue;
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === "string" && value.length >= 4 && SECRET_ENV_NAME.test(name)) found.add(value);
    }
  }
  return [...found];
}

interface Launch { command: string; args: string[]; env: unknown }
function parseEntry(entry: unknown): Launch | null {
  if (!isRecord(entry) || typeof entry.command !== "string" || !entry.command.trim()) return null;
  const args = entry.args ?? [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return null;
  return { command: entry.command, args: args as string[], env: entry.env };
}

const defaultSpawn = (command: string, args: string[], env: Record<string, string>): ChildProcess =>
  spawnCli(command, args, { stdio: ["pipe", "pipe", "pipe"], env }, engineJob());

const noop = () => { /* drained */ };
const validId = (id: unknown): boolean => typeof id === "number" || typeof id === "string" || id === null;

interface Pending { resolve(value: unknown): void; reject(error: ChatMcpError): void }
interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }

/** H6: how long a stop waits for the descendant snapshot before it ends the server anyway. */
export const CHAT_MCP_SNAPSHOT_CAP_MS = 1_000;
/** H6: how long a descendant still running after the SIGKILL bound is re-checked for a late exit (its teardown stays unconfirmed). */
const ESCAPED_LATE_WATCH_MS = 60_000;

const settleWithin = (work: Promise<unknown>, ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  void work.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
});
/** False only when the OS says no such process (ESRCH); EPERM means it exists. */
const pidExists = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};
const pause = (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
/** Linux: a terminated process its parent has not reaped yet (state Z) holds nothing and counts as gone. */
const linuxZombie = async (pid: number): Promise<boolean> => {
  if (process.platform !== "linux") return false;
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).startsWith("Z");
  } catch { return false; }
};

/** H6 (POSIX; on Windows the engine job object holds every descendant, escaped or not). A server descendant that left the
 *  process group (setsid, a daemon) is beyond the group SIGTERM/SIGKILL killCliTree sends, so it would survive Stop and Quit.
 *  Every descendant seen while the server runs is remembered with its start identity (process-tree.ts descendantIdentities):
 *  after startup, after each answered call, and at the stop itself, BEFORE stdin ends or the group is signalled, while the
 *  parentage is still intact. At the stop each one still running as the same process (pid AND start identity, re-read through
 *  processParentsAndArgs) gets SIGTERM with the group, then SIGKILL after CLI_TERM_GRACE_MS. The server's ChildTeardown
 *  confirms only once the group is gone AND every remembered descendant is, so a survivor keeps the run owned and a shutdown
 *  dispose rejects unconfirmed rather than claiming success. A descendant already reparented away before any snapshot saw it
 *  cannot be found by parentage; it is observed only through the pipes it holds (root close). */
export class ChatMcpDescendants {
  readonly #root: number | undefined;
  readonly #active: boolean;
  readonly #known: ProcessIdentities = new Map();
  #frozen = false;
  /** The stop's own snapshot gave no answer in time: what escaped is unknown, so nothing can confirm the tree gone (Astra code-r2). */
  #blind = false;
  /** Pids the latest #remaining probe read with their remembered identity: the only ones ever signalled. */
  readonly #verified = new Set<number>();
  #inFlight: Promise<void> | null = null;
  #ready: Promise<void> | null = null;
  #stop: Promise<boolean> | null = null;
  #gone = false;
  #resolveGone: (() => void) | null = null;
  #goneSignal: Promise<true> | null = null;

  constructor(child: ChildProcess, platform: NodeJS.Platform = process.platform) {
    this.#root = child.pid;
    this.#active = platform !== "win32" && typeof child.pid === "number";
  }

  /** False on Windows (the job holds the tree) and for a child the OS never created: nothing to track. */
  get active(): boolean { return this.#active; }

  /** True when the probe answered (an empty answer included). */
  #take(): Promise<boolean> {
    const root = this.#root;
    if (!this.#active || root === undefined) return Promise.resolve(true);
    return descendantIdentitiesKeepingUnknown(root).then((found) => {
      if (!found) return false;
      if (this.#frozen) return true;
      // an unreadable start is no identity: such a pid is never signalled, and nothing can later prove it gone, so the tree can no
      // longer be confirmed (Grok code-r2)
      for (const [pid, start] of found) {
        if (pid === process.pid) continue;
        if (start) this.#known.set(pid, start);
        else this.#blind = true;
      }
      return true;
    }, () => false);
  }

  /** Remember the server's current descendants (coalesced; never blocks a call). */
  track(): void {
    if (!this.#active || this.#ready || this.#inFlight) return;
    this.#inFlight = this.#take().then(() => undefined).finally(() => { this.#inFlight = null; });
  }

  /** The stop's own snapshot, bounded: the group is signalled and stdin ended only once it settled (or its cap passed). */
  ready(): Promise<void> {
    if (!this.#active) return Promise.resolve();
    return this.#ready ??= (() => {
      let answered = false;
      const snapshot = Promise.all([this.#inFlight, this.#take()]).then(([, ok]) => { answered = ok; });
      return settleWithin(snapshot, CHAT_MCP_SNAPSHOT_CAP_MS).then(() => { if (!answered) this.#blind = true; });
    })();
  }

  /** Idempotent: true once every remembered descendant is gone; false at the SIGKILL bound (goneSignal reports a late exit). */
  stop(): Promise<boolean> {
    if (!this.#active) return Promise.resolve(true);
    return this.#stop ??= this.#run();
  }

  /** Resolves whenever every remembered descendant is finally gone; never otherwise. */
  goneSignal(): Promise<true> {
    if (!this.#active || this.#gone) return Promise.resolve(true);
    return this.#goneSignal ??= new Promise<true>((resolve) => { this.#resolveGone = () => resolve(true); });
  }

  async #run(): Promise<boolean> {
    await this.ready();
    this.#frozen = true;
    if (!this.#blind && await this.#remaining().then((left) => left?.size === 0)) return this.#markGone();
    await this.#signal("SIGTERM");
    const termed = await this.#allGone(CLI_TERM_GRACE_MS);
    if (termed && !this.#blind) return this.#markGone();
    if (!termed) await this.#signal("SIGKILL");
    if (this.#blind) {
      console.warn("[chat-mcp] the process list gave no answer before the MCP server was stopped, so an escaped descendant cannot be ruled out; the run stays owned");
      return false;
    }
    if (await this.#allGone(CLI_FORCE_WAIT_MS)) return this.#markGone();
    const pids = [...this.#known.keys()];
    console.warn(`[chat-mcp] ${pids.length} escaped MCP descendant(s) still running after SIGKILL (pids ${pids.join(", ")}); the run stays owned`);
    void this.#allGone(ESCAPED_LATE_WATCH_MS, 1_000).then((gone) => { if (gone) this.#markGone(); });
    return false;
  }

  #markGone(): true {
    this.#gone = true;
    this.#resolveGone?.();
    return true;
  }

  /** The remembered descendants still running as themselves (pruning the rest); null when the probe gave no answer. */
  async #remaining(): Promise<ProcessIdentities | null> {
    if (!this.#known.size) return this.#known;
    const rows = await processParentsAndArgs(this.#known.keys()).catch(() => null);
    if (!rows) return null;
    this.#verified.clear();
    for (const [pid, start] of [...this.#known]) {
      const row = rows.get(pid);
      // a pid now running with another identity is a reused pid: ours is gone. A pid the probe left out, or whose identity it could
      // not read, is gone only when the OS says so (ESRCH) or it is a zombie; otherwise it is kept, unconfirmed (Astra code-r3).
      if (row?.start && row.start !== start) { this.#known.delete(pid); continue; }
      if (row?.start === start && !(await linuxZombie(pid))) { this.#verified.add(pid); continue; }
      if (!pidExists(pid) || await linuxZombie(pid)) this.#known.delete(pid);
    }
    return this.#known;
  }

  async #signal(signal: NodeJS.Signals): Promise<void> {
    if (!(await this.#remaining())) return;
    // only a pid whose identity this probe read and matched is signalled: an unreadable one may be a reused pid (Astra code-r4)
    for (const pid of this.#verified) { try { process.kill(pid, signal); } catch { /* gone, or not ours */ } }
  }

  async #allGone(ms: number, every = 100): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      const left = await this.#remaining();
      if (left?.size === 0) return true;
      if (Date.now() >= deadline) return false;
      await pause(Math.min(every, Math.max(0, deadline - Date.now())));
    }
  }
}

/** The server's teardown: the group's confirmation (after the stop's snapshot) AND every remembered descendant gone. */
function chatMcpTeardown(child: ChildProcess, descendants: ChatMcpDescendants): ChildTeardown {
  return new ChildTeardown(
    child,
    (target) => Promise.all([descendants.ready().then(() => awaitCliTreeStopped(target)), descendants.stop()]).then(([tree, rest]) => tree && rest),
    cliStopDelivery,
    (target) => Promise.all([cliTreeStoppedSignal(target), descendants.goneSignal()]).then(() => true as const),
  );
}

class ChatMcpConnection implements ChatMcpSession {
  readonly server: string;
  readonly teardown: ChildTeardown;
  readonly #child: ChildProcess;
  #tools: ChatMcpToolDef[] = [];
  #closed = false;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #parts: Buffer[] = [];
  #partsBytes = 0;
  #frames = 0;

  readonly #descendants: ChatMcpDescendants;

  constructor(server: string, child: ChildProcess, teardown: ChildTeardown, descendants: ChatMcpDescendants = new ChatMcpDescendants(child, "win32")) {
    this.server = server;
    this.#child = child;
    this.teardown = teardown;
    this.#descendants = descendants;
    const { stdin, stdout, stderr } = child;
    child.on("error", () => this.close());
    // A reply already in the pipe can be reported after `exit`; the stream's own end closes at once.
    child.once("exit", () => { const timer = setTimeout(() => this.close(), 50); timer.unref?.(); });
    // stderr may carry credentials: drained and discarded, never read into anything.
    if (stderr) { stderr.on("error", noop); stderr.resume(); }
    if (!stdin || !stdout) { this.close(); return; }
    stdin.on("error", () => this.close());
    stdout.on("error", () => this.close());
    stdout.on("end", () => this.close());
    stdout.on("data", (chunk: Buffer | string) => this.#onData(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
  }

  get tools(): ChatMcpToolDef[] { return this.#tools; }
  set tools(tools: ChatMcpToolDef[]) { this.#tools = tools; }
  get closed(): boolean { return this.#closed; }

  /** Remember the server's current descendants (H6); called after startup and after each answered call. */
  trackDescendants(): void { this.#descendants.track(); }

  /** Idempotent. Every pending request rejects; the child is marked stop-requested, then its whole tree is killed. On POSIX
   *  (H6) stdin ends and the group is signalled only after the stop's descendant snapshot (bounded by CHAT_MCP_SNAPSHOT_CAP_MS),
   *  so a descendant that left the group is still found through its parent, and is ended with it. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#parts = [];
    this.#partsBytes = 0;
    const end = () => {
      try { this.#child.stdin?.end(); } catch { /* already closed */ }
      try { killCliTree(this.#child); } catch { /* already gone */ }
    };
    this.teardown.markStopRequested();
    if (this.#descendants.active) {
      void this.#descendants.ready().then(end);
      void this.#descendants.stop();
    } else end();
    for (const waiter of pending) waiter.reject(new ChatMcpError("failed"));
  }

  #write(message: Record<string, unknown>): boolean {
    if (this.#closed) return false;
    try {
      this.#child.stdin?.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.#write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  request(method: string, params?: Record<string, unknown>, options: RequestOptions = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(new ChatMcpError("failed"));
    const { signal, timeoutMs } = options;
    if (signal?.aborted) {
      this.close();
      return Promise.reject(new ChatMcpError("aborted"));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => stop("aborted");
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      // Abort or timeout: tell the server, then end the session (the call may still be running in it).
      const stop = (kind: "aborted" | "timeout") => {
        if (!this.#pending.delete(id)) return;
        cleanup();
        this.notify("notifications/cancelled", { requestId: id, reason: kind === "timeout" ? "timed out" : "cancelled" });
        this.close();
        reject(new ChatMcpError(kind));
      };
      this.#pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      });
      if (timeoutMs !== undefined) timer = setTimeout(() => stop("timeout"), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  async callTool(name: string, args: Record<string, unknown>, opts: ChatMcpCallOptions = {}): Promise<ChatMcpCallResult> {
    const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs : CHAT_MCP_CALL_TIMEOUT_MS;
    const result = await this.request("tools/call", { name, arguments: args }, { signal: opts.signal, timeoutMs });
    this.trackDescendants();
    return callResultOf(result, opts.scrub);
  }

  #onData(chunk: Buffer): void {
    let start = 0;
    while (!this.#closed && start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        const rest = chunk.subarray(start);
        if (this.#partsBytes + rest.length > CHAT_MCP_FRAME_CAP_BYTES) { this.close(); return; }
        this.#parts.push(rest);
        this.#partsBytes += rest.length;
        return;
      }
      const piece = chunk.subarray(start, newline);
      start = newline + 1;
      if (this.#partsBytes + piece.length > CHAT_MCP_FRAME_CAP_BYTES) { this.close(); return; }
      const line = this.#parts.length ? Buffer.concat([...this.#parts, piece]) : piece;
      this.#parts = [];
      this.#partsBytes = 0;
      this.#onLine(line.toString("utf8"));
    }
  }

  #onLine(text: string): void {
    const line = text.trim();
    if (!line) return;
    if (++this.#frames > CHAT_MCP_MAX_FRAMES) { this.close(); return; }
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.close(); return; }
    if (!isRecord(message) || message.jsonrpc !== "2.0") { this.close(); return; }
    const { id, method } = message;
    if (method !== undefined) {
      if (typeof method !== "string") { this.close(); return; }
      if (id === undefined) return; // a notification: nothing this client acts on
      if (!validId(id)) { this.close(); return; }
      // This client serves no server-initiated request (sampling, roots, elicitation, ping).
      this.#write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (id === undefined || !validId(id) || ("result" in message) === ("error" in message)) { this.close(); return; }
    if (typeof id !== "number") return;
    const waiter = this.#pending.get(id);
    if (!waiter) return;
    this.#pending.delete(id);
    // The server's error object is never surfaced (section 8): one fixed message.
    if ("error" in message) waiter.reject(new ChatMcpError("failed"));
    else waiter.resolve(message.result);
  }
}

function callResultOf(result: unknown, scrub: ChatMcpResultScrub = (value) => value): ChatMcpCallResult {
  if (!isRecord(result)) throw new ChatMcpError("failed");
  const parts: string[] = [];
  let droppedImages = 0;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(String(scrub(part.text)));
    else if (isRecord(part) && part.type === "image") droppedImages += 1;
    // A structured block (an embedded resource, a resource link) is scrubbed on its parsed string leaves BEFORE it is
    // serialized: a secret holding `"` or `\` is escaped by JSON.stringify, and a later scrub of the text would miss it.
    else parts.push(JSON.stringify(scrub(part)) ?? "");
  }
  // Read whole (bounded by the frame cap); scrubbed per block above, the caller scrubs the joined text again, then caps.
  return { isError: result.isError === true, text: parts.join("\n"), droppedImages };
}

function toolDefOf(raw: unknown): ChatMcpToolDef | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name) return null;
  return {
    name: raw.name,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    inputSchema: isRecord(raw.inputSchema) ? raw.inputSchema : { type: "object", properties: {} },
  };
}

async function startSession(connection: ChatMcpConnection): Promise<ChatMcpToolDef[]> {
  const init = await connection.request("initialize", {
    protocolVersion: CHAT_MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "murage", version: "1" },
  });
  if (!isRecord(init)) throw new ChatMcpError("failed");
  connection.notify("notifications/initialized");
  const tools: ChatMcpToolDef[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= CHAT_MCP_MAX_LIST_PAGES) throw new ChatMcpError("failed");
    const listed = await connection.request("tools/list", cursor === undefined ? undefined : { cursor });
    if (!isRecord(listed) || (listed.tools !== undefined && !Array.isArray(listed.tools))) throw new ChatMcpError("failed");
    for (const raw of (listed.tools as unknown[] | undefined) ?? []) {
      const tool = toolDefOf(raw);
      if (tool && !names.has(tool.name)) { names.add(tool.name); tools.push(tool); }
    }
    const next = listed.nextCursor;
    if (typeof next !== "string" || next === "") break;
    if (cursors.has(next)) throw new ChatMcpError("failed"); // a server that repeats a cursor would page forever
    cursors.add(next);
    cursor = next;
  }
  return tools;
}

/** Start every configured server concurrently and return the ones that came up, in config order. `failed` names the rest
 *  (no command, spawn refused, startup error or budget); their children are already closed. An abort during startup
 *  closes everything spawned and resolves with no sessions and nothing failed. */
export async function openChatMcpServers(
  servers: Record<string, unknown>,
  options: OpenChatMcpOptions = {},
): Promise<{ sessions: ChatMcpSession[]; failed: string[] }> {
  const { signal } = options;
  if (signal?.aborted) return { sessions: [], failed: [] };
  const spawn = options.spawn ?? defaultSpawn;
  const startupMs = typeof options.startupMs === "number" && options.startupMs > 0 ? options.startupMs : CHAT_MCP_STARTUP_MS;
  const slots: Array<{ name: string; connection?: ChatMcpConnection }> = [];
  // Everything is spawned and reported synchronously, before the first await.
  for (const [name, entry] of Object.entries(servers ?? {})) {
    const launch = parseEntry(entry);
    if (!launch) { slots.push({ name }); continue; }
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, chatMcpChildEnv(launch.env));
    } catch {
      slots.push({ name });
      continue;
    }
    const descendants = new ChatMcpDescendants(child);
    const teardown = chatMcpTeardown(child, descendants);
    const connection = new ChatMcpConnection(name, child, teardown, descendants);
    try {
      options.onSpawn?.(name, teardown);
    } catch {
      connection.close();
      slots.push({ name });
      continue;
    }
    slots.push({ name, connection });
  }
  let aborted = false;
  const closeAll = () => { for (const slot of slots) slot.connection?.close(); };
  const onAbort = () => { aborted = true; closeAll(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const started = await Promise.all(slots.map(async (slot) => {
      const connection = slot.connection;
      if (!connection) return false;
      const timer = setTimeout(() => connection.close(), startupMs);
      try {
        connection.tools = await startSession(connection);
        connection.trackDescendants();
        return !connection.closed;
      } catch {
        connection.close();
        return false;
      } finally {
        clearTimeout(timer);
      }
    }));
    if (aborted || signal?.aborted) {
      closeAll();
      return { sessions: [], failed: [] };
    }
    const sessions: ChatMcpSession[] = [];
    const failed: string[] = [];
    slots.forEach((slot, index) => {
      if (started[index] && slot.connection) sessions.push(slot.connection);
      else failed.push(slot.name);
    });
    return { sessions, failed };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
