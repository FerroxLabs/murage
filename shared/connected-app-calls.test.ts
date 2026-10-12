// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  CONNECTED_APP_ACTION_TIMEOUT_MS,
  CONNECTED_APP_LOOKUP_TIMEOUT_MS,
  connectedAppActionLabel,
  connectedAppEffectArgs,
  connectedAppRequirements,
  connectedAppCallTimeoutMs,
  connectedAppNames,
  connectedAppTimeoutText,
  isConnectedAppLookup,
  CONNECTED_APP_STATUS_TOOL,
  CONNECTED_APP_STATUS_TOOL_DEFINITION,
  connectedAppActionCall,
  connectedAppNotSentText,
  connectedAppPendingText,
  connectedAppRepeatNote,
  connectedAppUnknownText,
  isConnectedAppStatusTool,
} from "./connected-app-calls.ts";

const call = (name: string, args: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("connected-app call bounds", () => {
  it("bounds a lookup at 30 s and an action at 120 s, both inside the broker's 285 s", () => {
    expect(CONNECTED_APP_LOOKUP_TIMEOUT_MS).toBe(30_000);
    expect(CONNECTED_APP_ACTION_TIMEOUT_MS).toBe(120_000);
    for (const name of ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "composio__COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_WAIT_FOR_CONNECTIONS"]) {
      expect(connectedAppCallTimeoutMs(call(name)), name).toBe(30_000);
    }
    for (const name of ["COMPOSIO_MULTI_EXECUTE_TOOL", "composio__COMPOSIO_REMOTE_WORKBENCH", "COMPOSIO_REMOTE_BASH_TOOL", "GMAIL_LIST_EMAILS"]) {
      expect(connectedAppCallTimeoutMs(call(name)), name).toBe(120_000);
    }
    expect(connectedAppCallTimeoutMs({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toBe(30_000);
    expect(connectedAppCallTimeoutMs(call("COMPOSIO_MULTI_EXECUTE_TOOL"), { actionMs: 5 })).toBe(5);
    expect(isConnectedAppLookup("GMAIL_LIST_EMAILS")).toBe(false);
  });

  it("names the app action a call runs, also inside an engine's tool wrapper", () => {
    const args = { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }, { tool_slug: "GOOGLECALENDAR_EVENTS_LIST" }, { tool_slug: "SLACK_SEND_MESSAGE" }] };
    expect(connectedAppActionLabel(args)).toBe("Gmail: fetch emails and 2 more");
    expect(connectedAppNames(args)).toBe("Gmail, Google Calendar and Slack");
    expect(connectedAppNames({ tool_name: "composio__COMPOSIO_MULTI_EXECUTE_TOOL", tool_input: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }] } })).toBe("Gmail");
    expect(connectedAppActionLabel({ query: "email" })).toBeUndefined();
    expect(connectedAppActionLabel("GMAIL")).toBeUndefined();
  });

  it("tells the bot what stopped and what to do, in product words", () => {
    const action = connectedAppTimeoutText("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] }, 120_000);
    expect(action).toBe("The connected app action (Gmail: send email) is taking longer than 120 seconds and is still running on its own. Do not run it again. Making the exact same request again returns its result once it finishes, without running it a second time. Tell the user it is still working and that you will report the outcome.");
    const lookup = connectedAppTimeoutText("COMPOSIO_SEARCH_TOOLS", { queries: [] }, 30_000);
    expect(lookup).toMatch(/^The connected app lookup did not answer within 30 seconds/);
    for (const text of [action, lookup]) expect(text).not.toMatch(/composio|\bsafe|safety|unsafe|—/i);
  });

  it("gives each action an identity, and words every operation answer in product terms", () => {
    expect(connectedAppActionCall(call("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] }))).toEqual({ id: 1, name: "COMPOSIO_MULTI_EXECUTE_TOOL", args: { tools: [] } });
    expect(connectedAppActionCall(call("COMPOSIO_SEARCH_TOOLS"))).toBeNull();
    expect(connectedAppActionCall(call(CONNECTED_APP_STATUS_TOOL, { handle: "op-1" }))).toBeNull();
    expect(connectedAppActionCall({ jsonrpc: "2.0", method: "tools/call", params: { name: "GMAIL_SEND_EMAIL" } })).toBeNull();
    expect(connectedAppCallTimeoutMs(call(CONNECTED_APP_STATUS_TOOL))).toBe(30_000);
    expect(isConnectedAppStatusTool("murage-connectors__CHECK_CONNECTED_APP_ACTION")).toBe(true);
    const texts = [
      connectedAppPendingText("Gmail: send email", "op-1", false),
      connectedAppPendingText(undefined, "op-1", true),
      connectedAppRepeatNote("Gmail: send email", "op-1", 40),
      connectedAppUnknownText("Gmail: send email", "op-1"),
      connectedAppNotSentText(undefined, "connected apps are unavailable."),
      CONNECTED_APP_STATUS_TOOL_DEFINITION.description,
    ];
    expect(texts[0]).toMatch(/still running\. Its handle is op-1\. Do not run it again/);
    expect(texts[0]).toContain(CONNECTED_APP_STATUS_TOOL);
    expect(texts[4]).toBe("The connected app action did not run: connected apps are unavailable. Nothing was sent to the app, so it is fine to make the request again.");
    for (const text of texts) expect(text).not.toMatch(/composio|—|\bfail|broken/i);
  });
});

describe("an action's identity (1.0.2 round 2)", () => {
  const email = { tool_slug: "GMAIL_SEND_EMAIL", account: "ca_1", arguments: { to: "a@example.com", body: "Hi" } };
  it("leaves out the model's commentary and nothing that changes the effect", () => {
    const a = connectedAppEffectArgs({ tools: [email], thought: "one", current_step: "A", current_step_metric: "0/1", session_id: "s1" });
    const b = connectedAppEffectArgs({ tools: [{ ...email, thought: "inside a row" }], thought: "two", current_step: "B", session_id: "s2" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual({ tools: [email] });
    // The tool's own arguments are untouched, even one that is called thought.
    expect(connectedAppEffectArgs({ tools: [{ ...email, arguments: { thought: "kept" } }] })).toEqual({ tools: [{ ...email, arguments: { thought: "kept" } }] });
    // A wrapper call's commentary is dropped too.
    expect(connectedAppEffectArgs({ tool_name: "X", tool_input: { tools: [email], thought: "t" }, thought: "u" })).toEqual({ tool_name: "X", tool_input: { tools: [email] } });
  });
  it("names the tool and account each action needs", () => {
    expect(connectedAppRequirements({ tools: [email, { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }], thought: "x" })).toEqual([
      { tool: "GMAIL_SEND_EMAIL", account: "ca_1" }, { tool: "GMAIL_FETCH_EMAILS" },
    ]);
  });
});
