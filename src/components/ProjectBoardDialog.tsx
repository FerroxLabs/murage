// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { useFocusTrap } from "@/lib/focus-trap";
import { LayerSurface } from "./LayerSurface";
import { useNativeDialogLayer } from "@/lib/native-dialog-layer";
import type { LoadedLayerProps } from "@/components/LazyOverlay";
import { t } from "@/lib/i18n";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { returnFocus } from "@/lib/return-focus";
import { BOX_FRAME, BOX_DIALOG, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";
import "./project-board.css";
export const BOARD_BUTTON = "min-h-11 rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink hover:bg-raised disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
export const BOARD_INPUT = "min-h-11 w-full min-w-0 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
/** The side sheet is pinned to the right edge, so it skips box-dialog's centring and takes its own keyboard rule from project-board.css. */
const BOARD_SIDE = "project-board-side min-h-0 overflow-clip open:flex open:flex-col";
/** Native modal dialogs trap focus, make the underlying board inert and keep
 * Escape local to the topmost sheet, including nested phone pickers. */
export function ProjectBoardDialog({ layerLifecycle, native: isNative = true, title, children, actions, onClose: requestedClose, side = false, bottom = false, returnFocusRef }: { title: string; children: ReactNode; actions?: ReactNode; onClose: () => void; side?: boolean; bottom?: boolean; returnFocusRef?: RefObject<HTMLElement | null> } & { layerLifecycle?: LoadedLayerProps; native?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), heading = useId();
  const native = useNativeDialogLayer(ref, { name: "project-board", returnFocusTo: layerLifecycle?.opener ?? returnFocusRef?.current, lease: layerLifecycle?.lease, returnTo: target => returnFocus(target as Element | null) });
  const onClose = () => isNative ? native.dismiss(requestedClose) : requestedClose();
  const layerRef = useRef<HTMLDivElement>(null);
  const layer = useFocusTrap(layerRef, !isNative, { name: "new-project-dialog", kind: "dialog", returnFocusTo: layerLifecycle?.opener ?? returnFocusRef?.current, lease: layerLifecycle?.lease, onEscape: onClose });
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (isNative) native.show();
  }, [returnFocusRef, isNative]);
  const content = <>
    <BoxHead className="items-start border-b border-hairline/30 p-4"><h2 id={heading} className="min-w-0 break-words text-lg font-semibold">{title}</h2><button type="button" className={BOARD_BUTTON} onClick={onClose} aria-label={t("projects.dialog.closeTitled",{title})}>{t("projects.dialog.close")}</button></BoxHead>
    <BoxBody className="space-y-4 p-4">{children}</BoxBody>
    {actions && <BoxFoot className="flex-wrap border-t border-hairline/30 p-4">{actions}</BoxFoot>}
  </>;
  if (!isNative) return <LayerSurface handle={layer}><div className="overlay-inset fixed inset-0 flex items-center justify-center bg-black/50 p-4" onMouseDown={event => event.target === event.currentTarget && onClose()}><div ref={layerRef} role="dialog" aria-modal="true" aria-labelledby={heading} tabIndex={-1} className={`${BOX_FRAME} project-board-dialog max-h-[calc(var(--vvh,100dvh)-2rem)] rounded-xl border border-hairline/40 bg-panel text-ink`}>{content}</div></div></LayerSurface>;
  return <dialog ref={ref} aria-modal="true" aria-labelledby={heading} onCancel={e => { e.preventDefault(); close.current(); }} className={`project-board-dialog ${side ? BOARD_SIDE : BOX_DIALOG} ${bottom ? "project-board-bottom" : ""} border border-hairline/40 bg-panel text-ink`}>
{content}
  </dialog>;
}
