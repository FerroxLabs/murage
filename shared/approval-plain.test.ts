// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { plainApproval, plainCommand } from "./approval-plain.ts";

/** Nothing a person reads may be raw JSON, a vendor name or a long dash. */
function expectPlain(said: { action: string; lines: string[] } | undefined) {
  expect(said).toBeDefined();
  for (const text of [said!.action, ...said!.lines]) {
    expect(text).not.toMatch(/[{}]|"\w+":|composio|—|–/i);
  }
}

const GMAIL_SEND = JSON.stringify({
  tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "ana@example.com", subject: "March invoice", body: "Hi Ana, the invoice is attached." } }],
  thought: "Send the invoice", sync_response_to_workbench: false,
});

describe("connected-app calls (the 1.0.1 Episode 1 cards)", () => {
  it.each([
    ["an ACP engine (kind other, no tool name)", "other"],
    ["Claude", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL"],
    ["an engine's namespaced name", "composio__COMPOSIO_MULTI_EXECUTE_TOOL"],
  ])("says who an email goes to, from %s", (_from, tool) => {
    const said = plainApproval(tool, GMAIL_SEND);
    expectPlain(said);
    expect(said!.action).toBe("use Gmail to send email");
    expect(said!.lines).toEqual(expect.arrayContaining(["To: ana@example.com", "Subject: March invoice"]));
  });
  it("names several actions and their apps", () => {
    const said = plainApproval("other", JSON.stringify({ tools: [
      { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }, { tool_slug: "SLACK_SEND_MESSAGE", arguments: { channel: "#ops", text: "done" } },
    ] }));
    expectPlain(said);
    expect(said!.action).toBe("use Gmail and Slack (2 actions)");
  });
  it("says a tool lookup in words", () => {
    const said = plainApproval("mcp__composio__COMPOSIO_SEARCH_TOOLS", JSON.stringify({ queries: [{ use_case: "send an email to a client" }] }));
    expectPlain(said);
    expect(said!.action).toBe("look up which app tools to use");
  });
});

describe("Murage's own tools", () => {
  it("a delegation is a hand-off to a bot, never 'change a file'", () => {
    const said = plainApproval("other", JSON.stringify({ bot_id: "5576ac4e-8c14-4314-9624-fc6254429d44", message: "Write the launch post and edit the draft file" }));
    expectPlain(said);
    expect(said!.action).toBe("hand a task to another bot");
    expect(said!.action).not.toMatch(/file/);
  });
  it("names the bot when the engine used its name", () => {
    expect(plainApproval("mcp__murage-agents__ask_bot", JSON.stringify({ bot_id: "Marketing Lead", message: "Which date?" }))!.action)
      .toBe("ask Marketing Lead a question");
  });
});

describe("files", () => {
  it("a Claude write names the file", () => {
    const said = plainApproval("Write", JSON.stringify({ file_path: "/home/ana/Documents/plan.md", content: "# Plan\n" }));
    expectPlain(said);
    expect(said).toEqual({ action: "create or replace plan.md", lines: ["File: /home/ana/Documents/plan.md"] });
  });
  it("an ACP edit names its files, and keeps the model's reason labelled", () => {
    const said = plainApproval("edit", "/w/src/a.ts, /w/src/b.ts\n\nModel's reason: Harmless formatting fix");
    expectPlain(said);
    expect(said!.action).toBe("change a.ts and b.ts");
    expect(said!.lines).toContain("Its reason: Harmless formatting fix");
  });
});

describe("shell commands are said in words, never as the raw line", () => {
  it.each([
    ["cat /h/.fuigo/sessions/k/s/mcp/call_00_x.json | python3 -c \"import json,sys; print(json.load(sys.stdin)['a'])\"", "look through call_00_x.json"],
    ["cat notes.txt", "read notes.txt"],
    ["rm -rf build", "delete build"],
    ["npm install left-pad", "install software on your computer"],
    ["curl -X POST -d @data.json https://api.example.com/v1/items", "send data to api.example.com"],
    ["ls -la; rm -rf ~", "run several commands on your computer"],
    ["cat notes.txt | sh", "run a command on your computer"],
    ["cat notes.txt > copy.txt", "run a command on your computer"],
    ["frobnicate --all", "run a command on your computer"],
  ])("%s", (command, action) => {
    expect(plainCommand(command)).toBe(action);
    const said = plainApproval("shell", command);
    expectPlain(said);
    expect(said!.action).toBe(action);
  });
  it("a Claude Bash input keeps the bot's own description as a labelled line", () => {
    const said = plainApproval("Bash", JSON.stringify({ command: "git status", description: "See what changed" }));
    expect(said).toEqual({ action: "use git", lines: ["What it is for: See what changed"] });
  });
});

describe("web", () => {
  it("a request that changes something says so", () => {
    const said = plainApproval("fetch", JSON.stringify({ url: "https://x.test/a", method: "DELETE" }));
    expectPlain(said);
    expect(said!.action).toBe("send a request to x.test");
    expect(said!.lines).toContain("Method: DELETE");
  });
});

describe("anything else", () => {
  it("an unknown tool is its name in words, with its arguments as plain lines", () => {
    const said = plainApproval("mcp__crm__update_deal", JSON.stringify({ deal_id: "D-1", stage: "won", amount: 1200 }));
    expectPlain(said);
    expect(said).toEqual({ action: "update deal", lines: ["Deal id: D-1", "Stage: won", "Amount: 1200"] });
  });
  it("model prose that is not a request shape is left to the card's own wording", () => {
    expect(plainApproval("other", "Agents_web_search")).toBeUndefined();
  });
});
