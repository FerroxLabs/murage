// Host CUA is shared, but ordinary model turns are not computer operations.
// Keep the trusted driver behind the harness and reserve it only while an
// admitted tool call (including transport cleanup) is actually outstanding.
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";
import { currentUpstreamAccounting } from "./memory/upstream-reader.ts";
import { verifyExeIdentity } from "../shared/cua-driver-identity.mjs";
import { WINDOWS_DRIVER_SHA256 } from "../shared/cua-driver-windows-pins.mjs";

export type HostComputerSpec = { command: string; args: string[]; env: Record<string, string>; platform?: string; generation?: string };
/** DESIGN 1022-cua-windows D6 b: before each NEW MCP child of a win32 descriptor, the exe is hashed through one fd and
 * the path must still name that file object. true = the pinned bytes. */
/** "ok"; "integrity" (the bytes or the file object are wrong: tell main, which stops the driver); "busy" (could not
 * read the file now, e.g. a scanner holds it: that one call fails, retryable, nothing is stopped). */
export type SpawnVerifier = (command: string) => Promise<"ok" | "integrity" | "busy">;
const verifyWindowsDriver: SpawnVerifier = async (command) => {
  const answer = await verifyExeIdentity(command, WINDOWS_DRIVER_SHA256, undefined, { exclusive: false });
  if (answer.ok) return "ok";
  return answer.reason === "busy" || answer.reason === "unreadable" ? "busy" : "integrity";
};
export const DRIVER_INTEGRITY_TEXT = "This computer's driver failed its integrity check, so nothing was performed. The owner can reinstall Murage.";
const integrityFailed = () => Object.assign(new Error(DRIVER_INTEGRITY_TEXT), { status: 409, code: "driver-integrity", sent: false });
const driverBusy = () => Object.assign(new Error("This computer's driver file could not be read just now, so nothing was performed. Try again in a moment."), { status: 409, code: "driver-busy", sent: false });
// DESIGN 1022-cua-windows C4 / D13: a generation main withdrew or retired takes no new call, whatever the route's gate says.
const generationOff = () => Object.assign(new Error("This computer's driver is being stopped or restarted, so nothing was performed. Try again in a moment."), { status: 409, code: "host-off", sent: false });
const driverExited = () => Object.assign(new Error("This computer's driver stopped while this action ran. It may have partly happened; check the screen before continuing."), { status: 409, code: "driver-exited", sent: true });
// C8 / D16 a: the MCP child died (exit, broken pipe, the withdraw grace kill) while a started action had no reply. The
// daemon may still be acting, so the claim is kept; main stops G and the claim clears only on retired:G (C4).
const driverLost = () => Object.assign(new Error("This computer's driver connection broke while this action ran. It may have partly happened; check the screen before continuing."), { status: 409, code: "driver-lost", sent: true });
const refused = () => Object.assign(new Error("Computer control changed or this turn is no longer active; its result cannot be delivered."), { status: 409 });
// A stop withdraws the action (MCP notifications/cancelled) but cannot recall
// input the driver already sent to the OS, so the wording never claims it can.
const cancelled = (sent: boolean) => Object.assign(new Error(sent
  ? "Stopped: this computer action was cancelled. An action already sent to the computer may still have taken effect; inspect the screen before continuing."
  : "Stopped before this computer action was sent; nothing was performed."), { status: 409, code: "cancelled", sent });

// The server request owns this raw transport; only standalone proxies use proxy IPC.
// A kept session passes `accept`, so each call's reply bytes are charged to
// that call's owner rather than to whichever call opened the connection.
function startHostEngine(spec: HostComputerSpec, accept?: (chunk: Uint8Array) => void): EngineClient {
  const accounting = accept ? undefined : currentUpstreamAccounting("collection");
  return startHeadlessEngine(spec, null, accept ?? (chunk => accounting?.accept(chunk)));
}
function currentAccept(): ((chunk: Uint8Array) => void) | undefined {
  const accounting = currentUpstreamAccounting("collection");
  return accounting && (chunk => accounting.accept(chunk));
}

/** One bot turn's driver connection. cua-driver 0.55.0 remembers which
 * windows were read (get_window_state) per MCP connection and refuses a pixel
 * click/type_text/press_key on a window this connection has not read, so a
 * turn's read and its next action must share one child. `key` names the bot,
 * thread, turn generation and host-control revision, so a new turn, another
 * bot, or a person taking control never inherits a read. `owner` is the retire
 * scope: a new key in the same scope replaces the old session. */
export type HostComputerSession = { key: string; owner: string };
/** The scope is one bot thread, never the bot: a bot may run several threads
 * at once, and one thread starting or reading must not retire another
 * thread's read (cua-upgrade-design/BROKER-DESIGN.md). */
