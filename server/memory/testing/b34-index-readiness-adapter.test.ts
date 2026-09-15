// B34 Q06 adapter through the runner-equivalent harness: the isolated server
// with the scripted fake Claude CLI and keyword index. Every adapter check and
// every mirrored runner check must pass. Claude 4 lane evidence only; runner
// receipts remain Claude 5's and root's.
import { describe, expect, it } from "vitest";
import { expectAllPass, runAdapterLikeRunner } from "./b34-adapter-harness.ts";
import { b34Q06Adapter } from "./b34-index-readiness-adapter.ts";

const RUNNER_CHECKS = [
  "adapter-recorded-behavioural-checks",
  "adapter-artifacts-valid",
  "no-runner-pinned-memory",
  "intended-source-processed-and-indexed",
  "unrelated-recent-context-present",
  "old-evidence-supplied-to-later-task",
  "isolation-preserved",
];

describe.skipIf(process.platform === "win32")("B34 Q06 index readiness adapter", () => {
  it("supplies processed, indexed old evidence to a later task past recent context, abstains without support and keeps bot and room isolation", async () => {
    const result = await runAdapterLikeRunner(b34Q06Adapter);
    expectAllPass(result);
    for (const name of RUNNER_CHECKS) expect(result.checks.filter(check => check.name === name).map(check => check.status), name).toEqual(["PASS"]);
    expect(result.artifacts?.row).toBe("Q06");
    // The harness closes the fixture server only when the adapter settles. The
    // adapter's own bounded waits (four 45 s readiness waits, 15 s + 30 s per
    // turn, 10 s receipt and health waits) can exceed three minutes, and a
    // Vitest timeout would abandon a live server and fake CLI, so this bound
    // stays above them.
  }, 600_000);
});
