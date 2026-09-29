import { describe, expect, it } from "vitest";

import {
  parseRoomTurnTimeoutMinutes,
} from "./room-turn-timeout";

describe("room turn timeout input", () => {
  it.each(["", " ", "0", "1", "19", "1.5", "1441", "twenty"])(
    "rejects %j",
    (value) => {
      expect(parseRoomTurnTimeoutMinutes(value)).toEqual({
        ok: false,
        error: "Enter a whole number from 20 to 1,440.",
      });
    },
  );

  it.each([
    ["20", 20],
    ["45", 45],
    ["1440", 1440],
  ])("accepts %s", (value, expected) => {
    expect(parseRoomTurnTimeoutMinutes(value)).toEqual({ ok: true, minutes: expected });
  });

});
