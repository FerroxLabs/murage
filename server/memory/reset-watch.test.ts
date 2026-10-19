// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearResetWatch, noteContinuationReset, noteSealedTurn, RESET_LOOP_WINDOW_MS, sealedTurnCounts, sealedTurnSummary } from "./reset-watch.ts";

afterEach(() => { clearResetWatch(); vi.restoreAllMocks(); });

it("warns once per thread when resets pass 3 in 10 minutes, with the reasons", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) expect(noteContinuationReset("th-1", "claude", "lineage", t0 + i * 1_000)).toBeUndefined();
  const line = noteContinuationReset("th-1", "claude", "memory-changed (receipt-already-revoked)", t0 + 4_000);
  expect(line).toBe("memory continuation reset loop thread=th-1 engine=claude resets=4 window=10m reasons=lineage x3; memory-changed (receipt-already-revoked) x1");
  expect(warn).toHaveBeenCalledTimes(1);
  // once per thread
  for (let i = 0; i < 5; i++) expect(noteContinuationReset("th-1", "claude", "lineage", t0 + 5_000 + i)).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  // another thread counts on its own
  expect(noteContinuationReset("th-2", "claude", "lineage", t0)).toBeUndefined();
});

it("resets spread wider than the window never warn", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  for (let i = 0; i < 10; i++) noteContinuationReset("th-3", "claude", "memory-changed", i * (RESET_LOOP_WINDOW_MS / 3 + 1));
  expect(warn).not.toHaveBeenCalled();
});

describe("thread recall sealed turns (design S2)", () => {
  it("ten sealed turns in ten minutes raise no warning and count ten", () => {
    clearResetWatch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t0 = 1_000_000;
      for (let i = 0; i < 10; i++) expect(noteSealedTurn("sealed-1", i % 2 ? "codex" : "claude", t0 + i * 60_000)).toBe(i + 1);
      expect(warn).not.toHaveBeenCalled();
      expect(sealedTurnCounts()).toEqual([{ threadId: "sealed-1", count: 10, instances: ["claude", "codex"], lastAt: t0 + 9 * 60_000 }]);
      // the sealed turns left the reset-loop count untouched: three ordinary resets still stay quiet
      for (let i = 0; i < 3; i++) expect(noteContinuationReset("sealed-1", "claude", "lineage", t0 + i)).toBeUndefined();
    } finally { warn.mockRestore(); }
  });
  it("four non-seal resets on an unsealed thread still warn", () => {
    clearResetWatch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) expect(noteContinuationReset("plain-1", "claude", "lineage", i)).toBeUndefined();
      expect(noteContinuationReset("plain-1", "claude", "lineage", 4)).toContain("reset loop");
    } finally { warn.mockRestore(); }
  });
  it("the summary is bounded to the most recent threads and totals every turn", () => {
    clearResetWatch();
    for (let i = 0; i < 25; i++) { noteSealedTurn(`th-${i}`, "claude", 1_000 + i); noteSealedTurn(`th-${i}`, "codex", 2_000 + i); }
    const summary = sealedTurnSummary();
    expect(summary).toMatchObject({ threads: 25, turns: 50 });
    expect(summary.recent).toHaveLength(20);
    expect(summary.recent[0]).toMatchObject({ threadId: "th-24", count: 2, instances: ["claude", "codex"] });
  });
});
