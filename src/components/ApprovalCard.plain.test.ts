// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The approval card says what will happen in plain words. The raw request
// (JSON, a shell line) is still on the card, folded under "Show details".
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "./ApprovalCard";
import { PendingApprovalPanel, spokenToolAction, type Pending } from "./PendingApproval";
import type { Bot, Message } from "@/state/store";

const bot = { id: "bot-ember", name: "Ember" } as Bot;

function card(tool: string, subtitle: string): Message {
  return { id: `m-${tool}`, role: "bot", kind: "options", at: 1,
    card: { title: "Approval needed", subtitle, options: ["Allow", "Deny"], tool, requestId: "r1" } };
}

/** The visible text before the folded details, with tags removed. */
function visible(markup: string): string {
  const folded = markup.indexOf("<details");
  return (folded < 0 ? markup : markup.slice(0, folded)).replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

const GMAIL = JSON.stringify({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "ana@example.com", subject: "March invoice", body: "Attached." } }] });
const DELEGATE = JSON.stringify({ bot_id: "5576ac4e-8c14-4314-9624-fc6254429d44", message: "Write and edit the launch post" });
const OWN_READ = "cat /h/.fuigo/sessions/k/s/mcp/call_00_Ugx02hBzWG21yy4QOx9K5297.json | python3 -c \"import json,sys; print(json.load(sys.stdin)['data'])\"";

describe("approval cards in plain words", () => {
  it.each([
    ["a connected-app email (ACP engine)", "other", GMAIL, "Ember wants to use Gmail to send email", ["To: ana@example.com", "Subject: March invoice"]],
    ["a connected-app email (Claude)", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", GMAIL, "Ember wants to use Gmail to send email", ["To: ana@example.com"]],
    ["a file write", "Write", JSON.stringify({ file_path: "/home/ana/plan.md", content: "# Plan" }), "Ember wants to create or replace plan.md", ["File: /home/ana/plan.md"]],
    ["a shell command", "shell", "rm -rf /home/ana/build", "Ember wants to delete build", []],
    ["a delegation", "other", DELEGATE, "Ember wants to hand a task to another bot", ["Message: Write and edit the launch post"]],
  ])("%s", (_name, tool, subtitle, headline, lines) => {
    const markup = renderToStaticMarkup(createElement(ApprovalCard, { bot, message: card(tool, subtitle) }));
    const shown = visible(markup);
    expect(shown).toContain(headline);
    for (const line of lines) expect(shown).toContain(line);
    // nothing raw before the fold: no JSON, no shell line, no vendor name, no tool id
    expect(shown).not.toMatch(/[{}]|"\w+":|composio|COMPOSIO|rm -rf|mcp__|—/);
    // the original request is still there, folded
    expect(markup).toContain("<details");
    expect(markup).toContain("Show details");
  });

  it("a read of a saved tool result that still reached a card is said in words", () => {
    const shown = visible(renderToStaticMarkup(createElement(ApprovalCard, { bot, message: card("shell", OWN_READ) })));
    expect(shown).toContain("Ember wants to look through call_00_Ugx02hBzWG21yy4QOx9K5297.json");
    expect(shown).not.toMatch(/python3|cat \//);
  });

  it("the pending bar and a call say the same plain action", () => {
    const message = card("other", DELEGATE);
    const pending: Pending = { message, requestId: "r1", tool: "other", detail: message.card!.subtitle };
    const shown = visible(renderToStaticMarkup(createElement(PendingApprovalPanel, { pending, count: 1, index: 0 })));
    expect(shown).toContain("Wants to hand a task to another bot");
    expect(shown).not.toMatch(/[{}]|bot_id/);
    expect(spokenToolAction("other", DELEGATE)).toBe("hand a task to another bot");
  });
});
