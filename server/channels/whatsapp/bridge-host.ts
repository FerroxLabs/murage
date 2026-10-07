// Copyright 2026 Ferrox Labs
// Spawn shape follows server/memory/worker-controller.ts; respawn backoff and ping supervision follow
// WHATSAPP-DESIGN.md 1.2. Reconnect ownership stays inside the bridge; this host only supervises the process.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Parent-side supervisor of the WhatsApp bridge child (design 1.1, 1.2, 1.5).
// - Forks the bridge with ELECTRON_RUN_AS_NODE=1, the way the memory worker is forked, so a packaged app
//   runs it with the Electron binary as a Node runtime.
// - 30 s handshake (`ready`), then `init` with the auth key over IPC (never argv, never environment).
// - A real liveness check: `ping` every 10 s, `pong` expected within the next tick, three misses and SIGKILL.
//   (The memory worker's "heartbeat" renews a database lease and is not a ping.)
// - Respawn backoff doubling from 5 s to 30 min; owned-child kill on stop.
// - A request map with per-call deadlines for reserve, send, groups and resolve.
// The host never decides what a message means; it only moves validated messages both ways.
import { fork as nodeFork, type ChildProcess } from "node:child_process";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import {
  HANDSHAKE_DEADLINE_MS, HEARTBEAT_INTERVAL_MS, parseChildMessage, PING_MISS_LIMIT, PONG_DEADLINE_MS, PROTOCOL_VERSION, respawnDelay, redactForLog,
  type BridgeOptions, type ChildMessage, type HostMessage, type MessageKeyRef, type QuoteRef, type SendErrorWire,
} from "./core/protocol.ts";

