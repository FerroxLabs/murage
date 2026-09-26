// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { placeAnchoredMenu } from "./menu-placement";

const window1440 = { width: 1440, height: 851 };
const menu = { width: 228, height: 485 };

function fits(top: number, height: number, viewport: { height: number }) {
  return top >= 8 && top + height <= viewport.height - 8;
}

describe("placeAnchoredMenu", () => {
  it("opens below the anchor when there is room", () => {
    expect(placeAnchoredMenu({ x: 200, y: 120, anchorTop: 80 }, menu, window1440)).toEqual({ top: 120, left: 200 });
  });

  it("flips above the control for the Linux re-test bot row (menu 471 to 956 in an 851 window)", () => {
    const placed = placeAnchoredMenu({ x: 200, y: 551, anchorTop: 511 }, menu, window1440);
    expect(placed).toEqual({ top: 511 - 485, left: 200 });
    expect(fits(placed.top, menu.height, window1440)).toBe(true);
  });

  it("flips above a pointer when the anchor has no top edge", () => {
    expect(placeAnchoredMenu({ x: 200, y: 700 }, menu, window1440).top).toBe(700 - 485);
  });

  it("clamps inside the window when it fits neither below nor above", () => {
    const placed = placeAnchoredMenu({ x: 200, y: 400, anchorTop: 380 }, menu, { width: 1440, height: 600 });
    expect(placed).toEqual({ top: 600 - 8 - 485, left: 200 });
    expect(fits(placed.top, menu.height, { height: 600 })).toBe(true);
  });

  it("scrolls inside when the menu is taller than the window", () => {
    const placed = placeAnchoredMenu({ x: 200, y: 300, anchorTop: 280 }, menu, { width: 1440, height: 400 });
    expect(placed).toEqual({ top: 8, left: 200, maxHeight: 384 });
  });

  it("keeps the menu inside the right and left edges", () => {
    expect(placeAnchoredMenu({ x: 1400, y: 100 }, menu, window1440).left).toBe(1440 - 8 - 228);
    expect(placeAnchoredMenu({ x: -20, y: 100 }, menu, window1440).left).toBe(8);
  });

  it("never lets the top edge go above the margin", () => {
    expect(placeAnchoredMenu({ x: 0, y: 2 }, { width: 100, height: 100 }, window1440).top).toBe(8);
  });
});
