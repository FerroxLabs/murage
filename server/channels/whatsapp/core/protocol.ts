// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// IPC protocol between the Murage server (bridge-host) and the bridge child
// (design 1 and 7.1). Messages are plain JSON over `fork` IPC. Parsers accept
// `unknown` and return null for anything malformed, so a confused child can
// never crash the host. Nothing here logs; `redactForLog` is the only way a
// message should reach a log line (design 7.4).
import type { BlockedReason, CloseDecision, LinkState } from "./close-decision.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const HANDSHAKE_DEADLINE_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const RESPAWN_BACKOFF_MIN_MS = 5_000;
export const RESPAWN_BACKOFF_MAX_MS = 30 * 60_000;
export const PAIRING_CODE_VISIBLE_MS = 60_000;

export const MAX_PENDING_INBOUND = 450;
export const INBOUND_RESEND_MS = 30_000;
export const PING_MISS_LIMIT = 3;
export const PONG_DEADLINE_MS = 10_000;

export interface MessageKeyRef { remoteJid: string; id: string; fromMe?: boolean; participant?: string }

/** The message a reply quotes. The bridge rebuilds a minimal quoted message from `text`; with no text it sends unquoted. */
export interface QuoteRef extends MessageKeyRef { text?: string }

export type SendErrorWire = { code: "auth" | "forbidden" | "rate-limit" | "offline" | "timeout" | "unavailable"; message: string; uncertain?: boolean; retryAfterSeconds?: number };

export type MediaKind = "image" | "audio" | "video" | "document" | "sticker" | "location" | "contact";

export interface MediaDescriptor { kind: MediaKind; mime?: string; bytes?: number; name?: string; seconds?: number; ptt?: boolean; path?: string; caption?: string }

/** What the bridge forwards for one received message (design 5.5 and 7.1), before core/access decides anything. */
export interface InboundEnvelope {
  messageId: string;
  chatJid: string;
  chatJidAlt?: string;
  fromMe: boolean;
  /** Milliseconds. */
  timestampMs: number;
  upsertType: "notify" | "append";
  pushName?: string;
  participant?: string;
  participantAlt?: string;
  text?: string;
  mentionedJids: string[];
  quoted?: { id: string; participant?: string; text?: string; /** True when the quoted message is one of the bot's own (outbound journal). */ outbound?: boolean };
  media?: MediaDescriptor;
}

export type BridgeOptions = { access?: { allowFrom: readonly string[]; groups: import("./access.ts").GroupsPolicy }; readReceipts?: boolean; quoteReplies?: "off" | "groups" | "all"; enableWatchdog?: boolean };

/** Host to child. The auth key travels only in `init`, never on the command line or in the environment. */
export type HostMessage =
  | { kind: "init"; v: number; connectionId: string; dataDir: string; authKeyHex: string; mode: "self-chat" | "contacts"; appVersion: string; lastGoodWebVersion?: [number, number, number]; lastSeenAtMs?: number; retainedBinding?: boolean; options?: BridgeOptions; dryRun?: boolean }
  | { kind: "link"; method: "qr" | "code"; phone?: string }
  | { kind: "stop" }
  | { kind: "logout"; reqId?: string }
  | { kind: "reserve"; reqId: string; chatId: string; payload: { type: "text"; text: string } | { type: "audio" } }
  | { kind: "authorize"; chatId: string; generation: number }
  | { kind: "send"; reqId: string; chatId: string; generation?: number; ids: string[]; payload: { type: "text"; text: string; quote?: QuoteRef } | { type: "audio"; name: string; mime: string; bytesBase64: string } }
  | { kind: "presence"; chatId: string; state: "composing" | "paused" }
  | { kind: "read"; keys: MessageKeyRef[] }
  | { kind: "groups"; reqId: string }
  | { kind: "resolve"; reqId: string; op: "pn-for-lid" | "lid-for-pn"; jid: string }
  | { kind: "replay" }
  | { kind: "ack"; seq: number }
  | { kind: "ping"; n: number };

