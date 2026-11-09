// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { searchMessagesWithMeta, TRIGRAM_CANDIDATE_CAP, newestVisibleHit, GROUPED_WALK_ROWS, type SearchHit, type SearchAudience } from "./message-db.ts";
import { type ChatRow, type ChatFilters, newerFirst } from "./chat-list.ts";
import type { ChatsGen } from "./thread-summary.ts";

export interface ThreadHit extends SearchHit { hits: number; countComplete: boolean }
export interface ChatSearchPage { hits: ThreadHit[]; next: string | null; partial: boolean }
export function parseSearchBefore(value: string | null): { at: number; threadId?: string } | undefined | null {
  if (value === null) return undefined;
  const match = /^(\d+(?:\.\d+)?)(?::([\w-]+))?$/.exec(value);
  return match && Number.isFinite(Number(match[1])) ? { at: Number(match[1]), threadId: match[2] } : null;
}
export type ChatCursor = Pick<ChatRow, "threadId" | "createdAt" | "lastActivityAt" | "pinned">;
export interface GroupedContinuation {
  v: 1; after: ChatCursor | null;
  pending: { thread: ChatCursor; beforeAt: number; beforeRowid: number } | null;
  gen: ChatsGen; query: string; filters: string;
}
export const normalizedSearchFilters = (filters: ChatFilters) => JSON.stringify(Object.entries(filters).filter(([key, value]) => key !== "q" && value !== undefined && value !== false).sort(([a], [b]) => a.localeCompare(b)));
export const encodeGroupedContinuation = (value: GroupedContinuation) => Buffer.from(JSON.stringify(value)).toString("base64url");
const key = (row: ChatCursor): ChatCursor => ({ threadId: row.threadId, createdAt: row.createdAt, ...(row.lastActivityAt !== undefined ? { lastActivityAt: row.lastActivityAt } : {}), ...(row.pinned ? { pinned: true } : {}) });
const validKey = (row: any): boolean => row && typeof row.threadId === "string" && /^[\w-]{1,256}$/.test(row.threadId) && Number.isFinite(row.createdAt) && (row.lastActivityAt === undefined || Number.isFinite(row.lastActivityAt)) && (row.pinned === undefined || row.pinned === true);
export function parseGroupedContinuation(raw: string | null, query: string, filters: ChatFilters): GroupedContinuation | undefined | null {
  if (raw === null) return undefined;
  if (raw.length > 16384 || !/^[\w-]+$/.test(raw)) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (value.v !== 1 || value.query !== query.trim() || value.filters !== normalizedSearchFilters(filters) ||
      !value.gen || typeof value.gen.epoch !== "string" || !Number.isSafeInteger(value.gen.rev) || value.gen.rev < 0 ||
      !(value.after === null || validKey(value.after)) || !(value.pending === null || validKey(value.pending.thread) && Number.isFinite(value.pending.beforeAt) && Number.isSafeInteger(value.pending.beforeRowid) && value.pending.beforeRowid > 0)) return null;
    return value;
  } catch { return null; }
}

/** A complete candidate window decides chats; a partial one is only a hint.
 * Every cut carries the exact last examined message pair, never preview text. */
export function searchChatThreads(query: string, limit: number, orderedScope: readonly ChatRow[], from?: GroupedContinuation, gen: ChatsGen = { epoch: "fixture", rev: 0 }, filters: ChatFilters = {}, rendered?: SearchAudience["rendered"]): ChatSearchPage {
  const size = Math.max(1, Math.min(100, Math.trunc(limit)));
  let after = from?.after ?? null;
  const pending = from?.pending;
  const rows = orderedScope.filter(row => (!after || newerFirst(row, after as ChatRow) > 0) && (!pending || row.threadId !== pending.thread.threadId));
  const pendingRow = pending && orderedScope.find(row => row.threadId === pending.thread.threadId);
  if (pending && !pendingRow) after = pending.thread;
  const remaining = pending ? rows.filter(row => newerFirst(row, pending.thread as ChatRow) > 0) : rows;
  const work = pendingRow ? [pendingRow, ...remaining] : remaining;
  const window = searchMessagesWithMeta(query, TRIGRAM_CANDIDATE_CAP, work.map(row => row.threadId), { owner: true, excludeForgotten: true, rendered });
  const groups = new Map<string, ThreadHit>();
  if (!window.partial) for (const hit of window.hits) {
    const held = groups.get(hit.threadId);
    if (held) held.hits++; else groups.set(hit.threadId, { ...hit, hits: 1, countComplete: true });
  }
  const hits: ThreadHit[] = [];
  let budget = GROUPED_WALK_ROWS;
  const continuation = (unfinished: GroupedContinuation["pending"]) => encodeGroupedContinuation({ v: 1, after, pending: unfinished, gen, query: query.trim(), filters: normalizedSearchFilters(filters) });
  for (let index = 0; index < work.length; index++) {
    const row = work[index]!;
    if (budget === 0) return { hits, next: continuation(null), partial: true };
    let hit = groups.get(row.threadId);
    if (window.partial || row.threadId === pending?.thread.threadId) {
      const walked = newestVisibleHit(query, row.threadId, budget, row.threadId === pending?.thread.threadId ? { at: pending.beforeAt, rowid: pending.beforeRowid } : undefined, rendered);
      budget -= walked.walked;
      if (walked.cut) return { hits, next: continuation({ thread: row.threadId === pending?.thread.threadId ? pending.thread : key(row), beforeAt: walked.position!.at, beforeRowid: walked.position!.rowid }), partial: true };
      hit = walked.hit ? { ...walked.hit, hits: walked.hits, countComplete: walked.countComplete } : undefined;
    }
    after = row.threadId === pending?.thread.threadId ? pending.thread : key(row);
    if (hit) hits.push(hit);
    if (hits.length === size) return { hits, next: index + 1 < work.length ? continuation(null) : null, partial: false };
  }
  return { hits, next: null, partial: false };
}
