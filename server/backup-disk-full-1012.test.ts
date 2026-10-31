// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.12: a disk that fills up during the database copy, encryption or the
// readback is named as a full disk. These faults stand in for the real one;
// server/backup-real-full-disk.test.ts runs the same paths on a small volume.
import { closeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { decryptBackupFile } from "./installation-backup-encryption.ts";
import { isDiskFullError } from "./memory/schema.ts";
import { backupFixture, rawAgeHost, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { captureFailureSentence, describeCaptureError } from "../shared/backup-capture-failure.mjs";

const faults = vi.hoisted(() => ({ copy: undefined as Error | undefined, write: undefined as { name: string; error: Error } | undefined }));
vi.mock("node:sqlite", async importOriginal => {
  const real = await importOriginal<typeof import("node:sqlite")>();
  return { ...real, backup: (...args: Parameters<typeof real.backup>) => faults.copy ? Promise.reject(faults.copy) : real.backup(...args) };
});
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, default: real, createWriteStream: (path: string, options: { fd: number }) => {
    const fault = faults.write;
    if (!fault || !String(path).endsWith(fault.name)) return real.createWriteStream(path, options);
    return new Writable({ write(_chunk, _encoding, done) { done(fault.error); }, destroy(error, done) { try { closeSync(options.fd); } catch { /* already closed */ } done(error); } });
  } };
});

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const noSpace = (code = "ENOSPC") => Object.assign(new Error(`${code}: no space left on device, write`), { code, syscall: "write" });
afterEach(() => { faults.copy = undefined; faults.write = undefined; });

/** The error SQLite itself raises, so the test can't drift from what it really says. */
function realSqliteFull(): Error {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA max_page_count=4;CREATE TABLE t(v BLOB)");
    db.prepare("INSERT INTO t VALUES (zeroblob(1000000))").run();
  } catch (error) { return error as Error; } finally { db.close(); }
  throw new Error("SQLite did not fill up");
}

it("the error SQLite raises for a full database is known as a full disk", () => {
  const error = realSqliteFull();
  expect(error).toMatchObject({ errcode: 13 });
  expect(isDiskFullError(error)).toBe(true);
});

it("a full disk during the database copy is named, as SQLite says it and as the file system says it", async () => {
  for (const fault of [realSqliteFull(), noSpace(), noSpace("EDQUOT")]) {
    const f = backupFixture();
    try {
      faults.copy = fault;
      await expect(snapshotInstallationDatabase(f.data, join(f.parent, "copy.db"))).rejects.toMatchObject({ code: "BACKUP_DISK_FULL" });
    } finally { f.db.close(); removeTempDirSync(f.parent); }
  }
});

it("any other database copy failure keeps its own code", async () => {
  const f = backupFixture();
  try {
    faults.copy = Object.assign(new Error("disk I/O error"), { errcode: 10 });
    await expect(snapshotInstallationDatabase(f.data, join(f.parent, "copy.db"))).rejects.toMatchObject({ code: "DATABASE_SNAPSHOT_FAILED" });
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it.skipIf(!rawAgeHost)("a full disk during the database copy reaches the owner as a full disk, not as a database problem", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  try {
    faults.copy = realSqliteFull();
    const caught = await writeEncryptedInstallationBackup(f.data, join(f.parent, "x.age"), { ...keys, selection }).catch(error => error);
    expect(caught).toMatchObject({ code: "BACKUP_DISK_FULL", captureStep: "stage" });
    expect(captureFailureSentence({ stage: "capture", code: caught.code })).toContain("Free up space on this computer's drive and on the drive that holds your backup folder");
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it.skipIf(!rawAgeHost)("a full disk during encryption is a full disk, and no longer points at the recovery key", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  try {
    faults.write = { name: "backup.age", error: noSpace() };
    const caught = await writeEncryptedInstallationBackup(f.data, join(f.parent, "x.age"), { ...keys, selection }).catch(error => error);
    expect(caught).toMatchObject({ code: "BACKUP_DISK_FULL", captureStep: "encrypt" });
    expect(describeCaptureError(caught)).toMatchObject({ errno: "ENOSPC", tool: "age" });
    expect(captureFailureSentence({ stage: "capture", code: caught.code })).not.toMatch(/recovery key/i);
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it.skipIf(!rawAgeHost)("a full disk while the finished file is decrypted for its check is a full disk too", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  try {
    faults.write = { name: "authenticated.zip", error: noSpace() };
    const caught = await writeEncryptedInstallationBackup(f.data, join(f.parent, "x.age"), { ...keys, selection }).catch(error => error);
    expect(caught).toMatchObject({ code: "BACKUP_DISK_FULL", captureStep: "readback" });
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it.skipIf(!rawAgeHost)("a write failure that isn't a full disk stays the encryption tool's failure", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  try {
    faults.write = { name: "backup.age", error: Object.assign(new Error("EIO: i/o error, write"), { code: "EIO", syscall: "write" }) };
    const caught = await writeEncryptedInstallationBackup(f.data, join(f.parent, "x.age"), { ...keys, selection }).catch(error => error);
    expect(caught).toMatchObject({ code: "AGE_PROCESS_FAILED", captureStep: "encrypt" });
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it.skipIf(!rawAgeHost)("a wrong key is still a wrong key", async () => {
  const f = backupFixture(), keys = testAgeKeys(), other = testAgeKeys();
  try {
    const archive = join(f.parent, "x.age");
    await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
    await expect(decryptBackupFile(keys.ageExecutable, other.identity, archive, join(f.parent, "plain"), { maxBytes: 10 ** 9 })).rejects.toMatchObject({ code: "AGE_PROCESS_FAILED" });
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});
