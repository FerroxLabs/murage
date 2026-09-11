// The question normalizer is the only place engine-controlled question text
// becomes a card, and the only place an owner's answer becomes an engine
// reply. Both directions are checked here, because a gap in either one is
// how a bot ends up acting on an answer nobody gave.
import { describe, expect, it } from "vitest";

import {
  ELICITATION_URL_OPENED,
  QUESTION_NOTES,
  answersFromMessage,
  codexNoAnswers,
  fromClaude,
  fromCodex,
  fromElicitationForm,
  fromElicitationUrl,
  fromFuigo,
  fromMuragebox,
  fromPi,
  parseAnswers,
  recordableAnswers,
  toClaudeAnswers,
  toCodexAnswers,
  toElicitationContent,
  toFuigoAnswers,
  toMessageText,
  toPiValue,
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

// ── ASK3: the other engines ──────────────────────────────────────────────

describe("fromCodex / toCodexAnswers", () => {
  /** `ToolRequestUserInputParams` as codex-rs v2/item.rs defines it. */
  const params = {
    threadId: "t", turnId: "u", itemId: "call-1", isBlocking: true,
    questions: [
      { id: "db", header: "Database", question: "Which database?", isOther: false, isSecret: false,
        options: [{ label: "Postgres", description: "Relational" }, { label: "Redis", description: "In-memory" }] },
      { id: "token", header: "Token", question: "Paste the deploy token", isOther: false, isSecret: true, options: null },
      { id: "region", header: "Region", question: "Which region?", isOther: true, isSecret: false, options: [{ label: "eu", description: "" }] },
    ],
  };

  it("keeps every question under its own id, with options, headers, isOther and isSecret", () => {
    const result = fromCodex(params);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.questions).toEqual([
      { id: "db", header: "Database", question: "Which database?", options: [{ label: "Postgres", description: "Relational" }, { label: "Redis", description: "In-memory" }], multiSelect: false, allowOther: false },
      { id: "token", header: "Token", question: "Paste the deploy token", options: [], multiSelect: false, allowOther: true, secret: true },
      { id: "region", header: "Region", question: "Which region?", options: [{ label: "eu" }], multiSelect: false, allowOther: true },
    ]);
  });

  it("answers each question under its id, labels first and the owner's words last", () => {
    const questions = (fromCodex(params) as { ok: true; questions: QuestionSpec[] }).questions;
    const checked = validateAnswers(questions, [
      { id: "db", selected: ["Redis"] },
      { id: "token", selected: [], other: "tok_123" },
      { id: "region", selected: ["eu"], other: "" },
    ]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(toCodexAnswers(questions, checked.answers)).toEqual({
      db: { answers: ["Redis"] },
      token: { answers: ["tok_123"] },
      region: { answers: ["eu"] },
    });
  });

  it("gives a no-answer as empty arrays for every question, never a sentence", () => {
    const questions = (fromCodex(params) as { ok: true; questions: QuestionSpec[] }).questions;
    const none = codexNoAnswers(questions);
    expect(none).toEqual({ db: { answers: [] }, token: { answers: [] }, region: { answers: [] } });
    expect(JSON.stringify(none)).not.toMatch(/nobody|judgment|answered/i);
  });

  it("refuses duplicate ids, an empty list, more than four questions and a question without text", () => {
    expect(fromCodex({ questions: [{ id: "a", question: "x", options: [] }, { id: "a", question: "y", options: [] }] })).toMatchObject({ ok: false, error: expect.stringContaining('repeats the id "a"') });
    expect(fromCodex({ questions: [] })).toMatchObject({ ok: false });
    expect(fromCodex({ questions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, question: "x", options: [] })) })).toMatchObject({ ok: false, error: expect.stringContaining("more than 4") });
    expect(fromCodex({ questions: [{ id: "a", question: "", options: [] }] })).toMatchObject({ ok: false, error: expect.stringContaining("no text") });
  });

  it("falls back to positional ids when Codex sends none", () => {
    const result = fromCodex({ questions: [{ question: "Why?", options: null }] });
    expect(result).toMatchObject({ ok: true, questions: [{ id: "q1", allowOther: true }] });
  });
});