export type ForkFn = (script: string, args: string[], options: { execArgv: string[]; stdio: Array<"ignore" | "ipc">; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface HostTimings {
  handshakeMs: number;
  pingEveryMs: number;
  /** A ping unanswered by the next tick is a miss; kept for documentation and the fixture tests. */
  pongWithinMs: number;
  missLimit: number;
  /** How long a child must live before its crash count resets. */
  stableMs: number;
  reserveMs: number;
  sendMs: number;
  queryMs: number;
  stopGraceMs: number;
}

export const DEFAULT_TIMINGS: HostTimings = {
  handshakeMs: HANDSHAKE_DEADLINE_MS,
  pingEveryMs: HEARTBEAT_INTERVAL_MS,
  pongWithinMs: PONG_DEADLINE_MS,
  missLimit: PING_MISS_LIMIT,
  stableMs: 60_000,
  reserveMs: 15_000,
  sendMs: 5 * 60_000,
  queryMs: 30_000,
  stopGraceMs: 2_000,
};

export interface BridgeHostOptions {
  connectionId: string;
  /** DATA_DIR/whatsapp */
  dataDir: string;
  mode: "self-chat" | "contacts";
  appVersion: string;
  /** Resolves the 64-character hex auth key. Called on every spawn, so a respawn never relies on a stale copy. */
  getAuthKey: () => Promise<string> | string;
  /** Per-spawn extras for `init`: the last good web version and the last time the socket was seen connected. */
  initExtras?: () => { lastGoodWebVersion?: [number, number, number]; lastSeenAtMs?: number; retainedBinding?: boolean };
  options?: BridgeOptions;
  dryRun?: boolean;
  /** Child entry: the .ts source in dev, the compiled .js once packaged. */
  script?: string;
  fork?: ForkFn;
  /** Extra environment for the child (tests). */
  env?: NodeJS.ProcessEnv;
  timings?: Partial<HostTimings>;
  /** Every validated child message except `pong`, `ready` and request responses. */
  onMessage: (message: ChildMessage) => void;
  /** Host-side lifecycle notes for the service: spawn, ready, exit (with the delay before respawn), stopped. */
  onLifecycle?: (event: HostLifecycle) => void;
}

export type HostLifecycle =
  | { kind: "spawned"; pid: number | undefined }
  | { kind: "ready" }
  | { kind: "handshake-timeout" }
  | { kind: "spawn-error" }
  | { kind: "unresponsive"; misses: number }
  | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null; respawnInMs: number | null }
  | { kind: "key-unavailable"; respawnInMs: number }
  | { kind: "stopped" };

/** A request failed. `uncertain` is true when the bridge may still have transmitted (a send whose child died or timed out). */
export class BridgeRequestError extends Error {
  readonly error: SendErrorWire;
  readonly sentIds: string[];
  constructor(error: SendErrorWire, sentIds: string[] = []) {
    super(error.message);
    this.name = "BridgeRequestError";
    this.error = error;
    this.sentIds = sentIds;
  }
}

interface Pending {
  kind: "reserve" | "send" | "query";
  resolve: (value: unknown) => void;
  reject: (error: BridgeRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HostStatus { pid: number | undefined; ready: boolean; failures: number; misses: number; respawnAt: number | null; stopped: boolean }

export class BridgeHost {
  private opts: BridgeHostOptions;
  private timings: HostTimings;
  private forkFn: ForkFn;
  private script: string;
  private child: ChildProcess | null = null;
  private ready = false;
  private initializing = false;
  private authorizations = new Map<string, number>();
  private stopped = false;
  private failures = 0;
  private misses = 0;
  private pingN = 0;
  private lastPong = 0;
  private reqN = 0;
  private respawnAt: number | null = null;
  private pending = new Map<string, Pending>();
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private spawning = false;

  constructor(options: BridgeHostOptions) {
    this.opts = options;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.forkFn = options.fork ?? (nodeFork as unknown as ForkFn);
    this.script = options.script ?? SPAWNED_PROXIES.whatsappBridge;
  }

  status(): HostStatus {
    return { pid: this.child?.pid, ready: this.ready, failures: this.failures, misses: this.misses, respawnAt: this.respawnAt, stopped: this.stopped };
  }

  /** Spawns the child and starts supervising. Resolves once the process is forked; `onLifecycle` reports `ready`. */
  async start(): Promise<void> {
    if (this.stopped && this.child) throw new Error("WhatsApp child exit is not confirmed");
    this.stopped = false;
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    if (this.stopped || this.child || this.spawning) return;
    this.spawning = true;
    this.respawnAt = null;
    try {
      const execArgv = this.script.endsWith(".ts") ? ["--experimental-strip-types", "--max-old-space-size=512"] : ["--max-old-space-size=512"];
      // The same environment the memory worker gets, plus nothing secret: the auth key goes over IPC in `init`.
      const env: NodeJS.ProcessEnv = {
        ELECTRON_RUN_AS_NODE: "1",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        ...this.opts.env,
      };
      const child = this.forkFn(this.script, [], { execArgv, stdio: ["ignore", "ignore", "ignore", "ipc"], env });
      this.child = child;
      this.ready = false;
      this.initializing = false;
      this.authorizations.clear();
      this.misses = 0;
      this.pingN = 0;
      this.lastPong = 0;
      child.on("message", (raw: unknown) => this.onChildMessage(child, raw));
      child.on("error", () => {
        if (this.child !== child) return;
        this.opts.onLifecycle?.({ kind: "spawn-error" });
        // A failed spawn has no process. Other errors do not prove exit.
        if (child.pid === undefined) this.onExit(child, null, null);
      });
      child.on("exit", (code, signal) => this.onExit(child, code, signal));
      this.handshakeTimer = setTimeout(() => {
        if (this.child !== child || this.ready) return;
        this.opts.onLifecycle?.({ kind: "handshake-timeout" });
        this.kill(child);
      }, this.timings.handshakeMs);
      this.opts.onLifecycle?.({ kind: "spawned", pid: child.pid });
    } finally {
      this.spawning = false;
    }
  }

  private kill(child: ChildProcess): void {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }

  private clearTimers(): void {
    for (const timer of [this.handshakeTimer, this.stableTimer, this.respawnTimer]) if (timer) clearTimeout(timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.handshakeTimer = this.stableTimer = this.respawnTimer = null;
    this.pingTimer = null;
  }

  private onChildMessage(child: ChildProcess, raw: unknown): void {
    if (this.child !== child || this.stopped) return;
    const message = parseChildMessage(raw);
    if (!message) return;
    switch (message.kind) {
      case "ready":
        if (message.baileysVersion) this.opts.onMessage(message);
        void this.onReady(child);
        return;
      case "initialized":
        this.ready = true;
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.opts.onLifecycle?.({ kind: "ready" });
        return;
      case "pong":
        this.lastPong = message.n;
        return;
      case "reserved":
        this.settle(message.reqId, (p) => p.resolve(message.ids));
        return;
      case "send-result":
        if (message.ok) this.settle(message.reqId, (p) => p.resolve(message.ids));
        else this.settle(message.reqId, (p) => p.reject(new BridgeRequestError(message.error, message.sentIds)));
        return;
      case "result":
        if (message.ok) this.settle(message.reqId, (p) => p.resolve(message.value));
        else this.settle(message.reqId, (p) => p.reject(new BridgeRequestError(message.error)));
        return;
      default:
        try { this.opts.onMessage(message); } catch { /* a throwing consumer must not take the supervisor down */ }
    }
  }

  private async onReady(child: ChildProcess): Promise<void> {
    if (this.stopped || this.ready || this.initializing) return;
    this.initializing = true;
    let keyHex: string;
    try {
      keyHex = await this.opts.getAuthKey();
    } catch {
      // The key could not be produced (credential store refused). Treat as a failed start with backoff; no key is ever invented here.
      this.failures++;
      const delay = respawnDelay(this.failures);
      this.opts.onLifecycle?.({ kind: "key-unavailable", respawnInMs: delay });
      this.kill(child);
      return;
    }
    if (this.stopped || this.child !== child) return;
    const extras = this.opts.initExtras?.() ?? {};
    const init: HostMessage = {
      kind: "init", v: PROTOCOL_VERSION, connectionId: this.opts.connectionId, dataDir: this.opts.dataDir, authKeyHex: keyHex, mode: this.opts.mode, appVersion: this.opts.appVersion,
      ...(extras.lastGoodWebVersion ? { lastGoodWebVersion: extras.lastGoodWebVersion } : {}),
      ...(extras.lastSeenAtMs !== undefined ? { lastSeenAtMs: extras.lastSeenAtMs } : {}),
      ...(this.opts.options ? { options: this.opts.options } : {}),
      ...(extras.retainedBinding ? { retainedBinding: true } : {}),
      ...(this.opts.dryRun ? { dryRun: true } : {}),
    };
    this.post(init);
    this.pingTimer = setInterval(() => this.tick(child), this.timings.pingEveryMs);
    this.pingTimer.unref?.();
    this.stableTimer = setTimeout(() => { this.failures = 0; }, this.timings.stableMs);
    this.stableTimer.unref?.();
  }

  /** One liveness tick: a ping from the previous tick that never came back is a miss; three misses and the child is killed. */
  private tick(child: ChildProcess): void {
    if (this.child !== child || !this.ready) return;
    if (this.pingN > 0 && this.lastPong < this.pingN) this.misses++;
    else this.misses = 0;
    if (this.misses >= this.timings.missLimit) {
      this.opts.onLifecycle?.({ kind: "unresponsive", misses: this.misses });
      this.kill(child);
      return;
    }
    this.pingN++;
    this.post({ kind: "ping", n: this.pingN });
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.clearTimers();
    // Anything in flight may have reached WhatsApp or not; a send is reported uncertain and never retried here.
    for (const [reqId, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      this.pending.delete(reqId);
      pending.reject(new BridgeRequestError({ code: pending.kind === "send" ? "timeout" : "offline", message: "The WhatsApp bridge stopped", ...(pending.kind === "send" ? { uncertain: true } : {}) }));
    }
    if (this.stopped) { this.opts.onLifecycle?.({ kind: "exited", code, signal, respawnInMs: null }); return; }
    this.failures++;
    const delay = respawnDelay(this.failures);
    this.respawnAt = Date.now() + delay;
    this.opts.onLifecycle?.({ kind: "exited", code, signal, respawnInMs: delay });
    this.respawnTimer = setTimeout(() => { this.respawnTimer = null; void this.spawn(); }, delay);
    this.respawnTimer.unref?.();
  }

  /** Sends one validated-shape message to the child. Returns false when there is no live channel. */
  post(message: HostMessage): boolean {
    const child = this.child;
    if (!child || !child.connected) return false;
    try { child.send(message); return true; } catch { return false; }
  }

  private settle(reqId: string, action: (pending: Pending) => void): void {
    const pending = this.pending.get(reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(reqId);
    action(pending);
  }

  private request<T>(kind: Pending["kind"], deadlineMs: number, build: (reqId: string) => HostMessage): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const reqId = `r${++this.reqN}`;
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new BridgeRequestError({ code: "timeout", message: "The WhatsApp bridge did not answer in time", ...(kind === "send" ? { uncertain: true } : {}) }));
      }, deadlineMs);
      this.pending.set(reqId, { kind, resolve: resolve as (value: unknown) => void, reject, timer });
      if (!this.ready || !this.post(build(reqId))) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new BridgeRequestError({ code: "offline", message: "The WhatsApp bridge is not running" }));
      }
    });
  }

  /** Reserves outbound ids (one per chunk) on disk before any send. */
  reserve(chatId: string, payload: { type: "text"; text: string } | { type: "audio" }): Promise<string[]> {
    return this.request<string[]>("reserve", this.timings.reserveMs, (reqId) => ({ kind: "reserve", reqId, chatId, payload }));
  }

  /** Sends under reserved ids. A rejection carries `sentIds`; with sent ids present the reply is partial and must not be retried. */
  send(chatId: string, ids: string[], payload: { type: "text"; text: string; quote?: QuoteRef } | { type: "audio"; name: string; mime: string; bytesBase64: string }): Promise<string[]> {
    return this.request<string[]>("send", this.timings.sendMs, (reqId) => ({ kind: "send", reqId, chatId, generation: this.authorizations.get(chatId) ?? 0, ids, payload }));
  }

  groups(): Promise<Array<{ jid: string; subject: string; size: number }>> {
    return this.request("query", this.timings.queryMs, (reqId) => ({ kind: "groups", reqId }));
  }

  resolve(op: "pn-for-lid" | "lid-for-pn", jid: string): Promise<{ jid: string | null }> {
    return this.request("query", this.timings.queryMs, (reqId) => ({ kind: "resolve", reqId, op, jid }));
  }

  async link(method: "qr" | "code", phone?: string): Promise<boolean> {
    const deadline = Date.now() + this.timings.handshakeMs;
    while (!this.ready) {
      if (this.stopped || !this.child?.connected || Date.now() >= deadline) throw new BridgeRequestError({ code: "timeout", message: "WhatsApp initialization did not complete" });
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return this.post(method === "qr" ? { kind: "link", method: "qr" } : { kind: "link", method: "code", ...(phone ? { phone } : {}) });
  }
  revoke(chatId: string): void {
    const generation = (this.authorizations.get(chatId) ?? 0) + 1;
    this.authorizations.set(chatId, generation);
    this.post({ kind: "authorize", chatId, generation });
  }
  logout(): Promise<void> { return this.request("query", 11_000, reqId => ({ kind: "logout", reqId })); }
  ack(seq: number): boolean { return this.post({ kind: "ack", seq }); }
  replay(): boolean { return this.post({ kind: "replay" }); }
  presence(chatId: string, state: "composing" | "paused"): boolean { return this.post({ kind: "presence", chatId, state }); }
  read(keys: MessageKeyRef[]): boolean { return this.post({ kind: "read", keys }); }

  /** Stops supervising and requires exit within the grace and kill deadlines. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    this.clearTimers();
    const child = this.child;
    for (const [reqId, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      this.pending.delete(reqId);
      pending.reject(new BridgeRequestError({ code: "offline", message: "The WhatsApp bridge is stopping" }));
    }
    if (!child) { this.opts.onLifecycle?.({ kind: "stopped" }); return; }
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error): void => {
        if (done) return;
        done = true; clearTimeout(grace); clearTimeout(deadline); child.removeListener("exit", exited);
        if (error) { reject(error); return; }
        if (this.child === child) this.onExit(child, child.exitCode, child.signalCode);
        resolve();
      };
      const exited = (): void => finish();
      const grace = setTimeout(() => {
        deadline = setTimeout(() => finish(new Error("WhatsApp child exit is not confirmed")), this.timings.stopGraceMs);
        this.kill(child);
      }, this.timings.stopGraceMs);
      child.once("exit", exited);
      if (child.exitCode !== null || child.signalCode !== null) finish();
      else if (!this.post({ kind: "stop" })) this.kill(child);
    });
    this.opts.onLifecycle?.({ kind: "stopped" });
  }

  /** For logs: a message with QR text, keys, message bodies and credentials replaced. */
  static redact(message: unknown): unknown { return redactForLog(message); }
}
