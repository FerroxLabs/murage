// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 Kimi audit: each finding reproduced here first, then fixed.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recoveryDesktopSummary } from "../electron/installation-recovery-protocol.mjs";
import { validateArchiveFileList, writeInstallationArchive } from "./installation-archive.ts";
import { writeEncryptedInstallationBackup, restoreEncryptedInstallationNew, windowsRestoreRefusal, windowsTotalRefusal } from "./installation-encrypted-backup.ts";
import { restoreInstallation } from "./installation-restore.ts";
import { reviewInstallation } from "./installation-activation.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";
import { backupSkippedLines } from "../shared/backup-skipped.mjs";
import { WINDOWS_BACKUP_BYTES } from "./installation-encrypted-backup.ts";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;

// #1: a name with a backslash, or a bot name with a control character, in the
// list of skipped items must never turn a good backup into a failure.
it.skipIf(process.platform === "win32" || !process.env.MURAGE_BACKUP_TEST_AGE_DIR)("a skipped item named ..\\plug or \\ and a bot named with a bell still report a good backup", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  const desk = join(f.data, "workspaces", "bot"); mkdirSync(desk, { recursive: true });
  execFileSync("mkfifo", [join(desk, "..\\plug")]);
  writeFileSync(join(desk, "\\"), "x"); chmodSync(join(desk, "\\"), 0o000);
  const bots = JSON.parse(readFileSync(join(f.data, "bots.json"), "utf8")); bots[0].name = "Be\u0007ll"; writeFileSync(join(f.data, "bots.json"), JSON.stringify(bots));
  try {
    const saved = await writeEncryptedInstallationBackup(f.data, join(f.parent, "b.age"), { ...keys, selection });
    const summary = recoveryDesktopSummary({ ok: true, operation: "backup-encrypted", ...saved }) as { skipped: { count: number; items: Array<{ path: string }> } };
    expect(summary.skipped.items.map((item: { path: string }) => item.path).sort()).toEqual(["workspaces/bot/..\\plug", "workspaces/bot/\\"]);
    const lines = backupSkippedLines(summary.skipped).join(" ");
    expect(lines).toContain("..\\plug"); expect(lines).not.toContain("../plug"); expect(lines).not.toMatch(/[\x00-\x1f]/);
  } finally { chmodSync(join(desk, "\\"), 0o600); f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
}, 60_000);

it("a malformed skipped list never fails a good result", () => {
  const good = { ok: true, operation: "backup-encrypted", path: "/b/x.age", sha256: "a".repeat(64), snapshotId: "12345678-1234-1234-1234-123456789abc", coverage: { scope: "application-data", fullInstallation: false, components: [] } };
  const summary = recoveryDesktopSummary({ ...good, skipped: { count: 2, items: [{ path: "/etc/passwd", reason: "rebuildable" }, { path: "x", reason: "because" }], bots: { bot: "\u0007" } } }) as { skipped: { count: number } };
  expect(summary.skipped.count).toBe(2);
});

// #2: a crafted archive must not plant Murage's own records or links out of the data folder.
async function crafted(f: ReturnType<typeof backupFixture>, extra: object) {
  const saved = await writeInstallationArchive(f.data, join(f.parent, "x.zip"));
  return { manifest: { ...saved.manifest, ...extra }, saved };
}
it("a copy may only come from the same owner folder; never from Murage's own records", () => {
  const files = [{ path: "messages.db", bytes: 1, sha256: "a".repeat(64) }, { path: "workspaces/bot/a", bytes: 1, sha256: "b".repeat(64) }, { path: "attachments/c", bytes: 1, sha256: "c".repeat(64) }];
  const database = { status: "copied" as const, messages: 0, threads: 0, bytes: 1, sha256: "a".repeat(64) };
  expect(() => validateArchiveFileList({ files, database, copies: [{ path: "workspaces/bot/x/db", from: "messages.db" }] })).toThrow(/UNSAFE_ARCHIVE_PATH|refused/);
  expect(() => validateArchiveFileList({ files, database, copies: [{ path: "workspaces/bot/x", from: "attachments/c" }] })).toThrow(/UNSAFE_ARCHIVE_PATH|refused/);
  expect(() => validateArchiveFileList({ files, database, copies: [{ path: "workspaces/bot/b", from: "workspaces/bot/a" }] })).not.toThrow();
});
it("a restored shortcut must stay inside the restored data folder; others are left out and listed", async () => {
  const f = backupFixture();
  const desk = join(f.data, "workspaces", "bot"); mkdirSync(join(desk, "lib"), { recursive: true }); writeFileSync(join(desk, "lib", "i.js"), "x");
  const { symlinkSync } = await import("node:fs");
  symlinkSync("lib/i.js", join(desk, "inside")); symlinkSync("/etc", join(desk, "absolute")); symlinkSync("../../../../outside", join(desk, "escape"));
  try {
    const saved = await writeInstallationArchive(f.data, join(f.parent, "x.zip"));
    const target = join(f.parent, "restored");
    await restoreInstallation(target, saved.path, saved.sha256, { requireNew: true });
    expect(lstatSync(join(target, "workspaces", "bot", "inside")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, "workspaces", "bot", "absolute")) || (() => { try { lstatSync(join(target, "workspaces", "bot", "absolute")); return true; } catch { return false; } })()).toBe(false);
    expect(() => lstatSync(join(target, "workspaces", "bot", "escape"))).toThrow();
    const review = JSON.parse(readFileSync(join(target, "restore-review.json"), "utf8"));
    expect(review.modifications.filter((m: { action: string }) => /outside Murage's data folder/.test(m.action)).length).toBe(2);
    expect(reviewInstallation(target).status).toBe("ready-for-review");
    // The review refuses a link that leads out, however it got there.
    symlinkSync("/etc", join(target, "workspaces", "bot", "planted"));
    expect(() => reviewInstallation(target)).toThrow();
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
});

// #6: past what Windows' backup tool holds, the 20 GB sentence, not a key error.
it("Windows refuses a backup bigger than its tool holds with the 20 GB sentence", () => {
  expect(windowsRestoreRefusal("win32", WINDOWS_BACKUP_BYTES + 128 * 1024 ** 2)).toBe("BACKUP_WINDOWS_SIZE_LIMIT");
  expect(windowsRestoreRefusal("darwin", 30 * 1024 ** 3)).toBeNull();
  expect(windowsTotalRefusal("win32", WINDOWS_BACKUP_BYTES - 10, 20)).toBe("BACKUP_WINDOWS_SIZE_LIMIT");
  expect(windowsTotalRefusal("win32", 10, 20)).toBeNull();
});

// #7: copies accounting is linear.
it("50,000 extra names validate quickly", () => {
  const files = Array.from({ length: 50_000 }, (_, i) => ({ path: `workspaces/bot/f${i}`, bytes: 1, sha256: "a".repeat(64) }));
  const copies = files.map((file, i) => ({ path: `workspaces/bot/g${i}`, from: file.path }));
  const started = Date.now();
  validateArchiveFileList({ files, database: { status: "absent" }, copies });
  expect(Date.now() - started).toBeLessThan(1_000);
});
void crafted; void restoreEncryptedInstallationNew;
