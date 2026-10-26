import { describe, expect, it } from "vitest";
import { canScroll, jumpToLatestVisible, keyBreaksFollow } from "./transcript-viewport";

describe("canScroll", () => {
  it("is false for a transcript that fits and true when there is more to see", () => {
    expect(canScroll({ scrollHeight: 400, clientHeight: 400 })).toBe(false);
    expect(canScroll({ scrollHeight: 400.5, clientHeight: 400 })).toBe(false);
    expect(canScroll({ scrollHeight: 900, clientHeight: 400 })).toBe(true);
    expect(canScroll(null)).toBe(false);
  });
});

describe("jump to latest button", () => {
  it("does not show over a short chat that follows", () => {
    expect(jumpToLatestVisible(true, false, true)).toBe(false);
    expect(jumpToLatestVisible(false, false, true)).toBe(false);
  });
  it("shows when the reader scrolled away, or the window stops short of the newest message", () => {
    expect(jumpToLatestVisible(false, true, true)).toBe(true);
    expect(jumpToLatestVisible(false, false, false)).toBe(true);
    expect(jumpToLatestVisible(true, true, false)).toBe(false);
  });
});

describe("keys that stop following", () => {
  const page = { typing: false, inOwnArrowWidget: false };
  it("PageUp, Home and ArrowUp on the page count as scrolling", () => {
    for (const key of ["PageUp", "Home", "ArrowUp"]) expect(keyBreaksFollow(key, page)).toBe(true);
    expect(keyBreaksFollow("ArrowDown", page)).toBe(false);
  });
  it("arrow keys inside a menu, list or select do not", () => {
    const menu = { typing: false, inOwnArrowWidget: true };
    for (const key of ["PageUp", "Home", "ArrowUp"]) expect(keyBreaksFollow(key, menu)).toBe(false);
  });
  it("ArrowUp and Home while typing edit the text; PageUp still scrolls", () => {
    const typing = { typing: true, inOwnArrowWidget: false };
    expect(keyBreaksFollow("ArrowUp", typing)).toBe(false);
    expect(keyBreaksFollow("Home", typing)).toBe(false);
    expect(keyBreaksFollow("PageUp", typing)).toBe(true);
  });
});
