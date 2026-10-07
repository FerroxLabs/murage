// trackVisualViewport with a fake visualViewport. No DOM library is set up in
// this repo, so window and document are small stand-ins.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isKeyboardOpen, trackVisualViewport } from "./visual-viewport";

type Listener = () => void;

function setup(vv: { height: number; offsetTop: number } | undefined, innerHeight = 800) {
  const style = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const vvListeners = new Map<string, Listener>();
  const winListeners = new Map<string, Listener>();
  const visualViewport = vv && {
    ...vv,
    addEventListener: (type: string, fn: Listener) => vvListeners.set(type, fn),
    removeEventListener: (type: string) => vvListeners.delete(type),
  };
  vi.stubGlobal("window", {
    innerHeight,
    visualViewport,
    addEventListener: (type: string, fn: Listener) => winListeners.set(type, fn),
    removeEventListener: (type: string) => winListeners.delete(type),
  });
  vi.stubGlobal("document", {
    documentElement: { style: { setProperty: (k: string, v: string) => style.set(k, v) }, dataset },
    addEventListener: (type: string, fn: Listener) => winListeners.set(type, fn),
    removeEventListener: (type: string) => winListeners.delete(type),
  });
  const frames: Listener[] = [];
  const flush = () => frames.splice(0).forEach((fn) => fn());
  vi.stubGlobal("requestAnimationFrame", (fn: Listener) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return { style, dataset, visualViewport, vvListeners, winListeners, flush };
}

afterEach(() => vi.unstubAllGlobals());

describe("trackVisualViewport", () => {
  it("keyboard closed: --kb 0, --vvt 0, data-keyboard closed", () => {
    const { style, dataset } = setup({ height: 800, offsetTop: 0 });
    trackVisualViewport();
    expect(style.get("--vvh")).toBe("800px");
    expect(style.get("--kb")).toBe("0px");
    expect(style.get("--vvt")).toBe("0px");
    expect(dataset.keyboard).toBe("closed");
  });

  it("keyboard open, no pan: --kb is the keyboard, --vvt 0, data-keyboard open", () => {
    const { style, dataset } = setup({ height: 450, offsetTop: 0 });
    trackVisualViewport();
    expect(style.get("--kb")).toBe("350px");
    expect(style.get("--vvt")).toBe("0px");
    expect(dataset.keyboard).toBe("open");
  });

  it("keyboard open with a pan as large as the keyboard: still open, --vvt follows the pan", () => {
    // iOS: height = innerHeight - keyboard whatever the pan, so the pan is not subtracted from "open"
    const { style, dataset } = setup({ height: 450, offsetTop: 340 });
    trackVisualViewport();
    expect(dataset.keyboard).toBe("open");
    expect(style.get("--vvt")).toBe("340px");
    expect(style.get("--kb")).toBe("10px"); // --kb still honours offsetTop
  });

  it("follows a pan that arrives later, and closes cleanly", () => {
    const { style, dataset, visualViewport, vvListeners, flush } = setup({ height: 450, offsetTop: 0 });
    trackVisualViewport();
    visualViewport!.offsetTop = 300;
    vvListeners.get("scroll")!();
    flush();
    expect(style.get("--vvt")).toBe("300px");
    visualViewport!.height = 800;
    visualViewport!.offsetTop = 0;
    vvListeners.get("resize")!();
    flush();
    expect(dataset.keyboard).toBe("closed");
    expect(style.get("--vvt")).toBe("0px");
  });

  it("visualViewport absent: does nothing and returns a teardown that is safe to call", () => {
    const { style, dataset } = setup(undefined);
    const teardown = trackVisualViewport();
    expect(style.size).toBe(0);
    expect(dataset.keyboard).toBeUndefined();
    expect(() => teardown()).not.toThrow();
  });

  it("teardown removes its listeners", () => {
    const { vvListeners, winListeners } = setup({ height: 800, offsetTop: 0 });
    trackVisualViewport()();
    expect(vvListeners.size).toBe(0);
    expect(winListeners.size).toBe(0);
  });
});

describe("isKeyboardOpen", () => {
  it("ignores the pan and uses only how much shorter the visual viewport is", () => {
    expect(isKeyboardOpen({ innerHeight: 800, height: 800 })).toBe(false);
    expect(isKeyboardOpen({ innerHeight: 800, height: 730 })).toBe(false); // URL bar collapse
    expect(isKeyboardOpen({ innerHeight: 800, height: 450 })).toBe(true);
  });
});
