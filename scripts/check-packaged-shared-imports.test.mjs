// The release 0.1.57 nearly shipped: a packaged app that died on launch.
//
// electron-builder names each shared/*.mjs individually, so an import added in
// electron/ without a matching line packages an asar missing that file. Nothing
// in the ordinary suites noticed; the macOS and Windows build jobs went green
// through signing and notarisation, and only the Linux packaged smoke caught it.
// This test moves that failure back to where it is cheap.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { parse } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

// Give each historical omission a complete config of its own. A separate
// assertion above checks the live config, so unrelated omissions stay visible.
function withConfig(files, run) {
  const directory = mkdtempSync(join(tmpdir(), "packaged-imports-"));
  const config = join(directory, "electron-builder.yml");
  try {
    writeFileSync(config, `files:\n${files.map(file => `  - ${file}\n`).join("")}`);
    return run(config);
  } finally { removeTempDirSync(directory); }
}

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
    const imported = sharedModulesImportedByElectron();
    withConfig(imported.filter(name => name !== "shared/backup-capture-failure.mjs"), config => {
      const packaged = new Set(sharedModulesPackaged(config));
      expect(imported.filter(name => !packaged.has(name))).toEqual(["shared/backup-capture-failure.mjs"]);
    });
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

  it("the unbundled label scanner has a JavaScript-only packaged dependency graph", () => {
    const { files, missing } = packagedImportGraph(["shared/md-secret-label.mjs"]);
    expect(missing).toEqual([]);
    expect(files.filter(file => /\.tsx?$/.test(file))).toEqual([]);
    expect(files).toContain("shared/financial-ids.mjs");
    const patterns = builderFilePatterns();
    expect(files.filter(file => !isPackaged(file, patterns))).toEqual([]);
  });

  it("really walks the graph: it reaches shared/ and installer/ modules through electron/ files, and the vendored updater", () => {
    const { reached } = unpackagedMainProcessModules();
    for (const file of ["electron/main.mjs", "electron/backup-windows-acl.mjs", "shared/windows-sddl.mjs", "shared/backup-capture-failure.mjs", "electron/vendor/electron-updater.cjs", "electron/windows-update-signature.mjs"]) expect(reached, file).toContain(file);
    expect(reached.some((file) => file.startsWith("installer/lib/"))).toBe(true);
    // reached from main.mjs alone, not only as a root of its own
    expect(packagedImportGraph([electronEntries()[0]]).files).toContain("shared/windows-sddl.mjs");
  });

  it.each(["shared/windows-sddl.mjs", "shared/backup-space.mjs", "shared/agy-oauth-link.mjs", "shared/stored-root-path.mjs"])("would have caught the %s break", omitted => {
    const reached = packagedImportGraph([electronEntries()[0]]).files;
    expect(reached).toContain(omitted);
    withConfig(reached.filter(file => file !== omitted), config => {
      const patterns = builderFilePatterns(config);
      expect(reached.filter(file => !isPackaged(file, patterns))).toEqual([omitted]);
    });
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

it('electron-builder stages the require preload both inside ASAR and as an external resource', async () => {
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve('electron-builder/package.json'));
  const { getFileMatchers } = builder('app-builder-lib/out/fileMatcher.js');
  const { computeFileSets, getDestinationPath } = builder('app-builder-lib/out/util/appFileCopier.js');
  const config = parse(readFileSync('electron-builder.yml', 'utf8'));
  const root = mkdtempSync(join(tmpdir(), 'packaged-preload-'));
  try {
    for (const directory of ['shared', 'dist-server/shared']) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, 'win-hide-child-process.cjs'), 'module.exports = "fixture preload";');
    }
    const options = { defaultSrc: root, macroExpander: text => text.replaceAll('${arch}', 'x64'), customBuildOptions: {}, globalOutDir: join(root, 'release') };
    const resources = getFileMatchers(config, 'extraResources', join(root, 'Resources'), options);
    const files = getFileMatchers(config, 'files', join(root, 'Resources/app'), options);
    const excluded = [];
    for (const matcher of resources) matcher.computeParsedPatterns(excluded, root);
    for (const matcher of files) matcher.excludePatterns = excluded;
    const sets = await computeFileSets(files, null, { info: { projectDir: root, appDir: root, config, areNodeModulesHandledExternally: true, metadata: { dependencies: {} }, debugLogger: { add() {} } } }, false);
    const staged = sets.flatMap(set => set.files.map(file => getDestinationPath(file, set)));
    expect(staged).toContain(join(root, 'Resources/app/shared/win-hide-child-process.cjs'));
    const outside = resources.find(matcher => matcher.to === join(root, 'Resources/shared/win-hide-child-process.cjs'));
    expect(readFileSync(outside.from, 'utf8')).toBe('module.exports = "fixture preload";');
  } finally { removeTempDirSync(root); }
});
