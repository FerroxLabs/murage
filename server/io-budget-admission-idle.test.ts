// SPDX-License-Identifier: AGPL-3.0-or-later
// Idle verdict owner: warm-capture-c (capture drain). Ledger lock owner: walseam (admission-shared.ts).
// The capture drain asks the ledger whether the minute is idle. It must never throw, and a missed lock or a poisoned
// ledger reads as idle (the strict rule), so nothing but the capture already owed can run on that answer.
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { checkpointLedger } from "./admission-shared.ts";
import { IoBudget } from "./io-budget.ts";

const reading = { cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 };
const fresh = (lines: string[] = []) => {
  const budget = new IoBudget({ read: () => ({ ...reading, at: Date.now() }) as never, log: line => lines.push(line) });
  budget.setIsIdle(() => false);
  return budget;
};

it("the idle verdict follows the owner's idle state while the ledger lock is free", () => {
  const budget = fresh();
  expect(budget.admissionIdle()).toBe(false);
  budget.setIsIdle(() => true);
  expect(budget.admissionIdle()).toBe(true);
  budget.setIsIdle(() => false);
  expect(budget.admissionIdle()).toBe(false);
});

it("a held ledger lock reads as idle without throwing, and the miss is counted", { timeout: 30_000 }, async () => {
  const budget = fresh();
  const buf = budget.checkpointAdmissionBuffer();
  const holder = new Worker(`const { parentPort, workerData, threadId } = require("node:worker_threads");
    const ledger = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId);
    ledger.lock(); parentPort.postMessage("held"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); ledger.unlock();`,
  { eval: true, workerData: { buf, src: checkpointLedger.toString() } });
  try {
    await new Promise<void>((resolve, reject) => { holder.once("message", () => resolve()); holder.once("error", reject); });
    const before = budget.admissionHealth().lockTimeouts;
    expect(budget.admissionIdle(), "an owner who is active still reads idle when the lock is missed").toBe(true);
    expect(budget.admissionHealth().lockTimeouts).toBe(before + 1);
    expect(budget.admissionHealth().lastTimeoutSite).toBe("admissionIdle");
  } finally { await holder.terminate(); }
});

it("a poisoned ledger reads as idle even while the owner is active", () => {
  const budget = fresh();
  expect(budget.admissionIdle()).toBe(false);
  checkpointLedger(budget.checkpointAdmissionBuffer()).poison();
  expect(budget.admissionIdle()).toBe(true);
});

it("on an idle minute only the owed capture is admitted, and not even that while the ledger is poisoned", () => {
  // A fixed clock early in a minute keeps the closing guard out of this row.
  const at = 600 * 60_000 + 1000;
  const budget = new IoBudget({ read: () => ({ ...reading, at }) as never, log: () => {} });
  budget.setIsIdle(() => true);
  const capture = () => budget.withSource("memory-capture", () => budget.admit("BG", 8192, 4096));
  expect(budget.withSource("memory-worker", () => budget.admit("BG", 8192, 4096)), "unrelated background work stays refused").toBeNull();
  const ticket = capture();
  expect(ticket, "the owed capture drains while idle").not.toBeNull();
  budget.settle(ticket!, 0);
  checkpointLedger(budget.checkpointAdmissionBuffer()).poison();
  expect(capture(), "a poisoned ledger applies the strict idle rule to the capture too").toBeNull();
});
