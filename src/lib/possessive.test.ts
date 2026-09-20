import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { possessive } from "./possessive";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

describe("possessive of a bot's name", () => {
  it("adds 's to an ordinary name", () => {
    expect(possessive("Ember")).toBe("Ember's");
    expect(possessive("Chief of Staff")).toBe("Chief of Staff's");
  });

  it("gives a name already ending in s a bare apostrophe", () => {
    // A bot called Numbers read "Open Numbers's profile".
    expect(possessive("Numbers")).toBe("Numbers'");
    expect(possessive("Ops")).toBe("Ops'");
    expect(possessive("JARVIS")).toBe("JARVIS'");
  });

  it("never doubles the s, whatever the name ends in", () => {
    for (const name of ["Numbers", "Ops", "JARVIS", "Ember", "Zed", "Max"]) {
      expect(possessive(name)).not.toMatch(/ss'|s's$/i);
    }
  });

  it("keeps an empty name harmless", () => {
    expect(possessive("")).toBe("'s");
  });

  it("is the one place the profile opener builds the phrase", () => {
    for (const file of ["../components/RenameTitle.tsx", "../components/ChatHeader.tsx"]) {
      const source = read(file);
      expect(source, file).toContain("possessive(");
      expect(source, file).not.toMatch(/Open \$\{[\w.]+\}'s profile/);
    }
  });
});
