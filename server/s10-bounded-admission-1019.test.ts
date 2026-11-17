import { describe, expect, it } from "vitest";
import { autoVerdict } from "./auto-approve.ts";

const AUTO = { id: "bounded-admission", autoApprove: true };
const FULL = { ...AUTO, fullAccess: true };
const NO_LIMITS = { ...FULL, noLimits: true };
const command = "echo harmless\n".repeat(1300);
const owner = { ownerStarted: true, fullAccessOrigin: "owner" as const, stopLine: null, outsideRead: null };

describe("S10 bounded admission before grants and readers", () => {
  it.each(["summary", "exact", "arguments"] as const)("Auto holds the whole %s command before any grant", source => {
    const context = { ...owner, grants: ["*"], ...(source === "exact" ? { exactCommand: { command } }
      : source === "arguments" ? { call: { toolCall: { name: "shell", input: { command } }, toolKind: "command" } } : {}) };
    const verdict = autoVerdict(AUTO, "shell", source === "summary" ? command : "echo harmless", context as never);
    expect(verdict.approve).toBeNull();
    expect(verdict.rule).toBe("unreadable");
    expect(verdict.note).toContain("longer than Murage reads");
  });
  it("Full access holds text past the full-read ceiling", () => {
    const verdict = autoVerdict(FULL, "shell", "echo harmless", { ...owner, exactCommand: { command: command.repeat(9) } } as never);
    expect(verdict.approve).toBeNull();
    expect(verdict.rule).toBe("unreadable");
    expect(verdict.note).toContain("longer than Murage reads");
  });
  it("the current No limits path admits an ordinary long command", () => {
    const verdict = autoVerdict(NO_LIMITS, "shell", "echo harmless", { ...owner, exactCommand: { command } } as never);
    expect(verdict.approve).not.toBeNull();
    expect(verdict.source).toBe("no-limits");
  });
  it("a short ordinary command still runs at Auto", () => {
    expect(autoVerdict(AUTO, "shell", "echo harmless", { ...owner, exactCommand: { command: "echo harmless" } } as never).approve).not.toBeNull();
  });
});
