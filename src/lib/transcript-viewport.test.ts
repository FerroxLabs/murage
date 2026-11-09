import { describe, expect, it } from "vitest";
import { canScroll, jumpToLatestVisible, keyBreaksFollow, shortTranscriptReveal } from "./transcript-viewport";

describe("an upward gesture over a transcript too short to scroll", () => {
  const short = { scrollHeight: 400, clientHeight: 400 };
  it("shows the held rows first, then asks the server for an older page", () => {
    expect(shortTranscriptReveal(short, 180, true)).toBe("showEarlier");
    expect(shortTranscriptReveal(short, 0, true)).toBe("loadOlder");
  });
  it("does nothing when the pane scrolls or there is nothing earlier", () => {
    expect(shortTranscriptReveal({ scrollHeight: 900, clientHeight: 400 }, 180, true)).toBeNull();
    expect(shortTranscriptReveal(short, 0, false)).toBeNull();
    expect(shortTranscriptReveal(null, 5, true)).toBeNull();
  });
});

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
