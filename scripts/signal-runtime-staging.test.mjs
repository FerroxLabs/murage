import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageRuntimeLicenses } from "../server/channels/signal/runtime-licenses.mjs";
import { expect, it } from "vitest";
import { assertReleasePin, json, PIN_PATH, runInventoryCommand } from "./signal-inventory.mjs";

// Acceptance probes intentionally remain red until their reviewed evidence lands.
// Never substitute synthetic live evidence into the committed pin.
it("T-PIN-RELEASABLE: committed pin is release ready", () => {
  expect(() => assertReleasePin(json(PIN_PATH))).not.toThrow();
});
it("T-RUNTIME-INPUTS: committed build and source proof is complete", async () => {
  await expect(runInventoryCommand(["--assert-runtime-inputs"])).resolves.toMatch(/verified/);
});
it("T-LICENSE-COVERAGE: all 51 normalized jars have a POM/source licence record", () => {
  const pin = json(PIN_PATH), manifest = json(new URL("../licenses/signal-runtime/manifest.json", import.meta.url));
  expect(manifest.jars).toHaveLength(51);
  for (const target of Object.values(pin.targets)) {
    const root = mkdtempSync(join(tmpdir(), "signal-license-coverage-"));
    try {
      stageRuntimeLicenses(new URL("../licenses/signal-runtime/", import.meta.url), root, target.jars);
      const staged = JSON.parse(readFileSync(join(root, "manifest.json")));
      expect(staged.jars.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)))
        .toEqual(target.jars.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)));
      expect(staged.documents).toEqual(manifest.documents);
    } finally { removeTempDirSync(root); }
  }
  for (const jar of manifest.jars) {
    expect(jar.licenses.length).toBeGreaterThan(0);
    for (const doc of jar.pomChain) expect(manifest.documents).toContainEqual(expect.objectContaining(doc));
  }
});
