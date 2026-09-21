import { describe, expect, it } from "vitest";

import {
  CHIEF_CONFIRMATIONS,
  SETUP_FLUX_PROVED_ANSWER,
  SETUP_FLUX_UNPROVED_ANSWER,
  chiefConfirmation,
  chiefConfirmationsFor,
} from "./first-run-chief.ts";

/**
 * THE SENTENCE THAT WAS SAID OVER A KEY NOBODY HAD CHECKED.
 *
 * "That is saved, and locked away on this computer" was posted the moment a
 * `sk-flux-…` shaped string reached the keychain. Nothing had asked Flux
 * Router whether it worked, so a revoked or mistyped key got the Chief's
 * personal word for it and then failed on the person's first question.
 *
 * What is locked down here: the confirmation is earned, the offline sentence
 * makes no claim about the key, and a key Flux Router REFUSED gets no line at
 * all, because there is nothing true for the Chief to say yet.
 */
describe("what the Chief says when the key step lands", () => {
  it("says the key works only for the answer that means it was tried", () => {
    const proved = chiefConfirmation("flux", SETUP_FLUX_PROVED_ANSWER);
    expect(proved).toBe("That key works, and it is locked away on this computer. It never appears in our conversation, not even to me.");
  });

  it("never claims a key is good when nothing could reach Flux Router to ask", () => {
    const unproved = chiefConfirmation("flux", SETUP_FLUX_UNPROVED_ANSWER) ?? "";
    expect(unproved).toContain("could not reach Flux Router");
    expect(unproved).toContain("not tried it yet");
    // Somebody offline with a perfectly good key must not read a verdict.
    expect(unproved).not.toMatch(/\bwrong\b|\bworks\b|\bdid not accept\b|\brejected\b/i);
    // And they are not stranded: the key is theirs, kept, and will be used.
    expect(unproved).toContain("locked away on this computer");
  });

  it("says nothing at all for an answer it has no true sentence for", () => {
    // The old literal. If it ever comes back as an answer, it must not
    // resurrect a confirmation with it.
    expect(chiefConfirmation("flux", "key saved")).toBeNull();
    expect(chiefConfirmation("flux", "")).toBeNull();
    expect(chiefConfirmation("flux", "rejected")).toBeNull();
    for (const step of ["hello", "detect", "chat", "flow"] as const) {
      expect.soft(chiefConfirmation(step, SETUP_FLUX_PROVED_ANSWER), step).toBeNull();
    }
  });

  it("is tolerant of the whitespace a wire answer arrives with", () => {
    expect(chiefConfirmation("flux", ` ${SETUP_FLUX_PROVED_ANSWER}\n`)).toBe(chiefConfirmation("flux", SETUP_FLUX_PROVED_ANSWER));
  });

  it("hands the server every line the step could have said", () => {
    // The idempotence check reads this: a retry that comes back with the
    // other verdict must not leave two confirmations contradicting each
    // other in the thread.
    const lines = chiefConfirmationsFor("flux");
    expect(lines).toHaveLength(2);
    expect(lines).toContain(chiefConfirmation("flux", SETUP_FLUX_PROVED_ANSWER));
    expect(lines).toContain(chiefConfirmation("flux", SETUP_FLUX_UNPROVED_ANSWER));
    expect(chiefConfirmationsFor("hello")).toEqual([]);
  });

  it("keeps the house rules, which is why these live in one table", () => {
    for (const [step, lines] of Object.entries(CHIEF_CONFIRMATIONS)) {
      for (const [answer, text] of Object.entries(lines ?? {})) {
        const where = `${step}/${answer}`;
        expect.soft(text, where).not.toContain("—");
        expect.soft(text.toLowerCase(), where).not.toContain("composio");
        expect.soft(text, where).not.toMatch(/\bsk-/);
        expect.soft(text.split(/[.!?]+(?=\s|$)/).filter((part) => part.trim()).length, where).toBeLessThanOrEqual(3);
      }
    }
  });
});
