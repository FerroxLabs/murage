// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WHATS_NEW_PAGES } from "./whats-new-pages";

vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { runWhatsNewAction } = await import("./WhatsNewHost");
const page = WHATS_NEW_PAGES["1.0.19"]!;
const notes = readFileSync(new URL("../../release-notes/1.0.19.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../../apps/docs/content/docs/changelog/v1-0-19.mdx", import.meta.url), "utf8")
  .replace(/^---\n[\s\S]*?\n---\n\n/, "")
  .replace(/^(## .+?) in 1\.0\.19$/gm, "$1");
const surfaces = { notes, changelog, "What's New": page.more.join("\n") };

describe("1.0.19 reviewed release promises", () => {
  for (const [surface, copy] of Object.entries(surfaces)) {
    it(`H1 ${surface}: describes the learning send notice and dictation separately`, () => {
      // MAIN RULING 1114-NOTES-1019: extract.ts starts fetch before the learning notice; dictation discloses before sending.
      expect(copy).toContain("Memory learning tells you when it sends chat content to Flux. Dictation explains its use of your model before it starts.");
      expect(copy).not.toContain("Memory learning and dictation each explain their use of your model before they start.");
    });

    it(`L1 ${surface}: closes the approval request without promising to remove its card`, () => {
      // MAIN RULING 1114-NOTES-1019: Stop settles the request and retains its answered card in the transcript.
      expect(copy).toContain("Stop ends work that is waiting on your approval, and the request closes with it.");
      expect(copy).not.toContain("the waiting card goes away");
    });
  }

  it("M1 the Skills hero opens the Skills browser directly", () => {
    const dispatch = vi.fn();
    // MAIN RULING 1114-NOTES-1019: the Skills headline's shortcut must select the Skills view.
    expect(runWhatsNewAction(page.hero.action, dispatch)).toBe(true);
    expect(dispatch.mock.calls).toEqual([[{ type: "showTeamLibrary", view: "skills" }]]);
    expect(page.hero.button).toBe("Open Skills");
  });

  it("preserves the older Library shortcut's Teams destination", () => {
    const dispatch = vi.fn();
    expect(runWhatsNewAction("library", dispatch)).toBe(true);
    expect(dispatch.mock.calls).toEqual([[{ type: "showTeamLibrary", view: "teams" }]]);
  });

  it("keeps all feature lines and the introduction identical across the three surfaces", () => {
    expect(changelog).toBe(notes);
    expect(page.hero.body).toBe(notes.split("\n\n").slice(0, 2).join(" "));
    expect(page.more).toEqual(notes.split("\n").filter(line => line.startsWith("- ") && !line.includes("https://"))
      .map(line => line.slice(2).replace(/\*\*(.*?)\*\*/g, "$1")));
  });

  it("keeps the publisher length, copy rules, and offline update links", () => {
    expect(notes.length).toBeLessThan(8000);
    for (const copy of [...Object.values(surfaces), page.hero.title, page.hero.body]) {
      expect(copy).not.toMatch(/<!--|—|--|\b(?:free|trials?|credits|broken|bug|fixed)\b|\(R\)/i);
    }
    expect(page.hero.title).not.toMatch(/No limits/i);
    expect([...notes.matchAll(/https:\/\/\S+/g)].map(match => new URL(match[0]).href)).toEqual([
      "https://murage.ai/blog/whats-new-in-murage-1-0-19",
      "https://murage.ai/download",
      "https://murage.ai/changelog",
    ]);
  });
});
