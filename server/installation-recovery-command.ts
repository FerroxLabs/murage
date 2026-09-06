import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInstallationArchive, writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { restoreInstallation, rollbackInstallationRestore } from "./installation-restore.ts";
import { reviewInstallation, activateInstallation } from "./installation-activation.ts";

export const usage = "Usage: installation-recovery backup --data-dir <stopped-installation> --output <new-backup.zip> | inspect --archive <backup.zip> | plan-restore --archive <backup.zip> | restore --data-dir <stopped-installation> --archive <backup.zip> --sha256 <inspected-hash> | rollback --data-dir <installation>";

export async function installationRecoveryCommand(args: string[]): Promise<Record<string, unknown>> {
  const command = args[0];
  const options = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || options.has(key)) throw new Error(usage);
    options.set(key, value);
  }
  if (command === "backup" && options.size === 2 && options.has("--data-dir") && options.has("--output")) {
    const result = await writeInstallationArchive(options.get("--data-dir")!, options.get("--output")!);
    return { ok: true, operation: "backup", path: result.path, sha256: result.sha256, snapshotId: result.manifest.snapshotId, files: result.manifest.files.length, omitted: result.manifest.omitted, missing: result.manifest.missing, restorePolicy: result.manifest.restorePolicy };
  }
  if (command === "inspect" && options.size === 1 && options.has("--archive")) {
    const scratch = mkdtempSync(join(tmpdir(), "murage-backup-inspect-command-"));
    try {
      const result = await inspectInstallationArchive(options.get("--archive")!, scratch);
      return { ok: true, operation: "inspect", sha256: result.sha256, snapshotId: result.manifest.snapshotId, createdAt: result.manifest.createdAt, files: result.manifest.files.length, database: result.manifest.database, omitted: result.manifest.omitted, missing: result.manifest.missing, restorePolicy: result.manifest.restorePolicy, activationAvailable: false };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  if (command === "plan-restore" && options.size === 1 && options.has("--archive")) {
    const scratch = mkdtempSync(join(tmpdir(), "murage-restore-plan-command-"));
    try {
      const result = await prepareInstallationRestore(options.get("--archive")!, scratch);
      return { ok: true, operation: "plan-restore", sha256: result.sha256, snapshotId: result.manifest.snapshotId, restorePolicy: "paused-review-required", modifications: result.modifications, quarantined: result.quarantined, omitted: result.manifest.omitted, missing: result.manifest.missing, activationAvailable: false };
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  if (command === "restore" && options.size === 3 && options.has("--data-dir") && options.has("--archive") && options.has("--sha256")) {
    return { ok: true, operation: "restore", ...await restoreInstallation(options.get("--data-dir")!, options.get("--archive")!, options.get("--sha256")!) };
  }
  if (command === "rollback" && options.size === 1 && options.has("--data-dir")) {
    return { ok: true, operation: "rollback", ...rollbackInstallationRestore(options.get("--data-dir")!) };
  }
  if (command === "review" && options.size === 1 && options.has("--data-dir")) {
    return { ok: true, operation: "review", ...reviewInstallation(options.get("--data-dir")!) };
  }
  if (command === "activate" && options.size === 2 && options.has("--data-dir") && options.has("--review-hash")) {
    return { ok: true, operation: "activate", ...activateInstallation(options.get("--data-dir")!, options.get("--review-hash")!) };
  }
  throw new Error(usage);
}
