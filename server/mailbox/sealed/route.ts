// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// V (email design r9 3.4, I-1/I-2): POST /api/mailbox/sealed/read and /api/mailbox/sealed/media, the only routes that return a sealed
// conversation's real rows and its managed files from sealed custody.
// Only the owner's own computer reads it: the local desktop renderer with its surface secret (isOwnersComputer) over loopback. Every
// Cloud identity (owner-desktop included), a paired phone and a browser get the same 404 as an unknown route. At most one page of
// ids per call, each an indexed lookup; nothing is read for a thread whose seal has not completed.
import type { IncomingHttpHeaders } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { isOwnersComputer } from "../../cloud-owner-surface.ts";
import { isLoopback } from "../../model-gateway.ts";
import { mailboxSealState } from "../custody.ts";
import { sealedMediaRead } from "../media-custody.ts";
import { ATTACHMENT_NAME_IN_JSON } from "../../transcript-backfill.ts";

export const SEALED_READ_PATH = "/api/mailbox/sealed/read";
export const SEALED_READ_PAGE = 50;

export function sealedReadAllowed(headers: IncomingHttpHeaders, query: URLSearchParams, remoteAddress: string | undefined): boolean {
  // isOwnersComputer is false on every Cloud home (cloud-owner-surface.ts), so the computer test already carries the Cloud leg
  return isOwnersComputer(headers, query) && isLoopback(remoteAddress);
}

export function sealedRead(db: DatabaseSync, body: unknown): { status: number; body: Record<string, unknown> } {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const threadId = typeof input.threadId === "string" && input.threadId.length <= 200 ? input.threadId : "";
  const ids = Array.isArray(input.ids) && input.ids.length >= 1 && input.ids.length <= SEALED_READ_PAGE
    && input.ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 200) ? [...new Set(input.ids as string[])] : null;
  if (!threadId || !ids) return { status: 400, body: { error: `Give a threadId and 1 to ${SEALED_READ_PAGE} message ids.` } };
  if (mailboxSealState(db, threadId) !== "complete") return { status: 409, body: { error: "Email privacy setup hasn't finished; this conversation is paused." } };
  const held = db.prepare("SELECT json FROM mailbox_sealed_rows WHERE thread_id=? AND message_id=?");
  // I-3: a signed approval stays canonical in the transcript table; it is the only raw row read from there.
  const canonical = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=? AND json_extract(json, '$.card.approvalId') IS NOT NULL");
  const messages = ids.flatMap(id => {
    const row = held.get(threadId, id) ?? canonical.get(threadId, id);
    return row ? [{ ...JSON.parse(String(row.json)) as Record<string, unknown>, id }] : [];
  });
  return { status: 200, body: { threadId, messages } };
}

export const SEALED_MEDIA_PATH = "/api/mailbox/sealed/media";

/** One managed file of a completed seal, from sealed custody only after its bytes matched the ledger (media-custody.ts). */
export function sealedMedia(db: DatabaseSync, dir: string, body: unknown): { status: number; body: Record<string, unknown> } {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const threadId = typeof input.threadId === "string" && input.threadId.length <= 200 ? input.threadId : "";
  const name = typeof input.name === "string" ? input.name.toLowerCase() : "";
  const shaped = new RegExp(`^${ATTACHMENT_NAME_IN_JSON.source}$`, "i");
  if (!threadId || !shaped.test(name)) return { status: 400, body: { error: "Give a threadId and one attachment name." } };
  if (mailboxSealState(db, threadId) !== "complete") return { status: 409, body: { error: "Email privacy setup hasn't finished; this conversation is paused." } };
  const held = sealedMediaRead(db, dir, threadId, name);
  if (!held) return { status: 404, body: { error: "not found" } };
  return { status: 200, body: { threadId, name, sha256: held.sha256, base64: held.bytes.toString("base64") } };
}
