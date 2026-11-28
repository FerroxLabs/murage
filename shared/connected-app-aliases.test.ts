// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F11-V3 (1.0.23): the pure resolver and the name-only readers (witnesses W2, the pure half of W4 and W7).
import { describe, expect, it } from "vitest";
import { CONNECTED_APP_TOOLS } from "./bot-access.ts";
import { connectedAppActionCall, connectedAppCallTimeoutMs } from "./connected-app-calls.ts";
import { canonicalConnectedAppToolName } from "./connected-app-names.ts";
import { ownAppTool } from "./app-action-words.ts";
import { aliasCall, aliasMessage, CONNECTED_APP_ALIASES, forbiddenAuthArguments, isAliasName } from "./connected-app-aliases.ts";
import { classifyAsk, type StopLinePlace } from "../server/stop-line.ts";
import { namesBareAlias } from "../server/connector-aliases.ts";

const place: StopLinePlace = { cwd: "/tmp/x", roots: ["/tmp/x"], home: "/Users/ada", knownRecipients: new Set(), realpath: (p: string) => p };

describe("the alias table is derived from the catalog, with no other entries", () => {
  it("one alias per catalog row, lower case", () => {
    expect([...CONNECTED_APP_ALIASES.keys()].sort()).toEqual(CONNECTED_APP_TOOLS.map((row) => row.tool.toLowerCase()).sort());
    expect([...CONNECTED_APP_ALIASES.keys()].sort()).toEqual(["gmail_fetch_emails", "gmail_get_profile", "gmail_send_email", "googlecalendar_list_events", "slack_send_message"]);
  });
});

describe("aliasCall: pure, exact, the same for every caller", () => {
  const ok = { account: "acct_a", arguments: { recipient_email: "a@x.com" } };
  it("returns the canonical execute body, arguments unchanged", () => {
    const called = aliasCall("gmail_send_email", ok);
    expect(called).toEqual({ body: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: "acct_a", arguments: { recipient_email: "a@x.com" } }], sync_response_to_workbench: false } });
    expect((called as { body: { tools: Array<{ arguments: unknown }> } }).body.tools[0]!.arguments).toBe(ok.arguments);
  });
  it("is undefined for anything that is not exactly an alias", () => {
    for (const name of ["GMAIL_SEND_EMAIL", "Gmail_Send_Email", "gmail_send_email ", "mcp__murage_connectors__gmail_send_email", "gmail__send_email", "gmail_search"]) expect(aliasCall(name, ok), name).toBeUndefined();
    expect(isAliasName("gmail_send_email")).toBe(true);
    expect(isAliasName("Gmail_send_email")).toBe(false);
  });
  it("refuses a shape or account it cannot read whole, with the existing wording", () => {
    const shape = "its list of actions is missing, empty or not in the shape Murage reads";
    expect(aliasCall("gmail_send_email", { arguments: {} })).toEqual({ refused: shape });
    expect(aliasCall("gmail_send_email", { account: "a", arguments: {}, extra: 1 })).toEqual({ refused: shape });
    expect(aliasCall("gmail_send_email", { account: "a", arguments: [] })).toEqual({ refused: shape });
    expect(aliasCall("gmail_send_email", "x")).toEqual({ refused: shape });
    const account = "action 1 names an account Murage cannot read";
    for (const bad of ["", "a b", "x".repeat(181), 5, null]) expect(aliasCall("gmail_send_email", { account: bad, arguments: {} }), String(bad)).toEqual({ refused: account });
  });
  it("W7 refuses an account override anywhere inside `arguments`, in every mode (the call alone decides)", () => {
    const field = "action 1 carries a field Murage does not read";
    for (const args of [{ connected_account_id: "b" }, { nested: { account: "b" } }, { list: [{ authorization: "x" }] }, { api_key: "k" }, { user_id: "someone" }]) {
      expect(aliasCall("gmail_send_email", { account: "a", arguments: args }), JSON.stringify(args)).toEqual({ refused: field });
    }
    expect(aliasCall("gmail_send_email", { account: "a", arguments: { user_id: "me" } })).toHaveProperty("body");
    // a non-gmail slug may carry a user_id of its own
    expect(aliasCall("slack_send_message", { account: "a", arguments: { user_id: "U1" } })).toHaveProperty("body");
    // the guard reads `arguments`, never the alias input, which needs `account` (Opus L2)
    expect(aliasCall("gmail_send_email", { account: "a", arguments: {} })).toHaveProperty("body");
    // a structure past the depth cap is refused, not walked forever
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 400; i++) deep = { n: deep };
    expect(forbiddenAuthArguments(deep)).toBe(true);
  });
  it("is pure: the same literal call gives a byte-identical body (restart dedupe, W10)", () => {
    expect(JSON.stringify(aliasCall("gmail_send_email", ok))).toBe(JSON.stringify(aliasCall("gmail_send_email", { ...ok })));
  });
  it("aliasMessage keeps the id and params._meta, and names the service's execute tool", () => {
    const out = aliasMessage({ id: 7, params: { name: "gmail_send_email", arguments: ok, _meta: { progressToken: "p" } } }) as { message: Record<string, any> };
    expect(out, "an alias call is rewritten").toBeDefined();
    expect(out.message).toMatchObject({ id: 7, method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", _meta: { progressToken: "p" } } });
    expect(aliasMessage({ id: 1, params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: {} } })).toBeUndefined();
    expect(aliasMessage({ id: 1, params: { name: "gmail_send_email", arguments: {} } })).toHaveProperty("refused");
  });
});

