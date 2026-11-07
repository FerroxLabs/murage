import { useChatResource, type HitsPage } from "@/lib/chat-previews";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { landOnSearchHit } from "@/lib/focus-message";
import { imeComposing } from "@/lib/composer-enter";
import { useStore } from "@/state/store";

const EMPTY_HITS: import("@/lib/search-hit").SearchHit[] = [];

export function ChatFindBar({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  const [index, setIndex] = useState(0);
  const trimmed = query.trim();
  const resource = useChatResource<HitsPage>(trimmed ? `/api/search?q=${encodeURIComponent(trimmed)}&limit=100&threadId=${encodeURIComponent(threadId)}` : null, undefined, 180);
  const hits = resource.eligible ? resource.data?.hits ?? EMPTY_HITS : EMPTY_HITS;
  const loading = !!trimmed && resource.loading;

  useEffect(() => {
    if (resource.error) {
      dispatch({ type: "error", message: resource.error instanceof Error ? resource.error.message : "Search failed" });
    }
  }, [dispatch, resource.error]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const land = (next: number) => {
    const hit = hits[next];
    if (!hit) return;
    setIndex(next);
    void landOnSearchHit(hit, state, dispatch, resource.listGen).catch((error) =>
      dispatch({ type: "error", message: error instanceof Error ? error.message : "That message is unavailable" }),
    );
  };
  const move = (delta: number) => {
    if (!hits.length) return;
    land((index + delta + hits.length) % hits.length);
  };

  // Jump to the first match as soon as a new result set arrives.
  useEffect(() => {
    if (hits[0]) land(0);
    // `land` intentionally reads the state that produced this result set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits]);

  return (
    <div className="w-full px-5 pb-2">
      <div className="flex items-center gap-1.5 rounded-xl border border-hairline/50 bg-panel px-2 py-1.5 shadow-sm">
        <Search size={15} className="shrink-0 text-ink-secondary" />
        <input dir="auto"
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (imeComposing(event.nativeEvent)) return;
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "Enter") {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
          placeholder="Find in this conversation"
          aria-label="Find in this conversation"
          className="min-w-0 flex-1 bg-transparent px-1 text-[13px] text-ink outline-none placeholder:text-ink-secondary/70"
        />
        <span className="min-w-[58px] text-right text-[11.5px] tabular-nums text-ink-secondary">
          {loading ? "Searching…" : resource.error ? "" : query.trim() ? (hits.length ? `${index + 1} of ${hits.length}` : "No results") : ""}
        </span>
        <button
          type="button"
          onClick={() => move(-1)}
          disabled={!hits.length}
          aria-label="Previous result"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30"
        >
          <ChevronUp size={15} />
        </button>
        <button
          type="button"
          onClick={() => move(1)}
          disabled={!hits.length}
          aria-label="Next result"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30"
        >
          <ChevronDown size={15} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close find"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
