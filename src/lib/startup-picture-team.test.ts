// SPDX-License-Identifier: AGPL-3.0-or-later
// FIRSTRUN-1019 rulings 2 and 5 (MurageMain, Sean 11-09): real faces for the person's teammates on a daily start (five, then "+N"),
// the same row of real faces for the starter team on the welcome. Slices B and C.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validatePicture } from "../../electron/startup-picture.mjs";
import { splashPage } from "../../electron/startup-splash.mjs";
import { composeStartupPicture, type ComposeInput } from "./startup-picture-compose";
import { faceRow } from "./face-row";
import { STARTER_TEAM } from "./first-run-starter-team";
import en from "../locales/startup-tips/en.json";

const MASCOT = (name: string, state: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" data-who="${name}" data-state="${state}"><circle cx="15" cy="15" r="10" fill="#ff6b35"/></svg>`;
const mate = (n: number) => ({ id: `m${n}`, name: `Mate${n}`, color: "blue" as const });
const compose = (mates: number, extra: Partial<ComposeInput> = {}) => composeStartupPicture({
  roster: { chief: { id: "s", name: "Sable", color: "orange" as const }, mates: Array.from({ length: mates }, (_, i) => mate(i + 1)) } as ComposeInput["roster"],
  language: "en", os: "mac", phoneAvailable: true, sessionTip: 0, loadStrings: async () => en,
  renderMascot: async (bot, state) => MASCOT(bot.name, state), loadPhoto: async () => null, now: () => 1, ...extra,
});
const page = (picture: unknown) => decodeURIComponent(splashPage({ mode: "tip", picture: picture as never, language: "en" }).split(",").slice(1).join(","));

describe("faceRow: up to five, then +N", () => {
  it("shows up to five and counts the rest", () => {
    expect(faceRow([])).toEqual({ shown: [], more: 0 });
    expect(faceRow([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(faceRow([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3, 4, 5], more: 0 });
    expect(faceRow([1, 2, 3, 4, 5, 6])).toEqual({ shown: [1, 2, 3, 4, 5], more: 1 });
    expect(faceRow(Array.from({ length: 22 }, (_, i) => i)).more).toBe(17);
  });
});

describe("ruling 2: the daily start shows real faces for the teammates too", () => {
  it("composes the first five teammates' own faces and counts the rest (22 bots: five and +16)", async () => {
    const picture = await compose(21); // the Chief plus 21 teammates = 22 bots
    expect(picture!.team!.faces).toHaveLength(5);
    expect(picture!.team!.more).toBe(16);
    expect(picture!.team!.faces[0]).toContain('data-who="Mate1"'); // sidebar order: {m1} first, {m2} second, as the tip text names them
    expect(picture!.team!.faces[1]).toContain('data-who="Mate2"');
    expect(validatePicture(picture)!.team).toEqual(picture!.team);
  });

  it("with no teammates there is no row, and a face that cannot be drawn is left out and counted", async () => {
    expect((await compose(0))!.team).toBeUndefined();
    const picture = await compose(3, { renderMascot: async (bot, state) => (bot.name === "Mate2" ? null : MASCOT(bot.name, state)) });
    expect(picture!.team!.faces).toHaveLength(2);
    expect(picture!.team!.more).toBe(1);
  });

  it("the row gives way before the file limit does", async () => {
    const big = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><path d=\"" + "M0 0L1 1".repeat(5000) + "\"/></svg>";
    const picture = await compose(5, { renderMascot: async (bot, state) => (bot.name === "Sable" ? MASCOT(bot.name, state) : big) });
    expect(JSON.stringify(picture).length).toBeLessThanOrEqual(150_000);
  });

  it("main keeps a good row, and a hostile or oversized row drops only the row", async () => {
    const good = (await compose(2))!;
    expect(validatePicture(good)!.team!.faces).toHaveLength(2);
    const evil = MASCOT("x", "idle").replace("<circle", "<script>1</script><circle");
    for (const team of [{ faces: [evil], more: 0 }, { faces: Array(6).fill(MASCOT("a", "idle")), more: 0 }, { faces: [MASCOT("a", "idle")], more: -1 }, { faces: [], more: 3 }, "x"]) {
      const checked = validatePicture({ ...good, team });
      expect(checked, "the picture itself survives").not.toBeNull();
      expect(checked!.team).toBeUndefined();
    }
  });

  it("the splash draws the row as images, five then +N, and nothing when there is none", async () => {
    const withRow = page(await compose(8));
    expect(withRow.match(/<img src="data:image\/svg\+xml;base64,/g)).toHaveLength(5);
    expect(withRow).toContain('<span class="more">+3</span>');
    expect(page(await compose(0))).not.toContain('class="team"');
    expect(page(null)).not.toContain('class="team"');
    expect(withRow).not.toContain("data-who="); // faces are image data, never page markup
  });
});

describe("ruling 5: the welcome's starter team is the shipped starter agents", () => {
  const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../library/packages/${name}.json`, import.meta.url)), "utf8")).package;
  it("names and looks match library/packages/starter-*.json, in a fixed order", () => {
    const shipped = ["starter-solo-business", "starter-business-team", "starter-personal-home"].flatMap((name) => read(name).agents as Array<{ key: string; name: string; appearance: { color: string; mascotBody: string } }>);
    const byKey = new Map(shipped.map((agent) => [agent.key, agent]));
    expect(STARTER_TEAM.map((face) => face.key).sort()).toEqual([...byKey.keys()].sort());
    for (const face of STARTER_TEAM) {
      const agent = byKey.get(face.key)!;
      expect(face.name).toBe(agent.name);
      expect(face.color).toBe(agent.appearance.color);
      expect(face.mascotBody).toBe(agent.appearance.mascotBody);
    }
  });
});
