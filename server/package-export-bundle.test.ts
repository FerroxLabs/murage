import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBotPackageExportBundle, type BotPackageBundleInput, type SelectedExportSkill } from "./package-export-bundle.ts";
import { readBotPackageArchive, writeBotPackageArchive } from "./bot-package-archive.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): BotPackageBundleInput {
  return { exportInput: { name: "Selected crew", bots: ["first", "second"].map(id => ({ id, name: "Scout", title: "Research", description: "Review supplied notes", threadId: `runtime-${id}`, color: "green", notifications: true, unread: false, createdAt: 1,
    modelSelection: { instanceId: "private-engine", model: "private-model" }, resumeCursors: { engine: "private-session" }, autoApprove: true, alwaysAllow: ["private-grant"], cwd: "/private/workspace" })),
    groups: [], routines: [], selection: { botIds: ["second"], playbookKeys: [], routineIds: [] } },
    skills: [{ botId: "second", key: "research", name: "Research", license: "MIT", dependencies: [], payloads: new Map([
      ["skills/research/SKILL.md", Buffer.from("---\nname: research\ndescription: Review supplied notes.\nlicense: MIT\n---\nRead references/guide.md.\n")],
      ["skills/research/references/guide.md", Buffer.from("Compare the user's supplied notes and list uncertainties.\n")],
    ]) }],
  };
}
describe("selected file-backed package bundle", () => {
  it("round trips selected supporting files and stable portable agent keys without runtime state", async () => {
    const bundle = createBotPackageExportBundle(fixture());
    expect(bundle.manifest.definition.package.agents[0]).toMatchObject({ key: "scout-2", skills: ["research"] });
    expect(bundle.summary).toMatchObject({ agents: 1, skills: 1, files: 3 });
    expect(JSON.stringify(bundle.manifest)).not.toMatch(/runtime-first|runtime-second|private-engine|private-model|private-session|private-grant|private\/workspace|alwaysAllow/);
    const root = mkdtempSync(join(tmpdir(), "murage-bundle-export-")); roots.push(root);
    const archive = join(root, "selected.zip");
    await writeBotPackageArchive(archive, bundle);
    const intake = await readBotPackageArchive(archive);
    expect(intake.manifest).toEqual(bundle.manifest);
    expect(intake.payloads.get("skills/research/references/guide.md")).toEqual(bundle.payloads.get("skills/research/references/guide.md"));
  });
  it("deduplicates identical shared skills but refuses differing same-key content or ownership", () => {
    const input = fixture(); input.exportInput.selection.botIds = ["first", "second"];
    input.skills = [...input.skills, { ...input.skills[0], botId: "first" }];
    const bundle = createBotPackageExportBundle(input);
    expect(bundle.manifest.skills).toHaveLength(1);
    expect(bundle.manifest.definition.package.agents.every(agent => agent.skills?.[0] === "research")).toBe(true);
    const conflicting: SelectedExportSkill = { ...input.skills[0], botId: "first", payloads: new Map(input.skills[0].payloads) };
    (conflicting.payloads as Map<string, Buffer>).set("skills/research/references/guide.md", Buffer.from("Different"));
    expect(() => createBotPackageExportBundle({ ...input, skills: [input.skills[0], conflicting] })).toThrow("same key differ");
    expect(() => createBotPackageExportBundle({ ...fixture(), skills: [{ ...fixture().skills[0], botId: "first" }] })).toThrow("unselected bot");
  });
  it("binds payload contents and dependency warnings into the deterministic review hash", () => {
    const input = fixture();
    const first = createBotPackageExportBundle(input);
    const reverse = { ...input.skills[0], payloads: new Map([...input.skills[0].payloads].reverse()) };
    expect(createBotPackageExportBundle({ ...input, skills: [reverse] }).previewHash).toBe(first.previewHash);
    (reverse.payloads as Map<string, Buffer>).set("skills/research/references/guide.md", Buffer.from("Updated safe notes"));
    expect(createBotPackageExportBundle({ ...input, skills: [reverse] }).previewHash).not.toBe(first.previewHash);
    const unknown = createBotPackageExportBundle({ ...input, skills: [{ ...input.skills[0], dependencies: null }] });
    expect(unknown.reviewWarnings).toHaveLength(1);
    expect(unknown.previewHash).not.toBe(first.previewHash);
    expect(() => createBotPackageExportBundle({ ...input, skills: [{ ...input.skills[0], dependencies: ["missing"] }] })).toThrow("dependency is missing");
  });
  it("withholds all review file contents when any selected supporting file contains a secret", () => {
    const input = fixture(); const skill = input.skills[0];
    (skill.payloads as Map<string, Buffer>).set("skills/research/references/guide.md", Buffer.from("Bearer fake_secret_canary_1234567890"));
    const bundle = createBotPackageExportBundle(input);
    expect(bundle.scan.blocked).toBe(true);
    expect(bundle.files.every(file => !("content" in file))).toBe(true);
    expect(JSON.stringify(bundle.scan)).not.toContain("fake_secret_canary");
  });
});
