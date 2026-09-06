import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { writeInstallationArchive } from "./installation-archive.ts";
import { restoreInstallation, rollbackInstallationRestore } from "./installation-restore.ts";
import { acquireDataDirLease, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { assertRestoreReviewed } from "../electron/restore-review.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-restore-transaction-")); roots.push(root);
  const source = join(root, "source"), target = join(root, "target"), archive = join(root, "backup.zip");
  mkdirSync(source); mkdirSync(target);
  writeFileSync(join(source, "bots.json"), "[]");
  writeFileSync(join(source, "groups.json"), "[]");
  writeFileSync(join(target, "original.txt"), "original installation bytes");
  const backup = await writeInstallationArchive(source, archive);
  return { root, source, target, archive, sha: backup.sha256 };
}
function crash(f: Awaited<ReturnType<typeof fixture>>, operation: "restore" | "rollback", phase: string) {
  const module = new URL("./installation-restore.ts", import.meta.url).href;
  const source = `import { restoreInstallation, rollbackInstallationRestore } from ${JSON.stringify(module)};
    const checkpoint = phase => { if (phase === ${JSON.stringify(phase)}) process.exit(42); };
    ${operation === "restore" ? `await restoreInstallation(${JSON.stringify(f.target)}, ${JSON.stringify(f.archive)}, ${JSON.stringify(f.sha)}, { checkpoint });` : `rollbackInstallationRestore(${JSON.stringify(f.target)}, { checkpoint });`}`;
  let failure: any;
  try { execFileSync(process.execPath, ["--input-type=module", "-e", source], { timeout: 20_000, stdio: "pipe", env: { PATH: dirname(process.execPath), HOME: f.root, USERPROFILE: f.root, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } }); }
  catch (error) { failure = error; }
  expect(failure?.status, String(failure?.stderr)).toBe(42);
}
function originalIntact(f: Awaited<ReturnType<typeof fixture>>) {
  expect(readFileSync(join(f.target, "original.txt"), "utf8")).toBe("original installation bytes");
  expect(() => assertRestoreReviewed(f.target)).not.toThrow();
}

it("binds restore to the inspected hash and leaves original bytes intact on mismatch", async () => {
  const f = await fixture();
  await expect(restoreInstallation(f.target, f.archive, "0".repeat(64))).rejects.toMatchObject({ code: "ARCHIVE_HASH_CHANGED" });
  originalIntact(f);
});

it("refuses a live installation owner before replacing its state", async () => {
  const f = await fixture(), lease = acquireDataDirLease(f.target);
  try { await expect(restoreInstallation(f.target, f.archive, f.sha)).rejects.toThrow(); originalIntact(f); }
  finally { lease.release(); }
});

it("retains the original and keeps a successful restore inactive, then undoes it without deleting either", async () => {
  const f = await fixture();
  const result = await restoreInstallation(f.target, f.archive, f.sha);
  expect(result.activationAvailable).toBe(false);
  expect(readFileSync(join(result.previousDataDir!, "original.txt"), "utf8")).toBe("original installation bytes");
  expect(() => assertRestoreReviewed(f.target)).toThrowError(expect.objectContaining({ code: "RESTORE_REVIEW_REQUIRED" }));
  const rollback = rollbackInstallationRestore(f.target);
  originalIntact(f);
  expect(existsSync(join(rollback.retainedCandidate!, "bots.json"))).toBe(true);
});

it.each(["prepared", "original-renamed", "original-moved", "candidate-renamed", "candidate-installed"])("recovers after actual process exit at restore %s", async phase => {
  const f = await fixture(); crash(f, "restore", phase);
  expect(() => assertRestoreReviewed(f.target)).toThrow();
  const result = rollbackInstallationRestore(f.target);
  originalIntact(f);
  expect(existsSync(join(result.retainedCandidate!, "bots.json"))).toBe(true);
});

it("restores and undoes a previously absent installation while retaining the candidate", async () => {
  const f = await fixture();
  f.target = join(f.root, "fresh");
  const result = await restoreInstallation(f.target, f.archive, f.sha);
  expect(result.previousDataDir).toBeNull();
  const rollback = rollbackInstallationRestore(f.target);
  expect(existsSync(f.target)).toBe(false);
  expect(existsSync(join(rollback.retainedCandidate!, "bots.json"))).toBe(true);
  expect(() => assertRestoreReviewed(f.target)).not.toThrow();
});

it("refuses a substituted original directory and preserves both copies for investigation", async () => {
  const f = await fixture();
  const result = await restoreInstallation(f.target, f.archive, f.sha);
  const saved = join(f.root, "saved-original");
  renameSync(result.previousDataDir!, saved);
  mkdirSync(result.previousDataDir!);
  writeFileSync(join(result.previousDataDir!, "unrelated.txt"), "not the original");
  expect(() => rollbackInstallationRestore(f.target)).toThrowError(expect.objectContaining({ code: "RESTORE_ORIGINAL_IDENTITY_CHANGED" }));
  expect(readFileSync(join(saved, "original.txt"), "utf8")).toBe("original installation bytes");
  expect(readFileSync(join(result.previousDataDir!, "unrelated.txt"), "utf8")).toBe("not the original");
  expect(() => assertRestoreReviewed(f.target)).toThrow();
});

it("rejects home and working-tree roots before inspecting or changing them", async () => {
  const f = await fixture();
  for (const target of [homedir(), process.cwd()]) {
    await expect(restoreInstallation(target, f.archive, f.sha)).rejects.toMatchObject({ code: "BROAD_RESTORE_TARGET_REFUSED" });
  }
});

it("rejects malformed external journals without changing the installation", async () => {
  const f = await fixture();
  const journal = `${dataDirLeasePaths(f.target).leasePath}.restore.json`;
  writeFileSync(journal, JSON.stringify({ version: 1, id: "../../outside" }));
  expect(() => rollbackInstallationRestore(f.target)).toThrowError(expect.objectContaining({ code: "INVALID_RESTORE_JOURNAL" }));
  expect(readFileSync(join(f.target, "original.txt"), "utf8")).toBe("original installation bytes");
  expect(existsSync(journal)).toBe(true);
});

it("the actual harness refuses to initialize an absent root during interrupted rollback", async () => {
  const f = await fixture(); await restoreInstallation(f.target, f.archive, f.sha);
  crash(f, "rollback", "candidate-retained");
  expect(existsSync(f.target)).toBe(false);
  let failure: any;
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL("./index.ts", import.meta.url))], { timeout: 20_000, stdio: "pipe", env: { PATH: dirname(process.execPath), HOME: f.root, USERPROFILE: f.root, MURAGE_DATA_DIR: f.target, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
  } catch (error) { failure = error; }
  expect(failure?.status, String(failure?.stderr)).toBe(1);
  expect(String(failure.stderr)).toContain("RESTORE_REVIEW_REQUIRED");
  expect(existsSync(f.target)).toBe(false);
  rollbackInstallationRestore(f.target);
  originalIntact(f);
});

it.each(["rollback-started", "candidate-retained", "original-restored"])("retries rollback after actual process exit at %s", async phase => {
  const f = await fixture(); await restoreInstallation(f.target, f.archive, f.sha);
  crash(f, "rollback", phase);
  expect(() => assertRestoreReviewed(f.target)).toThrow();
  const result = rollbackInstallationRestore(f.target);
  originalIntact(f);
  expect(existsSync(join(result.retainedCandidate!, "bots.json"))).toBe(true);
});
