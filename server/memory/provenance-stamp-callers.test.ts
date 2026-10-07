import { expect, it } from "vitest";
import { scanCallers } from "./provenance-stamp.ts";

it("names the functions above the scan, skipping the scan itself", () => {
  const stack = ["Error", "    at scanCallers (/a/p.ts:1:1)", "    at identitySourceSet (/a/p.ts:2:1)",
    "    at sourceIsIdentity (/a/skills.ts:3:1)", "    at checkSkillProcedureEvidence (/a/skills.ts:4:1)", "    at node:internal/x (node:internal/y:1:1)"].join("\n");
  expect(scanCallers(stack)).toBe("sourceIsIdentity<checkSkillProcedureEvidence");
  expect(scanCallers("")).toBe("unknown");
});
it("works on a real stack", () => { function outerCaller() { return scanCallers(); } expect(outerCaller()).toContain("outerCaller"); });
