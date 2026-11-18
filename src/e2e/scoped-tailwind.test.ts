import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIRST_LINE, scopeStylesCss } from "./scoped-tailwind";

describe("scoped Tailwind scan for the fixtures", () => {
  it("the app stylesheet still opens with the line the fixtures rewrite", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css.split("\n")[0]).toBe(FIRST_LINE);
  });

  it("rewrites only line 1 and keeps the rest of the stylesheet byte for byte", () => {
    const rest = "\n.x { color: red; }\n";
    const out = scopeStylesCss(FIRST_LINE + rest);
    expect(out.endsWith(rest)).toBe(true);
    expect(out).toContain("source(none)");
    expect(out).toContain('@source "."');
    expect(out).toContain('@source "../index.html"');
  });

  it("leaves any other stylesheet alone", () => {
    expect(scopeStylesCss(".a { color: red; }")).toBe(".a { color: red; }");
  });
});
