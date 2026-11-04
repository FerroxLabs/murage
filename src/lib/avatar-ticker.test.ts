import { afterEach, describe, expect, it, vi } from "vitest";

import { avatarHost, prefersReducedMotion, runAvatar } from "./avatar-ticker";

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
  it("is hidden only when the document is hidden, never for lack of focus", () => {
    const state = { hidden: false, focused: false };
    stubBrowser(state);
    const host = avatarHost();
    expect(host.hidden()).toBe(false);
    state.hidden = true;
    expect(host.hidden()).toBe(true);
  });

  it("wakes the ticker on visibility changes, and stops after unsubscribe", () => {
    const { doc } = stubBrowser({ hidden: false, focused: true });
    const fn = vi.fn();
    const off = avatarHost().onVisibility(fn);
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reads prefers-reduced-motion", () => {
    stubBrowser({ hidden: false, focused: true, reduce: true });
    expect(prefersReducedMotion()).toBe(true);
    stubBrowser({ hidden: false, focused: true, reduce: false });
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("avatar in a browser tab without focus", () => {
  it("runs frames while the page lacks focus (web build, embedded frame)", () => {
    const frames: Array<(n: number) => void> = [];
    const { win } = stubBrowser({ hidden: false, focused: false });
    win.requestAnimationFrame = ((fn: (n: number) => void) => frames.push(fn)) as never;
    const settle = vi.fn();
    const step = vi.fn();
    const off = runAvatar(settle, step);
    expect(settle).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames[0](100);
    expect(step).toHaveBeenCalledTimes(1);
    off();
  });

  it("draws the settled face once when the tab is hidden, and runs when it shows", () => {
    const frames: Array<(n: number) => void> = [];
    const state = { hidden: true, focused: false };
    const { doc, win } = stubBrowser(state);
    win.requestAnimationFrame = ((fn: (n: number) => void) => frames.push(fn)) as never;
    const settle = vi.fn();
    const off = runAvatar(settle, vi.fn());
    expect(settle).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
    state.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(frames).toHaveLength(1);
    off();
  });
});
