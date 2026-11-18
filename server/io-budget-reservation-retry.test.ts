// SPDX-License-Identifier: AGPL-3.0-or-later
// Reservation-wait retry owner: warm-capture (arev-conf-warmcap-par Medium io-budget.ts:558). Ledger owner: walseam (admission-shared.ts).
// A capture refused while another holder's reservation is live retries at the short step only when that settle can make room:
// an idle allowance already spent waits for the next minute like any other spent bytes.
import { expect, it } from "vitest";
import { IoBudget, IO_BUDGET_IDLE_BYTES_PER_MINUTE } from "./io-budget.ts";

const reading = { cpuMicros: 0, fsWriteBlocks: 0, meterBytes: 0 };
const IDLE_ROOM = IO_BUDGET_IDLE_BYTES_PER_MINUTE - 65536;
function world() {
  // A fixed clock early in a minute keeps the closing guard out of these rows.
  const at = 600 * 60_000 + 1000;
  const budget = new IoBudget({ read: () => ({ ...reading, at }) as never, log: () => {} });
  let idle = false;
  budget.setIsIdle(() => idle);
  const capture = <T>(run: () => T) => budget.withSource("memory-capture", run);
  return { budget, capture, idle: (value: boolean) => { idle = value; } };
}

it("an idle capture behind a live reservation with idle room left retries at the short step", () => {
  const w = world();
  w.idle(true);
  const live = w.capture(() => w.budget.admit("BG", 8192, 0))!;
  expect(live).not.toBeNull();
  const retry = w.capture(() => w.budget.refusalRetry());
  expect(retry.reservationWait).toBe(true);
  expect(retry.retryInMs).toBeLessThanOrEqual(1000);
  expect(w.capture(() => w.budget.claimRetryMs(true))).toBeLessThanOrEqual(1000);
  w.budget.settle(live, 0);
});

it("an idle capture whose idle allowance is already spent waits for the minute, even beside a live reservation", () => {
  const w = world();
  w.idle(true);
  const spent = w.capture(() => w.budget.admit("BG", IDLE_ROOM, 0))!;
  expect(spent, "the whole idle allowance can be admitted").not.toBeNull();
  w.budget.settle(spent, IDLE_ROOM);
  // An unrelated holder reserved while the owner was active; its settle cannot return idle room that is already spent.
  w.idle(false);
  const live = w.budget.withSource("memory-worker", () => w.budget.admit("BG", 8192, 0))!;
  expect(live).not.toBeNull();
  w.idle(true);
  expect(w.capture(() => w.budget.admit("BG", 4096, 0)), "the spent idle allowance refuses the capture").toBeNull();
  const retry = w.capture(() => w.budget.refusalRetry());
  expect(retry.reservationWait, "spent idle bytes are not a reservation wait").toBe(false);
  expect(retry.retryInMs).toBe(w.budget.nextAdmissionMs());
  expect(w.capture(() => w.budget.claimRetryMs(true)), "the claim loop waits for the minute as well").toBe(w.budget.nextAdmissionMs());
  w.budget.settle(live, 0);
});
