import { ParkFs, SignalParkError, readSignalFile, parkReason } from "./park-fs.ts";
import { assertSignalQuiescent, beginSignalChild, publishSignalChild, exitSignalChild } from "./park-fence.ts";
import { readControl } from "./park-control.ts";
import { barrierSignalRecoveryParents, assertSignalServiceAllowed, type ParkOptions } from "./park.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { withHideInherit } from "../../../shared/win-hide-child-process.mjs";
import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { constants, openSync, closeSync, fstatSync, lstatSync, readdirSync, unlinkSync, renameSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { aciSchema, notificationSchema, parseRequest, parseResponse, type RpcPolicy } from "./rpc.ts";
import type { ProcessHost, RpcId, RpcMethod, RpcNotification, RpcRequest, RpcResponse, RuntimePin, SignalProblem, SignalPreservation, StorageGuard } from "./types.ts";
// @ts-expect-error The shared staging digest is an ESM JavaScript build module.
import { verifyRuntimeTree } from "./runtime-integrity.mjs";
// @ts-expect-error Shared ESM evidence verifier also runs in release tooling.
import { verifySignalEvidence } from "./evidence.mjs";
// @ts-expect-error Shared ESM runtime path contract.
import { signalFixtureDir } from "./runtime-paths.mjs";

export const MAX_FRAME_BYTES = 1024 * 1024;
const PERIOD = 30_000;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
const LOG_RESTART_BYTES = 8 * 1024 * 1024;
export interface Child extends EventEmitter {
  pid?: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
}
export type SpawnChild = (file: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"];
}) => Child;
export interface VerifiedRuntime { java: string; jar: string; nativeDir?: string; version: string }
export interface HostIdentity { ownAci: string; ownDeviceId: number; number: string }
export interface HostNotification { generation: number; spawnToken: symbol; notification: RpcNotification }
export interface HostRequestOptions {
  generation: number;
  /** Required at runtime. Optional in this extension only to preserve frozen B0
   * structural compatibility; B0 callers without a captured token fail closed.
   * Capture with the work, never refresh a delayed request from the getter.
   */
  spawnToken?: symbol;
  beforeWrite?: () => boolean;
}
export type HostEvent =
  | { kind: "blocked"; reason: SignalProblem; generation: number; preservation?:SignalPreservation }
  | { kind: "ready"; generation: number; spawnToken: symbol; identity: HostIdentity | null }
  | { kind: "exited"; generation: number; respawnInMs: number | null }
  | { kind: "malformed" | "unknown-method"; generation: number };
export interface HostOptions {
  dataDir: string;
  park?: ParkOptions;
  storage: StorageGuard;
  /** R's verifier must validate every jar, JRE and JNI hash against the pin.
   * Called before EVERY spawn; rejection blocks, with no fallback to system Java.
   */
  verifyRuntime: () => Promise<VerifiedRuntime>;
  spawnChild?: SpawnChild;
  rpc?: RpcPolicy;
  /** B7's persisted binding; also checked against the last identity on a respawn. */
  expectedIdentity?: () => Pick<HostIdentity, "ownAci" | "ownDeviceId"> | null;
  /** No pending reply or journal fsync. Absence conservatively prevents log respawns. */
  isIdle?: () => boolean;
  onEvent?: (event: HostEvent) => void;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}
class HostError extends Error { readonly code: string; readonly preservation?:SignalPreservation; constructor(code:string,preservation?:SignalPreservation){super(code);this.code=code;this.preservation=preservation;} }

/** Per-spawn verification of the installed bytes. R defines the JRE digest as
 * SHA256(JSON.stringify(sorted tree rows)); keep the same file/link projection.
 * G0 citations authorize integration, while these checks detect changed files.
 */