/** Child to host. */
export type ChildMessage =
  | { kind: "ready"; v: number; baileysVersion?: string; jimp?: boolean; platform?: string; arch?: string; electronVersion?: string }
  | { kind: "initialized" }
  | { kind: "pong"; n: number }
  | { kind: "qr"; text: string; version: number; issuedAt: number }
  | { kind: "pairing-code"; code: string; phone: string }
  | { kind: "connection"; state: LinkState; self?: { pn: string; lid?: string }; decision?: CloseDecision; blockedReason?: BlockedReason; attempt?: number; retryInMs?: number; lastSeenAtMs?: number; webVersion?: [number, number, number] }
  | { kind: "inbound"; seq: number; envelope: InboundEnvelope }
  | { kind: "reserved"; reqId: string; ids: string[] }
  | { kind: "send-result"; reqId: string; ok: true; ids: string[] }
  | { kind: "send-result"; reqId: string; ok: false; error: SendErrorWire; sentIds: string[] }
  | { kind: "dry-run"; reqId: string; chatId: string; ids: string[]; chunks: string[] }
  | { kind: "result"; reqId: string; ok: true; value?: unknown }
  | { kind: "result"; reqId: string; ok: false; error: SendErrorWire }
  | { kind: "status"; admittedAtMs?: number; ingressWriteFailed?: { remoteJid: string; id: string }; catchUpTruncated?: boolean; credsPersisted?: boolean; replayed?: number }
  | { kind: "fatal"; message: string }
  | { kind: "log"; level: "debug" | "info" | "warn" | "error"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max;
const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const STATES: ReadonlySet<string> = new Set(["idle", "linking", "restarting", "connected", "retry", "logged-out", "conflict", "blocked"]);
const ERROR_CODES: ReadonlySet<string> = new Set(["auth", "forbidden", "rate-limit", "offline", "timeout", "unavailable"]);
const MEDIA_KINDS: ReadonlySet<string> = new Set(["image", "audio", "video", "document", "sticker", "location", "contact"]);

function keyRef(value: unknown): MessageKeyRef | null {
  if (!isRecord(value) || !str(value.remoteJid, 200) || !str(value.id, 200)) return null;
  if (value.participant !== undefined && !str(value.participant, 200)) return null;
  return {
    remoteJid: value.remoteJid,
    id: value.id,
    ...(typeof value.fromMe === "boolean" ? { fromMe: value.fromMe } : {}),
    ...(typeof value.participant === "string" ? { participant: value.participant } : {}),
  };
}

function quoteRef(value: unknown): QuoteRef | null {
  const key = keyRef(value);
  if (!key) return null;
  const text = (value as Record<string, unknown>).text;
  if (text !== undefined && !str(text, 600)) return null;
  return { ...key, ...(typeof text === "string" ? { text } : {}) };
}

const version3 = (value: unknown): [number, number, number] | undefined =>
  Array.isArray(value) && value.length === 3 && value.every((n) => Number.isInteger(n) && n >= 0) ? [value[0], value[1], value[2]] : undefined;

const idList = (value: unknown, max = 200): string[] | null =>
  Array.isArray(value) && value.length >= 1 && value.length <= max && value.every((id) => str(id, 200) && id.length > 0) ? (value as string[]) : null;

export function parseHostMessage(raw: unknown): HostMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "init": {
      if (raw.v !== PROTOCOL_VERSION || !str(raw.connectionId, 100) || !/^[A-Za-z0-9_-]+$/.test(raw.connectionId)) return null;
      if (!str(raw.dataDir, 1024) || raw.dataDir.length === 0) return null;
      if (typeof raw.authKeyHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(raw.authKeyHex)) return null;
      if ((raw.mode !== "self-chat" && raw.mode !== "contacts") || !str(raw.appVersion, 64)) return null;
      const version = version3(raw.lastGoodWebVersion);
      let options: BridgeOptions | undefined;
      if (raw.options !== undefined) {
        if (!isRecord(raw.options)) return null;
        const o = raw.options;
        const quote = o.quoteReplies;
        if (quote !== undefined && quote !== "off" && quote !== "groups" && quote !== "all") return null;
        let access: BridgeOptions["access"];
        if (o.access !== undefined) {
          const a = o.access;
          if (!isRecord(a) || !Array.isArray(a.allowFrom) || !a.allowFrom.every(x => str(x, 200)) || !isRecord(a.groups)) return null;
          const g = a.groups;
          if (!["disabled", "allowlist"].includes(String(g.policy)) || !["members", "allowlist"].includes(String(g.senders)) || !Array.isArray(g.allow) ||
            !g.allow.every(x => isRecord(x) && str(x.jid, 200) && ["mention", "always"].includes(String(x.activation)) && (x.name === undefined || str(x.name, 120)))) return null;
          access = { allowFrom: a.allowFrom as string[], groups: g as unknown as import("./access.ts").GroupsPolicy };
        }
        options = {
          ...(access ? { access } : {}),
          ...(typeof o.readReceipts === "boolean" ? { readReceipts: o.readReceipts } : {}),
          ...(quote ? { quoteReplies: quote } : {}),
          ...(typeof o.enableWatchdog === "boolean" ? { enableWatchdog: o.enableWatchdog } : {}),
        };
      }
      return {
        kind: "init", v: PROTOCOL_VERSION, connectionId: raw.connectionId, dataDir: raw.dataDir, authKeyHex: raw.authKeyHex, mode: raw.mode, appVersion: raw.appVersion,
        ...(version ? { lastGoodWebVersion: version } : {}),
        ...(num(raw.lastSeenAtMs) ? { lastSeenAtMs: raw.lastSeenAtMs } : {}),
        ...(options ? { options } : {}),
        ...(raw.dryRun === true ? { dryRun: true } : {}),
        ...(raw.retainedBinding === true ? { retainedBinding: true } : {}),
      };
    }
    case "link":
      if (raw.method === "qr") return { kind: "link", method: "qr" };
      if (raw.method === "code" && typeof raw.phone === "string" && /^\d{6,15}$/.test(raw.phone)) return { kind: "link", method: "code", phone: raw.phone };
      return null;
    case "stop":
      return { kind: "stop" };
    case "logout":
      return raw.reqId === undefined || str(raw.reqId, 100) ? { kind: "logout", ...(typeof raw.reqId === "string" ? { reqId: raw.reqId } : {}) } : null;
    case "reserve": {
      if (!str(raw.reqId, 100) || !str(raw.chatId, 200) || !isRecord(raw.payload)) return null;
      if (raw.payload.type === "audio") return { kind: "reserve", reqId: raw.reqId, chatId: raw.chatId, payload: { type: "audio" } };
      if (raw.payload.type === "text" && typeof raw.payload.text === "string" && raw.payload.text.length <= 200_000) return { kind: "reserve", reqId: raw.reqId, chatId: raw.chatId, payload: { type: "text", text: raw.payload.text } };
      return null;
    }
    case "authorize":
      return str(raw.chatId, 200) && Number.isSafeInteger(raw.generation) && Number(raw.generation) >= 0 ? { kind: "authorize", chatId: raw.chatId, generation: Number(raw.generation) } : null;
    case "send": {
      if (raw.generation !== undefined && (!Number.isSafeInteger(raw.generation) || Number(raw.generation) < 0)) return null;
      if (!str(raw.reqId, 100) || !str(raw.chatId, 200) || !isRecord(raw.payload)) return null;
      const ids = idList(raw.ids);
      if (!ids) return null;
      const p = raw.payload;
      if (p.type === "text") {
        if (typeof p.text !== "string" || p.text.length > 200_000) return null;
        const quote = p.quote === undefined ? undefined : quoteRef(p.quote);
        if (quote === null) return null;
        return { kind: "send", reqId: raw.reqId, chatId: raw.chatId, ...(raw.generation !== undefined ? { generation: Number(raw.generation) } : {}), ids, payload: { type: "text", text: p.text, ...(quote ? { quote } : {}) } };
      }
      if (p.type === "audio") {
        if (!str(p.name, 200) || !str(p.mime, 100) || typeof p.bytesBase64 !== "string" || p.bytesBase64.length > MAX_FRAME_BYTES) return null;
        return { kind: "send", reqId: raw.reqId, chatId: raw.chatId, ...(raw.generation !== undefined ? { generation: Number(raw.generation) } : {}), ids, payload: { type: "audio", name: p.name, mime: p.mime, bytesBase64: p.bytesBase64 } };
      }
      return null;
    }
    case "presence":
      return str(raw.chatId, 200) && (raw.state === "composing" || raw.state === "paused") ? { kind: "presence", chatId: raw.chatId, state: raw.state } : null;
    case "read": {
      if (!Array.isArray(raw.keys) || raw.keys.length > 100) return null;
      const keys = raw.keys.map(keyRef);
      return keys.every((k): k is MessageKeyRef => k !== null) ? { kind: "read", keys } : null;
    }
    case "groups":
      return str(raw.reqId, 100) ? { kind: "groups", reqId: raw.reqId } : null;
    case "resolve":
      return str(raw.reqId, 100) && (raw.op === "pn-for-lid" || raw.op === "lid-for-pn") && str(raw.jid, 200) ? { kind: "resolve", reqId: raw.reqId, op: raw.op, jid: raw.jid } : null;
    case "replay":
      return { kind: "replay" };
    case "ack":
      return typeof raw.seq === "number" && Number.isInteger(raw.seq) && raw.seq >= 0 ? { kind: "ack", seq: raw.seq } : null;
    case "ping":
      return num(raw.n) ? { kind: "ping", n: raw.n } : null;
    default:
      return null;
  }
}

