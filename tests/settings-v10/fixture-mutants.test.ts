// Q1: MUT1-MUT14 each change the mockup generator and must turn the fixture check RED for the named reason.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pythonOut, withScratchGen } from "./run-mockup";

const MUTANTS: Array<[id: string, reason: RegExp, count: number | null]> = [
  ["MUT1", /restored routine does not link/, 2],
  ["MUT2", /draws a switch/, 3],
  ["MUT3", /opens skills-sheet\.html, whose sheet is "Invoice chase"/, 38],
  ["MUT4", /off since the restore/i, 1],
  ["MUT5", /drawn for Old Dax/, 1],
  ["MUT6", /and N more/, 2],
  ["MUT7", /Move all lists 33 bots, the plan clears 34/, 1],
  ["MUT8", /listed as getting the app, but Connected apps are off/, 1],
  ["MUT9", /Atlas loses \[\]/, 1],
  ["MUT10", /Move all names 3 chats, the plan clears 4/, 2],
  ["MUT11", /Move all names 0 routines, the plan clears 6/, 1],
  ["MUT12", /false promise in team-delete review/, 3],
  ["MUT13", /team-delete review lists \['Chief', 'Dax'\], the team is \['Chief', 'Dax', 'Juno'\]/, 1],
  ["MUT14", /"Delete team and keep bots" is not drawn in the team-delete review/, 2],
];

describe("settings v10 fixture mutants (Q1)", () => {
  for (const [id, reason, count] of MUTANTS) {
    it(`${id} turns the fixture check RED`, () => {
      const out = withScratchGen((gen) => pythonOut([join(gen, "mutants_v10.py"), id], gen));
      expect(out).toMatch(new RegExp(`^${id} .* -> RED \\(${count}\\)$`, "m"));
      expect(out).toMatch(reason);
    });
  }
});

// The generator's HTML summary is part of the fixture check: these two breakages must show up in it.
const HTML_BREAKS: Array<[name: string, from: string, to: string, reason: RegExp]> = [
  ["a switch with no name", ' aria-label="{e(label)}"></button>\'', '></button>\'', /switch with no name/],
  ["a duplicate id on a page", '<button type="button" class="tg" role="switch" aria-checked="{"true" if on else "false"}" aria-label', '<button id="dup" type="button" class="tg" role="switch" aria-checked="{"true" if on else "false"}" aria-label', /duplicate ids: \['dup'\]/],
];

describe("settings v10 HTML summary mutants (Q1)", () => {
  for (const [name, from, to, reason] of HTML_BREAKS) {
    it(`${name} turns the HTML parse line RED`, () => {
      const out = withScratchGen((gen) => {
        const file = join(gen, "core.py");
        const src = readFileSync(file, "utf8");
        expect(src).toContain(from);
        writeFileSync(file, src.replace(from, to));
        return pythonOut([join(gen, "build.py")], gen);
      });
      expect(out).not.toMatch(/^HTML parse: \d+ files, 0 with errors$/m);
      expect(out).toMatch(reason);
    });
  }
});
