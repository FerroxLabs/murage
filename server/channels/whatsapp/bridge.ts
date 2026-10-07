// Copyright 2026 Ferrox Labs
// Socket handling, reconnect, watchdog and serialized send queue adapted from Hermes Agent
// scripts/whatsapp-bridge/bridge.js (MIT, Nous Research) and OpenClaw extensions/whatsapp/src
// (connection-controller.ts, session.ts, inbound/durable-receive.ts, outbound-retry.ts; MIT, OpenClaw Foundation).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The WhatsApp bridge: the child process that owns the Baileys socket (design 1, 2, 4, 5.5, 5.6, 6).
// It is forked by bridge-host.ts with ELECTRON_RUN_AS_NODE, receives the auth key over IPC, and keeps
// three things on disk that the server never writes: the encrypted auth state, the ingress journal
// (every received message is on disk before anything else happens to it) and the outbound journal
// (every outbound id is on disk before the network send, so an echo can never become an owner turn).
//
// Everything is written against `BaileysLib`, an injected view of the package, so tests drive the whole
// engine with a fake socket. Only the entry at the bottom imports the real "baileys" (dynamically, so the
// bundle keeps it external and tests never load it). This file imports nothing that resolves paths relative
// to itself (the server/proxy-paths.ts anchor rule): every path arrives in `init`. It also uses only
// erasable TypeScript syntax (no parameter properties, no enums), because dev runs it with
// --experimental-strip-types.
import { createHash } from "node:crypto";
import { constants as fsConstants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { AuthStoreError, bufferJSON, parseAuthKey, useEncryptedAuthState, wipeAuthDir, writeFileAtomic, type EncryptedAuthState } from "./core/auth-store.ts";
import { CHUNK_DELAY_MS, chunkMessage, classifySendError, MAX_CHUNK_CHARS, minimalQuoted, SEND_TIMEOUT_MESSAGE, SEND_TIMEOUT_MS, sendRetryDelay, sendWithPresence } from "./core/chunk.ts";
import {
  createReconnectScheduler, createVersionResolver, decideClose, nextReconnect, RESTART_DELAY_MS, watchdogShouldRestart, WATCHDOG_FRAME_TIMEOUT_MS,
  type BlockedReason, type CloseDecision, type LinkState,
} from "./core/close-decision.ts";
import { containedMediaFile, createMediaDirectory, mediaDirectory } from "./media.ts";
import { decide } from "./core/access.ts";
import { envelopeOf } from "./core/content.ts";
import { parseOutboundJournal, createEchoLedger, SENT_RING_MAX, type EchoLedger, type ReservedRecord } from "./core/echo.ts";
import { formatForWhatsApp } from "./core/format.ts";
import { compactJournal, foldJournal, journalKey, JOURNAL_COMPACT_BYTES, JOURNAL_REPLAY_BATCH, JOURNAL_RESEND_MS, parseJournal, type JournalRow } from "./core/journal.ts";
import { canonicalJid, jidKind, stripDevice } from "./core/lid.ts";
import { MAX_PENDING_INBOUND, parseHostMessage, PROTOCOL_VERSION, type ChildMessage, type HostMessage, type InboundEnvelope, type QuoteRef, type SendErrorWire } from "./core/protocol.ts";

// ---------------------------------------------------------------------------------------------
// The slice of Baileys this bridge uses.
// ---------------------------------------------------------------------------------------------

export interface Emitter {
  on(event: string, listener: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface SocketLike {
  ev: Emitter;
  /** Raw WebSocket; its `frame` event drives the watchdog. */
  ws?: Emitter;
  user?: { id: string; lid?: string } | null;
  sendMessage(jid: string, content: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  sendPresenceUpdate(state: string, jid?: string): Promise<unknown>;
  readMessages(keys: Array<{ remoteJid: string; id: string; participant?: string }>): Promise<unknown>;
  requestPairingCode(phone: string): Promise<string>;
  groupFetchAllParticipating(): Promise<Record<string, { id: string; subject?: string; participants?: unknown[] }>>;
  logout(msg?: string): Promise<void>;
  end(error?: Error): void;
  updateMediaMessage?: (message: unknown) => Promise<unknown>;
  signalRepository?: { lidMapping?: { getPNForLID(lid: string): Promise<string | null | undefined>; getLIDForPN(pn: string): Promise<string | null | undefined> } };
}

export type MediaStream = AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void };

export interface BaileysLib {
  qualify?: () => Promise<{ baileysVersion: string; jimp: boolean }>;
  makeWASocket(config: Record<string, unknown>): SocketLike;
  initAuthCreds(): Record<string, unknown>;
  generateMessageIDV2(userId?: string): string;
  fetchLatestBaileysVersion(): Promise<{ version: [number, number, number] }>;
  downloadMediaMessage(message: unknown, type: "stream", options: Record<string, unknown>, context: Record<string, unknown>): Promise<MediaStream>;
  makeCacheableSignalKeyStore?(keys: unknown, logger: unknown): unknown;
  proto?: { Message?: { AppStateSyncKeyData?: { fromObject(value: unknown): unknown } } };
}

export const VERSION_FETCH_TIMEOUT_MS = 15_000;
export const LAST_SEEN_INTERVAL_MS = 5 * 60_000;
export const WATCHDOG_CHECK_MS = 60_000;
export const LOGOUT_DEADLINE_MS = 10_000;
export const AUDIO_CLIP_MAX_BYTES = 4 * 1024 * 1024;
export const MEDIA_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const MEDIA_CONNECTION_MAX_BYTES = 200 * 1024 * 1024;
export const MEDIA_SWEEP_MS = 7 * 24 * 60 * 60_000;
export const OUTBOUND_FILE_MAX_BYTES = 4 * 1024 * 1024;

const noop = (): void => undefined;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A pino-shaped logger that says nothing: the bridge's stdio is closed and no QR, key or message text may reach a log. */
export const silentLogger: Record<string, unknown> = {
  level: "silent",
  child() { return silentLogger; },
  trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
};

export interface BridgeDeps {
  lib: BaileysLib;
  send: (message: ChildMessage) => void;
  /** An unrecoverable fault (the auth state could not be saved). The entry exits non-zero and the host respawns. */
  onFatal?: (message: string) => void;
  now?: () => number;
  random?: () => number;
}

const chatKeyOf = (jid: string): string => createHash("sha256").update(canonicalJid(jid) || jid).digest("hex").slice(0, 24);
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

// ---------------------------------------------------------------------------------------------
// Ingress journal (design 3.4, 5.5)
// ---------------------------------------------------------------------------------------------

export interface IngressPayload { type: "notify" | "append"; msg: unknown }

/** Append-only ndjson of received messages. Every append is fsynced before the caller does anything else. */
export class IngressJournal {
  private file: string;
  private now: () => number;
  private rows = new Map<number, JournalRow>();
  private keys = new Set<string>();
  private nextSeq = 1;
  private fd: number | null = null;
  private bytes = 0;

  private constructor(file: string, now: () => number) {
    this.file = file;
    this.now = now;
  }

  static open(file: string, now: () => number): IngressJournal {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    const journal = new IngressJournal(file, now);
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new AuthStoreError("unsafe-path", "WhatsApp ingress journal must be a regular file");
      const { rows } = parseJournal(readFileSync(file, "utf8"));
      for (const row of foldJournal(rows)) journal.index(row);
      journal.compact();
    } else {
      journal.fd = openSync(file, "a", 0o600);
    }
    return journal;
  }

  private index(row: JournalRow): void {
    this.rows.set(row.seq, row);
    this.keys.add(journalKey(row.remoteJid, row.id));
    if (row.seq >= this.nextSeq) this.nextSeq = row.seq + 1;
  }

  private writeLine(row: JournalRow): void {
    if (this.fd === null) this.fd = openSync(this.file, "a", 0o600);
    const line = `${JSON.stringify(row)}\n`;
    writeSync(this.fd, line);
    fsyncSync(this.fd);
    this.bytes += Buffer.byteLength(line);
  }

  /** Throws when the disk refuses; the caller reports it. Returns null for a redelivery of a journaled message. */
  append(remoteJid: string, id: string, payload: IngressPayload): JournalRow | null {
    if (this.keys.has(journalKey(remoteJid, id))) return null;
    const row: JournalRow = { seq: this.nextSeq, receivedAt: this.now(), remoteJid, id, done: false, payload };
    this.writeLine(row);
    this.index(row);
    return row;
  }

  markDone(seq: number): void {
    const row = this.rows.get(seq);
    if (!row || row.done) return;
    const done: JournalRow = { seq, receivedAt: row.receivedAt, remoteJid: row.remoteJid, id: row.id, done: true, doneAt: this.now() };
    this.writeLine(done);
    this.rows.set(seq, done);
    if (this.bytes >= JOURNAL_COMPACT_BYTES) this.compact();
  }

  pending(): JournalRow[] { return [...this.rows.values()].filter((row) => !row.done).sort((a, b) => a.seq - b.seq); }
  has(remoteJid: string, id: string): boolean { return this.keys.has(journalKey(remoteJid, id)); }
  pendingIds(): Set<string> { return new Set(this.pending().map((row) => row.id)); }
  rowCount(): number { return this.rows.size; }

  /** Rewrites through a temp file and rename. Only finished rows can be dropped (core/journal.ts). */
  compact(): void {
    const kept = compactJournal([...this.rows.values()], this.now());
    if (this.fd !== null) { try { closeSync(this.fd); } catch { /* already closed */ } this.fd = null; }
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    let written = 0;
    try {
      for (const row of kept) { const line = `${JSON.stringify(row)}\n`; writeSync(fd, line); written += Buffer.byteLength(line); }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    this.bytes = written;
    this.rows = new Map(kept.map((row) => [row.seq, row]));
    this.keys = new Set(kept.map((row) => journalKey(row.remoteJid, row.id)));
    this.fd = openSync(this.file, "a", 0o600);
  }

  close(): void {
    if (this.fd !== null) { try { closeSync(this.fd); } catch { /* already closed */ } this.fd = null; }
  }
}

// ---------------------------------------------------------------------------------------------
// Bounded inbound media (design 5.6)
// ---------------------------------------------------------------------------------------------

const MIME_EXT: Record<string, string> = {
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav",
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf",
};

/** The extension comes from an allowlist of MIME types, never from a file name the sender chose. */
export const extensionFor = (mime: string | undefined): string => MIME_EXT[(mime ?? "").split(";")[0].trim().toLowerCase()] ?? "bin";
const safeSegment = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_";

/**
 * WhatsApp shows a voice bubble only for Ogg/Opus sent with `ptt`. Anything else (Murage's mp3 and wav, since no Opus
 * encoder is bundled) is sent as a plain audio message, a file with a play button, and says so here rather than
 * claiming a bubble.
 */
export function audioContent(mime: string, bytes: Buffer): { audio: Buffer; mimetype: string; ptt: boolean } {
  const ogg = mime.split(";")[0].trim().toLowerCase() === "audio/ogg";
  return { audio: bytes, mimetype: ogg ? "audio/ogg; codecs=opus" : mime, ptt: ogg };
}

export class MediaStore {
  private dir: string;
  private now: () => number;

  constructor(dir: string, now: () => number) {
    this.dir = dir;
    this.now = now;
  }

  private files(): Array<{ path: string; bytes: number; mtimeMs: number }> {
    const out: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
    const walk = (dir: string): void => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        const path = join(dir, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) walk(path);
        else if (stat.isFile()) out.push({ path, bytes: stat.size, mtimeMs: stat.mtimeMs });
      }
    };
    walk(this.dir);
    return out;
  }

  usedBytes(): number { return this.files().reduce((sum, file) => sum + file.bytes, 0); }

  pathFor(chatJid: string, messageId: string, mime: string | undefined): string {
    return join(this.dir, chatKeyOf(chatJid), `${safeSegment(messageId)}.${extensionFor(mime)}`);
  }

  /** Streams to a temp file under a hard cap; an overflow aborts the stream and deletes the partial file. Returns null on refusal. */
  async save(chatJid: string, messageId: string, mime: string | undefined, stream: MediaStream, maxBytes: number): Promise<{ path: string; bytes: number } | null> {
    const target = this.pathFor(chatJid, messageId, mime);
    if (existsSync(target)) { stream.destroy?.(); return containedMediaFile(this.dir, target, maxBytes); }
    if (!createMediaDirectory(this.dir) || !createMediaDirectory(dirname(target))) { stream.destroy?.(); return null; }
    if (!mediaDirectory(this.dir, join(target, ".."))) { stream.destroy?.(); return null; }
    const budget = Math.min(maxBytes, MEDIA_CONNECTION_MAX_BYTES - this.usedBytes());
    if (budget <= 0) { stream.destroy?.(); return null; }
    const tmp = `${target}.part`;
    if (existsSync(tmp)) {
      if (!containedMediaFile(this.dir, tmp, MEDIA_CONNECTION_MAX_BYTES)) { stream.destroy?.(); return null; }
      rmSync(tmp);
    }
    const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    let bytes = 0;
    let ok = false;
    try {
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        if (bytes > budget) { stream.destroy?.(); return null; }
        writeSync(fd, chunk);
      }
      fsyncSync(fd);
      ok = true;
    } finally {
      closeSync(fd);
      if (!ok) rmSync(tmp, { force: true });
    }
    renameSync(tmp, target);
    return containedMediaFile(this.dir, target, maxBytes);
  }

  /** Deletes files older than 7 days, except those named in `keepIds` (messages still unfinished). */
  sweep(keepIds: ReadonlySet<string>): number {
    let removed = 0;
    for (const file of this.files()) {
      const base = file.path.slice(file.path.lastIndexOf("/") + 1);
      const id = base.replace(/\.part$/, "").replace(/\.[^.]+$/, "");
      if (this.now() - file.mtimeMs < MEDIA_SWEEP_MS || keepIds.has(id)) continue;
      rmSync(file.path, { force: true });
      removed++;
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------

type InitMessage = Extract<HostMessage, { kind: "init" }>;
type ConnectionMessage = Extract<ChildMessage, { kind: "connection" }>;

const statusError = (statusCode: number, message: string): Error => Object.assign(new Error(message), { output: { statusCode } });
const wireError = (error: unknown, forceUncertain = false): SendErrorWire => {
  const c = classifySendError(error);
  return { code: c.code, message: c.message.slice(0, 2000), ...(c.uncertain || forceUncertain ? { uncertain: true } : {}), ...(c.retryAfterSeconds ? { retryAfterSeconds: c.retryAfterSeconds } : {}) };
};

export class Bridge {
  private deps: BridgeDeps;
  private now: () => number;
  private random: () => number;

  private init: InitMessage | null = null;
  private authDir = "";
  private authKey: Buffer | null = null;
  private journal: IngressJournal | null = null;
  private media: MediaStore | null = null;
  private ledger: EchoLedger | null = null;
  private outboundFile = "";
  private persistChain: Promise<void> = Promise.resolve();
  private persistPending: Promise<void> | null = null;
  private persistLatest: readonly ReservedRecord[] = [];

  private state: LinkState = "idle";
  private sock: SocketLike | null = null;
  private auth: EncryptedAuthState | null = null;
  private generation = 0;
  private open = false;
  private self: { pn: string; lid?: string } | null = null;
  private failures = 0;
  private recoveredAt: number | null = null;
  private postPairingRestarted = false;
  private restartedAtMs: number | undefined;
  private qrVersion = 0;
  private linkMethod: "qr" | "code" | null = null;
  private pairingPhone: string | undefined;
  private pairingRequested = false;
  private lastFrameAt = 0;
  private catchUpComplete = false;
  private admittedAt = 0;
  private stopped = false;
  private lastGoodVersion: [number, number, number] | null = null;
  private resolveVersion: (() => Promise<[number, number, number] | null>) | null = null;
  private aliases = new Map<string, string>();

  private inflight = new Map<number, number>();
  private pumping = false;
  private pumpAgain = false;
  private authorizations = new Map<string, number>();
  private sendTail: Promise<unknown> = Promise.resolve();

  private watchdog: ReturnType<typeof setInterval> | null = null;
  private resendTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenTimer: ReturnType<typeof setInterval> | null = null;
  private scheduleReconnect: (delayMs: number) => void = noop;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  // -- host messages --------------------------------------------------------------------------

  /** Entry for one host message. Never throws: a failure becomes a `result`, `connection`, `log` or `fatal`. */
  async handle(raw: unknown): Promise<void> {
    const message = parseHostMessage(raw);
    if (!message) return;
    try {
      switch (message.kind) {
        case "init": await this.onInit(message); break;
        case "link": await this.onLink(message); break;
        case "stop": await this.stop(); break;
        case "logout": await this.logout(); if (message.reqId) this.emit({ kind: "result", reqId: message.reqId, ok: true }); break;
        case "reserve": await this.onReserve(message); break;
        case "send": await this.onSend(message); break;
        case "authorize": this.authorizations.set(canonicalJid(message.chatId), message.generation); break;
        case "presence": if (this.open) await this.sock?.sendPresenceUpdate(message.state, message.chatId).catch(noop); break;
        case "read": await this.onRead(message); break;
        case "groups": await this.onGroups(message.reqId); break;
        case "resolve": await this.onResolve(message); break;
        case "replay": this.inflight.clear(); await this.pump(); break;
        case "ack": this.onAck(message.seq); break;
        case "ping": this.emit({ kind: "pong", n: message.n }); break;
      }
    } catch (error) {
      this.emit({ kind: "log", level: "error", message: `bridge handler failed: ${describeError(error)}` });
    }
  }

  private emit(message: ChildMessage): void {
    try { this.deps.send(message); } catch { /* the IPC channel closed; the host will notice */ }
  }

  private setState(state: LinkState, extra: Partial<ConnectionMessage> = {}): void {
    this.state = state;
    this.emit({ kind: "connection", ...extra, state, ...(this.self && !extra.self ? { self: this.self } : {}) } as ConnectionMessage);
  }

  private block(reason: BlockedReason): void {
    this.setState("blocked", { blockedReason: reason });
  }

  private async onInit(message: InitMessage): Promise<void> {
    if (this.init) return;
    this.init = { ...message, lastSeenAtMs: message.lastSeenAtMs ?? this.now() };
    this.authDir = join(message.dataDir, "auth");
    this.outboundFile = join(message.dataDir, "outbound", `${message.connectionId}.json`);
    try {
      this.authKey = parseAuthKey(message.authKeyHex);
      this.journal = IngressJournal.open(join(message.dataDir, "ingress", `${message.connectionId}.ndjson`), this.now);
      this.media = new MediaStore(join(message.dataDir, "media", message.connectionId), this.now);
      this.ledger = this.openLedger();
    } catch (error) {
      this.init = null;
      if (error instanceof AuthStoreError) this.block(error.code === "bad-key" ? "key-missing" : "auth-dir");
      else this.emit({ kind: "fatal", message: `bridge could not open its files: ${describeError(error)}` });
      return;
    }
    this.admittedAt = message.lastSeenAtMs ?? this.now();
    this.lastGoodVersion = message.lastGoodWebVersion ?? null;
    this.resolveVersion = createVersionResolver<[number, number, number]>(() => this.deps.lib.fetchLatestBaileysVersion(), { timeoutMs: VERSION_FETCH_TIMEOUT_MS, initial: this.lastGoodVersion });
    this.scheduleReconnect = createReconnectScheduler(() => this.startSocket(), { log: (line) => this.emit({ kind: "log", level: "warn", message: line }) });
    this.resendTimer = setInterval(() => { void this.resendStale(); }, Math.max(1000, Math.floor(JOURNAL_RESEND_MS / 3)));
    this.resendTimer.unref?.();
    this.emit({ kind: "connection", state: "idle" });
    // A restore needs no QR: registered credentials start the socket straight away.
    let registered = false;
    try {
      const peek = await useEncryptedAuthState(this.authDir, this.authKey!, { initCreds: () => this.deps.lib.initAuthCreds() });
      registered = peek.hadCreds && peek.state.creds.registered === true;
      const me = peek.state.creds.me as { id?: string; lid?: string } | undefined;
      if (me?.id) this.self = { pn: stripDevice(me.id), ...(me.lid ? { lid: stripDevice(me.lid) } : {}) };
    } catch (error) {
      this.onAuthError(error);
      return;
    }
    if (registered && !existsSync(this.outboundFile)) { this.emit({ kind: "fatal", message: "WhatsApp outbound journal needs recovery" }); this.init = null; return; }
    if (!existsSync(this.outboundFile)) await this.persistOutbound(this.ledger!.records());
    // Old media is swept by the service (service.ts), which knows which files an unfinished receipt still needs.
    if (message.dryRun) {
      if (this.deps.lib.qualify) {
        try { this.emit({ kind: "ready", v: PROTOCOL_VERSION, ...await this.deps.lib.qualify(), platform: process.platform, arch: process.arch, electronVersion: process.versions.electron }); }
        catch { this.emit({ kind: "fatal", message: "WhatsApp runtime qualification failed" }); return; }
      }
      this.emit({ kind: "initialized" });
      return;
    }
    if (!registered && message.retainedBinding) this.setState("logged-out");
    this.emit({ kind: "initialized" });
    if (registered) await this.startSocket();
    await this.pump();
  }

  private onAuthError(error: unknown): void {
    if (error instanceof AuthStoreError) this.block(error.code === "undecryptable" ? "auth-unreadable" : error.code === "bad-key" ? "key-missing" : "auth-dir");
    else this.emit({ kind: "fatal", message: `bridge could not open WhatsApp credentials: ${describeError(error)}` });
  }

  private async onLink(message: Extract<HostMessage, { kind: "link" }>): Promise<void> {
    if (!this.init) return;
    if (this.state === "connected") { this.emit({ kind: "connection", state: "connected", ...(this.self ? { self: this.self } : {}) }); return; }
    this.linkMethod = message.method;
    this.pairingPhone = message.method === "code" ? message.phone : undefined;
    this.pairingRequested = false;
    this.qrVersion = 0;
    this.postPairingRestarted = false;
    this.restartedAtMs = undefined;
    this.failures = 0;
    this.setState("linking");
    await this.startSocket();
  }

  // -- socket -----------------------------------------------------------------------------------

  private async startSocket(): Promise<void> {
    if (!this.init || this.stopped || !this.authKey) return;
    this.closeSocket();
    this.catchUpComplete = false;
    const gen = ++this.generation;
    let auth: EncryptedAuthState;
    try {
      const fromObject = this.deps.lib.proto?.Message?.AppStateSyncKeyData?.fromObject;
      auth = await useEncryptedAuthState(this.authDir, this.authKey, {
        initCreds: () => this.deps.lib.initAuthCreds(),
        reviveKey: (type, value) => (type === "app-state-sync-key" && fromObject ? fromObject(value) : value),
        // Signal keys must never run ahead of what is on disk: a failed write ends the process and the host respawns it.
        onPersistenceFailure: (error) => { this.closeSocket(); this.deps.onFatal?.(`auth state could not be saved: ${describeError(error)}`); },
        onUnreadable: () => { this.closeSocket(); this.block("auth-unreadable"); },
      });
    } catch (error) {
      this.onAuthError(error);
      return;
    }
    if (gen !== this.generation) return;
    this.auth = auth;
    const version = this.resolveVersion ? await this.resolveVersion() : null;
    if (gen !== this.generation) return;
    if (version) this.lastGoodVersion = version;
    const keys = this.deps.lib.makeCacheableSignalKeyStore ? this.deps.lib.makeCacheableSignalKeyStore(auth.state.keys, silentLogger) : auth.state.keys;
    const ledger = this.ledger!;
    const sock = this.deps.lib.makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: auth.state.creds, keys },
      logger: silentLogger,
      browser: ["Murage", "Desktop", this.init.appVersion],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid: string) => { const kind = jidKind(jid); return kind === "broadcast" || kind === "newsletter"; },
      // A retried send must carry its text (Hermes stubbed this with an empty conversation, so retries arrived blank).
      getMessage: async (key: { id?: string | null }) => { const text = key.id ? ledger.textFor(key.id) : undefined; return text === undefined ? undefined : { conversation: text }; },
      keepAliveIntervalMs: 25_000,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
    });
    this.sock = sock;
    this.open = false;
    this.lastFrameAt = this.now();
    sock.ev.on("creds.update", () => { if (gen === this.generation) void auth.saveCreds().catch(noop); });
    sock.ev.on("connection.update", (update: Record<string, unknown>) => { if (gen === this.generation) void this.onConnectionUpdate(gen, sock, update); });
    sock.ev.on("messages.upsert", (event: { messages?: unknown[]; type?: string }) => { if (gen === this.generation) this.onUpsert(event); });
    sock.ws?.on("frame", () => {
      if (gen !== this.generation) return;
      const now = this.now();
      if (now - this.lastFrameAt >= WATCHDOG_FRAME_TIMEOUT_MS) this.recoveredAt = now;
      if (this.open && this.recoveredAt !== null && now - this.recoveredAt >= 5 * 60_000) this.failures = 0;
      this.lastFrameAt = now;
    });
    if (!this.watchdog && this.init.options?.enableWatchdog !== false) {
      this.watchdog = setInterval(() => this.checkWatchdog(), WATCHDOG_CHECK_MS);
      this.watchdog.unref?.();
    }
  }

  private closeSocket(): void {
    const sock = this.sock;
    this.sock = null;
    this.open = false;
    this.recoveredAt = null;
    this.generation++;
    if (!sock) return;
    try { sock.end(undefined); } catch { /* already closed */ }
  }

  private checkWatchdog(): void {
    if (!this.sock || this.stopped) return;
    if (watchdogShouldRestart(this.state, this.lastFrameAt, this.now())) {
      this.emit({ kind: "log", level: "warn", message: `no WebSocket frame for ${Math.round(WATCHDOG_FRAME_TIMEOUT_MS / 1000)}s; restarting the socket` });
      this.closeSocket();
      void this.applyDecision(decideClose(408, { postPairingRestarted: this.postPairingRestarted, nowMs: this.now() }));
    }
  }

  private async onConnectionUpdate(gen: number, sock: SocketLike, update: Record<string, unknown>): Promise<void> {
    const qr = update.qr;
    if (typeof qr === "string" && qr) {
      const registered = this.auth?.state.creds.registered === true;
      if (this.linkMethod === "code" && this.pairingPhone && !registered) {
        if (!this.pairingRequested) {
          this.pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(this.pairingPhone);
            if (gen === this.generation) this.emit({ kind: "pairing-code", code, phone: this.pairingPhone });
          } catch (error) {
            this.emit({ kind: "log", level: "warn", message: `pairing code request failed: ${describeError(error)}` });
          }
        }
      } else {
        this.qrVersion++;
        this.emit({ kind: "qr", text: qr, version: this.qrVersion, issuedAt: this.now() });
      }
    }
    if (update.connection === "open") await this.onOpen(gen, sock);
    if (gen === this.generation && update.receivedPendingNotifications === true) { this.catchUpComplete = true; this.checkpointAdmission(); }
    if (update.connection === "close") await this.onClose(gen, (update.lastDisconnect as { error?: unknown } | undefined)?.error);
  }

  private async onOpen(gen: number, sock: SocketLike): Promise<void> {
    if (gen !== this.generation) return;
    this.open = true;
    this.recoveredAt = this.now();
    this.lastFrameAt = this.now();
    this.self = sock.user?.id ? { pn: stripDevice(sock.user.id), ...(sock.user.lid ? { lid: stripDevice(sock.user.lid) } : {}) } : this.self;
    this.linkMethod = null;
    // Report `connected` only after the credentials of a fresh link are on disk (OpenClaw connection-controller).
    await this.auth?.flush().catch(noop);
    if (gen !== this.generation) return;
    this.setState("connected", { ...(this.lastGoodVersion ? { webVersion: this.lastGoodVersion } : {}) });
    this.emit({ kind: "status", credsPersisted: true });
    if (!this.lastSeenTimer) {
      this.lastSeenTimer = setInterval(() => { if (this.open) this.emit({ kind: "connection", state: "connected", ...(this.self ? { self: this.self } : {}) }); }, LAST_SEEN_INTERVAL_MS);
      this.lastSeenTimer.unref?.();
    }
    if ((this.journal?.pending().length ?? 0) > JOURNAL_REPLAY_BATCH) this.emit({ kind: "status", catchUpTruncated: true });
    await this.pump();
  }

  private async onClose(gen: number, error: unknown): Promise<void> {
    if (gen !== this.generation) return;
    const code = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
    this.closeSocket();
    const decision = decideClose(code, { postPairingRestarted: this.postPairingRestarted, ...(this.restartedAtMs !== undefined ? { restartedAtMs: this.restartedAtMs } : {}), nowMs: this.now() });
    await this.applyDecision(decision);
  }

  private async applyDecision(decision: CloseDecision): Promise<void> {
    if (this.stopped) return;
    if (decision.wipeAuth) {
      // A remote logout (401) or a bad session (500): the credentials are dead. Wipe them now so that no respawn can restart-loop on them.
      try { await wipeAuthDir(this.authDir); } catch (error) { this.emit({ kind: "log", level: "error", message: `auth wipe failed: ${describeError(error)}` }); }
      this.self = null;
    }
    if (!decision.reconnect) {
      this.setState(decision.state, { decision, ...(decision.blockedReason ? { blockedReason: decision.blockedReason } : {}) });
      return;
    }
    if (decision.action === "restart-once") {
      this.postPairingRestarted = true;
      this.restartedAtMs = this.now();
      this.setState("restarting", { decision });
      await this.auth?.flush().catch(noop);
      this.scheduleReconnect(RESTART_DELAY_MS);
      return;
    }
    this.failures++;
    const next = nextReconnect(this.failures, undefined, this.random);
    if (next.kind === "blocked") { this.setState("blocked", { decision, blockedReason: "retry-limit" }); return; }
    this.setState("retry", { decision, attempt: next.attempt, retryInMs: next.delayMs });
    this.scheduleReconnect(next.delayMs);
  }

  // -- stop and logout --------------------------------------------------------------------------

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of [this.watchdog, this.resendTimer, this.lastSeenTimer]) if (timer) clearInterval(timer);
    this.watchdog = null;
    this.resendTimer = null;
    this.lastSeenTimer = null;
    const auth = this.auth;
    this.closeSocket();
    await auth?.flush().catch(noop);
    await this.persistChain.catch(noop);
    this.journal?.close();
    this.emit({ kind: "connection", state: "idle" });
  }

  /** Unlink: tell WhatsApp (10 s at most), end the socket, wipe the credentials. The key stays; it belongs to the installation. */
  async logout(): Promise<void> {
    const sock = this.sock;
    this.generation++;
    if (sock) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([sock.logout().catch(noop), new Promise<void>((resolve) => { timer = setTimeout(resolve, LOGOUT_DEADLINE_MS); })]);
      if (timer) clearTimeout(timer);
    }
    this.closeSocket();
    await this.auth?.flush().catch(noop);
    try { await wipeAuthDir(this.authDir); } catch (error) { this.emit({ kind: "log", level: "error", message: `auth wipe failed: ${describeError(error)}` }); }
    this.self = null;
    this.failures = 0;
    this.setState("idle");
  }

  // -- inbound ----------------------------------------------------------------------------------

  private onUpsert(event: { messages?: unknown[]; type?: string }): void {
    if (event.type !== "notify" && event.type !== "append") return;
    const type = event.type;
    for (const msg of event.messages ?? []) this.ingest(msg, type);
    if (this.ledger) void this.persistOutbound(this.ledger.records()).then(() => this.pump()).catch(() => this.emit({ kind: "fatal", message: "WhatsApp alias state needs recovery" }));
  }

  private ingest(msg: unknown, type: "notify" | "append"): void {
    const journal = this.journal;
    if (!journal) return;
    const raw = msg as { key?: { remoteJid?: string | null; id?: string | null }; message?: unknown } | null;
    const remoteJid = raw?.key?.remoteJid;
    const id = raw?.key?.id;
    if (!raw || !remoteJid || !id || !raw.message) return; // stubs and key-distribution noise carry no message
    const probe = envelopeOf(raw as never, type, this.now());
    if (!probe || (probe.text === undefined && !probe.media)) return; // reactions, protocol messages
    if (probe.chatJidAlt && jidKind(remoteJid) !== "group" && ["pn", "lid"].includes(jidKind(probe.chatJidAlt))) this.aliases.set(canonicalJid(remoteJid), canonicalJid(probe.chatJidAlt));
    const forms = [canonicalJid(remoteJid), ...this.aliasesOf(remoteJid)];
    const identity = forms.find(jid => jidKind(jid) === "pn") ?? forms[0];
    if (forms.some(jid => journal.has(jid, id))) return;
    // The first durable write, before classification, download or forwarding (design 5.5).
    let row: JournalRow | null;
    try {
      row = journal.append(identity, id, { type, msg: JSON.parse(JSON.stringify(msg, bufferJSON.replacer)) });
    } catch {
      this.emit({ kind: "status", ingressWriteFailed: { remoteJid, id } });
      return;
    }
    if (!row) return; // a redelivery of a message already in the journal
  }

  private async envelopeFor(row: JournalRow): Promise<InboundEnvelope | null> {
    const payload = row.payload as IngressPayload | undefined;
    if (!payload) return null;
    const revived = JSON.parse(JSON.stringify(payload.msg), bufferJSON.reviver) as Record<string, unknown>;
    const envelope = envelopeOf(revived as never, payload.type, row.receivedAt);
    if (!envelope) return null;
    if (envelope.chatJidAlt && ["pn", "lid"].includes(jidKind(envelope.chatJid)) && ["pn", "lid"].includes(jidKind(envelope.chatJidAlt))) this.aliases.set(canonicalJid(envelope.chatJid), canonicalJid(envelope.chatJidAlt));
    if (envelope.quoted && this.ledger?.isOutbound(envelope.quoted.id, envelope.chatJid, envelope.chatJidAlt)) envelope.quoted.outbound = true;
    if (envelope.media && !this.self) throw new Error("MEDIA_WAIT_CONNECTION");
    if (envelope.media) await this.attachMedia(envelope, revived);
    return envelope;
  }

  private async mediaWanted(envelope: InboundEnvelope): Promise<boolean> {
    const media = envelope.media;
    if (!media || !this.media || !this.self || !this.ledger || !this.init) return false;
    if (media.kind === "location" || media.kind === "contact") return false;
    const cap = media.kind === "audio" ? AUDIO_CLIP_MAX_BYTES : MEDIA_FILE_MAX_BYTES;
    if (media.bytes !== undefined && media.bytes > cap) return false;
    const access = this.init.options?.access;
    const result = await decide({ ...envelope, id: envelope.messageId,
      quotedMessageId: envelope.quoted?.id }, {
      mode: this.init.mode, self: this.self, echo: this.ledger, nowMs: this.now(),
      lastSeenAtMs: this.init.lastSeenAtMs, allowFrom: access?.allowFrom ?? [],
      groups: access?.groups ?? { policy: "disabled", allow: [], senders: "members" },
    }, {
      pnForLid: async jid => this.sock?.signalRepository?.lidMapping?.getPNForLID(jid),
      lidForPn: async jid => this.sock?.signalRepository?.lidMapping?.getLIDForPN(jid),
    });
    return result.decision === "accept";
  }

  private async attachMedia(envelope: InboundEnvelope, revived: Record<string, unknown>): Promise<void> {
    if (!envelope.media || !this.media || !await this.mediaWanted(envelope)) return;
    const cap = envelope.media.kind === "audio" ? AUDIO_CLIP_MAX_BYTES : MEDIA_FILE_MAX_BYTES;
    const existing = this.media.pathFor(envelope.chatJid, envelope.messageId, envelope.media.mime);
    try {
      if (existsSync(existing)) {
        const cached = containedMediaFile(join(this.init!.dataDir, "media", this.init!.connectionId), existing, cap);
        if (cached) { envelope.media.path = cached.path; envelope.media.bytes = cached.bytes; }
        return;
      }
      if (!this.sock || !this.open) throw new Error("MEDIA_WAIT_CONNECTION");
      const sock = this.sock;
      const stream = await this.withTimeout(this.deps.lib.downloadMediaMessage(revived, "stream", {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage ? sock.updateMediaMessage.bind(sock) : async (m: unknown) => m }));
      const deadline = setTimeout(() => stream.destroy?.(new Error("Media download deadline")), SEND_TIMEOUT_MS);
      let saved;
      try { saved = await this.withTimeout(this.media.save(envelope.chatJid, envelope.messageId, envelope.media.mime, stream, cap)); }
      finally { clearTimeout(deadline); stream.destroy?.(); }
      if (saved) { envelope.media.path = saved.path; envelope.media.bytes = saved.bytes; }
    } catch (error) {
      if (error instanceof Error && error.message === "MEDIA_WAIT_CONNECTION") throw error;
      this.emit({ kind: "log", level: "warn", message: `media download failed: ${describeError(error)}` });
    }
  }

  /** Sends pending journal rows to the host, at most 450 unacknowledged at a time, in arrival order. */
  private async pump(): Promise<void> {
    if (!this.journal || !this.ledger || !this.init) return;
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        for (const row of this.journal.pending()) {
          if (this.inflight.size >= MAX_PENDING_INBOUND) break;
          if (this.inflight.has(row.seq)) continue;
          let envelope: InboundEnvelope | null;
          try { envelope = await this.envelopeFor(row); } catch { continue; }
          if (!envelope) { this.journal.markDone(row.seq); continue; }
          // The bot's own sends come back as upserts; the outbound journal recognises them by id alone and they stop here.
          if (envelope.fromMe && this.ledger.classify({ fromMe: true, chatKind: jidKind(envelope.chatJid) === "group" ? "group" : "self", id: envelope.messageId, chatJid: envelope.chatJid, chatAltJid: envelope.chatJidAlt }) === "echo") { this.journal.markDone(row.seq); continue; }
          this.inflight.set(row.seq, this.now());
          this.emit({ kind: "inbound", seq: row.seq, envelope });
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private async resendStale(): Promise<void> {
    const cutoff = this.now() - JOURNAL_RESEND_MS;
    let any = false;
    for (const [seq, sentAt] of this.inflight) if (sentAt <= cutoff) { this.inflight.delete(seq); any = true; }
    if (any) await this.pump();
  }

  private onAck(seq: number): void {
    this.inflight.delete(seq);
    const row = this.journal?.pending().find(row => row.seq === seq);
    if (row) {
      const payload = row.payload as IngressPayload;
      const envelope = envelopeOf(payload.msg as never, payload.type, row.receivedAt);
      if (envelope) this.admittedAt = Math.max(this.admittedAt, Math.min(envelope.timestampMs, this.now()));
    }
    this.journal?.markDone(seq);
    this.checkpointAdmission();
    void this.pump();
  }

  private checkpointAdmission(): void {
    if (this.open && this.catchUpComplete && this.journal?.pending().length === 0 && this.admittedAt > 0) this.emit({ kind: "status", admittedAtMs: this.admittedAt });
  }

  private async onRead(message: Extract<HostMessage, { kind: "read" }>): Promise<void> {
    if (!this.open || !this.init?.options?.readReceipts) return;
    await this.sock?.readMessages(message.keys.map((k) => ({ remoteJid: k.remoteJid, id: k.id, ...(k.participant ? { participant: k.participant } : {}) }))).catch(noop);
  }

  // -- outbound journal -------------------------------------------------------------------------

  private openLedger(): EchoLedger {
    let initial: ReservedRecord[] = [];
    if (existsSync(this.outboundFile)) {
      const stat = lstatSync(this.outboundFile);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > OUTBOUND_FILE_MAX_BYTES) throw new AuthStoreError("unsafe-path", "WhatsApp outbound journal must be a regular file");
      const parsed = JSON.parse(readFileSync(this.outboundFile, "utf8"));
      initial = parseOutboundJournal(parsed);
      for (const [from, to] of Object.entries(parsed.aliases ?? {})) this.aliases.set(from, to as string);
    }
    mkdirSync(join(this.outboundFile, ".."), { recursive: true, mode: 0o700 });
    return createEchoLedger({
      generateId: () => this.deps.lib.generateMessageIDV2(this.sock?.user?.id),
      aliasesOf: (jid) => this.aliasesOf(jid),
      persist: (records) => this.persistOutbound(records),
      initial,
      max: SENT_RING_MAX,
      now: this.now,
    });
  }

  private aliasesOf(jid: string): string[] {
    const canon = canonicalJid(jid);
    const out = new Set<string>();
    const known = this.aliases.get(canon);
    if (known) out.add(known);
    for (const [from, to] of this.aliases) if (to === canon) out.add(from);
    const self = this.self;
    if (self?.lid) {
      if (canon === canonicalJid(self.pn)) out.add(canonicalJid(self.lid));
      if (canon === canonicalJid(self.lid)) out.add(canonicalJid(self.pn));
    }
    return [...out];
  }

  /** Coalescing, fsynced write of the outbound journal: callers that arrive while one is queued share it and it writes the latest records. */
  private persistOutbound(records: readonly ReservedRecord[]): Promise<void> {
    this.persistLatest = records;
    if (this.persistPending) return this.persistPending;
    const run = this.persistChain.catch(noop).then(async () => {
      this.persistPending = null;
      const snapshot = this.persistLatest.map((record) => ({ ...record }));
      let body = JSON.stringify({ records: snapshot, aliases: Object.fromEntries(this.aliases) });
      // 4 MB cap (design 3.4): ids are kept, the oldest texts go first.
      for (let i = 0; Buffer.byteLength(body) > OUTBOUND_FILE_MAX_BYTES && i < snapshot.length; i++) {
        delete snapshot[i].text;
        if (i % 50 === 49 || i === snapshot.length - 1) body = JSON.stringify({ records: snapshot, aliases: Object.fromEntries(this.aliases) });
      }
      await writeFileAtomic(this.outboundFile, Buffer.from(body, "utf8"));
    });
    this.persistPending = run;
    this.persistChain = run;
    return run;
  }

  // -- outbound ---------------------------------------------------------------------------------

  private chunksOf(text: string): string[] {
    return chunkMessage(formatForWhatsApp(text), MAX_CHUNK_CHARS);
  }

  private async onReserve(message: Extract<HostMessage, { kind: "reserve" }>): Promise<void> {
    const ledger = this.ledger;
    const fail = (text: string): void => this.emit({ kind: "result", reqId: message.reqId, ok: false, error: { code: "unavailable", message: text } });
    if (!ledger) return fail("bridge not initialised");
    const texts = message.payload.type === "text" ? this.chunksOf(message.payload.text) : ["[voice note]"];
    if (texts.length === 0) return fail("nothing to send");
    try {
      // Each id keeps the text it will carry, so `getMessage` can answer a retry with the same words.
      const reserved = texts.map((text) => ledger.reserve({ chatJid: message.chatId, text }));
      await Promise.all(reserved.map((r) => r.persisted));
      this.emit({ kind: "reserved", reqId: message.reqId, ids: reserved.map((r) => r.id) });
    } catch (error) {
      fail(`could not reserve ids: ${describeError(error)}`);
    }
  }

  private async onSend(message: Extract<HostMessage, { kind: "send" }>): Promise<void> {
    const ledger = this.ledger;
    const { reqId, chatId, ids, payload } = message;
    const refuse = (text: string): void => this.emit({ kind: "send-result", reqId, ok: false, error: { code: "unavailable", message: text }, sentIds: [] });
    if (!ledger) return refuse("bridge not initialised");
    if (!ids.every((id) => ledger.stateOf(id) === "reserved" && ledger.isOutbound(id, chatId))) return refuse("send refused: ids are not freshly reserved for this chat");
    const chunks = payload.type === "text" ? this.chunksOf(payload.text) : ["[voice note]"];
    if (chunks.length !== ids.length) return refuse("send refused: the reservation does not match the text");
    const job = this.sendTail.catch(noop).then(() => this.runSend(message, chunks));
    this.sendTail = job;
    await job;
  }

  /** One reply, all its chunks, under the serialized queue (Hermes: one send at a time, after cross-chat contamination bug #33360). */
  private async runSend(message: Extract<HostMessage, { kind: "send" }>, chunks: string[]): Promise<void> {
    const ledger = this.ledger!;
    const { reqId, chatId, ids, payload } = message;
    const sentIds: string[] = [];
    const authorized = () => !this.stopped && (message.generation ?? 0) === (this.authorizations.get(canonicalJid(chatId)) ?? 0);
    try {
      if (!authorized()) throw statusError(403, "Chat authorization changed");
      if (this.init?.dryRun) {
        this.emit({ kind: "dry-run", reqId, chatId, ids, chunks });
        for (const id of ids) { ledger.settle(id, { ok: true }); sentIds.push(id); }
        this.emit({ kind: "send-result", reqId, ok: true, ids });
        return;
      }
      await sendWithPresence(
        (state) => (this.open ? this.sock?.sendPresenceUpdate(state, chatId) : undefined),
        async () => {
          for (let i = 0; i < ids.length; i++) {
            if (i > 0) await sleep(CHUNK_DELAY_MS);
            if (payload.type === "text") {
              const quoted = i === 0 ? this.quoteFor(chatId, payload.quote) : undefined;
              await this.sendOne(chatId, ids[i], { text: chunks[i] }, quoted, authorized);
            } else {
              await this.sendOne(chatId, ids[i], audioContent(payload.mime, Buffer.from(payload.bytesBase64, "base64")), undefined, authorized);
            }
            ledger.settle(ids[i], { ok: true });
            sentIds.push(ids[i]);
          }
        },
        // A presence failure never fails the send (OpenClaw 402bd4af01b).
        (error) => this.emit({ kind: "log", level: "debug", message: `presence update failed: ${describeError(error)}` }),
      );
      this.emit({ kind: "send-result", reqId, ok: true, ids });
    } catch (error) {
      const classified = classifySendError(error);
      const partial = sentIds.length > 0;
      const failedAt = ids[sentIds.length];
      ids.slice(sentIds.length).forEach((id) => ledger.settle(id, id === failedAt && classified.uncertain ? { ok: false, uncertain: true, error: classified.message } : { ok: false, error: classified.message }));
      const wire = wireError(error, partial);
      this.emit({ kind: "send-result", reqId, ok: false, error: partial ? { ...wire, message: `partial: ${wire.message}`.slice(0, 2000) } : wire, sentIds });
    }
  }

  private quoteFor(chatId: string, quote: QuoteRef | undefined): ReturnType<typeof minimalQuoted> {
    const mode = this.init?.options?.quoteReplies ?? "groups";
    const group = jidKind(chatId) === "group";
    if (mode === "off" || (mode === "groups" && !group)) return undefined;
    return minimalQuoted(quote);
  }

  private withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(SEND_TIMEOUT_MESSAGE)), SEND_TIMEOUT_MS); });
    return Promise.race([operation, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /** 60 s per send; only connection-type errors retry (3 attempts, 500 to 1000 ms apart); a timeout is never retried. */
  private async sendOne(chatId: string, id: string, content: Record<string, unknown>, quoted: unknown, authorized: () => boolean = () => true): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.withTimeout((async () => {
          if (!authorized()) throw statusError(403, "Chat authorization changed");
          const sock = this.sock;
          if (!this.open || !sock) throw statusError(428, "Connection Closed");
          await sock.sendMessage(chatId, content, { messageId: id, ...(quoted ? { quoted } : {}) });
        })());
        return;
      } catch (error) {
        const delay = sendRetryDelay(classifySendError(error), attempt, this.random);
        if (delay === null) throw error;
        await sleep(delay);
      }
    }
  }

  // -- queries ----------------------------------------------------------------------------------

  private async onGroups(reqId: string): Promise<void> {
    const sock = this.sock;
    if (!this.open || !sock) { this.emit({ kind: "result", reqId, ok: false, error: { code: "offline", message: "WhatsApp is not connected" } }); return; }
    try {
      const all = await sock.groupFetchAllParticipating();
      const groups = Object.values(all).map((g) => ({ jid: g.id, subject: g.subject ?? "", size: Array.isArray(g.participants) ? g.participants.length : 0 }));
      groups.sort((a, b) => a.subject.localeCompare(b.subject));
      this.emit({ kind: "result", reqId, ok: true, value: groups });
    } catch (error) {
      this.emit({ kind: "result", reqId, ok: false, error: wireError(error) });
    }
  }

  private async onResolve(message: Extract<HostMessage, { kind: "resolve" }>): Promise<void> {
    const mapping = this.sock?.signalRepository?.lidMapping;
    if (!mapping) { this.emit({ kind: "result", reqId: message.reqId, ok: false, error: { code: "offline", message: "WhatsApp is not connected" } }); return; }
    try {
      const jid = message.op === "pn-for-lid" ? await mapping.getPNForLID(message.jid) : await mapping.getLIDForPN(message.jid);
      if (jid) this.aliases.set(canonicalJid(message.jid), canonicalJid(jid));
      this.emit({ kind: "result", reqId: message.reqId, ok: true, value: { jid: jid ?? null } });
    } catch (error) {
      this.emit({ kind: "result", reqId: message.reqId, ok: false, error: wireError(error) });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Process entry
// ---------------------------------------------------------------------------------------------

export interface ProcessLike {
  send?: (message: unknown) => boolean | void;
  on(event: string, listener: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  exit(code?: number): never | void;
}

/** Runs the bridge as the forked child: `ready`, then one host message at a time into the engine. `lib` is injected by tests and the fixture child. */
export async function runBridgeProcess(proc: ProcessLike = process as unknown as ProcessLike, injected?: BaileysLib): Promise<Bridge> {
  const lib = injected ?? (await loadBaileys());
  const send = (message: unknown): void => { proc.send?.(message); };
  const die = (message: string): void => { send({ kind: "fatal", message: message.slice(0, 500) }); setTimeout(() => proc.exit(1), 50); };
  const bridge = new Bridge({ lib, send, onFatal: die });
  proc.on("message", (message: unknown) => {
    void bridge.handle(message).then(() => { if ((message as { kind?: string } | null)?.kind === "stop") proc.exit(0); });
  });
  proc.on("disconnect", () => { void bridge.stop().finally(() => proc.exit(0)); });
  proc.on("uncaughtException", (error: unknown) => die(`uncaught exception: ${describeError(error)}`));
  proc.on("unhandledRejection", (error: unknown) => die(`unhandled rejection: ${describeError(error)}`));
  send({ kind: "ready", v: PROTOCOL_VERSION });
  return bridge;
}

async function loadBaileys(): Promise<BaileysLib> {
  // Dynamic and external: the bundle keeps `baileys` as a runtime import from dist-server/node_modules, and tests never load it.
  const module = (await import("baileys")) as unknown as Record<string, unknown>;
  return {
    qualify: async () => {
      const { Jimp } = await import("jimp");
      const bytes = await new Jimp({ width: 2, height: 2, color: 0xffffffff }).getBuffer("image/jpeg");
      const require = createRequire(import.meta.url);
      let dir = dirname(require.resolve("baileys"));
      while (!existsSync(join(dir, "package.json")) || JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name !== "baileys") {
        const parent = dirname(dir); if (parent === dir) throw new Error("Baileys package metadata missing"); dir = parent;
      }
      return { baileysVersion: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, jimp: bytes.length > 0 };
    },
    makeWASocket: (module.makeWASocket ?? module.default) as BaileysLib["makeWASocket"],
    initAuthCreds: module.initAuthCreds as BaileysLib["initAuthCreds"],
    generateMessageIDV2: module.generateMessageIDV2 as BaileysLib["generateMessageIDV2"],
    fetchLatestBaileysVersion: module.fetchLatestBaileysVersion as BaileysLib["fetchLatestBaileysVersion"],
    downloadMediaMessage: module.downloadMediaMessage as BaileysLib["downloadMediaMessage"],
    makeCacheableSignalKeyStore: module.makeCacheableSignalKeyStore as BaileysLib["makeCacheableSignalKeyStore"],
    proto: module.proto as BaileysLib["proto"],
  };
}

const isMain = ((): boolean => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) void runBridgeProcess();
