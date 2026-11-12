// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { z } from "zod";
import { syncParentDirectory, writeFileAtomic } from "../../atomic.ts";
import { ChannelSendError, DurableDelivery, type ChannelRuns } from "../durable-delivery.ts";
import { parseRequest, parseResponse, type RpcPolicy } from "./rpc.ts";
import { readAccountIdentity, type HostEvent, type HostIdentity, type HostNotification, type HostRequestOptions } from "./process-host.ts";
import { formatSignalRuns, prepareSignalPrompt, SIGNAL_MAX_RESPONSE } from "./transport.ts";
import { isAuthorizedUnlink, type AuthorizedUnlink } from "./unlink.ts";
import { wipeSignalData } from "./wipe.ts";
import { ParkFs,SignalParkError,parkReason,type ParkReason } from "./park-fs.ts";
import { assertSignalQuiescent } from "./park-fence.ts";
import { readControl } from "./park-control.ts";
import { assertSignalLinkAllowed, assertSignalServiceAllowed, type ParkOptions, type KeptAdvisory } from "./park.ts";
import { readSignalFile } from "./park-fs.ts";
import { defaultSecurityRunner, signalStorageRoots } from "./storage.ts";
import { currentUserSid, ownerVerdict, parseDacl } from "../../win-acl.ts";
import type { ChannelState, DeliveryAttempt, ProcessHost, ReviewState, RpcMethod, RpcParams, RpcRequest, RpcResponse,
  ServiceResendResult, SignalPreservation, SignalBinding, SignalEvent, SignalProblem, SignalService as ServiceContract, StorageGuard, StorageVerdict, Transport } from "./types.ts";

import { parseSignalConnectionRecord, type SignalConnectionRecord } from "./connection-record.ts";
export { parseSignalConnectionRecord } from "./connection-record.ts";
type Connection = SignalConnectionRecord;

const WINDOW = 7 * 86400000, BACKOFF = [5000, 30000, 120000, 600000, 1800000];
const time = z.number().int().safe().nonnegative();
const rowSchema = z.strictObject({ key: z.string().regex(/^[a-f0-9]{64}$/), timestamp: time, body: z.string().optional(), expiresAt: time.optional(), expiryMirrored: z.literal(true).optional(),
  state: z.enum(["pending", "forwarded", "dropped", "redacted"]), reason: z.literal("window").optional(),
  failures: z.number().int().min(0).max(5).optional(), retryAt: time.optional(), response: z.string().max(2000).optional(),
});
type Row = z.infer<typeof rowSchema>;
const tombstonesSchema = z.array(z.strictObject({ key: z.string().regex(/^[a-f0-9]{64}$/), timestamp: time, deletedAt: time }));
type Tombstone = z.infer<typeof tombstonesSchema>[number];
export const signalDeliveryId = (aci: string, timestamp: number): string => createHash("sha256").update(aci).update("\0").update(String(timestamp)).digest("hex");
const recipientFor = (aci: string) => `note-to-self:${createHash("sha256").update(aci).digest("hex")}`;

export interface ServiceHost extends ProcessHost {
  readonly spawnToken: symbol | undefined;
  readonly identity: HostIdentity | null;
  request<M extends RpcMethod>(request: RpcRequest<M>, options: HostRequestOptions): Promise<RpcResponse<M>>;
  onNotification(listener: (frame: HostNotification) => void): () => void;
  pauseReading(reason?: "storage-slow" | "disk-full"): void;
}
export interface AccessContext {
  binding: SignalBinding; now: number; isCurrent: boolean;
  isTombstoned: (timestamp: number) => boolean; hasSentTimestamp: (timestamp: number) => boolean;
}
/** B4/G0 supply normalization and authenticated decisions. Absence admits nothing.
 * No raw Signal shape is guessed here. B8 must provide the verified adapter.
 */
export interface SignalAccess {
  parse(raw: unknown): SignalEvent | null;
  decide(event: SignalEvent, context: AccessContext): "accept" | "too-long" | "drop";
  control(event: SignalEvent, context: AccessContext): boolean;
}
/** adapters.ts supplies source-derived link contracts, gated by reviewed G0 evidence.
 * startParams captures the dated device name for finishLink.
 */
export interface SignalLinkProtocol {
  policy: RpcPolicy;
  startParams(input: { deviceName: string; args: readonly ["-n", string] }): unknown;
  readStart(result: unknown): { uri: string; finishParams: unknown };
  /** Exact request minted only from pin-bound, reviewed linked-device proof. */
  unlink?: AuthorizedUnlink;
}
export interface SignalServiceOptions {
  dataDir: string;
  park?: ParkOptions;
  kept?: KeptAdvisory;
  beforeLink?: () => Promise<void>;
  onCustodyHold?: (reason:ParkReason) => void;
  storage: (connectionId: string) => StorageGuard;
  host: (context: { expectedIdentity: () => SignalBinding | null; onEvent: (event: HostEvent) => void; isIdle: () => boolean }) => ServiceHost;
  transport: (context: { binding: SignalBinding; host: ProcessHost; isCurrent: () => boolean }) => Transport & {
    hasSentTimestamp?: (timestamp: number) => boolean; prune?: () => void;
  };
  access?: SignalAccess;
  linkProtocol?: SignalLinkProtocol;
  runs: (context: { binding: SignalBinding; channelOrigin: { platform: "signal"; connectionId: string };
    owner: { platform: "signal"; authorityId: string; userId: string; connectionId: string }; notOwnerAudience: false }) => ChannelRuns;
  /** B8 wires observeVerifiedHuman + the workspace-owner link, and binding:null on revoke. */
  people: { linkOwner(binding: SignalBinding): Promise<void>; revoke(connectionId: string): Promise<void> };
  revokeRuns: (connectionId: string, runIds?: string[]) => Promise<void>;
  wipeData?: (connectionId: string, scope: "auth" | "all") => Promise<void>;
  channelsOpen: () => boolean;
  isCloudHome: () => boolean;
  isCurrentChief: (botId: string) => boolean;
  now?: () => number;
  count?: (reason: string) => void;
}

