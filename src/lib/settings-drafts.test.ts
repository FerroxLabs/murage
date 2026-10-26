// SPDX-License-Identifier: AGPL-3.0-or-later
// Release finding 12-B2: House rules and About me kept their words in the editor's own state, so a search keystroke, a page change, the
// backdrop, Escape and the close button all threw away unsaved typing with no question. The words are kept past the editor now, and
// closing asks first.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSettingsDraftStore, DISCARD_SETTINGS_CHANGES } from "./settings-drafts";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

describe("unsaved settings words", () => {
  it("are kept while they differ from the saved text and forgotten when they match it", () => {
    const store = createSettingsDraftStore();
    store.remember("house-rules", "my rules", "old rules");
    expect(store.anyUnsaved()).toBe(true);
    expect(store.recall("house-rules", "old rules")).toBe("my rules");
    store.remember("house-rules", "old rules", "old rules");
    expect(store.anyUnsaved()).toBe(false);
    expect(store.recall("house-rules", "old rules")).toBeNull();
  });
  it("are not handed back over saved text that changed under them", () => {
    const store = createSettingsDraftStore();
    store.remember("about-me", "draft", "saved v1");
    expect(store.recall("about-me", "saved v2")).toBeNull();
  });
  it("clear when the person discards", () => {
    const store = createSettingsDraftStore();
    store.remember("a", "x", "y");
    store.remember("b", "x", "y");
    store.clear();
    expect(store.anyUnsaved()).toBe(false);
  });
});

describe("the settings window", () => {
  it("restores kept words in both editors and asks before every way of closing", () => {
    expect(read("../components/HouseRulesSettings.tsx")).toContain("settingsDrafts.recall(DRAFT_KEY, rules.text)");
    expect(read("../components/AboutMeSettings.tsx")).toContain("settingsDrafts.recall(DRAFT_KEY, about.text)");
    const modal = read("../components/SettingsModal.tsx");
    expect(modal).toContain("DISCARD_SETTINGS_CHANGES");
    // Escape, the backdrop, the search box's Escape and the close button all go through the question
    expect(modal.match(/closeSettings\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(modal).toContain("onClick={closeSettings}");
    expect(modal).toContain("e.target === e.currentTarget && closeSettings()");
    expect(DISCARD_SETTINGS_CHANGES).not.toMatch(/[–—]/);
  });
});
