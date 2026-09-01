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

export function ConfirmDelete({
  name,
  kind,
  detail,
  onCancel,
  onConfirm,
}: {
  name: string;
  kind: string;
  detail: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
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
              Delete {kind} “{name}”?
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{detail}</p>
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
