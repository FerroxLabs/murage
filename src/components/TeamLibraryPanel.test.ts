import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// A source contract, not a render test. The panel is a 900-line component in a
// node-environment suite with no DOM, and the property worth pinning is not how
// it looks — it is that hiring a team can never take the roster away. That used
// to be the DEFAULT: importMode started as "replace", previewManifest actively
// selected it whenever you already owned bots, and the primary button read
// "Replace team" while "Add alongside instead" was a text link beside it. One
// stray click archived every bot you had.
const source = readFileSync(
  fileURLToPath(new URL("./TeamLibraryPanel.tsx", import.meta.url)),
  "utf8",
);

describe("team import is additive", () => {
  it("only ever asks the server for a mode that adds", () => {
    // `add` and `project` both create; `project` additionally opens a room on a
    // scouted folder (server/index.ts:6311). `replace` is the only mode that
    // archives what you already have, and nothing here may request it.
    const modes = [...source.matchAll(/\/api\/teams\/import\?mode=([a-z$#{}\w]*)/g)].map((m) => m[1]);
    expect(modes.length).toBeGreaterThan(0);
    expect([...new Set(modes)].sort()).toEqual(["add", "project"]);
  });

  it("carries no import-mode state that could select a destructive path", () => {
    expect(source).not.toMatch(/importMode|ImportMode/);
    expect(source).not.toMatch(/"replace"/);
  });

  it("offers no control that replaces the current team", () => {
    expect(source).not.toMatch(/Replace team|Replace current team/);
  });
});
