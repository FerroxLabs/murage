// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from "vitest";
import { clearResetWatch, noteContinuationReset, RESET_LOOP_WINDOW_MS } from "./reset-watch.ts";

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
