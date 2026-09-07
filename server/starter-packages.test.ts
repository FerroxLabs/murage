import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBotPackage } from "./bot-package.ts";

describe("self-contained starter packages", () => {
  for (const id of ["starter-personal-home", "starter-solo-business", "starter-business-team"]) it(`${id} is portable and grants no live authority`, () => {
    const raw = JSON.parse(readFileSync(new URL(`../library/packages/${id}.json`, import.meta.url), "utf8"));
    const parsed = parseBotPackage(raw);
    expect(parsed).toEqual(raw); // No forbidden fields silently stripped by the parser.
    const pkg = parsed.package;
    expect(pkg.agents.length).toBeGreaterThanOrEqual(1);
    expect(pkg.agents.length).toBeLessThanOrEqual(3);
    expect(pkg.requirements).toEqual({ apps: [], capabilities: [] });
    expect(pkg.agents.every(agent => !agent.skills?.length)).toBe(true);
    expect(pkg.routines?.every(routine => routine.enabledAfterInstall === false)).toBe(true);
    expect(pkg.examples?.[0].input.length).toBeGreaterThan(40);
    expect(pkg.playbooks?.every(playbook => /user|supplied/i.test(playbook.instructions))).toBe(true);
    expect(pkg.summary).toMatch(/suggested/i);
    expect(JSON.stringify(raw)).not.toMatch(/"(?:apiKey|autoApprove|alwaysAllow|cwd|sessionId|chiefScope|enabled)"\s*:/);
  });
});
