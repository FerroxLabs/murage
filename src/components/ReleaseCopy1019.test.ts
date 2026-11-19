// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WHATS_NEW_PAGES } from "./whats-new-pages";

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
      // notes-verify-1019 L41 (learning-consent 37b40ecabaa5, dictation-consent 3950d5468895): the learning line still says "when", never "before".
      expect(copy).toContain("Memory learning tells you when it uses Flux to learn from your chats. Dictation tells you when your model will tidy your words.");
      expect(copy).not.toContain("Memory learning and dictation each explain their use of your model before they start.");
      expect(copy).not.toMatch(/Memory learning[^.]*before/);
    });

    it(`L1 ${surface}: closes the approval request without promising to remove its card`, () => {
      // MAIN RULING 1114-NOTES-1019: Stop settles the request and retains its answered card in the transcript.
      // notes-verify-1019 finding 6: Stop closes engine permission requests on the stopped turn; durable proposals stay actionable.
      expect(copy).toContain("When a bot stops, its open requests for permission from the engine close with the turn.");
      expect(copy).not.toContain("Stop ends work that is waiting on your approval");
      expect(copy).not.toContain("the waiting card goes away");
    });

    it(`W1 ${surface}: makes no Smart App Control promise and keeps the cut room-routing line out`, () => {
      // Sean's Windows decision (Option A, 06:42Z): 1.0.19 signs Windows exactly as 1.0.18; SAC qualification moves to a later release.
      expect(copy).toContain("Windows builds are signed with the same trusted signing as 1.0.18.");
      expect(copy).not.toMatch(/Smart App Control|every program and add-on/i);
      // notes-verify-1019 finding 2: room routing's publication gate is unmet.
      expect(copy).not.toMatch(/Flux routing for Auto rooms/i);
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
