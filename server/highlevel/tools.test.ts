// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { HIGHLEVEL_HELPER_NAMES, HIGHLEVEL_TOOL_NAMES } from "../../shared/highlevel.ts";
import { advertisedTool, checkToolArguments, ENFORCED_KEYWORDS, HIGHLEVEL_TOOLS } from "./tools.ts";

/** A schema with the bound keywords removed: what the advertised schema may differ by, and nothing else. */
function withoutBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutBounds);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).filter(([key]) => !(ENFORCED_KEYWORDS as readonly string[]).includes(key)).map(([key, value]) => [key, withoutBounds(value)]));
}

function closed(node: unknown, at = "schema"): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  if (record.type === "object" && record.properties) expect(record.additionalProperties, at).toBe(false);
  for (const [key, value] of Object.entries(record)) closed(value, `${at}.${key}`);
}

describe("HighLevel tool schemas (GAP-HIGHLEVEL-109 section 7)", () => {
  it("advertises the golden list: the twenty tools in order, then the two helpers", () => {
    expect(HIGHLEVEL_TOOLS.map((tool) => tool.name)).toEqual([...HIGHLEVEL_TOOL_NAMES, ...HIGHLEVEL_HELPER_NAMES]);
  });

  it("advertises compact schemas that differ from the full ones only by enforced bounds, and stay closed", () => {
    let full = 0, compact = 0;
    for (const tool of HIGHLEVEL_TOOLS) {
      const advertised = advertisedTool(tool);
      expect(advertised.name).toBe(tool.name);
      expect(withoutBounds(advertised.inputSchema)).toEqual(withoutBounds(tool.inputSchema));
      closed(advertised.inputSchema, tool.name);
      full += JSON.stringify(tool.inputSchema).length;
      compact += JSON.stringify(advertised.inputSchema).length;
    }
    expect(compact).toBeLessThan(full);
    // a generous cap leaves the advertised schema; a tight one stays
    const search = advertisedTool(HIGHLEVEL_TOOLS.find((tool) => tool.name === "HIGHLEVEL_SEARCH_CONTACTS")!).inputSchema as { properties: Record<string, Record<string, unknown>> };
    expect(search.properties.query!.maxLength).toBeUndefined();
    expect(search.properties.phone!.maxLength).toBe(50);
  });

  it("every CRM tool takes an optional connectionId and nothing that names a credential, address or request part", () => {
    for (const tool of HIGHLEVEL_TOOLS) {
      const properties = Object.keys((tool.inputSchema as { properties: object }).properties);
      if ((HIGHLEVEL_TOOL_NAMES as readonly string[]).includes(tool.name)) expect(properties).toContain("connectionId");
      for (const name of properties) expect(name).not.toMatch(/token|auth|url|header|path|attachment|secret|key$/iu);
    }
  });

  it("accepts a call that fits its full schema", () => {
    expect(checkToolArguments("HIGHLEVEL_SEARCH_CONTACTS", { query: "ada", limit: 10 })).toBeNull();
    expect(checkToolArguments("HIGHLEVEL_UPDATE_CONTACT", { contactId: "contact_1", connectionId: "hl_conn_1", customFields: { "Lead source": "Referral" }, tags: ["vip"] })).toBeNull();
    expect(checkToolArguments("HIGHLEVEL_LIST_PIPELINES", {})).toBeNull();
    expect(checkToolArguments("HIGHLEVEL_ACTION_STATUS", { actionId: "hla_1234-abcd" })).toBeNull();
  });

  it("refuses extra fields, URLs, headers, paths and credentials at any depth", () => {
    const refused: Array<[string, Record<string, unknown>]> = [
      ["HIGHLEVEL_GET_CONTACT", { contactId: "c1", extra: 1 }],
      ["HIGHLEVEL_GET_CONTACT", { contactId: "c1", url: "https://evil.test" }],
      ["HIGHLEVEL_GET_CONTACT", { contactId: "c1", headers: { authorization: "Bearer x" } }],
      ["HIGHLEVEL_GET_CONTACT", { contactId: "c1", path: "/conversations/messages" }],
      ["HIGHLEVEL_GET_CONTACT", { contactId: "c1", authorization: "Bearer abc" }],
      ["HIGHLEVEL_LIST_PIPELINES", { access_token: "pit-123" }],
      ["HIGHLEVEL_UPDATE_CONTACT", { contactId: "c1", customFields: { url: "https://evil.test" } }],
      ["HIGHLEVEL_UPDATE_CONTACT", { contactId: "c1", customFields: { Authorization: "Bearer x" } }],
      ["HIGHLEVEL_ADD_NOTE", { contactId: "c1", body: "x", attachments: ["https://evil.test/a.pdf"] }],
    ];
    for (const [name, args] of refused) expect(checkToolArguments(name, args), `${name} ${JSON.stringify(args)}`).toMatch(/was not run/u);
  });

  it("holds every call to the bounds the advertised schema leaves out", () => {
    expect(checkToolArguments("HIGHLEVEL_SEARCH_CONTACTS", { query: "x".repeat(501) })).toMatch(/at most 500/u);
    expect(checkToolArguments("HIGHLEVEL_SEARCH_CONTACTS", { page: 1_001 })).toMatch(/at most 1000/u);
    expect(checkToolArguments("HIGHLEVEL_SEARCH_CONTACTS", { limit: 0 })).toMatch(/at least 1/u);
    expect(checkToolArguments("HIGHLEVEL_ADD_TAGS", { contactId: "c1", tags: [] })).toMatch(/must not be empty/u);
    expect(checkToolArguments("HIGHLEVEL_ADD_TAGS", { contactId: "c1", tags: Array.from({ length: 51 }, (_, i) => `t${i}`) })).toMatch(/at most 50 items/u);
    expect(checkToolArguments("HIGHLEVEL_UPDATE_CONTACT", { contactId: "c1", customFields: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, "v"])) })).toMatch(/at most 50 fields/u);
  });

  it("refuses ids that could change the request path, wrong types and unknown tools", () => {
    for (const contactId of ["..", ".", "../conversations", "a/b", "a?b", "a#b", "%2e%2e", ""]) {
      expect(checkToolArguments("HIGHLEVEL_GET_CONTACT", { contactId }), contactId).toMatch(/was not run/u);
    }
    expect(checkToolArguments("HIGHLEVEL_GET_CONTACT", {})).toMatch(/contactId is required/u);
    expect(checkToolArguments("HIGHLEVEL_GET_CONTACT", { contactId: 5 })).toMatch(/must be string/u);
    expect(checkToolArguments("HIGHLEVEL_SEARCH_OPPORTUNITIES", { status: "deleted" })).toMatch(/one of/u);
    expect(checkToolArguments("HIGHLEVEL_GET_CONTACT", { contactId: "c1", connectionId: "conn_1" })).toMatch(/was not run/u);
    expect(checkToolArguments("HIGHLEVEL_SEND_SMS", {})).toMatch(/Unknown HighLevel tool/u);
    expect(checkToolArguments("HIGHLEVEL_GET_CONTACT", ["c1"])).toMatch(/must be an object/u);
  });
});
