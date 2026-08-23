import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  systemPreferences: { isTrustedAccessibilityClient: () => true },
}));

const { compileSkillMarkdown, saveSkillRecording, skillSlug } = await import("./skill-recorder.mjs");

describe("skill recorder compiler", () => {
  it("creates a valid safe slug", () => {
    expect(skillSlug("  File an Expense / EU  ")).toBe("file-an-expense-eu");
    expect(skillSlug("💫")).toBe("recorded-workflow");
  });

  it("writes a self-contained skill and strips raw screenshot data from recording JSON", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openmausbot-recording-"));
    const result = saveSkillRecording({
      name: "File an expense",
      description: "Use when submitting a travel receipt",
      durationMs: 4_200,
      transcript: "Choose the matching trip and attach the receipt.",
      events: [{
        type: "click",
        atMs: 800,
        app: "Safari",
        windowTitle: "Expenses",
        screenshot: "data:image/webp;base64,AQIDBA==",
      }],
    }, { dataRoot });

    const skill = readFileSync(path.join(result.path, "SKILL.md"), "utf8");
    const recording = readFileSync(path.join(result.path, "references", "recording.json"), "utf8");
    expect(skill).toContain("name: file-an-expense");
    expect(skill).toContain("recorded frame under the skill root");
    expect(recording).not.toContain("base64");
    expect(existsSync(path.join(result.path, "references", "step-001.webp"))).toBe(true);
  });

  it("tells agents to adapt to current UI instead of replaying coordinates", () => {
    expect(compileSkillMarkdown({
      id: "demo", name: "Demo", description: "Do the task", transcript: "", events: [],
    })).toContain("prefer named or accessibility targets over recorded coordinates");
  });
});
