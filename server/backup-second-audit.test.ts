// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 second audit: (1) no plaintext byte on the backup folder, (2) paths
// another computer can't hold are left out and listed, (3) the no-hard-link
// publish never replaces another writer's file.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as archive from "./installation-archive.ts";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { backupWorkRoot, createBackupWork, sweepBackupWork } from "./backup-local-work.ts";
import { publishNoReplace } from "./publish-file.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";
import { MAX_RESTORABLE_PATH_BYTES } from "../shared/backup-limits.ts";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const tree = (root: string): string[] => existsSync(root) ? readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? [relative(root, join(root, entry.name)) + "/", ...tree(join(root, entry.name)).map(child => entry.name + "/" + child)] : [entry.name]) : [];
afterEach(() => vi.restoreAllMocks());

for (const failAt of [null, "readback"] as const) {
  it.skipIf(!process.env.MURAGE_BACKUP_TEST_AGE_DIR)(`only ciphertext ever sits in the backup folder${failAt ? ", also when the readback fails" : ""}`, async () => {
    const f = backupFixture(), keys = testAgeKeys();
    const destination = join(f.parent, "USB STICK", "Murage Backups"); mkdirSync(destination, { recursive: true });
    const seen: { destination: string[]; plaintextLocal: boolean } [] = [];
    const inspect = archive.inspectArchiveEntries;
    vi.spyOn(archive, "inspectArchiveEntries").mockImplementation(async (file, ...rest) => {
      // Mid-readback: the decrypted archive exists, and not in the backup folder.
      seen.push({ destination: tree(destination), plaintextLocal: file.startsWith(backupWorkRoot(f.data)) && statSync(file).size > 0 });
      if (failAt) throw new Error("injected readback failure");
      return inspect(file, ...rest);
    });
    try {
      const result = await writeEncryptedInstallationBackup(f.data, join(destination, "backup.age"), { ...keys, selection }).then(() => "made", () => "failed");
      expect(result).toBe(failAt ? "failed" : "made");
      expect(seen).toHaveLength(1);
      expect(seen[0].plaintextLocal).toBe(true);
      // During the readback: one private write folder holding only the ciphertext.
      expect(seen[0].destination.filter(name => !name.endsWith("/"))).toEqual([expect.stringMatching(/^\.murage-encrypted-write-[^/]+\/backup\.age$/)]);
      expect(tree(destination)).toEqual(failAt ? [] : ["backup.age"]);
      // And the local plaintext work is gone.
      expect(existsSync(backupWorkRoot(f.data))).toBe(false);
    } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); rmSync(join(backupWorkRoot(f.data), ".."), { recursive: true, force: true }); }
  }, 60_000);
}

it("a crash's plaintext work folder is swept once its process has gone, never a live one", () => {
  const f = backupFixture();
  try {
    const live = createBackupWork(f.data);
    const dead = join(backupWorkRoot(f.data), "run-999999-AbC123"); mkdirSync(dead); writeFileSync(join(dead, "authenticated.zip"), "plaintext");
    expect(statSync(backupWorkRoot(f.data)).mode & 0o077).toBe(0);
    expect(sweepBackupWork(f.data)).toBe(1);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); rmSync(join(backupWorkRoot(f.data), ".."), { recursive: true, force: true }); }
});

// Codex's scenario, scaled to what macOS can create: nested names of colons
// and accented letters whose percent-encoded path passes the restore bound.
it.skipIf(!process.env.MURAGE_BACKUP_TEST_AGE_DIR)("a path another computer can't hold is left out and listed; the backup restores", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  const name = ":".repeat(60) + "é".repeat(20);
  const deep = join(f.data, "workspaces", "bot", ...Array(5).fill(name));
  mkdirSync(deep, { recursive: true }); writeFileSync(join(deep, "note.md"), "deep\n");
  const near = join(f.data, "workspaces", "bot", "n".repeat(200), "m".repeat(200), "o".repeat(200)); mkdirSync(near, { recursive: true }); writeFileSync(join(near, "kept.md"), "kept\n");
  try {
    const saved = await writeEncryptedInstallationBackup(f.data, join(f.parent, "b.age"), { ...keys, selection });
    const skipped = (saved as { skipped?: { items: Array<{ path: string; reason: string }> } }).skipped?.items ?? [];
    expect(skipped).toEqual([{ path: expect.stringMatching(/^workspaces\/bot\/(?::{60}é{20}\/){3,4}:{60}é{20}$/), reason: "path-too-long" }]);
    const restored = join(f.parent, "restored");
    await restoreEncryptedInstallationNew(restored, join(f.parent, "b.age"), saved.sha256, keys);
    expect(readFileSync(join(restored, "workspaces", "bot", "n".repeat(200), "m".repeat(200), "o".repeat(200), "kept.md"), "utf8")).toBe("kept\n");
    expect(Buffer.byteLength(`workspaces/bot/${"n".repeat(200)}/${"m".repeat(200)}/${"o".repeat(200)}/kept.md`)).toBeLessThanOrEqual(MAX_RESTORABLE_PATH_BYTES);
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
}, 60_000);

it("archive paths are measured in bytes, not characters", () => {
  expect(archive.portableArchivePath("a/" + "é".repeat(100))).toBe(true);
  expect(archive.portableArchivePath(Array(20).fill("é".repeat(110)).join("/"))).toBe(false); // 4,419 bytes, 2,219 characters
});

const noLinks = () => { throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" }); };
it("without hard links, a name taken before the reservation is never replaced", () => {
  const f = backupFixture();
  try {
    writeFileSync(join(f.parent, "src"), "ours"); writeFileSync(join(f.parent, "dst"), "theirs");
    expect(() => publishNoReplace(join(f.parent, "src"), join(f.parent, "dst"), { link: noLinks })).toThrow(/EEXIST/);
    expect(readFileSync(join(f.parent, "dst"), "utf8")).toBe("theirs");
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
});
it("without hard links, a writer racing the reservation can neither take the name nor lose its file", () => {
  const f = backupFixture();
  try {
    const src = join(f.parent, "src"), dst = join(f.parent, "dst");
    writeFileSync(src, "ours");
    // In the window: an exclusive create by someone else fails...
    publishNoReplace(src, dst, { link: noLinks, afterReserve: () => { expect(() => writeFileSync(dst, "theirs", { flag: "wx" })).toThrow(/EEXIST/); } });
    expect(readFileSync(dst, "utf8")).toBe("ours");
    // ...and one that replaces the reservation outright keeps its file.
    writeFileSync(src, "ours again"); const dst2 = join(f.parent, "dst2");
    expect(() => publishNoReplace(src, dst2, { link: noLinks, afterReserve: () => { rmSync(dst2); writeFileSync(dst2, "theirs"); } })).toThrow(/EEXIST/);
    expect(readFileSync(dst2, "utf8")).toBe("theirs");
    expect(readFileSync(src, "utf8")).toBe("ours again");
    // A failed rename removes only our own empty reservation.
    const dst3 = join(f.parent, "dst3");
    expect(() => publishNoReplace(join(f.parent, "missing"), dst3, { link: noLinks })).toThrow();
    expect(existsSync(dst3)).toBe(false);
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
});
