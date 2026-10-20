// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 tool latency. In No limits a Grok ask for a connected-app tool took
// 137 s to be answered. The decision itself is pure policy over what the
// engine sent: it must come back in the same tick, with no network, no
// database and no memory work, so the only thing an automatic answer can
// ever wait on is the thread it runs on (observe.ts startLoopStallWatch names
// whatever holds that thread).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routineTurnApproval } from "./routine-permissions.ts";

const unlimited = { autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: [] };
const full = { autoApprove: true, fullAccess: true, alwaysAllow: [] };
const auto = { autoApprove: true, fullAccess: false, alwaysAllow: [] };
// Each ask carries the call the engine sent, as a real one does: an execute
// call names its actions, and one that does not is never answered by a mode.
const tools: Array<[string, string, Record<string, unknown>]> = [
  ["composio__COMPOSIO_GET_TOOL_SCHEMAS", "Read a connected-app tool's details", { tool_slugs: ["GMAIL_SEND_EMAIL"] }],
  ["composio__COMPOSIO_MULTI_EXECUTE_TOOL", "Run a connected-app action", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", account: "a", arguments: { max_results: 5 } }] }],
  ["composio__COMPOSIO_REMOTE_WORKBENCH", "Run code for a connected app", { code_to_execute: "print(1)" }],
];
const call = (tool: string, input: Record<string, unknown>) => ({ toolCall: { name: tool, input } });

afterEach(() => vi.restoreAllMocks());

describe("an automatic permission answer", () => {
  it("is decided in the same tick with no network, for every connected-app tool and every level that answers it", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("a permission decision reached the network"); });
    const started = performance.now();
    for (let round = 0; round < 2_000; round++) {
      for (const [tool, summary, input] of tools) {
        const result = routineTurnApproval({ bot: unlimited, tool, summary, context: { stopLine: null, call: call(tool, input) } });
        expect(result.verdict).not.toBeInstanceOf(Promise);
        expect(result.verdict.approve).toBeTruthy();
        expect(result.verdict.source).toBe("no-limits");
        expect(routineTurnApproval({ bot: full, tool, summary, context: { stopLine: null, call: call(tool, input) } }).verdict.source).toBe("full-access");
      }
    }
    const perDecisionMs = (performance.now() - started) / (2_000 * tools.length * 2);
    expect(fetchSpy).not.toHaveBeenCalled();
    // p50 on a laptop is microseconds; the bound is generous for a loaded CI box
    expect(perDecisionMs).toBeLessThan(1);
  });

  it("No limits lets a message to someone new go; Auto still asks", () => {
    const message = { kind: "message" as const, place: "ada@example.com", what: "Send a message to someone new: ada@example.com" };
    const send = call(tools[1]![0], { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: "a", arguments: { recipient_email: "ada@example.com" } }] });
    expect(routineTurnApproval({ bot: unlimited, tool: tools[1]![0], summary: "send", context: { stopLine: message as never, call: send } }).verdict.source).toBe("no-limits");
    expect(routineTurnApproval({ bot: auto, tool: tools[1]![0], summary: "send", context: { stopLine: message as never, call: send } }).verdict.approve).toBeFalsy();
  });

  it("an execute call whose actions cannot be read is held, even in No limits", () => {
    const verdict = routineTurnApproval({ bot: unlimited, tool: tools[1]![0], summary: "run", context: { stopLine: null, call: call(tools[1]![0], {}) } }).verdict;
    expect(verdict.approve).toBeFalsy();
    expect(verdict.source).toBe("unread-call");
  });

  it("is answered before the push risk rating, which is written only for a card a person sees", () => {
    // The server's request.opened handler (index.ts): the rating is a database
    // write, so it must sit on the card paths, never ahead of the answer.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    const start = source.indexOf('case "request.opened": {');
    const handler = source.slice(start, source.indexOf("const notifyHuman = () =>", start));
    const answer = handler.indexOf('respondToRequest(event.threadId, requestId, { behavior: "allow" })');
    expect(start).toBeGreaterThan(0);
    expect(answer).toBeGreaterThan(0);
    const direct = [...handler.matchAll(/pushStore\.rateRisk\(/g)].map(match => match.index!);
    expect(direct).toHaveLength(1); // inside ratePermissionRisk only
    const calls = [...handler.matchAll(/ratePermissionRisk\(\);/g)].map(match => match.index!);
    expect(calls.length).toBe(2);
    // one in the fallback after a failed answer, one on the card path after the automatic branch
    expect(calls.every(index => index > answer)).toBe(true);
  });
});
