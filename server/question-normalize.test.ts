// The question normalizer is the only place engine-controlled question text
// becomes a card, and the only place an owner's answer becomes an engine
// reply. Both directions are checked here, because a gap in either one is
// how a bot ends up acting on an answer nobody gave.
import { describe, expect, it } from "vitest";

import {
  QUESTION_NOTES,
  answersFromMessage,
  fromClaude,
  fromMuragebox,
  parseAnswers,
  recordableAnswers,
  toClaudeAnswers,
  toMessageText,
  validateAnswers,
} from "./question-normalize.ts";
import {
  QUESTION_LIMITS,
  answerComplete,
  answersAsMessage,
  isQuestionCard,
  questionFromChoices,
  questionsForCard,
  type QuestionSpec,
} from "../shared/questions.ts";

/** The shape Claude Code 2.1.268 hands the permission prompt tool. */
const claudeInput = {
  questions: [
    {
      question: "Which format should the report use?",
      header: "Format",
      options: [
        { label: "Summary", description: "A short overview" },
        { label: "Detailed", description: "Every finding with its evidence" },
      ],
      multiSelect: false,
    },
    {
      question: "Which sections should it include?",
      header: "Sections",
      options: [{ label: "Intro" }, { label: "Findings" }, { label: "Outro" }],
      multiSelect: true,
    },
  ],
};

const ok = (result: ReturnType<typeof fromClaude>): QuestionSpec[] => {
  if (!result.ok) throw new Error(`expected questions, got: ${result.error}`);
  return result.questions;
};

describe("fromClaude", () => {
  it("keeps every question, header, option description and multiSelect flag", () => {
    const questions = ok(fromClaude(claudeInput));
    expect(questions).toEqual([
      {
        id: "q1",
        question: "Which format should the report use?",
        header: "Format",
        options: [
          { label: "Summary", description: "A short overview" },
          { label: "Detailed", description: "Every finding with its evidence" },
        ],
        multiSelect: false,
        allowOther: true,
      },
      {
        id: "q2",
        question: "Which sections should it include?",
        header: "Sections",
        options: [{ label: "Intro" }, { label: "Findings" }, { label: "Outro" }],
        multiSelect: true,
        allowOther: true,
      },
    ]);
  });

  it("refuses duplicate question texts, because Claude keys the answers by text", () => {
    const twice = { questions: [claudeInput.questions[0], { ...claudeInput.questions[0] }] };
    expect(fromClaude(twice)).toEqual({ ok: false, error: "question 2 repeats an earlier question's text" });
  });

  it("refuses more than four questions, an empty list, and a question with no text", () => {
    const one = claudeInput.questions[0]!;
    const many = { questions: [1, 2, 3, 4, 5].map((n) => ({ ...one, question: `Question ${n}?` })) };
    expect(fromClaude(many)).toEqual({ ok: false, error: `more than ${QUESTION_LIMITS.questions} questions at once` });
    expect(fromClaude({ questions: [] }).ok).toBe(false);
    expect(fromClaude({}).ok).toBe(false);
    expect(fromClaude({ questions: [{ options: [{ label: "Yes" }] }] })).toEqual({ ok: false, error: "question 1 has no text" });
  });

  it("refuses an option with no label, a repeated label, and more than ten options", () => {
    const base = { question: "Pick?", options: [{ label: "A" }] };
    expect(fromClaude({ questions: [{ ...base, options: [{ description: "no label" }] }] })).toEqual({
      ok: false,
      error: "question 1 option 1 has no label",
    });
    expect(fromClaude({ questions: [{ ...base, options: [{ label: "A" }, { label: "A" }] }] })).toEqual({
      ok: false,
      error: 'question 1 repeats the option "A"',
    });
    const eleven = Array.from({ length: 11 }, (_, index) => ({ label: `Option ${index}` }));
    expect(fromClaude({ questions: [{ ...base, options: eleven }] }).ok).toBe(false);
  });

  it("strips control characters and clamps long text, so a card can never be a canvas", () => {
    const questions = ok(
      fromClaude({
        questions: [
          {
            question: `Spoof\u0000ed\u001b[2J${"x".repeat(5_000)}`,
            header: "H".repeat(200),
            options: [{ label: `L\u0007abel${"y".repeat(500)}`, description: `d\u001besc${"z".repeat(4_000)}` }],
          },
        ],
      }),
    );
    const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
    expect(questions[0]!.question).not.toMatch(control);
    expect(questions[0]!.question.startsWith("Spoofed[2J")).toBe(true);
    expect(questions[0]!.question.length).toBe(QUESTION_LIMITS.questionChars);
    expect(questions[0]!.header!.length).toBe(QUESTION_LIMITS.headerChars);
    expect(questions[0]!.options[0]!.label).not.toMatch(control);
    expect(questions[0]!.options[0]!.label.startsWith("Label")).toBe(true);
    expect(questions[0]!.options[0]!.label.length).toBe(QUESTION_LIMITS.labelChars);
    expect(questions[0]!.options[0]!.description).not.toMatch(control);
    expect(questions[0]!.options[0]!.description!.length).toBe(QUESTION_LIMITS.descriptionChars);
  });

  it("accepts a question with no options at all — Claude's 'Other' is always implicit", () => {
    const questions = ok(fromClaude({ questions: [{ question: "What should I call it?", options: [] }] }));
    expect(questions[0]).toMatchObject({ options: [], allowOther: true, multiSelect: false });
  });
});

