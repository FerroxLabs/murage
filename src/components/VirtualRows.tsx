// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A windowed list for "All apps": 1,500+ rows, of which only the ones in
// view (plus a few either side) are in the document. Rows may differ in
// height (an app's accounts, its label form), so each rendered row is
// measured and the rest use an estimate. It scrolls with the panel's own
// body rather than a scroller of its own, so the dialog keeps one scrollbar.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/** First index whose row ends below `y`, by binary search over offsets. */
export function rowAt(offsets: ReadonlyArray<number>, y: number): number {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid + 1] <= y) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low);
}

/** Which rows to render for a viewport, with `overscan` rows either side. */
export function visibleRange(offsets: ReadonlyArray<number>, top: number, height: number, overscan: number): [number, number] {
  const count = offsets.length - 1;
  if (count <= 0) return [0, 0];
  const first = rowAt(offsets, Math.max(0, top));
  const last = rowAt(offsets, Math.max(0, top + height));
  return [Math.max(0, first - overscan), Math.min(count, last + 1 + overscan)];
}

export function VirtualRows({
  count,
  scrollRef,
  estimate = 88,
  overscan = 6,
  renderRow,
  onRange,
}: {
  count: number;
  scrollRef: RefObject<HTMLElement | null>;
  estimate?: number;
  overscan?: number;
  renderRow: (index: number) => ReactNode;
  /** told the rendered range, so the caller can fetch the next page */
  onRange?: (first: number, last: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<number, number>());
  const [, setMeasured] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 900, width: 0 });

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const update = () => {
      const list = listRef.current;
      if (!list) return;
      const offset = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      setViewport((current) => {
        const next = { top: scroller.scrollTop - offset, height: scroller.clientHeight, width: scroller.clientWidth };
        // A width change can rewrap every row: measure them all again.
        if (next.width !== current.width) heights.current.clear();
        return current.top === next.top && current.height === next.height && current.width === next.width ? current : next;
      });
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [scrollRef]);

  const offsets: number[] = Array.from({ length: count + 1 }, () => 0);
  offsets[0] = 0;
  for (let index = 0; index < count; index += 1) offsets[index + 1] = offsets[index] + (heights.current.get(index) ?? estimate);
  const [first, last] = visibleRange(offsets, viewport.top, viewport.height, overscan);

  useEffect(() => {
    onRange?.(first, last);
  }, [first, last, onRange]);

  const rows: ReactNode[] = [];
  for (let index = first; index < last; index += 1) {
    rows.push(
      <div
        key={index}
        ref={(element) => {
          if (!element) return;
          const height = element.offsetHeight;
          if (height > 0 && heights.current.get(index) !== height) {
            heights.current.set(index, height);
            setMeasured((tick) => tick + 1);
          }
        }}
        style={{ position: "absolute", top: offsets[index], left: 0, right: 0 }}
      >
        {renderRow(index)}
      </div>,
    );
  }
  return (
    <div ref={listRef} role="list" aria-rowcount={count} style={{ position: "relative", height: offsets[count] }}>
      {rows}
    </div>
  );
}
