// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useNativeDialogLayer } from "@/lib/native-dialog-layer";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Brain, X } from "lucide-react";
import { MemorySettings } from "./MemorySettingsLazy";
import { t } from "@/lib/i18n";
import { useDesktopSurface } from "@/lib/use-surface";
import { BOX_DIALOG, BoxBody, BoxHead } from "./ui/BoxShell";

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
  const desktop = useDesktopSurface();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const native = useNativeDialogLayer(dialog, { name: "memory", returnFocusTo: returnFocusRef?.current ?? undefined });
  const setOpen = (next: boolean) => {
    if (next && desktop === true) {
      window.dispatchEvent(new CustomEvent("murage:open-memory", { detail: { botId } }));
      onOpenChange?.(false);
      return;
    }
    if (controlledOpen === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  useEffect(() => {
    if (open && desktop === true) { setOpen(true); return; }
    if (open) {
      if (!dialog.current?.open) native.show();
    } else native.close();
  }, [open, desktop]);
  useEffect(() => { setOpen(false); }, [botId]);
  const closed = () => native.dismiss(() => setOpen(false));
  return <>
    {showTrigger && <button type="button" onClick={() => setOpen(true)} aria-label={t("chatHeader.openMemoryFor", { name: botName })} title={t("chatHeader.memory")}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
      <Brain size={18} aria-hidden="true" />
      <span className={compact ? "chip-trim:hidden" : undefined}>{compact ? t("chatHeader.memory") : t("chatHeader.openMemory")}</span>
    </button>}
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={closed} onClose={() => { if (!dialog.current?.open) closed(); }}
      className={`${BOX_DIALOG} m-auto w-[min(760px,calc(100vw-24px))] rounded-2xl border border-hairline bg-card p-0 text-ink shadow-2xl backdrop:bg-black/60`}>
      <BoxHead className="border-b border-hairline bg-card p-4">
        <h2 id={titleId} className="min-w-0 truncate text-[17px] font-semibold">{botName} · {t("chatHeader.memory")}</h2>
        <button type="button" autoFocus onClick={() => setOpen(false)} aria-label={t("chatHeader.closeMemory")} className="rounded-lg p-2 hover:bg-raised focus-visible:outline-2 focus-visible:outline-focus"><X size={18} /></button>
      </BoxHead>
      {open && <BoxBody className="p-4"><MemorySettings key={botId} botId={botId} onNavigate={() => setOpen(false)} /></BoxBody>}
    </dialog>
  </>;
}
