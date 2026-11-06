// B43 grant presets: explicit slugs from one toolkit, no wildcard, empty rows removed.
import { describe, expect, it } from "vitest";
import { accessGrantSchema, CONNECTED_APP_TOOLS, GRANT_PRESETS, presetTools, withAccountTools, type AccessGrant } from "./bot-access";

const writes = new Set<string>(CONNECTED_APP_TOOLS.filter((entry) => entry.writes).map((entry) => entry.tool));
const ofToolkit = (toolkit: string) => new Set<string>(CONNECTED_APP_TOOLS.filter((entry) => entry.toolkit === toolkit).map((entry) => entry.tool));

describe("presetTools", () => {
  it("has exactly the read and all presets", () => {
    expect(Object.keys(GRANT_PRESETS).sort()).toEqual(["all", "read"]);
  });
  it("gmail read holds read tools only, and never a tool that changes data", () => {
    const tools = presetTools("gmail", "read");
    expect(tools).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE"]);
    for (const tool of tools) expect(writes.has(tool)).toBe(false);
  });
  it("all is every catalog tool of that toolkit and nothing from another toolkit", () => {
    for (const toolkit of ["gmail", "slack", "googlecalendar"]) {
      for (const preset of ["read", "all"] as const) {
        const tools = presetTools(toolkit, preset);
        for (const tool of tools) expect(ofToolkit(toolkit).has(tool)).toBe(true);
      }
      expect(new Set(presetTools(toolkit, "all"))).toEqual(ofToolkit(toolkit));
    }
  });
  it("returns explicit slugs only: no wildcard, and every slug passes the grant schema", () => {
    for (const toolkit of ["gmail", "slack", "googlecalendar", "unknown"]) for (const preset of ["read", "all"] as const) {
      const tools = presetTools(toolkit, preset);
      expect(tools.some((tool) => tool.includes("*"))).toBe(false);
      if (tools.length) expect(accessGrantSchema.safeParse({ toolkit, accountId: "ca_1", tools }).success).toBe(true);
    }
    expect(presetTools("unknown", "all")).toEqual([]);
  });
  it("the grant schema refuses a wildcard tool", () => {
    expect(accessGrantSchema.safeParse({ toolkit: "gmail", accountId: "ca_1", tools: ["*"] }).success).toBe(false);
    expect(accessGrantSchema.safeParse({ toolkit: "gmail", accountId: "ca_1", tools: ["GMAIL_*"] }).success).toBe(false);
  });
});

describe("withAccountTools", () => {
  const gmail = { toolkit: "gmail", accountId: "ca_g" };
  const other: AccessGrant = { toolkit: "googlecalendar", accountId: "ca_c", tools: ["GOOGLECALENDAR_LIST_EVENTS"] };
  it("sets the account's row to exactly the expansion and keeps other accounts' rows", () => {
    const start: AccessGrant[] = [{ ...gmail, tools: ["GMAIL_SEND_EMAIL"] }, other];
    expect(withAccountTools(start, gmail, presetTools("gmail", "read"))).toEqual([{ ...gmail, tools: ["GMAIL_FETCH_EMAILS", "GMAIL_GET_PROFILE"] }, other]);
    expect(withAccountTools([other], gmail, ["GMAIL_FETCH_EMAILS"])).toEqual([other, { ...gmail, tools: ["GMAIL_FETCH_EMAILS"] }]);
  });
  it("collapses duplicate rows for the account into one", () => {
    const start: AccessGrant[] = [{ ...gmail, tools: ["GMAIL_SEND_EMAIL"] }, other, { ...gmail, tools: ["GMAIL_GET_PROFILE"] }];
    expect(withAccountTools(start, gmail, ["GMAIL_FETCH_EMAILS"])).toEqual([{ ...gmail, tools: ["GMAIL_FETCH_EMAILS"] }, other]);
  });
  it("an empty expansion removes the row, so no tools: [] is ever produced", () => {
    const slack = { toolkit: "slack", accountId: "ca_s" };
    const start: AccessGrant[] = [{ ...slack, tools: ["SLACK_SEND_MESSAGE"] }, other];
    const next = withAccountTools(start, slack, presetTools("slack", "read"));
    expect(next).toEqual([other]);
    expect(next.some((grant) => grant.tools.length === 0)).toBe(false);
  });
});
