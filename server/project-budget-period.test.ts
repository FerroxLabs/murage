// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { budgetPeriodStart } from "./project-budget-period.ts";
it.each([
  ["day", "America/Santiago", "2026-09-06T12:00:00Z", "2026-09-06T04:00:00Z"],
  ["week", "Asia/Tehran", "2021-03-22T12:00:00Z", "2021-03-21T20:30:00Z"],
  ["month", "America/Asuncion", "2017-10-02T12:00:00Z", "2017-10-01T04:00:00Z"],
  ["day", "America/Havana", "2026-11-01T12:00:00Z", "2026-11-01T04:00:00Z"],
  ["day", "UTC", "2026-09-06T12:00:00Z", "2026-09-06T00:00:00Z"],
] as const)("F10 %s boundary in %s starts at its first local instant", (period, zone, now, expected) => {
  expect(budgetPeriodStart(period, zone, Date.parse(now))).toBe(Date.parse(expected));
});
