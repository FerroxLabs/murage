// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import "../../shared/win-hide-child-process.mjs";
import {isObservedChildIoMessage} from "../sentinel/io-child-receipts.ts";
import { cliStdinEnd } from "./cli-stdin-eof.ts";
import { probeFolder } from "../probe-folder.ts";
import type { ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { refuseConsumingTurn } from "../consuming-turn-response.ts";
import type { SendTurnInput } from "../contracts.ts";
import { CLOUD_BROKER_DIR } from "../cloud-home/turn-process.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { brokerSocketPath, spawnCli, engineJob, killCliTree, awaitCliTreeStopped, cliTreeStoppedSignal, CLI_CALLER_DEADLINE_MS } from "../procs.ts";
import { CRED_FILE_ENV, CRED_SERVER_ENV } from "../turn-credential.ts";
import { admittedMcpMount, assertConsumingMountAdmission, type AdmittedMcpMount } from "./mcp-mounts.ts";
import { bindCredentialPath, type TurnCredentialStore, type TurnSecrets } from "./turn-credentials.ts";
import { CHAT_MCP_FRAME_CAP_BYTES, CHAT_MCP_MAX_FRAMES, ChatMcpDescendants, chatMcpTeardown, chatMcpChildEnv } from "./chat-mcp-client.ts";

const transportClosed = () => Object.assign(new Error("MCP_TRANSPORT_CLOSED"), { code: "MCP_TRANSPORT_CLOSED" });

/** Shared by ChatMcpConnection and the CLI relay. One immutable admission owns
 * all stdin, stdout, IPC and transport failure for this child. */
export class RelayedMount {
  #parts: Buffer[] = [];
  #bytes = 0;
  #frames = 0;
  stopping = false;
  readonly child: ChildProcess;
  readonly mount: AdmittedMcpMount;
  readonly write: (frame: string) => void;
  readonly failed: (nativeError?: unknown) => void;
  readonly accepted: () => void;
  readonly pendingBarrier: () => boolean;
  constructor(child: ChildProcess, mount: AdmittedMcpMount,
    write: (frame: string) => void, failed: (nativeError?: unknown) => void, accepted: () => void = () => {}, pendingBarrier: () => boolean = () => false) {
    this.child = child; this.mount = mount; this.write = write; this.failed = failed; this.accepted = accepted;
    this.pendingBarrier = pendingBarrier;
    for (const event of ["error", "exit", "close", "end", "disconnect"]) child.prependOnceListener(event, () => {
      if (this.pendingBarrier()) { this.retire(); this.failed(); }
    });
    mount.ingress.supervise(child);
    child.on("message", message => { if(!isObservedChildIoMessage(child,message))this.fail(); });
    child.on("error", error => this.fail(error));
    child.once("exit", () => this.fail(transportClosed()));
    child.stdin?.on("error", error => this.fail(error));
    child.stderr?.on("error", () => {}); child.stderr?.resume();
    child.stdout?.on("error", error => this.fail(error));
    child.stdout?.on("end", () => this.fail(transportClosed()));
    child.stdout?.on("data", (chunk: Buffer | string) => this.data(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    if (!child.stdin || !child.stdout) this.fail(transportClosed());
  }
  retire(): void { this.stopping = true; this.mount.ingress.retire(); this.#parts = []; this.#bytes = 0; }
  fail(nativeError?: unknown): void {
    if (this.stopping) { this.mount.ingress.retire(); return; }
    if (this.pendingBarrier()) { this.retire(); this.failed(); return; }
    if (nativeError !== undefined) this.retire();
    else this.mount.ingress.seal();
    this.failed(nativeError);
  }
  request(frame: string): void {
    if (this.stopping) return;
    let entered = false;
    try {
      if (!this.child.stdin || this.child.stdin.writableNeedDrain || this.child.stdin.destroyed) throw new Error("MEMORY_CONTEXT_REVOKED");
      this.mount.ingress.request(frame, () => { entered = true; this.child.stdin!.write(frame + "\n"); }, "\n");
    } catch (error) { this.fail(entered ? error ?? new Error("MCP_WRITE_FAILED") : undefined); }
  }
  data(chunk: Buffer): void {
    if (this.stopping) return;
    let entered = false;
    try {
      this.mount.ingress.upstream(chunk.byteLength); // before buffering or scanning
      let start = 0;
      while (start < chunk.length && !this.stopping) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end < 0 ? chunk.length : end);
        if (this.#bytes + part.length > CHAT_MCP_FRAME_CAP_BYTES) throw new Error("MEMORY_CONTEXT_REVOKED");
        this.#parts.push(part); this.#bytes += part.length;
        if (end < 0) return;
        const line = Buffer.concat(this.#parts).toString("utf8");
        this.#parts = []; this.#bytes = 0; start = end + 1;
        if (++this.#frames > CHAT_MCP_MAX_FRAMES) throw new Error("MEMORY_CONTEXT_REVOKED");
        entered = false;
        const envelope = this.mount.accept(line, frame => { entered = true; return this.write(frame); }, "\n");
        entered = false;
        this.accepted();
        if (envelope) {
          // The response has already left. Losing the acknowledgement cannot
          // turn that release into a ledger denial or authorize a replay.
          try {
            if (!this.child.connected || !this.child.send) throw transportClosed();
            this.child.send({ type: "turn-release-ack", instanceId: envelope.instanceId, sequence: envelope.sequence }, error => { if (error) this.fail(error); });
          } catch (error) { this.fail(error ?? transportClosed()); }
        }
      }
    } catch (error) { this.fail(entered ? error ?? new Error("MCP_WRITE_FAILED") : undefined); }
  }
}

export const mountedTurn = (turn: Pick<SendTurnInput, "integrations">, required = false): boolean =>
  required || Object.values(turn.integrations ?? {}).some(value => value && (typeof value !== "object" || Object.keys(value).length > 0));

// Bot-wide ownership survives a failed stop, even after the driver's session
// exits. Only combined, positive death confirmation can remove this hold.
const quarantined = new Map<string, Set<CliMountRelay>>();
const holdWaiters = new Map<string, Array<() => void>>();
function releaseHold(owner: string, held: Set<CliMountRelay>, relay: CliMountRelay): void {
  held.delete(relay);
  if (held.size) return;
  quarantined.delete(owner);
  for (const wake of holdWaiters.get(owner)?.splice(0) ?? []) wake();
  holdWaiters.delete(owner);
}
/** A previous generation stop is still confirming in the background after its turn completed: the next mounted turn waits for it,
 * bounded by the same deadline as the stop, instead of refusing a retry the stop is about to allow. Null when nothing is held.
 * The caller races its own Stop; an unconfirmed stop still refuses at assertRelayAvailable. */
export function relayHoldReleased(turn: SendTurnInput, timeoutMs: number, signal?: AbortSignal): Promise<void> | null {
  const owner = turn.warmIdentity?.botId ?? turn.threadId;
  if (!quarantined.get(owner)?.size) return null;
  return new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); const list = holdWaiters.get(owner); const at = list?.indexOf(done) ?? -1; if (list && at >= 0) list.splice(at, 1); resolve(); };
    const timer = setTimeout(done, timeoutMs); timer.unref?.();
    holdWaiters.set(owner, [...(holdWaiters.get(owner) ?? []), done]);
    if (signal?.aborted) done(); else signal?.addEventListener("abort", done, { once: true });
  });
}
export function assertRelayAvailable(turn: SendTurnInput): void {
  if (quarantined.get(turn.warmIdentity?.botId ?? turn.threadId)?.size) throw new Error("MOUNT_RELAY_STOP_UNCONFIRMED");
}

/** A server-owned child, never a Cloud engine launch. Bundled IPC proxies
 * run under the server uid; custom commands keep the existing power block. */
const spawnMount = (command: string, args: string[], env: Record<string, string>, cwd: string): ChildProcess =>
  spawnCli(command, args, { cwd, env, stdio: env.MURAGE_RELEASE_INSTANCE ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"] },
    engineJob({ posixHostPower: !env.MURAGE_RELEASE_INSTANCE }), { serverTool: "mcp" });

declare const preparedMountBrand: unique symbol;
export interface PreparedCliMounts { readonly [preparedMountBrand]: true }
const preparedMounts = new WeakMap<PreparedCliMounts, {
  admission: NonNullable<SendTurnInput["mountAdmission"]>;
  entries: Map<string, Record<string, unknown>>;
  consumed: boolean;
}>();
function allocateMounts(turn: SendTurnInput, servers: Record<string, unknown>, secrets: TurnSecrets = {}): Map<string, Record<string, unknown>> {
  assertConsumingMountAdmission(turn, "server", true);
  const entries = new Map<string, Record<string, unknown>>();
  for (const [name, entry] of Object.entries(servers)) {
    if (!name || Buffer.byteLength(name) > 128) refuseConsumingTurn(turn.releaseBinding!);
    const spec = entry as Record<string, unknown>;
    if (spec?.env !== undefined && (!spec.env || typeof spec.env !== "object" || Array.isArray(spec.env) || Object.values(spec.env).some(value => typeof value !== "string"))) refuseConsumingTurn(turn.releaseBinding!);
    entries.set(name, turn.mountAdmission!.mount({ ...spec, env: { ...(spec?.env as Record<string, string> ?? {}), ...secrets[name] } }));
  }
  return entries;
}
/** Allocate the complete immutable set before an ACP engine/probe is started.
 * The private token is single-use and belongs to this exact admission. */
export function prepareCliMounts(turn: SendTurnInput, servers: Record<string, unknown>): PreparedCliMounts {
  const entries = allocateMounts(turn, servers);
  const token = Object.freeze(Object.create(null)) as PreparedCliMounts;
  preparedMounts.set(token, { admission: turn.mountAdmission!, entries, consumed: false });
  return token;
}

export class CliMountRelay {
  #ticket = randomBytes(32).toString("base64url");
  get ticket(): string { return this.#ticket; }
  readonly socketPath: string;
  readonly servers: Record<string, unknown> = {};
  readonly mounts = new Map<string, RelayedMount>();
  readonly #entries = new Map<string, Record<string, unknown>>();
  readonly #connections = new Map<string, Socket>();
  readonly #sockets = new Set<Socket>();
  readonly #children: Array<{ transport: RelayedMount; descendants: ChatMcpDescendants; teardown: ReturnType<typeof chatMcpTeardown> }> = [];
  #server: Server;
  #listenerOwner: CliMountRelay;
  #current: CliMountRelay = this;
  #generationStop?: Promise<boolean>;
  #generationStopped = false;
  #onTicketFailure?: () => void;
  #endCli: (cli: ChildProcess) => void = cli => cliStdinEnd({ child: cli });
  #stopping = false;
  #sealed = false;
  #finish?: Promise<boolean>;
  #confirmed = false;
  #resolveStopped!: () => void;
  readonly stopped = new Promise<void>(resolve => { this.#resolveStopped = resolve; });
  #cli?: ChildProcess;
  #onFailure?: (nativeError?: unknown) => void;
  #nativeFailure?: unknown;
  readonly turn: SendTurnInput;
  readonly cred: TurnCredentialStore | null;
  private constructor(turn: SendTurnInput, cred: TurnCredentialStore | null, previous?: CliMountRelay) {
    this.turn = turn; this.cred = cred;
    this.#listenerOwner = previous ? previous.#listenerOwner : this;
    if (previous) {
      this.socketPath = previous.socketPath;
      this.#server = previous.#server;
      this.#cli = previous.#cli;
      this.#onFailure = previous.#onFailure;
      this.#endCli = previous.#endCli;
      return;
    }
    const cloud = process.env.MURAGE_CLOUD_ROLE === "home";
    this.socketPath = brokerSocketPath(cloud ? CLOUD_BROKER_DIR : tmpdir(), `relay-${randomBytes(16).toString("hex")}`);
    this.#server = createServer(socket => this.#current.connect(socket));
    this.#server.on("error", error => this.#current.seal(error));
  }
  static async create(turn: SendTurnInput, servers: Record<string, unknown> | PreparedCliMounts, secrets: TurnSecrets,
    cred: TurnCredentialStore | null, launchMount = spawnMount): Promise<CliMountRelay> {
    return CliMountRelay.build(turn, servers, secrets, cred, launchMount);
  }
  private static async build(turn: SendTurnInput, servers: Record<string, unknown> | PreparedCliMounts, secrets: TurnSecrets,
    cred: TurnCredentialStore | null, launchMount: typeof spawnMount, previous?: CliMountRelay, onTicketFailure?: () => void): Promise<CliMountRelay> {
    assertRelayAvailable(turn);
    assertConsumingMountAdmission(turn, "server", true);
    const relay = new CliMountRelay(turn, cred, previous);
    relay.#onTicketFailure = onTicketFailure;
    relay.#listenerOwner.#current = relay;
    try {
      // Validate the entire set (including the 65th) before any child exists.
      const prepared = preparedMounts.get(servers as PreparedCliMounts);
      let entries: Map<string, Record<string, unknown>>;
      if (prepared) {
        if (prepared.consumed || prepared.admission !== turn.mountAdmission || cred || Object.keys(secrets).length) refuseConsumingTurn(turn.releaseBinding!);
        prepared.consumed = true;
        entries = prepared.entries;
      } else {
        const raw = servers as Record<string, unknown>;
        entries = allocateMounts(turn, cred ? bindCredentialPath(raw, cred.path) : raw, secrets);
      }
      for (const [name, entry] of entries) relay.#entries.set(name, entry);
      const bootstrap = { MURAGE_RELAY_TICKET: relay.ticket, MURAGE_RELAY_SOCKET: relay.socketPath };
      const fileSecrets = { ...secrets };
      for (const [name, entry] of relay.#entries) {
        fileSecrets[name] = { ...secrets[name], ...bootstrap };
        relay.servers[name] = { command: process.execPath, args: [SPAWNED_PROXIES.cliMountShim, "--server", name],
          ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
          ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
          env: { ELECTRON_RUN_AS_NODE: "1", ...(cred ? { [CRED_FILE_ENV]: cred.path, [CRED_SERVER_ENV]: name } : bootstrap) } };
      }
      cred?.write(fileSecrets);
      if (!previous) {
        await new Promise<void>((resolve, reject) => {
          relay.#server.once("error", reject);
          relay.#server.listen(relay.socketPath, () => { relay.#server.off("error", reject); resolve(); });
        });
        if (process.platform !== "win32") {
          const cloud = process.env.MURAGE_CLOUD_ROLE === "home";
          // The supervisor drops to murage before drivers run. The root-owned
          // setgid broker directory supplies murage-turn; do not attempt chown(0).
          if (cloud && statSync(relay.socketPath).gid !== statSync(CLOUD_BROKER_DIR).gid) throw new Error("RELAY_SOCKET_GROUP_MISMATCH");
          chmodSync(relay.socketPath, cloud ? 0o660 : 0o600);
        }
      }
      assertConsumingMountAdmission(turn, "server", true);
      for (const entry of relay.#entries.values()) {
        const ingress = admittedMcpMount(entry).ingress;
        if (ingress.sealed || ingress.retired) throw new Error("MEMORY_CONTEXT_REVOKED");
      }
      for (const [name, entry] of relay.#entries) {
        const child = launchMount(entry.command as string, entry.args as string[], chatMcpChildEnv(entry.env), turn.cwd ?? probeFolder());
        const descendants = new ChatMcpDescendants(child);
        const teardown = chatMcpTeardown(child, descendants);
        const transport = new RelayedMount(child, admittedMcpMount(entry), frame => {
          const socket = relay.#connections.get(name);
          if (!socket || socket.destroyed || socket.writableNeedDrain) throw new Error("MEMORY_CONTEXT_REVOKED");
          socket.write(frame);
        }, error => relay.seal(error), () => descendants.track(), () => !!relay.#onTicketFailure);
        relay.mounts.set(name, transport); relay.#children.push({ transport, descendants, teardown });
        descendants.track();
      }
      return relay;
    } catch (error) {
      const memoryRefusal = (error as { code?: string } | null)?.code === "MEMORY_CONTEXT_REVOKED"
        || (error as { message?: string } | null)?.message === "MEMORY_CONTEXT_REVOKED";
      if (previous) relay.retire();
      else relay.seal(memoryRefusal ? undefined : error ?? transportClosed());
      await relay.finish(); throw error;
    }
  }
  /** Only the retained local Claude caller opts into this operation. A fresh
   * dispatcher admission is mandatory; old ingresses are never rebound. */
  async nextGeneration(turn: SendTurnInput, servers: Record<string, unknown>, secrets: TurnSecrets,
    onTicketFailure: () => void, launchMount = spawnMount): Promise<CliMountRelay> {
    if (!this.#generationStopped || this.#finish || !this.cred || !this.#cli
      || this.#cli.exitCode !== null || process.env.MURAGE_CLOUD_ROLE === "home"
      || turn.threadId !== this.turn.threadId || turn.releaseBinding?.identity.botId !== this.turn.releaseBinding?.identity.botId
      || turn.mountAdmission === this.turn.mountAdmission
      || this.#listenerOwner.#current !== this) throw new Error("S2_GENERATION_NOT_AVAILABLE");
    const names = Object.keys(servers).sort();
    if (JSON.stringify(names) !== JSON.stringify([...this.#entries.keys()].sort())) throw new Error("S2_MOUNT_NAMES_CHANGED");
    const next = await CliMountRelay.build(turn, servers, secrets, this.cred, launchMount, this, onTicketFailure);
    return next;
  }
  /** End the pending barrier's authentication-failure subscription after release. */
  barrierPassed(): void { this.#onTicketFailure = undefined; }
  attach(cli: ChildProcess, onFailure: (nativeError?: unknown) => void, endCli?: (cli: ChildProcess) => void): void {
    this.#cli = cli; this.#onFailure = onFailure;
    if (endCli) this.#endCli = endCli;
    if (this.#sealed) { killCliTree(cli); onFailure(this.#nativeFailure); }
  }
  private connect(socket: Socket): void {
    this.#sockets.add(socket);
    let name: string | undefined;
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
    socket.on("error", error => { if (name && !this.#stopping) this.seal(error); });
    socket.on("close", () => {
      clearTimeout(timer); this.#sockets.delete(socket);
      if (name && !this.#stopping) this.seal(transportClosed());
    });
    socket.on("data", (chunk: Buffer) => {
      if (this.#stopping || this.#sealed) { socket.destroy(); return; }
      if (buffer.length + chunk.length > CHAT_MCP_FRAME_CAP_BYTES) { if (name) this.seal(); socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf(10); if (end < 0) return;
        const line = buffer.subarray(0, end).toString("utf8"); buffer = buffer.subarray(end + 1);
        if (!name) {
          try {
            const auth = JSON.parse(line);
            const ticket = Buffer.from(typeof auth.ticket === "string" ? auth.ticket : "");
            if (ticket.length !== Buffer.byteLength(this.ticket) || !timingSafeEqual(ticket, Buffer.from(this.ticket))
              || typeof auth.server !== "string" || !this.mounts.has(auth.server)) {
              // An expected mount with a stale/unknown ticket fails only the
              // S2 barrier. Authentication never acquires a consuming ingress.
              if (typeof auth.server === "string" && this.mounts.has(auth.server)) {
                try { this.#onTicketFailure?.(); } catch {}
              }
              socket.destroy(); return;
            }
            // Authentication precedes association: strangers cannot refuse a turn.
            if (this.#connections.has(auth.server)) { this.seal(); socket.destroy(); return; }
            name = auth.server as string; this.#connections.set(name, socket); clearTimeout(timer);
          } catch { socket.destroy(); return; }
        } else this.mounts.get(name)!.request(line);
      }
    });
  }
  seal(nativeError?: unknown): void {
    if (this.#stopping || this.#sealed) return;
    if (this.#onTicketFailure) {
      const failed = this.#onTicketFailure;
      this.retire();
      try { failed(); } catch {}
      return;
    }
    this.#sealed = true;
    this.#nativeFailure = nativeError;
    if (nativeError !== undefined) {
      // Invalidate every mount before teardown; native failure is not a ledger denial.
      for (const mount of this.mounts.values()) mount.retire();
      for (const entry of this.#entries.values()) admittedMcpMount(entry).ingress.retire();
    } else {
      if (!this.#entries.size && this.turn.releaseBinding) { try { refuseConsumingTurn(this.turn.releaseBinding); } catch {} }
      for (const entry of this.#entries.values()) { try { admittedMcpMount(entry).ingress.seal(); } catch {} }
    }
    if (this.#cli) { try { killCliTree(this.#cli); } catch {} }
    try { this.#onFailure?.(nativeError); } catch {}
    for (const socket of this.#sockets) { try { socket.destroy(); } catch {} }
    for (const { transport, descendants } of this.#children) void descendants.ready().then(() => killCliTree(transport.child)).catch(() => {});
  }
  retire(): void {
    this.#stopping = true;
    for (const entry of this.#entries.values()) admittedMcpMount(entry).ingress.retire();
    for (const mount of this.mounts.values()) mount.retire();
  }
  close(): void {
    for (const socket of this.#sockets) socket.destroy();
    this.#server.close();
    if (process.platform !== "win32") { try { unlinkSync(this.socketPath); } catch {} }
  }
  /** S2 §1: cut every shim before stopping any mount child. The listener,
   * credential pathname and CLI belong to the process, not this generation.
   * No S1 caller invokes this method. Failure recycles the CLI and retains the
   * ordinary quarantine until combined process/descendant death is proven. */
  retireGeneration(): Promise<boolean> {
    if (this.#finish || !this.cred || !this.#cli || process.env.MURAGE_CLOUD_ROLE === "home") return Promise.resolve(false);
    if (this.#generationStop) return this.#generationStop;
    this.#generationStop = this.stopGeneration();
    void this.#generationStop.then(ok => { if (!ok) void this.finish(); });
    return this.#generationStop;
  }
  private async stopGeneration(): Promise<boolean> {
    const owner = this.turn.warmIdentity?.botId ?? this.turn.threadId;
    const held = quarantined.get(owner) ?? new Set<CliMountRelay>();
    held.add(this); quarantined.set(owner, held);
    let confirmed = true;
    try {
      try { this.retire(); } catch { confirmed = false; }
      // Even a broken retire cannot let socket close callbacks seal a turn.
      this.#stopping = true;
      for (const mount of this.mounts.values()) { try { mount.retire(); } catch { confirmed = false; } }
      for (const socket of this.#sockets) { try { socket.destroy(); } catch { confirmed = false; } }
      const results = await Promise.all(this.#children.map(async ({ transport, descendants, teardown }) => {
        try {
          teardown.markStopRequested();
          await descendants.ready();
          try { transport.child.stdin?.end(); } catch {}
          killCliTree(transport.child);
          const [tree, rest] = await Promise.all([
            teardown.wait({ closeMs: CLI_CALLER_DEADLINE_MS, maxMs: CLI_CALLER_DEADLINE_MS }), descendants.stop(),
          ]);
          return tree.closeConfirmed && rest;
        } catch { return false; }
      }));
      confirmed = confirmed && results.every(Boolean);
    } catch { confirmed = false; }
    finally {
      try { this.cred?.clear(); } catch { confirmed = false; }
      this.#ticket = "";
      this.#onTicketFailure = undefined;
      try { this.turn.mountAdmission?.dispose(); } catch { confirmed = false; }
      this.#connections.clear();
    }
    this.#generationStopped = confirmed;
    if (confirmed) releaseHold(owner, held, this);
    return confirmed;
  }
  /** S1 §4: cleanup failures never skip another cleanup, nor certify death. */
  finish(cli = this.#cli): Promise<boolean> {
    if (this.#confirmed) return Promise.resolve(true);
    // Once a successor owns the process, stale generation callbacks may not
    // close its listener, credentials, admission or CLI.
    if (this.#listenerOwner.#current !== this) return Promise.resolve(this.#generationStopped);
    return this.#finish ??= this.#generationStop
      ? this.#generationStop.then(() => this.settle(cli)) : this.settle(cli);
  }
  private async settle(cli?: ChildProcess): Promise<boolean> {
    let confirmed = false;
    const owner = this.turn.warmIdentity?.botId ?? this.turn.threadId;
    const held = quarantined.get(owner) ?? new Set<CliMountRelay>();
    held.add(this); quarantined.set(owner, held);
    const release = () => {
      this.#confirmed = true; this.#resolveStopped();
      releaseHold(owner, held, this);
    };
    try {
      let stopFailed = false;
      try { this.retire(); } catch { stopFailed = true; }
      await Promise.all(this.#children.map(async ({ transport, descendants, teardown }) => {
        try {
          teardown.markStopRequested();
          await descendants.ready();
          try { transport.child.stdin?.end(); } catch {}
          killCliTree(transport.child);
        } catch { stopFailed = true; }
      }));
      if (cli) { try { this.#endCli(cli); } catch {} try { killCliTree(cli); } catch { stopFailed = true; } }
      const results = await Promise.all([
        cli ? awaitCliTreeStopped(cli, undefined, CLI_CALLER_DEADLINE_MS) : Promise.resolve(true),
        ...this.#children.map(async ({ teardown, descendants }) => {
          const [tree, rest] = await Promise.all([teardown.wait({ closeMs: CLI_CALLER_DEADLINE_MS, maxMs: CLI_CALLER_DEADLINE_MS }), descendants.stop()]);
          return tree.closeConfirmed && rest;
        }),
      ]);
      confirmed = !stopFailed && results.every(Boolean);
      if (confirmed) release();
    } catch { confirmed = false; }
    finally {
      try { this.cred?.clear(); } catch { console.warn("[mount-relay] credential clear failed"); }
      try { this.cred?.dispose(); } catch { console.warn("[mount-relay] credential dispose failed"); }
      try { this.turn.mountAdmission?.dispose(); } catch { console.warn("[mount-relay] admission dispose failed"); }
      try { this.close(); } catch { console.warn("[mount-relay] close failed"); }
    }
    if (!confirmed) {
      // Keep all surviving trees owned; late confirmation must include both.
      void Promise.all([cli ? cliTreeStoppedSignal(cli) : Promise.resolve(true), ...this.#children.map(({ teardown, descendants }) =>
        Promise.all([new Promise<void>(resolve => teardown.onClosed(resolve)), descendants.goneSignal()]))]).then(release, () => {});
    }
    return confirmed;
  }
}
