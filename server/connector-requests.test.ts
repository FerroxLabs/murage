import { describe, expect, it } from "vitest";
import { connectorRequestKey, connectorRequestStatus, parseConnectorRequests } from "./connector-requests.ts";

describe("account-scoped connector requests", () => {
  it("preserves legacy requests and deduplicates canonical account identities", () => {
    expect(parseConnectorRequests({ slugs: [" GMAIL ", "gmail"] })).toEqual([{ slug: "gmail" }]);
    expect(parseConnectorRequests({ items: [
      { slug: "GMAIL", alias: " Work " }, { toolkit: "gmail", account: "work" },
      { slug: "gmail", alias: "Personal" }, "gmail",
    ], slugs: ["ignored"] })).toEqual([
      { slug: "gmail", alias: "Work" }, { slug: "gmail", alias: "Personal" }, { slug: "gmail" },
    ]);
    expect(connectorRequestKey({ slug: "gmail", alias: "Work" })).not.toBe(connectorRequestKey({ slug: "gmail", alias: "Personal" }));
  });

  it("uses the existing alias validation instead of silently dropping invalid account intent", () => {
    for (const alias of [123, " ", "\ninvalid", "x".repeat(65)]) {
      // Leading whitespace is normalized by Composio, so use an embedded control character.
      const value = alias === "\ninvalid" ? "in\nvalid" : alias;
      expect(() => parseConnectorRequests({ items: [{ slug: "gmail", alias: value }] })).toThrow(/Account alias/);
    }
  });

  it("cannot complete a second-account card from first-account readiness or missing inventory", () => {
    const first = { connected: true, pending: false, status: "ACTIVE", accounts: [{ alias: "Personal", status: "ACTIVE" }] };
    expect(connectorRequestStatus(first, "Work")).toEqual({ connected: false, pending: false, status: "not_connected" });
    expect(connectorRequestStatus({ ...first, accounts: undefined }, "Work").connected).toBe(false);
    expect(connectorRequestStatus(first).connected).toBe(true);
    expect(connectorRequestStatus({ ...first, accounts: [...first.accounts, { alias: " WORK ", status: "INITIATED" }] }, "work")).toEqual({ connected: false, pending: true, status: "INITIATED" });
    expect(connectorRequestStatus({ ...first, accounts: [...first.accounts, { alias: " WORK ", status: "ACTIVE" }] }, "work").connected).toBe(true);
  });
});
