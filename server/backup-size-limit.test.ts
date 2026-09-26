// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit A-05: a backup was made and "verified" at the owner's size
// limit (50 GB by default) and then refused by restore, which used its own
// 20 GiB default, while every owner file was stored twice (raw/ and
// recovery/). Now one set of limits (shared/backup-limits.ts) governs both
// sides, an owner file is stored once, and anything a backup verified at its
// own limit restores with restore's defaults.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectEncryptedInstallationBackup, restoreEncryptedInstallationNew, windowsStageCap, WINDOWS_BACKUP_BYTES, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { captureFailureSentence } from "../shared/backup-capture-failure.mjs";
import { reviewInstallation } from "./installation-activation.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";
import { MAX_BACKUP_BYTES } from "../shared/backup-limits.ts";
import { backupScheduleSchema } from "../shared/backup-schedule.ts";
import { installationRecoveryCommand } from "./installation-recovery-command.ts";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const MiB = 1024 ** 2;

it("the largest size limit Backups accepts is the size restore accepts", async () => {
  expect(backupScheduleSchema.safeParse({ maxBytes: MAX_BACKUP_BYTES }).success).toBe(true);
  expect(backupScheduleSchema.safeParse({ maxBytes: MAX_BACKUP_BYTES + 1 }).success).toBe(false);
  // The command line refuses a larger --max-bytes before it touches anything.
  await expect(installationRecoveryCommand(["backup-encrypted", "--data-dir", "/nonexistent", "--output", "/nonexistent/b.age", "--age-tool", "/nonexistent/age", "--recipient", "age1x", "--credential-policy", "preserve-in-encrypted-fidelity", "--max-bytes", String(MAX_BACKUP_BYTES + 1)], { readIdentity: async () => "" })).rejects.toThrow("INVALID_BACKUP_BUDGET");
  // Setup's own default sits inside it: src/components/backup-limits-ui.test.ts.
});

it.skipIf(!process.env.MURAGE_BACKUP_TEST_AGE_DIR)("a backup near its size limit is stored once, verified, and restores with restore's defaults", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  mkdirSync(join(f.data, "workspaces", "bot"), { recursive: true });
  const video = randomBytes(40 * MiB); // incompressible
  writeFileSync(join(f.data, "workspaces", "bot", "video.bin"), video);
  try {
    const archive = join(f.parent, "b.age");
    // 40 MiB of owner files inside a 42 MiB limit: this used to double to
    // about 80 MiB inside the archive.
    const saved = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection, maxBytes: 42 * MiB });
    expect(lstatSync(archive).size).toBeLessThan(42 * MiB);
    // What the backup verified at its own limit, inspection accepts at that
    // same limit and restore accepts with no limit given at all.
    await inspectEncryptedInstallationBackup(archive, f.parent, { ...keys, maxBytes: 42 * MiB }).then(result => rmSync(result.directory, { recursive: true, force: true }));
    const restored = join(f.parent, "restored");
    await restoreEncryptedInstallationNew(restored, archive, saved.sha256, keys);
    expect(readFileSync(join(restored, "workspaces", "bot", "video.bin")).equals(video)).toBe(true);
    expect(reviewInstallation(restored).status).toBe("ready-for-review");
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
}, 120_000);

it.skipIf(!process.env.MURAGE_BACKUP_TEST_AGE_DIR)("over its size limit, a backup is refused while it is taken, naming the file that passed it", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  mkdirSync(join(f.data, "workspaces", "bot"), { recursive: true });
  writeFileSync(join(f.data, "workspaces", "bot", "video.bin"), randomBytes(12 * MiB));
  try {
    const error = await writeEncryptedInstallationBackup(f.data, join(f.parent, "b.age"), { ...keys, selection, maxBytes: 8 * MiB }).then(() => null, (caught: { code?: string; path?: string }) => caught);
    expect({ code: error?.code, path: error?.path }).toEqual({ code: "SNAPSHOT_LIMIT_EXCEEDED", path: "workspaces/bot/video.bin" });
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
}, 60_000);

// Windows' helper holds 20 GiB whatever the owner's limit says, so there the
// backup stops at that size with its own sentence, not "raise the limit".
it("on Windows the stage stops at what the helper holds, with a sentence that fits", () => {
  expect(windowsStageCap("win32", 50 * 1024 ** 3)).toBe(WINDOWS_BACKUP_BYTES);
  expect(windowsStageCap("win32", 10 * 1024 ** 3)).toBeUndefined();
  expect(windowsStageCap("darwin", 50 * 1024 ** 3)).toBeUndefined();
  const sentence = captureFailureSentence({ stage: "capture", code: "BACKUP_WINDOWS_SIZE_LIMIT", path: "workspaces/mira/video.mov" });
  expect(sentence).toMatch(/On Windows one backup can hold up to 20 GB/);
  expect(sentence).not.toMatch(/Raise/);
  expect(sentence).toContain("The item is workspaces/mira/video.mov");
});
