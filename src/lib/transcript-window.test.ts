import { describe, expect, it } from "vitest";

import {
  MAX_MOUNTED_ROWS,
  TRANSCRIPT_WINDOW_SIZE,
  expandEarlier,
  expandLater,
  expandWindowStart,
  focusWindowRange,
  resolveTranscriptWindow,
  tailWindowStart,
  trimFollowedTail,
  windowAfterPrepend,
} from "./transcript-window";

const thread = (total: number): number[] => Array.from({ length: total }, (_, i) => i);

describe("tailWindowStart", () => {
  it("shows everything when the thread is shorter than the window", () => {
    expect(tailWindowStart(10)).toBe(0);
  });

  it("shows everything when the thread is exactly one window", () => {
    expect(tailWindowStart(TRANSCRIPT_WINDOW_SIZE)).toBe(0);
  });

  it("starts one window back from the tail of a long thread", () => {
    expect(tailWindowStart(300)).toBe(180);
  });

  it("is zero for an empty thread", () => {
    expect(tailWindowStart(0)).toBe(0);
  });
});

describe("expandWindowStart", () => {
  it("pulls the boundary back by one window per click", () => {
    expect(expandWindowStart(300)).toBe(180);
  });

  it("clamps an expansion past the start of the thread to zero", () => {
    expect(expandWindowStart(60)).toBe(0);
  });

  it("stays at zero once fully expanded", () => {
    expect(expandWindowStart(0)).toBe(0);
  });
});

