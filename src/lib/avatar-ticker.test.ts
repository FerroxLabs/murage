import { afterEach, describe, expect, it, vi } from "vitest";

import { avatarHost, prefersReducedMotion } from "./avatar-ticker";

// No jsdom in this repo: a document and a window are stubbed as event targets.
function stubBrowser(state: { hidden: boolean; focused: boolean; reduce?: boolean }) {
  const doc = Object.assign(new EventTarget(), { hasFocus: () => state.focused });
  Object.defineProperty(doc, "hidden", { get: () => state.hidden });
  const win = Object.assign(new EventTarget(), {
    matchMedia: (q: string) => ({ matches: Boolean(state.reduce) && q.includes("reduce") }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  return { doc, win };
}

afterEach(() => vi.unstubAllGlobals());

describe("avatar ticker host", () => {
  it("is hidden when the document is hidden or the window is blurred", () => {
    const state = { hidden: false, focused: true };
    stubBrowser(state);
    const host = avatarHost();
    expect(host.hidden()).toBe(false);
    state.focused = false;
    expect(host.hidden()).toBe(true);
    state.focused = true;
    state.hidden = true;
    expect(host.hidden()).toBe(true);
  });

  it("wakes the ticker on visibility, focus and blur, and stops after unsubscribe", () => {
    const { doc, win } = stubBrowser({ hidden: false, focused: true });
    const fn = vi.fn();
    const off = avatarHost().onVisibility(fn);
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("blur"));
    win.dispatchEvent(new Event("focus"));
    expect(fn).toHaveBeenCalledTimes(3);
    off();
    win.dispatchEvent(new Event("blur"));
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("reads prefers-reduced-motion", () => {
    stubBrowser({ hidden: false, focused: true, reduce: true });
    expect(prefersReducedMotion()).toBe(true);
    stubBrowser({ hidden: false, focused: true, reduce: false });
    expect(prefersReducedMotion()).toBe(false);
  });
});
