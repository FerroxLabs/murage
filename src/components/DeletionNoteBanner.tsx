// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// After a Delete: what could not be removed, and where, in plain words.
import { Loader2, X } from "lucide-react";

import { retryResultLine } from "@/lib/deletion-notes";
import { useAction } from "@/lib/use-action";
import { ActionStatus } from "./ActionButton";

export const DISMISS_FAILED_LINE = "Could not dismiss this. Try again.";

export function DeletionNoteBanner({ note, onDismiss, onRetry }: { note: { title: string; items: string[]; retry?: boolean }; onDismiss: () => void | Promise<void>; onRetry?: () => unknown | Promise<unknown> }) {
  // The retry shows that it is running, then what it did in one short line (the server's answer), or why it did not run.
  const retry = useAction(async () => onRetry?.(), { idle: "Try again now", pending: "Trying again…", success: (result) => retryResultLine(result), successMs: 10_000, failure: "Could not try again right now. Check your connection and try again." });
  // Dismiss is saved by the server for a note from the owed list: the note goes once that is done, and stays with a line when it failed.
  const dismiss = useAction(async () => { await onDismiss(); }, { success: null, failure: DISMISS_FAILED_LINE, describeError: () => DISMISS_FAILED_LINE });
  return (
    <div className="w-full px-5">
      <div role="status" className="mb-2 flex items-start gap-2 rounded-lg border border-hairline/50 bg-raised px-3 py-2 text-[13px] text-ink">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{note.title}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-secondary">
            {note.items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
          </ul>
          {note.retry && onRetry && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void retry.run()} disabled={retry.pending} aria-busy={retry.pending} className="rounded border border-hairline/60 px-2 py-0.5 text-[12.5px] text-ink hover:bg-inset focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">
                {retry.pending && <Loader2 size={12} className="mr-1 inline animate-spin" aria-hidden="true" />}{retry.pending ? retry.label : "Try again now"}
              </button>
              <ActionStatus action={retry} />
            </div>
          )}
          <ActionStatus action={dismiss} />
        </div>
        <button type="button" aria-label="Dismiss" title="Dismiss" onClick={() => void dismiss.run()} disabled={dismiss.pending} aria-busy={dismiss.pending} className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-inset hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
