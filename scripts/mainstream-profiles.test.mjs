// The seven mainstream profiles must actually install what their cards promise.
//
// Two failures this pins, both learned the hard way:
//
//   * A profile whose skills all fail to resolve is INVISIBLE. chooseIntakeProfile
//     (src/lib/onboarding-intake.ts) does `if (skills.length === 0) continue;`, so a
//     profile declaring nothing — or nothing real — can never be offered by the
//     intake matcher. 18 of the older bot-library/builtins are in that state.
//   * PARTIAL resolution silently over-promises. The gate only requires
//     skills.length > 0, so a profile declaring ten ids of which one resolves is
//     still offered, and the card renders prose written for all ten.
//
// So: every id, not most of them. And installability is not "the directory
// exists" — installSkillFromLibrary needs SKILL.md AND manifest.json, and the
// SKILL.md frontmatter `name` must equal the manifest id or the install fails at
// the last step. Nine catalogued skills are broken exactly that way; asserting the
// invariant rather than the blocklist means a tenth cannot slip in unnoticed.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseBotPackage } from "../server/bot-package.ts";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillLibrary = join(repoRoot, "skills-library");

/** The profiles this test owns. Added together, aimed at the ~80% of real usage
 *  (Practical Guidance, Seeking Information, Writing) the library did not serve. */
const MAINSTREAM_PROFILES = ["concierge", "writer", "explainer", "researcher", "advisor", "creator", "builder"];

/** Catalogued but unusable: SKILL.md frontmatter `name` !== manifest id, so the
 *  install fails after the download. Referencing one is a promise that breaks. */
const KNOWN_BROKEN_SKILLS = [
  "ab-test-design-data-analysis",
  "academic-argument-writing",
  "code-reviewer-software-engineering",
  "incident-commander-devops-cloud",
  "incident-response-software-project",
  "risk-assessment-productivity",
  "security-auditor-security",
  "skill-gap-analysis-education",
  "sprint-facilitator-business-strategy",
];

function loadProfile(slug) {
  const file = join(repoRoot, "bot-library", "builtins", `${slug}.json`);
  return parseBotPackage(JSON.parse(readFileSync(file, "utf8"))).package;
}

function declaredSkills(pkg) {
  return [...new Set(pkg.agents.flatMap((agent) => agent.skills ?? []))];
}

/** Why this id would not install, or null if it would. */
function installFailure(id) {
  const dir = join(skillLibrary, id);
  if (!existsSync(join(dir, "SKILL.md"))) return "no SKILL.md";
  if (!existsSync(join(dir, "manifest.json"))) return "no manifest.json";
  const frontmatter = readFileSync(join(dir, "SKILL.md"), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return "SKILL.md has no frontmatter";
  const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, "");
  if (name !== id) return `SKILL.md name "${name}" !== manifest id`;
  return null;
}

describe("mainstream profiles", () => {
  it.each(MAINSTREAM_PROFILES)("%s declares skills that all resolve", (slug) => {
    const pkg = loadProfile(slug);
    const declared = declaredSkills(pkg);
    // Zero skills is the invisibility bug: the intake matcher skips the profile
    // entirely, so the card can never be offered no matter how well it is written.
    expect(declared.length).toBeGreaterThan(0);
    const broken = declared.map((id) => [id, installFailure(id)]).filter(([, why]) => why !== null);
    expect(broken).toEqual([]);
  });

  it("references none of the nine skills that are catalogued but cannot install", () => {
    const referenced = MAINSTREAM_PROFILES.flatMap((slug) => declaredSkills(loadProfile(slug)));
    expect(referenced.filter((id) => KNOWN_BROKEN_SKILLS.includes(id))).toEqual([]);
    // And the blocklist is still describing reality — if one of these were fixed
    // upstream the entry should go, not linger as folklore.
    for (const id of KNOWN_BROKEN_SKILLS) expect(installFailure(id)).not.toBeNull();
  });

  it("promises no connector it cannot honour", () => {
    // Zero of the 2,237 shipped skills can drive Composio or MCP, so a profile
    // declaring a required app would advertise a capability that does not exist.
    for (const slug of MAINSTREAM_PROFILES) {
      const pkg = loadProfile(slug);
      expect(pkg.requirements.apps).toEqual([]);
      expect(pkg.requirements.capabilities).toEqual([]);
    }
  });
});
