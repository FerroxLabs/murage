// AN ANSWERED CARD MUST STOP LOOKING LIKE A QUESTION.
//
// Every asking card in the first run hides its form once the step is done.
// The bug was never in that branch; it was in what fed it. Each card held
// `const [done, setDone] = useState(settled)`, which reads the prop exactly
// once, at first render.
//
// `settled` is set by the SERVER when the step lands, and that routinely
// happens after the card has already rendered: the step completed on its own
// (connected apps arrive with the Flux Router key), another surface answered
// it, or the app reopened part way through. In every one of those the card
// went on showing an open form with live buttons for a question that was
// already answered. Reported as the flow reading like a wall of unfinished
// business, with the hello card still offering empty name and email fields
// after the name was in the transcript two lines above.
//
// This is a source test rather than a render test for the same reason
// composer-key-guard.test.ts is: what has to hold is a PROPERTY OF THE CODE
// ("this value is derived, not captured"), and a render test would pass just
// as happily against a component that captured it and happened to be mounted
// after the fact.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Every card that asks the person for something and can be settled. */
const ASKING_CARDS = [
  "FirstRunHelloCard",
  "FirstRunFluxCard",
  "FirstRunAppsCard",
  "FirstRunBriefCard",
] as const;

/**
 * The component with its prose removed.
 *
 * The comments in these files NAME the thing they no longer do, so a scan of
 * the raw text finds `useState(settled)` in the note explaining why it is
 * gone and fails a file that is correct. Same trap as the brief's section
 * headings hiding in a CSS comment. Code only.
 */
const sourceOf = (name: string) =>
  readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("a card that the server has settled", () => {
  it("never captures `settled` as initial state", () => {
    for (const card of ASKING_CARDS) {
      expect
        .soft(sourceOf(card), `${card} captures settled once and will not hear it change`)
        .not.toContain("useState(settled)");
    }
  });

  it("derives done from the server's answer as well as its own", () => {
    for (const card of ASKING_CARDS) {
      const source = sourceOf(card);
      // Both halves: this component acted, OR the server says the step landed.
      expect.soft(source, `${card} does not derive done`).toMatch(/const done = acted \|\| settled;/);
    }
  });

  it("still hides its form when done", () => {
    // The branch this whole fix exists to reach. If a card stops gating its
    // form on `done`, settling it correctly buys nothing.
    for (const card of ASKING_CARDS) {
      expect.soft(sourceOf(card), `${card} no longer hides anything when done`).toContain("!done &&");
    }
  });
});
