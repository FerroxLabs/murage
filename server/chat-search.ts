// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { searchMessagesWithMeta, TRIGRAM_CANDIDATE_CAP, type SearchHit } from "./message-db.ts";

export interface ThreadHit extends SearchHit { hits: number }
export interface ChatSearchPage { hits: ThreadHit[]; next: string | null; partial: boolean }
export function parseSearchBefore(value: string | null): { at: number; threadId?: string } | undefined | null {
  if (value === null) return undefined;
  const match = /^(\d+(?:\.\d+)?)(?::([\w-]+))?$/.exec(value);
  return match && Number.isFinite(Number(match[1])) ? { at: Number(match[1]), threadId: match[2] } : null;
}

/** Fold the bounded search candidate window before applying the chat limit.
 * Counts describe that window; partial stays true when older candidates have
 * not been examined. Paging uses each thread's best hit, including time ties,
 * so a prolific chat never takes several slots or reappears on the next page. */
export function searchChatThreads(query: string, limit: number, threads: readonly string[], before?: { at: number; threadId?: string }): ChatSearchPage {
  const found = searchMessagesWithMeta(query, TRIGRAM_CANDIDATE_CAP, threads, { owner: true, excludeForgotten: true }, before?.threadId ? undefined : before?.at);
  const groups = new Map<string, ThreadHit>();
  for (const hit of found.hits) {
    const prior = groups.get(hit.threadId);
    if (prior) prior.hits++;
    else groups.set(hit.threadId, { ...hit, hits: 1 });
  }
  const rows = [...groups.values()].sort((a, b) => b.at - a.at || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0))
    .filter(hit => !before?.threadId || hit.at < before.at || hit.at === before.at && hit.threadId > before.threadId);
  const size = Math.max(1, Math.min(100, Math.trunc(limit)));
  const hits = rows.slice(0, size);
  const last = hits[hits.length - 1];
  return { hits, next: rows.length > size && last ? `${last.at}:${last.threadId}` : null, partial: found.partial };
}
