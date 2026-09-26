// Typed confirmation for the two actions that destroy work irreversibly.
//
// Deleting a bot removes its whole transcript, and deleting a room removes the
// conversation the team had in it. Both were a single click with no undo, while
// far smaller actions in this app already ask (ComputerPanel.tsx:748,
// LocalComputerSection.tsx:161). This closes that gap.
//
// The user types the NAME rather than the word "delete" on purpose: it confirms
// WHICH thing is going, not merely that they meant to click. Muscle memory can
// type "delete" on the wrong row; it cannot type the wrong name by accident.
import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { deletionConsequenceLines } from "@/lib/deletion-notes";
import { api } from "@/state/store";

export function ConfirmDelete({
  name,
  kind,
  detail,
  title,
  items,
  preview,
  onCancel,
  onConfirm,
}: {
  name: string;
  kind: string;
  detail: string;
  /** Heading override for a delete that is not one named thing (a bulk
   * delete names its count instead). Default: Delete {kind} "{name}"? */
  title?: string;
  /** Exactly what is going, one line each, when `name` alone cannot say it
   * (bulk delete). Shown in full, scrolling if long: the person must be able
   * to read every name before typing the confirmation. */
  items?: string[];
  /** What is being deleted, for the saved-files count and the backups line
   * (GET /api/deletion-preview). */
  preview?: { botId?: string; groupId?: string; threadId?: string };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();
  const savedFiles = useSavedFileCount(preview);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      // C5: this dialog autofocuses its "type the name to confirm" field, so a
      // software keyboard is always up while it is open. `inset-0` resolves
      // against the layout viewport, which iOS does not shrink, and would centre
      // the dialog in the full pre-keyboard height with the confirm button
      // behind the keys. See the overlay convention in styles.css.
      className="fixed inset-x-0 top-0 z-50 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/60 p-6"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="w-full max-w-[420px] rounded-2xl border border-hairline/40 bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0">
            <h2 id="confirm-delete-title" className="text-[15px] font-semibold text-ink">
              {title ?? <>Delete {kind} “{name}”?</>}
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{detail}</p>
            {preview && deletionConsequenceLines(savedFiles).map((line) => (
              <p key={line} className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{line}</p>
            ))}
            {items && items.length > 0 && (
              <ul
                aria-label="What will be deleted"
                className="mt-2 max-h-[160px] overflow-y-auto rounded-lg border border-hairline/40 bg-app px-3 py-2 text-[12.5px] leading-relaxed text-ink"
              >
                {items.map((item, index) => (
                  <li key={`${index}-${item}`} className="truncate">{item}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <label className="mt-4 block text-[12.5px] text-ink-secondary">
          Type <span className="font-medium text-ink">{name}</span> to confirm
          <input
            ref={inputRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && matches) onConfirm(); }}
            className="mt-1.5 w-full rounded-lg border border-hairline/50 bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
            placeholder={name}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg px-3.5 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!matches}
            className="rounded-lg bg-danger px-3.5 py-2 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Delete {kind}
          </button>
        </div>
      </div>
    </div>
  );
}

/** How many saved files a Delete takes with it; null until known. */
export function useSavedFileCount(preview: { botId?: string; groupId?: string; threadId?: string } | undefined): number | null {
  const [count, setCount] = useState<number | null>(null);
  const query = preview ? new URLSearchParams(Object.entries(preview).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString() : "";
  useEffect(() => {
    if (!query) return;
    let live = true;
    api(`/api/deletion-preview?${query}`).then((body: { savedFiles?: unknown }) => {
      if (live && typeof body?.savedFiles === "number") setCount(body.savedFiles);
    }).catch(() => {});
    return () => { live = false; };
  }, [query]);
  return count;
}
