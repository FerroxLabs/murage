import { expect, it } from "vitest";
import { beginClaudeS2Pending, claudeS2OwnsEarlier, claudeS2SteerAdapter, hasClaudeS2Pending } from "./claude-s2-pending.ts";
it("T-S2-G-M4: only this turn's owned rows pass the earlier-row fence; deferred fences run again", async () => {
  const pending = beginClaudeS2Pending("g-m4", () => false);
  try {
    let allowed = true, checks = 0;
    const fence = () => { checks++; if (!allowed) throw new Error("MEMORY_CONTEXT_REVOKED"); };
    const a = claudeS2SteerAdapter("g-m4", 10)!.steer("g-m4", "one", fence);
    const b = claudeS2SteerAdapter("g-m4", 11)!.steer("g-m4", "two");
    expect(claudeS2OwnsEarlier("g-m4", [10, 11])).toBe(true);
    expect(claudeS2OwnsEarlier("g-m4", [9, 10])).toBe(false);
    allowed = false;
    const written: string[] = [];
    await pending.flush(async (text, check) => { check?.(); written.push(text); return true; });
    expect(await a).toBe(false); expect(await b).toBe(true);
    expect(checks).toBe(2); expect(written).toEqual(["two"]);
    expect(claudeS2OwnsEarlier("g-m4", [10])).toBe(false);
  } finally { pending.close(); }
  expect(hasClaudeS2Pending("g-m4")).toBe(false);
});
