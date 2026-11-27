// MAIN RULING design F §1.1: switch fixtures include the reviewed verdict binding; OPEN for GrokBuild approval.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PendingApprovalPanel, PendingApprovalActions, pendingOf } from "./PendingApproval";
import { approvalLabel, approvalTitle, spokenApprovalPrompt, spokenQueueItem } from "@/lib/pending-approval";
import { StoreProvider } from "@/state/store";
import { ApprovalCard } from "./ApprovalCard";
const render = (answered: string, action = "turn_off", source = "learn:conversation") => renderToStaticMarkup(createElement(ApprovalCard, { message: { id: "fixture-message", role: "bot", kind: "options", card: { answered, title: 'Turn off skill "sample-skill"?', options: ["Turn off", "Deny"], tool: "switch_skill", skillRequest: { version: 1, requestId: "fixture-request", botId: "fixture-bot", threadId: "fixture-thread", stagedId: "", action, name: "sample-skill", gist: "Sample", source, preview: "Sample instructions", sha256: "a".repeat(64), warnings: [], createdAt: 0 } } } as any }));
it("a denied switch says Not changed", () => expect(render("deny")).toContain("Not changed"));
it("an approved switch names the completed action", () => {
  expect(render("allow")).toContain("Skill turned off");
  expect(render("allow", "turn_on")).toContain("Skill turned on");
  expect(render("allow", "delete")).toContain("Skill deleted");
  expect(render("allow", "delete", "collection:sample-skill")).toContain("Skill taken off");
});

it("the composer and voice name the switch instead of enabling a learned skill", () => {
  const message = { id: "fixture-open", role: "bot", kind: "options", card: { title: 'Turn off skill "sample-skill"?', subtitle: "Review the skill.", tool: "switch_skill", requestId: "fixture-request", options: ["Turn off", "Deny"], skillRequest: { version: 1, requestId: "fixture-request", botId: "fixture-bot", threadId: "fixture-thread", stagedId: "", action: "turn_off", verdictHash:"a".repeat(64), findings:[], name: "sample-skill", gist: "Sample", preview: "Sample instructions", sha256: "a".repeat(64), warnings: [], createdAt: 0 } } } as any;
  const pending = pendingOf(message);
  expect(approvalLabel(pending)).toBe(message.card.title);
  expect(spokenApprovalPrompt(pending, "Fixture bot")).toContain(message.card.title);
  expect(spokenQueueItem(pending, "Fixture bot")).toContain(message.card.title);
  const markup = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, threadId: "fixture-thread" }));
  expect(markup).toContain("Turn off"); expect(markup).not.toContain("Enable this learned skill");
});

it.each(["turn_on", "turn_off", "delete"])("Grok C1: %s names exactly its own action in the bar and voice", action => {
  const label = action === "turn_on" ? "Turn on" : action === "turn_off" ? "Turn off" : "Delete";
  const title = `${label} skill "sample-skill"?`;
  const card = { title, options: [label, "Deny"], tool: "switch_skill", requestId: "fixture-request", skillRequest: { action, name: "sample-skill", stagedId: "", warnings: [] } };
  const pending = pendingOf({ id: "fixture-open", role: "bot", kind: "options", card } as any);
  expect(approvalTitle(pending)).toBe(title); expect(approvalLabel(pending)).toBe(title);
  expect(spokenQueueItem(pending, "Fixture bot")).toContain(title);
  expect(spokenApprovalPrompt(pending, "Fixture bot")).toContain(label.toLowerCase());
});

it.each(["turn_on", "turn_off", "delete"])("Grok C1: %s primary button uses its own option and never Enable", action => {
  const label = action === "turn_on" ? "Turn on" : action === "turn_off" ? "Turn off" : "Delete";
  const message = { id: "fixture-buttons", role: "bot", kind: "options", card: { title: `${label} skill?`, options: [label, "Deny"], tool: "switch_skill", requestId: "fixture-request", skillRequest: { action, name: "sample-skill", preview: "Instructions", sha256: "a".repeat(64), warnings: [] } } } as any;
  const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(PendingApprovalActions, { pending: pendingOf(message), threadId: "fixture-thread", onCancelTurn: () => {} })));
  expect(markup).toContain(`>${label}</`); expect(markup).not.toContain(">Enable<");
});

it("a private shared delete receipt says Skill taken off without storing its source", () => {
  const card = { answered: "allow", title: 'Take skill "shared-skill" off Fixture bot?', subtitle: "Your other bots and the shared copy keep it. You can add it again from Skills.", options: ["Delete", "Deny"], tool: "switch_skill", skillRequest: { action: "delete", verdictHash:"a".repeat(64), findings:[], name: "shared-skill", sha256: "a".repeat(64) } };
  const markup = renderToStaticMarkup(createElement(ApprovalCard, { message: { id: "fixture-private-receipt", role: "bot", kind: "options", card } as any }));
  expect(markup).toContain("Skill taken off"); expect(markup).not.toContain("Skill deleted");
});