describe("fromFuigo / toFuigoAnswers", () => {
  /** `AskUserQuestionExtRequest` as fuigo-tools types.rs serializes it. */
  const ext = {
    sessionId: "sess-1", toolCallId: "tc-1", mode: "default",
    questions: [
      { question: "Which database?", options: [{ label: "Redis", description: "In-memory", preview: "<div/>" }, { label: "Postgres", description: "Relational" }] },
      { question: "Which frameworks?", options: [{ label: "React", description: "" }, { label: "Vue", description: "" }], multiSelect: true },
    ],
  };

  it("maps every question, keeps descriptions and drops previews, and accepts the leader's {method, params} wrapper", () => {
    const direct = fromFuigo(ext);
    const wrapped = fromFuigo({ method: "fuigo/ask_user_question", params: ext });
    expect(direct).toEqual(wrapped);
    expect(direct).toMatchObject({
      ok: true,
      questions: [
        { id: "q1", question: "Which database?", options: [{ label: "Redis", description: "In-memory" }, { label: "Postgres", description: "Relational" }], multiSelect: false, allowOther: true },
        { id: "q2", question: "Which frameworks?", options: [{ label: "React" }, { label: "Vue" }], multiSelect: true, allowOther: true },
      ],
    });
    expect(JSON.stringify(direct)).not.toContain("preview");
  });

  it("answers by question text: labels as a list, free text as Other plus notes", () => {
    const questions = (fromFuigo(ext) as { ok: true; questions: QuestionSpec[] }).questions;
    const checked = validateAnswers(questions, [
      { id: "q1", selected: [], other: "SQLite, it is a demo" },
      { id: "q2", selected: ["React", "Vue"], other: "and Svelte" },
    ]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(toFuigoAnswers(questions, checked.answers)).toEqual({
      outcome: "accepted",
      answers: { "Which database?": ["Other"], "Which frameworks?": ["React", "Vue"] },
      annotations: { "Which database?": { notes: "SQLite, it is a demo" }, "Which frameworks?": { notes: "and Svelte" } },
    });
    const plain = toFuigoAnswers(questions, [{ id: "q1", selected: ["Redis"] }, { id: "q2", selected: ["Vue"] }]);
    expect(plain).toEqual({ outcome: "accepted", answers: { "Which database?": ["Redis"], "Which frameworks?": ["Vue"] } });
  });

  it("refuses duplicate question texts, because Fuigo keys the answers by text", () => {
    expect(fromFuigo({ questions: [{ question: "Same?", options: [] }, { question: "Same?", options: [] }] })).toMatchObject({ ok: false, error: expect.stringContaining("repeats") });
    expect(fromFuigo({ questions: [] })).toMatchObject({ ok: false });
  });
});

describe("fromElicitationForm / toElicitationContent", () => {
  /** An ACP v1 `ElicitationSchema`: every primitive property kind at once. */
  const schema = {
    type: "object",
    properties: {
      environment: { type: "string", title: "Environment", enum: ["staging", "production"] },
      size: { type: "string", title: "Size", oneOf: [{ const: "s", title: "Small", description: "1 vCPU" }, { const: "l", title: "Large" }] },
      features: { type: "array", title: "Features", items: { type: "string", enum: ["cache", "cdn"] } },
      confirm: { type: "boolean", title: "Really?", description: "This cannot be undone" },
    },
    required: ["environment"],
  };

  it("maps enum and oneOf to single-select, array-of-enum to multi-select, boolean to Yes/No", () => {
    const result = fromElicitationForm("Deploy settings", schema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.questions).toEqual([
      { id: "environment", header: "Environment", question: "Deploy settings\nEnvironment", options: [{ label: "staging" }, { label: "production" }], multiSelect: false, allowOther: false },
      { id: "size", header: "Size", question: "Size", options: [{ label: "Small", description: "1 vCPU" }, { label: "Large" }], multiSelect: false, allowOther: false },
      { id: "features", header: "Features", question: "Features", options: [{ label: "cache" }, { label: "cdn" }], multiSelect: true, allowOther: false },
      { id: "confirm", header: "Really?", question: "Really?: This cannot be undone", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: false },
    ]);
  });

  it("types the accepted content: const values, arrays, booleans, numbers, words", () => {
    const questions = (fromElicitationForm("Deploy settings", schema) as { ok: true; questions: QuestionSpec[] }).questions;
    const checked = validateAnswers(questions, [
      { id: "environment", selected: ["production"] },
      { id: "size", selected: ["Small"] },
      { id: "features", selected: ["cdn", "cache"] },
      { id: "confirm", selected: ["No"] },
    ]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(toElicitationContent(schema, questions, checked.answers)).toEqual({ environment: "production", size: "s", features: ["cdn", "cache"], confirm: false });

    const numeric = { type: "object", properties: { count: { type: "integer", title: "How many?" }, note: { type: "string" } } };
    const nq = (fromElicitationForm("", numeric) as { ok: true; questions: QuestionSpec[] }).questions;
    expect(nq).toMatchObject([{ id: "count", question: "How many? (a number)", allowOther: true, options: [] }, { id: "note", question: "note", allowOther: true }]);
    expect(toElicitationContent(numeric, nq, [{ id: "count", selected: [], other: "12.7" }, { id: "note", selected: [], other: "hi" }])).toEqual({ count: 12, note: "hi" });
    // words where a number was asked for go through as words: the agent, not Murage, decides what to do with them
    expect(toElicitationContent(numeric, nq, [{ id: "count", selected: [], other: "a dozen" }, { id: "note", selected: [], other: "x" }])).toEqual({ count: "a dozen", note: "x" });
  });

  it("uses the message as the question for a lone untitled field, and refuses empty or oversized forms", () => {
    expect(fromElicitationForm("What is your name?", { type: "object", properties: { name: { type: "string" } } })).toMatchObject({
      ok: true, questions: [{ id: "name", question: "What is your name?", header: "name", allowOther: true }],
    });
    expect(fromElicitationForm("x", { type: "object", properties: {} })).toMatchObject({ ok: false, error: "the form has no fields" });
    expect(fromElicitationForm("x", { type: "object" })).toMatchObject({ ok: false });
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, { type: "string" }]));
    expect(fromElicitationForm("x", { type: "object", properties: many })).toMatchObject({ ok: false, error: expect.stringContaining("more than 4") });
    expect(fromElicitationForm("x", { type: "object", properties: { e: { type: "string", enum: [] } } })).toMatchObject({ ok: false, error: expect.stringContaining("no choices") });
    expect(fromElicitationForm("x", { type: "object", properties: { o: { type: "object" } } })).toMatchObject({ ok: false, error: expect.stringContaining("unsupported type") });
  });
});

