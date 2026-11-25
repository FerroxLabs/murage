// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BG_MINUTE_BYTES, BgDeferred, IoBudget } from "./io-budget.ts";
import { ownerFirst } from "./owner-first.ts";
const budgets: IoBudget[] = [];
let clock = 0;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(clock += 60_000);
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
});
afterEach(() => { for (const budget of budgets.splice(0)) budget.stop(); vi.restoreAllMocks(); vi.useRealTimers(); });
function watching() {
  const budget = new IoBudget({ read: () => ({ at: Date.now(), fsWriteBlocks: 0, cpuMicros: 0 }), isIdle: () => true, systemOverloaded: () => null, log: () => {} });
  budget.start(); budgets.push(budget); return budget;
}
it("a fresh fixture uses the admission reader's physical floor and still counts later writes", () => {
  // 1.0.21 B1/I8 (memv2-D): the admission ledger counts the application meter only (no OS counter is an input), so the fixture's floor and
  // its later writes are meter bytes; the OS counter moving alone is asserted to count nothing.
  let blocks = 200_000, meter = 200_000 * 512;
  const budget = new IoBudget({ read: () => ({ at: 30_000, fsWriteBlocks: 0, cpuMicros: 0 }), isIdle: () => false });
  budgets.push(budget);
  Reflect.set(budget, "admissionRead", () => ({ at: 30_000, fsWriteBlocks: blocks, meterBytes: meter, cpuMicros: 0 }));
  budget.resetAdmissionForFixture();
  const ticket = budget.admit("BG", 64 * 1024);
  expect(ticket).not.toBeNull();
  budget.settle(ticket!, 0);
  blocks += 2048;
  expect(budget.admissionState().total, "the OS counter alone counts nothing").toBe(0);
  meter += 2048 * 512;
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

it("BOOT_RECOVERY: idle transcript recovery shares BG room while ordinary idle upgrades remain refused", () => {
  const budget = watching();
  budget.resetAdmissionForFixture();
  const recovery = budget.claimBootRecovery(() => true)!;
  expect(recovery).not.toBeNull();
  expect(budget.admit("BG", 64 * 1024), "ordinary idle BG stays refused").toBeNull();
  const ticket = recovery.run(() => budget.admit("BOOT_RECOVERY", 64 * 1024, 64 * 1024));
  expect(ticket, "the first idle transcript pass is admitted").not.toBeNull();
  expect(budget.backgroundRoom()).toBe(BG_MINUTE_BYTES - 128 * 1024);
  budget.settle(ticket!, 32 * 1024, { salt: "fixture", frame: 1 }, 32 * 1024);
  expect(budget.admissionState()).toMatchObject({ bg: 32 * 1024, debt: 32 * 1024, reserved: 0 });
  expect(budget.backgroundRoom()).toBe(BG_MINUTE_BYTES - 64 * 1024);
  expect(budget.admit("BOOT_RECOVERY", BG_MINUTE_BYTES), "no extra recovery budget").toBeNull();
  recovery.close();
  expect(budget.admit("BOOT_RECOVERY", 1), "the finished pass cannot write").toBeNull();
  expect(() => recovery.run(() => true)).toThrow(BgDeferred);
  expect(budget.claimBootRecovery(() => true), "no second pass in this boot").toBeNull();
});
it("BOOT_RECOVERY yields to a revoked disk-floor permission before every write", () => {
  const budget = watching(); budget.resetAdmissionForFixture();
  let allowed = true;
  const recovery = budget.claimBootRecovery(() => allowed)!;
  expect(recovery.run(() => budget.currentSource())).toBe("memory-boot-recovery");
  allowed = false;
  expect(budget.admit("BOOT_RECOVERY", 64 * 1024), "recovery permission was revoked").toBeNull();
  expect(() => recovery.run(() => true)).toThrow(BgDeferred);
  expect(budget.admissionState()).toMatchObject({ bg: 0, debt: 0, reserved: 0 });
  recovery.close();
});

it.each(["turn", "start", "interaction"])("BOOT_RECOVERY yields to a real owner %s even on the active budget", kind => {
  const budget = new IoBudget({ read: () => ({ at: 30_000, fsWriteBlocks: 0, cpuMicros: 0 }), isIdle: () => false });
  budgets.push(budget); budget.resetAdmissionForFixture();
  const recovery = budget.claimBootRecovery(() => true)!;
  const release = kind === "turn" ? ownerFirst.beginOwnerTurn() : kind === "start" ? ownerFirst.beginStart() : () => {};
  if (kind === "interaction") ownerFirst.noteOwnerInteraction();
  try {
    expect(budget.admit("BOOT_RECOVERY", 64 * 1024), "owner work has priority").toBeNull();
    expect(() => recovery.run(() => true)).toThrow(BgDeferred);
    expect(budget.admissionState()).toMatchObject({ bg: 0, debt: 0, reserved: 0 });
  } finally { release(); if (kind === "interaction") vi.advanceTimersByTime(8001); recovery.close(); }
});

it("BOOT_RECOVERY yields to owner CRUD while automatic health and presence leave recovery eligible", () => {
  const budget = watching(); budget.resetAdmissionForFixture();
  const recovery = budget.claimBootRecovery(() => true)!;
  budget.noteOwnerRequest("GET", "/api/health");
  budget.noteOwnerRequest("POST", "/api/presence");
  const ticket = budget.admit("BOOT_RECOVERY", 64 * 1024);
  expect(ticket, "automatic polling does not manufacture owner activity").not.toBeNull();
  budget.settle(ticket!, 0);
  budget.noteOwnerRequest("POST", "/api/bots");
  // CHANGED-EXPECTATION (MAIN-RULING 2026-11-25T07:09:02Z, idle DO LESS no starvation; was: owner CRUD refuses recovery for the rest of the
  // minute): owner activity makes the minute ACTIVE, and on an active minute boot recovery is admitted under the BG cap; it still yields
  // while a turn streams or starts and while the owner types (the it.each above)
  const active = budget.admit("BOOT_RECOVERY", 64 * 1024);
  expect(active, "an active minute after owner CRUD admits recovery under the BG cap").not.toBeNull();
  budget.settle(active!, 0);
  expect(recovery.run(() => budget.currentSource())).toBe("memory-boot-recovery");
  recovery.close();
});

it("BOOT_RECOVERY writes repay the existing periodic debt before other idle work", () => {
  const budget = watching();
  budget.noteBytes("memory-boot-recovery", 128 * 1024);
  expect(budget.deferredForMs("memory-idle")).toBeGreaterThanOrEqual(30_000);
  expect(budget.deferredForMs("owner-turn")).toBe(0);
});

// CHANGED-EXPECTATION (MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS; was: an owed capture alone drains on an idle minute within the idle
// ceiling): on an idle minute no capture ticket is given; the owed capture drains on the next ACTIVE minute under the BG minute ceiling.
it("owed capture waits on an idle minute and drains on the next active minute (idle DO LESS)", () => {
  const budget = watching();
  expect(budget.admit('BG', 61_440, 61_440)).toBeNull();
  budget.withSource('memory-capture', () => {
    expect(budget.admit('BG', 61_440, 61_440), 'idle DO LESS: no capture ticket on an idle minute').toBeNull();
  });
  budget.setIsIdle(() => false);
  budget.withSource('memory-capture', () => {
    const ticket = budget.admit('BG', 61_440, 61_440);
    expect(ticket, 'an active minute admits the owed capture').not.toBeNull();
    budget.settle(ticket!, 4096, { salt: 'fixture', frame: 1 }, 4096);
  });
  expect(budget.admissionState()).toMatchObject({ bg: 4096, debt: 4096, reserved: 0 });
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
// CHANGED-EXPECTATION (MAIN-RULING 2026-11-25T05:54:59Z idle DO LESS; was: overlapping idle capture slices): idle refuses the capture; on an
// active minute the slices reserve their copy room and the closing guard (the minute's last 5 s) still refuses.
it('overlapping capture slices: refused idle, on an active minute they reserve copy room and preserve the closing guard',()=>{
 const budget=watching();
 budget.withSource('memory-capture',()=>{expect(budget.admit('BG',200_000,200_000),'idle DO LESS').toBeNull();});
 budget.setIsIdle(()=>false);
 budget.withSource('memory-capture',()=>{
  const first=budget.admit('BG',200_000,200_000)!;expect(first).not.toBeNull();
  budget.settle(first,4096,{salt:'fixture',frame:1},4096);
  vi.advanceTimersByTime(56_000);
  expect(budget.admit('BG',61_440,61_440),'the closing guard').toBeNull();
  vi.advanceTimersByTime(4000);
  const next=budget.admit('BG',61_440,61_440)!;expect(next).not.toBeNull();
  budget.settle(next,0);
 });
});
