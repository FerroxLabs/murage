import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

/** Shown once per bot, on the desktop, before Full access is switched on. */
export const FULL_ACCESS_WARNING =
  "This bot will not ask before running commands, reading credentials or personal files, or contacting other bots.";

export const FULL_ACCESS_STILL_ASKS =
  "Turns started by webhooks or routines still ask, as they do in Auto, and image generation still asks before it spends.";

export const FULL_ACCESS_ON_THIS_COMPUTER =
  "On this computer that includes your own screen, mouse and keyboard.";

export function FullAccessWarning({
  open,
  botName,
  onThisComputer,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  botName: string;
  /** the bot drives this computer, so the Auto-on-this-computer warning is
   * confirmed by this same dialog */
  onThisComputer: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Cancel is the default: this is the one switch that removes every stop.
    cancelRef.current?.focus();
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
        aria-labelledby="full-access-warning-title"
        aria-describedby="full-access-warning-body"
        className="w-full max-w-[440px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
          <div>
            <h2 id="full-access-warning-title" className="text-[15px] font-semibold text-ink">
              Give @{botName} full access?
            </h2>
            <div id="full-access-warning-body" className="mt-1.5 flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink-secondary">
              <p className="font-medium text-ink">{FULL_ACCESS_WARNING}</p>
              {onThisComputer && <p>{FULL_ACCESS_ON_THIS_COMPUTER}</p>}
              <p>{FULL_ACCESS_STILL_ASKS}</p>
              <p>You are asked this once for this bot. Switch back to Auto or Ask at any time.</p>
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110"
          >
            Turn on full access
          </button>
        </div>
      </div>
    </div>
  );
}
