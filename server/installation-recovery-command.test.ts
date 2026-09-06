import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { assertRestoreReviewed } from "../electron/restore-review.mjs";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../scripts/installation-recovery.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-backup-cli-"));
  roots.push(root);
  const data = join(root, "installation with spaces");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), '{"profile":{"name":"Fixture"},"flux":{"apiKey":"never-print-this-canary"}}');
  return { root, data, target: join(root, "backup with spaces.zip") };
}
const run = (args: string[], env?: Record<string, string>) => exec(process.execPath, [cli, ...args], { timeout: 20_000, ...(env ? { env: { ...process.env, ...env } } : {}) });

it("backs up and inspects an explicit offline installation through the real CLI", async () => {
  const f = fixture();
  const original = readFileSync(join(f.data, "config.json"));
  const saved = await run(["backup", "--data-dir", f.data, "--output", f.target]);
  const inspected = await run(["inspect", "--archive", f.target]);
  const planned = await run(["plan-restore", "--archive", f.target]);
  expect(saved.stdout + saved.stderr + inspected.stdout + inspected.stderr).not.toContain("never-print-this-canary");
  expect(JSON.parse(saved.stdout)).toMatchObject({ ok: true, operation: "backup", restorePolicy: "paused-review-required" });
  expect(JSON.parse(inspected.stdout)).toMatchObject({ ok: true, operation: "inspect", sha256: JSON.parse(saved.stdout).sha256, activationAvailable: false });
  expect(JSON.parse(planned.stdout)).toMatchObject({ ok: true, operation: "plan-restore", sha256: JSON.parse(saved.stdout).sha256, activationAvailable: false });
  expect(planned.stdout + planned.stderr).not.toContain("never-print-this-canary");
  expect(readFileSync(join(f.data, "config.json"))).toEqual(original);
});

it("exports damaged bytes privately without claiming a restorable backup", async () => {
  const f = fixture();
  const damaged = '{"secret":"damaged-private-canary",';
  writeFileSync(join(f.data, "config.json"), damaged);
  const result = await run(["export-damaged", "--data-dir", f.data, "--output", f.target]);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operation: "export-damaged", complete: false,
    activationAvailable: false, restorePolicy: "preservation-only-no-restore", warning: expect.stringContaining("Do not share") });
  expect(result.stdout + result.stderr).not.toContain("damaged-private-canary");
  expect(readFileSync(join(f.data, "config.json"), "utf8")).toBe(damaged);
  await expect(run(["inspect", "--archive", f.target])).rejects.toMatchObject({ code: 1 });
});

it("fails clearly for active ownership, duplicate options or a restore without target and inspected hash", async () => {
  const f = fixture();
  const owner = acquireDataDirLease(f.data);
  try {
    await expect(run(["backup", "--data-dir", f.data, "--output", f.target])).rejects.toMatchObject({ code: 1 });
  } finally { owner.release(); }
  await expect(run(["inspect", "--archive", f.target, "--archive", f.target])).rejects.toMatchObject({ code: 1 });
  await expect(run(["restore", "--archive", f.target])).rejects.toMatchObject({ code: 1 });
});

it("restores the hash-bound archive inactive and rolls back byte-for-byte through real CLI processes", async () => {
  const f = fixture(), original = readFileSync(join(f.data, "config.json"));
  const saved = JSON.parse((await run(["backup", "--data-dir", f.data, "--output", f.target])).stdout);
  const restored = await run(["restore", "--data-dir", f.data, "--archive", f.target, "--sha256", saved.sha256]);
  expect(JSON.parse(restored.stdout)).toMatchObject({ ok: true, operation: "restore", status: "restored-review-required", activationAvailable: false });
  expect(restored.stdout + restored.stderr).not.toContain("never-print-this-canary");
  expect(readFileSync(join(f.data, "config.json"), "utf8")).not.toContain("never-print-this-canary");
  expect(() => assertRestoreReviewed(f.data)).toThrow();
  const rolledBack = await run(["rollback", "--data-dir", f.data]);
  expect(JSON.parse(rolledBack.stdout)).toMatchObject({ ok: true, operation: "rollback", status: "rolled-back" });
  expect(readFileSync(join(f.data, "config.json"))).toEqual(original);
  expect(() => assertRestoreReviewed(f.data)).not.toThrow();
});

it("names the damaged component without exposing receipt contents", async () => {
  const f = fixture();
  writeFileSync(join(f.data, "delegation-receipts.json"), '[{"private":"receipt-secret-canary"}]');
  let failure: any;
  try { await run(["backup", "--data-dir", f.data, "--output", f.target]); } catch (error) { failure = error; }
  expect(failure?.code).toBe(1);
  expect(JSON.parse(failure.stderr)).toMatchObject({ ok: false, error: "INVALID_INSTALLATION_RECORDS", component: "delegation-receipts.json" });
  expect(failure.stderr).not.toContain("receipt-secret-canary");
});

it("a delegated recovery child can backup, restore and roll back while the primary owner remains held", async () => {
  const f = fixture(), original = readFileSync(join(f.data, "config.json"));
  const owner = acquireDataDirLease(f.data);
  try {
    const saved = JSON.parse((await run(["backup", "--data-dir", f.data, "--output", f.target], owner.utilityServerLeaseEnvironment())).stdout);
    expect(() => acquireDataDirLease(f.data)).toThrow();
    const restored = JSON.parse((await run(["restore", "--data-dir", f.data, "--archive", f.target, "--sha256", saved.sha256], owner.utilityServerLeaseEnvironment())).stdout);
    expect(restored.activationAvailable).toBe(false);
    expect(() => acquireDataDirLease(f.data)).toThrow();
    await run(["rollback", "--data-dir", f.data], owner.utilityServerLeaseEnvironment());
    expect(readFileSync(join(f.data, "config.json"))).toEqual(original);
    expect(() => acquireDataDirLease(f.data)).toThrow();
  } finally { owner.release(); }
});
