/** Long computer-use threads carry hundreds of rows (inline screenshots
 * included); mounting all of them makes the DOM heavy even though the memoized
 * list bails out of re-renders. Only the last `TRANSCRIPT_WINDOW_SIZE`
 * messages mount by default; a pill expands by the same step. */
export const TRANSCRIPT_WINDOW_SIZE = 120;

/** How close to the top a reader scrolled back has to get before the next
 * rows (held or on the server) are brought in. */
export const SCROLLBACK_TRIGGER_PX = 200;

export interface TranscriptWindow<T> {
  visible: T[];
  /** Messages hidden before the window — the pill's "(X more)" count. */
  hiddenCount: number;
  /** Messages hidden after a finite search-focus window. */
  laterCount: number;
  /** The boundary actually applied after clamping; expand steps from this,
   * not from the stored value, so a clamped window expands predictably. */
  startIndex: number;
  /** Exclusive end boundary, or the current list length for a tail window. */
  endIndex: number;
}

export interface TranscriptWindowRange {
  start: number;
  end: number;
}

/** Boundary for a fresh window: the last `size` messages. */
export function tailWindowStart(total: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, total - size);
}

/** One "Show earlier" click: pull the boundary back by another `size`. */
export function expandWindowStart(startIndex: number, size: number = TRANSCRIPT_WINDOW_SIZE): number {
  return Math.max(0, startIndex - size);
}

/** A bounded window containing a search target. Keeping this finite avoids
 * mounting an entire old transcript merely to land on one result. */
export function focusWindowRange(
  total: number,
  targetIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
): TranscriptWindowRange {
  const safeTotal = Math.max(0, total);
  const safeSize = Math.max(1, size);
  const target = Math.max(0, Math.min(targetIndex, Math.max(0, safeTotal - 1)));
  const start = Math.max(0, Math.min(target - Math.floor(safeSize / 2), Math.max(0, safeTotal - safeSize)));
  return { start, end: Math.min(safeTotal, start + safeSize) };
}

/** Resolve a stored boundary against the current list. The boundary is
 * anchored — appends grow the window instead of sliding it, so rows the
 * reader is looking at never drop out from under them. Anchoring means a
 * thread that shrinks (branch switch, edit rewinding the tail) can leave the
 * boundary at or past the new end; that stale boundary falls back to a fresh
 * tail window rather than blanking the transcript. */
export function resolveTranscriptWindow<T>(
  messages: readonly T[],
  startIndex: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  endIndex: number | null = null,
): TranscriptWindow<T> {
  const requestedEnd = endIndex === null ? messages.length : Math.max(0, Math.min(messages.length, endIndex));
  const invalidFiniteWindow = endIndex !== null && startIndex >= requestedEnd;
  const start =
    startIndex >= messages.length || invalidFiniteWindow
      ? tailWindowStart(messages.length, size)
      : Math.max(0, startIndex);
  const end = invalidFiniteWindow ? messages.length : Math.max(start, requestedEnd);
  return {
    visible: messages.slice(start, end),
    hiddenCount: start,
    laterCount: messages.length - end,
    startIndex: start,
    endIndex: end,
  };
}

/** Older messages were prepended ahead of the row that used to be first
 * (`shift` = its new index; -1 when it is gone, e.g. a branch switch).
 * Indices below are positions in the list, so a mounted window would slide
 * `shift` rows back in time; move it with the rows instead. `reveal` is the
 * reader at the top asking for those rows: a window at the top (start 0)
 * then stays there so they appear. Pages a jump walks through are not asked
 * for by the reader and stay unmounted (upstream #1527). */
export function windowAfterPrepend<W extends { start: number; end: number | null }>(window: W, shift: number, reveal = false): W {
  if (shift <= 0) return window;
  return {
    ...window,
    start: reveal && window.start === 0 ? 0 : window.start + shift,
    end: window.end === null ? null : window.end + shift,
  };
}

/** The most transcript rows mounted at once (spec §6). Reading back used to
 * grow the window without end: every "Show earlier" added a window and none
 * was ever taken away, so an hour of scrollback on a phone meant thousands of
 * live rows. Three windows is one on screen with a window of slack each way. */
export const MAX_MOUNTED_ROWS = TRANSCRIPT_WINDOW_SIZE * 3;

export interface WindowBounds {
  start: number;
  /** null: a live tail that grows with appends. */
  end: number | null;
}

/** "Show earlier" (or reaching the top). The start steps back; past the cap
 * the newest rows unmount, and the end becomes finite so "Show later" can
 * bring them back. The reader is reading back, so the rows dropped are the
 * ones below the screen. */
export function expandEarlier(
  bounds: WindowBounds,
  total: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  cap: number = MAX_MOUNTED_ROWS,
): WindowBounds {
  const start = expandWindowStart(Math.min(bounds.start, total), size);
  const end = bounds.end === null ? total : Math.min(bounds.end, total);
  if (end - start <= cap) return { start, end: bounds.end === null ? null : end };
  return { start, end: start + cap };
}

/** "Show later". The mirror image: the end steps forward, and past the cap
 * the oldest rows unmount. Reaching the end of the thread is a live tail
 * again. */
export function expandLater(
  bounds: WindowBounds,
  total: number,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  cap: number = MAX_MOUNTED_ROWS,
): WindowBounds {
  const end = bounds.end === null ? total : Math.min(total, bounds.end + size);
  const start = Math.max(bounds.start, end - cap);
  return { start, end: end >= total ? null : end };
}

/** A tail the reader is following grows with every append; a long live
 * session would mount rows without end. Past the cap it is cut back to one
 * fresh window. Only while following: the reader is pinned to the bottom, so
 * rows leaving the top were already off screen. A reader who scrolled up is
 * never moved (anchored window, see resolveTranscriptWindow). */
export function trimFollowedTail(
  bounds: WindowBounds,
  total: number,
  following: boolean,
  size: number = TRANSCRIPT_WINDOW_SIZE,
  cap: number = MAX_MOUNTED_ROWS,
): WindowBounds {
  if (!following || bounds.end !== null || total - bounds.start <= cap) return bounds;
  return { start: tailWindowStart(total, size), end: null };
}

/** A page the reader asked for, revealed at the top (windowAfterPrepend's
 * `reveal`). The window keeps its start so the page appears; past the cap the
 * newest rows unmount, as for expandEarlier. Without this, reading back
 * through the server's pages mounted every page. */
export function capRevealedWindow<W extends WindowBounds>(
  bounds: W,
  total: number,
  cap: number = MAX_MOUNTED_ROWS,
): W {
  const end = bounds.end === null ? total : Math.min(bounds.end, total);
  if (end - bounds.start <= cap) return bounds;
  return { ...bounds, end: bounds.start + cap };
}
