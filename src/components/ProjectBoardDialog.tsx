// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { returnFocus } from "@/lib/return-focus";
import { BOX_DIALOG, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";
export const BOARD_BUTTON = "min-h-11 rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink hover:bg-raised disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
export const BOARD_INPUT = "min-h-11 w-full min-w-0 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
/** The side sheet is pinned to the right edge, so it skips box-dialog's centring and takes its own keyboard rule from project-board.css. */
const BOARD_SIDE = "project-board-side min-h-0 overflow-clip open:flex open:flex-col";
/** Native modal dialogs trap focus, make the underlying board inert and keep
 * Escape local to the topmost sheet, including nested phone pickers. */
export function ProjectBoardDialog({ title, children, actions, onClose, side = false, bottom = false, returnFocusRef }: { title: string; children: ReactNode; actions?: ReactNode; onClose: () => void; side?: boolean; bottom?: boolean; returnFocusRef?: RefObject<HTMLElement | null> }) {
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
  return <dialog ref={ref} aria-modal="true" aria-labelledby={heading} onCancel={e => { e.preventDefault(); close.current(); }} className={`project-board-dialog ${side ? BOARD_SIDE : BOX_DIALOG} ${bottom ? "project-board-bottom" : ""} border border-hairline/40 bg-panel text-ink`}>
    <BoxHead className="items-start border-b border-hairline/30 p-4"><h2 id={heading} className="min-w-0 break-words text-lg font-semibold">{title}</h2><button type="button" className={BOARD_BUTTON} onClick={onClose} aria-label={t("projects.dialog.closeTitled",{title})}>{t("projects.dialog.close")}</button></BoxHead>
    <BoxBody className="space-y-4 p-4">{children}</BoxBody>
    {actions && <BoxFoot className="flex-wrap border-t border-hairline/30 p-4">{actions}</BoxFoot>}
  </dialog>;
}
