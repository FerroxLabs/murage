// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { createCompletionRetry } from "./completion-retry.ts";

const harness = (run: (n: number) => void, settle: () => boolean = () => true) => {
  const timers: Array<() => void> = []; let calls = 0, settled = 0;
  const retry = createCompletionRetry<string>({ run: () => run(++calls), settleFailed: () => { settled++; return settle(); }, schedule: fn => { timers.push(fn); } });
  return { retry, timers, calls: () => calls, settled: () => settled };
};
it("retries a non-BUSY I/O failure and completes when the write goes through", () => {
  const h = harness(n => { if (n < 3) throw new Error("disk I/O error"); });
  h.retry.start("done");
  expect(h.retry.pending()).toBe(true);
  h.timers.shift()!(); h.timers.shift()!();
  expect(h.calls()).toBe(3); expect(h.retry.pending()).toBe(false); expect(h.settled()).toBe(0);
});
it("settles durably as failed when the write keeps failing, and then stops", () => {
  const h = harness(() => { throw new Error("disk I/O error"); });
  h.retry.start("done");
  while (h.timers.length) h.timers.shift()!();
  expect(h.settled()).toBe(1); expect(h.retry.pending()).toBe(false);
});
it("keeps retrying (never relinquishing) while even the settlement cannot be written; a second completion is not started twice", () => {
  let settleOk = false;
  const h = harness(() => { throw new Error("disk I/O error"); }, () => settleOk);
  h.retry.start("a"); for (let i = 0; i < 12; i++) h.timers.shift()!();
  expect(h.retry.pending()).toBe(true); expect(h.settled()).toBeGreaterThan(1); expect(h.timers.length).toBe(1);
  const before = h.calls(); h.retry.start("again"); expect(h.calls()).toBe(before);
  settleOk = true; h.timers.shift()!();
  expect(h.retry.pending()).toBe(false);
  h.retry.start("later"); expect(h.calls()).toBeGreaterThan(before);
});
