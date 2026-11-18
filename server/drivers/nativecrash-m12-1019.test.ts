// SPDX-License-Identifier: AGPL-3.0-or-later
// G0 M12 (rebound target, Fable F11), structural guard by unit test: a discharge whose target is bound to another generation than its
// refusal writes no bytes, runs no close, and records "in-process:target-rebound" (the outcome G1's codex closeFenced reports, M18 order).
import { expect, it, vi } from "vitest";
import { EngineInputRevoked, refusalFor, targetRebound, type FencedRefusalOutcome } from "./engine-input.ts";

const verdict = { state: "checking", reason: "not-built" } as never;
let serial = 0; // a fresh dispatch generation per refusal (the registry joins one R per dispatch generation)
const refusal = (generation: number) => refusalFor(new EngineInputRevoked(verdict), "test.m12", { engine: "fixture", threadId: "thread-m12",
  generation, binding: { identity: { dispatchGeneration: `m12-${++serial}` } } as never, owner: {}, target: {} })!;

/** The M18 shape a driver's byte-writing discharge takes: the rebound test first, then the bytes, then the close. */
const discharge = (R: ReturnType<typeof refusal>, target: { boundGeneration?: number | null }, write: () => void) => {
  if (targetRebound(R, target)) return;
  write(); void R.close(async () => ({ confirmed: true }));
};

it("M12: a target rebound to generation N+1 gets no bytes and no close; the record says in-process:target-rebound", async () => {
  const R = refusal(7); const write = vi.fn();
  discharge(R, { boundGeneration: 8 }, write);
  await new Promise(r => setImmediate(r));
  expect(write).not.toHaveBeenCalled();
  expect(R.teardownSettled, "no close ran").toBe(false);
  expect(R.outcome).toBe("in-process:target-rebound" satisfies FencedRefusalOutcome);
});

it("M12 controls: the same generation, and a target that does not track its generation, are discharged as before", async () => {
  for (const target of [{ boundGeneration: 7 }, {}]) {
    const R = refusal(7); const write = vi.fn();
    discharge(R, target, write);
    await R.teardown;
    expect(write).toHaveBeenCalledOnce();
    expect(R.outcome).toBe("closed");
  }
});
