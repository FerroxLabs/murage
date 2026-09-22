// CAN THIS MACHINE PACKAGE A DEV BUILD WITHOUT CI?
//
// `native/gepa/build-mac.py` refuses to run outside a GitHub Actions runner
// with a Ferrox Developer ID in a disposable task keychain, and that is
// correct: it is the SIGNING path and it should be impossible to reproduce on
// a laptop. But packaging does not run that script. `package:mac` is
// `package:prepare && … && electron-builder --mac`, and all electron-builder
// needs is a bundle under `dist-native/gepa/<target>` whose manifest hashes to
// the receipt passed in through `extraMetadata.murageGepaManifests`.
//
// That receipt is a BUILD-TIME INPUT, not a CI secret. So a bundle already
// built from the same pinned inputs verifies anywhere, and a local unsigned
// dev build is possible after all. This asserts that before a forty minute
// build finds out, and it is deliberately the real `verifyGepaBundle` that
// `scripts/after-pack.mjs` calls — a check against a different function would
// prove nothing about whether the package will pass.
//
// It is a vitest test rather than a script because ad-hoc node against this
// repo resolves DATA_DIR to the live workspace, and that has already cost one
// deleted one.
//
// AND IT LIVES UNDER server/ BECAUSE scripts/ ONLY COLLECTS `.mjs`
// (vite.config.ts `include`). Written as `scripts/*.test.ts` it was never
// collected at all, and vitest reported "PASS (0) FAIL (0)" — a green run over
// nothing, which is the same failure this repo keeps finding in its own
// checks.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verifyGepaBundle } from "./gepa-resource.ts";

const BUNDLE = fileURLToPath(new URL("../dist-native/gepa/darwin-arm64", import.meta.url));
const MANIFEST = `${BUNDLE}/manifest.json`;

describe.skipIf(!existsSync(MANIFEST))("the staged GEPA bundle", () => {
  it("passes the same verification the packager runs", () => {
    const receipt = createHash("sha256").update(readFileSync(MANIFEST)).digest("hex");
    const result = verifyGepaBundle(BUNDLE, "darwin-arm64", receipt);

    expect(result.manifest.target).toBe("darwin-arm64");
    expect(result.expectedPythonVersion).toBe("3.13.15");
    expect(result.manifest.gepa).toBe("0.1.4");
    expect(result.manifest.pyinstaller).toBe("6.22.3");
    // The receipt to hand electron-builder, printed so the packaging command
    // does not have to guess it.
    console.info(`GEPA RECEIPT darwin-arm64: ${receipt}`);
  });

  it("rejects a receipt that is not this bundle's", () => {
    // Without this the test above passes for any bundle at all, including one
    // whose contents were swapped after the manifest was written.
    expect(() => verifyGepaBundle(BUNDLE, "darwin-arm64", "b".repeat(64)))
      .toThrow(/GEPA_RESOURCE_MANIFEST_MISMATCH/);
  });

  it("rejects the bundle under the wrong target", () => {
    const receipt = createHash("sha256").update(readFileSync(MANIFEST)).digest("hex");
    expect(() => verifyGepaBundle(BUNDLE, "win32-x64", receipt))
      .toThrow(/GEPA_RESOURCE_(TARGET|MANIFEST)_MISMATCH/);
  });
});