/** Only reads checked private paths; never follows the final component. */
function read(file: string): string {
  return readSignalFile(file).toString("utf8");
}
function optional(file: string): string | undefined {
  try { return read(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
function save(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, text, { mode: 0o600, syncDir: true });
}

/** B3 checks an existing tree. Bootstrap only empty directories, checking each
 * existing ancestor's owner and link attributes before creating anything below it.
 * B3 then applies and verifies the complete permission boundary before any keys
 * are read or a child is spawned. No ownership transfer is ever attempted.
 */
async function prepareDirectories(dataDir: string, id: string): Promise<StorageVerdict> {
  const root = resolve(dataDir), roots = signalStorageRoots(root, id);
  const paths = [root, join(root, "channels"), join(root, "channels/signal"), ...roots.slice(1), join(root, "signal/ingress")];
  const fail = (path: string, reason: "storage-owner" | "storage-permissions" = "storage-permissions"): StorageVerdict => ({
    state: "blocked", reason, path, scope: path === root ? "data-dir" : "signal",
  });
  const existing: string[] = [], missing: string[] = [];
  for (const path of paths) {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return fail(path);
      if (process.platform !== "win32" && stat.uid !== process.getuid?.() && !(path === root && stat.uid === 0)) return fail(path, "storage-owner");
      existing.push(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && path !== root) missing.push(path); else return fail(path); }
  }
  if (process.platform === "win32") {
    // This fixed-size bootstrap projection has no account-file or RPC shapes.
    // As in B3, all paths travel as JSON data and CLM needs only cmdlets/properties.
    const env = process.env, run = defaultSecurityRunner;
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    if (!win32.isAbsolute(systemRoot)) return fail(root);
    const sid = currentUserSid((file, args) => run(file, args, { env, timeout: 15000 }), env);
    if (!sid) return fail(root);
    try {
      const output = run(win32.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { env: { ...env, MURAGE_SIGNAL_DIRS: JSON.stringify(existing) }, timeout: 15000,
          input: "$ErrorActionPreference = 'Stop'\n@($env:MURAGE_SIGNAL_DIRS | ConvertFrom-Json) | ForEach-Object { $item = Get-Item -LiteralPath $_ -Force; $attributes = [int]$item.Attributes; $sddl = $null; if (($attributes -band 1024) -eq 0) { $sddl = (Get-Acl -LiteralPath $_).Sddl }; @{ attributes = $attributes; sddl = $sddl } | ConvertTo-Json -Compress }\n" });
      const rows = output.trim().split("\n").map(line => z.strictObject({ attributes: z.number().int().nonnegative(), sddl: z.string().nullable() }).parse(JSON.parse(line)));
      if (rows.length !== existing.length) return fail(root);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i], path = existing[i];
        if (row.attributes & 0x400 || !(row.attributes & 16)) return fail(path);
        const owner = ownerVerdict(row.sddl ?? "", sid);
        if (owner !== "ok") return fail(path, owner === "foreign" ? "storage-owner" : "storage-permissions");
        if (path === root) {
          const dacl = parseDacl(row.sddl ?? "");
          if (!dacl || dacl.allow.some(s => ["WD", "BU", "AU", "S-1-1-0", "S-1-5-32-545", "S-1-5-11"].includes(s))) return fail(path);
        }
      }
    } catch { return fail(root); }
  }
  for (const path of missing) {
    try { mkdirSync(path, { mode: 0o700 }); syncParentDirectory(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return fail(path); }
  }
  return { state: "ok" };
}

