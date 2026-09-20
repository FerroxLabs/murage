// The release 0.1.57 nearly shipped: a packaged app that died on launch.
//
// electron-builder names each shared/*.mjs individually, so an import added in
// electron/ without a matching line packages an asar missing that file. Nothing
// in the ordinary suites noticed; the macOS and Windows build jobs went green
// through signing and notarisation, and only the Linux packaged smoke caught it.
// This test moves that failure back to where it is cheap.
import { describe, expect, it } from "vitest";

import {
  missingFromPackage,
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
