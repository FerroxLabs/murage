import { describe, expect, it } from "vitest";

import { routineInstructionsLimit } from "./routine-instructions-limit";

// 0.1.60 re-test 2 D4: the editor accepted 26,712 characters and saved 20,000
// with no word. It now says the limit before Save, and only refuses over it.
describe("routineInstructionsLimit", () => {
  it("says nothing for ordinary and long-but-fine instructions, including the reports' lengths", () => {
    for (const length of [0, 20, 20_001, 26_646, 26_712, 89_999]) expect(routineInstructionsLimit("x".repeat(length))).toBeNull();
  });
  it("counts once close to the limit, and counts the way the server does (trimmed)", () => {
    expect(routineInstructionsLimit("x".repeat(90_000))).toEqual({ over: false, line: "90,000 of 100,000 characters" });
    expect(routineInstructionsLimit(`  ${"x".repeat(100_000)}\n\n`)).toEqual({ over: false, line: "100,000 of 100,000 characters" });
  });
  it("refuses over the limit with the server's own sentence", () => {
    expect(routineInstructionsLimit("x".repeat(100_001))).toEqual({ over: true,
      line: "Routine instructions can be up to 100,000 characters, and these are 100,001. Shorten them, or attach the long part as a file for the bot to read." });
  });
});
