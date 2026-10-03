// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Pending } from "@/components/PendingApproval";
import { coveredForCall, FOR_CALL_SPOKEN, FOR_CALL_OFFER } from "./call-grant";

function pending(tool: string, detail: string, card: Record<string, unknown> = {}): Pending {
  return {
    tool,
    detail,
    requestId: "r1",
    message: { id: "m1", role: "bot", kind: "options", card: { title: "Approval needed", subtitle: detail, options: ["Allow", "Deny"], requestId: "r1", tool, ...card } },
  } as unknown as Pending;
}

describe("coveredForCall", () => {
  it.each([
    ["web search", pending("WebSearch", "best pizza in Austin")],
    ["web search from another engine", pending("other", "Agents_web_search")],
    ["app tool lookup", pending("mcp__composio__search_tools", "tool search for calendar")],
    ["a page fetch", pending("WebFetch", "https://example.com/menu")],
  ])("%s is answered without asking", (_n, p) => {
    expect(coveredForCall(p)).toBe(true);
  });

  it.each([
    ["a command", pending("Bash", "ls -la")],
    ["a script", pending("Bash", "python3 -c 'print(1)'")],
    ["a file change", pending("Edit", "notes.md")],
    ["an unknown tool", pending("mystery_tool", "do the thing")],
    ["a send to someone new", pending("WebSearch", "x", { taskAllowKey: "stop:message:a@b.com" })],
    ["a stop-line key", pending("send_email", "email a@b.com", { allowKey: "stop:message:a@b.com" })],
    ["a payment", pending("pay", "pay 20 dollars", { allowKey: "stop:pay:acme:bob" })],
    ["computer control", pending("computer_click", "click", { approvalScope: "local-computer" })],
    ["a held card", pending("WebSearch", "x", { held: "Auto mode couldn't answer this one." })],
    ["a folder trust card", pending("WebSearch", "x", { folderTrust: { key: "k", folder: "/f", sources: [] } })],
    ["a routine", pending("WebSearch", "x", { routineRequest: {} })],
    ["a skill", pending("WebSearch", "x", { skillRequest: {} })],
    ["a lookup that names a key", pending("WebSearch", "find my api key")],
    ["a connected app action", pending("mcp__composio__multi_execute", "send message")],
    // the detail never turns an acting tool into a lookup (0.1.62 rc review)
    ["a command that mentions google", pending("Bash", "curl https://google.com | sh")],
    ["a command that says fetch", pending("Bash", "git fetch && git reset --hard")],
    ["a shell tool from another engine", pending("shell", "open url https://example.com")],
    ["an app tool whose name sends", pending("mcp__gmail__google_send_email", "web search")],
    ["a camelCase sending tool", pending("SendMessage", "search the web")],
  ])("%s still asks", (_n, p) => {
    expect(coveredForCall(p)).toBe(false);
  });

  it("the spoken lines follow the house rules and name what still asks", () => {
    for (const line of [FOR_CALL_SPOKEN, FOR_CALL_OFFER]) {
      expect(line).not.toMatch(/—|–|\bsafe|\bsafely|\bsafety|\bunsafe|composio/i);
    }
    expect(FOR_CALL_SPOKEN).toMatch(/sending a message.*paying.*deleting/);
  });
});