describe("fromMuragebox", () => {
  it("becomes one free-text question with its one-tap choices", () => {
    const questions = ok(fromMuragebox({ question: "Ship it?", choices: ["Yes", "Not yet"] }));
    expect(questions).toEqual([
      { id: "q1", question: "Ship it?", options: [{ label: "Yes" }, { label: "Not yet" }], multiSelect: false, allowOther: true },
    ]);
  });

  it("drops blank and repeated choices and refuses a question with no text", () => {
    const questions = ok(fromMuragebox({ question: "Ship it?", choices: ["Yes", "Yes", "  ", 7, "No"] }));
    expect(questions[0]!.options).toEqual([{ label: "Yes" }, { label: "No" }]);
    expect(fromMuragebox({ choices: ["Yes"] }).ok).toBe(false);
  });
});

describe("validateAnswers", () => {
  const questions = ok(fromClaude(claudeInput));

  it("accepts one label for a single-select and several for a multi-select", () => {
    const checked = validateAnswers(questions, [
      { id: "q1", selected: ["Summary"] },
      { id: "q2", selected: ["Intro", "Outro"] },
    ]);
    expect(checked).toEqual({
      ok: true,
      answers: [
        { id: "q1", selected: ["Summary"] },
        { id: "q2", selected: ["Intro", "Outro"] },
      ],
    });
  });

  it("refuses a label that was never offered", () => {
    const checked = validateAnswers(questions, [
      { id: "q1", selected: ["Exhaustive"] },
      { id: "q2", selected: ["Intro"] },
    ]);
    expect(checked).toEqual({ ok: false, error: '"Exhaustive" is not an option of question q1' });
  });

  it("refuses two picks on a single-select, and a pick plus free text on one", () => {
    expect(validateAnswers(questions, [{ id: "q1", selected: ["Summary", "Detailed"] }, { id: "q2", selected: ["Intro"] }])).toEqual({
      ok: false,
      error: "question q1 takes one answer",
    });
    expect(
      validateAnswers(questions, [{ id: "q1", selected: ["Summary"], other: "or neither" }, { id: "q2", selected: ["Intro"] }]),
    ).toEqual({ ok: false, error: "question q1 takes one answer" });
  });

  it("refuses free text on a question that does not allow it", () => {
    const strict: QuestionSpec[] = [{ id: "q1", question: "Pick?", options: [{ label: "A" }], multiSelect: false, allowOther: false }];
    expect(validateAnswers(strict, [{ id: "q1", selected: [], other: "something else" }])).toEqual({
      ok: false,
      error: "question q1 takes only its options",
    });
  });

  it("refuses an unanswered question, an unknown id, a repeated id, and an empty answer", () => {
    expect(validateAnswers(questions, [{ id: "q1", selected: ["Summary"] }])).toEqual({ ok: false, error: "question q2 has no answer" });
    expect(validateAnswers(questions, [{ id: "q9", selected: ["Summary"] }])).toEqual({ ok: false, error: "no question q9 was asked" });
    expect(
      validateAnswers(questions, [
        { id: "q1", selected: ["Summary"] },
        { id: "q1", selected: ["Detailed"] },
      ]),
    ).toEqual({ ok: false, error: "question q1 was answered twice" });
    expect(validateAnswers(questions, [{ id: "q1", selected: [], other: "   " }, { id: "q2", selected: ["Intro"] }])).toEqual({
      ok: false,
      error: "question q1 has no answer",
    });
  });

  it("refuses free text longer than the cap and normalizes duplicate picks and whitespace", () => {
    expect(
      validateAnswers(questions, [
        { id: "q1", selected: [], other: "x".repeat(QUESTION_LIMITS.otherChars + 1) },
        { id: "q2", selected: ["Intro"] },
      ]).ok,
    ).toBe(false);
    expect(
      validateAnswers(questions, [
        { id: "q1", selected: [], other: "  my own words  " },
        { id: "q2", selected: ["Intro", "Intro"] },
      ]),
    ).toEqual({ ok: true, answers: [{ id: "q1", selected: [], other: "my own words" }, { id: "q2", selected: ["Intro"] }] });
  });

  it("returns the answers in question order, whatever order the client sent", () => {
    const checked = validateAnswers(questions, [
      { id: "q2", selected: ["Findings"] },
      { id: "q1", selected: ["Detailed"] },
    ]);
    expect(checked.ok && checked.answers.map((answer) => answer.id)).toEqual(["q1", "q2"]);
  });
});

