// E10: landing on a message marks its `.transcript-row` with data-flash, so a
// seen row's paint containment (styles.css) does not clip the ring, and takes
// the mark off again when the flash ends or the view moves on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: vi.fn() }));

import { FLASH_MS, FLASH_TARGET, flashMessage } from "./focus-message";

class FakeElement {
  attributes = new Map<string, string>();
  classes = new Set<string>();
  classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
  };
  scrollIntoView = vi.fn();
  lastElementChild: FakeElement | null = null;
  row: FakeElement | null = null;
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  closest(selector: string) { return selector === ".transcript-row" ? this.row : null; }
}

function transcript() {
  const row = new FakeElement();
  const wrapper = new FakeElement();
  const bubble = new FakeElement();
  wrapper.lastElementChild = bubble;
  wrapper.row = row;
  let mounted = true;
  const root = { querySelector: vi.fn((selector: string) => (mounted && selector === '[data-mid="m1"]' ? wrapper : null)) };
  // React remounting the row: a new bubble element under the same wrapper
  const remount = () => { const next = new FakeElement(); wrapper.lastElementChild = next; return next; };
  return { row, bubble, root, remount, unmount: () => { mounted = false; }, mount: () => { mounted = true; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("CSS", { escape: (value: string) => value });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the flash on a landed message", () => {
  it("marks the row data-flash while the ring shows, and removes it when the flash ends", () => {
    const t = transcript();
    const landed = vi.fn();
    flashMessage(t.root as never, "m1", landed, () => false);
    expect(t.row.attributes.has("data-flash")).toBe(true);
    expect(t.bubble.attributes.has(FLASH_TARGET)).toBe(true);
    // never a className React owns
    expect(t.bubble.classes.size).toBe(0);
    expect(t.bubble.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(landed).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(t.row.attributes.has("data-flash")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(t.row.attributes.has("data-flash")).toBe(false);
    expect(t.bubble.attributes.has(FLASH_TARGET)).toBe(false);
  });

  // 0.1.60 Linux D10: opening the transcript window around the hit re-rendered
  // the bubble within a frame; the ring (then Tailwind classes) was wiped.
  it("keeps the ring through a re-render that clears it and a remount that replaces the bubble", () => {
    const t = transcript();
    flashMessage(t.root as never, "m1", vi.fn(), () => false);
    t.bubble.attributes.clear();
    vi.advanceTimersByTime(100);
    expect(t.bubble.attributes.has(FLASH_TARGET)).toBe(true);
    const fresh = t.remount();
    vi.advanceTimersByTime(100);
    expect(fresh.attributes.has(FLASH_TARGET)).toBe(true);
    expect(t.bubble.attributes.has(FLASH_TARGET)).toBe(false);
    vi.advanceTimersByTime(FLASH_MS);
    expect(fresh.attributes.has(FLASH_TARGET)).toBe(false);
    expect(t.row.attributes.has("data-flash")).toBe(false);
  });

  it("removes data-flash at once when the view moves on mid-flash", () => {
    const t = transcript();
    const stop = flashMessage(t.root as never, "m1", vi.fn(), () => true);
    expect(t.bubble.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
    stop();
    expect(t.row.attributes.has("data-flash")).toBe(false);
    expect(t.bubble.attributes.has(FLASH_TARGET)).toBe(false);
  });

  it("waits briefly for a row that lands a tick later, and marks nothing if it never does", () => {
    const t = transcript();
    t.unmount();
    const landed = vi.fn();
    flashMessage(t.root as never, "m1", landed, () => false);
    vi.advanceTimersByTime(300);
    expect(landed).not.toHaveBeenCalled();
    t.mount();
    vi.advanceTimersByTime(100);
    expect(landed).toHaveBeenCalledOnce();
    expect(t.row.attributes.has("data-flash")).toBe(true);

    const gone = transcript();
    gone.unmount();
    const never = vi.fn();
    flashMessage(gone.root as never, "m1", never, () => false);
    vi.advanceTimersByTime(5_000);
    expect(never).not.toHaveBeenCalled();
    expect(gone.root.querySelector).toHaveBeenCalledTimes(21);
    expect(gone.row.attributes.has("data-flash")).toBe(false);
  });
});
