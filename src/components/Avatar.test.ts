// A bot with no uploaded image still gets the shape it was given: the mascot
// is framed in a circle, rounded, or square tile instead of silently ignoring
// the choice.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotAvatar } from "./Avatar";
import { DEFAULT_SILHOUETTE } from "./EmberAvatar";
import { MASCOT_BODIES, MASCOT_BODY_IDS } from "../../shared/mascot-bodies";

const vega = { name: "Vega", color: "orange" as const };
const html = (bot: Parameters<typeof BotAvatar>[0]["bot"]) =>
  renderToStaticMarkup(createElement(BotAvatar, { bot, size: 100, animated: false }));

describe("BotAvatar shapes for a mascot", () => {
  it("draws the bare mascot when the shape is Mascot or unset", () => {
    for (const bot of [vega, { ...vega, avatarCrop: "mascot" as const }]) {
      const markup = html(bot);
      expect(markup).not.toContain("data-avatar-shape");
      expect(markup).toContain("Vega");
    }
  });

  it("frames the mascot in the chosen tile when there is no image", () => {
    for (const [crop, radius] of [["circle", "50%"], ["rounded", "22%"], ["square", "0"]] as const) {
      const markup = html({ ...vega, avatarCrop: crop });
      expect(markup).toContain(`data-avatar-shape="${crop}"`);
      expect(markup).toContain(`border-radius:${radius}`);
      expect(markup).toContain("bg-raised");
      // raised is also the profile card (light) and a selected row's fill, so
      // the tile needs its own edge or the shape is invisible there
      expect(markup).toContain("shadow-[inset_0_0_0_1px_var(--color-hairline)]");
      expect(markup).not.toContain("<img");
      expect(markup).toContain("Vega");
    }
  });

  it("wears the bot's chosen mascot body, and the flame for none or an unknown one", () => {
    const flame = html(vega);
    expect(flame).toContain(DEFAULT_SILHOUETTE.clip.slice(0, 60));
    const star = html({ ...vega, mascotBody: "star" });
    expect(star).toContain(MASCOT_BODIES.star.clip.match(/d="([^"]{40})/)![1]);
    expect(star).not.toContain(DEFAULT_SILHOUETTE.clip.slice(0, 60));
    expect(html({ ...vega, mascotBody: "cursor" as never })).toContain(DEFAULT_SILHOUETTE.clip.slice(0, 60));
  });

  it("draws every body in the catalog, each with its own outline and face anchor", () => {
    const seen = new Set<string>();
    for (const body of MASCOT_BODY_IDS) {
      const markup = html({ ...vega, mascotBody: body });
      const shape = body === "ember" ? DEFAULT_SILHOUETTE : MASCOT_BODIES[body];
      const outline = shape.clip.match(/d="([^"]{40})/)![1];
      expect(markup, body).toContain(outline);
      const { x, y, scale } = shape.anchor;
      expect(markup, body).toContain(`translate(${x} ${y}) scale(${scale})`);
      expect(seen.has(outline), `${body} duplicates another body's outline`).toBe(false);
      seen.add(outline);
    }
    expect(seen.size).toBe(MASCOT_BODY_IDS.length);
  });

  it("frames the mascot too when the stored image is unusable", () => {
    const markup = html({ ...vega, avatarCrop: "rounded", avatarUrl: "https://untrusted.invalid/a.png" });
    expect(markup).toContain('data-avatar-shape="rounded"');
    expect(markup).not.toContain("untrusted.invalid");
  });

  it("still crops a real uploaded image with no extra tile", () => {
    const markup = html({ ...vega, avatarCrop: "circle", avatarUrl: "/api/attachments/portrait.png" });
    expect(markup).toContain('src="/api/attachments/portrait.png"');
    expect(markup).toContain("border-radius:50%");
    expect(markup).not.toContain("data-avatar-shape");
  });
});
