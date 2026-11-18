// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: vi.fn() }));
import { monthLine } from "../components/today/MonthCard";
import { spendState } from "./spend-meter";
const total = { state: "ok" as const, spentUsd: 100, asOf: "2026-11-13T12:00:00Z", resetsAt: "2026-12-01T00:00:00Z" };
it("labels the billed account figure accurately with and without a local limit", () => {
  const unlimited = spendState(total, {monthlyLimitUsd: null});
  const limited = {...unlimited, limitUsd: 200, percent: 50};
  expect(monthLine(total, unlimited, true)).toBe("Account spend through Flux Router this month: $100");
  expect(monthLine(total, limited, true)).toBe("Account spend through Flux Router: $100 of $200 · 50%");
  expect(monthLine(total, unlimited)).toContain("Chat spend");
});
