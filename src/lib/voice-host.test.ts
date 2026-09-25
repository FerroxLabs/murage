import { describe, expect, it } from "vitest";

import { openingOf, plainFailure } from "./voice-host";

describe("an engine failure, said on a call", () => {
  it.each([
    [
      "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.7 for now. Usage resets…\nA",
      "You've used all the included free usage for model grok-4.7 for now.",
    ],
    ["error: Grok CLI is not signed in: run `grok login` in a terminal", "Grok CLI is not signed in: run grok login in a terminal"],
    ["This bot's model needs an AI provider connected first. Open Settings → Models to connect one.", "This bot's model needs an AI provider connected first."],
    ["", "The engine reported an error."],
  ])("%s", (details, said) => {
    expect(plainFailure(details)).toBe(said);
  });
});

describe("the opening of a long answer, when it cannot be told briefly", () => {
  it("reads the first paragraph of prose and points at the chat", () => {
    const answer = "It is 1:34pm in Bangkok. Nothing else is booked after 2:00.\n\n**Still on the day**\n\n- All day: Home\n- 1:30 buffer";
    expect(openingOf(answer)).toBe("It is 1:34pm in Bangkok. Nothing else is booked after 2:00. The rest is in the chat.");
    expect(openingOf("## Heading\n\n- one\n- two\n\nPlain words here.")).toBe("Plain words here. The rest is in the chat.");
  });
});
