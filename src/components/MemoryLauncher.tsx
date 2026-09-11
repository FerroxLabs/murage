import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Brain, X } from "lucide-react";
import { MemorySettings } from "./MemorySettings";
import { t } from "@/lib/i18n";

/** One bot-scoped memory surface, opened from either the toolbar or profile.
 *
 * The chat header can relocate the trigger into its More menu at narrow
 * widths (U0-T1). It then controls `open` and hides the trigger, but the
 * launcher stays mounted in the same place, so resizing never discards a
 * memory edit that is in progress. */
export function MemoryLauncher({
  botId,
  botName,
  compact = false,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
  returnFocusRef,
}: {
  botId: string;
  botName: string;
  compact?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
  /** Where focus goes when the dialog closes, if its opener is gone. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  useEffect(() => {
    if (open) {
      if (!dialog.current?.open) dialog.current?.showModal();
    } else dialog.current?.close();
  }, [open]);
  useEffect(() => { setOpen(false); }, [botId]);
  const closed = () => {
    setOpen(false);
    // The native dialog returns focus to its opener; a menu item that opened
    // it no longer exists, so fall back to the caller's element.
    const target = returnFocusRef?.current;
    if (target && (!document.activeElement || document.activeElement === document.body)) target.focus();
  };
  return <>
    {showTrigger && <button type="button" onClick={() => setOpen(true)} aria-label={t("chatHeader.openMemoryFor", { name: botName })} title={t("chatHeader.memory")}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
      <Brain size={18} aria-hidden="true" />
      <span className={compact ? "chip-trim:hidden" : undefined}>{compact ? t("chatHeader.memory") : t("chatHeader.openMemory")}</span>
    </button>}
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={closed} onClose={closed}
      className="m-auto max-h-[90dvh] w-[min(760px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-hairline bg-card p-0 text-ink shadow-2xl backdrop:bg-black/60">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-hairline bg-card p-4">
        <h2 id={titleId} className="min-w-0 truncate text-[17px] font-semibold">{botName} · {t("chatHeader.memory")}</h2>
        <button type="button" autoFocus onClick={() => setOpen(false)} aria-label={t("chatHeader.closeMemory")} className="rounded-lg p-2 hover:bg-raised focus-visible:outline-2 focus-visible:outline-focus"><X size={18} /></button>
      </div>
      {open && <div className="p-4"><MemorySettings key={botId} botId={botId} onNavigate={() => setOpen(false)} /></div>}
    </dialog>
  </>;
}
