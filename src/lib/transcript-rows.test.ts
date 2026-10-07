import { describe, expect, it, vi } from "vitest";

import { captureRowAnchor, captureViewportAnchor, observeSeenRows, restoreRowAnchor } from "./transcript-rows";

/** A scroller whose rows sit at fixed document offsets; scrollTop is live. */
function scroller(rows: Array<[id: string, top: number]>, scrollTop = 0) {
  const el = {
    scrollTop,
    rows: rows.map(([id, top]) => ({ dataset: { row: id }, top })),
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => el.rows.map((row) => ({
      dataset: row.dataset,
      getBoundingClientRect: () => ({ top: 100 + row.top - el.scrollTop }),
    })),
  };
  return el;
}

describe("row anchors", () => {
  it("keeps the first row still when a page lands above it and the bottom is trimmed", () => {
    const el = scroller([["m100", 0], ["m101", 80], ["m102", 160]], 40);
    const anchor = captureRowAnchor(el as never, "t", "first")!;
    expect(anchor).toEqual({ key: "t", id: "m100", offset: -40 });
    // 120 older rows (6000 px) mounted above; the newest rows unmounted below,
    // so scrollHeight grew by much less than 6000: a height delta would be wrong
    el.rows = [["m0", 0] as const, ["m100", 6000] as const].map(([id, top]) => ({ dataset: { row: id }, top }));
    expect(restoreRowAnchor(el as never, anchor)).toBe(true);
    expect(el.scrollTop).toBe(6040);
  });

  it("keeps the last row still when reading forward trims the top", () => {
    const el = scroller([["m0", 0], ["m1", 500], ["m2", 900]], 700);
    const anchor = captureRowAnchor(el as never, "t", "last")!;
    expect(anchor.id).toBe("m2");
    el.rows = [["m2", 300], ["m3", 700]].map(([id, top]) => ({ dataset: { row: id as string }, top: top as number }));
    restoreRowAnchor(el as never, anchor);
    expect(el.scrollTop).toBe(100);
  });

  it("does nothing when the anchor row is gone (a branch switch)", () => {
    const el = scroller([["m0", 0]], 10);
    expect(restoreRowAnchor(el as never, { key: "t", id: "gone", offset: 0 })).toBe(false);
    expect(el.scrollTop).toBe(10);
  });

  // The oldest held row opens with the day's separator; once the page before
  // it lands (same day) the separator moves up to the new oldest row. Keeping
  // the ROW's top still then moved the message itself up by the separator's
  // height (thread-paging.human, 55.75 px). What is kept still is the row's
  // content below any separator.
  it("keeps the message still when the day separator above it leaves its row", () => {
    const el = {
      scrollTop: 0,
      separator: 56,
      rowTop: 0,
      getBoundingClientRect: () => ({ top: 100 }),
      querySelectorAll: () => [{
        dataset: { row: "m100" },
        getBoundingClientRect: () => ({ top: 100 + el.rowTop - el.scrollTop }),
        querySelector: (selector: string) => {
          expect(selector).toContain("[data-day-separator]");
          return { getBoundingClientRect: () => ({ top: 100 + el.rowTop + el.separator - el.scrollTop, height: 20 }) };
        },
      }],
    };
    const anchor = captureRowAnchor(el as never, "t", "first")!;
    expect(anchor.offset).toBe(56);
    el.rowTop = 6000; el.separator = 0;
    restoreRowAnchor(el as never, anchor);
    // the message sat 56 px below the scroller top, and still does
    expect(100 + el.rowTop + el.separator - el.scrollTop - 100).toBe(56);
  });

  // A room row opens with the speaker's name when it starts a turn. When the
  // older page lands and its last message is from the same speaker, the name
  // leaves that row (the turn now started above), and keeping the name's top
  // still moved the message up by the label's height (0.1.61 CI audit on
  // d851c9c4). Like the day separator, the label is row chrome.
  it("keeps the message still when a room row's speaker label leaves it", () => {
    type Child = { attrs: string[]; height: number };
    const el = {
      scrollTop: 0,
      rowTop: 0,
      children: [{ attrs: ["data-row-chrome"], height: 32 }, { attrs: [], height: 80 }] as Child[],
      getBoundingClientRect: () => ({ top: 100 }),
      querySelectorAll: () => [{
        dataset: { row: "m100" },
        getBoundingClientRect: () => ({ top: 100 + el.rowTop - el.scrollTop, height: 1 }),
        // `:scope > :not([a], [b])`: the first direct child carrying none of
        // the listed attributes.
        querySelector: (selector: string) => {
          const excluded = [...selector.matchAll(/\[([\w-]+)\]/g)].map((match) => match[1]);
          let top = 100 + el.rowTop - el.scrollTop;
          for (const child of el.children) {
            if (!child.attrs.some((attr) => excluded.includes(attr))) return { getBoundingClientRect: () => ({ top, height: child.height }) };
            top += child.height;
          }
          return null;
        },
      }],
    };
    const anchor = captureRowAnchor(el as never, "t", "first")!;
    expect(anchor.offset).toBe(32);
    el.rowTop = 6000; el.children = [{ attrs: [], height: 80 }];
    restoreRowAnchor(el as never, anchor);
    // the message sat 32 px below the scroller top, and still does
    expect(100 + el.rowTop - el.scrollTop - 100).toBe(32);
  });

  // A row skipped by content-visibility has children with no box yet; its own
  // rect is then the better guess than a child's empty one.
  it("falls back to the row's own top when its content has no box", () => {
    const el = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 100 }),
      querySelectorAll: () => [{
        dataset: { row: "m1" },
        getBoundingClientRect: () => ({ top: 140 - el.scrollTop, height: 50 }),
        querySelector: () => ({ getBoundingClientRect: () => ({ top: 0, height: 0 }) }),
      }],
    };
    expect(captureRowAnchor(el as never, "t", "first")!.offset).toBe(40);
  });

  it("has no anchor in an empty transcript", () => {
    expect(captureRowAnchor(scroller([]) as never, "t", "first")).toBeNull();
  });
});

