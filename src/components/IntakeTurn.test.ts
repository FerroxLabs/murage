// The setup conversation, as a thing on screen.
//
// Source contracts, for the reason SkillAffordances.test.ts and
// BotIntakeCard.test.ts are: the renderer suite runs in a node environment
// with no DOM, so what a person sees cannot be rendered here. The decisions
// worth pinning are not visual anyway. They are the four that decide whether
// this is a conversation or a form:
//
//   • the composer stays the free-text answer, so the chips are never the
//     only way through,
//   • the question is the bot talking, not a panel,
//   • the wiring reaches it at all, and reaches it FIRST,
//   • the words on screen belong to the server.
//
// The behaviour underneath — what gets posted, in what order, and what the
// press changes — is executed for real in src/lib/onboarding-intake.test.ts,
// where it is a pure function rather than a component.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const turn = read("./IntakeTurn.tsx");
const chat = read("./ChatView.tsx");
const composer = read("./Composer.tsx");
const optionCard = read("./OptionCard.tsx");

/** The render body alone, so an assertion cannot be satisfied by the doc
 *  comment at the top of the file explaining why the thing is absent. */
const body = turn.slice(turn.indexOf("export function IntakeTurn("));

describe("free text is an answer at every turn", () => {
  it("carries no input of its own, because the composer is the input", () => {
    // NOT a chips-only card. The composer is on screen at every turn and
    // takes any sentence; a second box inside the bubble would be a form in
    // a chat window, and two inputs on one screen for one question.
    expect(body).not.toMatch(/<input\b/);
    expect(body).not.toMatch(/<textarea\b/);
  });

  it("is what the composer routes a typed answer into", () => {
    // Without this the sentence goes to the engine, which answers it as a
    // question about itself, and the conversation ends without the answer
    // ever being read. A question with no chips at all — the second one is
    // sometimes exactly that — would have no way to be answered.
    expect(composer).toContain("openIntakeCard(visibleMessages(bot))");
    expect(composer).toContain("replyToIntake(bot.id, question.id, t, api)");
    // Routed INSTEAD of sent: both would post the same line twice.
    const routed = composer.slice(composer.indexOf("openIntakeCard(visibleMessages(bot))"));
    expect(routed.slice(0, routed.indexOf("dispatch({"))).toContain("return;");
  });

  it("sends a chip back exactly as it arrived, deciding nothing", () => {
    // The server reads the step off its own stored card. A renderer that
    // matched the label against a sentence of its own would be a second copy
    // of the script, and the first copy edit would turn the chips into
    // no-ops that look fine.
    expect(body).toContain("replyToIntake(bot.id, message.id, text, api)");
    // The press is read by position, in a pure function that has its own
    // tests, rather than by matching the label against a sentence here.
    expect(body).toContain("intakeChipAction(intake, card.options, index)");
  });
});

describe("it is the bot talking, not a panel", () => {
  it("renders the card's own words and writes none of its own", () => {
    expect(body).toContain("{card.title}");
    expect(body).toContain("{card.subtitle}");
    expect(body).toContain("{option}");
    // No question is authored on this side of the wire.
    expect(body).not.toMatch(/"[^"]*\?"/);
  });

  it("offers chips rather than a lettered list in a box", () => {
    // A/B/C/D in a bordered box is the four-button quiz this replaced, and a
    // person reads it as a form to fill in.
    expect(body).not.toContain("LETTERS");
    expect(body).not.toMatch(/["'`]A["'`],\s*["'`]B["'`]/);
  });

  it("has no dismiss control, because there is nothing to dismiss", () => {
    // Typing something else ends it, and the server settles it as general
    // chat. A close button would make walking away look like a failure to
    // finish something.
    expect(body).not.toMatch(/aria-label="(Hide|Dismiss)/);
    expect(body).not.toContain("dismissCard");
    expect(body).not.toContain("<X ");
  });

  it("drops its controls once the question is spent", () => {
    // No "you picked X" state and no row of greyed-out buttons: the person's
    // own answer is the very next bubble, so either one says the same thing
    // twice.
    expect(body).toContain("const answered = Boolean(card.answered);");
    expect(body).toMatch(/\{!answered && card\.options\.length > 0 &&/);
  });
});

describe("it stays usable on a short window", () => {
  it("is a transcript row, so it scrolls with everything else", () => {
    // The card this replaces was pinned above the composer and grew
    // downward from a fixed edge: 1,379px on a 937px screen, with its own
    // question and its own close button pushed off the top and no scrollbar
    // anywhere. A row in the transcript cannot do that, and the way to keep
    // it that way is to give it no height of its own and no fixed edge.
    expect(turn).not.toMatch(/\d+vh|--vvh/);
    expect(turn).not.toMatch(/max-h-/);
    // Positioning, as it would actually appear: inside a class string.
    for (const literal of turn.match(/"[^"\n]*"/g) ?? []) {
      expect(literal).not.toMatch(/\b(absolute|fixed|sticky)\b/);
    }
  });

  it("wraps its chips rather than pushing a row off the side", () => {
    expect(body).toContain("flex flex-wrap");
  });
});

describe("the install still crosses the desktop boundary", () => {
  it("gates the apply chip, and only the apply chip", () => {
    // Installing a skill is a desktop-only write. Rendering a button that
    // will 404 and printing the raw server error underneath it is the
    // failure this replaces; "keep me general" installs nothing, so it stays
    // pressable on a phone.
    expect(turn).toContain('import { useDesktopSurface } from "@/lib/use-surface"');
    expect(body).toContain("desktop !== true");
    expect(body).toContain("desktop === false");
    expect(body).toContain("if (busy || !slug || desktop !== true) return;");
  });

  it("applies through the one helper that pins the name", () => {
    expect(body).toContain("confirmIntakeProfile(bot.id, message.id, slug,");
    expect(body).toContain("botPatched");
    expect(body).not.toContain("rename: true");
  });

  it("names what failed instead of swallowing it", () => {
    expect(body).toContain('role="alert"');
    expect(body).toContain("errors.length > 0");
  });
});

describe("the transcript reaches it, and reaches it first", () => {
  it("branches to the conversation before anything else claims the card", () => {
    // Order is the whole assertion. The hide rule below drops any
    // non-requestId options card once a later user text message exists, and
    // the intake route appends exactly such a message on every turn — so a
    // branch placed after it would delete the question the moment it was
    // answered.
    const options = chat.slice(chat.indexOf('case "options":'), chat.indexOf('case "routine.run":'));
    expect(options).toContain("<IntakeTurn bot={bot} message={m} />");
    expect(options.indexOf("IntakeTurn")).toBeLessThan(options.indexOf("ApprovalCard"));
    expect(options.indexOf("IntakeTurn")).toBeLessThan(options.indexOf("shouldHideOnboardingCard"));
  });

  it("is not claimed by the first-run quiz's own predicate either", () => {
    // Belt and braces: either guard alone is one edit away from the same
    // blank screen.
    expect(optionCard).toContain("if (readIntakeCard(message.card)) return false;");
  });
});

describe("no em dash, no en dash", () => {
  it("holds for every string this file ships", () => {
    for (const literal of turn.match(/"[^"\n]*"/g) ?? []) {
      expect(literal).not.toContain("—");
      expect(literal).not.toContain("–");
    }
  });
});
