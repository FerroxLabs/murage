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
    // upstream's six share one clamped scale; the three Blob Studio packs each
    // carry their own authored anchor, at the full face scale Ember also uses
    expect([...scales].sort()).toEqual([0.791, 1]);
    for (const id of ["circle", "shield", "hexagon"] as const) {
      expect(MASCOT_BODIES[id].anchor.scale, id).toBe(1);
    }
    for (const id of ["blob", "squircle", "capsule", "drop", "diamond", "star"] as const) {
      expect(MASCOT_BODIES[id].anchor.scale, id).toBe(0.791);
    }
  });

  it("falls back to the Ember flame for unknown, missing or hostile ids", () => {
    for (const value of [undefined, null, "", "cursor", "Circle", 7, { id: "star" }]) {
      expect(botMascotBody(value)).toBe("ember");
    }
    expect(botMascotBody("star")).toBe("star");
  });

  it("wears Sean's Blob Studio artwork for Circle, Cone and Polygon, under the ids 0.1.54 saved", () => {
    // the pack silhouettes replaced upstream's equivalents in place, so a profile
    // saved by 0.1.54 keeps its body instead of falling back to the flame
    expect(botMascotBody("shield")).toBe("shield");
    expect(botMascotBody("hexagon")).toBe("hexagon");
    expect(MASCOT_BODY_NAMES.circle).toBe("Circle");
    expect(MASCOT_BODY_NAMES.shield).toBe("Cone");
    expect(MASCOT_BODY_NAMES.hexagon).toBe("Polygon");
    expect(MASCOT_BODIES.shield.name).toBe("Cone");
    expect(MASCOT_BODIES.hexagon.name).toBe("Polygon");
    // the packs' own SHAPE geometry, verbatim but for the dropped xmlns attribute
    expect(MASCOT_BODIES.circle.clip).toContain('d="M0 100A100 100 0 0 1 200 100A100 100 0 0 1 0 100Z"');
    expect(MASCOT_BODIES.shield.clip).toContain("M57.25 38.475Q100 0 142.75 38.475");
    expect(MASCOT_BODIES.hexagon.clip).toContain("M94.91 4.94Q100.00 2.00 105.09 4.94");
    expect(MASCOT_BODIES.circle.anchor).toEqual({ x: 113.82, y: 113.82, scale: 1 });
    expect(MASCOT_BODIES.shield.anchor).toEqual({ x: 113.82, y: 107.91, scale: 1 });
    expect(MASCOT_BODIES.hexagon.anchor).toEqual({ x: 113.82, y: 113.82, scale: 1 });
    // no pack SVG or component was vendored in: the catalog is the whole integration
    expect(MASCOT_BODIES.circle.body).toContain('fill="{{GRADIENT}}"');
    expect(MASCOT_BODIES.circle.body).not.toContain("xmlns");
  });
});
