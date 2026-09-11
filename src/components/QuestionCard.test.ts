// The question card, rendered in node the way the rest of the renderer suite
// is (no DOM): the pick/other/keyboard logic as pure functions, and the markup
// contract that the real-browser spec and a screen reader both depend on.
//
// "Don't make me think": one look tells you whether to pick one or several,
// what each option means, and how to answer without reaching for the mouse.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  QuestionCardView,
  draftAnswers,
  draftsComplete,
  initialDrafts,
  questionCardState,
  questionKeyAction,
  setOther,
  toggleOption,
  type Drafts,
} from "./QuestionCard";
import type { QuestionAnswer, QuestionSpec } from "../../shared/questions";
import { folderTrustDecision, folderTrustQuestion } from "../../shared/folder-trust";
import type { OptionCardData } from "@/state/store";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const format: QuestionSpec = {
  id: "q1",
  question: "Which format should the report use?",
  header: "Format",
  options: [
    { label: "Summary", description: "A short overview" },
    { label: "Detailed", description: "Every finding with its evidence" },
  ],
  multiSelect: false,
  allowOther: true,
};
const sections: QuestionSpec = {
  id: "q2",
  question: "Which sections should it include?",
  header: "Sections",
  options: [{ label: "Intro" }, { label: "Findings" }, { label: "Outro" }],
  multiSelect: true,
  allowOther: true,
};

const card = (over: Partial<OptionCardData> = {}): OptionCardData => ({
  title: "Question",
  subtitle: format.question,
  options: ["Summary", "Detailed"],
  requestId: "r1",
  questions: [format, sections],
  ...over,
});

const render = (over: Partial<OptionCardData> = {}, props: Partial<Parameters<typeof QuestionCardView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(QuestionCardView, {
      card: card(over),
      botName: "Sable",
      onSubmit: () => {},
      onSkip: () => {},
      onSendAsMessage: () => {},
      ...props,
    }),
  );

const drafts = (selected: Record<string, string[]>, other: Record<string, string> = {}): Drafts =>
  Object.fromEntries(
    [format, sections].map((question) => [
      question.id,
      { selected: selected[question.id] ?? [], other: other[question.id] ?? "" },
    ]),
  );

describe("picking", () => {
  it("replaces the pick on a single-select and toggles on a multi-select", () => {
    let state = drafts({});
    state = toggleOption(state, format, "Summary");
    expect(state.q1).toEqual({ selected: ["Summary"], other: "" });
    state = toggleOption(state, format, "Detailed");
    expect(state.q1).toEqual({ selected: ["Detailed"], other: "" });

    state = toggleOption(state, sections, "Intro");
    state = toggleOption(state, sections, "Outro");
    expect(state.q2!.selected).toEqual(["Intro", "Outro"]);
    state = toggleOption(state, sections, "Intro");
    expect(state.q2!.selected).toEqual(["Outro"]);
  });

  it("lets 'Other' replace a single-select pick, and sit beside multi-select picks", () => {
    let state = toggleOption(drafts({}), format, "Summary");
    state = setOther(state, format, "something else entirely");
    expect(state.q1).toEqual({ selected: [], other: "something else entirely" });
    // clearing the text gives the options back without picking one
    state = setOther(state, format, "");
    expect(state.q1).toEqual({ selected: [], other: "" });

    let multi = toggleOption(drafts({}), sections, "Intro");
    multi = setOther(multi, sections, "and an appendix");
    expect(multi.q2).toEqual({ selected: ["Intro"], other: "and an appendix" });
  });

  it("knows when every question has enough of an answer to send", () => {
    const questions = [format, sections];
    expect(draftsComplete(questions, drafts({}))).toBe(false);
    expect(draftsComplete(questions, drafts({ q1: ["Summary"] }))).toBe(false);
    expect(draftsComplete(questions, drafts({ q1: ["Summary"], q2: ["Intro"] }))).toBe(true);
    // whitespace alone is not an answer
    expect(draftsComplete(questions, drafts({ q2: ["Intro"] }, { q1: "   " }))).toBe(false);
    expect(draftsComplete(questions, drafts({ q2: ["Intro"] }, { q1: "my own words" }))).toBe(true);
  });

  it("trims free text and drops it for a question that does not allow it", () => {
    expect(draftAnswers([format, sections], drafts({ q2: ["Intro"] }, { q1: "  mine  " }))).toEqual([
      { id: "q1", selected: [], other: "mine" },
      { id: "q2", selected: ["Intro"] },
    ]);
    const strict: QuestionSpec = { ...format, allowOther: false };
    expect(draftAnswers([strict], drafts({ q1: ["Summary"] }, { q1: "sneaky" }))).toEqual([{ id: "q1", selected: ["Summary"] }]);
  });

  it("seeds the inputs from an answer already given, so an answered card shows it", () => {
    const answers: QuestionAnswer[] = [
      { id: "q1", selected: [], other: "mine" },
      { id: "q2", selected: ["Intro", "Outro"] },
    ];
    expect(initialDrafts([format, sections], answers)).toEqual({
      q1: { selected: [], other: "mine" },
      q2: { selected: ["Intro", "Outro"], other: "" },
    });
    expect(initialDrafts([format], undefined)).toEqual({ q1: { selected: [], other: "" } });
  });
});