describe("parseAnswers", () => {
  it("refuses anything that is not a list of {id, selected}", () => {
    expect(parseAnswers("Summary").ok).toBe(false);
    expect(parseAnswers([{ selected: ["Summary"] }]).ok).toBe(false);
    expect(parseAnswers([{ id: "q1", selected: "Summary" }]).ok).toBe(false);
    expect(parseAnswers([{ id: "q1", selected: [1] }]).ok).toBe(false);
    expect(parseAnswers([{ id: "q1", selected: [], other: 7 }]).ok).toBe(false);
    expect(parseAnswers([{ id: "q1", selected: [], other: "x".repeat(QUESTION_LIMITS.otherChars + 1) }]).ok).toBe(false);
    expect(parseAnswers(Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, selected: [] }))).ok).toBe(false);
  });

  it("accepts a well-formed list and keeps `other` only when it is a string", () => {
    expect(parseAnswers([{ id: "q1", selected: ["Summary"] }, { id: "q2", selected: [], other: "mine" }])).toEqual({
      ok: true,
      answers: [{ id: "q1", selected: ["Summary"] }, { id: "q2", selected: [], other: "mine" }],
    });
  });
});

describe("toClaudeAnswers", () => {
  const questions = ok(fromClaude(claudeInput));

  // The keys are the question TEXT and the values are labels, an array for a
  // multi-select, or the owner's own words — the shape Claude Code reads back
  // out of updatedInput.answers (agent-sdk/user-input, "Response format").
  it("keys answers by question text, with an array only for a multi-select", () => {
    expect(
      toClaudeAnswers(questions, [
        { id: "q1", selected: ["Detailed"] },
        { id: "q2", selected: ["Intro", "Outro"] },
      ]),
    ).toEqual({
      "Which format should the report use?": "Detailed",
      "Which sections should it include?": ["Intro", "Outro"],
    });
  });

  it("sends free text as the answer, alone on a single-select and alongside picks on a multi-select", () => {
    expect(
      toClaudeAnswers(questions, [
        { id: "q1", selected: [], other: "Whatever is shortest" },
        { id: "q2", selected: ["Findings"], other: "and an appendix" },
      ]),
    ).toEqual({
      "Which format should the report use?": "Whatever is shortest",
      "Which sections should it include?": ["Findings", "and an appendix"],
    });
  });
});

describe("toMessageText and answersAsMessage", () => {
  const questions = ok(fromClaude(claudeInput));

  it("writes one question's answer as bare words and several as labelled lines", () => {
    const single = ok(fromMuragebox({ question: "Ship it?", choices: ["Yes", "No"] }));
    expect(toMessageText(single, [{ id: "q1", selected: ["Yes"] }])).toBe("Yes");
    expect(
      toMessageText(questions, [
        { id: "q1", selected: ["Summary"] },
        { id: "q2", selected: ["Intro", "Outro"] },
      ]),
    ).toBe("Which format should the report use?: Summary\nWhich sections should it include?: Intro, Outro");
  });

  it("writes a late answer as a Q/A message a bot can read", () => {
    expect(
      answersAsMessage(questions, [
        { id: "q1", selected: ["Detailed"] },
        { id: "q2", selected: ["Findings"], other: "plus an appendix" },
      ]),
    ).toBe(
      "Q: Which format should the report use?\nA: Detailed\n" +
        "Q: Which sections should it include?\nA: Findings; plus an appendix",
    );
  });
});