describe("W2 name-only readers never learn aliases", () => {
  it("canonicalConnectedAppToolName and ownAppTool leave a bare, dotted or foreign alias name alone", () => {
    for (const name of ["gmail_send_email", "gmail.send_email", "mcp__other__gmail_send_email", "other__gmail_send_email"]) {
      expect(canonicalConnectedAppToolName(name), name).toBe(name);
      expect(ownAppTool(name), name).toBeUndefined();
    }
  });
  it("an own-prefixed alias that no own-mount record proves stops as unreadable; a bare one (a custom server's own tool) does not", () => {
    // no engine facts at all: the name reader alone would have let the read alias through before F11-V3
    const unproven = classifyAsk({ tool: "mcp__murage_connectors__gmail_fetch_emails", summary: "x", toolCall: { name: "mcp__murage_connectors__gmail_fetch_emails", input: { account: "a", arguments: {} } } }, place);
    expect(unproven).toMatchObject({ kind: "delete", what: "Murage could not read this call whole, so it is waiting for you." });
    const bare = classifyAsk({ tool: "gmail_send_email", summary: "x", toolCall: { name: "gmail_send_email", input: { to: "a@x.com" } } }, place);
    expect(bare?.what ?? "").not.toBe("Murage could not read this call whole, so it is waiting for you.");
  });
});

describe("the relay never forwards a bare alias name", () => {
  it("is seen in a single call and inside a batch, and never for the execute tool", () => {
    const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
    expect(namesBareAlias(call("gmail_send_email"))).toBe(true);
    expect(namesBareAlias([call("COMPOSIO_MULTI_EXECUTE_TOOL"), call("slack_send_message")])).toBe(true);
    expect(namesBareAlias(call("COMPOSIO_MULTI_EXECUTE_TOOL"))).toBe(false);
    expect(namesBareAlias({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(false);
  });
});

describe("W12 (no regression, green on base by design) a plain-name send keeps the action timeout class after the rewrite", () => {
  it("the rewritten message is an action call with the 120 s limit, and a read alias is no lookup", () => {
    for (const alias of ["gmail_send_email", "slack_send_message", "gmail_fetch_emails"]) {
      const out = aliasMessage({ id: 3, params: { name: alias, arguments: { account: "a", arguments: {} } } }) as { message: Record<string, unknown> };
      expect(out, `${alias} is rewritten`).toBeDefined();
      expect(connectedAppCallTimeoutMs(out.message as never), alias).toBe(120_000);
      expect(connectedAppActionCall(out.message as never), alias).not.toBeNull();
    }
  });
});
