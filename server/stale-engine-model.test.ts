import { describe, expect, it } from "vitest";
import { LOCAL_CONTROL_OFF_NOTICE, staleModelNotice, staleModelReplacement } from "./stale-engine-model.ts";

const catalog = { default: "gemini-4-argon-high", options: [{ id: "gemini-4-argon-high" }, { id: "gpt-oss-120b-medium" }] };

describe("staleModelReplacement", () => {
  it("replaces an Antigravity model the CLI no longer lists", () => {
    expect(staleModelReplacement("antigravity", "gemini-3.1-pro-high", catalog)).toBe("gemini-4-argon-high");
  });
  it("keeps a listed model, an empty catalog and an unsaved model", () => {
    expect(staleModelReplacement("antigravity", "gpt-oss-120b-medium", catalog)).toBeNull();
    expect(staleModelReplacement("antigravity", "gemini-3.1-pro-high", { default: "x", options: [] })).toBeNull();
    expect(staleModelReplacement("antigravity", undefined, catalog)).toBeNull();
  });
  it("never touches engines that accept custom ids", () => {
    for (const kind of ["claude", "codex", "opencode", "pi", "grok"]) expect(staleModelReplacement(kind, "my-custom-id", catalog)).toBeNull();
  });
});

describe("notices", () => {
  it("say what changed and where to change it, without banned words", () => {
    const a = staleModelNotice("antigravity", "gemini-3.1-pro-high", "gemini-4-argon-high");
    expect(a).toBe("Antigravity no longer offers gemini-3.1-pro-high; this bot now uses gemini-4-argon-high. Change it in Settings if you prefer another model.");
    for (const t of [a, LOCAL_CONTROL_OFF_NOTICE]) expect(t).not.toMatch(/—|\bsafe|safety|unsafe/i);
    expect(LOCAL_CONTROL_OFF_NOTICE).toContain("Settings > Computer");
  });
});
