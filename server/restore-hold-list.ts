// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a restore is keeping for the owner, with enough words to tell each item apart: whose it is, which conversation
// it belongs to, a short preview and when. The owner releases an item from Settings > Backups; nothing else does.
import type { DatabaseSync } from "node:sqlite";
import { heldItems } from "./restore-fence.ts";

export interface HeldItemView {
  id: string;
  generation: string;
  /** The bot the item belongs to. */
  bot: string;
  /** The conversation it was made in (or will be posted to). */
  conversation: string;
  preview: string;
  /** Epoch ms. */
  at: number;
}

export interface HeldItemDeps {
  botName(botId: string): string | undefined;
  threadTitle(threadId: string): string | undefined;
  /** The conversation a finished shared request posts back to. */
  sharedDestination(requestId: string): string | undefined;
  sharedRequest(requestId: string): { toBotId: string | null; targetThreadId: string | null; resultMessageId: string | null; outcomeNote: string | null; finishedAt: number | null; createdAt: number } | undefined;
  messageText(threadId: string, messageId: string): string | undefined;
}

const PREVIEW_CHARS = 120;
const preview = (text: string | undefined | null) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);

/** Held saved outputs. Image operations are released by asking for the image again, so they are not listed. */
export function describeHeldOutputs(db: DatabaseSync, deps: HeldItemDeps): HeldItemView[] {
  const out: HeldItemView[] = [];
  for (const hold of heldItems(db, "output_receipt")) {
    const row = db.prepare("SELECT p.bot_id AS botId, p.thread_id AS threadId, p.mime AS mime, p.created_at AS at, a.name AS name FROM output_publications p LEFT JOIN artifacts a ON a.id=p.artifact_id WHERE p.id=? AND p.producer<>'image-operation'").get(hold.id) as { botId: string; threadId: string; mime: string; at: number; name: string | null } | undefined;
    if (!row) continue;
    out.push({ id: hold.id, generation: hold.generation, bot: deps.botName(row.botId) ?? "", conversation: deps.threadTitle(row.threadId) ?? "", preview: preview(row.name) || row.mime, at: Number(row.at) });
  }
  return out;
}

/** Held finished shared results. */
export function describeHeldSharedResults(db: DatabaseSync, deps: HeldItemDeps): HeldItemView[] {
  const out: HeldItemView[] = [];
  for (const hold of heldItems(db, "shared_result")) {
    const request = deps.sharedRequest(hold.id);
    if (!request) continue;
    const destination = deps.sharedDestination(hold.id);
    const text = request.targetThreadId && request.resultMessageId ? deps.messageText(request.targetThreadId, request.resultMessageId) : undefined;
    out.push({ id: hold.id, generation: hold.generation, bot: (request.toBotId ? deps.botName(request.toBotId) : undefined) ?? "", conversation: (destination ? deps.threadTitle(destination) : undefined) ?? "",
      preview: preview(text) || preview(request.outcomeNote), at: Number(request.finishedAt ?? request.createdAt) });
  }
  return out;
}
