// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A phone sheet (UX L7 part 1): rises from the bottom over the page, holds the
// keyboard while open (src/lib/focus-trap.ts), and closes on its Close button,
// a tap on the dimmed page behind it, or Escape. Focus goes back to whatever
// opened it. The sheet is drawn at the end of the body so no scrolling box or
// stacking context of the page clips it; React events still reach the
// component tree that opened it, so a page's own keys keep working inside.
import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { useFocusTrap } from "@/lib/focus-trap";
import { cn } from "@/lib/cn";
import { BOX_FRAME, BoxBody, BoxHead } from "@/components/ui/BoxShell";

export interface PhoneSheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** extra data attributes for the whole sheet, Close included (a page that reads its own markers inside, e.g. data-needs-row) */
  bodyData?: Record<`data-${string}`, string>;
  /** the body's id, for an opener that moves focus into it (Inbox's needs-row-body-<id>) */
  bodyId?: string;
}

export function PhoneSheet({ title, onClose, children, bodyData, bodyId }: PhoneSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, true, { onEscape: onClose });
  const sheet = (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" data-phone-sheet-layer>
      <div aria-hidden="true" data-phone-sheet-backdrop className="absolute inset-0 bg-black/50" onMouseDown={(event) => event.target === event.currentTarget && onClose()} />
      <div
        ref={ref}
        {...bodyData}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-phone-sheet
        className={cn(BOX_FRAME, "relative max-h-[85dvh] rounded-t-2xl border-t border-hairline/40 bg-panel text-ink shadow-xl focus:outline-none")}
      >
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-hairline" />
        <BoxHead className="items-start gap-2 px-4 pb-2 pt-2">
          <h2 id={titleId} className="line-clamp-3 min-w-0 flex-1 break-words pt-2.5 text-[16px] font-semibold leading-snug">{title}</h2>
          <button type="button" data-phone-sheet-close onClick={onClose} aria-label={t("ux.l7.sheet.close")}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <X size={18} aria-hidden="true" />
          </button>
        </BoxHead>
        <BoxBody id={bodyId} className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</BoxBody>
      </div>
    </div>
  );
  return typeof document === "undefined" ? sheet : createPortal(sheet, document.body);
}
