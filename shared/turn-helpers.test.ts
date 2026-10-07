// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { describe, expect, it } from "vitest";
import { settledTurnHelpers, turnHelpersForThread } from "./turn-helpers";

const rows = [{ id: "x", label: "One", status: "done", startedAt: 10, endedAt: 20, toolCount: 1, content: "secret tool output" }];

describe("turn helper summaries", () => {
  it("keeps only label, status, duration and tool count", () => {
    expect(settledTurnHelpers(rows)).toEqual([{ label: "One", status: "done", durationMs: 10, toolCount: 1 }]);
  });
  it("is stored for the owner's thread only", () => {
    expect(turnHelpersForThread(true, rows)).toHaveLength(1);
    expect(turnHelpersForThread(false, rows)).toEqual([]);
  });
  it("ignores junk and caps the list", () => {
    expect(settledTurnHelpers("nope")).toEqual([]);
    expect(settledTurnHelpers([null, 3, { label: "no time" }])).toEqual([]);
    expect(settledTurnHelpers(Array.from({ length: 100 }, () => rows[0]))).toHaveLength(64);
  });
});
