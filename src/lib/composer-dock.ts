import { useCallback, useLayoutEffect, useState } from "react";

/** Same as Tailwind `gap-3` on the transcript stack. The last bubble sits
 * this far above the composer when the pane is scrolled to the end. */
export const TRANSCRIPT_GAP = "0.75rem";

/** Empty one-line pill (~44px) plus the dock's `pb-3`. ResizeObserver
 * replaces this as soon as the real composer mounts. */
const FALLBACK_COMPOSER_PX = 64;

export function transcriptEndPad(composerHeightPx: number): string {
  const height = Number.isFinite(composerHeightPx)
    ? Math.max(0, Math.ceil(composerHeightPx))
    : FALLBACK_COMPOSER_PX;
  return `calc(${height}px + ${TRANSCRIPT_GAP})`;
}

type ResizeObserverLike = { observe(target: Element): void; disconnect(): void };
type ResizeObserverCtor = new (callback: () => void) => ResizeObserverLike;

/** Report the dock's height now and on every resize (multiline text, the
 * queued chip, attachments, a reply preview, an approval takeover). Returns
 * the cleanup. No element means nothing to measure: the height is 0 and the
 * caller falls back. */
export function observeDockHeight(
  el: Element | null,
  onHeight: (px: number) => void,
  Observer: ResizeObserverCtor = ResizeObserver,
): () => void {
  if (!el) {
    onHeight(0);
    return () => {};
  }
  const apply = () => onHeight(el.getBoundingClientRect().height);
  apply();
  const observer = new Observer(apply);
  observer.observe(el);
  return () => observer.disconnect();
}

/** Pad the transcript so rest-at-bottom leaves one inter-bubble gap of
 * black above the docked composer, whose real height is measured.
 *
 * `ref` is a callback ref, not a RefObject. A project room can open on its
 * Overview tab, where the dock is not mounted; with a RefObject the effect
 * ran once against `null` and never observed the dock that mounted on the
 * Chat tab, so the transcript kept the one-line fallback pad and a grown
 * composer (queued chip, busy hint, inject now) covered the newest bubble.
 * Holding the element in state re-observes whenever the dock mounts. */
export function useComposerDockPad() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => observeDockHeight(el, setHeight), [el]);
  const ref = useCallback((node: HTMLElement | null) => setEl(node), []);
  const measured = height > 0 ? height : FALLBACK_COMPOSER_PX;
  return { ref, pad: transcriptEndPad(measured), height: measured };
}
