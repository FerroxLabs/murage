// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectEncryptedInstallationBackup, writeEncryptedInstallationBackup } from "../installation-encrypted-backup.ts";
import { backupFixture, rawAgeHost, testAgeKeys } from "../testing/backup-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { SealedSecretStore } from "./secrets.ts";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });

// Same gate as the sibling backup suites: skipped only where no pinned age build exists for the platform (rawAgeHost). On a pinned host it runs, and fails if the staged age tools (scripts/prepare-backup-test-fixtures.mjs, MURAGE_BACKUP_TEST_AGE_DIR) are missing.
it.skipIf(!rawAgeHost)("the installation backup leaves the Cloud secrets directory out entirely: no plaintext and no sealed store", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  const canary = "FAKE-PENDING-REVOKE-TOKEN-CANARY";
  try {
    const dir = join(f.data, "secrets");
    const store = new SealedSecretStore(dir, "fixture-machine", Buffer.alloc(32, 3));
    store.patch({ fluxApiKey: canary, fluxComposioPendingRevokeTokens: JSON.stringify([canary]) });
    writeFileSync(join(dir, "plaintext-canary.txt"), canary);
    const archive = join(f.parent, "backup.age");
    const result = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
    expect(result.coverage.components).toContainEqual(expect.objectContaining({ path: "secrets", status: "excluded" }));
    const view = await inspectEncryptedInstallationBackup(archive, f.parent, keys);
    const files = walk(view.directory);
    expect(files.some(p => p.includes("credentials.enc") || p.includes("plaintext-canary"))).toBe(false);
    for (const file of files) expect(readFileSync(file).includes(Buffer.from(canary)), file).toBe(false);
    removeTempDirSync(view.directory);
  } finally { f.db.close(); removeTempDirSync(f.parent); }
}, 30000);
