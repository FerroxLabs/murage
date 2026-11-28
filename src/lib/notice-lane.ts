// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONE FLOATING NOTICE AT A TIME (1.0.20, owner report on 1.0.19: "popups
// stacked on top of popups"). The boxes that float in the bottom-left corner
// over the rail and the composer (the Undo toast, a team action's toast, the
// call-budget stop, the update pop-up, the update-check line, the home-screen
// invitation on a remote browser) each ask this lane for a turn. Only
// the one with the highest priority is drawn; the rest wait, in priority
// order, and each shows when the one above it closes or times out. Every one
// of them has its own close. Waiting changes nothing about a notice: its own
// state (an Undo deadline, a dismissed streak) is its own.
//
// The reconnect line is not here: it is a band above the main view and never
// floats (ReconnectAppsBanner.tsx).
import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";

/** Highest first: what answers something the person just did, then what Murage wants to tell them. */
export const NOTICE_PRIORITY = {
  undo: 40,
  "team-feedback": 30,
  "call-budget": 25,
  update: 20,
  "update-stale": 10,
  install: 5,
} as const;
export type NoticeId = keyof typeof NOTICE_PRIORITY;

const waiting = new Set<NoticeId>();
const listeners = new Set<() => void>();
let shown: NoticeId | null = null;

function settle() {
  let next: NoticeId | null = null;
  for (const id of waiting) if (next === null || NOTICE_PRIORITY[id] > NOTICE_PRIORITY[next]) next = id;
  if (next === shown) return;
  shown = next;
  for (const listener of listeners) listener();
}

/** Ask for a turn; the returned function gives it back. */
export function claimNotice(id: NoticeId): () => void {
  waiting.add(id);
  settle();
  return () => { waiting.delete(id); settle(); };
}

/** The notice whose turn it is, or null. */
export function noticeShown(): NoticeId | null { return shown; }

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** True while `id` wants to show and nothing above it is waiting. A notice that does not want to show gives its turn back.
 * Outranked, not "claimed first": a notice draws on its first render and steps aside in the same commit if one above it waits. */
export function useNoticeTurn(id: NoticeId, wants: boolean): boolean {
  useLayoutEffect(() => (wants ? claimNotice(id) : undefined), [id, wants]);
  const top = useSyncExternalStore(subscribe, noticeShown, noticeShown);
  return wants && (top === null || NOTICE_PRIORITY[top] <= NOTICE_PRIORITY[id]);
}

/** The one corner: over the rail's foot on a wide window, the width of the screen on a phone. */
export const NOTICE_CORNER = "fixed bottom-4 left-4 right-4 z-[60] sm:right-auto sm:max-w-[300px]";

/** Gap kept between a notice and the composer it would otherwise cover. */
const COMPOSER_GAP = 8;

/** Where the notice's bottom edge goes so it never covers the composer: null keeps its own place (they do not share a column,
 * as on a wide window where the corner sits over the rail), otherwise just above the composer's top edge. Pure for the witness. */
export function noticeBottomClear(
  notice: { left: number; right: number },
  composer: { left: number; right: number; top: number; width: number; height: number } | null,
  viewportHeight: number,
): number | null {
  if (!composer || composer.width <= 0 || composer.height <= 0) return null;
  if (notice.right <= composer.left || notice.left >= composer.right) return null;
  return Math.max(0, viewportHeight - composer.top + COMPOSER_GAP);
}

/** Lifts a shown corner notice above the composer when the two share a column (a phone), and follows the composer as it grows,
 * the window resizes or the keyboard opens. Returns the style to put on the notice. */
export function useClearOfComposer(ref: RefObject<HTMLElement | null>, shown: boolean): { bottom?: number } {
  const [bottom, setBottom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!shown) { setBottom(null); return; }
    const place = () => {
      const notice = ref.current;
      const composer = document.querySelector<HTMLElement>("[data-composer]");
      if (!notice) return;
      const height = window.visualViewport?.height ?? window.innerHeight;
      setBottom(noticeBottomClear(notice.getBoundingClientRect(), composer?.getBoundingClientRect() ?? null, height));
    };
    place();
    const composer = document.querySelector<HTMLElement>("[data-composer]");
    const observer = typeof ResizeObserver === "function" && composer ? new ResizeObserver(place) : null;
    if (observer && composer) observer.observe(composer);
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [ref, shown]);
  return bottom === null ? {} : { bottom };
}
