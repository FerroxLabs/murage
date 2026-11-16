import { expect, it } from "vitest";
import { vendorSecretSpans, VENDOR_SECRET_RULES } from "./provider-secret-mask.mjs";
import { vendorCarry, spliceSpans } from "./basic-auth-mask.ts";
import { LEARNING_SECRET_STAGES, redactLearningText } from "../server/memory/prospect-text.ts";

const bridged = (count: number) => Array(count).fill("pp" + "lx-" + "C".repeat(16) + "\n" + "D".repeat(16)).join("@x.");

it("vendor origins stay linear through the complete learning pipeline after bridging email edits", () => {
  for (const count of [64, 128, 256]) {
    const input = bridged(count);
    let carry = vendorCarry(input);
    let text = input;
    for (const stage of LEARNING_SECRET_STAGES) {
      const result = stage(text, carry); text = result.text; carry = [...result.carry];
    }
    const shown = spliceSpans(text, carry, () => "[secret]");
    expect(shown).toBe(redactLearningText(input));
    expect(shown.match(/\[email\]/g)).toHaveLength(count - 1);
    expect(shown).not.toContain("C".repeat(8));
    expect(shown).not.toContain("D".repeat(8));
    const origins = carry.reduce((sum, span) => sum + span.origins.length, 0);
    expect(origins, `origins retained for ${count} credentials`).toBeLessThan(12 * count);
  }
});

it("complete learning caller scales on bridging emails at 2k, 4k and 8k vendor extents", () => {
  const timings: number[] = [];
  for (const count of [2048, 4096, 8192]) {
    const input = bridged(count);
    let best = Infinity;
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = process.cpuUsage();
      const shown = redactLearningText(input);
      const used = process.cpuUsage(start);
      best = Math.min(best, (used.user + used.system) / 1000);
      expect(shown.match(/\[email\]/g)).toHaveLength(count - 1);
    }
    timings.push(best);
    expect(best, `${count} extents`).toBeLessThan(500);
  }
  // An additive allowance keeps tiny fixed costs and shared-host scheduling
  // from dominating the ratio; the counted-origin assertion is deterministic.
  expect(timings[2]!).toBeLessThan(6 * timings[0]! + 40);
}, 120_000);

// The same CPU budgets used by server/redact.test.ts, including each new
// named rule on its own. Missing values and folded near-matches are hostile.
for (const [kib, budget] of [[64, 40], [128, 60], [1024, 500]]) {
  it(`vendor masks stay linear at ${kib} KiB`, () => {
    const hostile = ["SG." + "a".repeat(22) + ".", "pypi-AgE", "ASIA", "ASIA" + "A".repeat(17), "ntn_", "secret_", "pplx-", "AWS_SESSION_TOKEN=", "SessionToken=" + "a".repeat(7) + "\n ", "X-Amz-Security-Token=" + " ".repeat(200), "ntn_a\n ", "pplx-a\r\n\t"];
    for (const unit of hostile) {
      const input = unit.repeat(Math.ceil(kib * 1024 / unit.length)).slice(0, kib * 1024);
      for (const [name, pattern] of [...VENDOR_SECRET_RULES, ["combined", undefined]] as const) {
        let best = Infinity;
        for (let attempt = 0; attempt < 3; attempt++) {
          const start = process.cpuUsage();
          if (pattern) { pattern.lastIndex=0; while(pattern.exec(input)) { /* one rule, same detection loop */ } }
          else vendorSecretSpans(input);
          const used = process.cpuUsage(start);
          best = Math.min(best, (used.user + used.system) / 1000);
        }
        expect(best, `${name}: ${unit.slice(0, 24)}`).toBeLessThan(budget);
      }
    }
  });
}
