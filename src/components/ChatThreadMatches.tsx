// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { chatsSearchPath, type ChatFilters } from "@/lib/all-chats";
import type { SearchHit } from "@/lib/search-hit";

export function HighlightedChatHit({ hit }: { hit: SearchHit }) {
  return <>{hit.snippet.slice(0, hit.matchStart)}<mark className="rounded-sm bg-accent/25 text-ink">{hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)}</mark>{hit.snippet.slice(hit.matchStart + hit.matchLength)}</>;
}

/** Expanded matches are fetched only on demand, through the same owner route. */
export function ChatThreadMatches({ query, threadId, filters, onOpen }: { query: string; threadId: string; filters: ChatFilters; onOpen: (hit: SearchHit) => void }) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const path = new URLSearchParams(chatsSearchPath(query, filters).split("?")[1]);
  path.delete("group_by"); path.set("threadId", threadId);
  const base = `/api/search?${path}`;
  useEffect(() => {
    const mine = ++generation.current;
    setHits([]); setNext(null); setBusy(true); setFailed(false);
    api(base).then((answer: { hits: SearchHit[]; next?: string | null }) => {
      if (generation.current === mine) { setHits(answer.hits); setNext(answer.next ?? null); setBusy(false); }
    }).catch(() => { if (generation.current === mine) { setFailed(true); setBusy(false); } });
    return () => { generation.current++; };
  }, [base]);
  const more = () => {
    if (busy || !next) return;
    const mine = generation.current; setBusy(true); setFailed(false);
    api(`${base}&before=${encodeURIComponent(next)}`).then((answer: { hits: SearchHit[]; next?: string | null }) => {
      if (generation.current !== mine) return;
      setHits(previous => [...previous, ...answer.hits.filter(hit => !previous.some(row => row.messageId === hit.messageId))]);
      setNext(answer.next ?? null); setBusy(false);
    }).catch(() => { if (generation.current === mine) { setFailed(true); setBusy(false); } });
  };
  return <div className="ml-10 border-l border-hairline/40 pl-2 text-[12.5px] text-ink-secondary">
    {hits.map(hit => <button key={hit.messageId} type="button" onClick={() => onOpen(hit)} className="block w-full rounded px-2 py-2 text-left hover:bg-raised"><HighlightedChatHit hit={hit} /></button>)}
    {busy && <p role="status">Loading matches…</p>}
    {failed && <p role="alert">Could not load matches. Try again.</p>}
    {next && <button type="button" disabled={busy} onClick={more} className="px-2 py-2">More results</button>}
  </div>;
}
