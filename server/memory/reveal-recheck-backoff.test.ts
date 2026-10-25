// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SELF-OVERLOAD-105 item 3: a pending reveal receipt whose job is not eligible is looked at again after a doubling pause (10 min, 20, 40,
// ... 24 h), not every 10 minutes. On the owner's store 80,605 such receipts at a flat 10 minutes needed 134 looks a second against a sweep
// that reads 64, so the sweep never stopped: 7,680 statements a minute for ever.
import { expect, it } from "vitest";
import * as reveal from "./reveal-capture.ts";

const R = reveal as unknown as Record<string, any>;

it("fail-before: the recheck backs off per look, from 10 minutes, doubling, capped at 24 hours", () => {
  expect(typeof R.ineligibleRecheckMs, "ineligibleRecheckMs is exported").toBe("function");
  expect(R.INELIGIBLE_RECHECK_MS).toBe(600_000);
  expect(R.ineligibleRecheckMs(0)).toBe(600_000);
  expect(R.ineligibleRecheckMs(1)).toBe(1_200_000);
  expect(R.ineligibleRecheckMs(2)).toBe(2_400_000);
  expect(R.ineligibleRecheckMs(7)).toBe(76_800_000);
  expect(R.ineligibleRecheckMs(8)).toBe(24 * 3_600_000);
  expect(R.ineligibleRecheckMs(40)).toBe(24 * 3_600_000);
  expect(R.ineligibleRecheckMs(-3)).toBe(600_000);
});

it("the looks an 80k ineligible set costs in its first day fall from 8,060 a minute (flat) to 8 per receipt in all", () => {
  // flat 10 minutes: 80,605 receipts / 10 min = 8,060 looks a minute (each one intent read and one eligibility probe), 11.6 million a day
  const receipts = 80_605, day = 24 * 60;
  const flat = (receipts / 10) * day;
  let at = 0, looks = 0;
  for (; at <= day * 60_000; looks++) at += R.ineligibleRecheckMs(looks);
  expect(looks).toBeLessThanOrEqual(9); // 10, 20, 40, 80, 160, 320, 640, 1280 min: eight looks reach a day
  expect(receipts * looks).toBeLessThan(flat / 15); // 645k looks in the day, 18x fewer, most of them in the first hours
});
