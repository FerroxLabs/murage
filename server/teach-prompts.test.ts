// W11 (TEACH-ENTRY 1.0.23 D8.1, D9.5): what every bot is told about /learn, /teach and taught
// skills, and the two teach notes: conditional and additive, never a reply order.
import { describe, expect, it } from "vitest";
import { TURN_PROMPTS } from "./bot-shapes.ts";

describe("W11 teach prompt lines", () => {
  it("the /learn line says where skills are reviewed and never to start a recording", () => {
    expect(TURN_PROMPTS.learn).toContain("Bot settings → Skills");
    expect(TURN_PROMPTS.learn).toContain("Settings → Skills → Taught by you");
    expect(TURN_PROMPTS.learn).toContain("never start a recording yourself");
  });
  it("the card note never starts /learn or claims a recording", () => {
    expect(TURN_PROMPTS.teachCard).toContain("Do not start /learn");
    expect(TURN_PROMPTS.teachCard).toContain("never say a recording has started");
  });
  it.each([["teachCard"], ["teachText"]] as const)("%s first answers the message and is otherwise ignored", (key) => {
    const line = TURN_PROMPTS[key];
    expect(line).toContain("First do or answer what the message asks");
    expect(line).toContain("Otherwise ignore this note");
    expect(line).not.toContain("Reply in");
    expect(line).not.toContain("not available where they are");
  });
});
