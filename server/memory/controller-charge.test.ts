// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW charge debits (r3.2.4 A2, r3.2.6 A2', owner G1/G2): the controller answers a charge in its handler turn, keyed
// (helperRunId, fileId, attempt). A granted charge is debited its bytes at grant; growth the helper later reports for it debits only the
// excess (a credit, spent oldest first, that expires after CHARGE_CREDIT_MS); a refused charge debits nothing; the conservative start is
// one synthetic window entry stamped at controller start that no refusal re-stamps; a charge from a run id that is not the current
// helper's first-seen one is refused.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { setMemoryMode } from "./repository.ts";
import { CHARGE_CREDIT_MS, CHARGE_START_HOLD_MS, MemoryWorkerController } from "./worker-controller.ts";

type Internals = { child: unknown; ready: boolean; onWorkerMessage(child: unknown, message: unknown): void; workerBytes: number };
let controller: MemoryWorkerController, internals: Internals, sent: Array<Record<string, unknown>>;
const fakeChild = () => ({ kill() {}, on() {}, send: (m: Record<string, unknown>) => { sent.push(m); return true; } });
const TICK_MS = 50;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  vi.useFakeTimers({ toFake: ["Date", "performance"] }); vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
  sent = [];
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = fakeChild(); internals.ready = true;
});
afterEach(async () => { await controller.stop().catch(() => {}); vi.useRealTimers(); closeDatabase(); });
const charge = (attempt: number, bytes: number, helperRunId = "r1", fileId = "f1", child = internals.child) => {
  internals.onWorkerMessage(child, { type: "charge", fileId, attempt, bytes, helperRunId });
  return sent.at(-1)!;
};
const io = (ioBytes: number, child = internals.child) => internals.onWorkerMessage(child, { type: "io", ioBytes, fileId: "f1" });
const pastStart = () => vi.advanceTimersByTime(CHARGE_START_HOLD_MS);

it("T14g: a granted attempt is debited exactly max(granted, actual); a refused one debits 0", () => {
  pastStart();
  // actual below the grant: the grant is the debit
  expect(charge(1, 8192)).toEqual({ type: "charge-ack", fileId: "f1", attempt: 1, granted: true, helperRunId: "r1" });
  expect(internals.workerBytes).toBe(8192);
  io(4096);
  expect(internals.workerBytes).toBe(8192);
  // (attempt 1's unused 4,096 B credit would pay for attempt 2's growth while it lasts: oldest first, owner G1; let it expire)
  vi.advanceTimersByTime(CHARGE_CREDIT_MS);
  // actual above the grant: only the excess is added
  expect(charge(2, 8192).granted).toBe(true);
  io(4096 + 20_000);
  expect(internals.workerBytes).toBe(8192 + 20_000);
  // a refused charge (no byte count) debits nothing, and its growth-free ack runs no attempt
  expect(charge(3, Number.NaN).granted).toBe(false);
  expect(internals.workerBytes).toBe(28_192);
  // the same charge again (one key) is answered the same and debited once
  expect(charge(2, 8192).granted).toBe(true);
  expect(internals.workerBytes).toBe(28_192);
});

it("T14g: a refusal in the start hold debits 0 and never re-stamps it; the first grant comes no later than 60 s + one tick (T14e (i))", () => {
  let attempt = 0;
  // refusals spread over the hold
  const start = performance.now();
  for (const step of [10_000, 20_000, 20_000, 9_000]) {
    vi.advanceTimersByTime(step);
    expect(charge(++attempt, 4096).granted).toBe(false);
  }
  expect(internals.workerBytes).toBe(0);
  vi.advanceTimersByTime(CHARGE_START_HOLD_MS - (performance.now() - start) + TICK_MS);
  expect(charge(++attempt, 4096).granted).toBe(true);
  expect(internals.workerBytes).toBe(4096);
});

it("T14h: a helper-only restart that reuses attempt numbers gets a fresh debit; a foreign run id is refused and its ack echoes it", () => {
  pastStart();
  expect(charge(1, 4096, "r1").granted).toBe(true);
  // the same helper, another run id: refused, debited nothing, the ack carries the charge's own ids
  expect(charge(2, 4096, "r9")).toEqual({ type: "charge-ack", fileId: "f1", attempt: 2, granted: false, helperRunId: "r9" });
  expect(internals.workerBytes).toBe(4096);
  // a new helper (new child, new run id) starts its attempts at 1 again on the same file: a fresh debit
  const next = fakeChild(); internals.child = next;
  expect(charge(1, 4096, "r2", "f1", next).granted).toBe(true);
  expect(internals.workerBytes).toBe(8192);
  // the old helper's run id is not the new helper's first-seen one
  expect(charge(2, 4096, "r1", "f1", next).granted).toBe(false);
  expect(internals.workerBytes).toBe(8192);
  // a charge with no run id is refused (fail closed)
  internals.onWorkerMessage(next, { type: "charge", fileId: "f1", attempt: 3, bytes: 4096 });
  expect(sent.at(-1)).toMatchObject({ attempt: 3, granted: false });
  expect(internals.workerBytes).toBe(8192);
});

it("G1: under interleaved attempts the debits are never below the bytes written, and a credit expires after CHARGE_CREDIT_MS", () => {
  pastStart();
  let written = 0, attempt = 0;
  // grants and growth interleaved: some attempts write less than granted, some more, some nothing
  const plan: Array<[number, number]> = [[8192, 4096], [4096, 12_288], [16_384, 0], [0, 9000], [4096, 4096], [2048, 30_000]];
  for (const [grant, actual] of plan) {
    if (grant) expect(charge(++attempt, grant).granted).toBe(true);
    written += actual; io(written);
    expect(internals.workerBytes).toBeGreaterThanOrEqual(written);
    vi.advanceTimersByTime(1000);
  }
  expect(internals.workerBytes).toBe(written); // every credit was spent by later growth
  // a credit left unspent past CHARGE_CREDIT_MS expires: growth after it is debited whole
  const before = internals.workerBytes;
  expect(charge(++attempt, 10_000).granted).toBe(true);
  vi.advanceTimersByTime(CHARGE_CREDIT_MS + TICK_MS);
  written += 10_000; io(written);
  expect(internals.workerBytes).toBe(before + 10_000 + 10_000);
  expect(internals.workerBytes).toBeGreaterThanOrEqual(written);
});
