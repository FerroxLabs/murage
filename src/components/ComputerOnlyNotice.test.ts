import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComputerOnlyNotice } from "./ComputerOnlyNotice";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("ComputerOnlyNotice", () => {
  it("says to approve on the computer or in the app, and offers no button", () => {
    const markup = renderToStaticMarkup(createElement(ComputerOnlyNotice, {}));
    expect(markup).toContain("Approve this on your computer or in the Murage app");
    expect(markup).not.toMatch(/<button/i);
    expect(markup).not.toMatch(/Allow/);
  });
});

describe("the two places a phone allows a card use it", () => {
  it("PendingApprovalActions swaps every Allow button for the notice and keeps Deny", () => {
    const source = read("./PendingApproval.tsx");
    expect(source).toContain("allowNeedsComputer(");
    expect(source).toContain("<ComputerOnlyNotice");
    const guard = source.indexOf("{!computerOnly && (");
    expect(guard).toBeGreaterThan(-1);
    const deny = source.indexOf('onClick={() => decide("deny", "deny")}');
    expect(deny).toBeGreaterThan(-1);
    expect(deny).toBeLessThan(guard);
    expect(source.indexOf('onClick={() => decide("allow", "allow")}')).toBeGreaterThan(guard);
  });
  it("InboxRequestAnswer does the same for an approval and still allows a question to be answered", () => {
    const source = read("./InboxRequest.tsx");
    expect(source).toContain("allowNeedsComputer(");
    expect(source).toContain("<ComputerOnlyNotice");
    expect(source.indexOf("{!computerOnly && (")).toBeGreaterThan(source.indexOf("Open the request to see exactly"));
  });
});
