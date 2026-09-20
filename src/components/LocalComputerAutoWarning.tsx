import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

export const LOCAL_COMPUTER_AUTO_WARNING =
  "Auto mode will let this bot click, type, and run tools on this computer without asking first. Destructive and sensitive actions still stop. Continue only if you are watching.";

/** The same question for Full access. It is a different answer, not a louder
 * one: Auto keeps a stop in front of destructive and sensitive actions and
 * Full access does not, so the Auto sentence would be a promise this mode
 * cannot keep. */
export const LOCAL_COMPUTER_FULL_ACCESS_WARNING =
  "Full access will let this bot click, type, and run tools on this computer without asking first — including destructive and sensitive actions. Continue only if you are watching.";

export function LocalComputerAutoWarning({
  open,
  /** which switch the person actually chose; the dialog says so */
  mode = "auto",
  onCancel,
  onConfirm,
}: {
  open: boolean;
  mode?: "auto" | "full";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-auto-warning-title"
        aria-describedby="local-auto-warning-body"
        className="w-full max-w-[420px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
          <div>
            <h2 id="local-auto-warning-title" className="text-[15px] font-semibold text-ink">
              {mode === "full" ? "Allow Full access on this computer?" : "Allow Auto mode on this computer?"}
            </h2>
            <p id="local-auto-warning-body" className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
              {mode === "full" ? LOCAL_COMPUTER_FULL_ACCESS_WARNING : LOCAL_COMPUTER_AUTO_WARNING}
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
