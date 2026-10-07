// Copyright 2026 Ferrox Labs
// Adapted from Hermes Agent scripts/whatsapp-bridge/bridge_helpers.js (unwrapMessageEnvelopes, getContextInfo)
// and OpenClaw extensions/whatsapp/src/inbound/media.ts (MIT, Nous Research and OpenClaw Foundation).
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turns a Baileys message into the plain envelope the host sees. Pure: no Baileys import, so it
// works on any object of the same shape (design 5.5, 5.6). Disappearing-message and view-once
// chats nest the real payload inside wrapper messages; those are peeled up to 8 deep so their text
// is not dropped (upstream delta 17).
import { stripDevice } from "./lid.ts";
import type { InboundEnvelope, MediaDescriptor, MediaKind } from "./protocol.ts";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const isObj = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);

const WRAPPERS = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension", "documentWithCaptionMessage"] as const;
export const MAX_UNWRAP_DEPTH = 8;

/** Peels ephemeral, view-once and document-with-caption wrappers (nested up to 8 deep) and returns the inner message. */
export function unwrapContent(message: unknown): Obj {
  let current: Obj = isObj(message) ? message : {};
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    let next: unknown;
    for (const wrapper of WRAPPERS) {
      const inner = current[wrapper]?.message;
      if (isObj(inner)) { next = inner; break; }
    }
    if (!next) break;
    current = next as Obj;
  }
  return current;
}

/** Hermes getContextInfo: the first nested object that carries a contextInfo. */
export function contextInfoOf(content: Obj): Obj {
  for (const value of Object.values(content)) if (isObj(value) && isObj(value.contextInfo)) return value.contextInfo;
  return {};
}

export function textOf(content: Obj): string {
  const candidates: unknown[] = [
    content.conversation,
    content.extendedTextMessage?.text,
    content.imageMessage?.caption,
    content.videoMessage?.caption,
    content.documentMessage?.caption,
    content.buttonsResponseMessage?.selectedDisplayText,
    content.listResponseMessage?.title,
    content.templateButtonReplyMessage?.selectedDisplayText,
  ];
  for (const candidate of candidates) if (typeof candidate === "string" && candidate) return candidate;
  return "";
}

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (isObj(value)) {
    if (typeof value.toNumber === "function") { const n = (value as { toNumber(): number }).toNumber(); return Number.isFinite(n) ? n : undefined; }
    if (typeof value.low === "number") return (value.high ?? 0) * 4294967296 + (value.low >>> 0);
  }
  return undefined;
};

/** Message time in milliseconds from a Baileys `messageTimestamp` (number, numeric string or Long). */
export function timestampMsOf(value: unknown, fallbackMs: number): number {
  const seconds = toNumber(value);
  return seconds && seconds > 0 ? seconds * 1000 : fallbackMs;
}

const MEDIA_FIELDS: ReadonlyArray<readonly [string, MediaKind]> = [
  ["imageMessage", "image"], ["audioMessage", "audio"], ["videoMessage", "video"], ["ptvMessage", "video"],
  ["documentMessage", "document"], ["stickerMessage", "sticker"], ["locationMessage", "location"], ["liveLocationMessage", "location"],
  ["contactMessage", "contact"], ["contactsArrayMessage", "contact"],
];

/** What kind of attachment this is, without downloading anything. */
export function mediaOf(content: Obj): MediaDescriptor | undefined {
  for (const [field, kind] of MEDIA_FIELDS) {
    const m = content[field];
    if (!isObj(m)) continue;
    const bytes = toNumber(m.fileLength);
    const seconds = toNumber(m.seconds);
    return {
      kind,
      ...(typeof m.mimetype === "string" && m.mimetype ? { mime: m.mimetype } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(typeof m.fileName === "string" && m.fileName ? { name: m.fileName } : kind === "contact" && typeof m.displayName === "string" ? { name: m.displayName } : {}),
      ...(seconds !== undefined ? { seconds } : {}),
      ...(kind === "audio" ? { ptt: m.ptt === true } : {}),
      ...(typeof m.caption === "string" && m.caption ? { caption: m.caption } : {}),
    };
  }
  return undefined;
}

export interface RawMessage {
  key?: { remoteJid?: string | null; remoteJidAlt?: string | null; fromMe?: boolean | null; id?: string | null; participant?: string | null; participantAlt?: string | null };
  message?: unknown;
  messageTimestamp?: unknown;
  pushName?: string | null;
}

/**
 * Normalises one received message. Returns null when it has no id or chat. The quoted text is capped
 * at 500 characters and never downloaded media (design 5.6, 6).
 */
export function envelopeOf(raw: RawMessage, upsertType: "notify" | "append", nowMs: number): InboundEnvelope | null {
  const key = raw.key ?? {};
  if (!key.remoteJid || !key.id) return null;
  const content = unwrapContent(raw.message);
  const ctx = contextInfoOf(content);
  const quotedContent = isObj(ctx.quotedMessage) ? unwrapContent(ctx.quotedMessage) : undefined;
  const quotedText = quotedContent ? textOf(quotedContent).slice(0, 500) : "";
  const media = mediaOf(content);
  const text = textOf(content);
  const mentions = Array.isArray(ctx.mentionedJid) ? (ctx.mentionedJid as unknown[]).filter((jid): jid is string => typeof jid === "string" && jid.length > 0).map(stripDevice) : [];
  return {
    messageId: key.id,
    chatJid: key.remoteJid,
    fromMe: key.fromMe === true,
    timestampMs: timestampMsOf(raw.messageTimestamp, nowMs),
    upsertType,
    mentionedJids: mentions,
    ...(key.remoteJidAlt ? { chatJidAlt: key.remoteJidAlt } : {}),
    ...(raw.pushName ? { pushName: raw.pushName } : {}),
    ...(key.participant ? { participant: key.participant } : {}),
    ...(key.participantAlt ? { participantAlt: key.participantAlt } : {}),
    ...(text ? { text } : {}),
    ...(typeof ctx.stanzaId === "string" && ctx.stanzaId
      ? { quoted: { id: ctx.stanzaId, ...(typeof ctx.participant === "string" && ctx.participant ? { participant: ctx.participant } : {}), ...(quotedText ? { text: quotedText } : {}) } }
      : {}),
    ...(media ? { media } : {}),
  };
}
