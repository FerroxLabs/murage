import { describe, expect, it } from "vitest";

import { showKeyboardHints } from "./use-keyboard-hints";

describe("showKeyboardHints", () => {
  it("shows the hints on a desktop with a fine pointer", () => {
    expect(showKeyboardHints({ coarsePointer: false, nativeShell: false })).toBe(true);
  });

  it("keeps them on an Electron Mac without a touchscreen (fine pointer, not the phone shell)", () => {
    expect(showKeyboardHints({ coarsePointer: false, nativeShell: false })).toBe(true);
  });

  it("hides them where the primary pointer is a finger, and inside the phone app whatever the pointer", () => {
    expect(showKeyboardHints({ coarsePointer: true, nativeShell: false })).toBe(false);
    expect(showKeyboardHints({ coarsePointer: false, nativeShell: true })).toBe(false);
    expect(showKeyboardHints({ coarsePointer: true, nativeShell: true })).toBe(false);
  });
});
