// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/attachments/<name>: the checks the route makes, in order, kept out
// of index.ts so they are tested without a server.
//
// A name the caller may not see answers 404 before anything else. A name the
// owner removed from storage (1.0.4 SL-H H2a: its marker exists) answers 410
// {removed: true} before any read, again after the read, and again right
// before the first byte is written: a thumbnail resize can take a while, and
// a Remove made during it must not still serve the picture. A name with no
// marker keeps 1.0.3's answers: 404 when missing, 503 when the disk could not
// answer.
import type { AttachmentServe } from "./attachments.ts";

export interface Refused { status: number; body: unknown }
export const NOT_FOUND: Refused = { status: 404, body: { error: "no such attachment" } };
export const REMOVED: Refused = { status: 410, body: { removed: true } };
const COULD_NOT_READ: Refused = { status: 503, body: { error: "That image could not be read just now." } };

export interface AttachmentGetDeps {
  /** May this caller see the name (attachment-access.ts)? */
  visible: () => boolean;
  /** Does the name have a Remove marker, asked now (attachmentRemoved)? */
  removed: () => boolean;
  read: () => Promise<AttachmentServe>;
  warn?: (line: string) => void;
}

export type AttachmentGet =
  | { refused: Refused }
  | { attachment: Extract<AttachmentServe, { ok: true }>; recheck: () => Refused | null };

export async function attachmentGet(name: string, deps: AttachmentGetDeps): Promise<AttachmentGet> {
  const recheck = (): Refused | null => !deps.visible() ? NOT_FOUND : deps.removed() ? REMOVED : null;
  const before = recheck();
  if (before) return { refused: before };
  const attachment = await deps.read();
  if (!attachment.ok) {
    // A Remove that unlinked the file during the read is still a removal.
    if (deps.removed()) return { refused: REMOVED };
    // missing, not a plain file, too large or changed: the same 404 a
    // hidden name gets. A disk that could not answer: 503, never cached.
    if (attachment.reason !== "missing" && attachment.reason !== "changed") deps.warn?.(`[attachments] ${name} not served: ${attachment.reason}${attachment.code ? ` (${attachment.code})` : ""}`);
    if (attachment.reason === "io" || attachment.reason === "busy") return { refused: COULD_NOT_READ };
    return { refused: NOT_FOUND };
  }
  // Asked again after the read: hiding a conversation, or a Remove, while
  // the image was being read answers as it would have before it.
  const after = recheck();
  if (after) return { refused: after };
  return { attachment, recheck };
}
