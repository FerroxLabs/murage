import { describe, expect, it } from "vitest";

import { AuraTicker, FRAME_MS, type TickerHost } from "./aura-ticker";

/** A host whose frames and visibility the test drives by hand. */
function fakeHost() {
  let hidden = false;
  let next: ((now: number) => void) | null = null;
  let handle = 0;
  const visibility = new Set<() => void>();
  const host: TickerHost = {
    request: (fn) => {
      next = fn;
      handle += 1;
      return handle;
    },
    cancel: () => {
      next = null;
    },
    hidden: () => hidden,
    onVisibility: (fn) => {
      visibility.add(fn);
      return () => visibility.delete(fn);
    },
    now: () => 0,
  };
  return {
    host,
    frame(now: number) {
      const fn = next;
      next = null;
      fn?.(now);
    },
    get scheduled() {
      return next !== null;
    },
    hide(value: boolean) {
      hidden = value;
      for (const fn of visibility) fn();
    },
    get watching() {
      return visibility.size;
    },
  };
}

describe("the shared frame loop", () => {
  it("runs one loop for every subscriber, capped at 30 frames a second", () => {
    const h = fakeHost();
    const ticker = new AuraTicker(h.host);
    const seen: number[] = [];
    const off = ticker.subscribe((_now, dt) => seen.push(dt));
    ticker.subscribe(() => undefined);
    expect(h.scheduled).toBe(true);
    h.frame(0);
    h.frame(8); // too soon for 30 a second: skipped
    h.frame(16); // still inside the cap from 0
    h.frame(34);
    h.frame(70);
    expect(seen).toEqual([0, 34, 36]);
    expect(FRAME_MS).toBeCloseTo(33.3, 1);
    off();
    expect(h.scheduled).toBe(true);
  });

  it("stops while the document is hidden and resumes when it shows", () => {
    const h = fakeHost();
    const ticker = new AuraTicker(h.host);
    let frames = 0;
    const off = ticker.subscribe(() => {
      frames += 1;
    });
    h.frame(0);
    expect(frames).toBe(1);
    h.hide(true);
    expect(h.scheduled).toBe(false);
    expect(ticker.running).toBe(false);
    h.frame(100);
    expect(frames).toBe(1);
    h.hide(false);
    expect(h.scheduled).toBe(true);
    h.frame(200);
    expect(frames).toBe(2);
    off();
  });

  it("cancels the frame and the visibility listener when the last subscriber leaves", () => {
    const h = fakeHost();
    const ticker = new AuraTicker(h.host);
    const a = ticker.subscribe(() => undefined);
    const b = ticker.subscribe(() => undefined);
    expect(h.watching).toBe(1);
    a();
    expect(h.scheduled).toBe(true);
    b();
    expect(h.scheduled).toBe(false);
    expect(ticker.running).toBe(false);
    expect(h.watching).toBe(0);
  });
});
