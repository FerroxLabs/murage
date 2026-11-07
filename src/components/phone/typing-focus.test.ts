// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone tabs step aside for the keyboard (Android shrinks the WebView, so
// a fixed bar would ride up over it), and the Door bundle keeps
// viewport-fit=cover so iOS gives real safe-area insets to the bar.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PRESS_HOLD_MAX_MS, isTypingTarget, watchTyping } from "./typing-focus";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("phone tabs and the keyboard", () => {
  it("counts text boxes as typing, and buttons, checkboxes and read-only boxes as not", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "text", readOnly: true })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("reports typing on focus in, and not typing once focus leaves the box", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const doc = Object.assign(target, { activeElement: null as unknown });
    const seen: boolean[] = [];
    const stop = watchTyping(doc as never, (typing) => seen.push(typing));
    doc.activeElement = { tagName: "TEXTAREA" };
    doc.dispatchEvent(new Event("focusin"));
    doc.activeElement = { tagName: "BODY" };
    doc.dispatchEvent(new Event("focusout"));
    vi.runAllTimers();
    expect(seen).toEqual([false, true, false]);
    stop();
    doc.dispatchEvent(new Event("focusin"));
    expect(seen).toHaveLength(3);
    vi.useRealTimers();
  });

  it("says nothing after it is stopped, even for a focus move already on its way", () => {
    vi.useFakeTimers();
    const doc = Object.assign(new EventTarget(), { activeElement: null as unknown });
    const seen: boolean[] = [];
    const stop = watchTyping(doc as never, (typing) => seen.push(typing));
    doc.dispatchEvent(new Event("focusout"));
    stop();
    vi.runAllTimers();
    expect(seen).toEqual([false]);
    vi.useRealTimers();
  });

  it("keeps the bar away while a tap that left the box is still down, so the page does not move under the finger", () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const doc = Object.assign(target, { activeElement: { tagName: "INPUT", type: "search" } as unknown });
    const seen: boolean[] = [];
    const stop = watchTyping(doc as never, (typing) => seen.push(typing));
    expect(seen).toEqual([true]);
    doc.dispatchEvent(new Event("pointerdown"));
    doc.activeElement = { tagName: "BUTTON" };
    doc.dispatchEvent(new Event("focusout"));
    doc.dispatchEvent(new Event("focusin"));
    vi.advanceTimersByTime(10);
    expect(seen).toEqual([true]);
    doc.dispatchEvent(new Event("pointerup"));
    vi.runAllTimers();
    expect(seen).toEqual([true, false]);
    stop();
    vi.useRealTimers();
  });

  // A press that leaves the box but never gets its pointerup (the window blurs,
  // the page hides, capture is lost) must not keep the tabs away for good.
  const pressedOutOfTheBox = () => {
    const target = new EventTarget();
    const doc = Object.assign(target, { activeElement: { tagName: "INPUT", type: "search" } as unknown, visibilityState: "visible" });
    const win = new EventTarget();
    const seen: boolean[] = [];
    const stop = watchTyping(doc as never, (typing) => seen.push(typing), win as never);
    doc.dispatchEvent(new Event("pointerdown"));
    doc.activeElement = { tagName: "BUTTON" };
    doc.dispatchEvent(new Event("focusout"));
    doc.dispatchEvent(new Event("focusin"));
    vi.advanceTimersByTime(10);
    expect(seen).toEqual([true]);
    return { doc, win, seen, stop };
  };

  for (const [name, end] of [
    ["the window blurs", (h: ReturnType<typeof pressedOutOfTheBox>) => h.win.dispatchEvent(new Event("blur"))],
    ["the page goes hidden", (h: ReturnType<typeof pressedOutOfTheBox>) => { h.doc.visibilityState = "hidden"; h.doc.dispatchEvent(new Event("visibilitychange")); }],
    ["pointer capture is lost", (h: ReturnType<typeof pressedOutOfTheBox>) => h.doc.dispatchEvent(new Event("lostpointercapture"))],
  ] as const) {
    it(`brings the tabs back when a press out of the box is cut off because ${name}`, () => {
      vi.useFakeTimers();
      const h = pressedOutOfTheBox();
      end(h);
      vi.advanceTimersByTime(10);
      expect(h.seen).toEqual([true, false]);
      h.stop();
      vi.useRealTimers();
    });
  }

  it("after a cut-off press, keyboard Tab out of the box brings the tabs back", () => {
    vi.useFakeTimers();
    const h = pressedOutOfTheBox();
    h.win.dispatchEvent(new Event("blur"));
    h.win.dispatchEvent(new Event("focus"));
    h.doc.activeElement = { tagName: "INPUT", type: "search" };
    h.doc.dispatchEvent(new Event("focusin"));
    h.doc.dispatchEvent(new Event("keydown"));
    h.doc.activeElement = { tagName: "BUTTON" };
    h.doc.dispatchEvent(new Event("focusout"));
    h.doc.dispatchEvent(new Event("focusin"));
    vi.advanceTimersByTime(10);
    expect(h.seen.at(-1)).toBe(false);
    h.stop();
    vi.useRealTimers();
  });

  it("a key press ends a press that never got its pointerup", () => {
    vi.useFakeTimers();
    const h = pressedOutOfTheBox();
    h.doc.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(10);
    expect(h.seen).toEqual([true, false]);
    h.stop();
    vi.useRealTimers();
  });

  it("fails open: a press that no event ends holds the tabs back no longer than PRESS_HOLD_MAX_MS", () => {
    vi.useFakeTimers();
    const h = pressedOutOfTheBox();
    vi.advanceTimersByTime(PRESS_HOLD_MAX_MS - 20);
    expect(h.seen).toEqual([true]);
    vi.advanceTimersByTime(40);
    expect(h.seen).toEqual([true, false]);
    h.stop();
    vi.useRealTimers();
  });

  it("listens to the window for blur and focus", () => {
    const source = read("./typing-focus.ts");
    expect(source).toContain("watchTyping(document, setTyping, window)");
  });

  it("hides the tab bar while typing", () => {
    const source = read("./PhoneTabs.tsx");
    expect(source).toContain('import { useTypingFocus } from "./typing-focus";');
    expect(source).toMatch(/const typing = useTypingFocus\(\);\s*if \(typing\) return null;/);
  });

  it("keeps viewport-fit=cover in the Door bundle's viewport meta", () => {
    const meta = read("../../../index.html").match(/<meta name="viewport" content="([^"]*)"/);
    expect(meta?.[1]).toContain("viewport-fit=cover");
  });
});
