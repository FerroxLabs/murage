import { describe, expect, it } from "vitest";
import { LOCAL_CONTROL_OFF_NOTICE, staleModelNotice, staleModelReplacement } from "./stale-engine-model.ts";

import { readFileSync } from "node:fs";
const catalog = { source: "live" as const, default: "gemini-4-argon-high", options: [{ id: "gemini-4-argon-high" }, { id: "gpt-oss-120b-medium" }] };

describe("staleModelReplacement", () => {
  it("replaces an Antigravity model the CLI no longer lists", () => {
    expect(staleModelReplacement("antigravity", "gemini-3.1-pro-high", catalog)).toBe("gemini-4-argon-high");
  });
  it("keeps a listed model, an empty catalog and an unsaved model", () => {
    expect(staleModelReplacement("antigravity", "gpt-oss-120b-medium", catalog)).toBeNull();
    expect(staleModelReplacement("antigravity", "gemini-3.1-pro-high", { source: "live" as const, default: "x", options: [] })).toBeNull();
    expect(staleModelReplacement("antigravity", undefined, catalog)).toBeNull();
  });
  it("covers opencodeGo and cursorAgent, whose CLIs reject unlisted ids", () => {
    expect(staleModelReplacement("opencodeGo", "opencode/x-preview-f-free", { source: "live" as const, default: "opencode/beam-free", options: [{ id: "opencode/beam-free" }] })).toBe("opencode/beam-free");
    expect(staleModelReplacement("cursorAgent", "gone", { source: "live" as const, default: "auto", options: [{ id: "auto" }] })).toBe("auto");
    expect(staleModelReplacement("opencodeGo", "opencode/beam-free", { source: "live" as const, default: "opencode/beam-free", options: [{ id: "opencode/beam-free" }] })).toBeNull();
  });
  it("acts only on a live list: a failed probe or built-in list rewrites nothing", () => {
    for (const kind of ["antigravity", "opencodeGo", "cursorAgent"]) {
      expect(staleModelReplacement(kind, "gone/model", { default: "a/b", options: [{ id: "a/b" }], source: "static" })).toBeNull();
      expect(staleModelReplacement(kind, "gone/model", { default: "a/b", options: [{ id: "a/b" }] })).toBeNull();
    }
  });
  it("opencodeGo: a custom provider survives a live list, x-preview-f-free still migrates", () => {
    const live = { source: "live" as const, default: "opencode/beam-free", options: [{ id: "opencode/beam-free" }, { id: "openrouter/vendor/m" }] };
    expect(staleModelReplacement("opencodeGo", "mycorp/private-model", live)).toBeNull();
    expect(staleModelReplacement("opencodeGo", "opencode/x-preview-f-free", live)).toBe("opencode/beam-free");
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

describe("wiring in index.ts", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  it("patches the thread's selection next to the bot's, and clears the local-control note when the destination leaves local", () => {
    expect(src).toMatch(/store\.patchBot\(bot\.id, \{ modelSelection: switched \}\);\s*[^\n]*\n\s*store\.patchTask\(bot\.id, threadId, \{ modelSelection: switched \}\)/);
    expect(src).toMatch(/existingBot\?\.computer === "local" && body\.computer !== undefined && body\.computer !== "local"\) \{\s*if \(existingBot\.localControlOffNoted\) patch\.localControlOffNoted = false;/);
  });
});

describe("the real Antigravity driver kind", () => {
  it("is covered: a retired model on the registered driver is replaced, with its notice", async () => {
    const { BUILT_IN_DRIVERS } = await import("./drivers/builtIn.ts");
    const kind = BUILT_IN_DRIVERS.find((driver) => driver.metadata.displayName === "Google Gemini (Antigravity)")!.driverKind;
    expect(kind).toBe("antigravityAgent");
    expect(staleModelReplacement(kind, "gemini-3.1-pro-high", catalog)).toBe("gemini-4-argon-high");
    expect(staleModelNotice(kind, "a", "b")).toMatch(/^Antigravity no longer offers a;/);
  });
});
