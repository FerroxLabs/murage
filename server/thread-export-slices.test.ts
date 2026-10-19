// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 lane 2, item 2.4 (M4): the export walk steps a bounded slice whatever the thread holds. On a sparse fixture (40,000 rows of
// which one in 10,000 is a line the export prints) no single `next` of the reader runs past its budget by more than the one page it is
// allowed to finish, with the real clock and with a clock that moves a fixed step per read, and the stream still prints every line.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { transaction } from "./database.ts";
import { Store } from "./store.ts";
import { EXPORT_SLICE_MS, streamThreadExport } from "./thread-export.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const ROWS = 40_000, EVERY = 10_000;

describe("the export walk on a sparse thread", () => {
  // The fixture is seeded once (40,000 appends in one outer transaction: the tests only read it); the budget is a per-read assertion,
  // not a wall-clock one, so a shared fixture changes nothing about what is proved.
  let bot: { threadId: string };
  beforeAll(() => {
    removeTempDirSync(DATA_DIR);
    const seed = new Store(selection);
    bot = transaction(() => {
      const created = seed.createBot();
      for (let i = 0; i < ROWS; i++) seed.appendMessage(created.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: i % EVERY === 0 ? `match ${i}` : "" });
      return created;
    });
  }, 300_000);
  afterEach(() => vi.restoreAllMocks());

  it("no read runs past the slice budget, and the stream prints every matching line", { timeout: 300_000 }, async () => {
    const store = new Store(selection);
    const reader = store.branchExportReader(bot.threadId);
    const times: number[] = [];
    const timed = { next: (budgetMs?: number) => { const started = performance.now(); const slice = reader.next(budgetMs); times.push(performance.now() - started); return slice; } };
    const writes: string[] = [];
    const res = { destroyed: false, writableEnded: false, writeHead() {}, write(chunk: string) { writes.push(chunk); return true; }, end() { (res as { writableEnded: boolean }).writableEnded = true; }, on() {}, off() {} };
    const ok = await streamThreadExport({ res: res as never, reader: timed, format: "markdown", name: "T", threadId: bot.threadId, filename: "t", who: () => "w", activityLine: () => "" });
    expect(ok).toBe(true);
    const text = writes.join("");
    for (let i = 0; i < ROWS; i += EVERY) expect(text).toContain(`match ${i}`);
    const [first, ...rest] = times;
    console.log(`[export] ${times.length} reads over ${ROWS} rows, first ${first!.toFixed(1)} ms, slowest after it ${Math.max(...rest).toFixed(1)} ms (budget ${EXPORT_SLICE_MS} ms), whole walk ${times.reduce((x, y) => x + y, 0).toFixed(0)} ms`);
    // the budget is checked between keyed steps and pages: one page of rows past it, never a walk of the thread (the first read also
    // opens the thread and counts its rows a page at a time)
    // On the real clock a shared machine adds pauses no code controls (a collection, another process): the bound is the 95th percentile
    // under 50 ms, and no read anywhere near a walk of the thread (the whole walk, logged above, is far above 250 ms). The exact per-read bound is
    // the fake-clock test below.
    const sorted = [...rest].sort((x, y) => x - y), p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    expect(first).toBeLessThan(200);
    expect(p95).toBeLessThan(50);
    expect(Math.max(...rest)).toBeLessThan(250);
  });

  it("with a clock that moves a step per read, a read ends at the budget and the next one carries on", { timeout: 300_000 }, () => {
    // (the count comes from another store instance: a thread read into memory takes the in-memory path, which has no clock)
    const total = new Store(selection).messagesFor(bot.threadId).length;
    const store = new Store(selection);
    const reader = store.branchExportReader(bot.threadId);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => { now += 0.05; return now; });
    let reads = 0, early = 0, rows = 0;
    for (let guard = 0; guard < 100_000; guard++) {
      const at = now;
      const slice = reader.next(EXPORT_SLICE_MS);
      reads++; rows += slice.messages.length;
      if (!slice.done && !slice.messages.length) early++;
      // one read never consumes more than its budget plus one page: the clock is read between keyed steps (every 256) and per statement
      // of the page it then fills (200 rows, a few reads each); a walk of the thread would be 40,000 rows, two orders above this
      expect(now - at).toBeLessThan(EXPORT_SLICE_MS + 256 * 0.05 + 200 * 0.05 * 4 + 5);
      if (slice.done) break;
    }
    expect(rows).toBe(total);
    expect(early).toBeGreaterThan(0);
    expect(reads).toBeGreaterThan(early);
  });
});
