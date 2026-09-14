import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

test("Windows backup bundles load without source protocol or node_modules and refuse unsupported hosts", async t => {
  const root = mkdtempSync(join(tmpdir(), "murage-windows-bundle-test-"));
  t.after(() => safeWipeSync(root));
  for (const name of ["windows-backup-resources", "installation-windows-backup-transport"]) {
    copyFileSync(new URL(`../dist-server/${name}.js`, import.meta.url), join(root, `${name}.mjs`));
  }
  const resources = await import(pathToFileURL(join(root, "windows-backup-resources.mjs")).href);
  const client = await import(pathToFileURL(join(root, "installation-windows-backup-transport.mjs")).href);
  assert.equal(typeof client.runWindowsBackupTransport, "function");
  const resolver = resources.createWindowsBackupResourceResolver({ resourcesPath: "C:\\fixture\\resources" }, {
    platform: "linux", arch: "x64", verifySignatures: () => assert.fail("must not invoke native verifier"),
  });
  await assert.rejects(resolver(), error => error.code === "AGE_TOOL_PLATFORM_UNQUALIFIED");
});
