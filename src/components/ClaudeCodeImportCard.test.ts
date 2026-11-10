import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: vi.fn() }));
vi.mock("@/lib/settings-words", () => ({ sw: (key: string) => key }));
vi.mock("./SettingsPrimitives", () => ({ Card: () => null, Switch: () => null }));

import { claudeCodeImportErrorKey } from "./ClaudeCodeImportCard";
import words from "@/locales/en-settings/settings.json";

describe("Claude Code import recovery copy", () => {
  it("explains a linked Claude Code folder without displaying a source path", () => {
    const key = claudeCodeImportErrorKey({ body: { code: "source-linked", error: "/private/source" } });
    expect(key).toBe("settings.claudeCode.linkedFiles");
    expect(words[key as keyof typeof words]).toBe("Claude Code files are reached through a link, so Murage did not read them.");
  });

  it("asks for a new review when the bound review cannot be used", () => {
    const key = claudeCodeImportErrorKey({ body: { code: "review-required" } });
    expect(key).toBe("settings.claudeCode.reviewRequired");
    expect(words[key as keyof typeof words]).toContain("Review again");
  });

  it("reports incomplete rollback without claiming no changes", () => {
    const key = claudeCodeImportErrorKey({ body: { code: "partly-undone", notUndone: [{ kind: "skill", name: "alpha" }] } });
    expect(key).toBe("settings.claudeCode.partlyUndone");
    expect(words[key as keyof typeof words]).toContain("could not be undone");
    expect(words[key as keyof typeof words]).not.toContain("Nothing was changed");
  });

  it.each([new Error("connection lost"), null, {}, { body: null }])("does not promise rollback after an unknown or lost response: %s", (error) => {
    const key = claudeCodeImportErrorKey(error);
    expect(key).toBe("settings.claudeCode.importFailed");
    expect(words[key as keyof typeof words]).not.toContain("Nothing was changed");
    expect(words[key as keyof typeof words]).toContain("Review again");
  });
});
