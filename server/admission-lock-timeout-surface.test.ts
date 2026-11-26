// SPDX-License-Identifier: AGPL-3.0-or-later
// WAL-ADMISSION-HANG r2 D2/D5: every caller of the ledger lock fails closed on AdmissionLockTimeout and the failure reaches a
// user-visible path: a loud log line and GET /api/health (admissionLock, io-budget.ts admissionHealth), not only a counter.
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { checkpointLedger } from "./admission-shared.ts";
import { IoBudget } from "./io-budget.ts";
import { walMaintenanceTestHooks } from "./wal-maintenance.ts";

const reading = { at: Date.now(), cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 } as never;

it("T6 a held ledger lock: every caller refuses or skips, and the timeout is counted, logged loudly and on the health path", { timeout: 30_000 }, async () => {
  const lines: string[] = [];
  const budget = new IoBudget({ read: () => ({ ...(reading as object), at: Date.now() }) as never, log: line => lines.push(line) });
  budget.setIsIdle(() => false);
  const buf = budget.checkpointAdmissionBuffer();
  const release = new Int32Array(new SharedArrayBuffer(4));
  const holder = new Worker(`const { parentPort, workerData, threadId } = require("node:worker_threads");
    const ledger = (0, eval)("(" + workerData.src + ")")(workerData.buf, threadId);
    ledger.lock(); parentPort.postMessage("held"); Atomics.wait(new Int32Array(workerData.release), 0, 0, 20000); ledger.unlock();`,
  { eval: true, workerData: { buf, src: checkpointLedger.toString(), release: release.buffer } });
  const exited = new Promise<number>(resolve => holder.once("exit", resolve));
  try {
    await once(holder, "message");
    expect(budget.checkpointAdmissionBuffer(), "the missed refresh still returns the shared ledger").toBe(buf);
    expect(budget.admissionHealth().lastTimeoutSite).toBe("checkpointAdmissionBuffer");
    expect.soft(lines.filter(line => line.includes("AdmissionLockTimeout"))).toEqual([
      "[io-budget] AdmissionLockTimeout at checkpointAdmissionBuffer: the admission ledger was busy (1 so far, 0 lines suppressed); retry on the next ledger refresh",
    ]);
    let worst = 0, last = performance.now();
    const gap = async () => { await new Promise<void>(resolve => setTimeout(resolve, 5)); const now = performance.now(); worst = Math.max(worst, now - last - 5); last = now; };
    expect(budget.admit("FGCOPY", 4096), "admit refuses: nothing is admitted without the lock").toBeNull();
    expect(budget.admit("BG", 4096), "admit refuses (BG)").toBeNull();
    expect(budget.copyRoom(), "copyRoom offers nothing").toBe(0);
    expect(budget.backgroundRoom(), "backgroundRoom offers nothing").toBe(0);
    expect(budget.admissionState().total, "admissionState reports a full total").toBeGreaterThanOrEqual(49 * 1024 * 1024);
    expect(() => budget.noteForegroundActivity(), "owner activity callers do not throw").not.toThrow();
    expect(() => budget.backfilled({ salt: "x", frame: 1, complete: true }), "backfilled does not throw").not.toThrow();
    expect(budget.nextAdmissionMs(), "nextAdmissionMs still answers").toBeGreaterThan(0);
    await gap(); await gap();
    expect(worst, "the main thread never waited for the lock: the event loop was not held up").toBeLessThan(50);
    const health = budget.admissionHealth();
    expect(health.lockTimeouts, "counted").toBeGreaterThanOrEqual(3);
    expect(health.lastTimeoutSite, "and says where").not.toBeNull();
    expect(lines.some(l => l.includes("AdmissionLockTimeout")), "a loud line").toBe(true);
  } finally {
    Atomics.store(release, 0, 1);
    Atomics.notify(release, 0);
    expect(await exited).toBe(0);
  }
  const ledger = checkpointLedger(buf);
  const beforeRetry = budget.admissionHealth().lockTimeouts;
  expect(ledger.slots[7], "the missed refresh stored the strict idle verdict").toBe(1n);
  expect(budget.checkpointAdmissionBuffer()).toBe(buf);
  expect(ledger.slots[7], "the next refresh republished the active verdict").toBe(0n);
  expect(budget.admissionHealth().lockTimeouts).toBe(beforeRetry);
  expect(ledger.recoveries()).toBe(0);
});

it("T6b the checkpointer's own timeout message reaches the same counter, and GET /api/health carries the field", () => {
  const before = walMaintenanceTestHooks.captureHandler();
  expect(typeof before).toBe("function");
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(index, "the health body reports the admission ledger").toContain("admissionLock: ioBudget.admissionHealth()");
  const wm = readFileSync(new URL("./wal-maintenance.ts", import.meta.url), "utf8");
  expect(wm, "the worker reports a timeout to the main thread").toContain('type:"admission-timeout"');
  expect(wm, "and the main thread feeds io-budget's counter").toContain("ioBudget.noteLockTimeout(");
});

it.each(["wal-beginCopy", "wal-endCopy"])("reports a retry for %s", site => {
  const lines: string[] = [];
  const budget = new IoBudget({ log: line => lines.push(line) });
  budget.noteLockTimeout(site);
  expect(lines.filter(line => line.includes("AdmissionLockTimeout"))).toEqual([
    `[io-budget] AdmissionLockTimeout at ${site}: the admission ledger was busy (1 so far, 0 lines suppressed); the checkpointer will retry`,
  ]);
});
