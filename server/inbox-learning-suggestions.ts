// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Suggestions are the only learning in the Inbox (design section 12): a lesson
// that waits for the owner's yes (or an offer to share one, or a change to a skill or routine) is owed, like a question. Nothing else the
// bots learn ever lands here. Rides on the desktop's Inbox read beside the
// backup rows, and is counted in `decisions` the same way a stopped backup is
// (server/inbox-backup-notices.ts), because it is owed and no segment counts it.
import type { DatabaseSync } from "node:sqlite";
import type { InboxLearningSuggestion } from "../shared/inbox.ts";
import { recipientViews } from "./memory/lesson-sharing.ts";
import { listProcedureSuggestions } from "./memory/procedure-landing.ts";

export type { InboxLearningSuggestion };

/** One row per lesson waiting for a decision, newest first. `nameOf` drops bots that no longer exist. */
export function inboxSuggestionRows(db: DatabaseSync, nameOf: (botId: string) => string | undefined, botIds: readonly string[] = []): InboxLearningSuggestion[] {
  const rows = db.prepare(`SELECT id,version,bot_id,scope,recipients,kind,text,created_at FROM memory_lessons
    WHERE state='suggested' AND version=(SELECT MAX(version) FROM memory_lessons m WHERE m.id=memory_lessons.id)
    ORDER BY created_at DESC,rowid DESC LIMIT 50`).all() as Array<Record<string, any>>;
  const out: InboxLearningSuggestion[] = [];
  for (const row of rows) {
    const botName = nameOf(String(row.bot_id));
    if (botName === undefined) continue;
    const scope = row.scope === "bots" || row.scope === "team" ? row.scope as "bots" | "team" : undefined;
    // A share suggestion names the bots it is for; the owner can pick which ones in the bot's Learning section.
    const share = scope ? { scope, fromName: botName, recipients: recipientViews(row.recipients ? (JSON.parse(String(row.recipients)) as unknown[]).map(String) : null).map(r => ({ ...r, name: nameOf(r.id) ?? r.name })) } : {};
    out.push({ botId: String(row.bot_id), botName, lessonId: String(row.id), version: Number(row.version), text: String(row.text), at: Number(row.created_at), kind: "lesson", lessonKind: row.kind === "style" ? "style" : "note", ...share });
  }
  // Skill and routine changes waiting for the owner (psug-): the sentence only, never the whole skill text.
  for (const botId of botIds) {
    const botName = nameOf(botId);
    if (botName === undefined) continue;
    for (const item of listProcedureSuggestions(db, botId)) {
      out.push({ botId, botName, lessonId: item.id, version: item.version, text: item.summary, at: item.createdAt, kind: "procedure", targetKind: item.targetKind, label: item.label,
        summary: item.summary, reasons: [...item.reasons], proposedHash: item.proposedHash, edited: item.edited });
    }
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

/** The Inbox read with the suggestions attached and counted as owed. Unchanged when there are none. */
export function withLearningSuggestions<T extends { decisions?: number }>(body: T, rows: readonly InboxLearningSuggestion[]): T & { learningSuggestions?: InboxLearningSuggestion[] } {
  if (!rows.length) return body;
  return { ...body, learningSuggestions: [...rows], ...(typeof body.decisions === "number" ? { decisions: body.decisions + rows.length } : {}) };
}
