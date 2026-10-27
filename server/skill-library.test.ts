import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBundledSkills, loadUserSkills, mergeSkills, parseSkillManifest, selectBundledSkills, shippedSkillCheck, skillInstructionsFor, skillsForAudience, skillsWithMountedTools, type BundledSkill } from "./skill-library.ts";

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
    const root = mkdtempSync(join(tmpdir(), "murage-skills-"));
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

  it("keeps an owner's recording to turns that answer the owner unless the owner shares it", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-skills-"));
    const write = (id: string, extra: Record<string, unknown>) => {
      const directory = join(root, id);
      mkdirSync(directory);
      writeFileSync(join(directory, "manifest.json"), JSON.stringify({
        id, name: id, version: "1.0.0", description: "Recorded", defaultEnabled: true, triggerTerms: ["expense"], requiredCapabilities: [], ...extra,
      }));
      writeFileSync(join(directory, "SKILL.md"), `---\nname: ${id}\ndescription: Recorded\n---\nWindow title: Payroll.\n`);
    };
    write("recorded-expense", { audience: "owner" });
    write("older-recording", {});
    write("shared-expense", { audience: "everyone" });
    const shippedPhone = { ...phone, manifest: { ...phone.manifest, triggerTerms: ["expense"], requiredCapabilities: [] }, shipped: true as const };
    const catalogue = mergeSkills([shippedPhone], loadUserSkills(root));
    const shipped = shippedSkillCheck([shippedPhone]);
    const ids = (ownerTurn: boolean) => selectBundledSkills("file my expense", [], skillsForAudience(catalogue, ownerTurn, shipped)).map((skill) => skill.manifest.id).sort();
    expect(ids(true)).toEqual(["older-recording", "phone-harness", "recorded-expense", "shared-expense"]);
    expect(ids(false)).toEqual(["phone-harness", "shared-expense"]);
    expect(() => parseSkillManifest({ ...phone.manifest, audience: "room" }, "/skills/phone-harness")).toThrow(/invalid audience/);
  });

  it("chooses trigger-term skills from the audience's catalogue on direct and room turns", () => {
    const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(index).toContain("skillsForAudience(pinnedProcedures.catalogue, directOwnerAudience && ownServersAllowedFor(bot), murageSkill)");
    expect(index).toContain("const audienceSkills = skillsForAudience(skills, roomOwnerAudience && ownServersAllowedFor(bot), murageSkill);");
    expect(index.match(/^\s+audienceSkills,$/gmu)).toHaveLength(2);
  });

  it("does not let a user skill shadow a bundled skill id", () => {
    expect(mergeSkills([phone], [{ ...phone, instructions: "user replacement" }])).toEqual([phone]);
  });

  it("treats a non-directory user skill root as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-skills-root-"));
    const file = join(root, "not-a-directory");
    writeFileSync(file, "nope");
    expect(loadUserSkills(file)).toEqual([]);
  });
});

describe("bundled verification skill", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const instructions = skills.find((skill) => skill.manifest.id === "create-verification-skill")?.instructions ?? "";

  it("ships one reviewed authoring adapter", () => {
    const ids = skills.map((skill) => skill.manifest.id);
    expect(ids).toContain("create-verification-skill");
    expect(ids).not.toContain("maintain-verification-skill");
    expect(instructions).toContain("skill_manage");
    expect(instructions).not.toContain("~/.murage");
    expect(instructions).not.toContain("propose_routine");
  });

  it("requires skill authoring and an explicit creation request", () => {
    for (const text of [
      "/create-verification-skill for my notes app",
      "can you make a verification skill so you can prove changes work",
    ]) {
      expect(selectBundledSkills(text, [], skills)).toEqual([]);
      expect(selectBundledSkills(text, ["skillAuthoring"], skills).map((skill) => skill.manifest.id))
        .toEqual(["create-verification-skill"]);
    }
  });

  it("does not mount for generic verification or maintenance phrasing", () => {
    for (const text of [
      "please verify the numbers in this invoice",
      "maintain the verification skill for atlas",
      "the verification skill is stale",
      "make a control cli",
      "create a feature map for my app",
    ]) {
      expect(selectBundledSkills(text, ["skillAuthoring"], skills)).toEqual([]);
    }
  });

  it("bundles the image-generation skill, chosen only when image generation is on", () => {
    const skills = loadBundledSkills(join(process.cwd(), "skills"));
    const image = skills.find((skill) => skill.manifest.id === "image-generation");
    expect(image?.manifest).toMatchObject({ requiredCapabilities: ["imageGeneration"], defaultEnabled: true });
    expect(image?.instructions).toMatch(/^---\nname: image-generation\n/);
    for (const name of ["list_image_models", "generate_image", "resolve_image_reference", "condensed_from_chars", "aspect_ratio", "prompt_blocks", "save_prompt_block", "get_prompt_block", "reference_pack", "save_reference_pack", "list_prompt_blocks", "list_reference_packs"]) expect(image?.instructions).toContain(name);
    // No fixed limits: they come from list_image_models per model.
    expect(image?.instructions).not.toMatch(/4,000|three sizes|4 references/);
    expect(image?.instructions).not.toMatch(/\u2014|\bsaf(e|ely|ety)\b|\$\d/i);
    const ids = (text: string, capabilities: string[]) => selectBundledSkills(text, capabilities, skills).map((skill) => skill.manifest.id);
    expect(ids("Make an image of a lighthouse in 9:16", ["imageGeneration"])).toContain("image-generation");
    expect(ids("Make an image of a lighthouse in 9:16", [])).not.toContain("image-generation");
    expect(ids("Summarise my notes", ["imageGeneration"])).not.toContain("image-generation");
  });
});

describe("a skill rides a turn only with the tools it needs", () => {
  it("drops the phone skill when this turn has no phone mounted (not the owner's audience), and keeps it when it does", () => {
    const other = { ...phone, directory: "/skills/other", manifest: { ...phone.manifest, id: "other", requiredCapabilities: [] } };
    expect(skillsWithMountedTools([phone, other], { phone: false })).toEqual([other]);
    expect(skillsWithMountedTools([phone, other], { phone: true })).toEqual([phone, other]);
  });
});
