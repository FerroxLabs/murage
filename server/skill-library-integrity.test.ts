import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKILL_LIBRARY_ROOT, checkLibrarySkill } from "./skills.ts";

/** The catalog builder is plain JS with no declaration file, and this repo has
 * no .d.ts anywhere under scripts/. Rather than add one, the single export this
 * test needs is typed at the boundary; the specifier is held in a variable so
 * TypeScript treats the module as untyped instead of erroring on the missing
 * declarations. */
const BUILDER_MODULE = "../scripts/build-local-catalog.mjs";
async function loadBuilder(): Promise<{ installableSkillIds: (root: string) => Set<string> }> {
  return await import(BUILDER_MODULE);
}

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

/** The end invariant, stated on the artifact users actually receive.
 *
 * library/catalog.json is generated and CI-gated, and each entry advertises
 * its skills as `teams/<slug>/skills/<id>/SKILL.md`. Every one of those ids
 * has to install, or the card's "Set this up" button promises something the
 * installer will refuse. The catalog builder is what decides which declared
 * ids survive into that list, so builder and installer must agree exactly —
 * the builder used to test only that two files existed while its comment
 * claimed it matched the installer, which let an uninstallable skill through
 * on any rule beyond file presence. */
describe("shipped catalog", () => {
  const CATALOG = join(SKILL_LIBRARY_ROOT, "..", "library", "catalog.json");

  function advertisedSkillIds(): string[] {
    const catalog = JSON.parse(readFileSync(CATALOG, "utf8")) as {
      teams: Array<{ slug: string; skills?: string[] }>;
    };
    return [
      ...new Set(
        catalog.teams.flatMap((team) =>
          (team.skills ?? []).map((path) => /^teams\/[^/]+\/skills\/(.+)\/SKILL\.md$/.exec(path)?.[1] ?? path),
        ),
      ),
    ].sort();
  }

  it("advertises no skill that cannot install", () => {
    const advertised = advertisedSkillIds();
    expect(advertised.length).toBeGreaterThan(0);
    const broken = advertised.flatMap((id) => {
      const checked = checkLibrarySkill(id, SKILL_LIBRARY_ROOT);
      return "error" in checked ? [`  ${id} -> ${checked.error}`] : [];
    });
    expect(
      broken.join("\n"),
      `library/catalog.json advertises ${broken.length} of ${advertised.length} skills that installSkillFromLibrary ` +
        "would refuse. A user picking that team gets a card promising a skill the installer rejects.",
    ).toBe("");
  });

  it("builds its installable set with the installer's own rules", async () => {
    // Builder and installer must agree on the SAME library, or the catalog is
    // derived from a different notion of installable than the one that runs.
    const { installableSkillIds } = await loadBuilder();
    const builder = [...installableSkillIds(SKILL_LIBRARY_ROOT)].sort();
    const installer = skillIds(SKILL_LIBRARY_ROOT).filter(
      (id) => !("error" in checkLibrarySkill(id, SKILL_LIBRARY_ROOT)),
    );
    expect(builder).toEqual(installer);
  });

  it("drops a skill the installer would refuse", async () => {
    // The rule the old existence-only filter could not see: both files present,
    // install still refused. The builder must not offer it.
    const { installableSkillIds } = await loadBuilder();
    const root = libraryCopy(["ab-test-design", "academic-argument"]);
    const skillMd = join(root, "ab-test-design", "SKILL.md");
    writeFileSync(skillMd, readFileSync(skillMd, "utf8").replace("name: ab-test-design", "name: something-else"));
    expect([...installableSkillIds(root)]).toEqual(["academic-argument"]);
  });
});
