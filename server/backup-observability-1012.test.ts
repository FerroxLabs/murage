// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.12: step timing and real progress are additions around a backup. A run
// that works today has to finish the same with them in.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectEncryptedInstallationBackup, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { installationRecoveryCommand } from "./installation-recovery-command.ts";
import { backupFixture, rawAgeHost, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { BACKUP_WORKER_STEPS, type BackupProgressReport } from "../shared/backup-progress.mjs";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;

async function contents(archive: string, parent: string, keys: ReturnType<typeof testAgeKeys>) {
  const view = await inspectEncryptedInstallationBackup(archive, parent, keys);
  try { return { sha256: view.sha256, files: Object.fromEntries(view.manifest.files.map(file => [file.path, file.sha256])) }; }
  finally { removeTempDirSync(view.directory); }
}
const leftovers = (parent: string) => readdirSync(parent).filter(name => name.startsWith(".murage-"));

it.skipIf(!rawAgeHost)("a run that succeeds today still succeeds, whatever happens to its notes", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  try {
    const seen: string[] = [];
    const modes: Array<[string, { onProgress?: BackupProgressReport }]> = [
      ["as it runs today", {}],
      ["with notes collected", { onProgress: step => { seen.push(step); } }],
      ["with notes that throw", { onProgress: () => { throw new Error("the window went away"); } }],
    ];
    let baseline: Awaited<ReturnType<typeof contents>>["files"] | undefined;
    for (const [index, [name, options]] of modes.entries()) {
      const archive = join(f.parent, `backup-${index}.age`);
      const result = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection, ...options });
      expect(result.path, name).toBe(realpathSync.native(archive));
      const read = await contents(archive, f.parent, keys);
      expect(read.sha256, name).toBe(result.sha256);
      baseline ??= read.files;
      expect(read.files, name).toEqual(baseline);
      expect(leftovers(f.parent), name).toEqual([]);
    }
    // Every step, in the order a run takes them (the source is checked again twice).
    const order = seen.filter((step, index) => step !== seen[index - 1]);
    expect(order).toEqual(["records", "database-read", "source-recheck", "database-check", "database-copy", "database-clean", "database-verify", "source-recheck", "database-digest", "ledger", "inventory", "encrypt", "readback", "readback-entries", "readback-hash", "flush", "publish", "done"]);
    for (const step of order) expect(BACKUP_WORKER_STEPS).toContain(step);
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it.skipIf(!rawAgeHost)("the worker's command hands notes to the run, with real byte counts", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  try {
    const counts = new Map<string, { done: number; total: number }>();
    const archive = join(f.parent, "command.age");
    const result = await installationRecoveryCommand(["backup-encrypted", "--data-dir", f.data, "--output", archive, "--age-tool", keys.ageExecutable, "--recipient", keys.recipient, "--credential-policy", "preserve-in-encrypted-fidelity", "--max-bytes", String(10 ** 9), "--max-duration-ms", String(60_000)], {
      readIdentity: async () => keys.identity,
      onProgress: (step, done, total) => { if (done !== undefined && total !== undefined) counts.set(step, { done, total }); },
    });
    expect(result).toMatchObject({ ok: true, operation: "backup-encrypted" });
    const size = statSync(archive).size;
    expect(counts.get("readback")).toEqual({ done: expect.any(Number), total: size });
    expect(counts.get("readback")!.done).toBeGreaterThan(0);
    const encrypt = counts.get("encrypt")!;
    expect(encrypt.done).toBeGreaterThan(0);
    // The archive's own size, before age adds its small framing.
    expect(encrypt.total).toBeLessThanOrEqual(size);
    expect(encrypt.total).toBeGreaterThan(size * 0.9);
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});
