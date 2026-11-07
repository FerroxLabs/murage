// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NEEDSYOU-INLINE-APPROVE (1.0.18, Sean): an approval row in Needs you says WHAT
// it approves in one line and answers with one click, Approve or Don't allow,
// through the same hook, route and bodies as the open card's own buttons. A card
// the open view would not settle with one plain press (a scope to pick, typed
// input, several options, a review-first Allow) keeps Open only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OptionCardData } from "@/state/store";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { InboxQuickAnswer, quickAnswerOf, quickAnswerChoices, requestSummary, ALLOW_ONCE_BODY, DENY_BODY } = await import("../InboxRequest");
const { NeedsRow } = await import("./NeedsRow");

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const open = { computerOnly: false, reviewFirst: false };
const approval: OptionCardData = { title: "Approval needed", subtitle: "git push origin main", options: ["Allow", "Deny"], requestId: "tool-1", tool: "Bash" };
const question: OptionCardData = {
  title: "Question needs an answer", subtitle: "Send the Dana email now?", options: ["Yes", "No"], requestId: "ask-1",
  questions: [{ id: "q1", question: "Send the Dana email now?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: true }],
};

describe("the row says what is being approved", () => {
  it("names the action and its target, never a blind 'Approval requested'", () => {
    const line = requestSummary(approval);
    expect(line).toContain("git push origin main");
    expect(line).toMatch(/^Wants to /);
    expect(line).not.toContain("Approval requested");
  });
  it("shows the command itself; the card's own summary only stands in when there is no command", () => {
    expect(requestSummary({ ...approval, summary: "Bash" })).toContain("git push origin main");
    expect(requestSummary({ ...approval, subtitle: "", summary: "push main to GitHub" })).toContain("push main to GitHub");
  });
  it("cuts a long command to about 120 characters, on one line", () => {
    const line = requestSummary({ ...approval, subtitle: `curl -X POST https://example.com/${"a".repeat(400)}\nsecond line` });
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line).not.toContain("\n");
    expect(line).not.toContain("second line");
  });
  it("a question's row reads the bot's own question", () => {
    expect(requestSummary(question)).toBe("Send the Dana email now?");
  });
  it("says nothing for a card it cannot read", () => {
    expect(requestSummary(undefined)).toBe("");
  });
});

describe("which rows get the one-click answer", () => {
  it("a plain approval: Approve and Deny", () => {
    expect(quickAnswerOf(approval, open)).toEqual({ kind: "approval" });
  });
  it("Open only for anything the open card would not settle with one plain press", () => {
    expect(quickAnswerOf({ ...approval, taskAllowKey: "stop:delete:/x" }, open)).toBeNull();
    expect(quickAnswerOf(approval, { ...open, computerOnly: true })).toBeNull();
    expect(quickAnswerOf(approval, { ...open, reviewFirst: true })).toBeNull();
    expect(quickAnswerOf({ ...approval, kind: "email-send" }, open)).toBeNull();
    expect(quickAnswerOf({ ...approval, kind: "publish" }, open)).toBeNull();
    expect(quickAnswerOf({ ...approval, routineRequest: {} as never }, open)).toBeNull();
    expect(quickAnswerOf({ ...approval, skillRequest: {} as never }, open)).toBeNull();
    expect(quickAnswerOf({ ...approval, tool: "local_computer_consent" }, open)).toBeNull();
    expect(quickAnswerOf({ ...approval, tool: "murage_limit_offer" }, open)).toBeNull();
    expect(quickAnswerOf({ ...approval, tool: "browser_extension_action" }, open)).toBeNull();
    expect(quickAnswerOf({ ...approval, answered: "Allow" }, open)).toBeNull();
    expect(quickAnswerOf(undefined, open)).toBeNull();
  });
  it("APPROVALS-SIMPLE-1018: a long or several-line command still answers in one click, and no command is dumped beside the buttons", () => {
    const longCommand = `cd ~/site && npm run build\nrsync -a dist/ deploy@example.com:/srv/site/${"a".repeat(150)}`;
    expect(quickAnswerOf({ ...approval, subtitle: longCommand }, open)).toEqual({ kind: "approval" });
    const html = renderToStaticMarkup(createElement(InboxQuickAnswer, { threadId: "t1", card: { ...approval, lowRisk: true, subtitle: longCommand }, labelledBy: "line-1", onSettled: () => {} }));
    expect(html).not.toContain("data-needs-whole");
    expect(html).not.toContain("deploy@example.com");
    expect(html).not.toContain("npm run build");
    expect(html).toContain("Approve");
    expect(html).toContain(">Deny<");
    expect(read("../InboxRequest.tsx")).not.toContain("data-needs-whole");
  });
  it("Open only when the server cut the tool input short for display", () => {
    expect(quickAnswerOf({ ...approval, toolInputTruncated: true }, open)).toBeNull();
  });
  it("a room post (venue_post) keeps Open only: the row would not show the room or the whole post", () => {
    const post: OptionCardData = { title: "Sable wants to post in Launch team", subtitle: "We ship Friday", options: ["Post", "Skip"], requestId: "venue-post-1", tool: "venue_post" };
    expect(quickAnswerOf(post, open)).toBeNull();
  });
  it("a question with exactly two plain options gets those two; anything else gets Open only", () => {
    expect(quickAnswerOf(question, open)).toEqual({ kind: "choice", questionId: "q1", options: ["Yes", "No"] });
    const q = question.questions![0]!;
    const withQuestion = (patch: Partial<typeof q>) => ({ ...question, questions: [{ ...q, ...patch }] });
    expect(quickAnswerOf(withQuestion({ options: [{ label: "A" }, { label: "B" }, { label: "C" }] }), open)).toBeNull();
    expect(quickAnswerOf(withQuestion({ options: [{ label: "Only" }] }), open)).toBeNull();
    expect(quickAnswerOf(withQuestion({ multiSelect: true }), open)).toBeNull();
    expect(quickAnswerOf(withQuestion({ secret: true }), open)).toBeNull();
    expect(quickAnswerOf(withQuestion({ options: [{ label: "Yes", description: "and also delete the old one" }, { label: "No" }] }), open)).toBeNull();
    expect(quickAnswerOf({ ...question, questions: [q, { ...q, id: "q2" }] }, open)).toBeNull();
    expect(quickAnswerOf({ ...question, folderTrust: { key: "k", folder: "/x", sources: [] } }, open)).toBeNull();
  });
});

describe("one click answers the way the open card does", () => {
  it("Approve and Deny send the open card's own Allow once and Deny bodies", () => {
    const choices = quickAnswerChoices({ kind: "approval" });
    expect(choices.map(choice => [choice.choice, choice.body])).toEqual([["allow", ALLOW_ONCE_BODY], ["deny", DENY_BODY]]);
    expect(ALLOW_ONCE_BODY).toEqual({ behavior: "allow" });
    expect(DENY_BODY).toEqual({ behavior: "deny", message: "Denied by the user." });
  });
  it("a two-option question sends the same answer a one-tap pick in the open card sends", () => {
    const choices = quickAnswerChoices({ kind: "choice", questionId: "q1", options: ["Yes", "No"] });
    expect(choices.map(choice => choice.body)).toEqual([
      { behavior: "answer", answers: [{ id: "q1", selected: ["Yes"] }] },
      { behavior: "answer", answers: [{ id: "q1", selected: ["No"] }] },
    ]);
  });
  it("both surfaces answer through ONE hook and the same bodies, so there is no second route", () => {
    const source = read("../InboxRequest.tsx");
    expect(source.match(/useRequestAnswer\(/g)?.length).toBeGreaterThanOrEqual(3); // its definition, the open card, the row
    expect(source).toContain('decide("allow", ALLOW_ONCE_BODY)');
    expect(source).toContain('decide("deny", DENY_BODY)');
    expect(source.match(/\/api\/threads\/\$\{threadId\}\/respond/g)).toHaveLength(1);
  });
  it("draws Approve as the primary and Deny beside it (the open card's own word), named by the row's line", () => {
    const html = renderToStaticMarkup(createElement(InboxQuickAnswer, { threadId: "t1", card: { ...approval, lowRisk: true }, labelledBy: "line-1", onSettled: () => {} }));
    const approve = html.match(/<button[^>]*>(?:(?!<\/button>).)*Approve/)![0];
    expect(approve).toMatch(/\bbg-accent\b/);
    expect(html).toContain(">Deny<");
    expect(html).not.toContain("Don&#x27;t allow");
    expect(html).toContain('aria-labelledby="line-1"');
    expect(html.indexOf("Approve")).toBeLessThan(html.indexOf(">Deny<"));
  });
  it("draws nothing for a card that keeps Open only", () => {
    const html = renderToStaticMarkup(createElement(InboxQuickAnswer, { threadId: "t1", card: { ...approval, lowRisk: true, taskAllowKey: "stop:x" }, labelledBy: "line-1", onSettled: () => {} }));
    expect(html).toBe("");
  });
});

describe("the Needs you row", () => {
  const verbs = createElement("div", null, createElement("button", null, "Approve"), createElement("button", null, "Don't allow"));
  it("collapsed: the line, the answer buttons it was given, and Open", () => {
    const html = renderToStaticMarkup(createElement(NeedsRow, { id: "r1", line: "Wants to run a command: git push", meta: "Sable · waiting since 06:07", open: false, onToggle: () => undefined, actions: verbs }));
    expect(html).toContain("Approve");
    expect(html).toContain('id="needs-row-line-r1"');
    expect(html).toContain(">Open</button>");
  });
  it("open: the inline buttons step aside for the card's own", () => {
    const html = renderToStaticMarkup(createElement(NeedsRow, { id: "r1", line: "x", meta: "y", open: true, onToggle: () => undefined, actions: verbs }, createElement("p", null, "card")));
    expect(html).not.toContain("Approve");
  });
  it("APPROVALS-SIMPLE-1018 (needs-inline Astra r2 High): the row's line and grey line WRAP, never a CSS cut", () => {
    const html = renderToStaticMarkup(createElement(NeedsRow, { id: "r1", line: "Petra wants to append today's Trustpilot check to the ops log", meta: "Runs a command · Petra · waiting since 06:39", open: false, onToggle: () => undefined, actions: verbs }));
    const line = html.match(/<p id="needs-row-line-r1"[^>]*>/)![0];
    expect(line).not.toMatch(/\btruncate\b/);
    expect(line).toMatch(/\bbreak-words\b/);
    expect(html).not.toMatch(/class="[^"]*\btruncate\b/);
    expect(read("./NeedsRow.tsx")).not.toMatch(/className="[^"]*\btruncate\b/);
  });
  it("a waiting request's expand reads Show details / Hide details", () => {
    expect(renderToStaticMarkup(createElement(NeedsRow, { id: "r1", line: "x", meta: "y", open: false, details: true, onToggle: () => undefined }))).toContain(">Show details</button>");
    expect(renderToStaticMarkup(createElement(NeedsRow, { id: "r1", line: "x", meta: "y", open: true, details: true, onToggle: () => undefined }))).toContain(">Hide details</button>");
  });
  it("the door gives every loaded approval its line and its quick answer, and takes the row away once answered", () => {
    const inbox = read("../Inbox.tsx");
    expect(inbox).toContain("line={rowLine(card, bot, requestSummary) || item.title}");
    expect(inbox).toContain("details={item.kind === \"request\"}");
    expect(inbox).toContain("<InboxQuickAnswer");
    expect(inbox).toContain("labelledBy={`needs-row-line-${item.id}`}");
    expect(inbox).toMatch(/onSettled=\{\(\) => settledInline\(item\)\}/);
  });
});
