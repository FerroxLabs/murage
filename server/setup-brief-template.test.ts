// THE SAMPLE HAS TO BE THE TEMPLATE, NOT A PICTURE OF ONE.
//
// The first run shows a rendered brief before it asks for anything, and the
// requirement on it is not "look nice once". It is that the page somebody
// sees on their first morning is the same page they get every morning after,
// with their own day in it.
//
// That is a promise made by two separate things that do not import each
// other: `shared/brief.ts` defines the sections the renderer lays out, and
// the routine prompt in server/index.ts is what actually asks the engine for
// them. Nothing in the type system connects those, so they can drift, and the
// drift would be invisible: the sample would keep rendering beautifully while
// the real brief quietly came back in some other shape. The person would
// notice on day two, which is the worst possible day to notice.
//
// So this is the seam that holds them together.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BRIEF_SECTIONS } from "../shared/brief.ts";

/** Read as source rather than imported: the template sits inside server/index.ts,
 *  which boots a server on import. */
const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

const template = (() => {
  const at = index.indexOf("  brief: {\n    name: \"Morning brief\",");
  expect(at, "the morning brief template has moved or been renamed").toBeGreaterThan(-1);
  const end = index.indexOf("\n  },", at);
  return index.slice(at, end);
})();

/** Just the sentences the routine runs on, with the comment stripped out, so
 *  a word that appears only in a code comment cannot satisfy an assertion. */
const prompt = template
  .slice(template.indexOf("prompt: () =>"))
  .replace(/^\s*\+?\s*"/gm, "")
  .replace(/"\s*$/gm, "");

describe("the morning brief asks for the brief we designed", () => {
  it("asks for every section, in the order the page lays them out", () => {
    // Matched on `asks`, the phrase each section declares, rather than on a
    // guess derived from its heading. A first attempt guessed, and matched
    // the word "overnight" where the prompt says what to GO THROUGH rather
    // than where it says what to WRITE, which made a correct prompt look out
    // of order. The phrase belongs next to the section it is for.
    const asked = BRIEF_SECTIONS.map((section) => ({
      heading: section.heading,
      at: prompt.indexOf(section.asks),
    }));

    for (const section of asked) {
      expect.soft(section.at, `the brief never asks for "${section.heading}"`).toBeGreaterThan(-1);
    }
    const order = asked.map((section) => section.at);
    expect([...order].sort((a, b) => a - b), "the prompt asks for the sections out of order").toEqual(order);
  });

  it("asks for a recommendation, because a list of options is not a decision", () => {
    // The single most repeated finding in both cross-research answers: an
    // assistant that hands back three options has failed to do the job.
    expect(prompt.toLowerCase()).toMatch(/what you would do/);
  });

  it("tells it to leave sections out rather than pad them", () => {
    expect(prompt.toLowerCase()).toMatch(/leave out|omit/);
  });

  it("keeps the quiet day to one line", () => {
    expect(prompt.toLowerCase()).toMatch(/one line/);
  });

  it("bans the things that make a brief get ignored", () => {
    // Counts nobody can act on, wholesale lists, and yesterday's unchanged
    // items. Named independently by both models as the failure that turns a
    // brief into wallpaper.
    expect.soft(prompt.toLowerCase()).toMatch(/no counts/);
    expect.soft(prompt.toLowerCase()).toMatch(/repeated unchanged|nothing repeated/);
  });

  it("is still written for the person whose routines list it appears in", () => {
    // The note above the templates in index.ts is explicit that these are
    // read by the owner later, not just by a model. A specification would be
    // unreadable in that list, so length is the check that keeps it prose.
    expect(prompt.length).toBeLessThan(700);
    expect.soft(prompt, "no em dash, same as every other string the Chief owns").not.toContain("—");
  });
});
