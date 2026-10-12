import { describe, expect, it, vi } from "vitest";
import { reconcileLateSteer, type LateSteerDeps, type LateSteerInput } from "./steer-late.ts";

const input: LateSteerInput = { botId: "b1", threadId: "t1", seq: 4, messageId: "m1" };
function deps(over: Partial<LateSteerDeps> = {}): LateSteerDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    botExists: () => true,
    patchMessage: vi.fn((_t, _m, patch) => { calls.push(`patch ${JSON.stringify(patch)}`); }),
    delivered: vi.fn(() => { calls.push("delivered"); }),
    passedByLater: () => false,
    requeue: vi.fn(() => { calls.push("requeue"); }),
    fail: vi.fn(() => { calls.push("fail"); }),
    release: vi.fn(() => { calls.push("release"); }),
    drain: vi.fn(() => { calls.push("drain"); }),
    ...over,
  };
}

describe("late steer reconciliation", () => {
  it("a late acceptance confirms the line in place and stops holding the line", () => {
    const d = deps();
    reconcileLateSteer(d, input, "delivered");
    expect(d.patchMessage).toHaveBeenCalledWith("t1", "m1", { steerUnconfirmed: false });
    expect(d.delivered).toHaveBeenCalledWith(4, "m1");
    expect(d.release).toHaveBeenCalledWith(4);
    expect(d.requeue).not.toHaveBeenCalled();
  });

  it("a late proven refusal puts the row back in place, from the line already in the transcript, and drains it", () => {
    const d = deps();
    reconcileLateSteer(d, input, "rejected");
    expect(d.requeue).toHaveBeenCalledWith(4, "m1");
    expect(d.calls.at(-1)).toBe("drain");
    expect(d.calls[0]).toContain('"steerUnconfirmed":false');
  });

  it("a late refusal after a later message already went to the engine is failed, never queued behind it", () => {
    const d = deps({ passedByLater: () => true });
    reconcileLateSteer(d, input, "rejected");
    expect(d.fail).toHaveBeenCalledWith(4, "t1", "m1");
    expect(d.requeue).not.toHaveBeenCalled();
  });

  it("an answer that is still uncertain changes nothing, and a deleted bot queues nothing", () => {
    const d = deps();
    reconcileLateSteer(d, input, "uncertain");
    expect(d.calls).toEqual([]);
    const gone = deps({ botExists: () => false });
    reconcileLateSteer(gone, input, "rejected");
    expect(gone.requeue).not.toHaveBeenCalled();
  });

  it("never throws into the engine", () => {
    const d = deps({ requeue: () => { throw new Error("queue refused"); } });
    expect(() => reconcileLateSteer(d, input, "rejected")).not.toThrow();
    expect(d.release).toHaveBeenCalled();
  });
});
