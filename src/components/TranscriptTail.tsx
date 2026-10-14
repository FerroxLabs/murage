// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one live region of a transcript: the newest message, spoken once when it
// arrives. The transcript's own `role="log"` is `aria-live="off"`, so rows that
// mount while the reader scrolls up are never announced as new.
import { useRef } from "react";

import { nextTailAnnouncement, type TailLast, type TailState } from "@/lib/transcript-tail";

export function TranscriptTail({ scope, last }: { scope: string; last: TailLast | null }) {
  const held = useRef<{ state: TailState | null; say: string }>({ state: null, say: "" });
  const next = nextTailAnnouncement(held.current.state, scope, last);
  // A re-render with nothing new keeps what was said; the region only changes on a new message.
  held.current = { state: next.state, say: next.say ?? (held.current.state?.scope === scope ? held.current.say : "") };
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {held.current.say}
    </div>
  );
}
