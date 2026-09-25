// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A card answered after its routine run had ended (Murage stopped under it,
// or the run was cancelled). Nothing can deliver that answer any more, so the
// row says the run ended and offers Run again, which starts the routine now.
// An "Always allow for this routine" chosen on the card is already saved.
import { useState } from "react";
import { RotateCcw } from "lucide-react";

export function RoutineRunAgainRow({ text, onRunAgain }: { text: string; onRunAgain: () => void }) {
  const [started, setStarted] = useState(false);
  return (
    <div className="flex justify-start">
      <div role="status" data-testid="routine-run-again" className="flex max-w-[42rem] flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-hairline/50 bg-card px-3 py-2 text-[13px] text-ink-secondary">
        <span className="min-w-0 flex-1">{text}</span>
        <button
          type="button"
          disabled={started}
          onClick={() => { setStarted(true); onRunAgain(); }}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-hairline/70 bg-control px-3 py-1 text-[12px] font-medium text-ink hover:bg-raised disabled:opacity-50"
        >
          <RotateCcw size={13} aria-hidden="true" />{started ? "Started" : "Run again"}
        </button>
      </div>
    </div>
  );
}
