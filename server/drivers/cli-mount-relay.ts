// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import "../../shared/win-hide-child-process.mjs";
import { NotModelRequest } from "../../shared/engine-transport.ts";
import {isObservedChildIoMessage} from "../sentinel/io-child-receipts.ts";
import { cliStdinEnd } from "./cli-stdin-eof.ts";
import { probeFolder } from "../probe-folder.ts";
import type { ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { refuseConsumingTurn, refuseEngineOwnTurn } from "../consuming-turn-response.ts";
import { logSwallowedConsumingError } from "../consuming-error-log.ts";
import { terminalReasonWord } from "../proxy-turn-release.ts";
import { TURN_RELEASE_WAIT_MS } from "../turn-release-wait.ts";
import { isMemoryRefusal } from "./engine-input.ts";
import { isPendingFenceDeferral } from "../memory/send-fence.ts";
import { PENDING_FENCE_WAIT_MS } from "../memory/fence-pending.ts";
import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { CLOUD_BROKER_DIR } from "../cloud-home/turn-process.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { brokerSocketPath, spawnCli, engineJob, killCliTree, awaitCliTreeStopped, cliTreeStoppedSignal, CLI_CALLER_DEADLINE_MS } from "../procs.ts";
import { CRED_FILE_ENV, CRED_SERVER_ENV } from "../turn-credential.ts";
import { unavailableLabels } from "./mcp-readiness.ts";
import { isConnectedAppsServer } from "../../shared/connected-app-names.ts";
import { admittedMcpMount, assertConsumingMountAdmission, type AdmittedMcpMount } from "./mcp-mounts.ts";
import { bindCredentialPath, type TurnCredentialStore, type TurnSecrets } from "./turn-credentials.ts";
import { ChatMcpDescendants, chatMcpTeardown, chatMcpChildEnv } from "./chat-mcp-client.ts";
/** The most bytes read from a connection before it has shown its ticket (the one small line the relay client writes first). It bounds a
 * stranger on the socket, never a call: once the ticket is read, a line of any size passes (MAIN-RULING cause22-no-transport-caps). */
const TICKET_LINE_MAX_BYTES = 2 * 1024 * 1024;

type MountLoss = "spawn" | "exit" | "stdin" | "stdout" | "ipc" | "socket" | "duplicate" | "server";
/** The per-turn name Fuigo mounts Murage memory by (acp/fuigo-memory-permission.ts newFuigoMemoryAlias). */
const fuigoMemoryAlias = /^murage-memory-[a-f0-9]{20}$/;
const optionalMountNames = new Set(["browser", "murage-browser", "computer", "agents", "murage-memory", "phone", "phoneJobs", "dweb", "highlevel"]);
/** The terminal frame's error code only (never its message or id). */
const terminalFrameCode = (frame: unknown): string => terminalReasonWord((frame as { error?: { data?: { code?: unknown } } } | null)?.error?.data?.code);
const transportClosed = () => Object.assign(new Error("MCP_TRANSPORT_CLOSED"), { code: "MCP_TRANSPORT_CLOSED" });

/** Shared by ChatMcpConnection and the CLI relay. One immutable admission owns
 * all stdin, stdout, IPC and transport failure for this child. */
export class RelayedMount {
  declare readonly engineTransport: true;
  /** 1.0.20 revkill: the longest a call waits for a pending memory check before only that call is answered with an error. */
  static pendingWaitMs = PENDING_FENCE_WAIT_MS;
  // Engine frames held, in order, while the first of them waits for its pending memory check.
  #waiting: string[] | undefined;
  // 1.0.20 revkill2: child output held, in order, behind a tool reply that waits for its pending memory check.
  #held: Buffer[] | undefined;
  // 1.0.21 revkill3: the held bytes (bounded by one frame cap, not a chunk count) and the early end of that wait when they pass it.
  #parts: Buffer[] = [];
  #bytes = 0;
  // cause22 caps (owner turn only): why the child's stdout is paused. A busy engine socket or a full held queue waits; it never seals.
  readonly #paused = new Set<"flow" | "held">();
  stopping = false;
  readonly child: ChildProcess;
  readonly mount: AdmittedMcpMount;
  readonly write: (frame: string) => void;
  readonly failed: (nativeError?: unknown, refusal?: unknown) => void;
  readonly accepted: () => void;
  readonly pendingBarrier: () => boolean;
  readonly drop: (cause: MountLoss, reason?: string) => boolean;
  /** cause22 caps: resolves when the engine connection can take more (it needs drain now); undefined when it is not busy. */
  readonly flow: () => Promise<void> | undefined;
  // The first bytes of the child's stderr. Only the content-free site/class/code words of its
  // "[consuming] swallowed error" lines ever reach the log (stderrCause), never the text itself.
  #stderrHead = "";
  constructor(child: ChildProcess, mount: AdmittedMcpMount,
    write: (frame: string) => void, failed: (nativeError?: unknown, refusal?: unknown) => void, accepted: () => void = () => {}, pendingBarrier: () => boolean = () => false,
    drop: (cause: MountLoss, reason?: string) => boolean = () => false, flow: () => Promise<void> | undefined = () => undefined) {
    this.child = child; this.mount = mount; this.write = write; this.failed = failed; this.accepted = accepted;
    this.pendingBarrier = pendingBarrier; this.drop = drop; this.flow = flow;
    for (const event of ["error", "exit", "close", "end", "disconnect"]) child.prependOnceListener(event, () => {
      if (this.pendingBarrier()) { this.retire(); this.failed(); }
    });
    mount.ingress.supervise(child);
    child.on("message", message => {
      if (isObservedChildIoMessage(child, message)) return;
      // Name only the shape: a frame or token never reaches the log.
      const shape = message && typeof message === "object" ? message as Record<string, unknown> : {};
      if (shape.type === "mcp-server-unavailable" && this.drop("server")) return;
      // Bundled proxies also use terminal IPC when their own backend disappears.
      // The parent denial and approval-broker guards in dropMount still take precedence.
      if (shape.type === "turn-release-terminal" && shape.instanceId === mount.ingress.identity.proxyInstanceId && this.drop("ipc", terminalReasonWord(shape.reason))) return;
      if (!this.stopping) console.warn(`[mount-relay] mount ipc message seals the relay type=${typeof shape.type === "string" ? shape.type.slice(0, 40) : typeof message}`
        + ` keys=${Object.keys(shape).slice(0, 8).join(",").slice(0, 120)}`
        // The terminal's frame is the fixed refusal; its reason is the child's code word for the first refusing check.
        + (shape.type === "turn-release-terminal" ? ` frame=${terminalFrameCode(shape.frame)} reason=${terminalReasonWord(shape.reason)}` : ""));
      this.fail();
    });
    child.on("error", error => this.transportLost("spawn", error));
    child.once("disconnect", () => this.transportLost("ipc", undefined, "disconnect"));
    child.once("exit", (code, signal) => {
      if (!this.stopping) console.warn(`[mount-relay] mount child exited code=${code ?? "-"} signal=${signal ?? "-"}`);
      this.transportLost("exit");
    });
    child.stdin?.on("error", error => this.transportLost("stdin", error));
    child.stderr?.on("error", () => {});
    child.stderr?.on("data", (chunk: Buffer | string) => { if (this.#stderrHead.length < 4096) this.#stderrHead = (this.#stderrHead + String(chunk)).slice(0, 4096); });
    child.stderr?.resume();
    child.stdout?.on("error", error => this.transportLost("stdout", error));
    child.stdout?.on("end", () => this.transportLost("stdout"));
    child.stdout?.on("data", (chunk: Buffer | string) => this.data(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    if (!child.stdin || !child.stdout) this.transportLost("spawn");
  }
  transportLost(cause: MountLoss, error: unknown = transportClosed(), reason?: string): void {
    if (!this.stopping && !this.drop(cause, reason)) this.fail(error);
  }
  /** The child's own first refusing checks, as code words: site/class/code of each "[consuming] swallowed error" line (at most 3). */
  stderrCause(): string {
    const words = [...this.#stderrHead.matchAll(/^\[consuming\] swallowed error site=(\S+) n=\S+ class=(\S+) code=(\S+)/gm)].slice(0, 3)
      .map(match => [match[1], match[2], match[3]].map(terminalReasonWord).join("/"));
    return words.join(",") || "none";
  }
  retire(): void { this.stopping = true; this.mount.ingress.retire(); this.#parts = []; this.#bytes = 0; this.#paused.clear(); }
  /** G0-LLM: `refusal` is the fenced refusal error itself (a pre-entry ledger denial); the relay hands it to the consumer, which claims it
   * with refusalFor(target null) so the lease closes it. It never counts as a native failure. */
  fail(nativeError?: unknown, refusal?: unknown): void {
    if (this.stopping) { this.mount.ingress.retire(); return; }
    if (this.pendingBarrier()) { this.retire(); this.failed(); return; }
    if (nativeError !== undefined) this.retire();
    else this.mount.ingress.seal();
    if (refusal === undefined) this.failed(nativeError); else this.failed(nativeError, refusal);
  }
  request(frame: string, retried = false): void {
    if (this.stopping) return;
    if (this.#waiting) { if (this.#waiting.length < 256) this.#waiting.push(frame); else this.refuseCall(frame); return; }
    let entered = false;
    try {
      if (!this.child.stdin || this.child.stdin.destroyed) { this.transportLost("stdin"); return; }
      // MAIN-RULING cause22-no-transport-caps: a busy child stdin never seals a turn. The write is taken and the engine side waits
      // (stdinBusy, asked by the relay's connection reader).
      NotModelRequest("Local MCP admission checks a capability-bound tool request.", this.mount.ingress.request(frame, () => { entered = true; NotModelRequest("Writes a capability-bound MCP request to the local child.", this.child.stdin!.write(frame + "\n")); }, "\n"));
    } catch (error) {
      // 1.0.20 revkill: held context still checking:pending is not a revoke. Only this call waits (bounded) and is offered once more;
      // the relay and the turn stay open. A proven revoke on that retry refuses as before.
      if (!entered && isPendingFenceDeferral(error)) { this.waitPending(frame, error, retried); return; }
      if (!this.stopping) logSwallowedConsumingError(entered ? "relay.mount:entered" : "relay.mount", error);
      this.fail(entered ? error ?? new Error("MCP_WRITE_FAILED") : undefined, entered || !isMemoryRefusal(error) ? undefined : error);
    }
  }
  private waitPending(frame: string, error: unknown, retried: boolean): void {
    const waiting = this.#waiting = [frame];
    console.warn(`[mount-relay] a call waits for a pending memory check retried=${retried}`);
    void (retried ? Promise.resolve(false) : this.mount.ingress.waitPending(error, () => this.stopping, RelayedMount.pendingWaitMs))
      .catch(() => false).then(cleared => {
        if (this.#waiting !== waiting) return;
        this.#waiting = undefined;
        if (this.stopping) return;
        const [first, ...rest] = waiting;
        if (cleared) NotModelRequest("Retries the held MCP request after its local context check.", this.request(first!, true));
        else this.refuseCall(first!);
        for (const next of rest) NotModelRequest("Drains queued MCP requests held behind a local context check.", this.request(next));
      });
  }
  /** The fixed, content-free answer for the one call whose check did not settle in time. Nothing of the call is forwarded. */
  private refuseCall(frame: string): void {
    console.warn("[mount-relay] a call still waiting for its memory check was answered with an error; the turn continues");
    let id: unknown;
    try { const rpc = JSON.parse(frame) as { id?: unknown; method?: unknown }; if (typeof rpc.method === "string") id = rpc.id; } catch { return; }
    if (typeof id !== "string" && typeof id !== "number") return;
    try { NotModelRequest("Local MCP reply reports that the context check is still pending.", this.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Murage is still checking remembered context. Try this again in a moment." } }) + "\n")); }
    catch { /* the engine connection is gone; that loss is handled by the relay */ }
  }
  /** cause22 caps: resolves when the child's stdin can take more; undefined when it is not busy. The relay pauses the engine connection on it. */
  stdinBusy(): Promise<void> | undefined {
    const stdin = this.child.stdin;
    if (this.stopping || !stdin || stdin.destroyed || !stdin.writableNeedDrain) return undefined;
    return new Promise<void>(resolve => { const done = () => { stdin.off("drain", done); stdin.off("close", done); stdin.off("error", done); resolve(); };
      stdin.once("drain", done); stdin.once("close", done); stdin.once("error", done); });
  }
  private pause(why: "flow" | "held"): void { if (!this.#paused.size) this.child.stdout?.pause(); this.#paused.add(why); }
  private resume(why: "flow" | "held"): void { if (this.#paused.delete(why) && !this.#paused.size && !this.stopping) this.child.stdout?.resume(); }
  data(chunk: Buffer): void {
    if (this.stopping) return;
    try { this.mount.ingress.upstream(chunk.byteLength); } // before buffering or scanning
    catch (error) { this.dataFailed(false, error); return; }
    // 1.0.20 revkill2: while a reply waits for its pending check, later child output is held behind it, in order (already charged).
    if (this.#held) {
      // MAIN-RULING cause22-no-transport-caps: no count of held chunks seals a turn. Past 256 the chunk is kept and the child waits.
      // rel/1023: no count of held BYTES ends the wait either (MAIN-RULING cause22-no-transport-caps; the 1.0.21 revkill3 byte bound is gone).
      this.#held.push(chunk);
      if (this.#held.length > 256) this.pause("held");
      return;
    }
    this.scan(chunk);
    // A busy engine connection makes the child wait, on every turn; it never seals the relay.
    if (!this.stopping && !this.#paused.has("flow")) {
      const wait = this.flow();
      if (wait) { this.pause("flow"); void wait.catch(() => {}).then(() => this.resume("flow")); }
    }
  }
  /** `retried`: a held reply offered once more before the held bytes after it are scanned. */
  private scan(chunk: Buffer, retried?: string): void {
    let entered = false, line = retried, start = 0, onRetry = retried !== undefined;
    try {
      if (line !== undefined) this.deliverLine(line, () => { entered = true; });
      while (start < chunk.length && !this.stopping) {
        line = undefined; entered = false; onRetry = false;
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end < 0 ? chunk.length : end);
        this.#parts.push(part); this.#bytes += part.length;
        if (end < 0) return;
        line = Buffer.concat(this.#parts).toString("utf8");
        this.#parts = []; this.#bytes = 0; start = end + 1;
        this.deliverLine(line, () => { entered = true; });
      }
    } catch (error) {
      // 1.0.20 revkill2: a reply that meets held context still checking:pending is not a revoke. It and everything after it wait (bounded)
      // for that exact check and are offered once more; nothing unchecked is forwarded. A proven revoke on that retry refuses as before.
      if (!entered && line !== undefined && isPendingFenceDeferral(error) && !this.stopping) { this.holdReply(line, error, onRetry, chunk.subarray(start)); return; }
      this.dataFailed(entered, error);
    }
  }
  private holdReply(line: string, error: unknown, retried: boolean, rest: Buffer): void {
    const held = this.#held = rest.length ? [rest] : [];
    console.warn(`[mount-relay] a tool reply waits for a pending memory check retried=${retried}`);
    void (retried ? Promise.resolve(false) : this.mount.ingress.waitPending(error, () => this.stopping || this.#held !== held, RelayedMount.pendingWaitMs))
      .catch(() => false).then(cleared => {
        if (this.#held !== held) return;
        this.#held = undefined;
        this.resume("held");
        if (this.stopping) return;
        // Held bytes are replayed through the same scan, in order; a later deferral holds again from there.
        const bytes = Buffer.concat(held.splice(0));
        if (cleared) this.scan(bytes, line);
        else { this.dropReply(); this.scan(bytes); }
      });
  }
  /** The one reply whose check did not settle in time is never released; the call it answered gets the fixed, content-free error. */
  private dropReply(): void {
    console.warn("[mount-relay] a tool reply still waiting for its memory check was dropped; the turn continues");
    // 1.0.21 revkill3: the call id comes from the frame the ingress checked, so an enveloped (bundled proxy) reply is answered too.
    let id: string | number | undefined;
    try { id = this.mount.drop?.(); } catch { /* the permit then lapses at its own deadline */ }
    if (id === undefined) return;
    try { NotModelRequest("Local MCP reply reports that the context check is still pending.", this.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Murage is still checking remembered context. Try this again in a moment." } }) + "\n")); }
    catch { /* the engine connection is gone; that loss is handled by the relay */ }
  }
  private deliverLine(line: string, enter: () => void): void {
    const envelope = this.mount.accept(line, frame => { enter(); return NotModelRequest("Local CLI relay writes a capability-bound MCP response.", this.write(frame)); }, "\n");
    this.accepted();
    if (envelope) {
      // The response has already left. Losing the acknowledgement cannot
      // turn that release into a ledger denial or authorize a replay.
      try {
        if (!this.child.connected || !this.child.send) throw transportClosed();
        NotModelRequest("IPC acknowledges an accepted local MCP response.", this.child.send({ type: "turn-release-ack", instanceId: envelope.instanceId, sequence: envelope.sequence }, error => { if (error) this.transportLost("ipc", error); }));
      } catch (error) { this.transportLost("ipc", error); }
    }
  }
  private dataFailed(entered: boolean, error: unknown): void {
    if (!this.stopping) logSwallowedConsumingError(entered ? "relay.mount:entered" : "relay.mount", error);
    this.fail(entered ? error ?? new Error("MCP_WRITE_FAILED") : undefined, entered || !isMemoryRefusal(error) ? undefined : error);
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
 * The caller races its own Stop; an unconfirmed stop still refuses at assertRelayAvailable, except the owner's own turn. */
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
/** The process a mount child runs, command and args (never its env): the same integration under every driver's mount name. */
function mountLaunch(entry: Record<string, unknown> | undefined): string { return JSON.stringify([entry?.command, entry?.args]); }
/** Mount names and launches whose child, in any relay holding this turn's bot, is not confirmed gone (q1024-steerquar H2). */
function heldMounts(turn: SendTurnInput): Array<{ name: string; launch: string }> {
  return [...quarantined.get(turn.warmIdentity?.botId ?? turn.threadId) ?? []].flatMap(relay => relay.unconfirmedMounts());
}
/** q1024-steerquar (owner sends never fail): the owner's own turn (hostPowerOwnerTurn, set by the registry decorator alone) has
 * already waited the bounded window above, so a stop about to confirm still clears first. If the hold persists, it starts on its own
 * new relay, without any integration whose held mount child is not confirmed gone (#skipHeldMount). The held relay stays
 * quarantined (its credentials, ticket and sockets are already gone) until its own death is confirmed, and every other audience
 * is still refused here. */
export function assertRelayAvailable(turn: SendTurnInput): void {
  if (turn.hostPowerOwnerTurn === true) return;
  if (quarantined.get(turn.warmIdentity?.botId ?? turn.threadId)?.size) throw new Error("MOUNT_RELAY_STOP_UNCONFIRMED");
}

/** A server-owned child, never a Cloud engine launch. Bundled IPC proxies
 * run under the server uid; custom commands keep the existing power block. */
const spawnMount = (command: string, args: string[], env: Record<string, string>, cwd: string, ownerTurn = false): ChildProcess =>
  spawnCli(command, args, { cwd, env, stdio: env.MURAGE_RELEASE_INSTANCE ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"] },
    engineJob({ posixHostPower: !env.MURAGE_RELEASE_INSTANCE, ownerTurn }), { serverTool: "mcp" }); // OVERREACH #5: the owner's own turn mounts unwrapped

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
    // 1.0.20 busy-engines: a mount name or env the relay cannot carry is its own refusal (ENGINE_OWN_REFUSAL): a rebuild meets it again.
    if (!name || Buffer.byteLength(name) > 128) refuseEngineOwnTurn(turn.releaseBinding!);
    const spec = entry as Record<string, unknown>;
    if (spec?.env !== undefined && (!spec.env || typeof spec.env !== "object" || Array.isArray(spec.env) || Object.values(spec.env).some(value => typeof value !== "string"))) refuseEngineOwnTurn(turn.releaseBinding!);
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
  readonly #unavailable = new Set<string>();
  readonly #entries = new Map<string, Record<string, unknown>>();
  readonly #connections = new Map<string, Socket>();
  readonly #sockets = new Set<Socket>();
  readonly #children: Array<{ name: string; transport: RelayedMount; descendants: ChatMcpDescendants; teardown: ReturnType<typeof chatMcpTeardown> }> = [];
  /** Mount children of an unconfirmed stop whose own tree and descendants are confirmed gone (heldMounts reads the rest). */
  readonly #mountsGone = new Set<string>();
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
  #onFailure?: (nativeError?: unknown, refusal?: unknown) => void;
  #nativeFailure?: unknown;
  #refusal?: unknown;
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
        if (relay.#skipHeldMount(name)) continue;
        const admitted = admittedMcpMount(entry);
        let child: ChildProcess;
        try { child = launchMount(entry.command as string, entry.args as string[], chatMcpChildEnv(entry.env), turn.cwd ?? probeFolder(), turn.hostPowerOwnerTurn === true); }
        catch (error) {
          if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException | null)?.code ?? "") && relay.dropMount(name, "spawn")) continue;
          throw error;
        }
        const descendants = new ChatMcpDescendants(child);
        const teardown = chatMcpTeardown(child, descendants);
        const transport = new RelayedMount(child, admitted, frame => {
          const socket = relay.#connections.get(name);
          // MAIN-RULING cause22-no-transport-caps: a busy engine connection never seals a turn. The write is taken and the child waits (flow).
          if (!socket || socket.destroyed) throw new Error("MEMORY_CONTEXT_REVOKED");
          NotModelRequest("Local MCP relay delivers a capability-bound tool response.", socket.write(frame));
        }, (error, refusal) => {
          // Name the mount whose child, IPC or frame sealed the relay (name and cause kind only).
          if (!relay.#stopping && !relay.#sealed) console.warn(`[mount-relay] mount failure seals the relay mount=${name.slice(0, 64)}`
            + ` cause=${error !== undefined ? "native" : refusal !== undefined ? "refusal" : "none"}`);
          relay.seal(error, refusal);
        }, () => descendants.track(), () => !!relay.#onTicketFailure, (cause, reason) =>
          relay.dropMount(name, cause, reason, () => {
            teardown.markStopRequested();
            void descendants.ready().then(() => {
              killCliTree(child);
              return descendants.stop();
            }).catch(() => {});
          }), () => {
          const socket = relay.#connections.get(name);
          if (!socket || socket.destroyed || !socket.writableNeedDrain) return undefined;
          return new Promise<void>(resolve => { const done = () => { socket.off("drain", done); socket.off("close", done); resolve(); };
            socket.once("drain", done); socket.once("close", done); });
        });
        // One bounded line per dropped mount, once its child has gone: how it ended and its own first refusing checks.
        child.once("close", (code, signal) => {
          if (relay.mountUnavailable(name)) console.warn(`[mount-relay] dropped mount child closed mount=${JSON.stringify(name.slice(0, 64))}`
            + ` code=${code ?? "-"} signal=${signal ?? "-"} stderr=${transport.stderrCause()}`);
        });
        if (relay.mountUnavailable(name)) transport.retire();
        else relay.mounts.set(name, transport);
        relay.#children.push({ name, transport, descendants, teardown });
        descendants.track();
      }
      return relay;
    } catch (error) {
      logSwallowedConsumingError("relay.build", error);
      const memoryRefusal = (error as { code?: string } | null)?.code === "MEMORY_CONTEXT_REVOKED"
        || (error as { message?: string } | null)?.message === "MEMORY_CONTEXT_REVOKED";
      if (previous) relay.retire();
      else relay.seal(memoryRefusal ? undefined : error ?? transportClosed(), memoryRefusal ? error : undefined);
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
  attach(cli: ChildProcess, onFailure: (nativeError?: unknown, refusal?: unknown) => void, endCli?: (cli: ChildProcess) => void): void {
    this.#cli = cli; this.#onFailure = onFailure;
    if (endCli) this.#endCli = endCli;
    if (this.#sealed) { killCliTree(cli); if (this.#refusal === undefined) onFailure(this.#nativeFailure); else onFailure(this.#nativeFailure, this.#refusal); }
  }
  mountUnavailable(name: string): boolean { return this.#unavailable.has(name); }
  reportUnavailable(base: () => Pick<RuntimeEvent, "eventId" | "provider" | "threadId" | "turnId" | "createdAt">, emit: (event: RuntimeEvent) => void): void {
    if (!this.#unavailable.size || this.#sealed) return;
    const labels = unavailableLabels([...this.#unavailable].map(name => fuigoMemoryAlias.test(name) ? "murage-memory" : name.replace(/[\p{C}\p{Z}]+/gu, " ").trim()));
    const list = new Intl.ListFormat("en").format(labels);
    const title = `Murage couldn't use the ${list} for this reply.`;
    const event = base();
    const itemId = `mount-unavailable-${event.turnId}`;
    emit({ ...event, type: "item.started", itemType: "tool", origin: "murage", toolKind: "notice", itemId, title });
    emit({ ...base(), type: "item.completed", itemType: "tool", itemId, ok: false });
  }
  /** The engine reports this mount settled without coming up (unavailable, failed...): an optional mount is retired for the turn, like one
   * whose child exited (dropMount decides which names may be dropped; a name it refuses stays, and the caller's gate refuses). */
  retireSettledMount(name: string, status: string): boolean { return this.dropMount(name, "exit", status); }
  private dropMount(name: string, cause: MountLoss, reason?: string, stopChild?: () => void): boolean {
    if (this.#unavailable.has(name)) return true;
    if (this.#stopping || this.#sealed || this.#onTicketFailure || !this.#droppable(name)) return false;
    const entry = this.#entries.get(name)!;
    const mount = admittedMcpMount(entry);
    const proxy = entry.command === process.execPath ? (entry.args as string[])[0] : undefined;
    // Only the wipe proxy itself can report loss of the server behind it.
    if (cause === "server" && proxy !== SPAWNED_PROXIES.wipeMcp) return false;
    this.#unavailable.add(name);
    this.mounts.get(name)?.retire();
    mount.ingress.retire();
    this.mounts.delete(name);
    this.#connections.get(name)?.destroy();
    this.#connections.delete(name);
    stopChild?.();
    console.warn(`[mount-relay] mount unavailable mount=${JSON.stringify(name.slice(0, 64))} cause=${cause}${reason ? ` reason=${terminalReasonWord(reason)}` : ""}`);
    return true;
  }
  /** A mount this turn may answer without: an integration or optional tool, never Murage's own box, permission or ledger-refused proxy. */
  #droppable(name: string): boolean {
    if (this.#murageOwn(name)) return false;
    const integrations = this.turn.integrations;
    // 1.0.24 winfirst (MAIN: owner turns pass; memory not ready = answer without memory, never write past the fence): a decided owner's
    // turn lets its Fuigo memory alias go like the plain "murage-memory" (its gate retires it unproven, a dead child drops it); dropping
    // closes its ingress and connection, so nothing reaches memory past the fence, and the bot is told. Any other audience keeps it required.
    const ownerMemory = fuigoMemoryAlias.test(name) && this.turn.warmIdentity?.audience === "owner" && this.turn.warmIdentity.decidedOwner === true;
    return optionalMountNames.has(name) || ownerMemory || isConnectedAppsServer(name) || integrations?.agents?.serverName === name
      || Object.hasOwn(integrations?.custom ?? {}, name);
  }
  /** Murage's own box, permission or ledger-refused proxy: no turn may answer without it. */
  #murageOwn(name: string): boolean {
    if (name === "muragebox") return true;
    const entry = this.#entries.get(name)!;
    const proxy = entry.command === process.execPath ? (entry.args as string[])[0] : undefined;
    return admittedMcpMount(entry).ingress.ledgerRefused || proxy === SPAWNED_PROXIES.permission;
  }
  /** q1024-steerquar H2: the owner's turn passes a bot hold (assertRelayAvailable) but never starts a second copy of an integration
   * whose earlier mount child is not confirmed gone, since that child may still run with the same env and secrets. The mount is
   * dropped for this reply and the owner is told (reportUnavailable). Murage's own proxies, which no turn may drop, still start:
   * their only capability is the held relay's ticket and admission, which its stop has already cleared and disposed. */
  #skipHeldMount(name: string): boolean {
    if (this.turn.hostPowerOwnerTurn !== true) return false;
    // ASTRA 0faec876bb: held by its process, not only its name. Drivers name one integration differently (Antigravity "murage-computer",
    // "murage-agents", "murage-custom-<name>"; Codex/ACP "computer", "agents", "<name>"), so a bot switched between them would
    // otherwise relaunch the computer integration beside its unconfirmed earlier child.
    const launch = mountLaunch(this.#entries.get(name));
    if (!heldMounts(this.turn).some(held => held.name === name || held.launch === launch) || this.#murageOwn(name)) return false;
    this.#unavailable.add(name);
    admittedMcpMount(this.#entries.get(name)!).ingress.retire();
    console.warn(`[mount-relay] mount unavailable mount=${JSON.stringify(name.slice(0, 64))} cause=held`);
    return true;
  }
  /** The mount names and launches of this relay's children not yet confirmed gone. */
  unconfirmedMounts(): Array<{ name: string; launch: string }> {
    return this.#children.filter(({ name }) => !this.#mountsGone.has(name)).map(({ name }) => ({ name, launch: mountLaunch(this.#entries.get(name)) }));
  }
  private dropConnection(name: string, cause: "socket" | "duplicate"): boolean {
    return this.mountUnavailable(name) || (this.mounts.get(name)?.drop(cause) ?? false);
  }
  private connect(socket: Socket): void {
    this.#sockets.add(socket);
    let name: string | undefined;
    // One engine line at a time: its parts as they arrive (never re-copied per chunk), and whether the rest of a cut line is being discarded.
    let parts: Buffer[] = [], held = 0;
    // Closed before its ticket was read: one line with the reason word only (never the bytes), then the close.
    const refuse = (reason: "timeout" | "ticket" | "mount" | "frame") => {
      if (!this.#stopping && !this.#sealed) console.warn(`[mount-relay] engine connection closed before its ticket reason=${reason}`);
      socket.destroy();
    };
    // A hang guard for a connection that never sends its ticket, not a deadline for a slow server: the shim writes the
    // ticket the moment it connects, and a busy main loop reads it late, not never (cause17: a 5 s guard closed every
    // shim of a turn after one late loop turn). A wrong ticket still closes at once below.
    const timer = setTimeout(() => refuse("timeout"), TURN_RELEASE_WAIT_MS); timer.unref();
    socket.on("error", error => {
      if (!name || this.#stopping || this.#sealed || this.dropConnection(name, "socket")) return;
      console.warn(`[mount-relay] engine connection error seals the relay mount=${name.slice(0, 64)}`);
      this.seal(error);
    });
    socket.on("close", () => {
      clearTimeout(timer); this.#sockets.delete(socket);
      if (!name || this.#stopping || this.#sealed || this.dropConnection(name, "socket")) return;
      console.warn(`[mount-relay] engine connection closed seals the relay mount=${name.slice(0, 64)}`);
      this.seal(transportClosed());
    });
    socket.on("data", (chunk: Buffer) => {
      if (this.#stopping || this.#sealed || (name && this.mountUnavailable(name))) { socket.destroy(); return; }
      // MAIN-RULING cause22-no-transport-caps: a call of any size is read once the connection has named its mount. Only the first line
      // of a connection that has not shown its ticket yet keeps a bound.
      if (!name) { const end = chunk.indexOf(10); if (held + (end < 0 ? chunk.length : end) > TICKET_LINE_MAX_BYTES) { refuse("frame"); return; } }
      let start = 0;
      while (start < chunk.length) {
        if (socket.destroyed || this.#stopping || this.#sealed) return;
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end < 0 ? chunk.length : end);
        parts.push(part); held += part.length;
        if (end < 0) return;
        const line = (parts.length === 1 ? parts[0]! : Buffer.concat(parts, held)).toString("utf8"); parts = []; held = 0; start = end + 1;
        if (!name) {
          try {
            const auth = JSON.parse(line);
            const ticket = Buffer.from(typeof auth.ticket === "string" ? auth.ticket : "");
            const ticketOk = ticket.length === Buffer.byteLength(this.ticket) && timingSafeEqual(ticket, Buffer.from(this.ticket));
            if (!ticketOk || typeof auth.server !== "string" || !this.mounts.has(auth.server)) {
              // An expected mount with a stale/unknown ticket fails only the
              // S2 barrier. Authentication never acquires a consuming ingress.
              if (typeof auth.server === "string" && this.mounts.has(auth.server)) {
                try { this.#onTicketFailure?.(); } catch {}
              }
              refuse(ticketOk ? "mount" : "ticket"); return;
            }
            // Authentication precedes association: strangers cannot refuse a turn.
            if (this.#connections.has(auth.server)) {
              if (this.dropConnection(auth.server, "duplicate")) { socket.destroy(); return; }
              if (!this.#stopping && !this.#sealed) console.warn(`[mount-relay] second engine connection for one mount seals the relay mount=${auth.server.slice(0, 64)}`);
              this.seal(); socket.destroy(); return;
            }
            name = auth.server as string; this.#connections.set(name, socket); clearTimeout(timer);
          } catch { refuse("frame"); return; }
        } else {
          const target = this.mounts.get(name);
          NotModelRequest("Local MCP relay dispatches to the mounted tool channel.", target?.request(line));
          // A child whose stdin is busy makes the engine connection wait, on every turn.
          const busy = target?.stdinBusy();
          if (busy && !socket.isPaused()) { socket.pause(); void busy.then(() => { if (!socket.destroyed) socket.resume(); }); }
        }
      }
    });
  }
  seal(nativeError?: unknown, refusal?: unknown): void {
    if (this.#stopping || this.#sealed) return;
    if (this.#onTicketFailure) {
      const failed = this.#onTicketFailure;
      this.retire();
      try { failed(); } catch {}
      return;
    }
    this.#sealed = true;
    this.#nativeFailure = nativeError; this.#refusal = refusal;
    // The first cause of a sealed relay: a native transport failure, a ledger refusal, or neither (a protocol seal).
    logSwallowedConsumingError(nativeError !== undefined ? "relay.seal:native" : refusal !== undefined ? "relay.seal:refusal" : "relay.seal",
      nativeError ?? refusal ?? new Error("RELAY_SEALED"));
    if (nativeError !== undefined) {
      // Invalidate every mount before teardown; native failure is not a ledger denial.
      for (const mount of this.mounts.values()) mount.retire();
      for (const entry of this.#entries.values()) admittedMcpMount(entry).ingress.retire();
    } else {
      if (!this.#entries.size && this.turn.releaseBinding) { try { refuseConsumingTurn(this.turn.releaseBinding); } catch {} }
      for (const entry of this.#entries.values()) { try { admittedMcpMount(entry).ingress.seal(); } catch {} }
    }
    if (this.#cli) { try { killCliTree(this.#cli); } catch {} }
    try { if (refusal === undefined) this.#onFailure?.(nativeError); else this.#onFailure?.(nativeError, refusal); } catch {}
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
  /** A stop's end of the engine (stdin end, then the tree signal). It runs one microtask after the stop began, never inside the
   *  caller's step: ACP's interrupt starts the stop and then writes session/cancel in the same step, and an engine signalled
   *  before that line went out never reads its cancellation (1.0.21: cause9 had moved this end above the stop's first await). */
  async endEngine(cli: ChildProcess): Promise<boolean> {
    await null;
    try { this.#endCli(cli); } catch {}
    try { killCliTree(cli); return true; } catch { return false; }
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
      // The engine is ended first, beside the mount servers' process list and never behind it. It is not a parent of the mount
      // servers (Murage starts them), so their descendant snapshot does not need it alive, and a Stop must not leave it running
      // while a slow process list is waited for.
      const engineEnded = cli ? this.endEngine(cli).catch(() => false) : Promise.resolve(true);
      await Promise.all(this.#children.map(async ({ transport, descendants, teardown }) => {
        try {
          teardown.markStopRequested();
          await descendants.ready();
          try { transport.child.stdin?.end(); } catch {}
          killCliTree(transport.child);
        } catch { stopFailed = true; }
      }));
      if (!(await engineEnded)) stopFailed = true;
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
      // Keep all surviving trees owned; late confirmation must include both. Each mount child is recorded gone on its own
      // confirmation (heldMounts); a relay whose whole stop confirmed has already left the hold.
      void Promise.all([cli ? cliTreeStoppedSignal(cli) : Promise.resolve(true), ...this.#children.map(({ name, teardown, descendants }) =>
        Promise.all([new Promise<void>(resolve => teardown.onClosed(resolve)), descendants.goneSignal()]).then(() => { this.#mountsGone.add(name); }))])
        .then(release, () => {});
    }
    return confirmed;
  }
}
