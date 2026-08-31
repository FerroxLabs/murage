import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBundledSkills, loadUserSkills, mergeSkills, parseSkillManifest, selectBundledSkills, skillInstructionsFor, type BundledSkill } from "./skill-library.ts";

const phone: BundledSkill = {
  directory: "/skills/phone-harness",
  instructions: "---\nname: phone-harness\ndescription: test\n---\nUse phone tools.",
  manifest: {
    id: "phone-harness",
    name: "Phone Harness",
    version: "0.1.0",
    description: "Control a phone",
    defaultEnabled: true,
    triggerTerms: ["android", "phone"],
    requiredCapabilities: ["phoneMcp"],
  },
};

describe("bundled skill library", () => {
  it("selects a skill only when both its trigger and capability are present", () => {
    const rendered = skillInstructionsFor("Open Uber on my Android", ["phoneMcp"], [phone]);
    expect(rendered).toContain("Use phone tools");
    expect(rendered).not.toContain('root="/skills/phone-harness"');
    expect(skillInstructionsFor("Open Uber on my Android", ["phoneMcp"], [phone], { includeRoot: true }))
      .toContain('root="/skills/phone-harness"');
    expect(skillInstructionsFor("Open Uber on my Android", [], [phone])).toBe("");
    expect(skillInstructionsFor("Write a poem", ["phoneMcp"], [phone])).toBe("");
  });

  it("requires the manifest id to match its isolated folder", () => {
    expect(() => parseSkillManifest({
      ...phone.manifest,
      id: "other-skill",
    }, "/skills/phone-harness")).toThrow(/invalid id/);
  });

  it("loads a recorded skill without letting a broken sibling disable it", () => {
    const root = mkdtempSync(join(tmpdir(), "openmausbot-skills-"));
    const valid = join(root, "file-expense");
    mkdirSync(valid);
    writeFileSync(join(valid, "manifest.json"), JSON.stringify({
      id: "file-expense", name: "File expense", version: "1.0.0", description: "File expenses",
      defaultEnabled: true, triggerTerms: ["expense"], requiredCapabilities: [],
    }));
    writeFileSync(join(valid, "SKILL.md"), "---\nname: file-expense\ndescription: File expenses\n---\nDo it safely.\n");
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "manifest.json"), "not json");
    writeFileSync(join(broken, "SKILL.md"), "broken");

    expect(loadUserSkills(root).map((skill) => skill.manifest.id)).toEqual(["file-expense"]);
  });

  it("does not let a user skill shadow a bundled skill id", () => {
    expect(mergeSkills([phone], [{ ...phone, instructions: "user replacement" }])).toEqual([phone]);
  });

  it("treats a non-directory user skill root as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "openmausbot-skills-root-"));
    const file = join(root, "not-a-directory");
    writeFileSync(file, "nope");
    expect(loadUserSkills(file)).toEqual([]);
  });
});

describe("bundled verification skills", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));

  it("ship enabled with valid manifests", () => {
    const ids = skills.map((skill) => skill.manifest.id);
    expect(ids).toContain("create-verification-skill");
    expect(ids).toContain("maintain-verification-skill");
    for (const skill of skills) {
      expect(skill.manifest.defaultEnabled).toBe(true);
      expect(skill.instructions.startsWith("---")).toBe(true);
    }
  });

  it("the slash form and natural phrasing both select create, and only create", () => {
    for (const text of [
      "/create-verification-skill for my notes app",
      "can you make a verification skill so you can prove changes work",
    ]) {
      const selected = selectBundledSkills(text, [], skills).map((skill) => skill.manifest.id);
      expect(selected).toContain("create-verification-skill");
      expect(selected).not.toContain("maintain-verification-skill");
    }
  });

  it("maintenance phrasing selects maintain without dragging in create", () => {
    const selected = selectBundledSkills("/maintain-verification-skill for atlas", [], skills)
      .map((skill) => skill.manifest.id);
    expect(selected).toContain("maintain-verification-skill");
    expect(selected).not.toContain("create-verification-skill");
  });

  it("ordinary chat selects neither", () => {
    const selected = selectBundledSkills("please verify the numbers in this invoice", [], skills)
      .map((skill) => skill.manifest.id);
    expect(selected).not.toContain("create-verification-skill");
    expect(selected).not.toContain("maintain-verification-skill");
  });
});
