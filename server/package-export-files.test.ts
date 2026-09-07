import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectPackageExportSkills, listPackageExportSkillCandidates } from "./package-export-files.ts";
import { snapshotInstalledSkill } from "./skills.ts";
import { DATA_DIR } from "./config.ts";
import { workspaceDir } from "./workspace.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const markdown = (name: string) => `---\nname: ${name}\ndescription: Check facts\nlicense: MIT\ndependencies:\n  - must-be-reviewed\n---\nRead references and use scripts only after review.\n`;
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "murage-export-skills-")); roots.push(workspace);
  const put = (path: string, content: string) => { mkdirSync(dirname(join(workspace, path)), { recursive: true }); writeFileSync(join(workspace, path), content); };
  put("skills/research/SKILL.md", markdown("research"));
  put("skills/research/references/note.md", "Exact reference");
  put("skills/research/scripts/check.sh", "echo do-not-execute");
  put("skills/private/SKILL.md", "fake-secret-outside-selection");
  put("credentials.txt", "fake-workspace-secret");
  return { workspace, put };
}

it("enumerates without parsing unselected content and collects exactly selected nested files", () => {
  const f = fixture();
  expect(listPackageExportSkillCandidates(f.workspace)).toEqual([{ key: "private", name: "private" }, { key: "research", name: "research" }]);
  const result = collectPackageExportSkills(f.workspace, ["research"]);
  expect([...result.payloads.keys()]).toEqual(["skills/research/SKILL.md", "skills/research/references/note.md", "skills/research/scripts/check.sh"]);
  expect(result.payloads.get("skills/research/scripts/check.sh")?.toString()).toBe("echo do-not-execute");
  expect(result.skills[0]).toMatchObject({ key: "research", license: "MIT", dependencies: [], dependencyStatus: "unverified" });
  expect(result.warnings.join(" ")).toContain("dependencies are unverified");
  expect([...result.payloads.values()].some(bytes => bytes.includes("fake-secret") || bytes.includes("fake-workspace-secret"))).toBe(false);
  expect(readFileSync(join(f.workspace, "skills/private/SKILL.md"), "utf8")).toBe("fake-secret-outside-selection");
  expect(collectPackageExportSkills(f.workspace, []).payloads.size).toBe(0);
});

it("uses Unspecified when there is no declared license", () => {
  const f = fixture(); f.put("skills/research/SKILL.md", markdown("research").replace("license: MIT\n", ""));
  expect(collectPackageExportSkills(f.workspace, ["research"]).skills[0].license).toBe("Unspecified");
});

it.each(["../private", "Research", "a/b", "con", "e\u0301"])("refuses unsafe selection %s with fixed sanitized errors", name => {
  const f = fixture();
  expect(() => collectPackageExportSkills(f.workspace, [name])).toThrow(/Selected skill export refused/);
  try { collectPackageExportSkills(f.workspace, [name]); } catch (error) { expect(String(error)).not.toContain(f.workspace); }
});

it("refuses oversized files before allocating their content", () => {
  const f = fixture();
  const path = join(f.workspace, "skills/research/large.bin"); writeFileSync(path, ""); truncateSync(path, 50 * 1024 * 1024 + 1);
  expect(() => collectPackageExportSkills(f.workspace, ["research"])).toThrow("SKILL_EXPORT_LIMIT");
  expect(existsSync(path)).toBe(true);
});

it.skipIf(process.platform === "win32")("refuses links and case collisions instead of reading external data", () => {
  for (const kind of ["symlink", "hardlink", "case"]) {
    const f = fixture();
    const target = join(f.workspace, "skills/research/unsafe");
    if (kind === "symlink") symlinkSync(join(f.workspace, "credentials.txt"), target);
    if (kind === "hardlink") linkSync(join(f.workspace, "credentials.txt"), target);
    if (kind === "case") { f.put("skills/research/REF/first", "a"); f.put("skills/research/ref/second", "b"); }
    if (kind === "case" && !existsSync(join(f.workspace, "skills/research/REF/second"))) {
      expect(() => collectPackageExportSkills(f.workspace, ["research"])).toThrow("UNSAFE_SKILL_SOURCE");
    } else if (kind !== "case") expect(() => collectPackageExportSkills(f.workspace, ["research"])).toThrow("UNSAFE_SKILL_SOURCE");
  }
});

it("snapshots the installed reviewed revision without exporting stale direct files or migrating metadata", () => {
  const botId = randomUUID(), workspace = workspaceDir(botId), state = join(DATA_DIR, "skill-state", botId);
  roots.push(workspace, state);
  const revision = "a".repeat(64), content = markdown("research"), digest = createHash("sha256").update(content).digest("hex");
  const source = join(workspace, "skills", ".revisions", revision);
  mkdirSync(source, { recursive: true }); mkdirSync(state, { recursive: true });
  mkdirSync(join(workspace, "skills", "research"));
  writeFileSync(join(workspace, "skills", "research", "SKILL.md"), "stale-private-content");
  writeFileSync(join(source, "SKILL.md"), content);
  writeFileSync(join(source, "reference.txt"), "Reviewed revision reference");
  const manifest = JSON.stringify({ research: { description: "Check facts", enabled: false, source: "fixture", sha256: digest, importedAt: "2026-09-06", warnings: [], skippedFiles: [], storageRevision: revision } });
  writeFileSync(join(state, "skills.json"), manifest);
  const result = snapshotInstalledSkill(botId, "research");
  expect(result.payloads.get("skills/research/SKILL.md")?.toString()).toBe(content);
  expect(result.payloads.get("skills/research/reference.txt")?.toString()).toBe("Reviewed revision reference");
  expect(result.dependencies).toBeNull();
  expect(readFileSync(join(state, "skills.json"), "utf8")).toBe(manifest);
  writeFileSync(join(source, "SKILL.md"), content + "changed");
  expect(() => snapshotInstalledSkill(botId, "research")).toThrow("could not be exported safely");
});
