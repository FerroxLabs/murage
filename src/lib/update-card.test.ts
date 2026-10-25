// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { indicatorLabelKey, indicatorShows } from "./update-card";

describe("update indicator state table", () => {
  it("shows for every actionable or in-flight state and hides for idle, checking and no bridge", () => {
    for (const status of ["available", "downloading", "downloaded", "installing", "deferred", "handed-off", "error"] as const) expect(indicatorShows(status)).toBe(true);
    for (const status of ["idle", "checking", undefined] as const) expect(indicatorShows(status)).toBe(false);
  });
  it("names the button by state", () => {
    expect(indicatorLabelKey("available")).toBe("updates.indicatorAvailable");
    expect(indicatorLabelKey("downloaded")).toBe("updates.indicatorReady");
    expect(indicatorLabelKey("error")).toBe("updates.indicatorProblem");
    expect(indicatorLabelKey("downloading")).toBe("updates.indicatorBusy");
  });
});
