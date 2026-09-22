// A waiting request in the Inbox says what the bot asked, and can be
// answered without walking to the conversation.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { OptionCardData } from "@/state/store";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { InboxRequestAnswer, inlineAnswerKind, requestHeadline, requestOpen } = await import("./InboxRequest");
const { Inbox, botNameFromSource, INBOX_VIEWS } = await import("./Inbox");

const question: OptionCardData = {
  title: "Question needs an answer",
  subtitle: "Which email account should I use?",
  options: ["Work", "Personal"],
  requestId: "ask-1",
  questions: [{ id: "q1", question: "Which email account should I use?", options: [{ label: "Work" }, { label: "Personal" }], multiSelect: false, allowOther: true }],
};
const approval: OptionCardData = { title: "Run a shell command", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "tool-1", tool: "Bash" };

describe("what a waiting request says", () => {
  it("heads the card with the bot's question, not with a category", () => {
    expect(requestHeadline(question)).toBe("Which email account should I use?");
    expect(requestHeadline(undefined)).toBe("");
  });

  it("never lifts a permission card's title or command out of the conversation", () => {
    expect(requestHeadline(approval)).toBe("");
  });

  it("reads a settled request as settled", () => {
    expect(requestOpen(question)).toBe(true);
    expect(requestOpen({ ...question, answered: "Work" })).toBe(false);
    expect(requestOpen({ ...question, dismissed: true })).toBe(false);
    expect(requestOpen({ ...question, expired: true })).toBe(false);
    expect(requestOpen({ title: "", subtitle: "", options: [] })).toBe(false);
  });

  it("names the bot from the thread label the projection already carries", () => {
    expect(botNameFromSource("Ember · Weekly report")).toBe("Ember");
    expect(botNameFromSource("Ember")).toBe("Ember");
  });
});

describe("what can be settled from the Inbox", () => {
  it("answers questions and plain approvals here", () => {
    expect(inlineAnswerKind(question)).toBe("question");
    expect(inlineAnswerKind(approval)).toBe("approval");
  });

  it("sends proposals and folder decisions to their own review surface", () => {
    expect(inlineAnswerKind({ ...approval, routineRequest: { } as never })).toBeNull();
    expect(inlineAnswerKind({ ...approval, skillRequest: { } as never })).toBeNull();
    expect(inlineAnswerKind({ ...question, folderTrust: { key: "k", folder: "/tmp", sources: [] } })).toBeNull();
    expect(inlineAnswerKind({ ...question, intake: {} as never })).toBeNull();
    expect(inlineAnswerKind({ ...question, answered: "Work" })).toBeNull();
  });
});

describe("answering in place", () => {
  const render = (card: OptionCardData) =>
    renderToStaticMarkup(createElement(InboxRequestAnswer, { threadId: "t1", card, botName: "Ember", onSettled: () => {} }));

  it("draws the real question card, with its options and a send button", () => {
    const markup = render(question);
    expect(markup).toContain("Which email account should I use?");
    expect(markup).toContain("Work");
    expect(markup).toContain("Personal");
    expect(markup).toContain('data-question-state="open"');
  });

  it("offers allow and deny for a tool approval, and leaves the command in the conversation", () => {
    const markup = render(approval);
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Deny");
    expect(markup).toContain("Open the request to see exactly what Ember would run.");
    expect(markup).not.toContain("rm -rf build");
  });

  it("stays out of the way of a request it must not settle", () => {
    expect(render({ ...approval, skillRequest: {} as never })).toBe("");
  });
});

describe("the Inbox's own view tabs", () => {
  const markup = () =>
    renderToStaticMarkup(createElement(Inbox, { onOpen: () => {}, initialView: "decisions" as const }));

  it("fills the selected tab so it cannot be mistaken for the others", () => {
    const html = markup();
    // One filled chip and the rest plain. COUNTED FROM `INBOX_VIEWS`, not
    // pinned to a number: this assertion said "three" and went red when the
    // list grew to seven, which taught nothing except that the list had
    // grown.
    expect(html.match(/text-accent-ink/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(INBOX_VIEWS.length - 1);
    // the filled chip is the selected one, not some other control
    const selected = html.match(/<button[^>]*aria-pressed="true"[^>]*>/)![0];
    expect(selected).toMatch(/\bbg-accent\b/);
    // …and it carries exactly one background. `bg-control bg-accent` leaves
    // the winner to stylesheet order, which painted white ink on light grey.
    expect(selected).not.toMatch(/\bbg-control\b/);
    expect(html.match(/<button[^>]*aria-pressed="false"[^>]*>/)![0]).toMatch(/\bbg-control\b/);
    // the old selected style was a tint on a grey control — invisible
    expect(html).not.toContain("bg-accent/10");
  });
});

// THE SAME MISTAKE, TWICE, A FILE APART.
//
// The tab test above already records it: `bg-control bg-accent` leaves the
// winner to stylesheet order. That was found and fixed for the TABS, and the
// identical composition sat untouched in this file's approval buttons —
// `${button} bg-accent text-accent-ink` over a base that already carried
// `bg-control text-ink`. `bg-control` won there too, so the owner opened his
// Inbox to an Allow once button rendered as a dim grey slab beside a healthy
// looking Deny, and reported it as a button that did not work. It was never
// disabled.
//
// Knowing about a bug in one place does not fix it in another. This pins the
// shape rather than the colour, so the next person who reaches for
// `${base} bg-something` here has to see it fail.
describe("the two answers a person can give from the Inbox", () => {
  const markup = () => renderToStaticMarkup(createElement(InboxRequestAnswer, {
    threadId: "t1",
    card: { requestId: "r1", title: "Approval requested", subtitle: "rm -rf nothing", options: [], tool: "Bash" } as OptionCardData,
    botName: "Kessler (Ops Manager)",
    onSettled: () => {},
  }));

  it("fills the answer it wants, and never lets two backgrounds fight", () => {
    const html = markup();
    const allow = html.match(/<button[^>]*>\s*Allow once/)![0];
    const deny = html.match(/<button[^>]*>\s*Deny/)![0];

    // The primary action is FILLED, and carries exactly one background.
    expect(allow, "Allow once must be the filled control").toMatch(/\bbg-accent\b/);
    expect(allow, "two backgrounds means stylesheet order decides which one paints")
      .not.toMatch(/\bbg-control\b/);
    expect(allow).toMatch(/text-accent-ink/);
    expect(allow, "the ink must not fight either").not.toMatch(/\btext-ink\b/);

    // Deny is a real control in the colour of what it does, and outlined:
    // two filled buttons side by side make somebody choose between two shouts.
    expect(deny).toMatch(/text-danger/);
    expect(deny).not.toMatch(/\bbg-accent\b/);
    expect(deny, "outlined, not filled").toMatch(/bg-transparent/);
  });

  it("does not disable the answer it is asking for", () => {
    // It only ever LOOKED disabled. Pinning this means a future `disabled=`
    // added for a good reason has to be defended in a test rather than
    // discovered by the owner.
    //
    // The attribute, not the substring: the class list carries
    // `disabled:opacity-50`, so a regex for a bare `disabled` matches every
    // button on the panel and reports a defect that is not there. The first
    // version of this check did exactly that.
    const allow = markup().match(/<button[^>]*>\s*Allow once/)![0];
    expect(allow).not.toMatch(/disabled=""/);
    expect(allow, "the guard has to be able to see a real one").toMatch(/disabled:opacity-50/);
  });
});
