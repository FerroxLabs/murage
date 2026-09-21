// THE REGISTER OF COPY SURFACES, AND WHY IT IS ENFORCED RATHER THAN TRUSTED.
//
// The copy gate walked ONE module and was written as though that were every
// word of the first run. `SETUP_CARD_COPY` in server/setup-conversation.ts is
// the title and subtitle of every card the Chief puts in the person's thread,
// and not one house rule reached it: "Talk to me and I will answer out loud."
// on the jobs card passed the whole suite.
//
// Adding the second surface to the gate fixes that one hole. It does nothing
// at all about the THIRD surface, which is the same defect again by a
// different name, and the reason this file exists. Every non-test module in
// the first-run and setup-card area is imported here and its exports are
// walked for prose. A module that holds prose must be a registered surface;
// a module that holds none must say so in FIRST_RUN_SURFACE_MODULES. Anything
// in neither list fails, so a new copy table cannot be added to the area
// without either joining the gate or stating, in the register, why it is
// exempt.
//
// It imports the modules rather than reading their source. A scan for
// `const .*COPY` is the kind of guard this branch is currently deleting.

import { describe, expect, it } from "vitest";

import {
  FIRST_RUN_SURFACES,
  FIRST_RUN_SURFACE_MODULES,
  firstRunReadableStrings,
  firstRunStoredStrings,
  walkStrings,
} from "./first-run-surfaces";

/** The area. Test files are excluded; everything else is imported and read. */
const area: Record<string, unknown> = {
  ...import.meta.glob(["./first-run*.ts", "!./*.test.ts"], { eager: true }),
  ...import.meta.glob("../../server/setup-conversation.ts", { eager: true }),
  // AND THE ONE THAT IS NOT IN THIS DIRECTORY. The Chief's confirmations are
  // posted by the server, so they live in shared/ and an area defined as
  // "./first-run*.ts" would never have seen them. A register that only
  // watches the folder the hole was found in is the same hole again.
  ...import.meta.glob("../../shared/first-run-chief.ts", { eager: true }),
};

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * A string somebody could read on a screen, as opposed to a key, a class
 * list, a url or a wire value.
 *
 * Deliberately generous: a false positive costs one line in the register
 * saying why a module is exempt, and a false negative is the hole this file
 * exists to close.
 */
function looksLikeProse(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 25) return false;
  if (/^[a-z]+:\/\//i.test(trimmed)) return false;
  if (/^[./~]/.test(trimmed)) return false;
  if (!/[a-z]/.test(trimmed)) return false;
  // Four or more words, at least one of them ending a thought or carrying a
  // capital: a tailwind class list or a slug has neither.
  const words = trimmed.split(/\s+/);
  return words.length >= 4 && /[.,!?]|\b[A-Z]/.test(trimmed);
}

describe("the register of first-run copy surfaces", () => {
  it("found the area at all", () => {
    // An empty glob would make every assertion below vacuous, which is
    // exactly the failure mode this whole branch is about.
    expect(Object.keys(area).length).toBeGreaterThan(5);
    expect(Object.keys(area).map(basename)).toContain("setup-conversation.ts");
    expect(Object.keys(area).map(basename)).toContain("first-run-copy.ts");
  });

  it("classifies every module in the area, and holds no entry for one that is gone", () => {
    const found = Object.keys(area).map(basename).sort();
    for (const file of found) {
      expect(
        Object.prototype.hasOwnProperty.call(FIRST_RUN_SURFACE_MODULES, file),
        `${file} is in the first-run area and is not in FIRST_RUN_SURFACE_MODULES. `
        + "Register it as a copy surface, or say there why it holds no readable copy.",
      ).toBe(true);
    }
    for (const file of Object.keys(FIRST_RUN_SURFACE_MODULES)) {
      expect(found, `${file} is registered and no longer exists`).toContain(file);
    }
  });

  it("lets no module in the area hold prose without joining the gate", () => {
    const gated = new Set(firstRunReadableStrings().map((entry) => entry.text));
    for (const [path, module] of Object.entries(area)) {
      const file = basename(path);
      // A registered surface is already gated. The register itself is
      // skipped because its only strings are the reasons in the two lists
      // above, which nobody reads on a screen.
      const reason = FIRST_RUN_SURFACE_MODULES[file];
      if (reason?.startsWith("surface:") || reason === "the register itself") continue;
      const strings: Array<{ path: string; text: string }> = [];
      walkStrings(module, file, strings);
      for (const { path: at, text } of strings) {
        if (!looksLikeProse(text)) continue;
        expect.soft(
          gated.has(text) ? null : `${at}: "${text}"`,
          `${file} holds readable copy that no house rule is applied to. `
          + "Register it in FIRST_RUN_SURFACES, or move the words to a surface that is.",
        ).toBeNull();
      }
    }
  });

  it("walks every registered surface, and each one really contributes", () => {
    const stored = firstRunStoredStrings();
    for (const name of Object.keys(FIRST_RUN_SURFACES)) {
      // CONTRIBUTES AT ALL, rather than contributes a lot. A surface can
      // honestly be small: the Chief owes exactly two sentences for the key
      // step, and one of the two exists because the other would be a claim
      // about a key nothing had tried. A floor high enough to exclude it
      // would push small surfaces back out of the gate, which is the thing
      // this file exists to stop. How big the gate is as a whole is held in
      // first-run-copy.test.ts.
      expect(
        stored.filter((entry) => entry.path.startsWith(`${name}.`)).length,
        `${name} is registered and contributed no strings`,
      ).toBeGreaterThan(0);
    }
    // The renderer's own table is still the big one, and an empty or
    // half-imported FIRST_RUN_COPY would make every rule above vacuous.
    expect(stored.filter((entry) => entry.path.startsWith("FIRST_RUN_COPY.")).length).toBeGreaterThan(40);
    // And the Chief's own sentences really are in the walk now.
    expect(stored.some((entry) => entry.path.startsWith("CHIEF_CONFIRMATIONS.flux."))).toBe(true);
    // And the server's cards are genuinely in there, which is the surface
    // that was missing.
    expect(stored.some((entry) => entry.path === "SETUP_CARD_COPY.jobs.subtitle")).toBe(true);
  });
});
