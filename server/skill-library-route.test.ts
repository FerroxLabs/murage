// Installing a bundled skill onto a bot — the route that did not exist.
//
// installSkillFromLibrary had exactly one caller in the whole server, buried
// inside POST /api/teams/import, so the only way to give a bot a capability
// was to hire an entire team. This is the primitive three separate features
// were each waiting on: assigning a skill from the library, adding one from a
// bot's own Skills panel, and an assistant configuring itself.
//
// It is also a security boundary, and that is why it lives on the desktop
// surface alone. An enabled skill is symlinked into the engine's native
// discovery directories, so choosing one is choosing instructions an agent
// will follow. That decision belongs to the person at the keyboard.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
  "utf8",
);

/** The route body, so an assertion cannot pass by matching some other route. */
const routeBody = (() => {
  const start = source.indexOf('path.match(/^\\/api\\/bots\\/([\\w-]+)\\/skills\\/library$/)');
  expect(start, "the library install route is missing entirely").toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("m = path.match", start + 10));
})();

describe("POST /api/bots/:id/skills/library", () => {
  it("refuses any surface but the desktop", () => {
    // A paired phone, and later the browser door, must not be able to install
    // instruction files. Nothing under /skills is on the companion allowlist
    // today, but that is one careless line away from changing, so the route
    // refuses on its own rather than trusting a list in another package.
    expect(routeBody).toContain('requestSurface(req.headers, url.searchParams) !== "desktop"');
    // 404, not 403 — consistent with every other withheld route, and it does
    // not confirm the endpoint exists to something that may not read it.
    const refusal = routeBody.slice(routeBody.indexOf("requestSurface"));
    expect(refusal.slice(0, refusal.indexOf("}"))).toContain("404");
  });

  it("is matched before the single-skill route that would swallow it", () => {
    // /skills/([a-z0-9-]+) matches "library" perfectly well, so ordering is
    // the only thing stopping this route being read as a skill named library.
    const library = source.indexOf("skills\\/library$");
    const single = source.indexOf("skills\\/([a-z0-9-]+)$");
    expect(library).toBeGreaterThan(-1);
    expect(single).toBeGreaterThan(-1);
    expect(library).toBeLessThan(single);
  });

  it("bounds how many instruction files one request may add", () => {
    expect(routeBody).toContain("MAX_LIBRARY_SKILLS_PER_REQUEST");
    const bound = /const MAX_LIBRARY_SKILLS_PER_REQUEST = (\d+);/.exec(source);
    expect(bound, "the bound must be a named constant, not a literal").toBeTruthy();
    // Large enough for the biggest bundled profile (11 skills), small enough
    // that a single call cannot bury someone.
    expect(Number(bound![1])).toBeGreaterThanOrEqual(11);
    expect(Number(bound![1])).toBeLessThanOrEqual(50);
  });

  it("installs through the library helper, so the traversal gate applies", () => {
    // installSkillFromLibrary's isSkillName check is what stops an id naming
    // anything but one direct child of the library root. Reaching around it
    // to read a path would reintroduce traversal.
    expect(routeBody).toContain("installSkillFromLibrary(bot.id, skillId, SKILL_LIBRARY_ROOT)");
    // No filesystem reach-around: the helper owns every path decision.
    // `errors.join` is the one legitimate join, so it is excluded by name.
    expect(routeBody.replace(/errors\.join/g, "")).not.toMatch(/join\(|readFileSync|readdirSync/);
  });

  it("enables what it installs, and says why in the route rather than the helper", () => {
    // The helper lands everything off because it cannot tell a first-party
    // bundled skill from a URL someone pasted. This caller can, so this is
    // where the decision belongs.
    expect(routeBody).toContain("setSkillEnabled(bot.id, result.name, true)");
  });

  it("reports per-id failures instead of failing the batch", () => {
    expect(routeBody).toContain("errors.push(result.error)");
    expect(routeBody).toContain("continue;");
    // And refuses honestly when nothing at all installed.
    expect(routeBody).toContain("422");
  });

  it("de-duplicates ids so a repeated name is not installed twice", () => {
    expect(routeBody).toContain("new Set(parsed.data.ids)");
  });
});

describe("the companion surface", () => {
  it("still exposes no skills route to a paired device", () => {
    // The route's own surface check is the real defence; this is the second
    // lock, and it fails loudly if someone adds one to the allowlist.
    const routes = readFileSync(
      fileURLToPath(new URL("../companion/src/routes.ts", import.meta.url)),
      "utf8",
    );
    expect(routes).not.toMatch(/skills/);
  });
});
