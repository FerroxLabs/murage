import { describe, expect, it } from "vitest";

import { shouldHideOnboardingCard, shouldOfferOnboardingCardBack } from "./OptionCard";
import type { Message } from "@/state/store";

const msg = (partial: Partial<Message> & Pick<Message, "id" | "kind">): Message => ({
  role: "bot",
  at: 1,
  ...partial,
});

describe("shouldHideOnboardingCard", () => {
  const quiz = msg({
    id: "quiz",
    kind: "options",
    card: {
      title: "What do you mostly want help with?",
      subtitle: "Pick whatever's closest; we can always expand from there.",
      options: ["Work & projects"],
    },
  });
  const greeting = msg({ id: "hi", kind: "text", text: "Hey — I'm Echo." });
  const user = msg({ id: "u1", role: "user", kind: "text", text: "Hi bro" });

  it("keeps the quiz until the person talks", () => {
    expect(shouldHideOnboardingCard(quiz, [greeting, quiz])).toBe(false);
  });

  it("hides once a later user message is on the path", () => {
    expect(shouldHideOnboardingCard(quiz, [greeting, quiz, user])).toBe(true);
  });

  it("hides an answered quiz for good — the answer is a message in the thread", () => {
    expect(
      shouldHideOnboardingCard({ ...quiz, card: { ...quiz.card!, answered: "Work & projects" } }, [greeting, quiz]),
    ).toBe(true);
  });

  it("does not erase a dismissed quiz: it keeps its place so it can come back", () => {
    const dismissed = { ...quiz, card: { ...quiz.card!, dismissed: true } };

    // the X used to remove the only route back to this question
    expect(shouldHideOnboardingCard(dismissed, [greeting, quiz])).toBe(false);
    expect(shouldOfferOnboardingCardBack(dismissed, [greeting, quiz])).toBe(true);
    // and the way back survives the conversation moving on
    expect(shouldOfferOnboardingCardBack(dismissed, [greeting, quiz, user])).toBe(true);
  });

  it("shows the card itself again once it has been restored, talked past or not", () => {
    const restored = { ...quiz, card: { ...quiz.card!, dismissed: false } };

    expect(shouldHideOnboardingCard(restored, [greeting, quiz])).toBe(false);
    expect(shouldOfferOnboardingCardBack(restored, [greeting, quiz])).toBe(false);
    // an explicit "show me this again" outranks the transcript rule, or
    // restoring on a thread with any history at all would do nothing
    expect(shouldHideOnboardingCard(restored, [greeting, quiz, user])).toBe(false);
  });

  it("offers no way back to a quiz that was answered or never hidden", () => {
    expect(shouldOfferOnboardingCardBack(quiz, [greeting, quiz])).toBe(false);
    expect(
      shouldOfferOnboardingCardBack(
        { ...quiz, card: { ...quiz.card!, dismissed: true, answered: "Work & projects" } },
        [greeting, quiz],
      ),
    ).toBe(false);
    // an old server that never recorded the hide: the transcript still hides
    // it, and there is no recorded click to undo
    expect(shouldOfferOnboardingCardBack(quiz, [greeting, quiz, user])).toBe(false);
  });

  it("never hides a live permission or question card", () => {
    const ask = msg({
      id: "ask",
      kind: "options",
      card: {
        title: "Approval needed",
        subtitle: "run rm",
        options: ["Allow", "Deny"],
        requestId: "req-1",
        tool: "Bash",
      },
    });
    expect(shouldHideOnboardingCard(ask, [greeting, quiz, user, ask])).toBe(false);
    // and a live ask never collapses to the restore line: a denial is settled
    // with the provider and cannot be taken back from the transcript
    expect(shouldOfferOnboardingCardBack({ ...ask, card: { ...ask.card!, dismissed: true } }, [ask])).toBe(false);
    const question = msg({
      id: "q",
      kind: "options",
      card: {
        title: "Your bot has a question",
        subtitle: "which file?",
        options: [],
        requestId: "req-2",
      },
    });
    expect(shouldHideOnboardingCard(question, [user, question])).toBe(false);
  });
});