/** Inert until explicitly started by B8. All state is scoped to the supplied dataDir. */
export class SignalService implements ServiceContract {
  private connection: Connection;
  private readonly file: string;
  private readonly host: ServiceHost;
  private unsubscribe: () => void;
  private checked?: symbol;
  private live = false;
  private lifecycle = 0;
  private problem?: Extract<ChannelState, { state: "blocked" }>;
  private linking?: Extract<ChannelState, { state: "linking" }>;
  private linkingBusy = false;
  private linkAttempt = 0;
  private linkDeadline = 0;
  private cancelLinkWait?: () => void;
  private ledger?: DurableDelivery;
  private transport?: ReturnType<SignalServiceOptions["transport"]>;
  private rows: Row[] = [];
  private tombstones: Tombstone[] = [];
  private incoming: Array<{ row?: Row; deletion?: Tombstone }> = [];
  private pausedAt?: number;
  private pauseReason: "disk-full" | "storage-slow" = "storage-slow";
  private ticker?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private revocation?: Promise<ChannelState>;
  private lastSweep = 0;
  private loaded = false;
  private readonly options: SignalServiceOptions;
  constructor(options: SignalServiceOptions) {
    assertSignalServiceAllowed(options.dataDir,options.park);
    this.options = options;
    this.file = join(options.dataDir, "channels/signal/connection.json");
    const text = optional(this.file);
    this.connection = text === undefined ? { version: 1, connectionId: randomUUID(), generation: 1, enabled: false,
      paused: true, revoking: false, binding: null, account: null } : parseSignalConnectionRecord(JSON.parse(text));
    this.host = options.host({ expectedIdentity: () => this.connection.binding, onEvent: event => this.hostEvent(event),
      isIdle: () => !this.ticking && !this.incoming.length && !this.ledger?.status().pending });
    this.unsubscribe = this.host.onNotification(frame => this.receive(frame));
  }
  private holdCustody(reason:ParkReason,preservation?:SignalPreservation){
    this.live=false;this.checked=undefined;this.ledger?.stop();if(this.ticker)clearInterval(this.ticker);this.ticker=undefined;
    this.problem={state:'blocked',reason:reason==='busy'?'kept-busy':'kept-check',path:join(this.options.dataDir,'recovery-quarantine/signal-parked'),preservation:preservation??{progress:reason==='busy'?'busy':reason==='adoption'?'adoption':reason==='durability'?'durability':'check',canLink:false,canKeepBoth:false}};
    this.options.onCustodyHold?.(reason);
  }
  private assertMutation(){if(this.problem?.preservation?.canLink===false)throw new Error('Signal files are kept');try{assertSignalServiceAllowed(this.options.dataDir,this.options.park);}catch(error){this.holdCustody(parkReason(error));throw error;}}
  private now() { return this.options.now?.() ?? Date.now(); }
  private path(name: string) { return join(this.options.dataDir, "signal/ingress", `${this.connection.connectionId}.${name}`); }
  private ledgerFile() { return join(this.options.dataDir, "channels/signal", this.connection.connectionId, "receipts.json"); }
  private persist(next: Connection) {
    try { save(this.file, JSON.stringify(parseSignalConnectionRecord(next))); this.connection = next; }
    catch (error) {
      // A rename can commit before directory fsync reports failure. Keep the
      // live fence closed and recover from the root that actually reached disk.
      this.live = false; this.checked = undefined; this.ledger?.stop();
      const saved = optional(this.file);
      if (saved !== undefined) this.connection = parseSignalConnectionRecord(JSON.parse(saved));
      throw error;
    }
  }
  private block(reason: SignalProblem) { this.problem = { state: "blocked", reason }; }
  private current(token = this.checked) {
    const c = this.connection, b = c.binding;
    return this.live && !!b && c.enabled && !c.paused && !c.revoking && !!token && token === this.checked && token === this.host.spawnToken
      && this.host.generation === c.generation && !(this.pausedAt !== undefined && this.pauseReason === "disk-full")
      && !this.options.isCloudHome() && this.options.channelsOpen() && this.options.isCurrentChief(b.chiefBotId)
      && !["identity-unavailable", "identity-mismatch", "storage-owner", "storage-permissions", "revoke-recovery-required", "link-required", "needs-update", "disk-full", "storage-slow"].includes(this.problem?.reason ?? "");
  }
  private records(): Array<{ deliveryId: string; state: string; response?: string; error?: string; resendAfter?: number; runId?: string }> {
    const text = optional(this.ledgerFile()); if (!text) return [];
    const root = JSON.parse(text);
    const rows = [...root.records];
    for (const page of root.overflow ?? []) {
      if (!z.uuid().safeParse(page).success) throw new Error("Invalid Signal receipt page");
      rows.push(...JSON.parse(read(`${this.ledgerFile()}.${page}`)).records);
    }
    return rows;
  }
  private reviews(): ReviewState[] {
    if (!this.ledger) return [];
    return this.records().flatMap((r): ReviewState[] => {
      if (r.state === "needs-review") return [{ deliveryId: r.deliveryId, state: "needs-review", reason: "run-receipt-missing", ...(r.runId ? { runId: r.runId } : {}) }];
      if (r.state === "rejected") return [{ deliveryId: r.deliveryId, state: "rejected", reason: "invalid-request", ...(r.response === undefined ? {} : { response: r.response }) }];
      if (r.state !== "uncertain") return [];
      const base = { deliveryId: r.deliveryId, state: "uncertain" as const, response: r.response ?? "", partial: r.error === "partial" };
      return [r.resendAfter !== undefined ? { ...base, reason: "rate-limit", resendAfter: r.resendAfter } : { ...base, reason: "delivery-unknown" }];
    });
  }
  status(): ChannelState {
    const result = this.actualStatus();
    return { ...result, ...(this.options.kept ? { kept: this.options.kept } : {}) };
  }
  private actualStatus(): ChannelState {
    const reviews = this.reviews(), count = reviews.length;
    if (this.problem) return { ...this.problem, reviews, reviewCount: count };
    if (this.linking) return { ...this.linking };
    if (reviews.some(r => r.state === "needs-review")) return { state: "blocked", reason: "reply-lost", reviews, reviewCount: count };
    const binding = this.connection.binding;
    if (!binding) return { state: "not-linked", ...(this.connection.removeDeviceOnPhone ? { removeDeviceOnPhone: true } : {}) };
    return { state: "linked", binding: { ...binding }, maskedNumber: `•••${this.connection.account?.slice(-4) ?? ""}`,
      reviews, reviewCount: count, ...(this.connection.repairedStorageOwner ? { repairedStorageOwner: true } : {}) };
  }
  async start(input: { restored?: boolean } = {}): Promise<ChannelState> {
    if(this.problem?.preservation?.canLink===false)return this.status();
    if ((input.restored || this.connection.restoring) && !this.connection.revoking) {
      // The marker survives a crash while old human/run bindings are revoked.
      // Receipts remain available for review, but their connection can never send.
      this.persist({ ...this.connection, restoring: true });
      return this.revoke(false);
    }
    if (this.connection.revoking) return this.finishRevocation();
    if (this.options.isCloudHome() || !this.options.channelsOpen()) return this.status();
    if (this.connection.problem) { this.block(this.connection.problem); return this.status(); }
    if (!this.connection.binding || !this.connection.enabled) return this.status();
    const generation = this.connection.generation, lifecycle = ++this.lifecycle;
    try {
      if (!await this.checkStorage() || this.connection.generation !== generation || lifecycle !== this.lifecycle) return this.status();
      this.loadJournal(); await this.options.people.linkOwner(this.connection.binding);
      if (this.connection.generation !== generation || this.connection.revoking || lifecycle !== this.lifecycle) return this.status();
      this.live = true; await this.host.spawn({ generation, account: this.connection.account });
      if (lifecycle !== this.lifecycle) return this.status();
      this.arm();
      await this.tick();
    } catch (error) { if (lifecycle === this.lifecycle) await this.startFailed(error, generation); }
    return this.status();
  }
  private async checkStorage(repair = false) {
    const prepared = await prepareDirectories(this.options.dataDir, this.connection.connectionId);
    const guard = this.options.storage(this.connection.connectionId);
    const verdict = prepared.state === "ok" ? await (repair ? guard.repair() : guard.check()) : prepared;
    if (verdict.state === "ok") return true;
    this.problem = verdict;
    if (verdict.reason === "storage-owner" && verdict.scope !== "data-dir") this.persist({ ...this.connection, problem: "storage-owner" });
    return false;
  }
  private async startFailed(error: unknown, generation: number) {
    if (generation !== this.connection.generation || this.connection.revoking) return;
    this.live = false; this.checked = undefined; this.ledger?.stop();
    const code = (error as { code?: string })?.code;
    if(error instanceof SignalParkError||(error as {preservation?:SignalPreservation}).preservation||code==="kept-check"||code==="kept-busy"){this.holdCustody(error instanceof SignalParkError?error.reason:code==="kept-busy"?"busy":((error as {preservation?:SignalPreservation}).preservation?.progress==="adoption"?"adoption":"conflict"),(error as {preservation?:SignalPreservation}).preservation);return;}
    const reason = code === "identity-unavailable" || code === "identity-mismatch" || code === "needs-update" ? code : this.problem?.reason ?? "link-required";
    this.block(reason);
    if (reason === "identity-unavailable") {
      this.persist({ ...this.connection, problem: reason });
      await this.stopHost();
      if (generation === this.connection.generation && !this.connection.revoking) await this.wipe("auth");
    }
  }
  private hostEvent(event: HostEvent) {
    if (event.generation !== this.connection.generation || this.connection.revoking || !this.live) return;
    if (event.kind === "ready" && event.identity) {
      const binding = this.connection.binding;
      if (!binding || event.identity.ownAci !== binding.ownAci || event.identity.ownDeviceId !== binding.ownDeviceId) {
        this.checked = undefined; this.ledger?.stop(); this.block("identity-mismatch");
        this.persist({ ...this.connection, problem: "identity-mismatch" }); return;
      }
      this.checked = event.spawnToken;
      try { this.openLedger(binding, event.spawnToken); } catch { this.checked = undefined; this.block("ledger-write-failed"); }
    } else if (event.kind === "blocked") {
      this.checked = undefined; this.ledger?.stop(); this.block(event.reason);
      if(!event.preservation&&(event.reason==='kept-check'||event.reason==='kept-busy')){this.holdCustody(event.reason==='kept-busy'?'busy':'conflict');return;}
      if(event.preservation){this.holdCustody(event.preservation.progress==="busy"?"busy":event.preservation.progress==="adoption"?"adoption":event.preservation.progress==="durability"?"durability":"conflict",event.preservation);return;}
      if (event.reason === "identity-unavailable") void this.startFailed({ code: event.reason }, event.generation).catch(() => this.block("revoke-recovery-required"));
      if (event.reason === "storage-owner") this.persist({ ...this.connection, problem: "storage-owner" });
      if (event.reason === "link-required") void this.linkRequired().catch(() => this.block("revoke-recovery-required"));
    } else if (event.kind === "exited") { this.checked = undefined; this.ledger?.stop(); }
  }
  private openLedger(binding: SignalBinding, token: symbol) {
    this.ledger?.stop();
    const current = () => this.current(token), host = this.host;
    // Capture this child's token now. B6's B0 request interface cannot carry it.
    const fencedHost: ProcessHost = {
      get generation() { return host.generation; }, spawn: input => host.spawn(input), stop: () => host.stop(),
      request: (request, options) => host.request(request, { ...options, spawnToken: token }),
      onNotification: listener => host.onNotification(listener), pauseReading: () => host.pauseReading(), resumeReading: () => host.resumeReading(),
    };
    const transport = this.transport = this.options.transport({ binding, host: fencedHost, isCurrent: current });
    const recipient = recipientFor(binding.ownAci);
    const runs = formatSignalRuns(this.options.runs({ binding, channelOrigin: { platform: "signal", connectionId: binding.connectionId },
      owner: { platform: "signal", authorityId: binding.ownAci, userId: binding.ownAci, connectionId: binding.connectionId }, notOwnerAudience: false }));
    const ledger = new DurableDelivery({ file: this.ledgerFile(), bindingKey: binding.connectionId, recipient, runs,
      now: this.options.now, isCurrent: current, maxResponse: SIGNAL_MAX_RESPONSE, noticeAtMostOnce: true,
      reserve: input => transport.reserve(input as DeliveryAttempt & { text: string }),
      send: async input => {
        if (!current()) throw new ChannelSendError("offline", false);
        try {
          const result = await transport.sendNoteToSelf({ ...input, isRedacted: () => !current() || this.deliveryRedacted(input.deliveryId) } as Parameters<Transport["sendNoteToSelf"]>[0]);
          return { recipient, messageId: String(result.timestamps.at(-1) ?? "") };
        } finally {
          // Even a failed final chunk may settle after its source has expired.
          if (current()) this.deliveryRedacted(input.deliveryId);
        }
      },
    });
    this.ledger = ledger; this.lastSweep = 0;
    ledger.recoverExpiry(this.rows.map(row => ({ deliveryId: row.key, expiresAt: row.expiresAt })));
    this.mirrorExpiries(true);
  }
  /** Ledger durability precedes the flag; a crash between these writes replays safely. */
  private mirrorExpiries(verifyCoverage = false) {
    let changed = false;
    const rows = this.rows.map(row => {
      if (row.expiresAt === undefined || (row.expiryMirrored && !verifyCoverage)) return row;
      if (!this.ledger!.setExpiry(row.key, row.expiresAt)) {
        if (row.state === "forwarded") throw new Error("Signal expiry coverage is missing");
        return row; // Not admitted yet; the journal remains authoritative.
      }
      if (row.expiryMirrored) return row;
      changed = true; return { ...row, expiryMirrored: true as const };
    });
    if (changed) this.rewrite(rows);
  }
  private loadJournal() {
    const text = optional(this.path("ndjson")) ?? "", lines = text.split("\n");
    // Only a final unterminated append may be discarded. Earlier damage fails closed.
    const torn = !!text && !text.endsWith("\n");
    if (torn) lines.pop();
    this.rows = lines.filter(Boolean).map(line => rowSchema.parse(JSON.parse(line)));
    this.tombstones = tombstonesSchema.parse(JSON.parse(optional(this.path("tombstones.json")) ?? "[]"));
    if (torn) this.rewrite();
    this.loaded = true;
  }
  private rewrite(rows = this.rows) { save(this.path("ndjson"), rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "")); this.rows = rows; }
  private sweepJournalTemps() {
    const directory = dirname(this.path("ndjson")), id = this.connection.connectionId;
    try {
      for (const name of readdirSync(directory)) {
        if (!name.endsWith(".tmp") || ![`${id}.ndjson.`, `${id}.tombstones.json.`].some(prefix => name.startsWith(prefix))) continue;
        try { unlinkSync(join(directory, name)); } catch { this.options.count?.("journal-sweep-failed"); }
      }
      syncParentDirectory(this.path("ndjson"));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.count?.("journal-sweep-failed"); }
  }
  private receive(frame: HostNotification) {
    const binding = this.connection.binding, access = this.options.access;
    if (!binding || !access || frame.generation !== binding.generation || frame.spawnToken !== this.checked || !this.current()) return;
    let event: SignalEvent | null;
    try { event = access.parse(frame.notification.params); } catch { this.options.count?.("malformed"); return; }
    if (!event) { this.options.count?.("malformed"); return; }
    const key = signalDeliveryId(binding.ownAci, event.timestamp);
    const tombstoned = (timestamp: number) => this.tombstones.some(t => t.key === signalDeliveryId(binding.ownAci, timestamp))
      || this.incoming.some(i => i.deletion?.key === signalDeliveryId(binding.ownAci, timestamp));
    const context: AccessContext = { binding, now: this.now(), isCurrent: this.current(), isTombstoned: tombstoned,
      hasSentTimestamp: timestamp => this.transport?.hasSentTimestamp?.(timestamp) ?? false };
    if (event.variant === "sync-control") {
      if (!access.control(event, context)) return;
      if (event.control.kind === "timer") return; // Each note carries its own immutable deadline.
      const timestamp = event.control.target;
      if (timestamp < binding.linkedAt - 300000 || timestamp > this.now() + 300000) return;
      this.incoming.push({ deletion: { key: signalDeliveryId(binding.ownAci, timestamp), timestamp, deletedAt: this.now() } });
      // A running drain may be awaiting chunk one. Persist and redact now so
      // B6's synchronous cancellation fence refuses every later chunk.
      if (this.flush()) void this.controls().catch(() => { this.pause("disk-full"); });
    } else {
      if (event.variant !== "sync-sent" || tombstoned(event.timestamp)) return;
      const decision = access.decide(event, context); if (decision === "drop") return;
      // The first admitted note owns its timer. Redelivery cannot change it.
      if (this.rows.some(row => row.key === key) || this.incoming.some(i => i.row?.key === key) || this.ledger?.has(key)) return;
      const prompt = event.body === null ? null : prepareSignalPrompt(event.body);
      const tooLong = decision === "too-long" || prompt === null || event.longText;
      if (!tooLong && !event.body?.trim()) return;
      this.incoming.push({ row: { key, timestamp: event.timestamp, state: "pending",
        ...(tooLong ? { response: "That note is too long for me to read here. Send it in shorter parts, or paste it in Murage." } : { body: event.body! }),
        ...(event.expiresInSeconds ? { expiresAt: event.timestamp + event.expiresInSeconds * 1000 } : {}) } });
    }
    if (this.incoming.length >= 50) this.pause("storage-slow");
  }
  private pause(reason: "disk-full" | "storage-slow") {
    this.pausedAt ??= this.now(); this.pauseReason = reason; this.host.pauseReading(reason);
  }
  private flush() {
    while (this.incoming.length) {
      const next = this.incoming[0];
      try {
        if (next.deletion) {
          const tombstones = [...this.tombstones.filter(t => t.key !== next.deletion!.key), next.deletion];
          save(this.path("tombstones.json"), JSON.stringify(tombstones)); this.tombstones = tombstones;
        } else if (next.row) {
          // Append fsync precedes ledger admission. A failed append stays queued.
          // Rewrite from the known durable rows on retry to remove a torn tail.
          if (this.pausedAt !== undefined && this.pauseReason === "disk-full") this.rewrite();
          const file = this.path("ndjson"); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
          try { writeFileSync(fd, JSON.stringify(next.row) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
          syncParentDirectory(file); this.rows.push(next.row);
        }
        this.incoming.shift();
      } catch { this.pause("disk-full"); return false; }
    }
    if (this.pausedAt !== undefined) { this.pausedAt = undefined; this.host.resumeReading(); }
    return true;
  }
  /** Intent is already durable. Redact ledger before rewriting the journal so
   * a crash at either boundary is replayable, with exact run cancellation.
   */
  private redactControls() {
    const ledger = this.ledger!, token = this.checked, now = this.now();
    const cancellations: Promise<void>[] = [];
    const deleted = new Set([...this.tombstones.map(t => t.key), ...ledger.expiredSourceIds(), ...ledger.unknownExpirySourceIds()]);
    for (const row of this.rows) if (row.expiresAt !== undefined && row.expiresAt <= now) deleted.add(row.key);
    for (const key of deleted) {
      const result = ledger.redact(key);
      const runIds = [...(result?.runId ? [result.runId] : []), ...(result?.descendantRunIds ?? [])];
      if (runIds.length) cancellations.push(this.options.revokeRuns(this.connection.connectionId, runIds));
      if (!this.current(token)) break;
    }
    return { deleted, cancellations };
  }
  /** Called inside every synchronous transport write fence, including resends. */
  private deliveryRedacted(deliveryId: string): boolean {
    try {
      const { cancellations } = this.redactControls();
      void Promise.all(cancellations).catch(() => this.pause("disk-full"));
      return this.ledger!.isRedacted(deliveryId);
    } catch { this.pause("disk-full"); return true; }
  }
  private async controls() {
    const ledger = this.ledger!, token = this.checked, now = this.now();
    this.mirrorExpiries();
    const { deleted, cancellations } = this.redactControls();
    if (!this.current(token)) return false;
    if (this.rows.some(row => deleted.has(row.key) && (row.body !== undefined || row.response !== undefined || row.state !== "redacted"))) {
      this.rewrite(this.rows.map(row => {
        if (!deleted.has(row.key)) return row;
        const { body: _body, response: _response, ...rest } = row; return { ...rest, state: "redacted" as const };
      }));
    }
    if (now - this.lastSweep >= 60000) {
      if (ledger.sweepPages().failed) this.options.count?.("page-sweep-failed");
      this.sweepJournalTemps();
      this.transport?.prune?.();
      // Never prune a pending note or a future deadline the ledger does not hold.
      const rows = this.rows.filter(row => row.state === "pending" || row.timestamp >= now - WINDOW
        || (row.expiresAt !== undefined && row.expiresAt > now && !row.expiryMirrored));
      if (rows.length !== this.rows.length) this.rewrite(rows);
      const tombstones = this.tombstones.filter(t => t.deletedAt >= now - WINDOW);
      if (tombstones.length !== this.tombstones.length) { save(this.path("tombstones.json"), JSON.stringify(tombstones)); this.tombstones = tombstones; }
      this.lastSweep = now;
    }
    await Promise.all(cancellations);
    return this.current(token);
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.work().finally(() => { this.ticking = undefined; }); return this.ticking;
  }
  private async work() {
    if (this.pausedAt !== undefined && this.now() - this.pausedAt >= 30000) { this.block(this.pauseReason); return; }
    if (!this.current() || !this.ledger || !this.loaded) return;
    const ledger = this.ledger, token = this.checked;
    try {
      if (!this.flush() || !await this.controls() || !this.current(token)) return;
      for (const row of this.rows) {
        if (!this.current(token)) return;
        if (row.state !== "pending" || (row.failures ?? 0) >= 5 || (row.retryAt ?? 0) > this.now()) continue;
        const capacity = ledger.admissionCapacity();
        if (!ledger.has(row.key) && (capacity.records >= 190 || capacity.tombstones >= 10000)) break;
        try {
          ledger.accept({ deliveryId: row.key, occurredAt: row.timestamp, expiryKnown: true,
            ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }), prompt: row.body === undefined ? "" : prepareSignalPrompt(row.body)!,
            ...(row.response === undefined ? {} : { response: row.response }) });
          const expiryMirrored = row.expiresAt !== undefined && ledger.setExpiry(row.key, row.expiresAt);
          this.rewrite(this.rows.map(r => r === row ? { ...r, state: "forwarded", failures: 0, retryAt: 0,
            ...(expiryMirrored ? { expiryMirrored: true as const } : {}) } : r));
        } catch (error) {
          if (error instanceof Error && error.message === "Channel event is outside the admission window") {
            this.rewrite(this.rows.map(r => r.key === row.key ? { ...r, state: "dropped", reason: "window" } : r)); this.options.count?.("window");
          } else {
            const failures = Math.min(5, (row.failures ?? 0) + 1);
            this.rewrite(this.rows.map(r => r.key === row.key ? { ...r, failures, retryAt: this.now() + BACKOFF[failures - 1] } : r));
            this.block(failures === 5 ? "notes-stuck" : "ledger-write-failed");
            this.problem!.noteCount = this.rows.filter(r => r.state === "pending").length; break;
          }
        }
      }
      if (!this.rows.some(r => r.state === "pending" && (r.failures ?? 0) > 0)
        && ["ledger-write-failed", "notes-stuck"].includes(this.problem?.reason ?? "")) this.problem = undefined;
      if (this.current(token)) await ledger.drain();
    } catch { this.block("ledger-write-failed"); }
  }
  private arm() {
    if (!this.ticker) { this.ticker = setInterval(() => { void this.tick(); }, 1000); this.ticker.unref?.(); }
  }
  async retryNotes(): Promise<void> {
    this.assertMutation();
    if (!this.checked && this.problem?.reason === "ledger-write-failed") { await this.start(); return; }
    if (!this.loaded || this.connection.revoking) return;
    this.rewrite(this.rows.map(row => row.state === "pending" ? { ...row, failures: 0, retryAt: 0 } : row));
    if (["notes-stuck", "ledger-write-failed"].includes(this.problem?.reason ?? "")) this.problem = undefined;
    await this.tick();
  }
  async resend(deliveryId: string): Promise<ServiceResendResult> {
    this.assertMutation();
    if (!this.ledger || !this.current()) return "not-resendable";
    try { if (!await this.controls()) return "not-resendable"; }
    catch { this.block("ledger-write-failed"); return "not-resendable"; }
    const row = this.records().find(r => r.deliveryId === deliveryId);
    if (!row || row.state === "cancelled") return this.ledger.has(deliveryId) ? "already" : "not-resendable";
    if (row.state !== "uncertain" || !row.response) return "not-resendable";
    if ((row.resendAfter ?? 0) > this.now()) return "too-early";
    try { return this.ledger.resend(deliveryId); }
    catch (error) {
      // Reopen after any uncertain root commit before another drain can run.
      this.ledger.stop(); this.checked = undefined; this.block("ledger-write-failed"); throw error;
    }
  }
  async settle(deliveryId: string): Promise<void> {
    this.assertMutation();
    if (this.ledger && this.reviews().some(r => r.deliveryId === deliveryId)) this.ledger.settle(deliveryId);
  }
  private async rpc<M extends RpcMethod>(method: M, params: RpcParams[M], token: symbol, generation = this.connection.generation) {
    const policy = this.options.linkProtocol?.policy;
    const request = parseRequest({ jsonrpc: "2.0", id: randomUUID(), method, params }, policy) as RpcRequest<M>;
    const response = parseResponse(method, await this.host.request(request, { generation, spawnToken: token }), policy);
    if (response.error) throw new Error("Signal request refused"); return response.result;
  }
  async link(input: { chiefBotId: string; removedDeviceOnPhone?: boolean }): Promise<ChannelState> {
    this.assertMutation();
    try{await this.options.beforeLink?.();assertSignalLinkAllowed(this.options.dataDir,this.options.park);}catch(error){this.holdCustody(parkReason(error));throw error;}
    if (this.options.isCloudHome() || !this.options.channelsOpen() || !this.options.isCurrentChief(input.chiefBotId)) return this.status();
    if (this.linkingBusy || this.linking) return this.status();
    if (this.problem?.scope === "data-dir") return this.status();
    if (this.connection.problem === "storage-owner" || this.connection.ownerRepair || this.problem?.reason === "storage-owner") {
      if (!input.removedDeviceOnPhone) return this.status();
      await this.revoke(true); if (this.connection.revoking) return this.status();
    } else if (this.connection.revoking) { await this.finishRevocation(); if (this.connection.revoking) return this.status(); }
    else if (this.connection.binding) { await this.disconnect(); if (this.connection.revoking) return this.status(); }
    const protocol = this.options.linkProtocol;
    if (!protocol?.policy.contracts?.startLink || !protocol.policy.contracts.finishLink) { this.block("needs-update"); return this.status(); }
    this.linkingBusy = true; this.lifecycle++; const generation = this.connection.generation, attempt = ++this.linkAttempt;
    this.linkDeadline ||= this.now() + 600000;
    try {
      const io=new ParkFs(this.options.dataDir,this.options.park);assertSignalQuiescent(io,readControl(io),this.options.park?.fence);
      if (!await this.checkStorage() || generation !== this.connection.generation || attempt !== this.linkAttempt) return this.status();
      if(optional(this.file)===undefined)this.persist(this.connection);
      this.problem = undefined; this.live = true;
      await this.host.spawn({ generation, account: null });
      const token = this.host.spawnToken;
      if (!token || generation !== this.connection.generation || attempt !== this.linkAttempt) return this.status();
      const deviceName = `Murage (${new Date(this.now()).toISOString().slice(0, 10)})`;
      const start = protocol.readStart(await this.rpc("startLink", protocol.startParams({ deviceName, args: ["-n", deviceName] }), token));
      if (generation !== this.connection.generation || this.connection.revoking || attempt !== this.linkAttempt) return this.status();
      this.linking = { state: "linking", uri: start.uri, expiresAt: this.now() + 60000 };
      void this.completeLink(start.finishParams, input.chiefBotId, generation, token, attempt)
        .catch(() => { if (attempt === this.linkAttempt) this.block("revoke-recovery-required"); });
    } catch (error) { if (attempt === this.linkAttempt) { this.linkDeadline = 0; await this.startFailed(error, generation); } }
    finally { this.linkingBusy = false; }
    return this.status();
  }
  private async completeLink(params: unknown, chiefBotId: string, generation: number, token: symbol, attempt: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const outcome = await Promise.race([
        this.rpc("finishLink", params, token, generation).then(() => "finished" as const),
        new Promise<"refresh" | "cancel">(resolve => {
          timer = setTimeout(() => resolve("refresh"), 60000); timer.unref?.();
          this.cancelLinkWait = cancel = () => resolve("cancel");
        }),
      ]);
      if (outcome === "cancel" || attempt !== this.linkAttempt || generation !== this.connection.generation || this.connection.revoking || !this.live) return;
      // Finish linking's writer must exit before reading accounts.json and deviceId.
      await this.stopHost();
      if (attempt !== this.linkAttempt || generation !== this.connection.generation || !this.live) return;
      if (outcome === "refresh") {
        this.linking = undefined;
        if (this.now() < this.linkDeadline) await this.link({ chiefBotId });
        else { this.linkDeadline = 0; this.live = false; this.block("link-required"); }
        return;
      }
      if (!await this.checkStorage() || generation !== this.connection.generation || attempt !== this.linkAttempt) return;
      const identity = readAccountIdentity(this.options.dataDir);
      const binding: SignalBinding = { connectionId: this.connection.connectionId, generation, ownAci: identity.ownAci,
        ownDeviceId: identity.ownDeviceId, linkedAt: this.now(), chiefBotId };
      await this.options.people.linkOwner(binding);
      if (generation !== this.connection.generation || this.connection.revoking || attempt !== this.linkAttempt) return;
      this.persist({ ...this.connection, binding, account: identity.number, enabled: true, paused: false, problem: undefined });
      this.linking = undefined; this.linkDeadline = 0; await this.start();
    } catch (error) {
      if (generation === this.connection.generation && attempt === this.linkAttempt) {
        this.linking = undefined; this.linkDeadline = 0; await this.startFailed(error, generation);
      }
    } finally { if (timer) clearTimeout(timer); if (this.cancelLinkWait === cancel) this.cancelLinkWait = undefined; }
  }
  private async stopHost(){
    try{await this.host.stop();}catch(error){
      const preservation=(error as {preservation?:SignalPreservation}).preservation;
      if(preservation)this.holdCustody(preservation.progress==='durability'?'durability':'conflict',preservation);
      throw error;
    }
  }
  private wipe(scope: "auth" | "all") { return this.options.wipeData?.(this.connection.connectionId, scope) ?? wipeSignalData(this.options.dataDir, this.connection.connectionId, scope); }
  disconnect(): Promise<ChannelState> { this.assertMutation(); return this.revoke(false); }
  /** Called for a verified provider removal/lapse; no inference from message silence. */
  async linkRequired(): Promise<ChannelState> {
    await this.revoke(false);
    if (!this.connection.revoking) {
      this.persist({ ...this.connection, problem: "link-required" }); this.block("link-required");
    }
    return this.status();
  }
  finishRevocation(): Promise<ChannelState> { this.assertMutation(); return this.revoke(this.connection.ownerRepair === true); }
  private revoke(ownerRepair: boolean): Promise<ChannelState> {
    if (this.revocation) return this.revocation;
    this.revocation = this.revokeWork(ownerRepair).finally(() => { this.revocation = undefined; }); return this.revocation;
  }
  private async revokeWork(ownerRepair: boolean): Promise<ChannelState> {
    const oldGeneration = this.connection.generation;
    const unlink = this.options.linkProtocol?.unlink;
    const deviceId = this.connection.binding?.ownDeviceId;
    const token = this.host.spawnToken;
    const canUnlink = !ownerRepair && !this.connection.revoking && this.live && deviceId !== undefined
      && this.host.identity?.ownDeviceId === deviceId && this.host.identity?.ownAci === this.connection.binding?.ownAci
      && isAuthorizedUnlink(unlink, deviceId);
    let removeDeviceOnPhone = true;
    this.lifecycle++;
    this.linkAttempt++; this.cancelLinkWait?.(); this.linkDeadline = 0;
    this.live = false; this.checked = undefined; this.linking = undefined;
    if (this.ticker) clearInterval(this.ticker); this.ticker = undefined;
    try {
      if (!this.connection.revoking) this.persist({ ...this.connection, generation: oldGeneration + 1,
        binding: this.connection.binding ? { ...this.connection.binding, generation: oldGeneration + 1 } : null,
        revoking: true, enabled: false, paused: true, ownerRepair, removeDeviceOnPhone: true });
      await revokeSignalLocalAuthority(this.options,this.connection.connectionId);
      if (!this.ledger && this.connection.binding && optional(this.ledgerFile())) {
        // Recovery never constructs a transport or starts a child to revoke receipts.
        this.ledger = new DurableDelivery({ file: this.ledgerFile(), bindingKey: this.connection.connectionId,
          recipient: recipientFor(this.connection.binding.ownAci), maxResponse: SIGNAL_MAX_RESPONSE, isCurrent: () => false,
          runs: { enqueue: () => { throw new Error("Signal is disconnecting"); }, result: () => null },
          send: async () => { throw new ChannelSendError("offline", false); }, now: this.options.now });
      }
      this.ledger?.revoke();
      // Revoke local authority first. A failed/unproved remote unlink never
      // prevents local stop/wipe and never removes the phone-removal reminder.
      if (canUnlink && unlink && token) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.rpc(unlink.method, unlink.params, token, oldGeneration),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Unlink unconfirmed")), 5000); }),
          ]);
          removeDeviceOnPhone = false;
        } catch { /* Keep S7 phone-removal copy; never log provider errors. */ }
        finally { if (timer) clearTimeout(timer); }
      }
      await this.stopHost();
      const restoring = this.connection.restoring;
      await this.wipe(restoring ? "auth" : "all");
      this.persist({ version: 1, connectionId: randomUUID(), generation: this.connection.generation, binding: null, account: null,
        enabled: false, paused: true, revoking: false, removeDeviceOnPhone,
        ...(restoring ? { problem: "link-required" as const } : {}),
        ...(ownerRepair ? { repairedStorageOwner: true } : {}) });
      this.ledger = undefined; this.transport = undefined; this.rows = []; this.tombstones = []; this.incoming = []; this.loaded = false;
      this.problem = restoring ? { state: "blocked", reason: "link-required" } : undefined;
      this.pausedAt = undefined;
    } catch { if(!this.problem?.preservation){this.block("revoke-recovery-required"); this.problem!.path = join(this.options.dataDir, "signal");} }
    return this.status();
  }
  async fixPermissions(): Promise<ChannelState> {
    this.assertMutation();
    if (this.connection.revoking) return this.finishRevocation();
    if (this.connection.problem === "storage-owner") return this.status();
    if (await this.checkStorage(true)) {
      if (this.loaded && !this.flush()) return this.status();
      this.problem = undefined; return this.start();
    }
    return this.status();
  }
  async stop(): Promise<void> {
    this.lifecycle++;
    this.linkAttempt++; this.cancelLinkWait?.(); this.linkDeadline = 0; this.linking = undefined;
    this.live = false; this.checked = undefined; this.ledger?.stop();
    if (this.ticker) clearInterval(this.ticker); this.ticker = undefined;
    this.unsubscribe(); await this.stopHost();
  }
}

/** Local authority phase shared with preservation; never wipes or revokes receipts. */
export async function revokeSignalLocalAuthority(options: {people: Pick<SignalServiceOptions["people"],"revoke">;revokeRuns: SignalServiceOptions["revokeRuns"]}, id: string, runIds?: string[]) {
  await options.people.revoke(id);
  await options.revokeRuns(id,runIds);
}