describe("resolveTranscriptWindow", () => {
  it("keeps a short thread fully visible with nothing hidden", () => {
    const result = resolveTranscriptWindow(thread(10), tailWindowStart(10));
    expect(result.visible).toHaveLength(10);
    expect(result.hiddenCount).toBe(0);
    expect(result.startIndex).toBe(0);
    expect(result.laterCount).toBe(0);
  });

  it("windows a long thread to its tail", () => {
    const result = resolveTranscriptWindow(thread(300), tailWindowStart(300));
    expect(result.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
    expect(result.visible[0]).toBe(180);
    expect(result.visible.at(-1)).toBe(299);
    expect(result.hiddenCount).toBe(180);
  });

  it("grows the window when messages append past an anchored boundary", () => {
    const start = tailWindowStart(300);
    const result = resolveTranscriptWindow(thread(310), start);
    // the boundary must not slide forward: rows on screen stay on screen
    expect(result.startIndex).toBe(start);
    expect(result.visible).toHaveLength(130);
    expect(result.visible.at(-1)).toBe(309);
  });

  it("expands by one window per step until the start of the thread", () => {
    const messages = thread(300);
    const once = resolveTranscriptWindow(messages, expandWindowStart(180));
    expect(once.visible).toHaveLength(240);
    expect(once.hiddenCount).toBe(60);
    const twice = resolveTranscriptWindow(messages, expandWindowStart(once.startIndex));
    expect(twice.visible).toHaveLength(300);
    expect(twice.hiddenCount).toBe(0);
  });

  it("falls back to a tail window when the thread shrinks under the boundary", () => {
    // branch switch / edit rewound the thread below the stored boundary
    const result = resolveTranscriptWindow(thread(150), 180);
    expect(result.startIndex).toBe(30);
    expect(result.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
    expect(result.hiddenCount).toBe(30);
  });

  it("resets a boundary sitting exactly at the end of the thread", () => {
    const result = resolveTranscriptWindow(thread(100), 100);
    expect(result.startIndex).toBe(0);
    expect(result.visible).toHaveLength(100);
  });

  it("resolves an empty thread to an empty window", () => {
    const result = resolveTranscriptWindow([], 0);
    expect(result.visible).toHaveLength(0);
    expect(result.hiddenCount).toBe(0);
  });

  it("respects a custom window size", () => {
    const result = resolveTranscriptWindow(thread(10), tailWindowStart(10, 4), 4);
    expect(result.visible).toHaveLength(4);
    expect(result.hiddenCount).toBe(6);
  });

  it("keeps a finite search-focus window instead of mounting through the tail", () => {
    const result = resolveTranscriptWindow(thread(1_000), 440, TRANSCRIPT_WINDOW_SIZE, 560);
    expect(result.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE);
    expect(result.visible[0]).toBe(440);
    expect(result.visible.at(-1)).toBe(559);
    expect(result.hiddenCount).toBe(440);
    expect(result.laterCount).toBe(440);
    expect(result.endIndex).toBe(560);
  });

  it("falls back to the tail if a finite window becomes invalid after a rewind", () => {
    const result = resolveTranscriptWindow(thread(100), 440, TRANSCRIPT_WINDOW_SIZE, 560);
    expect(result.visible[0]).toBe(0);
    expect(result.visible.at(-1)).toBe(99);
    expect(result.laterCount).toBe(0);
  });
});

describe("focusWindowRange", () => {
  it.each([10, 500, 990])("contains target %i in a bounded window", (target) => {
    const range = focusWindowRange(1_000, target);
    expect(target).toBeGreaterThanOrEqual(range.start);
    expect(target).toBeLessThan(range.end);
    expect(range.end - range.start).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_SIZE);
  });

  it("uses the full short transcript", () => {
    expect(focusWindowRange(20, 10)).toEqual({ start: 0, end: 20 });
  });
});

describe("windowAfterPrepend", () => {
  it("moves a mounted window with its rows when older ones land in front", () => {
    expect(windowAfterPrepend({ start: 30, end: null }, 100)).toEqual({ start: 130, end: null });
    expect(windowAfterPrepend({ start: 30, end: 150 }, 100, true)).toEqual({ start: 130, end: 250 });
    // a jump walking back through pages mounts none of them
    expect(windowAfterPrepend({ start: 0, end: null }, 100)).toEqual({ start: 100, end: null });
  });

  it("keeps a window at the top there when the reader asked, so the page shows", () => {
    expect(windowAfterPrepend({ start: 0, end: null }, 100, true)).toEqual({ start: 0, end: null });
  });

  it("mounts a phone's topped-up page from the top: one booted row becomes 101", () => {
    // ChatView/GroupView capture for the store's top-up, so reveal is true
    const window = windowAfterPrepend({ start: tailWindowStart(1), end: null }, 100, true);
    expect(window).toEqual({ start: 0, end: null });
    expect(resolveTranscriptWindow(thread(101), window.start, TRANSCRIPT_WINDOW_SIZE, window.end).visible).toHaveLength(101);
  });

  it("leaves the window alone when the first row did not move back", () => {
    const window = { start: 5, end: null };
    expect(windowAfterPrepend(window, -1)).toBe(window);
    expect(windowAfterPrepend(window, 0)).toBe(window);
  });
});

describe("a capped window (spec §6)", () => {
  it("caps at three windows", () => {
    expect(MAX_MOUNTED_ROWS).toBe(TRANSCRIPT_WINDOW_SIZE * 3);
  });

  it("reads back without a cap until three windows are mounted", () => {
    // tail of 1000: 880..end; two clicks back mounts 360 rows, all of them
    expect(expandEarlier({ start: 880, end: null }, 1000)).toEqual({ start: 760, end: null });
    expect(expandEarlier({ start: 760, end: null }, 1000)).toEqual({ start: 640, end: null });
  });

  it("unmounts the newest rows once reading back passes the cap", () => {
    // 640..1000 is 360 mounted; one more step back drops the newest 120
    expect(expandEarlier({ start: 640, end: null }, 1000)).toEqual({ start: 520, end: 880 });
    expect(expandEarlier({ start: 520, end: 880 }, 1000)).toEqual({ start: 400, end: 760 });
  });

  it("clamps at the top of the thread and still honours the cap", () => {
    expect(expandEarlier({ start: 50, end: 400 }, 1000)).toEqual({ start: 0, end: 360 });
  });

  it("reads forward again, unmounting the oldest rows past the cap", () => {
    expect(expandLater({ start: 400, end: 760 }, 1000)).toEqual({ start: 520, end: 880 });
  });

  it("becomes a live tail again when reading forward reaches the end", () => {
    expect(expandLater({ start: 520, end: 880 }, 1000)).toEqual({ start: 640, end: null });
  });

  it("reads forward inside the cap without moving the start", () => {
    expect(expandLater({ start: 100, end: 220 }, 1000)).toEqual({ start: 100, end: 340 });
  });

  it("cuts a followed live tail back to one window once it passes the cap", () => {
    // a long live session appended 361 rows since the window was opened
    expect(trimFollowedTail({ start: 0, end: null }, 361, true)).toEqual({ start: 241, end: null });
  });

  it("leaves a tail the reader is not following exactly where it is", () => {
    const bounds = { start: 0, end: null };
    expect(trimFollowedTail(bounds, 5000, false)).toBe(bounds);
  });

  it("leaves a finite window, and a tail inside the cap, alone", () => {
    const finite = { start: 0, end: 400 };
    expect(trimFollowedTail(finite, 5000, true)).toBe(finite);
    const small = { start: 0, end: null };
    expect(trimFollowedTail(small, MAX_MOUNTED_ROWS, true)).toBe(small);
  });

  it("does not grow past the cap on an empty or short thread", () => {
    expect(expandEarlier({ start: 0, end: null }, 0)).toEqual({ start: 0, end: null });
    expect(expandLater({ start: 0, end: 10 }, 10)).toEqual({ start: 0, end: null });
  });
});
