// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated fixture lifecycle owner: c3-memory. Native ledger owner: scperf-p1.
import { describe, expect, it } from "vitest";
import { ioBudget } from "../../io-budget.ts";

describe.sequential("closed memory fixture admission", () => {
  it("keeps the full minute cap within one application", () => {
    const ticket = ioBudget.admit("BG", 12 * 1024 * 1024);
    expect(ticket).not.toBeNull();
    ioBudget.settle(ticket!, ticket!.bytes);
    expect(ioBudget.admit("BG", 1)).toBeNull();
  });

  it("starts the next isolated application without the discarded fixture's spent room", () => {
    expect(ioBudget.admissionState().bg).toBe(0);
    const ticket = ioBudget.admit("BG", 12 * 1024 * 1024);
    expect(ticket).not.toBeNull();
    ioBudget.settle(ticket!, 0);
  });
});
