// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
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
  readonly failed: () => void;
  readonly accepted: () => void;
  constructor(child: ChildProcess, mount: AdmittedMcpMount,
    write: (frame: string) => void, failed: () => void, accepted: () => void = () => {}) {
    this.child = child;
    this.mount = mount;
    this.write = write;
    this.failed = failed;
    this.accepted = accepted;
    mount.ingress.supervise(child);
    child.on("message", () => this.fail());
    child.on("error", () => this.fail());
    child.once("exit", () => this.fail());
    child.stdin?.on("error", () => this.fail());
    child.stderr?.on("error", () => {}); child.stderr?.resume();
    child.stdout?.on("error", () => this.fail());
    child.stdout?.on("end", () => this.fail());
    child.stdout?.on("data", (chunk: Buffer | string) => this.data(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    if (!child.stdin || !child.stdout) this.fail();
  }
  retire(): void { this.stopping = true; this.mount.ingress.retire(); this.#parts = []; this.#bytes = 0; }
  fail(): void {
    if (this.stopping) { this.mount.ingress.retire(); return; }
    this.mount.ingress.seal(); this.failed();
  }
  request(frame: string): void {
    if (this.stopping) return;
    try {
      if (!this.child.stdin || this.child.stdin.writableNeedDrain || this.child.stdin.destroyed) throw new Error("MEMORY_CONTEXT_REVOKED");
      this.mount.ingress.request(frame, () => { this.child.stdin!.write(frame + "\n"); });
    } catch { this.fail(); }
  }
  data(chunk: Buffer): void {
    if (this.stopping) return;
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
        const envelope = this.mount.accept(line, this.write);
        this.accepted();
        if (envelope) {
          if (!this.child.connected || !this.child.send) throw new Error("MEMORY_CONTEXT_REVOKED");
          this.child.send({ type: "turn-release-ack", instanceId: envelope.instanceId, sequence: envelope.sequence }, error => { if (error) this.fail(); });
        }
      }
    } catch { this.fail(); }
  }
}

export const mountedTurn = (turn: Pick<SendTurnInput, "integrations">, required = false): boolean =>
  required || Object.values(turn.integrations ?? {}).some(value => value && (typeof value !== "object" || Object.keys(value).length > 0));

// Bot-wide ownership survives a failed stop, even after the driver's session
// exits. Only combined, positive death confirmation can remove this hold.
const quarantined = new Map<string, Set<CliMountRelay>>();
export function assertRelayAvailable(turn: SendTurnInput): void {
  if (quarantined.get(turn.warmIdentity?.botId ?? turn.threadId)?.size) throw new Error("MOUNT_RELAY_STOP_UNCONFIRMED");
}

/** A server-owned child, never a Cloud engine launch. Bundled IPC proxies
 * run under the server uid; custom commands keep the existing power block. */
