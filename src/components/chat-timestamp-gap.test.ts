// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// upstream #1938: the hover action tray sat one spacing step from the
// timestamp and covered it. The gap is a class on the timestamp, so the check
// reads the Bubble's source: there is no layout engine in this suite.
describe("message timestamp gap", () => {
  const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
  const timestamp = /className=\{cn\(\s*"self-end pb-1 text-\[11px\][^"]*",\s*user \? "([^"]*)" : "([^"]*)",\s*\)\}\s*>\s*\{formatTime\(message\.at\)\}/.exec(source);

  it("finds the timestamp's spacing classes", () => {
    expect(timestamp).not.toBeNull();
  });

  it("keeps two spacing steps between the timestamp and the action tray, on either side", () => {
    expect(timestamp?.[1]).toContain("mr-2");
    expect(timestamp?.[2]).toContain("ml-2");
    expect(timestamp?.[1]).not.toMatch(/\bmr-1\b/);
    expect(timestamp?.[2]).not.toMatch(/\bml-1\b/);
  });
});
