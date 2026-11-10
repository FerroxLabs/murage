// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one clamp for a popover anchored under its trigger (1.0.19 slice P, SETTINGS-P-LAZY-FAILURE-1019 section 3):
// it keeps the popover 12px inside the viewport on both sides and gives it the room below the anchor. The model
// picker's dialog and its load-failure frame both use it, so a failed load looks and sits like the dialog. React
// hooks only, so the eager side can import it without pulling the lazy dialog into the first paint.
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/** The menu's height: on a phone, everything below where it opens but a 12px margin (a fixed 70% left ~3 rows and
 *  blank space under them); on a wider window the compact 560px cap. Never shorter than a usable list. */
export function popoverMaxHeight(menuTop: number, viewportHeight: number, viewportWidth: number) {
  const room = Math.floor(viewportHeight - menuTop - 12);
  return Math.max(240, viewportWidth >= 768 ? Math.min(560, room) : room);
}

/** Same horizontal clamp as TaskPicker, using the rendered menu width. */
export function popoverViewportOffset(anchorRight: number, menuWidth: number, viewportWidth: number) {
  const left = anchorRight - menuWidth;
  return Math.max(12, Math.min(left, viewportWidth - menuWidth - 12)) - left;
}

/** Attach `ref` to the popover and spread `style` on it. `contained` (drawn in flow) needs no clamp and gets no style. */
export function usePopoverClamp(root: RefObject<HTMLElement | null>, contained: boolean): { ref: RefObject<HTMLDivElement | null>; style: CSSProperties | undefined } {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (contained) return;
    const reposition = () => {
      if (root.current && ref.current) {
        setOffset(popoverViewportOffset(root.current.getBoundingClientRect().right, ref.current.getBoundingClientRect().width, window.innerWidth));
        setMaxHeight(popoverMaxHeight(ref.current.getBoundingClientRect().top, window.visualViewport?.height ?? window.innerHeight, window.innerWidth));
      }
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    if (root.current) observer.observe(root.current);
    if (ref.current) observer.observe(ref.current);
    const header = root.current?.closest("[data-chat-header]");
    if (header) observer.observe(header);
    window.addEventListener("resize", reposition);
    return () => { observer.disconnect(); window.removeEventListener("resize", reposition); };
  }, [contained, root]);
  return { ref, style: contained ? undefined : { transform: `translateX(${offset}px)`, ...(maxHeight ? { maxHeight } : {}) } };
}
