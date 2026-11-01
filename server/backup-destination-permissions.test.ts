import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { captureFailureSentence } from "../shared/backup-capture-failure.mjs";
import { removeTempDirSync } from "./testing/cleanup.ts";

const failure = vi.hoisted(() => ({ code: "EACCES", operation: "mkdir" }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
    if (failure.operation === "mkdir" && String(args[0]).includes(".murage-encrypted-write-"))
      throw Object.assign(new Error("injected destination permissions"), { code: failure.code });
    return fs.mkdtempSync(...args);
  }, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    if (failure.operation === "stat" && String(args[0]).endsWith("backup.age"))
      throw Object.assign(new Error("injected destination permissions"), { code: failure.code });
    return fs.lstatSync(...args);
  } };
});

for (const code of ["EACCES", "EPERM", "EROFS"])
  for (const operation of ["mkdir", "stat"])
  it.skipIf(process.platform === "win32" && operation === "mkdir")(`names ${code} during destination ${operation}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "murage-readonly-backup-"));
    try {
      const data = join(root, "data"), destination = join(root, "backups");
      mkdirSync(data); mkdirSync(destination); failure.code = code; failure.operation = operation;
      await expect(writeEncryptedInstallationBackup(data, join(destination, "backup.age"), {
        ageExecutable: "unused", identity: "unused", recipient: "unused",
        selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" },
      })).rejects.toMatchObject({ code: "BACKUP_FOLDER_NOT_WRITABLE", captureStep: "private-stage" });
      expect(captureFailureSentence({ stage: "capture", code: "BACKUP_FOLDER_NOT_WRITABLE" }))
        .toBe("The last backup stopped while copying your workspace. Murage can't write a file the backup needs. Choose a backup folder you can write to, or fix the permissions on that folder and on the folder that holds Murage's data.");
    } finally { removeTempDirSync(root); }
  });
