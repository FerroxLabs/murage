// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A delegation waiting on a busy teammate. It used to be a plain line, shown
// only with Tool calls on, and nothing could stop it: when its wake-up was
// missed it sat there until a restart (0.1.60 L4-1). The line now shows with
// Tool calls on or off while the handoff waits, and offers Stop, which drops
// that one handoff. The server removes the control once it runs, gives up or
// is stopped.
import { useState } from "react";
import { Square } from "lucide-react";

export function DelegationWaitRow({ text, onStop }: { text: string; onStop: () => void }) {
  const [stopping, setStopping] = useState(false);
  return (
    <div className="flex justify-start">
      <div role="status" data-testid="delegation-wait" className="flex max-w-[42rem] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-hairline/50 bg-card px-3 py-2 text-[13px] text-ink-secondary">
        <span className="min-w-0 flex-1">{text}</span>
        <button
          type="button"
          disabled={stopping}
          onClick={() => { setStopping(true); onStop(); }}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-hairline/70 bg-control px-3 py-1 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-50"
        >
          <Square size={12} aria-hidden="true" />{stopping ? "Stopping" : "Stop"}
        </button>
      </div>
    </div>
  );
}