describe("the keyboard", () => {
  it("picks with 1-9, sends with Enter and starts a skip with Esc", () => {
    expect(questionKeyAction("1", 3, false)).toEqual({ type: "toggle", index: 0 });
    expect(questionKeyAction("3", 3, false)).toEqual({ type: "toggle", index: 2 });
    expect(questionKeyAction("Enter", 3, false)).toEqual({ type: "submit" });
    expect(questionKeyAction("Escape", 3, false)).toEqual({ type: "skip" });
  });

  it("ignores a digit past the last option, and every digit while typing an answer", () => {
    expect(questionKeyAction("4", 3, false)).toBeNull();
    expect(questionKeyAction("0", 3, false)).toBeNull();
    expect(questionKeyAction("1", 3, true)).toBeNull();
    expect(questionKeyAction("a", 3, false)).toBeNull();
    // Enter and Esc still work from inside the text field
    expect(questionKeyAction("Enter", 3, true)).toEqual({ type: "submit" });
    expect(questionKeyAction("Escape", 3, true)).toEqual({ type: "skip" });
  });
});

describe("where the card stands", () => {
  it("reads its state from the persisted card alone", () => {
    expect(questionCardState(card())).toBe("open");
    expect(questionCardState(card({ answered: "answer" }))).toBe("answered");
    expect(questionCardState(card({ answered: "skipped" }))).toBe("skipped");
    // an older client's deny is the same thing as a skip
    expect(questionCardState(card({ answered: "deny" }))).toBe("skipped");
    expect(questionCardState(card({ answered: "expired", expired: true }))).toBe("expired");
    expect(questionCardState(card({ expired: true }))).toBe("expired");
    expect(questionCardState(card({ answered: "unavailable" }))).toBe("closed");
    // "sent as a message" outranks expired: that answer did reach the bot
    expect(questionCardState(card({ expired: true, sentAsMessage: true }))).toBe("sent");
  });
});

