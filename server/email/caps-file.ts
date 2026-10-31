// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EMAIL-CAPS-CACHE-1011 (1.0.11 scope): the last DEFINITIVE #31 answer, kept in DATA_DIR/email-capabilities.json so a launch shows bot
// email at once and a network failure never hides it or turns it off. One entry only, keyed by a fingerprint of the saved Flux key
// (credentialFingerprint, a sha256 prefix; the key itself is never written). A file for another key is dropped at boot and never read.
// Not in the database and not restored: it describes the saved key, not the data.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Capabilities } from "./flux-email-client.ts";

export interface CapsFileEntry { v: 1; accountRef: string; caps: Capabilities; readAt: number }

/** The entry on disk, or null when there is none or it cannot be used (missing, unreadable, malformed, another version). */
export function readCapsFile(path: string): CapsFileEntry | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  try {
    const doc = JSON.parse(raw) as Partial<CapsFileEntry> | null;
    if (!doc || typeof doc !== "object" || Array.isArray(doc) || doc.v !== 1) return null;
    if (typeof doc.accountRef !== "string" || !doc.accountRef) return null;
    if (!doc.caps || typeof doc.caps !== "object" || Array.isArray(doc.caps) || typeof doc.caps.enabled !== "boolean") return null;
    if (typeof doc.readAt !== "number" || !Number.isFinite(doc.readAt)) return null;
    return { v: 1, accountRef: doc.accountRef, caps: doc.caps, readAt: doc.readAt };
  } catch { return null; }
}

/** Writes the one entry atomically (temp file, then rename), owner-only. Throws on failure; the caller logs and keeps memory state. */
export function writeCapsFile(path: string, entry: Omit<CapsFileEntry, "v">): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, accountRef: entry.accountRef, caps: entry.caps, readAt: entry.readAt }), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Removes the file (another key's answer). Never throws. */
export function dropCapsFile(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* the next definitive read overwrites it */ }
}
