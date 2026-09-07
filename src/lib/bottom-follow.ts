import { useLayoutEffect, type RefObject } from "react";

/** Subpixel slack for "at the rest position" — not a magnet zone. A larger
 * value used to re-pin follow ~48px early and then jump the pane to the end. */
export const BOTTOM_FOLLOW_THRESHOLD = 4;

/**
 * Resume automatic bottom-follow only when the reader is already at the
 * rest position and still moving toward it. Re-pinning must not imply a
 * snap; the scroll effect follows new content, it does not yank the viewport.
 */
export function shouldResumeBottomFollow({
  following,
  previousScrollTop,
  scrollTop,
  distanceFromBottom,
}: {
  following: boolean;
  previousScrollTop: number;
  scrollTop: number;
  distanceFromBottom: number;
}): boolean {
  return !following && scrollTop > previousScrollTop && distanceFromBottom < BOTTOM_FOLLOW_THRESHOLD;
}

export function followBottomGrowth(scroller: { scrollHeight: number; scrollTo(options: ScrollToOptions): void }, following: boolean): boolean {
  if (!following) return false;
  scroller.scrollTo({ top: scroller.scrollHeight });
  return true;
}

/** Upstream 351506e0: delayed thinking rows and other resized descendants must
 * stay visible only while the reader is already following the transcript. */
export function useBottomFollowResize(scrollRef: RefObject<HTMLElement | null>, transcriptRef: RefObject<HTMLElement | null>, followingRef: RefObject<boolean>, observeKey: string | null): void {
  useLayoutEffect(() => {
    const scroller = scrollRef.current, transcript = transcriptRef.current;
    if (!scroller || !transcript || observeKey === null) return;
    const observer = new ResizeObserver(() => { followBottomGrowth(scroller, followingRef.current); });
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [followingRef, observeKey, scrollRef, transcriptRef]);
}
