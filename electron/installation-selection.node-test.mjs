import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dataDirLeasePaths } from "./data-dir-lease.mjs";
import { allocateSeparateInstallation, planSeparateInstallation, publishInstallationSelection, resolveInstallationSelection } from "./installation-selection.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
const roots = [];
test.afterEach(() => { for (const root of roots.splice(0)) safeWipeSync(root); });
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "murage-selection-test-"))); roots.push(root);
  const userData = path.join(root, "desktop"), original = path.join(root, "original"); mkdirSync(userData); mkdirSync(original);
  return { root, userData, original, plan: planSeparateInstallation(userData, original, original) };
}
function restored(plan) {
  const allocated = allocateSeparateInstallation(plan); mkdirSync(allocated.dataDirectory);
  const snapshotId = randomUUID(), transactionId = randomUUID(), archiveSha256 = "a".repeat(64);
  writeFileSync(path.join(allocated.dataDirectory, "restore-review.json"), JSON.stringify({ version: 1, status: "review-required", snapshotId, transactionId, archiveSha256 }));
  writeFileSync(path.join(allocated.dataDirectory, "restored-connections.json"), JSON.stringify({ version: 1, id: randomUUID() }));
  const receipt = path.join(allocated.container, `.data.restore-${transactionId}.receipt.json`);
  writeFileSync(receipt, JSON.stringify({ version: 1, id: transactionId, hadOriginal: false, phase: "candidate-installed", snapshotId, archiveSha256 }));
  return { allocated, result: { ok: true, operation: "restore", status: "restored-review-required", activationAvailable: false, previousDataDir: null, snapshotId, sha256: archiveSha256, receipt } };
}
test("planning is read-only and allocation never adopts an existing container", () => {
  const f = fixture(); assert.equal(existsSync(f.plan.storage), false);
  allocateSeparateInstallation(f.plan);
  assert.equal(existsSync(f.plan.dataDirectory), false);
  assert.throws(() => allocateSeparateInstallation(f.plan), { code: "EEXIST" });
});
test("published selection resolves only the matching requested installation", () => {
  const f = fixture(), r = restored(f.plan); publishInstallationSelection(r.allocated, r.result);
  assert.equal(resolveInstallationSelection(f.userData, f.original).dataDirectory, f.plan.dataDirectory);
  const other = path.join(f.root, "explicit-other");
  assert.deepEqual(resolveInstallationSelection(f.userData, other), { dataDirectory: dataDirLeasePaths(other).canonicalDataDir, selected: false });
});
test("missing, redirected or changed selected metadata fails closed", () => {
  const f = fixture(), r = restored(f.plan); publishInstallationSelection(r.allocated, r.result);
  const retained = path.join(f.root, "retained-data"); renameSync(f.plan.dataDirectory, retained);
  assert.throws(() => resolveInstallationSelection(f.userData, f.original), { code: "INSTALLATION_SELECTION_INVALID" });
  symlinkSync(retained, f.plan.dataDirectory, "dir");
  assert.throws(() => resolveInstallationSelection(f.userData, f.original), { code: "INSTALLATION_SELECTION_INVALID" });
  rmSync(f.plan.dataDirectory); renameSync(retained, f.plan.dataDirectory);
  writeFileSync(path.join(f.plan.container, "selection-record.json"), "{}");
  assert.throws(() => resolveInstallationSelection(f.userData, f.original), { code: "INSTALLATION_SELECTION_INVALID" });
});
test("overlap and managed-storage aliases are rejected before writes", () => {
  const f = fixture();
  assert.throws(() => planSeparateInstallation(f.original, f.original, f.original), { code: "INSTALLATION_SELECTION_INVALID" });
  symlinkSync(f.original, f.plan.storage, "dir");
  assert.throws(() => planSeparateInstallation(f.userData, f.original, f.original), { code: "INSTALLATION_SELECTION_INVALID" });
});
test("publication validates success and hash and retains candidate on selector conflict", () => {
  const f = fixture(), r = restored(f.plan);
  assert.throws(() => publishInstallationSelection(r.allocated, { ...r.result, sha256: "b".repeat(64) }), { code: "INSTALLATION_SELECTION_INVALID" });
  assert.equal(existsSync(f.plan.selector), false);
  writeFileSync(f.plan.selector, "changed-selection");
  assert.throws(() => publishInstallationSelection(r.allocated, r.result), { code: "INSTALLATION_SELECTION_INVALID" });
  assert.equal(readFileSync(f.plan.selector, "utf8"), "changed-selection");
  assert.equal(existsSync(r.result.receipt), true);
  assert.equal(existsSync(f.plan.dataDirectory), true);
});
test("a selected target without its review barrier cannot start as an empty profile", () => {
  const f = fixture(), r = restored(f.plan); publishInstallationSelection(r.allocated, r.result);
  rmSync(path.join(f.plan.dataDirectory, "restore-review.json"));
  assert.throws(() => resolveInstallationSelection(f.userData, f.original), { code: "INSTALLATION_SELECTION_INVALID" });
});
test("strict selector errors reject unknown fields without exposing private bytes", () => {
  const f = fixture(), r = restored(f.plan); publishInstallationSelection(r.allocated, r.result);
  const valid = JSON.parse(readFileSync(f.plan.selector, "utf8"));
  for (const value of [null, { ...valid, arbitraryPath: "PRIVATE_SELECTOR_CANARY" }, { ...valid, version: 2 }, { ...valid, id: "../outside" }]) {
    writeFileSync(f.plan.selector, JSON.stringify(value));
    assert.throws(() => resolveInstallationSelection(f.userData, f.original), error => error.code === "INSTALLATION_SELECTION_INVALID" && !String(error).includes("PRIVATE_SELECTOR_CANARY"));
  }
});
