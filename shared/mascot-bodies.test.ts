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
    // the anchors are taken as each pack authored them, so the scales are not
    // uniform: most packs place a full-size face, the Star clamps its own, and
    // the two outlines still copied from upstream keep upstream's shared clamp
    expect([...scales].sort()).toEqual([0.682, 0.791, 1]);
    for (const id of ["blob", "circle", "capsule", "drop", "shield", "hexagon"] as const) {
      expect(MASCOT_BODIES[id].anchor.scale, id).toBe(1);
    }
    expect(MASCOT_BODIES.star.anchor.scale).toBe(0.682);
    for (const id of ["squircle", "diamond"] as const) {
      expect(MASCOT_BODIES[id].anchor.scale, id).toBe(0.791);
    }
  });

  it("falls back to the Ember flame for unknown, missing or hostile ids", () => {
    for (const value of [undefined, null, "", "cursor", "Circle", 7, { id: "star" }]) {
      expect(botMascotBody(value)).toBe("ember");
    }
    expect(botMascotBody("star")).toBe("star");
  });

  it("wears Sean's Blob Studio artwork for all seven packs, under the ids 0.1.54 saved", () => {
    // the pack silhouettes replaced upstream's equivalents in place, so a profile
    // saved by 0.1.54 keeps its body instead of falling back to the flame
    for (const id of ["blob", "circle", "capsule", "drop", "shield", "hexagon", "star"] as const) {
      expect(botMascotBody(id), id).toBe(id);
    }
    expect(MASCOT_BODY_NAMES.circle).toBe("Circle");
    expect(MASCOT_BODY_NAMES.shield).toBe("Cone");
    expect(MASCOT_BODY_NAMES.hexagon).toBe("Polygon");
    expect(MASCOT_BODIES.shield.name).toBe("Cone");
    expect(MASCOT_BODIES.hexagon.name).toBe("Polygon");
    // each pack's own SHAPE geometry, verbatim but for the dropped xmlns attribute
    expect(MASCOT_BODIES.circle.clip).toContain('d="M0 100A100 100 0 0 1 200 100A100 100 0 0 1 0 100Z"');
    expect(MASCOT_BODIES.shield.clip).toContain("M57.25 38.475Q100 0 142.75 38.475");
    expect(MASCOT_BODIES.hexagon.clip).toContain("M94.91 4.94Q100.00 2.00 105.09 4.94");
    expect(MASCOT_BODIES.blob.clip).toContain("M198.91 113.13Q198.00 126.26 193.13 138.61");
    // the two the packs actually redraw: quadratic capsule corners, a new star waist
    expect(MASCOT_BODIES.capsule.clip).toContain('d="M100 0H100Q175 0 175 75V125Q175 200 100 200H100Q25 200 25 125V75Q25 0 100 0Z"');
    expect(MASCOT_BODIES.drop.clip).toContain("A78 78 0 0 1 22 119");
    expect(MASCOT_BODIES.star.clip).toContain("M100.00 2.00L124.19 66.70L193.20 69.72");
    expect(MASCOT_BODIES.capsule.anchor).toEqual({ x: 113.82, y: 86.15, scale: 1 });
    expect(MASCOT_BODIES.star.anchor).toEqual({ x: 113.82, y: 117.01, scale: 0.682 });
    // Blob Studio's own green default never reaches the catalog: Murage paints
    // each body with the bot's colour through the gradient slot
    for (const body of Object.values(MASCOT_BODIES)) {
      expect(body.body, body.id).toContain('fill="{{GRADIENT}}"');
      expect(body.body, body.id).not.toContain("#009A5A");
      expect(body.body, body.id).not.toContain("xmlns");
    }
  });

  it("still carries the two outlines the packs have not replaced", () => {
    expect(MASCOT_BODY_NAMES.squircle).toBe("Squircle");
    expect(MASCOT_BODY_NAMES.diamond).toBe("Diamond");
    expect(MASCOT_BODIES.squircle.clip).toContain("M50 0C83.33333 0");
    expect(MASCOT_BODIES.diamond.clip).toContain("M94.12 7.88C98.04 3.96");
  });

});
