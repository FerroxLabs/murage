// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rowAt, visibleRange } from "./VirtualRows";

const offsets = (heights: number[]) => heights.reduce<number[]>((acc, h) => [...acc, acc.at(-1)! + h], [0]);

describe("the All apps window", () => {
  it("finds the row under a point", () => {
    const at = offsets([88, 88, 176, 88]);
    expect(rowAt(at, 0)).toBe(0);
    expect(rowAt(at, 87)).toBe(0);
    expect(rowAt(at, 88)).toBe(1);
    expect(rowAt(at, 300)).toBe(2);
    expect(rowAt(at, 10_000)).toBe(3);
  });
  it("renders the rows in view plus the overscan, never past the ends", () => {
    const at = offsets(Array.from({ length: 800 }, () => 88));
    expect(visibleRange(at, 0, 880, 6)).toEqual([0, 17]);
    expect(visibleRange(at, 88 * 400, 880, 6)).toEqual([394, 417]);
    expect(visibleRange(at, 88 * 800, 880, 6)).toEqual([793, 800]);
    expect(visibleRange(offsets([]), 0, 880, 6)).toEqual([0, 0]);
  });
});

describe("the panel's paging and polling (Kimi round 1)", () => {
  const panel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "PluginsPanel.tsx"), "utf8");
  it("K1: keeps asking past the server's 45-second walk", async () => {
    const { CATALOG_POLL_MS, CATALOG_POLLS } = await import("./PluginsPanel");
    expect(CATALOG_POLL_MS * CATALOG_POLLS).toBeGreaterThan(45_000 + 8_000);
  });
  it("K10: a cursor that does not move ends the list", () => {
    expect(panel).toMatch(/r\.nextCursor !== cursor \? r\.nextCursor : null/);
  });
  it("hides All apps when the rollback switch is set", () => {
    expect(panel).toMatch(/catalog\?\.allApps === true/);
  });
});
