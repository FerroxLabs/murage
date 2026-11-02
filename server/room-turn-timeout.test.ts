import { describe, expect, it, vi } from "vitest";

import * as roomTurnTimeout from "./room-turn-timeout.ts";
import { readFileSync } from "node:fs";
import { ROOM_OPEN_TOOL_MINUTES as SHOWN_OPEN_TOOL_MINUTES } from "../src/lib/room-turn-timeout.ts";
import { ROOM_OPEN_TOOL_MINUTES, RoomOpenTools, RoomTurnStallRegistry, roomTurnSilenceMs, roomTurnStallMessage } from "./room-turn-timeout.ts";

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

describe("room open tools (LONGWORK-STALL-60-ROOMS)", () => {
  it("uses the room's limit with nothing open and at least an hour while a tool is open", () => {
    const tools = new RoomOpenTools();
    expect(tools.limitMinutes(20)).toBe(20);
    tools.started("a");
    expect(tools.limitMinutes(20)).toBe(60);
    expect(tools.limitMinutes(45)).toBe(60);
    tools.completed("a");
    expect(tools.limitMinutes(20)).toBe(20);
  });

  it("keeps a saved limit above an hour", () => {
    const tools = new RoomOpenTools();
    tools.started("a");
    expect(tools.limitMinutes(90)).toBe(90);
  });

  it("holds the longer limit until the last tool closes, and a duplicate start is one tool", () => {
    const tools = new RoomOpenTools();
    tools.started("a");
    tools.started("a");
    tools.started("b");
    tools.completed("a");
    expect(tools.limitMinutes(20)).toBe(60);
    tools.completed("b");
    expect(tools.limitMinutes(20)).toBe(20);
  });

  it("an end for a tool it never saw changes nothing, and a tool with no id still counts", () => {
    const tools = new RoomOpenTools();
    tools.completed("someone-else");
    expect(tools.limitMinutes(20)).toBe(20);
    tools.started(undefined);
    tools.completed("someone-else");
    expect(tools.limitMinutes(20)).toBe(60);
    tools.completed(undefined);
    expect(tools.limitMinutes(20)).toBe(20);
  });

  it("past the tracked count an untracked tool could be running, so the longer limit stays", () => {
    const tools = new RoomOpenTools();
    for (let i = 0; i < 257; i++) tools.started(`t${i}`);
    for (let i = 0; i < 257; i++) tools.completed(`t${i}`);
    expect(tools.limitMinutes(20)).toBe(60);
  });

  it("Settings says what the server does", () => {
    expect(SHOWN_OPEN_TOOL_MINUTES).toBe(ROOM_OPEN_TOOL_MINUTES);
    const settings = readFileSync(new URL("../src/components/RoomTurnTimeoutSettings.tsx", import.meta.url), "utf8");
    expect(settings).toContain("minutes with no activity. A running tool can take up to {Math.max(confirmedMinutes, ROOM_OPEN_TOOL_MINUTES)} minutes.");
  });
});