function sendError(value: unknown): SendErrorWire | null {
  if (!isRecord(value) || typeof value.code !== "string" || !ERROR_CODES.has(value.code) || !str(value.message, 2000)) return null;
  return {
    code: value.code as SendErrorWire["code"],
    message: value.message,
    ...(value.uncertain === true ? { uncertain: true } : {}),
    ...(num(value.retryAfterSeconds) ? { retryAfterSeconds: value.retryAfterSeconds } : {}),
  };
}

function envelope(value: unknown): InboundEnvelope | null {
  if (!isRecord(value) || !str(value.messageId, 200) || !str(value.chatJid, 200) || typeof value.fromMe !== "boolean" || !num(value.timestampMs)) return null;
  if (value.upsertType !== "notify" && value.upsertType !== "append") return null;
  const optional = (field: string, max: number): string | undefined | null => (value[field] === undefined ? undefined : str(value[field], max) ? (value[field] as string) : null);
  const chatJidAlt = optional("chatJidAlt", 200), pushName = optional("pushName", 400), participant = optional("participant", 200), participantAlt = optional("participantAlt", 200), text = optional("text", 200_000);
  if ([chatJidAlt, pushName, participant, participantAlt, text].includes(null)) return null;
  if (!Array.isArray(value.mentionedJids) || value.mentionedJids.length > 1000 || !value.mentionedJids.every((jid) => str(jid, 200))) return null;
  let quoted: InboundEnvelope["quoted"];
  if (value.quoted !== undefined) {
    const q = value.quoted;
    if (!isRecord(q) || !str(q.id, 200) || (q.participant !== undefined && !str(q.participant, 200)) || (q.text !== undefined && !str(q.text, 600))) return null;
    quoted = { id: q.id, ...(typeof q.participant === "string" ? { participant: q.participant } : {}), ...(typeof q.text === "string" ? { text: q.text } : {}), ...(q.outbound === true ? { outbound: true } : {}) };
  }
  let media: MediaDescriptor | undefined;
  if (value.media !== undefined) {
    const m = value.media;
    if (!isRecord(m) || typeof m.kind !== "string" || !MEDIA_KINDS.has(m.kind)) return null;
    for (const field of ["mime", "name", "path", "caption"]) if (m[field] !== undefined && !str(m[field], 4000)) return null;
    media = {
      kind: m.kind as MediaKind,
      ...(typeof m.mime === "string" ? { mime: m.mime } : {}),
      ...(num(m.bytes) ? { bytes: m.bytes } : {}),
      ...(typeof m.name === "string" ? { name: m.name } : {}),
      ...(num(m.seconds) ? { seconds: m.seconds } : {}),
      ...(typeof m.ptt === "boolean" ? { ptt: m.ptt } : {}),
      ...(typeof m.path === "string" ? { path: m.path } : {}),
      ...(typeof m.caption === "string" ? { caption: m.caption } : {}),
    };
  }
  return {
    messageId: value.messageId, chatJid: value.chatJid, fromMe: value.fromMe, timestampMs: value.timestampMs, upsertType: value.upsertType, mentionedJids: value.mentionedJids as string[],
    ...(chatJidAlt ? { chatJidAlt } : {}), ...(pushName ? { pushName } : {}), ...(participant ? { participant } : {}), ...(participantAlt ? { participantAlt } : {}),
    ...(text !== undefined ? { text: text as string } : {}), ...(quoted ? { quoted } : {}), ...(media ? { media } : {}),
  };
}

