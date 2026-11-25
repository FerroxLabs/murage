// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The long run of remote-mcp-proxy.interleave.test.ts (DESIGN-R3 5.2): seeds 501..20000, same checks.
import { describe, it } from "vitest";
import { describeFailure, runSchedule, shrink } from "./remote-mcp-proxy.interleave.ts";

describe("the owner's MCP session under interleaved answers (seeded, long run)", () => {
  it("holds its invariants on seeds 501..20000", async () => {
    for (let seed = 501; seed <= 20000; seed++) {
      const outcome = await runSchedule(seed);
      if (outcome.violations.length === 0) continue;
      const small = await shrink(outcome.actions);
      throw new Error(`${describeFailure(outcome).split("\n").slice(0, 2).join("\n")}\n--- shrunk ---\n${describeFailure(small.violations.length > 0 ? small : outcome)}`);
    }
  }, 3_600_000);
});