describe("seen rows", () => {
  it("marks a row the first time it is on screen and stops watching it", () => {
    const observed: unknown[] = [];
    const unobserved: unknown[] = [];
    let callback!: (entries: Array<{ isIntersecting: boolean; target: { setAttribute(name: string, value: string): void } }>) => void;
    class FakeObserver {
      constructor(cb: typeof callback, readonly options: { root: unknown }) { callback = cb; }
      observe(target: unknown) { observed.push(target); }
      unobserve(target: unknown) { unobserved.push(target); }
      disconnect = vi.fn();
    }
    const row = { setAttribute: vi.fn() };
    const other = { setAttribute: vi.fn() };
    const root = { querySelectorAll: vi.fn(() => [row, other]) };
    const stop = observeSeenRows(root as never, {} as never, FakeObserver as never);
    expect(root.querySelectorAll).toHaveBeenCalledWith("[data-row]:not([data-seen])");
    expect(observed).toEqual([row, other]);
    callback([{ isIntersecting: true, target: row }, { isIntersecting: false, target: other }]);
    expect(row.setAttribute).toHaveBeenCalledWith("data-seen", "");
    expect(other.setAttribute).not.toHaveBeenCalled();
    expect(unobserved).toEqual([row]);
    stop();
  });

  it("is a no-op where IntersectionObserver does not exist", () => {
    const root = { querySelectorAll: vi.fn(() => []) };
    expect(() => observeSeenRows(root as never, {} as never, undefined)()).not.toThrow();
    expect(root.querySelectorAll).not.toHaveBeenCalled();
  });

  it("forgets seen rows when the scroller's width changes, so they are measured again", () => {
    const observed: unknown[] = [];
    class FakeObserver {
      constructor(_cb: unknown, readonly options: unknown) {}
      observe(target: unknown) { observed.push(target); }
      unobserve() {}
      disconnect = vi.fn();
    }
    let resized!: (entries: Array<{ contentRect: { width: number } }>) => void;
    const resizeDisconnect = vi.fn();
    const watched: unknown[] = [];
    class FakeResize {
      constructor(cb: typeof resized) { resized = cb; }
      observe(target: unknown) { watched.push(target); }
      disconnect = resizeDisconnect;
    }
    const seen = { setAttribute: vi.fn(), removeAttribute: vi.fn() };
    const root = { querySelectorAll: vi.fn((selector: string) => (selector.endsWith("[data-seen]") ? [seen] : [])) };
    const scrollerEl = {};
    const stop = observeSeenRows(root as never, scrollerEl as never, FakeObserver as never, FakeResize as never);
    expect(watched).toEqual([scrollerEl]);
    resized([{ contentRect: { width: 400 } }]); // the first report only records
    resized([{ contentRect: { width: 400 } }]); // a height change: same width
    expect(seen.removeAttribute).not.toHaveBeenCalled();
    resized([{ contentRect: { width: 800 } }]); // rotated
    expect(root.querySelectorAll).toHaveBeenCalledWith("[data-row][data-seen]");
    expect(seen.removeAttribute).toHaveBeenCalledWith("data-seen");
    expect(observed).toEqual([seen]); // watched again, marked on its next appearance
    stop();
    expect(resizeDisconnect).toHaveBeenCalled();
  });
});

describe("captureViewportAnchor (a chip lands under an older reply)", () => {
  /** Rows have heights; the scroller top is 100. */
  function sized(rows: Array<[id: string, top: number, height: number]>, scrollTop: number) {
    const el = {
      scrollTop,
      heights: new Map(rows.map(([id, , height]) => [id, height])),
      tops: new Map(rows.map(([id, top]) => [id, top])),
      getBoundingClientRect: () => ({ top: 100 }),
      querySelectorAll: () => rows.map(([id]) => ({ dataset: { row: id }, getBoundingClientRect: () => ({ top: 100 + el.tops.get(id)! - el.scrollTop, height: el.heights.get(id)! }) })),
    };
    return el;
  }
  it("holds the first row that reaches into the view, not a row scrolled far above it", () => {
    const el = sized([["a", 0, 100], ["b", 100, 100], ["c", 200, 100]], 150);
    const anchor = captureViewportAnchor(el, "t1")!;
    expect(anchor).toMatchObject({ key: "t1", id: "b" });
    // a chip lands under row "a": everything below moves down 32px, scrollTop is restored
    el.tops.set("b", 132); el.tops.set("c", 232);
    expect(restoreRowAnchor(el, anchor)).toBe(true);
    expect(el.scrollTop).toBe(182);
    expect(100 + el.tops.get("b")! - el.scrollTop - 100).toBe(anchor.offset);
  });
  it("is null with no rows", () => {
    expect(captureViewportAnchor(sized([], 0), "t1")).toBeNull();
  });
});
