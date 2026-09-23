import { describe, expect, it } from "vitest";

import { plainFailure } from "./voice-host";

describe("an engine failure, said on a call", () => {
  it.each([
    [
      "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.7 for now. Usage resets…\nA",
      "You've used all the included free usage for model grok-4.7 for now.",
    ],
    ["error: Grok CLI is not signed in — run `grok login` in a terminal", "Grok CLI is not signed in — run grok login in a terminal"],
    ["This bot's model needs an AI provider connected first. Open Settings → Models to connect one.", "This bot's model needs an AI provider connected first."],
    ["", "The engine reported an error."],
  ])("%s", (details, said) => {
    expect(plainFailure(details)).toBe(said);
  });
});
