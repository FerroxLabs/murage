import type { EngineTransport } from "../../shared/engine-transport.ts";
import { NotModelRequest } from "../../shared/engine-transport.ts";
import { registerBusyloopPayloadSite } from "../../shared/flux-route.ts";
import { botFolderOrThrow } from "../bot-folder.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The hardened stdio MCP client the chat-completions engines mount their tools through (OPENAI-TOOLS-109 section 3).
// JSON-RPC 2.0 over newline-delimited frames. pi-mcp-extension.ts StdioMcp is a framing reference only and is not reused:
// every child here is started by spawnCli under an engine job (tree kill, Windows job objects), gets an ALLOWLIST-built
// environment (never process.env stripped), is tracked by a ChildTeardown from the moment it exists, and is stopped by
// markStopRequested then killCliTree. Nothing a server writes to stderr is ever read, and no server error text or stderr
// reaches a caller: every failure carries one of the fixed ChatMcpError messages (section 8).
import { RelayedMount } from "./cli-mount-relay.ts";
import type { ChildProcess } from "node:child_process";
import { admittedMcpMount, type AdmittedMcpMount } from "./mcp-mounts.ts";

import { augmentedPath } from "../env-path.ts";
import {
  awaitCliTreeStopped, CLI_FORCE_WAIT_MS, CLI_TERM_GRACE_MS, cliStopDelivery, cliTreeStoppedSignal, engineJob, killCliTree, markPerPairStop, spawnCli,
} from "../procs.ts";
import { alreadyClosed, ChildTeardown } from "./child-teardown.ts";
import { randomUUID } from "node:crypto";
import { enrollUnprovenStop, mcpStopStore, mcpStopTargetDeps, planMcpSpawn, spawnPlanned, type McpSpawnPlan } from "./mcp-stop-runtime.ts";
import type { StopRecord } from "./mcp-stop-proof.ts";
import type { ProbeOutcome } from "./mcp-stop-recovery.ts";
import { DesktopStopTarget, ProofBatch, WindowsStopTarget, captureTargets, type StopTarget } from "./mcp-stop-target.ts";
import { HELPER_CAP_MS, type WarmHelper } from "./mcp-stop-helper.ts";

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
  /** Retire ingress before intentionally removing a mount mid-turn. */
  retire(): void;
  readonly closed: boolean;
}
export interface OpenChatMcpOptions {
  cwd?: string;
  signal?: AbortSignal;
  startupMs?: number;
  /** Called synchronously for every child the moment it is spawned, before any await, so the caller tracks even a child
   *  whose startup then fails. */
  onSpawn?(server: string, teardown: ChildTeardown): void;
  /** Test hook. Default: spawnCli under engineJob(). */
  spawn?: (command: string, args: string[], env: Record<string, string>, cwd: string, plan?: McpSpawnPlan) => ChildProcess;
  /** The stop-record owner key (the bot or thread); a run without one is its own owner. */
  owner?: string;
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

const defaultSpawn = (command: string, args: string[], env: Record<string, string>, cwd: string, plan?: McpSpawnPlan): ChildProcess =>
  !env.MURAGE_RELEASE_INSTANCE
    ? spawnCli(command, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env }, plan ? plan.job : engineJob())
    : spawnCli(command, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"], env }, plan ? plan.job : engineJob());

const validId = (id: unknown): boolean => typeof id === "number" || typeof id === "string" || id === null;

interface Pending { resolve(value: unknown): void; reject(error: ChatMcpError): void }
interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }

/** A call stopped by abort or timeout: after its notifications/cancelled, how long the server has to read it before its stop
 *  starts (a server that exits by itself ends the wait at once). Without it a Windows job kill lands in the same tick as the
 *  write, so no server there ever read its cancellation. */
