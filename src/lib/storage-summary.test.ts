// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { readableBytes, storageSummary } from "./storage-summary";

const GIB = 1024 ** 3;
const report = (freeBytes: number | null) => ({ freeBytes, floorBytes: GIB, attachments: { bytes: 600 * 1024 ** 2, inProgressBytes: 0 }, files: { bytes: 3 * 1024 ** 2 } });

describe("Settings > Storage", () => {
  it("shows free space, what Murage keeps and a plain next step", () => {
    const summary = storageSummary(report(120 * GIB));
    expect(summary).toMatchObject({ free: "120 GB", attachments: "600 MB", files: "3 MB", low: false });
    expect(summary.next).toMatch(/There is room/);
  });
  it("names the next step when the disk is nearly full or unreadable, never deleting conversations", () => {
    const low = storageSummary(report(GIB / 2));
    expect(low.low).toBe(true);
    expect(low.next).toMatch(/almost out of space/);
    const unknown = storageSummary(report(null));
    expect(unknown).toMatchObject({ free: "Unknown", low: true });
    for (const text of [low.next, unknown.next]) expect(text).not.toMatch(/delete conversations|—|\bsafe/i);
  });
  it("says sizes in human units", () => {
    expect([readableBytes(243 * 1024), readableBytes(1.5 * GIB), readableBytes(12)]).toEqual(["243 KB", "1.5 GB", "12 bytes"]);
  });
});
