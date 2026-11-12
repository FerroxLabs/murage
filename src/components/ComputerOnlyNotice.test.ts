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
    // APPROVAL-ONE-CARD: Deny and Run are built once and placed on the panel
    // and in the phone's Details sheet; every place Run goes sits behind the guard.
    expect(source).toContain('onClick={() => { decide("deny", "deny"); after?.(); }}');
    expect(source).toContain('onClick={() => { decide("allow", "allow"); after?.(); }}');
    // de0e1d65ee adds the refused HighLevel review to the same deny-only guard.
    expect(source).toContain('const allowHidden = computerOnly || highlevelReview?.phase === "refused";');
    const guard = source.indexOf("{!allowHidden && (");
    expect(guard).toBeGreaterThan(-1);
    const deny = source.indexOf("{denyButton()}");
    expect(deny).toBeGreaterThan(-1);
    expect(deny).toBeLessThan(guard);
    // the two places Run is put (its definition reads "runButton = (")
    const used = [...source.matchAll(/runButton\(/g)].map((match) => match.index!);
    expect(used).toHaveLength(2);
    expect(source.slice(guard, used[0])).not.toContain("</span>");
    expect(source).toContain("{!allowHidden && runButton(closeSheet)}");
    expect(source.indexOf("{!allowHidden && runButton(closeSheet)}") + "{!allowHidden && ".length).toBe(used[1]);
  });
  it("InboxRequestAnswer does the same for an approval and still allows a question to be answered", () => {
    const source = read("./InboxRequest.tsx");
    expect(source).toContain("allowNeedsComputer(");
    expect(source).toContain("<ComputerOnlyNotice");
    expect(source.indexOf("{!computerOnly && (")).toBeGreaterThan(source.indexOf("Open the request to see exactly"));
  });
});