export const CHAT_MCP_CANCEL_GRACE_MS = 1_000;
/** H6: how long a stop waits for the descendant snapshot before it ends the server anyway. */
export const CHAT_MCP_SNAPSHOT_CAP_MS = 1_000;
/** One live proof attempt of the stop (aborted, its helper child killed, and counted UNKNOWN at the cap). */
export const CHAT_MCP_PROOF_CAP_MS = 5_000;
const settleWithin = (work: Promise<unknown>, ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  void work.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
});
/** The startup walks that have settled (R8-C C2: a stop then sends its capture at once instead of a tick later). */
const settledWalks = new WeakSet<Promise<void>>();
const pause = (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
/** H6, rebuilt on the MCP stop proof (mcp-stop-proof.ts, design V). The server's stop target is one durable record plus a platform proof:
 *  Cloud the stored scope's cgroup, Windows the stored job, desktop every (pid, start) pair ever observed (the U1 union: the root at
 *  RUNNING, one budgeted walk after startup and after each answered call, the pre-stop capture). The pre-stop capture happens BEFORE
 *  stdin ends or anything is signalled (bounded by CHAT_MCP_SNAPSHOT_CAP_MS, with its read aborted at the cap); only a proof that
 *  succeeds AFTER the kill says gone. A proof that cannot be obtained is UNKNOWN: the run stays owned and the stop is handed to the
 *  bounded recovery (mcp-stop-recovery.ts), which releases it only on a later proof. Nothing here reads an empty process-list walk as a
 *  verdict, ChatMcpDescendants.stop() never resolves true because the platform is win32, and no desktop path signals a process group. */
export class ChatMcpDescendants {
  readonly #active: boolean;
  readonly #target: StopTarget | null;
  /** The pre-stop capture did not complete: what escaped is unknown (it stays unknown after the kill, R2). */
  #blind = false;
  #inFlight: Promise<void> | null = null;
  /** The startup walk (the first track()): the only walk a stop's capture waits on (R8 amendment B1). */
  #startup: Promise<void> | null = null;
  /** The abort of the running walk when it is a later one (after an answered call): the stop's capture ends it instead of waiting. */
  #rewalk: AbortController | null = null;
  /** The post-kill proofs of the stop this server's capture was shared with (R8 amendment B2): one helper per round for all of them. */
  #proofs: ProofBatch | null = null;
  #ready: Promise<void> | null = null;
  #stop: Promise<boolean> | null = null;
  #gone = false;
  #resolveGone: (() => void) | null = null;
  #goneSignal: Promise<true> | null = null;

  constructor(child: ChildProcess, platform: NodeJS.Platform = process.platform, target?: StopTarget) {
    this.#active = typeof child.pid === "number";
    this.#target = !this.#active ? null : target ?? defaultStopTarget(child.pid!, platform);
    if (this.#target && platform !== "win32") markPerPairStop(child);
  }

  /** False only for a child the OS never created: nothing to track. */
  get active(): boolean { return this.#active; }
  /** The proof's record (tests and the relay read it). */
  get target(): StopTarget | null { return this.#target; }

  #queued: Promise<void> | null = null;

  /** Remember the server's current descendants (U1). The returned promise settles once an enumeration that STARTED AFTER this call has
   *  persisted its result: a walk already running is followed by one more (coalesced), never reused for a later answer. */
  track(): Promise<void> {
    if (!this.#target || this.#ready) return Promise.resolve();
    if (this.#inFlight) return this.#queued ??= this.#inFlight.then(() => { this.#queued = null; return this.#begin(); });
    return this.#begin();
  }

  #begin(): Promise<void> {
    if (!this.#target || this.#ready) return Promise.resolve();
    const rewalk = this.#startup ? new AbortController() : null;
    const run: Promise<void> = this.#target.track(rewalk?.signal).catch(() => undefined)
      .finally(() => { if (this.#inFlight === run) { this.#inFlight = null; this.#rewalk = null; } });
    this.#inFlight = run; this.#rewalk = rewalk;
    if (!this.#startup) { this.#startup = run; void run.then(() => { settledWalks.add(run); }); }
    return run;
  }

  /** The stop's own capture, bounded: the group is signalled and stdin ended only once it settled (or its cap passed). At the cap the
   *  capture's reads are aborted and the capture is unknown for good. `peers` are the other servers of the same stop (a relay's
   *  children): the first ready() of that stop captures every peer not yet captured in ONE request (captureTargets: one helper child,
   *  one enumeration, R8 as amended 2026-11-17) under ONE cap, after only the batch's startup walks (amendment B1),
   *  and each peer's ready() is that shared capture. A peer whose answer is missing at the cap is blind exactly as a lone capture would be (fail closed: one stalled helper leaves every peer it covered owned). */
  ready(peers: readonly ChatMcpDescendants[] = [], warm?: WarmHelper | null): Promise<void> {
    if (!this.#target) return Promise.resolve();
    if (this.#ready) return this.#ready;
    const batch = [this, ...peers.filter((peer) => peer !== this && peer.#target && !peer.#ready)];
    const controller = new AbortController();
    const answered = batch.map(() => false);
    // B1: wait only on the startup walks of the peers being stopped; a later walk still running is aborted (its helper killed, so it
    // persists nothing after the capture), because the capture's own fresh enumeration supersedes it
    // R8-C (C2): when every startup walk has settled the capture request is sent NOW, synchronously, at the stop request (not a tick later,
    // after the stop loop); the warm helper (C1) then answers it while the rest of the stop request runs
    for (const one of batch) one.#rewalk?.abort();
    const startups = batch.map((one) => one.#startup).filter((walk): walk is Promise<void> => walk !== null && !settledWalks.has(walk));
    // MC63 R-B: CHAT_MCP_SNAPSHOT_CAP_MS bounds the capture itself, so its clock starts only once the startup walks settled. The walk wait
    // keeps the walk's own existing bound, HELPER_CAP_MS (a walk is one helper request, killed and answered null at that cap,
    // mcp-stop-helper.ts); a walk still unsettled there fails closed: no capture is sent and every peer of the batch is blind
    const captureNow = () => settleWithin(captureTargets(batch.map((one) => one.#target!), controller.signal, warm)
      .then((oks) => { oks.forEach((ok, i) => { answered[i] = ok; }); }), CHAT_MCP_SNAPSHOT_CAP_MS);
    let walked = !startups.length;
    const captured = walked ? captureNow()
      : settleWithin(Promise.all(startups).then(() => { walked = true; }), HELPER_CAP_MS).then(() => walked ? captureNow() : undefined);
    const shared = captured.then(() => {
      let blind = false;
      batch.forEach((one, i) => { if (!answered[i]) { one.#blind = true; blind = true; } });
      if (blind) controller.abort();
    });
    const proofs = new ProofBatch();
    for (const one of batch) { one.#ready = shared; one.#proofs = proofs; }
    return shared;
  }

  /** Idempotent: true once the platform proof says gone; false when the stop stays unproven (goneSignal reports a later proof). */
  stop(): Promise<boolean> {
    if (!this.#target) return Promise.resolve(true);
    return this.#stop ??= this.#run(this.#target);
  }

  /** Resolves whenever the stop is finally proven; never otherwise. */
  goneSignal(): Promise<true> {
    if (!this.#target || this.#gone) return Promise.resolve(true);
    return this.#goneSignal ??= new Promise<true>((resolve) => { this.#resolveGone = () => resolve(true); });
  }

  async #run(target: StopTarget): Promise<boolean> {
    await this.ready();
    await target.kill("SIGTERM").catch(() => undefined);
    if (!this.#blind && await this.#waitGone(target, CLI_TERM_GRACE_MS)) return this.#markGone(target);
    await target.kill("SIGKILL").catch(() => undefined);
    if (this.#blind) {
      console.warn("[chat-mcp] the pre-stop capture gave no answer before the MCP server was stopped, so an escaped descendant cannot be ruled out; the run stays owned");
    } else if (await this.#waitGone(target, CLI_FORCE_WAIT_MS)) return this.#markGone(target);
    else console.warn("[chat-mcp] the MCP server's stop could not be proven after SIGKILL; the run stays owned and is re-proved with backoff");
    void enrollUnprovenStop(target.record).then(() => { this.#markGone(target); });
    return false;
  }

  #markGone(target: StopTarget): true {
    this.#gone = true;
    mcpStopStore()?.delete(target.record);
    this.#resolveGone?.();
    return true;
  }

  async #waitGone(target: StopTarget, ms: number, every = 100): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      // Each live proof sits under an encompassing budget (the stop's remaining wait, at most CHAT_MCP_PROOF_CAP_MS): at the cap its
      // reads are aborted (the helper child is killed) and the attempt is UNKNOWN, so a stalled enumeration cannot hold the stop open.
      const controller = new AbortController();
      const left = Math.max(1, Math.min(CHAT_MCP_PROOF_CAP_MS, deadline - Date.now()));
      const timer = setTimeout(() => controller.abort(), left);
      timer.unref?.();
      const outcome = await Promise.race([
        (this.#proofs ? this.#proofs.prove(target, controller.signal) : target.prove(controller.signal)).catch((): ProbeOutcome => ({ v: "unknown", why: "the proof threw" })),
        new Promise<ProbeOutcome>((resolve) => { controller.signal.addEventListener("abort", () => resolve({ v: "unknown", why: "the proof passed its cap" }), { once: true }); }),
      ]).finally(() => clearTimeout(timer));
      if (outcome.v === "gone") return true;
      if (Date.now() >= deadline) return false;
      await pause(Math.min(every, Math.max(0, deadline - Date.now())));
    }
  }
}

/** A target for a child built without a stop lifecycle (a test, a caller that never planned a record): an in-memory record, so the
 *  same proof rules apply. win32 has no job record here, so it can never prove gone. */
function defaultStopTarget(pid: number, platform: NodeJS.Platform): StopTarget {
  const base: StopRecord = { version: 1, owner: `unplanned:${pid}`, generation: Date.now() * 1000, platform: "desktop", state: "RUNNING", desktop: { pairs: [], captureCompleted: false } };
  if (platform === "win32") return new WindowsStopTarget({ ...base, platform: "windows", desktop: undefined }, { store: null });
  const adhoc = new DesktopStopTarget(base, pid, platform === "darwin" ? "darwin" : "linux", { ...mcpStopTargetDeps(), store: null });
  return adhoc;
}

/** The signal that ends an MCP server's root. Windows: the job (TerminateJobObject through killCliTree), never a pid. Elsewhere the root and
 *  every descendant are ended by ChatMcpDescendants.stop(), one identity-verified signal per recorded pair (U3): a desktop path never signals a
 *  process group, so a pgid shared with an unrelated process receives nothing. A child the proof does not track keeps the tree kill. */
export function killMcpRoot(child: ChildProcess, descendants: ChatMcpDescendants): void {
  if (process.platform === "win32" || !descendants.active) killCliTree(child);
}

/** The server's teardown: the group's confirmation (after the stop's snapshot) AND every remembered descendant gone. */
export function chatMcpTeardown(child: ChildProcess, descendants: ChatMcpDescendants): ChildTeardown {
  // A POSIX proof cannot close inherited pipes held by a process outside the captured set.
  const rootClosed = !descendants.target || process.platform === "win32" || child.pid === undefined || alreadyClosed(child)
    ? Promise.resolve() : new Promise<void>(resolve => child.once("close", () => resolve()));
  return new ChildTeardown(
    child,
    // POSIX with a tracked target (U3/V5): the stop is descendants.stop() alone, one signal per recorded pair; the group is never signalled.
    (target) => descendants.target && process.platform !== "win32"
      ? descendants.ready().then(() => descendants.stop()).then(gone => gone ? rootClosed.then(() => true) : false)
      : Promise.all([descendants.ready().then(() => awaitCliTreeStopped(target)), descendants.stop()]).then(([tree, rest]) => tree && rest),
    cliStopDelivery,
    (target) => descendants.target && process.platform !== "win32"
      ? descendants.goneSignal().then(() => rootClosed).then(() => true as const)
      : Promise.all([cliTreeStoppedSignal(target), descendants.goneSignal()]).then(() => true as const),
  );
}

export class ChatMcpConnection implements ChatMcpSession, EngineTransport {
  readonly engineTransport = true as const;
  readonly #mount: AdmittedMcpMount;
  readonly server: string;
  readonly teardown: ChildTeardown;
  readonly #child: ChildProcess;
  #tools: ChatMcpToolDef[] = [];
  #closed = false;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #transport: RelayedMount;
  #frames = 0;

  readonly #descendants: ChatMcpDescendants;

  constructor(server: string, child: ChildProcess, teardown: ChildTeardown, descendants: ChatMcpDescendants, mount: AdmittedMcpMount) {
    this.#mount = mount;
    this.server = server;
    this.#child = child;
    this.teardown = teardown;
    this.#descendants = descendants;
    this.#transport = new RelayedMount(child, mount, frame => this.#acceptFrame(frame), error => { if (error !== undefined) this.retire(); this.close(); });
  }

  get tools(): ChatMcpToolDef[] { return this.#tools; }
  set tools(tools: ChatMcpToolDef[]) { this.#tools = tools; }
  get closed(): boolean { return this.#closed; }

  /** Remember the server's current descendants (H6); called after startup and after each answered call. */
  trackDescendants(): Promise<void> { return this.#descendants.track(); }

  retire(): void { this.#mount.ingress.retire(); }

  /** Idempotent. Every pending request rejects; the child is marked stop-requested, then its whole tree is killed. On POSIX
   *  (H6) stdin ends and the group is signalled only after the stop's descendant snapshot (bounded by CHAT_MCP_SNAPSHOT_CAP_MS),
   *  so a descendant that left the group is still found through its parent, and is ended with it. */
  close(): void { this.#shutdown(0); }

  /** close() after a grace: the stop (stop request, descendant snapshot, stdin end, tree kill) starts once the server exits or
   *  `graceMs` passes, on every platform, so a notifications/cancelled just written is read before the kill. The teardown is marked
   *  stop-requested only then, so no teardown wait starts the kill early (markStopRequested starts the confirmation for a wait
   *  already running); every wait's own close and max budgets still bound it. */
  #shutdown(graceMs: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport.retire();
    this.#mount.close();
    const pending = [...this.#pending.values()];
    this.#pending.clear();

    const child = this.#child;
    const kill = () => {
      try { child.stdin?.end(); } catch { /* already closed */ }
      try { killMcpRoot(child, this.#descendants); } catch { /* already gone */ }
    };
    const requestStop = () => {
      this.teardown.markStopRequested();
      if (this.#descendants.active) void this.#descendants.stop();
    };
    const stopNow = () => {
      requestStop();
      if (this.#descendants.active) void this.#descendants.ready().then(kill);
      else kill();
    };
    if (graceMs <= 0 || child.exitCode !== null || child.signalCode !== null) stopNow();
    else {
      // The server keeps its stdin and its descendants stay untouched while it reads the cancellation; the stop that follows is the
      // immediate one, so its descendant snapshot is taken after the grace, right before stdin ends and the group is signalled.
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.off("exit", finish);
        stopNow();
      };
      const timer = setTimeout(finish, graceMs);
      child.once("exit", finish);
    }
    for (const waiter of pending) waiter.reject(new ChatMcpError("failed"));
  }

  #write(message: Record<string, unknown>): boolean {
    if (this.#closed) return false;
    try {
      const frame = JSON.stringify(message);
      this.#transport.request(frame);
      if (this.#closed) return false;
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
        try { this.#mount.ingress.cancel(id, frame => { this.#child.stdin?.write(frame + "\n"); }); }
        catch { this.#mount.ingress.seal(); }
        this.#shutdown(CHAT_MCP_CANCEL_GRACE_MS);
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
    const result = await NotModelRequest("MCP initialization, tool discovery/invocation or protocol reply; no inference request", this.request("tools/call", { name, arguments: args }, { signal: opts.signal, timeoutMs }));
    await this.trackDescendants(); // U1: enumerated and persisted BEFORE the turn result returns
    return callResultOf(result, opts.scrub);
  }

  #acceptFrame(text: string): void {
    const line = text.trim();
    if (!line) return;
    if (++this.#frames > CHAT_MCP_MAX_FRAMES) { this.close(); return; }
    let message: unknown;
    try { message = registerBusyloopPayloadSite("read", JSON.parse(line)); } catch { this.close(); return; }
    if (!isRecord(message) || message.jsonrpc !== "2.0") { this.close(); return; }
    const { id, method } = message;
    if (method !== undefined) {
      if (typeof method !== "string") { this.close(); return; }
      if (id === undefined) return; // a notification: nothing this client acts on
      if (!validId(id)) { this.close(); return; }
      // This client serves no server-initiated request (sampling, roots, elicitation, ping).
      // Ingress acceptance currently owns the SQLite writer. This reply is a
      // distinct release: enqueue its fresh admission after that owner exits.
      queueMicrotask(() => {
        if (!this.#closed) this.#write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      });
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
  const init = await NotModelRequest("MCP initialization, tool discovery/invocation or protocol reply; no inference request", connection.request("initialize", {
    protocolVersion: CHAT_MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "murage", version: "1" },
  }));
  if (!isRecord(init)) throw new ChatMcpError("failed");
  NotModelRequest("MCP initialization, tool discovery/invocation or protocol reply; no inference request", connection.notify("notifications/initialized"));
  const tools: ChatMcpToolDef[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= CHAT_MCP_MAX_LIST_PAGES) throw new ChatMcpError("failed");
    const listed = await NotModelRequest("MCP initialization, tool discovery/invocation or protocol reply; no inference request", connection.request("tools/list", cursor === undefined ? undefined : { cursor }));
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
  const admitted = new Map<string, AdmittedMcpMount>();
  try { for (const [name, entry] of Object.entries(servers ?? {})) admitted.set(name, admittedMcpMount(entry)); }
  catch (error) { for (const mount of admitted.values()) mount.close(); throw error; }
  const cwd = botFolderOrThrow(options);
  const launchMcp = options.spawn ?? defaultSpawn;
  const startupMs = typeof options.startupMs === "number" && options.startupMs > 0 ? options.startupMs : CHAT_MCP_STARTUP_MS;
  const slots: Array<{ name: string; connection?: ChatMcpConnection }> = [];
  // Everything is spawned and reported synchronously, before the first await.
  for (const [name, entry] of Object.entries(servers ?? {})) {
    const mount = admitted.get(name)!;
    const launch = parseEntry(entry);
    if (!launch) { mount.close(); slots.push({ name }); continue; }
    let child: ChildProcess;
    let plan: McpSpawnPlan;
    try {
      plan = planMcpSpawn(options.owner ?? `chat-mcp:${randomUUID()}`, { cloud: false });
      child = spawnPlanned(plan, (planned) => launchMcp(launch.command, launch.args, chatMcpChildEnv(launch.env), cwd, planned));
    } catch {
      mount.ingress.retire();
      mount.close();
      slots.push({ name });
      continue;
    }
    const descendants = new ChatMcpDescendants(child, process.platform, plan.life.target(child.pid));
    const teardown = chatMcpTeardown(child, descendants);
    const connection = new ChatMcpConnection(name, child, teardown, descendants, mount);
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
        await connection.trackDescendants();
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