describe("fromElicitationUrl", () => {
  it("shows the link as text with one explicit 'I opened it' option and refuses non-http links", () => {
    expect(fromElicitationUrl("Sign in to continue", "https://example.com/auth?x=1")).toEqual({
      ok: true,
      questions: [{ id: "url", header: "Link", question: "Sign in to continue\nhttps://example.com/auth?x=1", options: [{ label: ELICITATION_URL_OPENED, description: "https://example.com/auth?x=1" }], multiSelect: false, allowOther: false }],
    });
    expect(fromElicitationUrl("x", "javascript:alert(1)")).toMatchObject({ ok: false });
    expect(fromElicitationUrl("x", "file:///etc/passwd")).toMatchObject({ ok: false });
  });
});

describe("fromPi / toPiValue", () => {
  it("maps select to its own options, input and editor to free text, and nothing else", () => {
    expect(fromPi({ method: "select", title: "Which branch?", options: ["main", "develop"] })).toEqual({
      ok: true, questions: [{ id: "q1", question: "Which branch?", options: [{ label: "main" }, { label: "develop" }], multiSelect: false, allowOther: false }],
    });
    expect(fromPi({ method: "input", title: "Name the release", placeholder: "v1.2.3" })).toEqual({
      ok: true, questions: [{ id: "q1", question: "Name the release", header: "v1.2.3", options: [], multiSelect: false, allowOther: true }],
    });
    expect(fromPi({ method: "editor", title: "Edit the notes", prefill: "Line 1\nLine 2" })).toMatchObject({
      ok: true, questions: [{ id: "q1", question: "Edit the notes\nCurrent text:\nLine 1\nLine 2", options: [], allowOther: true }],
    });
    expect(fromPi({ method: "select", title: "Empty", options: [] })).toMatchObject({ ok: false });
    expect(fromPi({ method: "confirm", title: "Clear?" })).toMatchObject({ ok: false });
  });

  it("answers with the picked label or the owner's words", () => {
    const select = (fromPi({ method: "select", title: "Which branch?", options: ["main", "develop"] }) as { ok: true; questions: QuestionSpec[] }).questions;
    expect(toPiValue(select, [{ id: "q1", selected: ["develop"] }])).toBe("develop");
    const input = (fromPi({ method: "input", title: "Name?" }) as { ok: true; questions: QuestionSpec[] }).questions;
    expect(toPiValue(input, [{ id: "q1", selected: [], other: "v2" }])).toBe("v2");
    expect(toPiValue(input, [])).toBe("");
  });
});
