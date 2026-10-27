import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { showWorkingDots } from "./turn-tail";

const msg = (m: Partial<Message>): Message => ({ id: "m1", role: "bot", kind: "text", at: 1, ...m });

describe("showWorkingDots", () => {
  it("hides the dots when the bot is idle", () => {
    expect(showWorkingDots(false, msg({ role: "user" }))).toBe(false);
  });

  it("shows the dots while a turn runs with nothing settled yet", () => {
    expect(showWorkingDots(true, undefined)).toBe(true);
    expect(showWorkingDots(true, msg({ role: "user" }))).toBe(true);
    expect(showWorkingDots(true, msg({ kind: "activity" }))).toBe(true);
    expect(showWorkingDots(true, msg({ kind: "options" }))).toBe(true);
  });

  it("stays through the bot's words in the middle of a turn: a sentence is not the turn's end (upstream #3374)", () => {
    expect(showWorkingDots(true, msg({}))).toBe(true);
    expect(showWorkingDots(true, msg({}), undefined, false)).toBe(true);
  });

  it("keeps the dots hidden after the reply settles and the turn has ended, while busy winds down", () => {
    // the end-of-stream window: reply landed, turn.completed seen, busy:false
    // still in flight; re-showing the dots here is the jitter
    expect(showWorkingDots(true, msg({}), undefined, true)).toBe(false);
  });

  it("an ended turn hides nothing a newer row says is running", () => {
    expect(showWorkingDots(true, msg({ role: "user" }), undefined, true)).toBe(true);
    expect(showWorkingDots(true, msg({ kind: "activity" }), undefined, true)).toBe(true);
  });

  it("rooms: a settled reply only covers the bot that said it, once its turn has ended", () => {
    const fromA = msg({ from: { botId: "a", name: "A", color: "blue" } });
    expect(showWorkingDots(true, fromA, "a", true)).toBe(false);
    expect(showWorkingDots(true, fromA, "a", false)).toBe(true);
    // the floor moved on: the next speaker's dots are real information
    expect(showWorkingDots(true, fromA, "b", true)).toBe(true);
    // no attribution (older data): fail toward showing the indicator
    expect(showWorkingDots(true, msg({}), "a", true)).toBe(true);
  });
});