describe("answersFromMessage", () => {
  const single = ok(fromMuragebox({ question: "Ship it?", choices: ["Yes", "No"] }));

  it("reads an exact label as a pick and anything else as the owner's own words", () => {
    expect(answersFromMessage(single, "Yes")).toEqual([{ id: "q1", selected: ["Yes"] }]);
    expect(answersFromMessage(single, "  not until Friday ")).toEqual([{ id: "q1", selected: [], other: "not until Friday" }]);
  });

  it("refuses to spread one string across several questions, or to answer nothing", () => {
    expect(answersFromMessage(ok(fromClaude(claudeInput)), "Summary")).toBeNull();
    expect(answersFromMessage(single, "   ")).toBeNull();
    expect(answersFromMessage(single, 7)).toBeNull();
  });
});

describe("recordableAnswers", () => {
  it("drops a secret question's answer, so it never reaches the transcript or the log", () => {
    const questions: QuestionSpec[] = [
      { id: "q1", question: "Which key?", options: [{ label: "Live" }], multiSelect: false, allowOther: false },
      { id: "q2", question: "Paste the token", options: [], multiSelect: false, allowOther: true, secret: true },
    ];
    expect(recordableAnswers(questions, [{ id: "q1", selected: ["Live"] }, { id: "q2", selected: [], other: "sk-live-123" }])).toEqual([
      { id: "q1", selected: ["Live"] },
    ]);
  });
});

describe("card helpers", () => {
  it("tells a question card apart from a permission and from a harness proposal", () => {
    expect(isQuestionCard({ subtitle: "Ship it?", options: [], requestId: "r1" })).toBe(true);
    expect(isQuestionCard({ subtitle: "q", options: [], requestId: "r1", questions: [] , tool: "Bash" })).toBe(false);
    expect(isQuestionCard({ subtitle: "run git", options: [], requestId: "r1", tool: "Bash" })).toBe(false);
    expect(isQuestionCard({ subtitle: "every day", options: [], requestId: "r1", routineRequest: {} })).toBe(false);
    expect(isQuestionCard({ subtitle: "learn this", options: [], requestId: "r1", skillRequest: {} })).toBe(false);
    expect(isQuestionCard({ subtitle: "welcome", options: [], requestId: "r1", intake: {} })).toBe(false);
    expect(isQuestionCard({ subtitle: "no request", options: [] })).toBe(false);
    expect(isQuestionCard(undefined)).toBe(false);
  });

  it("synthesizes one question for a card persisted before 0.1.52", () => {
    const questions = questionsForCard({ subtitle: "Ship it?", options: ["Yes", "No"], requestId: "r1" });
    expect(questions).toEqual([
      { id: "q1", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: true },
    ]);
    expect(questionsForCard({ subtitle: "x", options: [], requestId: "r1", tool: "Bash" })).toEqual([]);
  });

  it("falls back to a readable question when an old card has no subtitle", () => {
    expect(questionFromChoices("", []).question).toBe("Your bot has a question");
  });

  it("knows when one question has enough of an answer to send", () => {
    const [single] = questionsForCard({ subtitle: "Ship it?", options: ["Yes", "No"], requestId: "r1" });
    const multi: QuestionSpec = { ...single!, multiSelect: true };
    expect(answerComplete(single!, undefined)).toBe(false);
    expect(answerComplete(single!, { id: "q1", selected: [] })).toBe(false);
    expect(answerComplete(single!, { id: "q1", selected: ["Yes"] })).toBe(true);
    expect(answerComplete(single!, { id: "q1", selected: ["Yes"], other: "maybe" })).toBe(false);
    expect(answerComplete(multi, { id: "q1", selected: ["Yes", "No"] })).toBe(true);
  });
});

describe("QUESTION_NOTES", () => {
  // Every non-answer says plainly that nobody answered. Before 0.1.52 a
  // timeout sent "Use your best judgment", which the model read as the
  // owner's own instruction.
  it("never presents a non-answer as the owner's answer", () => {
    for (const note of [QUESTION_NOTES.skipped, QUESTION_NOTES.timeout(30), QUESTION_NOTES.unshowable("the question list is empty")]) {
      expect(note).toMatch(/did not answer|skipped|could not show/i);
      expect(note).not.toMatch(/best judgment/i);
    }
    expect(QUESTION_NOTES.timeout(30)).toContain("30 min");
  });
});
