// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A transcript that mounts only what is on screen (plus an overscan), however
// long the conversation. The rows above and below stand in as padding of
// their measured height; the arithmetic is lib/virtual-transcript.ts.
//
// The reader's place is held as an anchor row. Rows measuring in, a page
// landing above, a chip growing under an older reply: after each, the anchor
// row is put back where it was, so nothing moves under the reader. At the
// live end there is no anchor, and the transcript's own bottom-follow keeps
// the newest row in view while a reply streams in.
//
// Every row keeps its place in the DOM order, inside the transcript's
// `role="log"`; a focused row, the row being edited and a row jumped to stay
// mounted even while scrolled away, so focus and the search flash are never
// pulled out from under a keyboard or a screen reader.
import { useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from "react";

import {
  anchorAt,
  anchorScrollTarget,
  FALLBACK_VIEWPORT_PX,
  mountedRange,
  needsRefill,
  rowOffsets,
  viewportTop,
  type RowAnchor,
  type RowRange,
} from "@/lib/virtual-transcript";

/** Measured row heights kept across conversations (switching back reuses them). */
const MAX_REMEMBERED_HEIGHTS = 4_000;

interface Held {
  heights: Map<string, number>;
  anchor: RowAnchor | null;
  /** The anchor's offset the scroll was last calibrated to (null: not yet placed). */
  placed: number | null;
  viewport: number;
  width: number;
  lastTop: number;
  resetKey: string;
  follow: boolean;
  focusKey: string | null;
  focused: string | null;
  range: RowRange;
  offsets: number[];
  keys: readonly string[];
  index: ReadonlyMap<string, number>;
  /** The scrollTop this list set last; its own scroll event is not the reader. */
  set: number | null;
  observer: ResizeObserver | null;
  observed: Set<Element>;
  frame: number;
}

export function VirtualTranscript<T>({
  items,
  keyOf,
  render,
  scrollRef,
  followRef,
  follow,
  resetKey,
  focusKey = null,
  pinKey = null,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T, index: number) => ReactNode;
  scrollRef: RefObject<HTMLElement | null>;
  /** True while the transcript follows its newest row. */
  followRef: RefObject<boolean>;
  follow: boolean;
  /** The conversation: a new one starts at its live end. */
  resetKey: string;
  /** A row to bring into view and hold (a jump or search hit). */
  focusKey?: string | null;
  /** A row to keep mounted (the one being edited). */
  pinKey?: string | null;
}) {
  const [, refill] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const held = useRef<Held | null>(null);
  held.current ??= {
    heights: new Map(), anchor: null, placed: null, viewport: FALLBACK_VIEWPORT_PX, width: 0, lastTop: 0, resetKey, follow,
    focusKey: null, focused: null, range: { start: 0, end: 0 }, offsets: [0], keys: [], index: new Map(),
    set: null, observer: null, observed: new Set(), frame: 0,
  };
  const v = held.current;
  // keyOf is read with the items it belongs to
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { keys, index } = useMemo(() => {
    const keys = items.map(keyOf);
    return { keys, index: new Map(keys.map((key, i) => [key, i])) };
  }, [items]);

  if (v.resetKey !== resetKey) {
    v.resetKey = resetKey;
    v.anchor = null;
    v.placed = null;
    v.lastTop = 0;
    v.focused = null;
  }
  // Following again (Jump to latest, back at the end): the live end, no anchor.
  if (follow && !v.follow) { v.anchor = null; v.placed = null; }
  v.follow = follow;
  if (focusKey && focusKey !== v.focusKey && index.has(focusKey)) {
    v.anchor = { key: focusKey, offsetInView: Math.round(v.viewport / 3) };
    v.placed = null;
  }
  v.focusKey = focusKey;

  const offsets = rowOffsets(keys, v.heights);
  const top = viewportTop(offsets, (key) => index.get(key) ?? -1, v.anchor, v.viewport, v.lastTop);
  const pins: number[] = [];
  for (const key of [v.focused, pinKey, focusKey]) {
    const at = key ? index.get(key) : undefined;
    if (at !== undefined) pins.push(at);
  }
  const range = mountedRange(offsets, top, v.viewport, pins);
  v.range = range;
  v.offsets = offsets;
  v.keys = keys;
  v.index = index;

  // Measure what mounted, then hold the anchor row where the reader had it.
  const measure = () => {
    const el = scrollRef.current, list = listRef.current;
    // No layout (a hidden pane, a test without a DOM): estimates stand.
    if (!el || !list || !el.clientHeight || !el.clientWidth) return;
    let changed = false;
    if (v.viewport !== el.clientHeight) {
      v.viewport = el.clientHeight;
      changed = true;
    }
    // A height is right only at the width it was measured at.
    if (v.width && v.width !== el.clientWidth) v.heights.clear();
    // Heights of rows from conversations left long ago are let go.
    if (v.heights.size > MAX_REMEMBERED_HEIGHTS) {
      for (const key of v.heights.keys()) if (!v.index.has(key)) v.heights.delete(key);
    }
    v.width = el.clientWidth;
    const mounted = new Set<string>();
    for (const child of Array.from(list.children)) {
      const key = (child as HTMLElement).dataset.vkey;
      if (!key) continue;
      mounted.add(key);
      const height = child.getBoundingClientRect().height;
      if (v.heights.get(key) !== height) {
        v.heights.set(key, height);
        changed = true;
      }
      if (!v.observed.has(child)) {
        v.observer?.observe(child);
        v.observed.add(child);
      }
    }
    for (const element of v.observed) {
      if (element.isConnected) continue;
      v.observer?.unobserve(element);
      v.observed.delete(element);
    }
    // A row that rendered nothing takes no room.
    for (let i = v.range.start; i < v.range.end; i++) {
      const key = v.keys[i]!;
      if (!mounted.has(key) && v.heights.get(key) !== 0) {
        v.heights.set(key, 0);
        changed = true;
      }
    }
    if (changed) v.offsets = rowOffsets(v.keys, v.heights);
    const anchorIndex = v.anchor ? v.index.get(v.anchor.key) : undefined;
    if (v.anchor && anchorIndex !== undefined) {
      const listTop = list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const anchorOffset = v.offsets[anchorIndex]!;
      const target = anchorScrollTarget({ scrollTop: el.scrollTop, anchorOffset, placed: v.placed, listTop, offsetInView: v.anchor.offsetInView });
      if (target !== null) {
        el.scrollTop = target;
        v.set = el.scrollTop;
      }
      v.placed = anchorOffset;
    }
    if (changed) refill((n) => n + 1);
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const Observer = globalThis.ResizeObserver;
    v.observer = Observer
      ? new Observer(() => {
          cancelAnimationFrame(v.frame);
          v.frame = requestAnimationFrame(() => measureRef.current());
        })
      : null;
    v.observer?.observe(el);
    const onScroll = () => {
      const list = listRef.current;
      if (!list) return;
      if (v.set !== null && Math.abs(el.scrollTop - v.set) < 1) {
        v.set = null;
        return;
      }
      v.set = null;
      const top = el.scrollTop - (list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop);
      v.lastTop = top;
      if (el.clientHeight) v.viewport = el.clientHeight;
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      v.anchor = followRef.current && fromBottom < 4 ? null : anchorAt(v.offsets, v.keys, top);
      v.placed = v.anchor ? (v.offsets[v.index.get(v.anchor.key) ?? -1] ?? null) : null;
      if (needsRefill(v.offsets, v.range, top, v.viewport)) refill((n) => n + 1);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(v.frame);
      v.observer?.disconnect();
      v.observer = null;
      v.observed.clear();
    };
  }, [scrollRef, followRef, v]);
  useLayoutEffect(() => measureRef.current());

  if (!items.length) return null;
  const total = offsets[offsets.length - 1]!;
  return (
    <div
      ref={listRef}
      className="-mb-3 flex flex-col"
      style={{ paddingTop: offsets[range.start], paddingBottom: total - offsets[range.end]! }}
      onFocus={(event: FocusEvent<HTMLDivElement>) => {
        v.focused = (event.target as HTMLElement).closest?.("[data-vkey]")?.getAttribute("data-vkey") ?? null;
      }}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) v.focused = null;
      }}
    >
      {items.slice(range.start, range.end).map((item, offset) => {
        const at = range.start + offset;
        const node = render(item, at);
        if (node === null || node === undefined || node === false) return null;
        return (
          <div key={keys[at]} data-vkey={keys[at]} className="flex flex-col pb-3">
            {node}
          </div>
        );
      })}
    </div>
  );
}
