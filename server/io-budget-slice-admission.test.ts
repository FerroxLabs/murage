// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IoBudget } from "./io-budget.ts";
const budgets: IoBudget[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { for (const budget of budgets.splice(0)) budget.stop(); vi.useRealTimers(); });
function watching() {
  const budget = new IoBudget({ read: () => ({ at: Date.now(), fsWriteBlocks: 0, cpuMicros: 0 }), isIdle: () => true, systemOverloaded: () => null, log: () => {} });
  budget.start(); budgets.push(budget); return budget;
}
it("a fresh fixture uses the admission reader's physical floor and still counts later writes", () => {
  let blocks = 200_000;
  const budget = new IoBudget({ read: () => ({ at: 30_000, fsWriteBlocks: 0, cpuMicros: 0 }), isIdle: () => false });
  budgets.push(budget);
  Reflect.set(budget, "admissionRead", () => ({ at: 30_000, fsWriteBlocks: blocks, cpuMicros: 0 }));
  budget.resetAdmissionForFixture();
  const ticket = budget.admit("BG", 64 * 1024);
  expect(ticket).not.toBeNull();
  budget.settle(ticket!, 0);
  blocks += 2048;
  expect(budget.admissionState().total).toBeGreaterThanOrEqual(1024 * 1024);
});
it("one measured backfill slice is repaid before another periodic writer starts", () => {
  const budget = watching(); budget.noteBytes("record-keys-backfill", 128 * 1024);
  expect(budget.deferredForMs("memory-upgrade")).toBeGreaterThanOrEqual(30_000);
  expect(budget.deferredForMs("owner-turn")).toBe(0);
  expect(budget.deferredForMs("search-index", { requested: true })).toBe(0);
  vi.advanceTimersByTime(29_999); expect(budget.shouldDefer("memory-notebook")).toBe(true);
  vi.advanceTimersByTime(1); expect(budget.shouldDefer("memory-notebook")).toBe(false);
});
it("a second source cannot borrow a fresh minute while the first slice is still owed", () => {
  const budget = watching(); budget.noteBytes("record-keys-backfill", 64 * 1024);
  vi.advanceTimersByTime(5000); budget.noteBytes("memory-idle", 64 * 1024);
  expect(budget.deferredForMs("push-delivery")).toBeGreaterThanOrEqual(25_000);
  vi.advanceTimersByTime(25_000); expect(budget.shouldDefer("push-delivery")).toBe(false);
});

it("owed capture alone may drain idle, within the existing idle write and copy ceiling", () => {
  const budget = watching();
  expect(budget.admit('BG', 61_440, 61_440)).toBeNull();
  budget.withSource('memory-capture', () => {
    const ticket = budget.admit('BG', 61_440, 61_440);
    expect(ticket, 'already-owed capture has an idle admission path').not.toBeNull();
    budget.settle(ticket!, 4096, { salt: 'fixture', frame: 1 }, 4096);
  });
  expect(budget.admissionState()).toMatchObject({ bg: 4096, debt: 4096, reserved: 0 });
  budget.withSource('memory-capture', () => {
    expect(budget.admit('BG', 1024 * 1024, 0), 'idle ceiling is unchanged').toBeNull();
  });
  expect(budget.withSource('memory-worker', () => budget.admit('BG', 61_440))).toBeNull();
});

it.each([[2_600_960, 9_900_032, 40_960], [2_486_272, 10_022_912, 36_864]])(
  'native admission snapshot charged=%i reserved=%i refuses the minimum commit independently of shared pacing',
  (charged, reserved, cap) => {
    const budget = watching(); budget.setIsIdle(() => false);
    const paid = budget.admit('BG', charged)!; budget.settle(paid, charged);
    const pool = budget.admit('BG', reserved)!;
    expect(Math.floor(budget.backgroundRoom() / 2)).toBe(cap);
    expect(budget.deferredForMs('memory-worker')).toBe(0);
    expect(budget.admit('BG', 61_440, 61_440)).toBeNull();
    budget.withSource('memory-capture', () => expect(budget.admit('BG', 61_440, 61_440)).toBeNull());
    budget.settle(pool, 0);
    const commit = budget.admit('BG', 61_440, 61_440)!;
    expect(commit).not.toBeNull(); budget.settle(commit, 4096, { salt: 'fixture', frame: 1 }, 4096);
    expect(budget.admissionState()).toMatchObject({ bg: charged + 4096, debt: 4096, reserved: 0 });
    budget.backfilled({ salt: 'fixture', frame: 1 });
    expect(budget.admissionState()).toMatchObject({ bg: charged + 8192, debt: 0, reserved: 0 });
    budget.noteBytes('memory-worker', 1024 * 1024);
    expect(budget.deferredForMs('memory-worker')).toBeGreaterThan(60_000);
    vi.advanceTimersByTime(60_000);
    expect(budget.admit('BG', 61_440, 61_440)).not.toBeNull();
  },
);
it('overlapping idle capture slices reserve copy room and preserve the closing guard',()=>{
 const budget=watching();
 budget.withSource('memory-capture',()=>{
  const first=budget.admit('BG',200_000,200_000)!;expect(first).not.toBeNull();
  expect(budget.admit('BG',200_000,200_000)).toBeNull();
  budget.settle(first,4096,{salt:'fixture',frame:1},4096);
  vi.advanceTimersByTime(56_000);
  expect(budget.admit('BG',61_440,61_440)).toBeNull();
  vi.advanceTimersByTime(4000);
  const next=budget.admit('BG',61_440,61_440)!;expect(next).not.toBeNull();
  budget.settle(next,0);
 });
 expect(budget.admissionState()).toMatchObject({bg:0,debt:4096,reserved:0});
});
