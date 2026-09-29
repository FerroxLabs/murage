import { describe, expect, it, vi } from "vitest";

import * as roomTurnTimeout from "./room-turn-timeout.ts";
import { RoomTurnStallRegistry, roomTurnSilenceMs, roomTurnStallMessage } from "./room-turn-timeout.ts";

describe("room turn silence limit", () => {
  it("converts configured minutes to milliseconds", () => {
    expect(roomTurnSilenceMs(20)).toBe(20 * 60_000);
  });

  it("has no absolute ceiling left to stop a room reply that keeps working", () => {
    // 0.1.61: the fixed room ceiling stopped long work mid-stream. Room turns
    // are stopped for silence only, by the stall watchdog.
    expect("RoomTurnDeadline" in roomTurnTimeout).toBe(false);
  });

  it("settles a stalled room turn once and can be reused", () => {
    const stalls = new RoomTurnStallRegistry();
    const finish = vi.fn();
    stalls.register("room-thread", finish);

    expect(stalls.stall("room-thread")).toBe(true);
    expect(stalls.stall("room-thread")).toBe(false);
    expect(finish).toHaveBeenCalledOnce();

    const settledElsewhere = vi.fn();
    const cleanup = stalls.register("room-thread", settledElsewhere);
    cleanup();
    expect(stalls.stall("room-thread")).toBe(false);
    expect(settledElsewhere).not.toHaveBeenCalled();

    const nextTurn = vi.fn();
    stalls.register("room-thread", nextTurn);
    expect(stalls.stall("room-thread")).toBe(true);
    expect(nextTurn).toHaveBeenCalledOnce();
  });

  it("says no activity, in the direct turns' words, with the close it still waits for", () => {
    expect(roomTurnStallMessage(1)).toBe(
      "error: no activity for 1 minute: stopping; waiting for the engine to confirm close",
    );
    expect(roomTurnStallMessage(20)).toBe(
      "error: no activity for 20 minutes: stopping; waiting for the engine to confirm close",
    );
  });
});