export function hostComputerSession(botId: string, threadId: string, generation: string, revision: number): HostComputerSession {
  return { key: JSON.stringify([botId, threadId, generation, revision]), owner: JSON.stringify([botId, threadId]) };
}
/** A read is only worth keeping while the model is still looking at it. */
export const HOST_SESSION_IDLE_MS = 5 * 60_000;
/** How quickly a session of an ended/revoked turn is closed when unused. */
const HOST_SESSION_SWEEP_MS = 2_000;
type Session = {
  key: string; owner: string; fingerprint: string;
  authorize: () => boolean;
  generation?: string;
  client?: EngineClient;
  ready: Promise<EngineClient>;
  /** The current (else the latest) call's byte accounting: requests on a
   * session run one at a time, and bytes between calls belong to this turn. */
  accept?: (chunk: Uint8Array) => void;
  queue: Promise<unknown>;
  /** Calls admitted to this session and not yet settled (queued or running). */
  busy: number; lastUsed: number; closed?: Promise<void>;
};
const stillAuthorized = (authorize: () => boolean) => { try { return authorize(); } catch { return false; } };
const reset = () => Object.assign(new Error("This computer's driver connection was reset before this call was sent; nothing was performed. Read the window again with get_window_state before acting."), { status: 409 });

export class HostComputerBroker {
  private active: { generation?: string } | undefined;
  // C4: descriptor generations main withdrew (no new call, claim kept) and retired (driver confirmed gone)
  private readonly withdrawnGenerations = new Set<string>();
  private readonly retiredGenerations = new Set<string>();
  private readonly waiters = new Map<string, Set<(error: Error) => void>>();
  private pending = new Set<Promise<unknown>>();
  private closing = false;
  private readonly sessions = new Map<string, Session>();
  // sessions a newer key of the same thread took out of `sessions` while their last call is still waiting on the driver
  private readonly detached = new Set<Session>();
  private sweep: ReturnType<typeof setInterval> | undefined;
  private readonly start: (spec: HostComputerSpec, accept?: (chunk: Uint8Array) => void) => EngineClient;
  // one plain object, not function-valued own fields: the internal-authority fixture admits only prototype methods
  private readonly hooks: { verifySpawn: SpawnVerifier; onIntegrity: (generation: string | undefined) => void; onUnconfirmedLoss: (generation: string | undefined) => void };
  constructor(start: (spec: HostComputerSpec, accept?: (chunk: Uint8Array) => void) => EngineClient = startHostEngine, { verifySpawn = verifyWindowsDriver, onIntegrity = () => {}, onUnconfirmedLoss = () => {} }: { verifySpawn?: SpawnVerifier; onIntegrity?: (generation: string | undefined) => void; onUnconfirmedLoss?: (generation: string | undefined) => void } = {}) {
    this.start = start;
    this.hooks = { verifySpawn, onIntegrity, onUnconfirmedLoss };
  }

  /** C8: a started action's request failed and its child is gone. The caller gets `driver-lost` (409, never a 500 that
   * seals the mount), the claim stays (the finally blocks keep it: no reply), and main is told at once (win32: cua-stuck). */
  private actionFailed(error: unknown, client: EngineClient, generation: string | undefined): unknown {
    if (!client.ended?.()) return error;
    try { this.hooks.onUnconfirmedLoss(generation); } catch { /* the 409 below still says it */ }
    return driverLost();
  }