export function parseChildMessage(raw: unknown): ChildMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "ready":
      return raw.v === PROTOCOL_VERSION ? { kind: "ready", v: PROTOCOL_VERSION, ...(str(raw.baileysVersion, 100) ? { baileysVersion: raw.baileysVersion } : {}), ...(typeof raw.jimp === "boolean" ? { jimp: raw.jimp } : {}), ...(str(raw.platform, 30) ? { platform: raw.platform } : {}), ...(str(raw.arch, 30) ? { arch: raw.arch } : {}), ...(str(raw.electronVersion, 100) ? { electronVersion: raw.electronVersion } : {}) } : null;
    case "initialized": return { kind: "initialized" };
    case "pong":
      return num(raw.n) ? { kind: "pong", n: raw.n } : null;
    case "qr":
      return str(raw.text, 4096) && typeof raw.version === "number" && Number.isInteger(raw.version) && num(raw.issuedAt)
        ? { kind: "qr", text: raw.text, version: raw.version, issuedAt: raw.issuedAt }
        : null;
    case "pairing-code":
      return typeof raw.code === "string" && /^[A-Za-z0-9]{8}$/.test(raw.code) && str(raw.phone, 32) ? { kind: "pairing-code", code: raw.code, phone: raw.phone } : null;
    case "connection": {
      if (typeof raw.state !== "string" || !STATES.has(raw.state)) return null;
      const self = isRecord(raw.self) && str(raw.self.pn, 200)
        ? { pn: raw.self.pn, ...(str(raw.self.lid, 200) ? { lid: raw.self.lid } : {}) }
        : undefined;
      const decision = isRecord(raw.decision) && typeof raw.decision.action === "string" ? (raw.decision as unknown as CloseDecision) : undefined;
      const webVersion = version3(raw.webVersion);
      return {
        kind: "connection",
        state: raw.state as LinkState,
        ...(self ? { self } : {}),
        ...(decision ? { decision } : {}),
        ...(typeof raw.blockedReason === "string" ? { blockedReason: raw.blockedReason as BlockedReason } : {}),
        ...(typeof raw.attempt === "number" && Number.isInteger(raw.attempt) ? { attempt: raw.attempt } : {}),
        ...(num(raw.retryInMs) ? { retryInMs: raw.retryInMs } : {}),
        ...(num(raw.lastSeenAtMs) ? { lastSeenAtMs: raw.lastSeenAtMs } : {}),
        ...(webVersion ? { webVersion } : {}),
      };
    }
    case "inbound": {
      if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 0) return null;
      const parsed = envelope(raw.envelope);
      return parsed ? { kind: "inbound", seq: raw.seq, envelope: parsed } : null;
    }
    case "reserved": {
      const ids = idList(raw.ids);
      return str(raw.reqId, 100) && ids ? { kind: "reserved", reqId: raw.reqId, ids } : null;
    }
    case "send-result": {
      if (!str(raw.reqId, 100)) return null;
      if (raw.ok === true) {
        const ids = idList(raw.ids);
        return ids ? { kind: "send-result", reqId: raw.reqId, ok: true, ids } : null;
      }
      const error = raw.ok === false ? sendError(raw.error) : null;
      const sent = Array.isArray(raw.sentIds) && raw.sentIds.length <= 200 && raw.sentIds.every((id) => str(id, 200)) ? (raw.sentIds as string[]) : null;
      return error && sent ? { kind: "send-result", reqId: raw.reqId, ok: false, error, sentIds: sent } : null;
    }
    case "dry-run": {
      const ids = idList(raw.ids);
      const chunks = Array.isArray(raw.chunks) && raw.chunks.length <= 200 && raw.chunks.every((c) => str(c, 100_000)) ? (raw.chunks as string[]) : null;
      return str(raw.reqId, 100) && str(raw.chatId, 200) && ids && chunks ? { kind: "dry-run", reqId: raw.reqId, chatId: raw.chatId, ids, chunks } : null;
    }
    case "result": {
      if (!str(raw.reqId, 100)) return null;
      if (raw.ok === true) return { kind: "result", reqId: raw.reqId, ok: true, ...(raw.value !== undefined ? { value: raw.value } : {}) };
      const error = raw.ok === false ? sendError(raw.error) : null;
      return error ? { kind: "result", reqId: raw.reqId, ok: false, error } : null;
    }
    case "status": {
      const failed = raw.ingressWriteFailed;
      if (failed !== undefined && !(isRecord(failed) && str(failed.remoteJid, 200) && str(failed.id, 200))) return null;
      return {
        kind: "status",
        ...(num(raw.admittedAtMs) ? { admittedAtMs: raw.admittedAtMs } : {}),
        ...(failed ? { ingressWriteFailed: { remoteJid: (failed as { remoteJid: string }).remoteJid, id: (failed as { id: string }).id } } : {}),
        ...(typeof raw.catchUpTruncated === "boolean" ? { catchUpTruncated: raw.catchUpTruncated } : {}),
        ...(typeof raw.credsPersisted === "boolean" ? { credsPersisted: raw.credsPersisted } : {}),
        ...(typeof raw.replayed === "number" && Number.isInteger(raw.replayed) ? { replayed: raw.replayed } : {}),
      };
    }
    case "fatal":
      return str(raw.message, 4000) ? { kind: "fatal", message: raw.message } : null;
    case "log":
      return (raw.level === "debug" || raw.level === "info" || raw.level === "warn" || raw.level === "error") && str(raw.message, 4000)
        ? { kind: "log", level: raw.level, message: raw.message }
        : null;
    default:
      return null;
  }
}

