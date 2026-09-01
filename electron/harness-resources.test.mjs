import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  FUIGO_EXECUTABLE_NAMES,
  HARNESS_RESOURCE_DIRECTORIES,
  bundledFuigoPath,
  harnessResourceEnvironment,
} from "./harness-resources.mjs";

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
      MURAGE_FUIGO_DIR: `${resources}/fuigo`,
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
  // Per-platform blocks count too: a single-platform executable (cloudflared,
  // fuigo) can only be declared there, and "packaged nowhere" is the failure
  // this whole file exists to catch.
  const packagedDestinations = [
    ...(builderConfig.extraResources ?? []),
    ...["mac", "win", "linux"].flatMap((section) => builderConfig[section]?.extraResources ?? []),
  ].map((entry) => String(entry.to));

  for (const [variable, directory] of Object.entries(HARNESS_RESOURCE_DIRECTORIES)) {
    it(`ships ${directory} for ${variable}`, () => {
      const packaged = packagedDestinations.filter(
        (destination) => destination === directory || destination.startsWith(`${directory}/`),
      );
      expect(packaged.length).toBeGreaterThan(0);
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

describe("bundled fuigo engine contract", () => {
  // The engine is a single executable INSIDE MURAGE_FUIGO_DIR, so two names
  // can drift, not one: the directory (covered above) and the file. Both sides
  // of the file name are pinned here — electron-builder's `to:` basename and
  // the literal server/env-path.ts joins onto MURAGE_FUIGO_DIR.
  const directory = HARNESS_RESOURCE_DIRECTORIES.MURAGE_FUIGO_DIR;
  const sections = { mac: "darwin", win: "win32", linux: "linux" };

  for (const [section, platform] of Object.entries(sections)) {
    it(`packages exactly one ${platform} fuigo executable, named the way the server reads it`, () => {
      const entries = (builderConfig[section]?.extraResources ?? []).filter((row) => {
        const to = String(row.to);
        return to === directory || to.startsWith(`${directory}/`);
      });
      expect(entries.map((row) => String(row.to))).toEqual([
        `${directory}/${FUIGO_EXECUTABLE_NAMES[platform]}`,
      ]);
      // Staged per BUILD TARGET, never picked from the build host.
      expect(String(entries[0].from)).toMatch(
        new RegExp(`^dist-native/fuigo/${platform}-[^/]+/${FUIGO_EXECUTABLE_NAMES[platform]}$`),
      );
    });
  }

  it("selects the mac executable by built arch rather than one fixed arch", () => {
    const entry = (builderConfig.mac?.extraResources ?? []).find(
      (row) => String(row.to) === `${directory}/${FUIGO_EXECUTABLE_NAMES.darwin}`,
    );
    expect(String(entry.from)).toContain("${arch}");
  });

  it("keeps server/env-path.ts reading the same env variable and executable names", () => {
    const source = readFileSync(join(repoRoot, "server", "env-path.ts"), "utf8");
    expect(source).toContain("MURAGE_FUIGO_DIR");
    for (const name of new Set(Object.values(FUIGO_EXECUTABLE_NAMES))) {
      expect(source).toContain(`"${name}"`);
    }
  });

  it("resolves the bundled engine inside a packaged Resources directory", () => {
    const resources = "/Applications/Murage.app/Contents/Resources";
    expect(bundledFuigoPath(resources, "darwin")).toBe(`${resources}/fuigo/fuigo`);
    expect(bundledFuigoPath(resources, "win32")).toBe(`${resources}/fuigo/fuigo.exe`);
    expect(() => bundledFuigoPath(resources, "aix")).toThrow(/no bundled fuigo/);
  });

  it("ships named license terms for the engine, the way cloudflared does", () => {
    const licenses = (builderConfig.extraResources ?? []).filter((row) =>
      String(row.to).startsWith("licenses/fuigo-"),
    );
    expect(licenses.map((row) => String(row.to)).sort()).toEqual([
      "licenses/fuigo-LICENSE.txt",
      "licenses/fuigo-README.md",
      "licenses/fuigo-THIRD_PARTY_NOTICES.md",
    ]);
    // Fuigo is Ferrox Labs' own Apache-2.0 work; the same full text ships
    // under its own name so the executable's terms are unambiguous.
    expect(licenses.find((row) => String(row.to) === "licenses/fuigo-LICENSE.txt").from).toBe("LICENSE");
  });
});
