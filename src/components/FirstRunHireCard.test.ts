import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FirstRunHireCard, HIRE_ROWS } from "./FirstRunHireCard";
import { STARTER_TEAM } from "../lib/first-run-starter-team";
import { MASCOT_BODIES } from "../../shared/mascot-bodies";
import { DEFAULT_SILHOUETTE } from "./EmberAvatar";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { bots: [] } }), api: vi.fn() }));

describe("G1 hire rows", () => {
  it("renders each catalog face beside its checkbox, including the unticked teammate", () => {
    const html = renderToStaticMarkup(createElement(FirstRunHireCard, { settled: false }));
    const rows = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]);
    expect(rows).toHaveLength(4);
    HIRE_ROWS.forEach((row, i) => {
      const face = STARTER_TEAM.find((member) => member.key === row.key)!;
      expect(rows[i]).toContain('type="checkbox"');
      expect(rows[i]).toContain(face.name);
      expect(rows[i]).toContain('<svg');
      const shape = face.mascotBody === "ember" ? DEFAULT_SILHOUETTE : MASCOT_BODIES[face.mascotBody as keyof typeof MASCOT_BODIES];
      expect(rows[i]).toContain(shape.clip.match(/d="([^"]{40})/)![1]);
      expect(rows[i].includes('checked=""')).toBe(row.fit);
    });
  });
});
