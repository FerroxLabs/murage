// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { returnFocus } from "@/lib/return-focus";
export const BOARD_BUTTON = "min-h-11 rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink hover:bg-raised disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
export const BOARD_INPUT = "min-h-11 w-full min-w-0 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
/** Native modal dialogs trap focus, make the underlying board inert and keep
 * Escape local to the topmost sheet, including nested phone pickers. */
export function ProjectBoardDialog({ title, children, onClose, side = false, bottom = false, returnFocusRef }: { title: string; children: ReactNode; onClose: () => void; side?: boolean; bottom?: boolean; returnFocusRef?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDialogElement>(null), heading = useId();
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      // An opener in the closed phone drawer is inert: the drawer's menu button takes focus instead.
      returnFocus(returnFocusRef?.current ?? prior);
    };
  }, [returnFocusRef]);
  return <dialog ref={ref} aria-modal="true" aria-labelledby={heading} onCancel={e => { e.preventDefault(); close.current(); }} className={`project-board-dialog ${side ? "project-board-side" : ""} ${bottom ? "project-board-bottom" : ""} border border-hairline/40 bg-panel text-ink`}>
    <header className="flex items-start justify-between gap-3 border-b border-hairline/30 p-4"><h2 id={heading} className="min-w-0 break-words text-lg font-semibold">{title}</h2><button type="button" className={BOARD_BUTTON} onClick={onClose} aria-label={t("projects.dialog.closeTitled",{title})}>{t("projects.dialog.close")}</button></header>
    <div className="min-w-0 space-y-4 p-4">{children}</div>
  </dialog>;
}
