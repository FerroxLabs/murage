import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifiedArtifactNativePath } from "./artifact-action.mjs";

test("native artifact action accepts only matching private saved bytes", () => {
  const scratch = mkdtempSync(join(tmpdir(), "murage-native-artifact-"));
  try {
    const root = realpathSync(scratch), saved = join(root, "artifact-files"); mkdirSync(saved);
    const bytes = "<h1>Report</h1>", sha256 = createHash("sha256").update(bytes).digest("hex"), path = join(saved, sha256 + ".html");
    writeFileSync(path, bytes);
    assert.equal(verifiedArtifactNativePath({ path, sha256 }, root), path);
    assert.throws(() => verifiedArtifactNativePath({ path: join(root, "outside.html"), sha256 }, root));
    writeFileSync(path, "changed");
    assert.throws(() => verifiedArtifactNativePath({ path, sha256 }, root));
    assert.throws(() => verifiedArtifactNativePath({ path, sha256: "invalid" }, root));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
test("native artifact action rejects symlinks", { skip: process.platform === "win32" }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "murage-native-artifact-link-"));
  try {
    const root = realpathSync(scratch); mkdirSync(join(root, "artifact-files"));
    const source = join(root, "outside.txt"); writeFileSync(source, "private");
    const path = join(root, "artifact-files", "link.txt"); symlinkSync(source, path);
    assert.throws(() => verifiedArtifactNativePath({ path, sha256: createHash("sha256").update("private").digest("hex") }, root));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
