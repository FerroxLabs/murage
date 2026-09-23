import { describe, expect, it } from "vitest";
import { approvalAnswer } from "./call-answers";

describe("approvalAnswer", () => {
  it.each([
    ["Yes", "allow"],
    ["yeah go ahead", "allow"],
    ["Allow.", "allow"],
    ["Sure, do it", "allow"],
    ["You can go ahead", "allow"],
    ["Um, yes", "allow"],
    ["That's fine, go ahead", "allow"],
    ["yes for the rest of the call", "allow-for-call"],
    ["Allow for the rest of the call.", "allow-for-call"],
    ["I'll allow it for the rest of the call", "allow-for-call"],
    ["For the rest of the call, go ahead", "allow-for-call"],
    ["Don't ask me again", "allow-for-call"],
    ["Stop asking, just do it", "allow-for-call"],
    ["Yes to everything", "allow-for-call"],
    ["Allow it for this call", "allow-for-call"],
    ["No", "deny"],
    ["Nope, don't do that", "deny"],
    ["Don't", "deny"],
    ["Deny it", "deny"],
    ["No, not for the rest of the call", "deny"],
    ["I'd rather you didn't, cancel", "deny"],
  ])("%s -> %s", (said, answer) => {
    expect(approvalAnswer(said)).toBe(answer);
  });

  it.each([
    "What is it searching for?",
    "Hmm",
    "Which calendar is it going to look at before it goes ahead and does anything with it",
    "",
  ])("not a decision: %s", (said) => {
    expect(approvalAnswer(said)).toBeNull();
  });
});
