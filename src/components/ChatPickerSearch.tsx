import { useEffect, useState } from "react";
import { useChatResource, type HitsPage } from "@/lib/chat-previews";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { chatsSearchPath, chatTitle, incompleteChatCount, type ChatFilters } from "@/lib/all-chats";
import type { SearchHit } from "@/lib/search-hit";
import { HighlightedChatHit } from "./ChatThreadMatches";

export function ChatPickerSearch({ query, scope, onOpen }: { query: string; scope: ChatFilters; onOpen: (hit: SearchHit) => void }) {
  const path = chatsSearchPath(query, { ...scope, routines: true });
  const [settledPath, setSettledPath] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => { setSettledPath(path); }, 250);
    return () => { clearTimeout(timer); };
  }, [path]);
  const held = useChatResource<HitsPage>(settledPath === path ? path : null);
  const hits = held.eligible ? held.data?.hits ?? [] : [];
  const next = held.data?.next;
  const partial = held.data?.partial;
  const busy = held.loading || !held.eligible;
  const failed = !!held.error;
  const more = () => { if (next) held.more(`${path}&before=${encodeURIComponent(next)}`, (old, page) => ({ ...page, hits: [...old.hits, ...page.hits.filter(hit => !old.hits.some(row => row.threadId === hit.threadId))] })); };
  return <section aria-label="Matches in messages" className="px-2 py-1 text-[12px] text-ink-secondary">
    {busy && <p role="status">Searching messages…</p>}
    {failed && <p role="alert">Could not search messages. Try again.</p>}
    {partial && <p>Showing matches from your most recent messages. Search is still getting ready for older ones.</p>}
    {!busy && !failed && hits.length === 0 && <p>No messages match “{query.trim()}”.</p>}
    {hits.map(hit => <button key={hit.threadId} type="button" onClick={() => onOpen(hit)} className="block w-full rounded px-2 py-2 text-left hover:bg-raised">
      <span className="block truncate text-ink">{hit.task ? chatTitle(hit.task) : "Chat"}</span>
      <span className="line-clamp-2"><HighlightedChatHit hit={hit} />{hit.countComplete !== true ? ` · ${incompleteChatCount(hit.hits ?? 1)}` : (hit.hits ?? 0) > 1 && ` · ${hit.hits} matches`}</span>
    </button>)}
    {next && <button type="button" disabled={busy} onClick={more} className="px-2 py-2">More results</button>}
  </section>;
}
