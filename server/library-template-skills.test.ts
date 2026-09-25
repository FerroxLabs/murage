// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A team made from a library template switches on every skill its bots come
// with. Trend Desk promised 22 and delivered 21: Skill Guard read one line of
// user-research-plan as a warning, so the skill arrived switched off and the
// only trace was a server log line (0.1.60 Linux customer pass, D7). Every
// skill a template hands out must pass the same scan the switch-on runs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_LIBRARY_ROOT, parseSkillMd } from "./skills.ts";
import { scanSkill } from "./skill-guard/scan.ts";

const packagesDir = new URL("../library/packages/", import.meta.url);
const verdicts = JSON.parse(readFileSync(new URL("../skills-library/scan-verdicts.json", import.meta.url), "utf8")).skills as Record<string, { verdict: string }>;
const templateSkills = new Set<string>();
for (const name of readdirSync(packagesDir).filter(file => file.endsWith(".json"))) {
  const pkg = JSON.parse(readFileSync(new URL(name, packagesDir), "utf8")).package;
  for (const agent of pkg.agents ?? []) for (const skill of agent.skills ?? []) templateSkills.add(skill);
}

describe("template skills switch on", () => {
  it("covers the skill Trend Desk lost", () => {
    expect(templateSkills.has("user-research-plan")).toBe(true);
  });

  it.each([...templateSkills].sort())("%s passes the switch-on scan", id => {
    const text = readFileSync(join(SKILL_LIBRARY_ROOT, id, "SKILL.md"), "utf8");
    const parsed = parseSkillMd(text);
    const description = "error" in parsed ? "" : parsed.description;
    const scan = scanSkill({ name: id, description, triggerTerms: [], files: [{ path: "SKILL.md", content: text }] });
    expect(scan.findings.map(f => `${f.severity} ${f.rule}: ${f.evidence}`)).toEqual([]);
    expect(scan.verdict).toBe("clean");
    // and the shipped verdict list the library panel reads agrees
    expect(verdicts[id]?.verdict).toBe("clean");
  });
});
