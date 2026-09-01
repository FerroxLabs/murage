import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { HARNESS_RESOURCE_DIRECTORIES, harnessResourceEnvironment } from "./harness-resources.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const builderConfig = parse(readFileSync(join(repoRoot, "electron-builder.yml"), "utf8"));

describe("harnessResourceEnvironment", () => {
  it("resolves every shipped tree inside a packaged Resources directory", () => {
    const resources = "/Applications/Murage.app/Contents/Resources";
    expect(harnessResourceEnvironment(resources)).toEqual({
      MURAGE_RESOURCES_PATH: resources,
      MURAGE_STATIC_DIR: `${resources}/ui`,
      MURAGE_SKILLS_DIR: `${resources}/skills`,
      MURAGE_SKILL_LIBRARY: `${resources}/skills-library`,
    });
  });

  it("refuses a missing resources path rather than emitting a bare relative one", () => {
    expect(() => harnessResourceEnvironment(undefined)).toThrow(/resources path/);
    expect(() => harnessResourceEnvironment("")).toThrow(/resources path/);
  });
});

describe("packaged resource contract", () => {
  // The whole 2,205-skill library shipped nowhere through 0.1.44 because these
  // two lists were never compared: server/skills.ts read MURAGE_SKILL_LIBRARY
  // and electron-builder.yml packaged no skills-library. Comparing them is the
  // point of this file.
  const packagedDirectories = new Set(
    (builderConfig.extraResources ?? []).map((entry) => entry.to),
  );

  for (const [variable, directory] of Object.entries(HARNESS_RESOURCE_DIRECTORIES)) {
    it(`ships ${directory} for ${variable}`, () => {
      expect(packagedDirectories).toContain(directory);
    });
  }

  it("packages the skill library from the repo tree the server reads in dev", () => {
    const entry = (builderConfig.extraResources ?? []).find((row) => row.to === "skills-library");
    expect(entry?.from).toBe("skills-library");
  });

  it("keeps main.mjs handing the resource env to the forked server child", () => {
    const main = readFileSync(join(repoRoot, "electron", "main.mjs"), "utf8");
    expect(main).toContain("...harnessResourceEnvironment(process.resourcesPath)");
  });
});
