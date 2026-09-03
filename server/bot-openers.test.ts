// The opener list is copy, and copy rots. Everything the owner asked for by
// name is asserted mechanically here so the rules survive the next person
// who adds a thirty-first line: no em dash, no en dash, thirty distinct
// templates, one `{name}` in each, and a rotation that is deterministic
// under test without being obviously cyclic in use.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BOT_OPENERS, openerAt, openingLine } from "../shared/bot-openers.ts";

const MODULE_PATH = fileURLToPath(new URL("../shared/bot-openers.ts", import.meta.url));
// Built from code points so this file never has to contain the
// characters it forbids.
const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);

describe("bot openers", () => {
  it("has 30 distinct templates", () => {
    expect(BOT_OPENERS).toHaveLength(30);
    expect(new Set(BOT_OPENERS).size).toBe(30);
  });

  // The rule the owner asked for by name. It covers the whole SOURCE FILE,
  // comments included, not just the array: a stray em dash in a doc comment
  // is the seed of the next one in a string.
  it("contains no em dash anywhere in the module source", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    const at = source.indexOf(EM_DASH);
    const context = at === -1 ? "" : source.slice(Math.max(0, at - 60), at + 60);
    expect({ found: at !== -1, context }).toEqual({ found: false, context: "" });
  });

  it("contains no en dash anywhere in the module source", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    expect(source.includes(EN_DASH)).toBe(false);
  });

  it("uses no dashes and no exclamation marks in any opener", () => {
    for (const opener of BOT_OPENERS) {
      expect(opener).not.toContain(EM_DASH);
      expect(opener).not.toContain(EN_DASH);
      expect(opener).not.toContain("!");
    }
  });

  it("never asks a question: the card that follows does that", () => {
    for (const opener of BOT_OPENERS) expect(opener).not.toContain("?");
  });

  it("puts {name} in every opener exactly once", () => {
    for (const opener of BOT_OPENERS) {
      expect(opener.split("{name}")).toHaveLength(2);
    }
  });

  it("varies genuinely in length", () => {
    const words = BOT_OPENERS.map((opener) => opener.split(/\s+/).length);
    expect(Math.min(...words)).toBeLessThanOrEqual(4);
    expect(Math.max(...words)).toBeGreaterThanOrEqual(13);
  });

  it("renders every template with no placeholder left behind", () => {
    for (let i = 0; i < BOT_OPENERS.length; i++) {
      const line = openerAt(i, "Ada");
      expect(line).not.toContain("{name}");
      expect(line).toContain("Ada");
    }
  });

  it("openerAt is deterministic and wraps in both directions", () => {
    expect(openerAt(0, "Ada")).toBe(openerAt(30, "Ada"));
    expect(openerAt(0, "Ada")).toBe(openerAt(-30, "Ada"));
    expect(openerAt(-1, "Ada")).toBe(openerAt(29, "Ada"));
    expect(openerAt(7, "Ada")).toBe(BOT_OPENERS[7].replaceAll("{name}", "Ada"));
  });

  // Rotation: injectable so a test can pin the line, `Math.random` by default
  // so two bots made a minute apart do not read as a counter ticking over.
  it("openingLine reaches every opener and is pinnable through pick", () => {
    const seen = new Set<string>();
    for (let i = 0; i < BOT_OPENERS.length; i++) {
      seen.add(openingLine("Ada", () => i / BOT_OPENERS.length));
    }
    expect(seen.size).toBe(30);
    expect(openingLine("Ada", () => 0)).toBe(openerAt(0, "Ada"));
    expect(openingLine("Ada", () => 0.999999)).toBe(openerAt(29, "Ada"));
  });

  it("openingLine with the real Math.random stays inside the list", () => {
    const rendered = new Set(BOT_OPENERS.map((_, i) => openerAt(i, "Ada")));
    for (let i = 0; i < 200; i++) expect(rendered.has(openingLine("Ada"))).toBe(true);
  });
});