describe("the markup", () => {
  it("shows one row per option with its own description, and the header as a chip", () => {
    const markup = render();
    expect(markup).toContain("Format");
    expect(markup).toContain("Sections");
    expect(markup).toContain("Which format should the report use?");
    expect(markup).toContain("A short overview");
    expect(markup).toContain("Every finding with its evidence");
    expect(markup).toContain("Sable asks");
  });

  it("says which kind of pick each question takes, in words and in roles", () => {
    const markup = render();
    expect(markup).toContain("Choose one");
    expect(markup).toContain("Choose any that apply");
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('role="radio"');
    expect(markup).toContain('role="checkbox"');
    // every option row states whether it is chosen, for a screen reader
    expect(markup.match(/aria-checked="false"/g)?.length).toBe(5);
    // each group names its own question
    expect(markup).toContain("aria-labelledby=");
  });

  it("offers 'Other' with a real input, and numbers the options you can type", () => {
    const markup = render();
    expect(markup).toContain("Other");
    expect(markup).toContain("Type your own answer");
    expect(markup).toContain('type="text"');
    expect(markup).toContain("1–9 to pick");
    for (const digit of ["1", "2", "3"]) expect(markup).toContain(`>${digit}</kbd>`);
  });

  it("hides a secret answer as it is typed", () => {
    const secret: QuestionSpec = { id: "q1", question: "Paste the token", options: [], multiSelect: false, allowOther: true, secret: true };
    const markup = render({ questions: [secret], subtitle: secret.question });
    expect(markup).toContain('type="password"');
    expect(markup).not.toContain('type="text"');
  });

  /** Is the button whose label starts with `label` really disabled? (The
   * `disabled:` Tailwind prefixes in its class list are not the attribute.) */
  const buttonDisabled = (markup: string, label: string): boolean => {
    const end = markup.indexOf(`>${label}`);
    expect(end, `no "${label}" button in the markup`).toBeGreaterThan(-1);
    const tag = markup.slice(markup.lastIndexOf("<button", end), end + 1);
    return /\sdisabled(=|\s|>)/.test(tag);
  };

  it("cannot be sent until every question has an answer", () => {
    // half an answer is not an answer: q2 is still untouched
    expect(buttonDisabled(render({ answers: [{ id: "q1", selected: ["Summary"] }] }), "Send answer")).toBe(true);

    const both = [{ id: "q1", selected: ["Summary"] }, { id: "q2", selected: ["Intro"] }];
    expect(buttonDisabled(render({ answers: both }), "Send answer")).toBe(false);
    // busy disables it again, so one answer cannot be sent twice
    expect(buttonDisabled(render({ answers: both }, { busy: true }), "Sending…")).toBe(true);
  });

  it("keeps an expired question visible, with a way to get the answer there anyway", () => {
    const markup = render({ answered: "expired", expired: true });
    expect(markup).toContain('data-question-state="expired"');
    expect(markup).toContain("Expired");
    expect(markup).toContain("Sable stopped waiting for an answer");
    expect(markup).toContain("Send as a message");
    // an expired card is still editable, so a half-typed answer is not lost
    expect(markup).toContain('role="radio"');
    expect(markup).toContain("Type your own answer");
    // and it no longer offers to skip something nobody is waiting on
    expect(markup).not.toContain("Skip question");
  });

  it("never offers to post a secret answer into the conversation", () => {
    const secret: QuestionSpec = { id: "q1", question: "Paste the token", options: [], multiSelect: false, allowOther: true, secret: true };
    const markup = render({ questions: [secret], subtitle: secret.question, answered: "expired", expired: true });
    expect(markup).not.toContain("Send as a message");
    expect(markup).toContain("This answer is private");
  });

  it("shows a settled question read-only, with what was chosen", () => {
    const answers: QuestionAnswer[] = [
      { id: "q1", selected: ["Detailed"] },
      { id: "q2", selected: ["Intro", "Outro"] },
    ];
    const answered = render({ answered: "answer", answers });
    expect(answered).toContain('data-question-state="answered"');
    expect(answered).toContain("Answered");
    expect(answered).toContain('aria-checked="true"');
    expect(answered.match(/aria-checked="true"/g)?.length).toBe(3);
    expect(answered).not.toContain("Send answer");
    expect(answered).not.toContain("Skip question");

    const skipped = render({ answered: "skipped" });
    expect(skipped).toContain('data-question-state="skipped"');
    expect(skipped).toContain("You skipped this question.");

    const sent = render({ expired: true, sentAsMessage: true, answers });
    expect(sent).toContain('data-question-state="sent"');
    expect(sent).toContain("Sent as a message");
  });

  it("says what is happening while an answer is in flight, and shows what went wrong", () => {
    expect(render({}, { busy: true })).toContain("Sending…");
    expect(render({}, { error: "That option is no longer offered." })).toContain('role="alert"');
    expect(render({}, { error: "That option is no longer offered." })).toContain("That option is no longer offered.");
  });

  it("renders an older card that has no structured questions at all", () => {
    // a card persisted before 0.1.52: one question built from the subtitle
    const markup = render({ questions: undefined, subtitle: "Ship it?", options: ["Yes", "Not yet"] });
    expect(markup).toContain("Ship it?");
    expect(markup).toContain("Yes");
    expect(markup).toContain("Not yet");
    expect(markup).toContain("Choose one");
    expect(markup).toContain("Type your own answer");
  });
});

