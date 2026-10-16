// SPDX-License-Identifier: AGPL-3.0-or-later
// A hand-off to another bot reads as one on every engine (1.0.1 Episode 1:
// a delegation was labelled "change a file" because its task said "write").
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "./ApprovalCard";
import { knownToolAction, spokenToolAction } from "./PendingApproval";
import { coveredForCall } from "@/lib/call-grant";
import { liveActivityLabel } from "@/lib/live-activity";
import type { Message } from "@/state/store";
import { narrateTool } from "../../server/tts/speech-text";
import { toolAction } from "../../server/reply-action-guard";

const input = JSON.stringify({ bot_id: "Draft Partner", message: "Please write the intro email and apply the brand voice." });

describe("a delegation is never a file change, on any engine's spelling", () => {
  it.each([
    ["delegate_bot", input],
    ["mcp__agents__delegate_bot", input],
    ["agents__delegate_bot", input],
    ["agents_delegate_bot", input],
    ["Agents.DelegateBot", input],
    ["use_tool", JSON.stringify({ tool_name: "agents__delegate_bot", tool_input: { bot_id: "Draft Partner", message: "Write the intro email." } })],
    ["other", `Agents_delegate_bot ${input}`],
    ["Local computer approval", `agents__delegate_bot\n${input}`],
    ["message_agent", JSON.stringify({ agent: "Draft Partner", message: "write the intro" })],
    ["handoff", JSON.stringify({ to: "Draft Partner", task: "edit the intro" })],
  ])("%s", (tool, detail) => {
    const action = knownToolAction(tool, detail);
    expect(action).not.toMatch(/file/);
    expect(action).toMatch(/Draft Partner/);
    expect(spokenToolAction(tool, detail)).not.toMatch(/file/);
  });

  it("names the teammate and the task in plain words", () => {
    expect(knownToolAction("mcp__agents__delegate_bot", input)).toBe("ask Draft Partner to write the intro email and apply the brand voice");
    expect(knownToolAction("agents__ask_bot", JSON.stringify({ bot_id: "Nova", message: "What did we write?" }))).toBe("ask Nova a question");
  });

  it("never shows a machine id as the teammate", () => {
    const action = knownToolAction("delegate_bot", JSON.stringify({ bot_id: "3f2b9c1e-8a7d-4e5f-9b0a-1c2d3e4f5a6b", message: "Draft the plan" }));
    expect(action).toBe("ask a teammate to draft the plan");
  });

  it("leaves real file edits and other tools as they were", () => {
    expect(knownToolAction("Edit", "src/notes.md")).toBe("change notes.md");
    expect(knownToolAction("other", "Agents_web_search")).toBe("search the web");
    expect(knownToolAction("Bash", "echo delegate_bot")).toBe("run a command on your computer");
  });

  it("is never covered by a call-long yes", () => {
    const message = { id: "m", role: "bot", kind: "options", at: 1, card: { tool: "delegate_bot", subtitle: input, requestId: "r", lowRisk: true } } as unknown as Message;
    expect(coveredForCall({ message, requestId: "r", tool: "delegate_bot", detail: input })).toBe(false);
  });
});

describe("the approval card header", () => {
  const bot = { name: "Business Planner" } as Parameters<typeof ApprovalCard>[0]["bot"];
  const render = (card: Record<string, unknown>) => renderToStaticMarkup(createElement(ApprovalCard, { bot, message: { id: "a", role: "bot", kind: "options", at: 1, card: { options: ["Allow", "Deny"], requestId: "r", ...card } } as Message }));

  it("reads an ACP delegation as asking a teammate", () => {
    const html = render({ title: "Approval needed", tool: "other", subtitle: `Agents_delegate_bot ${input}` });
    expect(html).toContain("Business Planner wants to ask Draft Partner to write the intro email");
    expect(html).not.toContain("change a file");
  });

  it("reads a peer approval card with the teammate from its title", () => {
    const html = render({ title: "@Business Planner wants to delegate to @Draft Partner", tool: "delegate_bot", subtitle: "Write the intro email." });
    expect(html).toContain("Business Planner wants to ask Draft Partner to write the intro email");
    expect(html).not.toContain("wants to delegate bot");
  });
});

describe("the live working line and spoken narration", () => {
  const activity = (name: string) => ({ id: "x", role: "bot", kind: "activity", at: 1, tool: { name } }) as unknown as Message;
  it.each(["delegate_bot", "agents__delegate_bot", "agents_delegate_bot", "mcp__agents__delegate_bot"])("%s", (name) => {
    expect(liveActivityLabel(activity(name))).toBe("Handing off a task");
    expect(narrateTool(name, { bot_id: "Draft Partner", message: "write the intro" })).toBe("handing work to Draft Partner");
  });
  it("names a wrapped hand-off too", () => {
    expect(narrateTool("use_tool", { tool_name: "agents__delegate_bot", tool_input: { bot_id: "Draft Partner", message: "x" } })).toBe("handing work to Draft Partner");
    expect(narrateTool("ask_bot")).toBe("asking a teammate");
  });
  it("counts a hand-off as a delegation, never a save", () => {
    expect(toolAction("mcp__agents__delegate_bot").classes).toEqual(["delegate"]);
  });
});
