// B100 (upstream 6830ec2f2, b372bf6de, f37fad4d6): every text field shows keyboard focus on its own border, and the
// controls that have no border to repaint (checkbox, radio, slider, colour well, file picker) keep the focus ring.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

describe("keyboard focus on fields", () => {
  it("paints a focused field's border in the ring colour, except a field reporting an error", () => {
    const rule = rules.find((r) => /:is\(input, textarea, select\):focus-visible:not\(\[aria-invalid="true"\]\)/.test(r.selector));
    expect(rule?.body).toMatch(/border-color:\s*var\(--color-focus\)/);
  });

  it("keeps the ring on sliders, colour wells and file pickers as well as checkboxes and radios", () => {
    const cleared = rules.filter((r) => /outline:\s*none/.test(r.body) && /:is\(input, textarea, select\)/.test(r.selector));
    expect(cleared.length).toBeGreaterThan(0);
    for (const rule of cleared) {
      for (const type of ["checkbox", "radio", "range", "color", "file"]) expect(rule.selector).toContain(`[type="${type}"]`);
    }
  });
});
