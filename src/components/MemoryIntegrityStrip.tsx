// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "You can chat as usual. Checking earlier memory, 42%, about 6 minutes left." The calm strip under the engine banner while the later memory
// work runs after an update. Chat is open; this only explains why bots do not yet use their earlier replies. If memory is set aside it becomes
// an alert in the app's own words. What is on screen updates with every reading; what a screen reader is told is a separate, slower line
// (at most every ten seconds), except a hold, which is spoken at once. Not dismissible while it matters, and silent when there is nothing to say.
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useMemoryIntegrity } from "@/lib/memory-integrity-feed";
import { createAnnouncer, type StripView } from "@/lib/memory-integrity-view";

/** The sentence a screen reader is told for the view on screen: the view's own text at most every ten seconds, at once when its kind changes. */
export function useThrottledAnnouncement(view: StripView | null): string {
  const announcer = useMemo(() => createAnnouncer(), []);
  const [spoken, setSpoken] = useState(() => announcer.offer(view).text);
  const latest = useRef(view);
  latest.current = view;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offer = () => {
      const answer = announcer.offer(latest.current);
      setSpoken(answer.text);
      if (answer.retryInMs !== null) timer = setTimeout(offer, answer.retryInMs);
    };
    offer();
    return () => { if (timer) clearTimeout(timer); };
  }, [announcer, view]);
  return spoken;
}

export function MemoryIntegrityStripView({ view, announced }: { view: StripView | null; announced?: string }) {
  if (!view) return null;
  const alert = view.role === "alert";
  const spoken = announced ?? view.text;
  return (
    <div
      role={alert ? "alert" : undefined}
      data-testid="memory-strip"
      data-kind={view.kind}
      className={`flex items-center justify-center gap-2 px-4 py-2 text-[13px] ${alert ? "bg-danger text-white font-medium" : "bg-raised text-ink"}`}
    >
      {view.kind === "working" && <Loader2 size={14} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      {/* the visible sentence changes with every reading, so it is not the live region */}
      <span aria-hidden={alert ? undefined : true}>{view.text}</span>
      {!alert && <span className="sr-only" role="status" aria-live="polite">{spoken}</span>}
    </div>
  );
}

export function MemoryIntegrityStrip() {
  const view = useMemoryIntegrity();
  return <MemoryIntegrityStripView view={view} announced={useThrottledAnnouncement(view)} />;
}