export async function verifyRuntimePin(input: { runtimeDir: string; pin: RuntimePin; target: keyof RuntimePin["targets"] }): Promise<VerifiedRuntime> {
  try {
    const { pin, target } = input;
    const root = resolve(input.runtimeDir);
    if (pin.contract !== "murage-signal-runtime-pin/1.0" || !pin.g0?.citation || pin.g0.signalCliVersion !== pin.signalCliVersion
        || pin.rateLimitNotSentProof !== null || !pin.signalNetwork.syncProof || !pin.targets[target]) throw new Error();
    verifySignalEvidence(pin, signalFixtureDir(root));
    return { ...await verifyRuntimeTree({ root, pin, target }), version: pin.signalCliVersion };
  } catch { throw new HostError("needs-update"); }
}
type Pending = { method: RpcMethod; resolve: (value: RpcResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Session = {
  child: Child; fenceToken: string; fenceFailed: boolean; generation: number; spawnToken: symbol; epoch: number; ready: boolean; receiving: boolean; closing: boolean;
  buffer: Buffer; startup: Buffer; stderr: Buffer; pending: Map<RpcId, Pending>; lastFrame: number;
  pausedAt: number | null; pauseReason: "storage-slow" | "disk-full";
  pauseTimer?: ReturnType<typeof setTimeout>; ticker?: ReturnType<typeof setInterval>; killer?: ReturnType<typeof setTimeout>;
  ping: boolean; misses: number; version: string; identity: HostIdentity | null;
  exited: Promise<void>; resolveExit: () => void; planned: boolean;
};

/** Read only the identity projection: account files contain many private fields.
 * The full tree has already passed StorageGuard. O_NOFOLLOW closes the final-link race.
 */
function readJson(file: string): unknown {
  try { return JSON.parse(readSignalFile(file,16*1024*1024).toString("utf8")); }
  catch { throw new HostError("identity-unavailable"); }
}
const accountIndex = z.object({ accounts: z.array(z.object({
  path: z.string().regex(/^[^/\\:]+$/).refine(p => p !== "." && p !== ".."),
  uuid: aciSchema, number: z.string().regex(/^\+[0-9]{1,15}$/),
})).length(1) });
const identityProjection = z.strictObject({ deviceId: z.number().int().safe().positive() });
export function readAccountIdentity(dataDir: string): HostIdentity {
  try {
    const data = join(dataDir, "signal/auth/data");
    for (const path of [dataDir, join(dataDir, "signal"), join(dataDir, "signal/auth"), data]) {
      if (!lstatSync(path).isDirectory()) throw new HostError("identity-unavailable");
    }
    const parsed = accountIndex.safeParse(readJson(join(data, "accounts.json")));
    if (!parsed.success) throw new HostError("identity-unavailable");
    const entry = parsed.data.accounts[0];
    const raw = readJson(join(data, entry.path)) as { storage?: { deviceId?: unknown } } | null;
    const identity = identityProjection.safeParse({ deviceId: raw?.storage?.deviceId });
    if (!identity.success) throw new HostError("identity-unavailable");
    return { ownAci: entry.uuid, ownDeviceId: identity.data.deviceId, number: entry.number };
  } catch { throw new HostError("identity-unavailable"); }
}

export class SignalProcessHost implements ProcessHost {
  private current?: Session;
  private desired?: { generation: number; account: string | null };
  private epoch = 0;
  private generationValue = 0;
  private serial = 0;
  private failures = 0;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private lastIdentity: HostIdentity | null = null;
  private listeners = new Set<(frame: HostNotification) => void>();
  private exitCheck: Promise<void> = Promise.resolve();
  private custodyFault=false;
  private readonly options: HostOptions;
  constructor(options: HostOptions) { this.options = options; }
  get generation() { return this.generationValue; }
  /** Separate from the persisted binding generation; never reused across children or hosts. */
  get spawnToken(): symbol | undefined { return this.current && this.live(this.current) ? this.current.spawnToken : undefined; }
  get identity(): HostIdentity | null { return this.current?.ready && this.current.identity ? { ...this.current.identity } : null; }
  /** No accessor exposes the ring's plaintext to diagnostics. */
  get stderrBytes() { return this.current?.stderr.length ?? 0; }
  private emit(event: HostEvent) { this.options.onEvent?.(event); }
  private live(s: Session) { return this.current === s && s.epoch === this.epoch && !s.closing; }
  private assertEpoch(epoch: number) { if (epoch !== this.epoch || !this.desired) throw new HostError("offline"); }
  private block(reason: SignalProblem, generation = this.generation,preservation?:SignalPreservation) {
    this.desired = undefined;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.emit({ kind:"blocked",reason,generation,...(preservation?{preservation}:{}) });
  }
  async spawn(input: { generation: number; account: string | null }): Promise<void> {
    if (!Number.isSafeInteger(input.generation) || input.generation < this.generation || input.generation < 1) throw new HostError("offline");
    const stopping = this.stop();
    const epoch = this.epoch;
    await stopping;
    if (epoch !== this.epoch) throw new HostError("offline");
    this.generationValue = input.generation;
    this.desired = { ...input };
    await this.open(this.epoch);
  }
  private async open(epoch: number): Promise<void> {
    this.assertEpoch(epoch);
    const input = this.desired!;
    try {
      await this.exitCheck;
      this.assertEpoch(epoch);
      const parkIo = new ParkFs(this.options.dataDir,this.options.park);
      assertSignalQuiescent(parkIo,readControl(parkIo),this.options.park?.fence,false);
      barrierSignalRecoveryParents(parkIo);
      const controlParent=join(this.options.dataDir,"recovery-quarantine/signal-park-control");if(parkIo.checked(controlParent))parkIo.barrier(controlParent,true);
      const verdict = await this.options.storage.check();
      this.assertEpoch(epoch);
      if (verdict.state !== "ok") throw new HostError(verdict.reason);
      let runtime: VerifiedRuntime;
      try { runtime = await this.options.verifyRuntime(); } catch { throw new HostError("needs-update"); }
      this.assertEpoch(epoch);
      if (!runtime.version || !isAbsolute(runtime.java) || !isAbsolute(runtime.jar)) throw new HostError("needs-update");
      const identity = input.account === null ? null : readAccountIdentity(this.options.dataDir);
      if (identity && identity.number !== input.account) throw new HostError("identity-unavailable");
      const expected = this.options.expectedIdentity?.() ?? this.lastIdentity;
      if (identity && expected && (identity.ownAci !== expected.ownAci || identity.ownDeviceId !== expected.ownDeviceId)) throw new HostError("identity-mismatch");
      this.prepareFiles();
      // Newly created/rotated logs inherit a DACL on Windows. StorageGuard must
      // validate and protect those files too before the child can write them.
      const prepared = await this.options.storage.check();
      this.assertEpoch(epoch);
      if (prepared.state !== "ok") throw new HostError(prepared.reason);
      const root = resolve(this.options.dataDir, "signal");
      const env: NodeJS.ProcessEnv = { HOME: root, TMPDIR: join(root, "tmp"), PATH: dirname(runtime.java) };
      const parent = this.options.environment ?? process.env;
      if ((this.options.platform ?? process.platform) === "win32" && parent.SystemRoot) env.SystemRoot = parent.SystemRoot;
      const args = ["-XX:-UsePerfData", "-XX:-HeapDumpOnOutOfMemoryError", `-XX:ErrorFile=${join(root, "tmp/hs_err_%p.log")}`,
        "-XX:+DisableAttachMechanism", `-Djava.io.tmpdir=${join(root, "tmp")}`,
        `-Djava.library.path=${runtime.nativeDir ?? join(dirname(runtime.jar), "native")}`,
        `-Dorg.sqlite.lib.path=${runtime.nativeDir ?? join(dirname(runtime.jar), "native")}`,
        `-Dorg.sqlite.lib.name=${(this.options.platform ?? process.platform) === "win32" ? "sqlitejdbc.dll" : (this.options.platform ?? process.platform) === "darwin" ? "libsqlitejdbc.dylib" : "libsqlitejdbc.so"}`,
        "-jar", runtime.jar,
        "--config", join(root, "auth"), "--log-file", join(root, "log/signal-cli.log"),
        ...(input.account === null ? [] : ["-a", input.account]), "jsonRpc", "--receive-mode", "manual", "--ignore-attachments", "--ignore-stories"];
      const spawn: SpawnChild = this.options.spawnChild ?? ((file, argv, opts) => nodeSpawn(file, [...argv], withHideInherit(opts)));
      assertSignalServiceAllowed(this.options.dataDir,this.options.park);
      const fenceToken = beginSignalChild(new ParkFs(this.options.dataDir,this.options.park),input.generation,this.options.park?.fence);
      const child = spawn(runtime.java, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let resolveExit!: () => void;
      const exited = new Promise<void>(resolve => { resolveExit = resolve; });
      const s: Session = { child, fenceToken, fenceFailed: false, generation: input.generation, spawnToken: Symbol(), epoch, ready: false, receiving: false, closing: false,
        buffer: Buffer.alloc(0), startup: Buffer.alloc(0), stderr: Buffer.alloc(0), pending: new Map(), lastFrame: Date.now(),
        pausedAt: null, pauseReason: "storage-slow", ping: false, misses: 0, version: runtime.version, identity, exited, resolveExit, planned: false };
      this.current = s;
      child.stdout.on("data", (data: Buffer) => this.onData(s, Buffer.from(data)));
      child.stderr.on("data", (data: Buffer) => {
        if (this.live(s)) s.stderr = Buffer.from(Buffer.concat([s.stderr, Buffer.from(data).subarray(-4096)]).subarray(-4096));
      });
      child.on("exit", () => this.onExit(s));
      child.on("error", () => { if (this.live(s)) { if (!child.pid) this.onExit(s); else this.terminate(s); } });
      child.stdin.on("error", () => { if (this.live(s)) this.terminate(s); });
      child.stdout.on("error", () => { if (this.live(s)) this.terminate(s); });
      child.stderr.on("error", () => { if (this.live(s)) this.terminate(s); });
      try { publishSignalChild(new ParkFs(this.options.dataDir,this.options.park),fenceToken,child.pid,this.options.park?.fence); }
      catch (error) { s.fenceFailed = true; this.terminate(s); throw error; }
      const version = await this.internal(s, "version");
      if (!this.live(s)) throw new HostError("offline");
      if (!("result" in version) || (version.result as { version: string }).version !== runtime.version) throw new HostError("needs-update");
      if (identity) {
        let response: RpcResponse;
        try { response = await this.internal(s, "listAccounts"); } catch (error) {
          if (error instanceof HostError && ["offline", "timeout", "broken-pipe"].includes(error.code)) throw error;
          throw new HostError("identity-unavailable");
        }
        if (!this.live(s)) throw new HostError("offline");
        const accounts = "result" in response ? response.result as Array<{ number: string; aci: string }> : [];
        if (accounts.length !== 1 || accounts[0].aci !== identity.ownAci || accounts[0].number !== identity.number) throw new HostError("identity-unavailable");
        // Do not open receive while the subscription's G0 contract is unresolved.
        if (!this.options.rpc?.contracts?.subscribeReceive) throw new HostError("needs-update");
        // Only this child's checked identity may subscribe. B7 still applies A9.
        s.receiving = true;
        const subscribed = await this.internal(s, "subscribeReceive");
        if (!this.live(s)) throw new HostError("offline");
        if ("error" in subscribed) throw new HostError("identity-unavailable");
        s.receiving = true;
        this.lastIdentity = { ...identity };
      }
      s.ready = true;
      s.ticker = setInterval(() => this.tick(s), PERIOD); s.ticker.unref?.();
      this.emit({ kind: "ready", generation: s.generation, spawnToken: s.spawnToken, identity: identity ? { ...identity } : null });
      // Service readiness installs the checked token and ledger synchronously.
      // Replay through the normal parser so its pause/generation fences apply.
      s.buffer = Buffer.concat([s.startup, s.buffer]); s.startup = Buffer.alloc(0);
      this.frames(s);
      if (this.live(s) && s.pausedAt === null) s.child.stdout.resume();
    } catch (error) {
      if (epoch !== this.epoch) throw new HostError("offline");
      const reason = error instanceof SignalParkError ? error.reason === "busy" ? "kept-busy" : "kept-check" : error instanceof HostError ? error.code === "invalid-frame" ? "needs-update" : error.code : "storage-permissions";
      const preservation:SignalPreservation|undefined=error instanceof SignalParkError||parkReason(error)==="durability"?{progress:parkReason(error)==="busy"?"busy":parkReason(error)==="adoption"?"adoption":parkReason(error)==="durability"?"durability":"check",canLink:false,canKeepBoth:false}:undefined;
      if (!["offline", "timeout", "broken-pipe"].includes(reason)) this.block(reason as SignalProblem,input.generation,preservation);
      if (this.current?.epoch === epoch) { this.terminate(this.current); await this.current?.exited; }
      throw new HostError(reason,preservation);
    }
  }
  private prepareFiles() {
    const root = join(this.options.dataDir, "signal");
    const tmp = join(root, "tmp");
    for (const name of readdirSync(tmp)) if (/^hs_err_[0-9]+\.log$/.test(name)) unlinkSync(join(tmp, name));
    const log = join(root, "log/signal-cli.log");
    const fd = openSync(log, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    let size: number;
    try { if (!fstatSync(fd).isFile()) throw new HostError("storage-permissions"); size = fstatSync(fd).size; } finally { closeSync(fd); }
    chmodSync(log, 0o600);
    if (size > LOG_ROTATE_BYTES) {
      try { unlinkSync(log + ".1"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      renameSync(log, log + ".1");
      closeSync(openSync(log, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
    }
  }
  onNotification(listener: (frame: HostNotification) => void) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  /** G0/B7 may supply authenticated evidence for a known own-device echo.
   * Never call this for arbitrary owner messages: other linked devices are valid senders.
   */
  confirmOwnDevice(sourceDevice: number, generation: number, spawnToken?: symbol): boolean {
    const s = this.current;
    if (!s || !this.live(s) || !s.ready || !s.identity || s.generation !== generation || s.spawnToken !== spawnToken) return false;
    if (sourceDevice === s.identity.ownDeviceId) return true;
    this.block("identity-unavailable"); this.terminate(s); return false;
  }
  async request<M extends RpcMethod>(request: RpcRequest<M>, options: HostRequestOptions): Promise<RpcResponse<M>> {
    const checked = parseRequest(request, this.options.rpc);
    const s = this.current;
    if (!s || !this.live(s) || s.generation !== options.generation || s.spawnToken !== options.spawnToken || !s.ready) throw new HostError("offline");
    if (checked.method === "send" && !s.identity) throw new HostError("offline");
    if ((checked.method === "startLink" || checked.method === "finishLink") && s.identity) throw new HostError("invalid-request");
    if (checked.method === "subscribeReceive" && !s.identity) throw new HostError("offline");
    return this.write(s, checked, options.beforeWrite) as Promise<RpcResponse<M>>;
  }
  private internal(s: Session, method: "version" | "listAccounts" | "subscribeReceive") {
    return this.write(s, { jsonrpc: "2.0", id: `host:${s.epoch}:${++this.serial}`, method, params: {} });
  }
  private write(s: Session, request: RpcRequest, beforeWrite?: () => boolean): Promise<RpcResponse> {
    if (!this.live(s) || s.pending.size >= 100 || s.child.stdin.destroyed || s.child.stdin.writableNeedDrain) return Promise.reject(new HostError("offline"));
    // Caller IDs can be reused after a timeout; wire IDs cannot, even in the same child.
    const wireId = `wire:${s.epoch}:${++this.serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { s.pending.delete(wireId); reject(new HostError("timeout")); }, PERIOD); timer.unref?.();
      s.pending.set(wireId, { method: request.method, resolve: response => resolve({ ...response, id: request.id }), reject, timer });
      const fail = (code: string) => { clearTimeout(timer); s.pending.delete(wireId); reject(new HostError(code)); };
      try {
        const line = JSON.stringify({ ...request, id: wireId }) + "\n";
        // No await between cancellation and write; recheck generation for a reentrant fence.
        if (beforeWrite && !beforeWrite()) { fail("cancelled"); return; }
        if (!this.live(s)) { fail("offline"); return; }
        s.child.stdin.write(line, (error) => { if (error && s.pending.has(wireId)) fail("broken-pipe"); });
      } catch { fail("broken-pipe"); }
    });
  }
  private onData(s: Session, data: Buffer) {
    if (!this.live(s)) return;
    s.buffer = Buffer.concat([s.buffer, data]);
    this.frames(s);
  }
  private frames(s: Session) {
    while (this.live(s) && s.pausedAt === null) {
      const newline = s.buffer.indexOf(10);
      if (newline > MAX_FRAME_BYTES || (newline < 0 && s.buffer.length > MAX_FRAME_BYTES)) { this.terminate(s); return; }
      if (newline < 0) return;
      const line = s.buffer.subarray(0, newline); s.buffer = s.buffer.subarray(newline + 1);
      let raw: unknown;
      try { raw = JSON.parse(line.toString("utf8")); } catch { this.emit({ kind: "malformed", generation: s.generation }); continue; }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { this.emit({ kind: "malformed", generation: s.generation }); continue; }
      const frame = raw as { id?: RpcId; method?: unknown };
      if (Object.hasOwn(frame, "id")) {
        const pending = s.pending.get(frame.id!);
        if (!pending) continue;
        try {
          const response = parseResponse(pending.method, raw, this.options.rpc);
          s.lastFrame = Date.now(); clearTimeout(pending.timer); s.pending.delete(frame.id!); pending.resolve(response);
          if (pending.method === "subscribeReceive" && !s.ready) {
            // Preserve the remainder of this chunk until open() emits ready.
            s.child.stdout.pause(); return;
          }
        } catch { clearTimeout(pending.timer); s.pending.delete(frame.id!); pending.reject(new HostError("invalid-frame")); this.emit({ kind: "malformed", generation: s.generation }); }
      } else if (frame.method !== "receive") this.emit({ kind: "unknown-method", generation: s.generation });
      else {
        const notification = notificationSchema.safeParse(raw);
        if (!notification.success || !Object.hasOwn(frame, "params")) { this.emit({ kind: "malformed", generation: s.generation }); continue; }
        s.lastFrame = Date.now();
        if (s.receiving && !s.ready) {
          // Some children notify before returning the subscription response.
          // Bound this pre-ready queue independently of normal journal pressure.
          if (s.startup.length + line.length + 1 > MAX_FRAME_BYTES) { this.terminate(s); return; }
          s.startup = Buffer.concat([s.startup, line, Buffer.from("\n")]);
        }
        if (s.ready && s.receiving) for (const listener of this.listeners) {
          if (!this.live(s)) break;
          listener({ generation: s.generation, spawnToken: s.spawnToken, notification: notification.data as RpcNotification });
        }
      }
    }
  }
  pauseReading(reason: "storage-slow" | "disk-full" = "storage-slow") {
    const s = this.current;
    if (!s || !this.live(s)) return;
    s.pauseReason = reason;
    if (s.pausedAt !== null) return;
    s.pausedAt = Date.now(); s.child.stdout.pause();
    s.pauseTimer = setTimeout(() => {
      if (this.live(s) && s.pausedAt !== null) this.emit({ kind: "blocked", reason: s.pauseReason, generation: s.generation });
    }, PERIOD); s.pauseTimer.unref?.();
  }
  resumeReading() {
    const s = this.current;
    if (!s || !this.live(s) || s.pausedAt === null) return;
    s.pausedAt = null; s.lastFrame = Date.now(); s.ping = false; s.misses = 0;
    if (s.pauseTimer) clearTimeout(s.pauseTimer);
    this.frames(s);
    if (this.live(s) && s.pausedAt === null) s.child.stdout.resume();
  }
  private tick(s: Session) {
    if (!this.live(s) || s.pausedAt !== null) return;
    if (s.ping) s.misses++;
    if (s.misses >= 3 || Date.now() - s.lastFrame >= 120_000) { this.terminate(s); return; }
    try {
      if (lstatSync(join(this.options.dataDir, "signal/log/signal-cli.log")).size > LOG_RESTART_BYTES
          && !s.pending.size && this.options.isIdle?.()) { s.planned = true; this.terminate(s); return; }
    } catch { this.block("storage-permissions"); this.terminate(s); return; }
    s.ping = true;
    void this.internal(s, "version").then(response => {
      if (!this.live(s) || s.pausedAt !== null) return;
      if (!("result" in response) || (response.result as { version: string }).version !== s.version) { this.block("needs-update"); this.terminate(s); return; }
      s.ping = false; s.misses = 0;
    }).catch(() => { /* The next tick counts the unanswered heartbeat. */ });
  }
  private terminate(s: Session) {
    if (s.closing) return;
    s.closing = true; s.ready = false; s.receiving = false;
    if (s.ticker) clearInterval(s.ticker);
    if (s.pauseTimer) clearTimeout(s.pauseTimer);
    for (const pending of s.pending.values()) { clearTimeout(pending.timer); pending.reject(new HostError("offline")); } s.pending.clear();
    s.killer = setTimeout(() => { s.child.kill("SIGKILL"); }, 5000); s.killer.unref?.();
    s.child.kill("SIGTERM");
  }
  private onExit(s: Session) {
    if (this.current !== s) return;
    if (s.killer) clearTimeout(s.killer);
    if (s.ticker) clearInterval(s.ticker);
    if (s.pauseTimer) clearTimeout(s.pauseTimer);
    s.closing = true;
    for (const pending of s.pending.values()) { clearTimeout(pending.timer); pending.reject(new HostError("offline")); } s.pending.clear();
    s.stderr = Buffer.alloc(0); s.buffer = Buffer.alloc(0);
    this.current = undefined;
    const epoch = this.epoch;
    const exitPreservation:SignalPreservation={progress:"durability",canLink:false,canKeepBoth:false};
    this.exitCheck = (async () => {
      try {
        if (s.fenceFailed) { this.custodyFault=true; this.block("kept-check",s.generation,exitPreservation); return; }
        try { exitSignalChild(new ParkFs(this.options.dataDir,this.options.park),s.fenceToken); }
        catch { s.fenceFailed=true; this.custodyFault=true; this.block("kept-check",s.generation,exitPreservation); return; }
        const verdict = await this.options.storage.check();
        if (epoch !== this.epoch) return;
        if (verdict.state !== "ok") { this.block(verdict.reason, s.generation); return; }
        const restart = !!this.desired && s.epoch === this.epoch;
        const delay = restart ? Math.min(1_800_000, 5000 * 2 ** Math.min(20, s.planned ? 0 : this.failures++)) : null;
        this.emit({ kind: "exited", generation: s.generation, respawnInMs: delay });
        if (delay !== null) {
          this.restartTimer = setTimeout(() => { this.restartTimer = undefined; void this.open(epoch).catch(() => {}); }, delay);
          this.restartTimer.unref?.();
        }
      } catch { if (epoch === this.epoch) this.block("storage-permissions", s.generation); }
    })();
    s.resolveExit();
  }
  async stop(): Promise<void> {
    this.epoch++; this.desired = undefined;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const s = this.current;
    if (s) { this.terminate(s); await s.exited; }
    await this.exitCheck;
    if(this.custodyFault)throw new HostError("kept-check",{progress:"durability",canLink:false,canKeepBoth:false});
  }
}
