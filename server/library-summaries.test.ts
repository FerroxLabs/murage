// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A library template's `summary` is shown to the person on the library card and
// the preview. It says what the template does for them. Instructions to the bot
// ("You are X ... you must ...") belong in the agent description or the
// playbook instructions, never in the summary.
const root = fileURLToPath(new URL("../", import.meta.url));
const DIRECTORIES = ["library/packages", "library/assistants", "bot-library/builtins"];
const files = DIRECTORIES.flatMap((dir) =>
  readdirSync(join(root, dir)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).map((name) => join(dir, name)));

/** Instruction-shaped openers: "You are", "You're", "Your job", "Act as", "I am" and friends. */
export const INSTRUCTION_OPENER = /^[\s*_"'`>#-]*(you are|you're|you were|you will|you must|you should|you can|your (job|role|task|goal|purpose)\b|act as|acting as|behave as|pretend|take on the role|as an? (ai|assistant|expert|specialist)\b|i am|i'm)\b/i;

/** A second-person persona sentence anywhere in the summary: "You answer one question", "You run Layer C", "Your authority". */
export const PERSONA_SENTENCE = /(^|[\n.!?*]\s*|\p{Extended_Pictographic}\uFE0F?\s*)(you (answer|run|handle|work|operate|are|own|treat|produce|define|ask|cite|never|always|must|should|will|do not|don't|need to|take|act|use)|your (job|role|task|goal|purpose|authority))\b/iu;

/** Copy rules for the summaries rewritten in 1.0.4: no em or en dashes, no safety words, no Composio. */
const COPY_RULES = /[–—]|\b(safe|safely|unsafe|safety)\b|composio/i;

const read = (file: string) => (JSON.parse(readFileSync(join(root, file), "utf8")) as { package: { id: string; summary: string; tagline: string } }).package;

describe("library template summaries read as plain descriptions", () => {
  it("finds the shipped templates", () => { expect(files.length).toBeGreaterThan(150); });
  it("recognises the instruction openers it guards against", () => {
    for (const text of ["You are **Writer**.", "you're a coach", "  Your job is to", "Act as a tutor", "**You are** X", "I am a bot"]) {
      expect(INSTRUCTION_OPENER.test(text), text).toBe(true);
    }
    for (const text of ["Makes a playable 3D platformer game you open in your browser.", "Your book plan in one place", "Youth sports scheduling"]) {
      expect(INSTRUCTION_OPENER.test(text), text).toBe(false);
    }
  });
  it.each(files)("%s summary is not an instruction to the bot", (file) => {
    expect(read(file).summary).not.toMatch(INSTRUCTION_OPENER);
  });
  it("recognises second-person persona sentences", () => {
    for (const text of ["Numbers specialist.\n\n\ud83d\udcca You answer one question: **x**", "Layer C.\n\nYou run Layer C of the framework.", "x.\n\nYour authority: y"]) {
      expect(PERSONA_SENTENCE.test(text), text).toBe(true);
    }
    for (const text of ["You receive the working draft and its evidence.", "Helps you plan a course.", "Compass prepares a plan. You get the draft."]) {
      expect(PERSONA_SENTENCE.test(text), text).toBe(false);
    }
  });
  it.each(files)("%s summary has no persona sentences", (file) => {
    expect(read(file).summary).not.toMatch(PERSONA_SENTENCE);
  });
  it.each(files)("%s summary is short: one paragraph, 300 characters or fewer", (file) => {
    const { summary } = read(file);
    expect(summary).not.toContain("\n");
    expect(summary.length).toBeLessThanOrEqual(300);
  });
  it("the shipped catalog cards are not instruction-shaped either", () => {
    const catalog = JSON.parse(readFileSync(join(root, "library/catalog.json"), "utf8")) as { teams: { slug: string; summary: string }[] };
    const bad = catalog.teams.filter((t) => INSTRUCTION_OPENER.test(t.summary)).map((t) => t.slug);
    expect(bad).toEqual([]);
  });
  it("no template summary or tagline uses an em or en dash", () => {
    const bad = files.filter((f) => /[\u2013\u2014]/.test(read(f).summary + read(f).tagline));
    expect(bad).toEqual([]);
  });
  it("every built-in template summary follows the copy rules", () => {
    const bad = files.filter((f) => f.startsWith("bot-library/builtins/")).filter((f) => COPY_RULES.test(read(f).summary));
    expect(bad).toEqual([]);
  });
});
