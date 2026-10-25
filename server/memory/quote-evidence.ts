// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.5: a bot cites what it heard by its words. memory_save and memory_propose_correction took evidence only as
// {sourceId, revision, startByte, endByte}, and the only tools that ever hand a bot a sourceId are memory_search and
// memory_get, for lines already remembered. A bot with nothing remembered yet (or citing anything said in this
// conversation) could not form one at all: on the training rig Ember said the memory system "needs conversation sources
// in a specific format I couldn't provide" and wrote files instead. Now an evidence item may be {quote} (exact words from
// this conversation) or {quote, messageId} (a line thread_search or thread_read returned). Plain text arguments, the same
// on every engine. The server finds the captured line and the quote's exact bytes in it; every check a sourceId citation
// meets (scope, state, capture, tombstones) still runs on the result.
import type { DatabaseSync } from "node:sqlite";
import type { MemoryEvidenceHandle } from "../../shared/memory.ts";
import type { MemoryAccess } from "./policy.ts";

export interface QuotedEvidence { quote: string; messageId?: string }
export type MemoryEvidenceInput = MemoryEvidenceHandle | QuotedEvidence;
/** The newest captured lines of this conversation a bare quote is looked for in: bounded, never the whole history. */
export const QUOTE_LOOKBACK_SOURCES = 200;

const isQuoted = (item: MemoryEvidenceInput): item is QuotedEvidence => typeof (item as QuotedEvidence).quote === "string";
const refuse = (message: string) => Object.assign(new Error(message), { status: 400 });

/** Every quoted item resolved to the exact handle of the captured line that contains it; handles pass through unchanged. `prior`: the
 * evidence an earlier save with the same idempotency key rests on (authority.ts savedMemoryEvidence); a quote still found there, at the
 * same bytes, resolves to it, so a retried save meets the same evidence even after a newer line repeated the words. */
export function resolveQuotedEvidence<T extends MemoryEvidenceInput>(db: DatabaseSync, items: readonly T[], access: MemoryAccess, prior: readonly MemoryEvidenceHandle[] = []): MemoryEvidenceHandle[] {
  return items.map((item, index) => isQuoted(item) ? resolveOne(db, item, access, index, prior) : item as MemoryEvidenceHandle);
}

/** `handle` still names exactly `needle`'s bytes in an active line this turn may read. */
function priorHolds(db: DatabaseSync, handle: MemoryEvidenceHandle, needle: Buffer, access: MemoryAccess, messageId?: string): boolean {
  if (handle.endByte - handle.startByte !== needle.length) return false;
  const row = db.prepare(`SELECT s.scope_id,s.message_id,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=?
    WHERE s.id=? AND s.revision=? AND s.state='active' AND NOT (s.kind IN ('tool-outcome','activity') AND s.outcome='failed')`).get(handle.revision, handle.sourceId, handle.revision);
  if (!row || !access.scopeIds.includes(String(row.scope_id)) || (messageId !== undefined && String(row.message_id) !== messageId)) return false;
  try {
    const text: unknown = JSON.parse(String(row.payload)).text;
    return typeof text === "string" && Buffer.from(text).subarray(handle.startByte, handle.endByte).equals(needle);
  } catch { return false; }
}

function resolveOne(db: DatabaseSync, item: QuotedEvidence, access: MemoryAccess, index: number, prior: readonly MemoryEvidenceHandle[]): MemoryEvidenceHandle {
  const quote = item.quote.trim();
  if (!quote) throw refuse(`evidence.${index}.quote: give the exact words from the conversation.`);
  const needle = Buffer.from(quote);
  for (const handle of prior) if (priorHolds(db, handle, needle, access, item.messageId)) return handle;
  // A failed tool outcome is never evidence (saveCandidate refuses it too); a retired or deleted line is not cited.
  const rows = item.messageId
    ? db.prepare(`SELECT s.id,s.revision,s.scope_id,s.speaker,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
        WHERE s.message_id=? AND s.state='active' AND NOT (s.kind IN ('tool-outcome','activity') AND s.outcome='failed') ORDER BY v.created_at DESC LIMIT 8`).all(item.messageId)
    : db.prepare(`SELECT s.id,s.revision,s.scope_id,s.speaker,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision
        WHERE s.thread_id=? AND s.state='active' AND NOT (s.kind IN ('tool-outcome','activity') AND s.outcome='failed') ORDER BY v.created_at DESC, s.rowid DESC LIMIT ?`).all(access.threadId, QUOTE_LOOKBACK_SOURCES);
  // The newest line holding the words, except that the owner's own line wins over a newer echo of it (a bot repeating what the owner said):
  // the same words are stronger evidence in the owner's mouth, and learning holds a save that rests on another speaker (learnable.ts).
  let echo: MemoryEvidenceHandle | undefined;
  for (const row of rows) {
    // only lines this turn may read: the same scope rule every citation is checked against again on save
    if (!access.scopeIds.includes(String(row.scope_id))) continue;
    let text: unknown;
    try { text = JSON.parse(String(row.payload)).text; } catch { continue; }
    if (typeof text !== "string") continue;
    const at = Buffer.from(text).indexOf(needle);
    if (at === -1) continue;
    const handle = { sourceId: String(row.id), revision: Number(row.revision), startByte: at, endByte: at + needle.length };
    if (row.speaker === "owner") return handle;
    echo ??= handle;
  }
  if (echo) return echo;
  throw refuse(item.messageId
    ? `evidence.${index}.quote: those exact words are not in that message (or it is not one you can cite). Copy them exactly as written.`
    : `evidence.${index}.quote: those exact words are not in this conversation's saved lines. Copy a sentence exactly as it was written, or add the messageId thread_search returned for an older conversation.`);
}
