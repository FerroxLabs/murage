// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { expect, it } from "vitest";
import { dragReady, dropAt, edgeScroll } from "./project-board-pointer";
it("requires 4px for a mouse or a still 300ms touch hold", () => {
  expect(dragReady("mouse", 3, 0, 500)).toBe(false);
  expect(dragReady("mouse", 4, 0, 1)).toBe(true);
  expect(dragReady("touch", 0, 0, 299)).toBe(false);
  expect(dragReady("touch", 0, 0, 300)).toBe(true);
  expect(dragReady("touch", 9, 0, 300)).toBe(false);
});
it("hits cached cells and card midpoints, allowing for board scroll", () => {
  const cells = [{ columnId: "todo", lane: "a", left: 10, right: 110, top: 0, bottom: 200, cards: [{ id: "x", midpoint: 50 }, { id: "y", midpoint: 100 }] }];
  expect(dropAt(cells, 40, 75, 0, 0)).toEqual({ columnId: "todo", lane: "a", index: 1, beforeId: "y" });
  expect(dropAt(cells, 0, 75, 20, 0)?.index).toBe(1);
  expect(dropAt(cells, 500, 0, 0, 0)).toBeNull();
  expect(edgeScroll(5, 0, 200)).toBeLessThan(0);
  expect(edgeScroll(195, 0, 200)).toBeGreaterThan(0);
  expect(edgeScroll(100, 0, 200)).toBe(0);
});
