// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A phone sheet (UX L7 part 1): rises from the bottom over the page, holds the
// keyboard while open (src/lib/focus-trap.ts), and closes on its Close button,
// a tap on the dimmed page behind it, or Escape. Focus goes back to whatever
// opened it. The sheet is drawn at the end of the body so no scrolling box or
// stacking context of the page clips it; React events still reach the
// component tree that opened it, so a page's own keys keep working inside.
// A sheet whose card heads itself (namedByBodyHeading: a Needs you card's
// question) is named by that heading and draws no second one, so the words show
// once; otherwise the title is the sheet's heading.
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LayerSurface } from "@/components/LayerSurface";
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
  /** under the thumb, below the scrolling body (the Needs you sheet's Next) */
  footer?: ReactNode;
  /** the card inside heads itself (a Needs you card's question): name the sheet by that heading and draw no title of its own */
  namedByBodyHeading?: boolean;
}

export function PhoneSheet({ title, onClose, children, bodyData, bodyId, footer, namedByBodyHeading }: PhoneSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [namedBy, setNamedBy] = useState<string | null>(null);
  const layer = useFocusTrap(ref, true, { name: "phone-sheet", kind: "dialog", onEscape: onClose });
  useLayoutEffect(() => {
    const body = namedByBodyHeading ? ref.current?.querySelector("[data-box-body]") : null;
    if (!body) { setNamedBy(null); return; }
    const own = `${titleId}card`;
    const find = () => {
      const heading = body.querySelector<HTMLElement>("h1,h2,h3,h4,h5,h6,[role=heading]");
      // one id of the sheet's own, only ever on the heading that names it
      const owned = body.querySelector<HTMLElement>(`[id="${own}"]`);
      if (owned && owned !== heading) owned.removeAttribute("id");
      if (heading && !heading.id) heading.id = own;
      setNamedBy(heading ? heading.id : null);
    };
    find();
    const watch = new MutationObserver(find);
    watch.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["id"] });
    return () => watch.disconnect();
  }, [titleId, namedByBodyHeading]);
  const sheet = (
    <div className="fixed inset-0 flex flex-col justify-end" data-phone-sheet-layer>
      <div aria-hidden="true" data-phone-sheet-backdrop className="absolute inset-0 bg-black/50" onMouseDown={(event) => event.target === event.currentTarget && onClose()} />
      <div
        ref={ref}
        {...bodyData}
        role="dialog"
        aria-modal="true"
        aria-labelledby={namedBy ?? titleId}
        tabIndex={-1}
        data-phone-sheet
        className={cn(BOX_FRAME, "relative max-h-[85dvh] rounded-t-2xl border-t border-hairline/40 bg-panel text-ink shadow-xl focus:outline-none")}
      >
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-hairline" />
        <BoxHead className="items-start gap-2 px-4 pb-2 pt-2">
          {namedBy ? <span className="flex-1" /> : <h2 id={titleId} className="line-clamp-3 min-w-0 flex-1 break-words pt-2.5 text-[16px] font-semibold leading-snug">{title}</h2>}
          <button type="button" data-phone-sheet-close onClick={onClose} aria-label={t("ux.l7.sheet.close")}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <X size={18} aria-hidden="true" />
          </button>
        </BoxHead>
        <BoxBody id={bodyId} className={cn("px-4", footer ? "pb-2" : "pb-[max(1rem,env(safe-area-inset-bottom))]")}>{children}</BoxBody>
        {footer && <div data-phone-sheet-footer className="shrink-0 border-t border-hairline/40 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">{footer}</div>}
      </div>
    </div>
  );
  return <LayerSurface handle={layer}>{sheet}</LayerSurface>;
}
