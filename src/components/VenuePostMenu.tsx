// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// VENUE-POST-1017 section 6: the Post in… list, loaded only when the owner opens it (Composer.tsx loads this chunk lazily).
import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { parsePostableVenues, postableVenuesPath, POST_IN_EMPTY, POST_IN_LOAD_FAILED, type PostableVenue } from "@/lib/venue-post-pick";

export function VenuePostMenu({ botId, threadId, onPick, onClose }: {
  botId: string;
  threadId: string;
  onPick: (venue: PostableVenue) => void;
  onClose: () => void;
}) {
  const [venues, setVenues] = useState<PostableVenue[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    setVenues(null);
    api(postableVenuesPath(botId, threadId), { signal: controller.signal })
      .then((body) => setVenues(parsePostableVenues(body)))
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [botId, threadId, attempt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const onDown = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) onClose(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown); };
  }, [onClose]);

  return (
    <div ref={root} role="menu" aria-label="Post in" data-venue-post-menu
      className="absolute bottom-full left-0 z-20 mb-2 max-h-72 w-64 overflow-y-auto overscroll-contain rounded-xl border border-hairline/40 bg-raised p-1 shadow-lg">
      {failed ? (
        <button type="button" className="w-full rounded-lg px-3 py-2 text-left text-sm text-ink-secondary hover:bg-control" onClick={() => setAttempt((n) => n + 1)}>
          {POST_IN_LOAD_FAILED}
        </button>
      ) : venues === null ? (
        <p className="px-3 py-2 text-sm text-ink-secondary">Loading…</p>
      ) : venues.length === 0 ? (
        <p className="px-3 py-2 text-sm text-ink-secondary">{POST_IN_EMPTY}</p>
      ) : (
        venues.map((venue) => (
          <button key={venue.venueId} type="button" role="menuitem"
            className="w-full truncate rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-control"
            onClick={() => onPick(venue)}>
            {venue.name}
          </button>
        ))
      )}
    </div>
  );
}
