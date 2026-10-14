// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The arithmetic of a virtual transcript (components/VirtualTranscript.tsx): only
// the rows near the viewport are mounted, and the rows above and below are
// stood in for by padding of their measured (or estimated) height.
//
// Coordinates are "list" pixels: 0 is the top of the first row. A row's
// height includes the gap after it, so offsets add up to the real layout.
// The reader's place is an anchor, a row and how far its top sits from the
// top of the viewport. While an anchor is held, every re-layout (rows
// measured, a page prepended, a reply growing below) puts that row back where
// it was. No anchor means the reader is at the live end.

/** A row not yet measured: the same estimate the row CSS reserves
 * (`contain-intrinsic-size` in styles.css) plus the 12px gap. */
export const ROW_ESTIMATE_PX = 132;
/** Rows kept mounted beyond each edge of the viewport. */
export const OVERSCAN_PX = 800;
/** How close the viewport may come to an unmounted row before a refill. */
export const REFILL_MARGIN_PX = 240;
/** A viewport whose size is not known yet (first render, a hidden pane). */
export const FALLBACK_VIEWPORT_PX = 1000;
/** Mounted rows never exceed this, however small the rows measure. */
export const MAX_MOUNTED_ITEMS = 160;
/** A pinned row (focused, edited, jumped to) stays mounted while it is this
 * many rows or fewer from the mounted range. */
export const MAX_PIN_DISTANCE = 60;

export interface RowAnchor {
  key: string;
  /** The row's top minus the viewport's top, px. */
  offsetInView: number;
}

export interface RowRange {
  /** First mounted index. */
  start: number;
  /** One past the last mounted index. */
  end: number;
}

/** offsets[i] is where row i starts; offsets[n] is the total height. */
export function rowOffsets(keys: readonly string[], heights: ReadonlyMap<string, number>, estimate = ROW_ESTIMATE_PX): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < keys.length; i++) offsets.push(offsets[i]! + (heights.get(keys[i]!) ?? estimate));
  return offsets;
}

/** The row that holds list pixel `y` (clamped to the rows that exist). Rows
 * of no height never hold a pixel; the first row at or after them does. */
export function rowAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The top of the viewport in list pixels: from the anchor when its row is
 * still here, at the end when there is no anchor, else where it last was. */
export function viewportTop(
  offsets: readonly number[],
  indexOf: (key: string) => number,
  anchor: RowAnchor | null,
  viewport: number,
  lastTop: number,
): number {
  const total = offsets[offsets.length - 1] ?? 0;
  if (!anchor) return Math.max(0, total - viewport);
  const index = indexOf(anchor.key);
  return index < 0 ? Math.max(0, Math.min(lastTop, total - viewport)) : offsets[index]! - anchor.offsetInView;
}

/** The rows to mount for a viewport at `top`: what it shows plus the
 * overscan, never more than `max`, stretched to reach any pinned row close
 * enough to keep. */
export function mountedRange(
  offsets: readonly number[],
  top: number,
  viewport: number,
  pins: readonly number[] = [],
  overscan = OVERSCAN_PX,
  max = MAX_MOUNTED_ITEMS,
): RowRange {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  const firstVisible = rowAt(offsets, top);
  const lastVisible = rowAt(offsets, top + viewport);
  let start = rowAt(offsets, top - overscan);
  let end = Math.min(n, rowAt(offsets, top + viewport + overscan) + 1);
  if (end - start > max) {
    const visible = lastVisible + 1 - firstVisible;
    if (visible >= max) {
      start = firstVisible;
      end = firstVisible + max;
    } else {
      const spare = max - visible;
      start = Math.max(start, firstVisible - Math.floor(spare / 2));
      end = Math.min(end, start + max);
      start = Math.max(0, Math.min(start, end - max));
    }
  }
  for (const pin of pins) {
    if (pin < 0 || pin >= n) continue;
    if (pin < start && start - pin <= MAX_PIN_DISTANCE) start = pin;
    else if (pin >= end && pin + 1 - end <= MAX_PIN_DISTANCE) end = pin + 1;
  }
  return { start, end };
}

/** The reader's place at list pixel `top`: the first row that reaches into
 * the viewport. */
export function anchorAt(offsets: readonly number[], keys: readonly string[], top: number): RowAnchor | null {
  if (!keys.length) return null;
  const index = rowAt(offsets, top);
  return { key: keys[index]!, offsetInView: offsets[index]! - top };
}

/** True when the viewport has come within `margin` of an unmounted row. */
export function needsRefill(offsets: readonly number[], range: RowRange, top: number, viewport: number, margin = REFILL_MARGIN_PX): boolean {
  const n = offsets.length - 1;
  return (range.start > 0 && top - margin < offsets[range.start]!) || (range.end < n && top + viewport + margin > offsets[range.end]!);
}

/**
 * Where to put the scroll so the anchor row stays where the reader had it.
 * `placed` is the anchor's offset the scroll was last calibrated to: when it
 * is known, the correction is only how far the rows above the anchor moved
 * since, added to wherever the scroll is NOW. An absolute target would be the
 * scroll position captured at the last scroll event, and applying it after a
 * slow refill drags back a scroll already in flight (Jump to latest). With no
 * `placed` (a row just jumped to) the absolute form places it. Null: nothing
 * to correct.
 */
export function anchorScrollTarget(input: {
  scrollTop: number;
  anchorOffset: number;
  placed: number | null;
  listTop: number;
  offsetInView: number;
}): number | null {
  const want = input.placed === null
    ? Math.max(0, input.listTop + input.anchorOffset - input.offsetInView)
    : Math.max(0, input.scrollTop + (input.anchorOffset - input.placed));
  return Math.abs(input.scrollTop - want) >= 1 ? want : null;
}
