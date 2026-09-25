// What a bot carries into every turn: its section's team brief and its own
// MEMORY.md. Both are the owner's material, so they ride only on turns whose
// human audience is the owner; a channel person's conversation gets neither.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { SECTION_CONTEXTS_FILE, writeSectionContext } from "./section-context.ts";
import { saveAboutMe } from "./about-me.ts";
import { standingContextParts, standingContextPrompt } from "./standing-context.ts";
import { ensureWorkspace, MEMORY_MAX_LINES } from "./workspace.ts";

const bot = { id: "standing-bot", section: "Ops" };
beforeEach(() => {
  rmSync(SECTION_CONTEXTS_FILE, { force: true });
  writeSectionContext("Ops", "BRIEF_CANARY ship on Thursdays", 1);
  writeFileSync(join(ensureWorkspace(bot.id), "MEMORY.md"), "# Memory\n\n- NOTEBOOK_CANARY the garden project is Fern\n");
});

it("gives an owner-audience turn the team brief and the bot's own notebook with edit guidance", () => {
  const prompt = standingContextPrompt(bot, { ownerAudience: true, fileTools: true });
  expect(prompt).toContain("BRIEF_CANARY");
  expect(prompt).toContain("Your memory (MEMORY.md):\n# Memory");
  expect(prompt).toContain("NOTEBOOK_CANARY");
  expect(prompt).toContain("only when the person asks you to remember");
  expect(prompt).toContain("never on your own initiative");
  expect(prompt.indexOf("BRIEF_CANARY")).toBeLessThan(prompt.indexOf("NOTEBOOK_CANARY"));
});

it("gives an engine without file tools its notebook read-only", () => {
  const prompt = standingContextPrompt(bot, { ownerAudience: true, fileTools: false });
  expect(prompt).toContain("NOTEBOOK_CANARY");
  expect(prompt).toContain("leave it unchanged on this turn");
  expect(prompt).not.toContain("Edit it with your file tools");
});

it("gives an unattended turn its notebook read-only, even with file tools", () => {
  const prompt = standingContextPrompt(bot, { ownerAudience: true, fileTools: true, unattended: true });
  expect(prompt).toContain("BRIEF_CANARY");
  expect(prompt).toContain("NOTEBOOK_CANARY");
  expect(prompt).toContain("leave it unchanged on this turn");
  expect(prompt).not.toContain("Edit it with your file tools");
  expect(prompt).not.toContain("Your private long-term memory file is");
});

it("gives a channel person's conversation neither the brief nor the notebook", () => {
  expect(standingContextPrompt(bot, { ownerAudience: false, fileTools: true })).toBe("");
});

it("loads only the notebook's budget, however long it grows", () => {
  const lines = Array.from({ length: MEMORY_MAX_LINES + 50 }, (_, index) => `- line ${index}`);
  writeFileSync(join(ensureWorkspace(bot.id), "MEMORY.md"), lines.join("\n"));
  const prompt = standingContextPrompt(bot, { ownerAudience: true, fileTools: true });
  expect(prompt).toContain(`- line ${MEMORY_MAX_LINES - 1}`);
  expect(prompt).not.toContain(`- line ${MEMORY_MAX_LINES}`);
  expect(prompt).toContain("Trim it");
});

// About me (about-me.ts) is the owner's own profile: the same owner-audience
// rule as the brief and the notebook, and a per-bot switch like the brief.
it("gives About me to an owner-audience turn only, attended or not", () => {
  saveAboutMe("ABOUT_ME_CANARY I run the Fern garden shop.");
  expect(standingContextParts(bot, { ownerAudience: true, fileTools: true }).aboutMe).toContain("ABOUT_ME_CANARY");
  expect(standingContextParts(bot, { ownerAudience: true, fileTools: false, unattended: true }).aboutMe).toContain("ABOUT_ME_CANARY");
  expect(standingContextParts(bot, { ownerAudience: false, fileTools: true })).toEqual({ aboutMe: "", teamBrief: "", memory: "" });
  // a webhook's payload came from outside and its reply may go back out
  expect(standingContextParts(bot, { ownerAudience: true, fileTools: true, unattended: true, webhook: true }).aboutMe).toBe("");
  // the joined standing block is unchanged: About me is its own layer
  expect(standingContextPrompt(bot, { ownerAudience: true, fileTools: true })).not.toContain("ABOUT_ME_CANARY");
});

it("leaves About me out for a bot the owner switched it off for", () => {
  saveAboutMe("ABOUT_ME_CANARY I run the Fern garden shop.");
  const parts = standingContextParts({ ...bot, aboutMe: false }, { ownerAudience: true, fileTools: true });
  expect(parts.aboutMe).toBe("");
  expect(parts.memory).toContain("NOTEBOOK_CANARY");
  saveAboutMe("");
  expect(standingContextParts(bot, { ownerAudience: true, fileTools: true }).aboutMe).toBe("");
});
