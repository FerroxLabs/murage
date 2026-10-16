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
  // One persistent region; the spoken node inside it is keyed by the message, so two messages in a row with the
  // same text still replace the node, a change assistive technology announces (equal text alone is no mutation).
  const lastId = held.current.state?.lastId ?? "none";
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      <span key={lastId} data-tail={lastId}>{held.current.say}</span>
    </div>
  );
}