const spawnMount = (command: string, args: string[], env: Record<string, string>): ChildProcess =>
  spawnCli(command, args, { env, stdio: env.MURAGE_RELEASE_INSTANCE ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"] },
    engineJob({ posixHostPower: !env.MURAGE_RELEASE_INSTANCE }), { serverTool: "mcp" });

export class CliMountRelay {
  readonly ticket = randomBytes(32).toString("base64url");
  readonly socketPath: string;
  readonly servers: Record<string, unknown> = {};
  readonly mounts = new Map<string, RelayedMount>();
  readonly #entries = new Map<string, Record<string, unknown>>();
  readonly #connections = new Map<string, Socket>();
  readonly #sockets = new Set<Socket>();
  readonly #children: Array<{ transport: RelayedMount; descendants: ChatMcpDescendants; teardown: ReturnType<typeof chatMcpTeardown> }> = [];
  #server: Server;
  #stopping = false;
  #sealed = false;
  #finish?: Promise<boolean>;
  #confirmed = false;
  #resolveStopped!: () => void;
  readonly stopped = new Promise<void>(resolve => { this.#resolveStopped = resolve; });
  #cli?: ChildProcess;
  #onFailure?: () => void;
  readonly turn: SendTurnInput;
  readonly cred: TurnCredentialStore | null;
  private constructor(turn: SendTurnInput, cred: TurnCredentialStore | null) {
    this.turn = turn;
    this.cred = cred;
    const cloud = process.env.MURAGE_CLOUD_ROLE === "home";
    this.socketPath = brokerSocketPath(cloud ? CLOUD_BROKER_DIR : tmpdir(), `relay-${randomBytes(16).toString("hex")}`);
    this.#server = createServer(socket => this.connect(socket));
    this.#server.on("error", () => this.seal());
  }
  static async create(turn: SendTurnInput, servers: Record<string, unknown>, secrets: TurnSecrets,
    cred: TurnCredentialStore | null, spawn = spawnMount): Promise<CliMountRelay> {
    assertRelayAvailable(turn);
    assertConsumingMountAdmission(turn, "server", true);
    const relay = new CliMountRelay(turn, cred);
    try {
      // Validate the entire set (including the 65th) before any child exists.
      const bound = cred ? bindCredentialPath(servers, cred.path) : servers;
      for (const [name, entry] of Object.entries(bound)) {
        if (!name || Buffer.byteLength(name) > 128) throw new Error("MEMORY_CONTEXT_REVOKED");
        const spec = entry as Record<string, unknown>;
        if (spec?.env !== undefined && (!spec.env || typeof spec.env !== "object" || Array.isArray(spec.env) || Object.values(spec.env).some(value => typeof value !== "string"))) throw new Error("MEMORY_CONTEXT_REVOKED");
        relay.#entries.set(name, turn.mountAdmission!.mount({ ...spec, env: { ...(spec?.env as Record<string, string> ?? {}), ...secrets[name] } }));
      }
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
      assertConsumingMountAdmission(turn, "server", true);
      for (const entry of relay.#entries.values()) {
        const ingress = admittedMcpMount(entry).ingress;
        if (ingress.sealed || ingress.retired) throw new Error("MEMORY_CONTEXT_REVOKED");
      }
      for (const [name, entry] of relay.#entries) {
        const child = spawn(entry.command as string, entry.args as string[], chatMcpChildEnv(entry.env));
        const descendants = new ChatMcpDescendants(child);
        const teardown = chatMcpTeardown(child, descendants);
        const transport = new RelayedMount(child, admittedMcpMount(entry), frame => {
          const socket = relay.#connections.get(name);
          if (!socket || socket.destroyed || socket.writableNeedDrain) throw new Error("MEMORY_CONTEXT_REVOKED");
          socket.write(frame + "\n");
        }, () => relay.seal(), () => descendants.track());
        relay.mounts.set(name, transport); relay.#children.push({ transport, descendants, teardown });
        descendants.track();
      }
      return relay;
    } catch (error) {
      relay.seal(); await relay.finish(); throw error;
    }
  }
  attach(cli: ChildProcess, onFailure: () => void): void {
    this.#cli = cli; this.#onFailure = onFailure;
    if (this.#sealed) { killCliTree(cli); onFailure(); }
  }
  private connect(socket: Socket): void {
    this.#sockets.add(socket);
    let name: string | undefined;
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
    socket.on("error", () => { if (name && !this.#stopping) this.seal(); });
    socket.on("close", () => {
      clearTimeout(timer); this.#sockets.delete(socket);
      if (name && !this.#stopping) this.seal();
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
              || typeof auth.server !== "string" || !this.mounts.has(auth.server)) { socket.destroy(); return; }
            // Authentication precedes association: strangers cannot refuse a turn.
            if (this.#connections.has(auth.server)) { this.seal(); socket.destroy(); return; }
            name = auth.server as string; this.#connections.set(name, socket); clearTimeout(timer);
          } catch { socket.destroy(); return; }
        } else this.mounts.get(name)!.request(line);
      }
    });
  }
  seal(): void {
    if (this.#stopping || this.#sealed) return;
    this.#sealed = true;
    if (!this.#entries.size && this.turn.releaseBinding) { try { refuseConsumingTurn(this.turn.releaseBinding); } catch {} }
    for (const entry of this.#entries.values()) { try { admittedMcpMount(entry).ingress.seal(); } catch {} }
    if (this.#cli) { try { killCliTree(this.#cli); } catch {} }
    try { this.#onFailure?.(); } catch {}
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
  /** S1 §4: cleanup failures never skip another cleanup, nor certify death. */
  finish(cli = this.#cli): Promise<boolean> {
    if (this.#confirmed) return Promise.resolve(true);
    return this.#finish ??= this.settle(cli);
  }
  private async settle(cli?: ChildProcess): Promise<boolean> {
    let confirmed = false;
    const owner = this.turn.warmIdentity?.botId ?? this.turn.threadId;
    const held = quarantined.get(owner) ?? new Set<CliMountRelay>();
    held.add(this); quarantined.set(owner, held);
    const release = () => {
      this.#confirmed = true; this.#resolveStopped();
      held.delete(this); if (!held.size) quarantined.delete(owner);
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
      if (cli) { try { cli.stdin?.end(); } catch {} try { killCliTree(cli); } catch { stopFailed = true; } }
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
