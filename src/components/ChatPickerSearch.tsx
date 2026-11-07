// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { chatsSearchPath, chatTitle, type ChatFilters } from "@/lib/all-chats";
import type { SearchHit } from "@/lib/search-hit";
import { HighlightedChatHit } from "./ChatThreadMatches";

export function ChatPickerSearch({ query, scope, onOpen }: { query: string; scope: ChatFilters; onOpen: (hit: SearchHit) => void }) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const path = chatsSearchPath(query, { ...scope, routines: true });
  useEffect(() => {
    const mine = ++generation.current;
    setHits([]); setNext(null); setPartial(false); setBusy(true); setFailed(false);
    const timer = setTimeout(() => {
      api(path).then((answer: { hits: SearchHit[]; next?: string | null; partial?: boolean }) => {
        if (generation.current !== mine) return;
        setHits(answer.hits); setNext(answer.next ?? null); setPartial(Boolean(answer.partial)); setBusy(false);
      }).catch(() => { if (generation.current === mine) { setFailed(true); setBusy(false); } });
    }, 250);
    return () => { clearTimeout(timer); generation.current++; };
  }, [path]);
  const more = () => {
    if (!next || busy) return;
    const mine = generation.current; setBusy(true); setFailed(false);
    api(`${path}&before=${encodeURIComponent(next)}`).then((answer: { hits: SearchHit[]; next?: string | null; partial?: boolean }) => {
      if (generation.current !== mine) return;
      setHits(previous => [...previous, ...answer.hits.filter(hit => !previous.some(row => row.threadId === hit.threadId))]);
      setNext(answer.next ?? null); setPartial(Boolean(answer.partial)); setBusy(false);
    }).catch(() => { if (generation.current === mine) { setFailed(true); setBusy(false); } });
  };
  return <section aria-label="Matches in messages" className="px-2 py-1 text-[12px] text-ink-secondary">
    {busy && <p role="status">Searching messages…</p>}
    {failed && <p role="alert">Could not search messages. Try again.</p>}
    {partial && <p>Showing matches from your most recent messages. Search is still getting ready for older ones.</p>}
    {!busy && !failed && hits.length === 0 && <p>No messages match “{query.trim()}”.</p>}
    {hits.map(hit => <button key={hit.threadId} type="button" onClick={() => onOpen(hit)} className="block w-full rounded px-2 py-2 text-left hover:bg-raised">
      <span className="block truncate text-ink">{hit.task ? chatTitle(hit.task) : "Chat"}</span>
      <span className="line-clamp-2"><HighlightedChatHit hit={hit} />{(hit.hits ?? 0) > 1 && ` · ${hit.hits} matches`}</span>
    </button>)}
    {next && <button type="button" disabled={busy} onClick={more} className="px-2 py-2">More results</button>}
  </section>;
}
