import { describe, expect, it, vi } from "vitest";

import { captureRowAnchor, observeSeenRows, restoreRowAnchor } from "./transcript-rows";

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
