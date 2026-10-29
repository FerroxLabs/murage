// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The canonical payload of an email and its hash (design 3.4 step 1), the send id (UUIDv7) and the bot-facing reference (4.6).
import { createHash, randomBytes } from "node:crypto";

export interface DraftAttachment { name: string; contentType: string; bytes: Uint8Array }
export interface EmailDraft {
  kind: "send" | "reply";
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: DraftAttachment[];
  /** the inbound message a reply answers; null on a send */
  replyTo: string | null;
}

export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** Lower-case, trimmed addr-specs, de-duplicated and sorted. */
export function normalizeAddresses(list: readonly string[]): string[] {
  return [...new Set(list.map(address => address.trim().toLowerCase()).filter(Boolean))].sort();
}

/** kind, sorted lower-case to and cc, subject, text, attachment name/size/SHA-256 list, reply target: one fixed key order. */
export function canonicalPayload(draft: EmailDraft): string {
  return JSON.stringify({
    kind: draft.kind,
    to: normalizeAddresses(draft.to),
    cc: normalizeAddresses(draft.cc),
    subject: draft.subject,
    text: draft.text,
    attachments: draft.attachments.map(file => ({ name: file.name, size: file.bytes.byteLength, sha256: sha256Hex(file.bytes) })),
    reply_to: draft.replyTo,
  });
}
export const payloadHash = (draft: EmailDraft): string => sha256Hex(canonicalPayload(draft));

/** RFC 9562 UUIDv7: 48-bit Unix milliseconds, version 7, variant 10, the rest random. */
export function uuidv7(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  const bytes = new Uint8Array(16);
  let ms = BigInt(Math.max(0, Math.trunc(now)));
  for (let i = 5; i >= 0; i--) { bytes[i] = Number(ms & 0xffn); ms >>= 8n; }
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `E-` plus six characters of [A-Z0-9], derived from the send id (validated as ^E-[A-Z0-9]{6}$ by the status table). */
export function emailRef(sendId: string): string {
  const digest = createHash("sha256").update(`email-ref:${sendId}`).digest();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[digest[i] % alphabet.length];
  return `E-${out}`;
}

/** The Idempotency-Key of one attempt (3.4 step 4). */
export const sendIdempotencyKey = (installId: string, sendId: string, suffix: number): string => `murage-email:${installId}:${sendId}:${suffix}`;
export const keyIdempotencyKey = (installId: string, opId: string): string => `murage-key:${installId}:${opId}`;
export const inboxIdempotencyKey = (installId: string, opId: string): string => `murage-inbox:${installId}:${opId}`;
