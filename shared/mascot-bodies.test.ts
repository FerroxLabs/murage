import { describe, expect, it } from "vitest";

import { DEFAULT_MASCOT_BODY, MASCOT_BODIES, MASCOT_BODY_IDS, MASCOT_BODY_NAMES, botMascotBody } from "./mascot-bodies.ts";

describe("mascot body catalog", () => {
  it("offers the Ember flame first and as the default, plus nine generated bodies", () => {
    expect(MASCOT_BODY_IDS[0]).toBe("ember");
    expect(DEFAULT_MASCOT_BODY).toBe("ember");
    expect(MASCOT_BODY_IDS).toHaveLength(10);
    expect(Object.keys(MASCOT_BODIES).sort()).toEqual(MASCOT_BODY_IDS.filter((id) => id !== "ember").sort());
    expect(Object.keys(MASCOT_BODY_NAMES).sort()).toEqual([...MASCOT_BODY_IDS].sort());
    // upstream's cursor artwork was retired in Murage and must not come back with the catalog
    expect(MASCOT_BODY_IDS).not.toContain("cursor" as never);
  });

  it("carries renderable outlines: a gradient slot, an unfilled clip and one shared face scale", () => {
    const scales = new Set<number>();
    for (const [id, body] of Object.entries(MASCOT_BODIES)) {
      expect(body.id, id).toBe(id);
      expect(body.body, id).toContain('fill="{{GRADIENT}}"');
      expect(body.clip, id).toMatch(/^<path d="M[^"]+Z"\/>$/);
      expect(body.fit, id).toMatch(/^translate\([-\d. ]+\) scale\([\d.]+\)$/);
      scales.add(body.anchor.scale);
    }
    expect([...scales]).toEqual([0.791]);
  });

  it("falls back to the Ember flame for unknown, missing or hostile ids", () => {
    for (const value of [undefined, null, "", "cursor", "Circle", 7, { id: "star" }]) {
      expect(botMascotBody(value)).toBe("ember");
    }
    expect(botMascotBody("star")).toBe("star");
  });
});
