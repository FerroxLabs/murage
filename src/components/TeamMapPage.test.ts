// The org chart drew every bot as the bare mascot, so an uploaded avatar and
// the Circle/Rounded/Square shape never reached the Team map even though the
// sidebar, header and channels showed them. Its nodes go through BotAvatar.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./TeamMapPage.tsx", import.meta.url), "utf8");

describe("Team map bot nodes", () => {
  it("render the bot's own avatar, image and shape included", () => {
    const node = source.slice(source.indexOf("function BotNode"), source.indexOf("const RAIL_HEADING"));
    expect(node).toContain("<BotAvatar");
    expect(node).toContain("bot={bot}");
    expect(source).not.toMatch(/<EmberAvatar\b/);
  });
});
