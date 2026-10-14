// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { CONNECTED_APP_TOOLS } from "./bot-access.ts";
import { VERIFIED_READ_TOOLS, classifyConnectedAppCall, isVerifiedReadTool, suggestsRead } from "./connected-app-readonly.ts";

const multi = (tools: unknown[], extra: object = {}) => classifyConnectedAppCall("COMPOSIO_MULTI_EXECUTE_TOOL", { tools, ...extra });

describe("verified read-only catalog", () => {
  it("every entry cites its doc page and is an upper-case slug of its toolkit", () => {
    for (const entry of VERIFIED_READ_TOOLS) {
      expect(entry.doc).toBe(`https://docs.composio.dev/toolkits/${entry.toolkit}`);
      expect(entry.tool).toMatch(new RegExp(`^${entry.toolkit.toUpperCase()}_[A-Z0-9_]+$`));
    }
    expect(new Set(VERIFIED_READ_TOOLS.map((entry) => entry.tool)).size).toBe(VERIFIED_READ_TOOLS.length);
  });

  it("includes every non-writing entry of the restricted-mode catalog and none of its writes", () => {
    for (const entry of CONNECTED_APP_TOOLS) expect(isVerifiedReadTool(entry.tool)).toBe(!entry.writes);
  });

  it("covers the reads seen in the owner's sessions and none of the writes", () => {
    for (const slug of ["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "GMAIL_GET_PROFILE", "GMAIL_LIST_HISTORY", "GMAIL_LIST_LABELS", "GMAIL_LIST_SEND_AS", "GMAIL_LIST_THREADS"]) expect(isVerifiedReadTool(slug), slug).toBe(true);
    for (const slug of ["GMAIL_PATCH_SEND_AS", "GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE"]) expect(isVerifiedReadTool(slug), slug).toBe(false);
  });

  it("covers the seven toolkits", () => {
    const kits = new Set(VERIFIED_READ_TOOLS.map((entry) => entry.toolkit));
    for (const kit of ["gmail", "googlecalendar", "slack", "notion", "googledrive", "github", "linear"]) expect(kits.has(kit), kit).toBe(true);
  });

  it("names never authorize: a slug that merely reads like a lookup is protected", () => {
    expect(suggestsRead("ACME_GET_THING")).toBe(true);
    expect(isVerifiedReadTool("ACME_GET_THING")).toBe(false);
    expect(multi([{ tool_slug: "ACME_GET_THING" }])).toBe("protected");
  });

  // Dev-time lint: a verified entry whose name does not read like a lookup, or a
  // write-looking name that slipped in, must be looked at again by a person.
  it("lint: every verified entry is lookup-shaped and none has a write verb", () => {
    const writeVerb = /_(SEND(?!_AS)|CREATE|DELETE|UPDATE|PATCH|INSERT|MODIFY|REMOVE|ADD|MOVE|REPLY|FORWARD|POST|ARCHIVE|TRASH|UNTRASH|SET|UPLOAD|IMPORT)(_|$)/;
    const odd = VERIFIED_READ_TOOLS.filter((entry) => !suggestsRead(entry.tool) || writeVerb.test(entry.tool)).map((entry) => entry.tool);
    expect(odd).toEqual([]);
  });
});

describe("classifyConnectedAppCall", () => {
  it("a batch of verified reads is a read", () => {
    expect(multi([{ tool_slug: "GMAIL_FETCH_EMAILS" }, { tool_slug: "GOOGLECALENDAR_EVENTS_LIST" }])).toBe("read");
  });
  it("any write or unknown tool makes the batch protected", () => {
    expect(multi([{ tool_slug: "GMAIL_FETCH_EMAILS" }, { tool_slug: "GMAIL_SEND_EMAIL" }])).toBe("protected");
    expect(multi([{ tool_slug: "GMAIL_FETCH_EMAILS" }, { tool_slug: "NOPE_X" }])).toBe("protected");
    expect(multi([{ tool_slug: "GMAIL_FETCH_EMAILS" }, {}])).toBe("protected");
    expect(multi([])).toBe("protected");
  });
  it("workbench sync and non-execute tools are protected", () => {
    expect(multi([{ tool_slug: "GMAIL_FETCH_EMAILS" }], { sync_response_to_workbench: true })).toBe("protected");
    expect(classifyConnectedAppCall("COMPOSIO_REMOTE_WORKBENCH", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }] })).toBe("protected");
    expect(classifyConnectedAppCall("COMPOSIO_REMOTE_BASH_TOOL", { command: "ls" })).toBe("protected");
    expect(classifyConnectedAppCall("COMPOSIO_MULTI_EXECUTE_TOOL", null)).toBe("protected");
    expect(classifyConnectedAppCall("GMAIL_FETCH_EMAILS", { query: "x" })).toBe("protected");
  });
  it("a wrapped call is classified by what it wraps", () => {
    expect(classifyConnectedAppCall("use_tool", { tool_name: "COMPOSIO_MULTI_EXECUTE_TOOL", tool_input: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }] } })).toBe("read");
    expect(classifyConnectedAppCall("use_tool", { tool_name: "COMPOSIO_MULTI_EXECUTE_TOOL", tool_input: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] } })).toBe("protected");
    expect(classifyConnectedAppCall("use_tool", { tool_name: "COMPOSIO_REMOTE_WORKBENCH", tool_input: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }] } })).toBe("protected");
  });
  it("engine-namespaced names classify the same", () => {
    expect(classifyConnectedAppCall("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: "GMAIL_LIST_LABELS" }] })).toBe("read");
  });
});
