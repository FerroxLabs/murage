// Exercise the actual bundled offline CLI with no node_modules in reach.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "murage-packaged-recovery-"));
try {
  const entry = join(scratch, "installation-recovery.mjs");
  copyFileSync(join(process.env.MURAGE_SMOKE_DIST ?? join(root, "dist-server"), "installation-recovery.js"), entry);
  const workerEntry = join(scratch, "installation-recovery-worker.mjs");
  copyFileSync(join(process.env.MURAGE_SMOKE_DIST ?? join(root, "dist-server"), "installation-recovery-worker.js"), workerEntry);
  const data = join(scratch, "fixture installation");
  mkdirSync(data);
  const original = '{"profile":{"name":"Package fixture"},"flux":{"apiKey":"package-credential-canary"}}';
  writeFileSync(join(data, "config.json"), original);
  writeFileSync(join(data, "bots.json"), '[{"id":"fixture","threadId":"fixture-thread","name":"Fixture bot"}]');
  const archive = join(scratch, "fixture backup.zip");
  const run = async (args, executable = entry) => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [executable, ...args], {
      cwd: scratch,
      env: { PATH: dirname(process.execPath), HOME: scratch, USERPROFILE: scratch, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      timeout: 20_000,
    });
    assert.equal((stdout + stderr).includes("package-credential-canary"), false);
    return JSON.parse(stdout);
  };
  const saved = await run(["backup", "--data-dir", data, "--output", archive]);
  const inspected = await run(["inspect", "--archive", archive]);
  const planned = await run(["plan-restore", "--archive", archive]);
  const workerPlan = await run(["plan-restore", "--archive", archive], workerEntry);
  assert.equal(workerPlan.ok, true);
  assert.equal(workerPlan.sha256, planned.sha256);
  assert.equal(workerPlan.activationAvailable, false);
  assert.equal(typeof workerPlan.omittedCount, "number");
  assert.equal(workerPlan.omitted, undefined);
  assert.equal(saved.ok, true);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.sha256, saved.sha256);
  assert.equal(inspected.restorePolicy, "paused-review-required");
  assert.equal(inspected.activationAvailable, false);
  assert.equal(planned.activationAvailable, false);
  assert.equal(planned.sha256, saved.sha256);
  assert.equal(readFileSync(join(data, "config.json"), "utf8"), original);
  const restored = await run(["restore", "--data-dir", data, "--archive", archive, "--sha256", planned.sha256]);
  assert.equal(restored.status, "restored-review-required");
  assert.equal(restored.activationAvailable, false);
  assert.equal(readFileSync(join(restored.previousDataDir, "config.json"), "utf8"), original);
  assert.equal(readFileSync(join(data, "config.json"), "utf8").includes("package-credential-canary"), false);
  assert.equal(JSON.parse(readFileSync(join(data, "restore-review.json"), "utf8")).status, "review-required");
  const rolledBack = await run(["rollback", "--data-dir", data]);
  assert.equal(rolledBack.status, "rolled-back");
  assert.equal(readFileSync(join(data, "config.json"), "utf8"), original);
  console.log("packaged offline backup, inspect, plan, inactive restore and rollback passed with no node_modules in reach ✓");
} finally { rmSync(scratch, { recursive: true, force: true }); }
