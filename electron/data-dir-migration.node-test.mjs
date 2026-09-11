import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { acquireDataDirLease } from "./data-dir-lease.mjs";
import { migrateLegacyDataDirectory } from "./data-dir-migration.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "murage-migration-proof-"));
  t.after(() => safeWipeSync(root));
  const legacyDataDir = join(root, "legacy");
  const dataDir = join(root, "current");
  mkdirSync(legacyDataDir);
  writeFileSync(join(legacyDataDir, "config.json"), "private-preserved-sentinel");
  return { root, dataDir, legacyDataDir, enabled: true };
}

test("moves legacy bytes under a held target lease and leaves that lease effective", t => {
  const f = fixture(t);
  const owner = acquireDataDirLease(f.dataDir);
  try {
    assert.equal(migrateLegacyDataDirectory(f), true);
    assert.equal(existsSync(f.legacyDataDir), false);
    assert.equal(readFileSync(join(f.dataDir, "config.json"), "utf8"), "private-preserved-sentinel");
    assert.throws(() => acquireDataDirLease(f.dataDir));
  } finally { owner.release(); }
});

test("failed rename preserves source and does not seed an empty replacement", t => {
  const f = fixture(t);
  // The filesystem itself refuses this rename: the destination parent does
  // not exist. No mock can accidentally turn this into a successful move.
  f.dataDir = join(f.root, "missing-parent", "current");
  assert.throws(() => migrateLegacyDataDirectory(f), error => {
    assert.equal(error.code, "PERSISTED_STATE_RECOVERY_REQUIRED");
    assert.equal(error.reason, "migration-failed");
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error), /private-preserved-sentinel/);
    return true;
  });
  assert.equal(existsSync(f.dataDir), false);
  assert.equal(readFileSync(join(f.legacyDataDir, "config.json"), "utf8"), "private-preserved-sentinel");
  const source = acquireDataDirLease(f.legacyDataDir);
  source.release();
});

test("refuses an owned legacy source without changing either installation", t => {
  const f = fixture(t);
  const source = acquireDataDirLease(f.legacyDataDir);
  try {
    assert.throws(() => migrateLegacyDataDirectory(f), { code: "PERSISTED_STATE_RECOVERY_REQUIRED" });
    assert.equal(existsSync(f.dataDir), false);
    assert.equal(readFileSync(join(f.legacyDataDir, "config.json"), "utf8"), "private-preserved-sentinel");
  } finally { source.release(); }
});

test("explicit overrides and existing destinations leave legacy data alone", t => {
  const f = fixture(t);
  assert.equal(migrateLegacyDataDirectory({ ...f, enabled: false }), false);
  assert.equal(existsSync(f.dataDir), false);
  mkdirSync(f.dataDir);
  writeFileSync(join(f.dataDir, "config.json"), "current-sentinel");
  assert.equal(migrateLegacyDataDirectory(f), false);
  assert.equal(readFileSync(join(f.dataDir, "config.json"), "utf8"), "current-sentinel");
  assert.equal(readFileSync(join(f.legacyDataDir, "config.json"), "utf8"), "private-preserved-sentinel");
});