  /** The env and the go-ahead for ONE new MCP child, on both paths (one-off and kept session). D4: a win32 child never
   * inherits a CUA_* key or DO_NOT_TRACK; D6 b: a win32 exe is hashed through one fd first ("busy" fails only this call,
   * "integrity" also tells main, which stops the driver). */
  private spawnSpec(spec: HostComputerSpec): HostComputerSpec {
    const windows = spec.platform === "win32";
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && !(windows && (/^CUA_/i.test(entry[0]) || entry[0].toUpperCase() === "DO_NOT_TRACK"))));
    return { ...spec, env: { ...env, ...spec.env } };
  }

  private fence(spec: HostComputerSpec): void {
    if (spec.generation && (this.withdrawnGenerations.has(spec.generation) || this.retiredGenerations.has(spec.generation))) throw generationOff();
  }

  /** C4: main withdrew generation G (Disable, restart, integrity, quit, update). No new call on G starts; a G claim
   * stays held, because the driver may still be acting until its exit is confirmed. */
  withdrawGeneration(generation: string): void { this.withdrawnGenerations.add(generation); }

  /** C4: main confirmed G's driver exited. Only now are G's sessions closed, G's waiting calls answered
   * `driver-exited`, and a G claim cleared. Never without `exitConfirmed` (a live daemon might still type). */
  retireGeneration(generation: string, { exitConfirmed }: { exitConfirmed: boolean }): void {
    if (exitConfirmed !== true) return;
    this.withdrawnGenerations.add(generation);
    this.retiredGenerations.add(generation);
    for (const item of [...this.sessions.values(), ...this.detached]) if (item.generation === generation) void this.closeSession(item).catch(() => {});
    const waiting = this.waiters.get(generation);
    this.waiters.delete(generation);
    for (const reject of waiting ?? []) reject(driverExited());
    if (this.active?.generation === generation) this.active = undefined;
  }

  private watch(generation: string | undefined, call: Promise<unknown>): Promise<unknown> {
    if (!generation) return call;
    return new Promise((resolve, reject) => {
      const set = this.waiters.get(generation) ?? new Set<(error: Error) => void>();
      this.waiters.set(generation, set);
      set.add(reject);
      call.then(resolve, reject).finally(() => { set.delete(reject); if (!set.size && this.waiters.get(generation) === set) this.waiters.delete(generation); });
    });
  }

  /** win32 only (other platforms start exactly as before, with no added await). */
  private async verifyWindowsSpawn(spec: HostComputerSpec): Promise<void> {
    const verdict = await this.hooks.verifySpawn(spec.command);
    if (verdict === "busy") throw driverBusy();
    if (verdict !== "ok") {
      try { this.hooks.onIntegrity(spec.generation); } catch { /* the answer below still says it */ }
      throw integrityFailed();
    }
  }

  /** `signal` is the stop: it answers the caller at once and withdraws the
   * action, while exclusion is still held until the driver really replies.
   * With `session`, the call runs on that turn's kept driver connection
   * (see HostComputerSession); without it, on a child of its own. */
  dispatch(spec: HostComputerSpec, method: string, params: Record<string, unknown> = {}, authorize: () => boolean = () => false, signal?: AbortSignal, session?: HostComputerSession): Promise<unknown> {
    const allowed = () => { if (this.closing || !authorize()) throw refused(); };
    allowed();
    this.fence(spec);
    if (method !== "tools/list" && method !== "tools/call") throw new Error("Unsupported computer method");
    if (method === "tools/call" && (typeof params.name !== "string" || !params.name)) throw new Error("Invalid computer tool call");
    const claim = method === "tools/call" ? { generation: spec.generation } : undefined;
    if (claim && this.active) throw Object.assign(new Error("Another computer action is in progress. This call was not performed; inspect the screen again before retrying."), { status: 409 });
    if (signal?.aborted) throw cancelled(false);
    if (claim) this.active = claim;
    let actionStarted = false;
    const operation = session ? this.onSession(this.acquire(spec, session, authorize), method, params, claim, allowed, signal, currentAccept(), () => { actionStarted = Boolean(claim); }) : (async () => {
      let client: EngineClient | undefined;
      let closed = false;
      let result: unknown;
      let actionReplied = false;
      try {
        if (spec.platform === "win32") { await this.verifyWindowsSpawn(spec); allowed(); }
        this.fence(spec);
        client = this.start(this.spawnSpec(spec));
        await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "murage-host-computer", version: "1" } });
        await client.notify?.("notifications/initialized");
        allowed();
        this.fence(spec);
        if (signal?.aborted) throw cancelled(false);
        actionStarted = Boolean(claim);
        // no clock on the action itself (0.1.61): it ends when it answers,
        // on Stop, or when the harness revokes the turn for silence
        try { result = await client.request(method, params, method === "tools/call" ? { signal, timeoutMs: null } : { signal }); }
        catch (error) { throw claim ? this.actionFailed(error, client, spec.generation) : error; }
        actionReplied = true;
        allowed();
      } finally {
        // The MCP child proxies a separate host daemon. Closing that child
        // cannot prove a timed-out daemon action stopped. Retain exclusion
        // without a matching reply; only normal confirmed replies recycle it.
        if (client) { await client.close(); closed = true; }
        else closed = true;
        if (closed && (!actionStarted || actionReplied) && claim && this.active === claim) this.active = undefined;
      }
      allowed();
      return result;
    })();
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation)).catch(() => {});
    if (!signal) return this.watch(spec.generation, operation);
    return this.watch(spec.generation, new Promise((resolve, reject) => {
      const stop = () => reject(cancelled(actionStarted));
      signal.addEventListener("abort", stop, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    }));
  }

  async drain(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
    const closes = await Promise.allSettled([...this.sessions.values()].map(item => this.closeSession(item)));
    if (this.active || closes.some(outcome => outcome.status === "rejected")) throw new Error("Host computer operation cleanup is unconfirmed");
  }

  /** The turn's session, or a new one. Another key of the same thread, a changed
   * driver spec, a dead child, or a revoked turn never carries a read over. */
  private acquire(spec: HostComputerSpec, session: HostComputerSession, authorize: () => boolean): Session {
    const fingerprint = JSON.stringify([spec.command, spec.args, spec.env]);
    for (const other of [...this.sessions.values()]) if (other.owner === session.owner && other.key !== session.key) this.retire(other);
    const kept = this.sessions.get(session.key);
    if (kept && (kept.fingerprint !== fingerprint || kept.client?.ended?.() || !stillAuthorized(kept.authorize))) this.retire(kept);
    const current = this.sessions.get(session.key);
    if (current) { current.authorize = authorize; return current; }
    const created: Session = { ...session, generation: spec.generation, fingerprint, authorize, busy: 0, lastUsed: Date.now(), queue: Promise.resolve(), ready: undefined as unknown as Promise<EngineClient> };
    created.ready = (async () => {
      if (spec.platform === "win32") await this.verifyWindowsSpawn(spec);
      this.fence(spec);
      const client = created.client = this.start(this.spawnSpec(spec), chunk => created.accept?.(chunk));
      await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "murage-host-computer", version: "1" } });
      await client.notify?.("notifications/initialized");
      return client;
    })();
    created.ready.catch(() => {});
    this.sessions.set(session.key, created);
    this.sweep ??= setInterval(() => this.sweepSessions(), HOST_SESSION_SWEEP_MS);
    this.sweep.unref?.();
    return created;
  }

  /** Same admission and exclusion rules as a one-off child. Only a confirmed
   * reply on a still-authorized, unstopped call keeps the connection; every
   * other ending closes it, so a later click must read the window again. */
  private onSession(item: Session, method: string, params: Record<string, unknown>, claim: { generation?: string } | undefined, allowed: () => void, signal: AbortSignal | undefined, accept: ((chunk: Uint8Array) => void) | undefined, started: () => void): Promise<unknown> {
    let actionStarted = false;
    let actionReplied = false;
    item.busy++;
    const run = item.queue.then(async () => {
      let kept = false;
      try {
        if (item.closed) throw reset();
        // set before the handshake, so the call that opens the child pays for it
        item.accept = accept;
        const client = await item.ready;
        allowed();
        this.fence({ command: "", args: [], env: {}, generation: item.generation });
        if (signal?.aborted) throw cancelled(false);
        if (item.closed || client.ended?.()) throw reset();
        actionStarted = Boolean(claim); started();
        let result: unknown;
        try { result = await client.request(method, params, method === "tools/call" ? { signal, timeoutMs: null } : { signal }); }
        catch (error) { throw claim ? this.actionFailed(error, client, item.generation) : error; }
        actionReplied = true;
        allowed();
        if (signal?.aborted) throw cancelled(true);
        kept = true;
        return result;
      } finally {
        item.busy--;
        item.lastUsed = Date.now();
        let closed = true;
        if (!kept) await this.closeSession(item).catch(() => { closed = false; });
        if (closed && (!actionStarted || actionReplied) && claim && this.active === claim) this.active = undefined;
      }
    });
    item.queue = run.catch(() => {});
    return run;
  }

  /** Takes no new calls; closes once the calls already admitted settle, so a
   * new turn never cuts off the old turn's withdrawn action before its reply. */
  private retire(item: Session): void {
    if (this.sessions.get(item.key) === item) this.sessions.delete(item.key);
    this.detached.add(item);
    const closing = item.queue.then(() => this.closeSession(item));
    this.pending.add(closing);
    void closing.finally(() => { this.pending.delete(closing); this.detached.delete(item); }).catch(() => {});
  }

  private closeSession(item: Session): Promise<void> {
    if (this.sessions.get(item.key) === item) this.sessions.delete(item.key);
    if (!this.sessions.size && this.sweep) { clearInterval(this.sweep); this.sweep = undefined; }
    if (!item.closed) {
      item.closed = (async () => { await (item.client ?? await item.ready.catch(() => undefined))?.close(); })();
      this.pending.add(item.closed);
      void item.closed.finally(() => this.pending.delete(item.closed!)).catch(() => {});
    }
    return item.closed;
  }

  private sweepSessions(): void {
    const now = Date.now();
    for (const item of [...this.sessions.values()]) {
      if (item.busy) continue;
      if (now - item.lastUsed >= HOST_SESSION_IDLE_MS || item.client?.ended?.() || !stillAuthorized(item.authorize)) void this.closeSession(item).catch(() => {});
    }
  }
}