const SECRET_FIELDS: ReadonlySet<string> = new Set(["text", "qr", "authKeyHex", "bytesBase64", "creds", "code", "key", "keys", "bytes", "chunks", "caption", "pushName", "quoted", "noiseKey", "signedIdentityKey", "advSecretKey"]);

/**
 * A log-safe copy of a protocol message: QR text, the pairing code, the auth
 * key, audio bytes, message bodies and any creds fields are replaced with a
 * marker (design 2.2 and 7.4). A `log` message keeps its own `message` field.
 */
export function redactForLog(message: unknown, depth = 0): unknown {
  if (Array.isArray(message)) return depth > 4 ? "[deep]" : message.map((item) => redactForLog(item, depth + 1));
  if (!isRecord(message)) return typeof message === "string" && message.length > 200 ? `${message.slice(0, 200)}...` : message;
  if (depth > 4) return "[deep]";
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(message)) out[field] = SECRET_FIELDS.has(field) ? "[redacted]" : redactForLog(value, depth + 1);
  return out;
}

/** Respawn delay: doubles from 5 s to 30 min (design 4). `failures` is the count of consecutive crashes, 1-based. */
export function respawnDelay(failures: number): number {
  return Math.min(RESPAWN_BACKOFF_MAX_MS, RESPAWN_BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));
}