// The folder-trust card (0.1.52 FUIGOTRUST1): the same card, one question
// that is a decision about a folder. What it must say and must not offer.
describe("the folder-trust card", () => {
  const buttonDisabled = (markup: string, label: string): boolean => {
    const end = markup.indexOf(`>${label}`);
    expect(end, `no "${label}" button in the markup`).toBeGreaterThan(-1);
    const tag = markup.slice(markup.lastIndexOf("<button", end), end + 1);
    return /\sdisabled(=|\s|>)/.test(tag);
  };
  const trustCard = (over: Partial<OptionCardData> = {}): Partial<OptionCardData> => ({
    title: "Trust this folder?",
    subtitle: folderTrustQuestion({ key: "/repo", folder: "/repo/app", sources: ["AGENTS.md", ".mcp.json"] }).question,
    options: ["Trust this folder", "Don't trust"],
    requestId: "trust-1",
    questions: [folderTrustQuestion({ key: "/repo", folder: "/repo/app", sources: ["AGENTS.md", ".mcp.json"] })],
    folderTrust: { key: "/repo", folder: "/repo/app", sources: ["AGENTS.md", ".mcp.json"] },
    ...over,
  });

  it("names the folder and what it would contribute, offers exactly Trust / Don't trust, and no free text", () => {
    const markup = render(trustCard());
    expect(markup).toContain("Sable needs a decision");
    expect(markup).toContain("Folder trust");
    expect(markup).toContain("/repo/app");
    expect(markup).toContain("AGENTS.md, .mcp.json");
    expect(markup).toContain("Trust this folder");
    expect(markup).toContain("Don&#x27;t trust");
    expect(markup).toContain("Apply them, and remember this for the folder.");
    expect(markup).toContain('role="radio"');
    // a decision, not conversation: no "Other" field
    expect(markup).not.toContain("Type your own answer");
    expect(markup).toContain("Choose one");
    expect(buttonDisabled(render(trustCard()), "Send answer")).toBe(true);
  });

  it("submits the pick as the folder-trust answer the server records", () => {
    const question = folderTrustQuestion({ key: "/repo", folder: "/repo", sources: ["AGENTS.md"] });
    let picked = toggleOption({}, question, "Trust this folder");
    expect(draftsComplete([question], picked)).toBe(true);
    expect(draftAnswers([question], picked)).toEqual([{ id: "folderTrust", selected: ["Trust this folder"] }]);
    expect(folderTrustDecision(draftAnswers([question], picked))).toBe("trust");
    picked = toggleOption(picked, question, "Don't trust");
    expect(folderTrustDecision(draftAnswers([question], picked))).toBe("reject");
    expect(buttonDisabled(render(trustCard({ answers: draftAnswers([question], picked) })), "Send answer")).toBe(false);
  });

  it("an expired trust card is read-only and says the turn was stopped — never 'Send as a message'", () => {
    const markup = render(trustCard({ answered: "expired", expired: true }));
    expect(markup).toContain('data-question-state="expired"');
    expect(markup).toContain("Nobody decided in time, so this turn was stopped. Send the message again to be asked.");
    expect(markup).not.toContain("Send as a message");
    expect(markup).not.toContain("Sable stopped waiting");
    // the radios are shown for the record but disabled
    expect(markup).toMatch(/role="radio"[^>]*disabled=""/);
  });

  it("a late trust card closed by the turn itself says the turn ran untrusted — finished, stopped or timed out — never 'stopped because nobody decided'", () => {
    const finished = render(trustCard({ answered: "expired", expired: true, folderTrust: { key: "/repo", folder: "/repo", sources: ["AGENTS.md / CLAUDE.md"], late: "finished" } }));
    expect(finished).toContain("The turn finished before anyone answered, so it ran without this folder&#x27;s files.");
    expect(finished).not.toContain("so this turn was stopped");
    expect(finished).not.toContain("Send as a message");
    const stopped = render(trustCard({ answered: "expired", expired: true, folderTrust: { key: "/repo", folder: "/repo", sources: ["AGENTS.md"], late: "stopped" } }));
    expect(stopped).toContain("The turn was stopped before anyone answered; it had been running without this folder&#x27;s files.");
    const timeout = render(trustCard({ answered: "expired", expired: true, folderTrust: { key: "/repo", folder: "/repo", sources: ["AGENTS.md"], late: "timeout" } }));
    expect(timeout).toContain("Nobody answered while the turn was running, so it ran without this folder&#x27;s files.");
  });

  it("shows the decision read-only once made", () => {
    const answered = render(trustCard({ answered: "answer", answers: [{ id: "folderTrust", selected: ["Don't trust"] }] }));
    expect(answered).toContain('data-question-state="answered"');
    expect(answered).toContain("Answered");
    expect(answered).toMatch(/aria-checked="true"[^>]*>(?:(?!<\/button>).)*Don&#x27;t trust/s);
  });
});

describe("where it is rendered", () => {
  const chat = read("./ChatView.tsx");
  const group = read("./GroupView.tsx");

  it("takes the question before the approval box does, in both transcripts", () => {
    for (const [name, source] of [["ChatView", chat], ["GroupView", group]] as const) {
      expect(source, name).toContain("QuestionCard");
      expect(source, name).toContain("isQuestionCard");
      // a question must be matched first: the approval branch answers
      // permissions, and would offer Allow/Deny over a question
      expect(source.indexOf("isQuestionCard(m.card)"), name).toBeLessThan(source.indexOf("<ApprovalCard"));
    }
  });

  it("answers by thread, so a question raised in a room is answerable there", () => {
    expect(group).toContain("threadId={group.threadId}");
    expect(group).toContain("groupId={group.id}");
  });
});
