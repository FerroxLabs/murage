// The two profile fields that reach the model, and what the panel admits.
//
// Source contracts, not render tests: the renderer suite runs in a node
// environment with no DOM (see SkillAffordances.test.ts), and SettingsPanel is
// ~800 lines.
//
// Sean asked for "a very micro prompt that was the personality of each bot"
// and asked whether Description already did it. It does — verbatim, on every
// turn — but the panel said "Description" over "What this agent is for", which
// reads as a note ABOUT the bot rather than instructions TO it. Two things are
// pinned here: that the panel now says what the field is, and that the voice
// note has its own small field, so voice is not written into the one field a
// Chief of Staff reads when it decides who does the work.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const settings = read("./SettingsPanel.tsx");

/** The Personality field alone, so a Description assertion cannot satisfy it. */
const personaField = (() => {
  const start = settings.indexOf('<Field label="Personality">');
  expect(start, "the Personality field is missing entirely").toBeGreaterThan(-1);
  return settings.slice(start, settings.indexOf("</Field>", start));
})();

describe("the personality field", () => {
  it("writes the persona field, bounded by the shared cap", () => {
    expect(BOT_PROFILE_LIMITS.persona).toBe(280);
    expect(personaField).toContain("maxLength={BOT_PROFILE_LIMITS.persona}");
    expect(personaField).toContain("patch({ persona: e.target.value })");
  });

  it("shows the cap as you type — the small cap is the design, not a trap", () => {
    expect(personaField).toContain("{persona.length}/{BOT_PROFILE_LIMITS.persona}");
  });

  it("says it is spoken to the agent, and that nothing else reads it", () => {
    expect(personaField).toMatch(/How this agent talks/);
    expect(personaField).toMatch(/read by nothing else/);
    expect(personaField).toMatch(/delegate/);
  });
});

describe("the description field stops hiding that it is a prompt", () => {
  const descriptionField = (() => {
    const start = settings.indexOf('<Field label="Instructions">');
    expect(start, "the instructions field is missing entirely").toBeGreaterThan(-1);
    return settings.slice(start, settings.indexOf("</Field>", start));
  })();

  it("no longer calls itself a description of the agent", () => {
    // The old copy exactly: a label and a placeholder that both read as
    // metadata about the bot rather than instructions to it.
    expect(settings).not.toContain('<Field label="Description">');
    expect(settings).not.toContain('placeholder="What this agent is for"');
  });

  it("still writes `description`, and says when the agent reads it", () => {
    expect(descriptionField).toContain("patch({ description: e.target.value })");
    expect(descriptionField).toMatch(/every turn/);
  });

  it("warns that teammates read it too — which is why voice belongs next door", () => {
    expect(descriptionField).toMatch(/teammates/);
  });
});
