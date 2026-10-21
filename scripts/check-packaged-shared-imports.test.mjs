// The release 0.1.57 nearly shipped: a packaged app that died on launch.
//
// electron-builder names each shared/*.mjs individually, so an import added in
// electron/ without a matching line packages an asar missing that file. Nothing
// in the ordinary suites noticed; the macOS and Windows build jobs went green
// through signing and notarisation, and only the Linux packaged smoke caught it.
// This test moves that failure back to where it is cheap.
import { describe, expect, it } from "vitest";

import {
  builderFilePatterns,
  electronEntries,
  isPackaged,
  missingFromPackage,
  packagedImportGraph,
  relativeSpecifiers,
  serverBundleInlinesRelativeImports,
  unpackagedMainProcessModules,
  sharedModulesImportedByElectron,
  sharedModulesPackaged,
} from "./check-packaged-shared-imports.mjs";

describe("every shared module the packaged app imports is actually packaged", () => {
  it("has no shared/*.mjs import missing from electron-builder.yml", () => {
    expect(missingFromPackage(), "add these to electron-builder.yml's files list, or the app dies on launch").toEqual([]);
  });

  it("really is reading both lists, so an empty result cannot pass by accident", () => {
    // A check that compares nothing to nothing reports success forever. Both
    // sides must be non-empty and must actually overlap.
    const imported = sharedModulesImportedByElectron();
    const packaged = sharedModulesPackaged();
    expect(imported.length).toBeGreaterThan(0);
    expect(packaged.length).toBeGreaterThan(0);
    expect(imported).toContain("shared/backup-capture-failure.mjs");
    expect(packaged).toContain("shared/backup-capture-failure.mjs");
  });

  it("would have caught the 0.1.57 break", () => {
    // Same comparison, with the real import list against a config that has
    // every line except the one that was forgotten.
    const packaged = new Set(sharedModulesPackaged().filter((name) => name !== "shared/backup-capture-failure.mjs"));
    const missing = sharedModulesImportedByElectron().filter((name) => !packaged.has(name));
    expect(missing).toEqual(["shared/backup-capture-failure.mjs"]);
  });
});

// Astra nops #1: shared/windows-sddl.mjs, imported by electron/backup-windows-acl.mjs, was not packaged. The check now walks the
// whole static import graph of the main process and holds every module it reaches against electron-builder.yml's files: list.
describe("every module the main process's import graph reaches is packaged", () => {
  it("nothing reachable from electron/main.mjs (or any shipped electron/ file) is left out of the package", () => {
    const { unpackaged, missing } = unpackagedMainProcessModules();
    expect(unpackaged, "add these to electron-builder.yml's files list, or the app dies on launch").toEqual([]);
    expect(missing, "imports that resolve to no file").toEqual([]);
  });

  it("really walks the graph: it reaches shared/ and installer/ modules through electron/ files, and the vendored updater", () => {
    const { reached } = unpackagedMainProcessModules();
    for (const file of ["electron/main.mjs", "electron/backup-windows-acl.mjs", "shared/windows-sddl.mjs", "shared/backup-capture-failure.mjs", "electron/vendor/electron-updater.cjs", "electron/windows-update-signature.mjs"]) expect(reached, file).toContain(file);
    expect(reached.some((file) => file.startsWith("installer/lib/"))).toBe(true);
    // reached from main.mjs alone, not only as a root of its own
    expect(packagedImportGraph([electronEntries()[0]]).files).toContain("shared/windows-sddl.mjs");
  });

  it("would have caught the windows-sddl.mjs break", () => {
    const patterns = builderFilePatterns();
    const without = { include: patterns.include.filter((pattern) => !pattern.test("shared/windows-sddl.mjs")), exclude: patterns.exclude };
    const reached = unpackagedMainProcessModules().reached;
    expect(reached.filter((file) => !isPackaged(file, without))).toEqual(["shared/windows-sddl.mjs"]);
  });

  it("reads electron-builder's include and exclude patterns as electron-builder does", () => {
    const patterns = builderFilePatterns();
    expect(isPackaged("electron/main.mjs", patterns)).toBe(true);
    expect(isPackaged("electron/vendor/electron-updater.cjs", patterns)).toBe(true);
    expect(isPackaged("electron/x.test.mjs", patterns)).toBe(false);
    expect(isPackaged("shared/not-listed.mjs", patterns)).toBe(false);
    expect(isPackaged("server/index.ts", patterns)).toBe(false);
  });

  it("finds static, re-export, side-effect, dynamic and require specifiers, and skips comments", () => {
    expect(relativeSpecifiers(`import a from "./a.mjs";\nimport {\n  b,\n  c,\n} from "../shared/b.mjs";\nimport "./c.mjs";\nexport * from "./d.mjs";\nexport { e } from "./e.mjs";\nconst f = await import("./f.mjs");\nconst g = require("./g.cjs");\n// import h from "./h.mjs";\n/* require("./i.cjs") */\nimport fs from "node:fs";`).sort())
      .toEqual(["../shared/b.mjs", "./a.mjs", "./c.mjs", "./d.mjs", "./e.mjs", "./f.mjs", "./g.cjs"]);
  });

  it("server code's shared imports are inside the server bundle: every build bundles, and no relative module is external", () => {
    const { externals, relativeExternals, bundled } = serverBundleInlinesRelativeImports();
    expect(externals.length).toBeGreaterThan(0);
    expect(relativeExternals).toEqual([]);
    expect(bundled.length).toBeGreaterThan(0);
    expect(bundled.every((value) => value === "true")).toBe(true);
  });
});
