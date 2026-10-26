// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Small rules for the transcript viewport shared by the chat and room views.
import { useEffect, useState, type RefObject } from "react";
import { prefersReducedMotion } from "@/lib/avatar-ticker";

/** Menus, lists, sliders, selects and editable fields use the arrow keys
 * themselves; pressing them there is not the reader scrolling the transcript. */
export const WIDGETS_WITH_OWN_ARROW_KEYS =
  '[role="menu"],[role="menubar"],[role="listbox"],[role="option"],[role="combobox"],[role="slider"],[role="tablist"],[role="radiogroup"],[role="tree"],[role="grid"],select,input[type="range"],[contenteditable=""],[contenteditable="true"]';

/** Does this key press count as the reader scrolling up? Pure, for tests. */
export function keyBreaksFollow(key: string, target: { typing: boolean; inOwnArrowWidget: boolean }): boolean {
  if (key === "PageUp") return !target.inOwnArrowWidget;
  if (key === "Home" || key === "ArrowUp") return !target.typing && !target.inOwnArrowWidget;
  return false;
}

/** Read a keyboard event's target into the two facts keyBreaksFollow needs. */
export function describeKeyTarget(target: EventTarget | null): { typing: boolean; inOwnArrowWidget: boolean } {
  const typing = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
  const inOwnArrowWidget = target instanceof Element && target.closest(WIDGETS_WITH_OWN_ARROW_KEYS) !== null;
  return { typing, inOwnArrowWidget };
}

/** True when there is more transcript than the pane shows. */
export function canScroll(el: { scrollHeight: number; clientHeight: number } | null | undefined): boolean {
  return Boolean(el) && el!.scrollHeight - el!.clientHeight >= 1;
}

/** Whether the Jump to latest button has anywhere to take the reader: the pane
 * scrolls, or the mounted window stops short of the newest message. */
export function jumpToLatestVisible(follow: boolean, scrollable: boolean, atLiveTail: boolean): boolean {
  return !follow && (scrollable || !atLiveTail);
}

/** Smooth, unless the reader asked for less motion. */
export function jumpScrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

/** Tracks whether the scroll pane has anything to scroll. */
export function useCanScroll(scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>, key: string | null): boolean {
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const sync = () => setScrollable(canScroll(scroller));
    sync();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(scroller);
    if (contentRef.current) observer?.observe(contentRef.current);
    scroller.addEventListener("scroll", sync, { passive: true });
    return () => { observer?.disconnect(); scroller.removeEventListener("scroll", sync); };
  }, [scrollRef, contentRef, key]);
  return scrollable;
}
