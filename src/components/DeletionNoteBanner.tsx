// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// After a Delete: what could not be removed, and where, in plain words.
import { X } from "lucide-react";

export function DeletionNoteBanner({ note, onDismiss }: { note: { title: string; items: string[] }; onDismiss: () => void }) {
  return (
    <div className="w-full px-5">
      <div role="status" className="mb-2 flex items-start gap-2 rounded-lg border border-hairline/50 bg-raised px-3 py-2 text-[13px] text-ink">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{note.title}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-secondary">
            {note.items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
          </ul>
        </div>
        <button type="button" aria-label="Dismiss" title="Dismiss" onClick={onDismiss} className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-inset hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
