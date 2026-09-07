import { expect, it } from "vitest";
import { approvalHoldNote } from "./auto-approve.ts";
it("names the real blocker without altering approval semantics", () => {
  expect(approvalHoldNote({ approve: null, source: "sensitive-guard" })).toContain("sensitive");
  expect(approvalHoldNote({ approve: null, source: "unattended-block" })).toContain("outside the desktop");
  expect(approvalHoldNote({ approve: null, source: "destructive-guard" })).toContain("destructive");
  expect(approvalHoldNote({ approve: null, source: "local-computer-block" })).toContain("controls your computer");
  expect(approvalHoldNote({ approve: "allowed", source: "auto-mode" })).toBeUndefined();
  expect(approvalHoldNote({ approve: null, source: "no-grant" })).toBeUndefined();
});
