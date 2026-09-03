import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKILL_LIBRARY_ROOT, checkLibrarySkill } from "./skills.ts";

/** The nine skills this guard was written for shipped on disk for months and
 * never installed: the profile asked for them, installSkillFromLibrary
 * rejected them one by one, and the caller logged and carried on. Nothing
 * walked the catalog, so nothing noticed. This walks it. */

function skillIds(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** One line per skill that installSkillFromLibrary would refuse, naming the
 * skill and the exact rule it broke — the message is the whole point, so the
 * next person fixes it from the test output alone. */
function unresolvable(root: string): string[] {
  return skillIds(root).flatMap((id) => {
    const checked = checkLibrarySkill(id, root);
    return "error" in checked ? [`  ${id} -> ${checked.error}`] : [];
  });
}

const temporaries: string[] = [];

function libraryCopy(ids: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "murage-skill-library-"));
  temporaries.push(root);
  for (const id of ids) cpSync(join(SKILL_LIBRARY_ROOT, id), join(root, id), { recursive: true });
  return root;
}

afterEach(() => {
  while (temporaries.length) rmSync(temporaries.pop()!, { recursive: true, force: true });
});

describe("shipped skill library", () => {
  it("resolves every skill on disk", () => {
    expect(existsSync(SKILL_LIBRARY_ROOT), `skill library missing at ${SKILL_LIBRARY_ROOT}`).toBe(true);
    const ids = skillIds(SKILL_LIBRARY_ROOT);
    // A library that reads as empty would pass the walk vacuously, which is
    // exactly the silence this guard exists to break.
    expect(ids.length, `no skill directories under ${SKILL_LIBRARY_ROOT}`).toBeGreaterThan(100);
    const failures = unresolvable(SKILL_LIBRARY_ROOT);
    expect(
      failures.join("\n"),
      `${failures.length} of ${ids.length} skills under ${SKILL_LIBRARY_ROOT} would fail to install. ` +
        "installSkillFromLibrary rejects each of these, and the installer logs and continues, " +
        "so a bot silently gets fewer skills than its profile declared. Fix the skill, not this test.",
    ).toBe("");
  });
});

/** The walk above is only worth its runtime if it actually goes red. These
 * corrupt copies — never the real library — one rule at a time. */
describe("skill library guard", () => {
  it("catches a frontmatter name that disagrees with the directory", () => {
    const root = libraryCopy(["ab-test-design"]);
    const skillMd = join(root, "ab-test-design", "SKILL.md");
    writeFileSync(skillMd, readFileSync(skillMd, "utf8").replace("name: ab-test-design", "name: ab-test-designs"));
    expect(unresolvable(root)).toEqual([
      "  ab-test-design -> library skill \"ab-test-design\" declares frontmatter name \"ab-test-designs\" " +
        "but its directory and manifest id are \"ab-test-design\" — " +
        "SKILL.md frontmatter name must equal the directory name",
    ]);
  });

  it("catches a manifest id that disagrees with the directory", () => {
    const root = libraryCopy(["ab-test-design"]);
    const manifest = join(root, "ab-test-design", "manifest.json");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace('"id": "ab-test-design"', '"id": "borrowed-id"'));
    expect(unresolvable(root)).toEqual([
      expect.stringContaining("manifest.json has an invalid id"),
    ]);
  });

  it("catches a deleted manifest.json", () => {
    const root = libraryCopy(["ab-test-design"]);
    rmSync(join(root, "ab-test-design", "manifest.json"));
    expect(unresolvable(root)).toEqual([
      expect.stringContaining('ab-test-design -> library skill "ab-test-design" could not be read: ENOENT'),
    ]);
  });

  it("catches a manifest.json that is not a file", () => {
    const root = libraryCopy(["ab-test-design"]);
    const manifest = join(root, "ab-test-design", "manifest.json");
    rmSync(manifest);
    mkdirSync(manifest);
    expect(unresolvable(root)).toEqual([
      '  ab-test-design -> library skill "ab-test-design" has no manifest.json',
    ]);
  });

  it("catches SKILL.md with no frontmatter", () => {
    const root = libraryCopy(["ab-test-design"]);
    writeFileSync(join(root, "ab-test-design", "SKILL.md"), "# no frontmatter here\n");
    expect(unresolvable(root)).toEqual([
      expect.stringContaining("SKILL.md has no YAML frontmatter"),
    ]);
  });

  it("reports nothing for an intact copy", () => {
    expect(unresolvable(libraryCopy(["ab-test-design"]))).toEqual([]);
  });

  it("reports a directory that holds no skill at all", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-skill-library-empty-"));
    temporaries.push(root);
    mkdirSync(join(root, "not-a-skill"));
    expect(unresolvable(root)).toEqual([
      expect.stringContaining('not-a-skill -> library skill "not-a-skill" could not be read: ENOENT'),
    ]);
  });
});
