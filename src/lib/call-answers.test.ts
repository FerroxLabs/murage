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

  // A negated answer is never consent (found 2026-10-03: "do not allow
  // everything" used to grant the rest of the call).
  it.each([
    ["do not allow everything", "deny"],
    ["Do not allow everything.", "deny"],
    ["don't allow it", "deny"],
    ["no, don't allow everything", "deny"],
    ["never allow that", "deny"],
    ["I don't want you to allow everything", "deny"],
    ["I do not want you to approve this", "deny"],
    ["yes, allow everything", "allow-for-call"],
    ["don't ask me again", "allow-for-call"],
    ["stop asking", "allow-for-call"],
    ["no need to ask", "allow-for-call"],
    ["no need to ask, just do it", "allow-for-call"],
    ["wait, don't", "deny"],
    ["wait", "deny"],
    ["not for the whole call", "deny"],
    ["don\u2019t allow everything", "deny"],
    ["um no", "deny"],
    ["sure", "allow"],
    ["ok do it", "allow"],
  ])("negation table: %s -> %s", (said, answer) => {
    expect(approvalAnswer(said)).toBe(answer);
  });

  it.each([
    "allow it but not the email",
    "yes but don't send anything",
    "go ahead, but never to my boss",
    "stop asking but don't allow the email",
  ])("a yes with a later no stays open: %s", (said) => {
    expect(approvalAnswer(said)).toBeNull();
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
