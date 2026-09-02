import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  FUIGO_EXECUTABLE_NAMES,
  HARNESS_RESOURCE_DIRECTORIES,
  bundledFuigoPath,
  harnessResourceEnvironment,
  DEV_STATIC_DIRECTORY,
  devHarnessEnvironment,
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
      MURAGE_LIBRARY_DIR: `${resources}/library`,
      MURAGE_BOT_LIBRARY_DIR: `${resources}/bot-library`,
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

  // Same failure, second shape. server/team-library.ts falls back to
  // process.cwd() for both of these, so a packaged build that does not carry
  // them reads as "no local library" and silently goes back to needing GitHub —
  // and every offline install button dies with it. The `to:` name must equal the
  // repo directory or the dev and packaged trees are different trees.
  for (const directory of ["library", "bot-library"]) {
    it(`packages ${directory} from the repo tree the server reads in dev`, () => {
      const entry = (builderConfig.extraResources ?? []).find((row) => String(row.to) === directory);
      expect(entry?.from).toBe(directory);
    });
  }

  it("ships the generated catalog and the documents its every entry installs", () => {
    const catalog = JSON.parse(readFileSync(join(repoRoot, "library", "catalog.json"), "utf8"));
    expect(catalog.teams.length).toBeGreaterThan(100);
    // Each packaged tree's `to:` is the env value, so a document under one of
    // these directories is reachable in a packaged build exactly when it is
    // reachable in dev.
    const packagedRoots = new Set(packagedDestinations);
    for (const entry of catalog.teams) {
      const candidates = [
        join("library", "packages", `${entry.slug}.md`),
        join("library", "packages", `${entry.slug}.json`),
        join("library", "assistants", `${entry.slug}.json`),
        join("bot-library", "builtins", `${entry.slug}.json`),
      ].filter((relative) => existsSync(join(repoRoot, relative)));
      expect(candidates, `${entry.slug} has no committed package document`).not.toHaveLength(0);
      expect(packagedRoots.has(candidates[0].split("/")[0])).toBe(true);
    }
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

// ── the static tree in development ───────────────────────────────────────
//
// A packaged build points MURAGE_STATIC_DIR at Resources/ui and the harness
// serves the app. In development nothing set it, so STATIC_DIR was null and
// the harness had no UI at all — invisible to the desktop app, which loads
// the Vite dev server directly, and fatal to the browser door, whose whole
// job is to proxy a phone to the harness and let the harness hand back the
// shell. So the door was untestable in dev and had nothing to serve.
describe("the dev static tree", () => {
  it("points the harness at the build vite actually writes", () => {
    // Not a second name for the same directory: `dist` is what `vite build`
    // emits and what the packaged `ui` directory is made from, so a phone in
    // dev gets the same bytes a packaged build would serve it.
    expect(DEV_STATIC_DIRECTORY).toBe("dist");
    expect(devHarnessEnvironment("/repo", () => true)).toEqual({
      MURAGE_STATIC_DIR: join("/repo", "dist"),
    });
  });

  it("says nothing at all when there is no build", () => {
    // An unset variable is exactly the state an unbuilt checkout is in, and
    // the harness already reads it as "no static tree". A path to a directory
    // that is not there would instead be a 404 per asset with no explanation.
    expect(devHarnessEnvironment("/repo", () => false)).toEqual({});
  });

  it("waits for index.html rather than for the directory", () => {
    // `vite build` creates dist/ before it finishes filling it. A phone served
    // a half-written build gets a blank page and no error worth reading.
    const seen = [];
    devHarnessEnvironment("/repo", (candidate) => {
      seen.push(candidate);
      return false;
    });
    expect(seen).toEqual([join("/repo", "dist", "index.html")]);
  });

  it("refuses a missing root rather than resolving against cwd", () => {
    // path.join("", "dist") is "dist", a relative path whose meaning depends
    // on whoever forked the child. That is the class of bug this whole module
    // exists for.
    expect(() => devHarnessEnvironment(undefined)).toThrow(/repository root/);
    expect(() => devHarnessEnvironment("")).toThrow(/repository root/);
  });

  it("agrees with the packaged mapping about which variable it is", () => {
    // Two names for one decision is how the packaged build and the dev build
    // end up serving different trees.
    expect(Object.keys(devHarnessEnvironment(repoRoot, () => true))).toEqual(["MURAGE_STATIC_DIR"]);
    expect(HARNESS_RESOURCE_DIRECTORIES.MURAGE_STATIC_DIR).toBe("ui");
  });
});
