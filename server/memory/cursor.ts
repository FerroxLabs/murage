// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search page cursors that tell a reader nothing. The helper pages its candidates by record id, so its raw cursor is the id
// of a record that may be one this reader is not allowed to see (msearch review round 3). The reader gets an opaque token
// instead: the raw cursor, the reader it was handed to (bot, thread, scopes, policy revision, deletion epoch, history mode)
// and an expiry, sealed with AES-256-GCM under a key that exists only in this process.
//
// The token is stateless. Nothing is stored per token, so there is no table for one reader to fill and no quota to
// evict another reader's token from (msearch review round 4: 256 tokens issued to B invalidated A's fresh token). A token
// from another reader, another policy revision, another history mode, an earlier run of the app, a tampered token or an
// expired one is refused; the binding is authenticated, not just compared. The plaintext is padded to one fixed size, so
// the length of a token says nothing about the id inside it.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { CURSOR_PLAINTEXT_BYTES, MEMORY_CURSOR_MAX_CHARS } from "./cursor-limits.ts";

const LIFETIME_MS = 10 * 60_000;
/** Plaintext size in bytes: 6 bytes of expiry, then the raw cursor, padded with spaces. A raw cursor that does not fit is a bug, not a token. */
const PLAINTEXT_BYTES = CURSOR_PLAINTEXT_BYTES;
export { MEMORY_CURSOR_MAX_CHARS };
const KEY = randomBytes(32);

export interface CursorReader { botId: string; threadId: string; scopeIds: readonly string[]; policyRevision: number; deletionEpoch: number }
const bindingOf = (reader: CursorReader, historical: boolean) => createHash("sha256")
  .update(JSON.stringify([reader.botId, reader.threadId, [...reader.scopeIds].sort(), reader.policyRevision, reader.deletionEpoch, historical])).digest();

/** The token a reader is handed in place of the helper's raw cursor. */
export function sealMemoryCursor(raw: string, reader: CursorReader, historical: boolean, now = Date.now()): string {
  const body = Buffer.from(raw, "utf8");
  if (6 + body.length > PLAINTEXT_BYTES) throw new Error("MEMORY_CURSOR_TOO_LARGE");
  const expiry = Buffer.alloc(6); expiry.writeUIntBE(now + LIFETIME_MS, 0, 6);
  const padded = Buffer.concat([expiry, body, Buffer.alloc(PLAINTEXT_BYTES - 6 - body.length, 0x20)]);
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", KEY, iv);
  cipher.setAAD(bindingOf(reader, historical));
  const sealed = Buffer.concat([cipher.update(padded), cipher.final()]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url");
}

const refused = () => Object.assign(new Error("INVALID_MEMORY_CURSOR: search again from the first page"), { status: 400 });

/** The raw cursor behind a token this reader was handed; "" for no cursor. Anything else is refused. */
export function openMemoryCursor(token: string, reader: CursorReader, historical: boolean, now = Date.now()): string {
  if (token === "") return "";
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 12 + PLAINTEXT_BYTES + 16) throw refused();
  try {
    const decipher = createDecipheriv("aes-256-gcm", KEY, bytes.subarray(0, 12));
    decipher.setAAD(bindingOf(reader, historical));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const plain = Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]);
    if (plain.readUIntBE(0, 6) <= now) throw refused();
    return plain.subarray(6).toString("utf8").trimEnd();
  } catch { throw refused(); }
}

/** Kept for tests that start from a clean slate: tokens hold no state, so there is nothing to clear. */
export function resetMemoryCursors(): void { /* stateless */ }
