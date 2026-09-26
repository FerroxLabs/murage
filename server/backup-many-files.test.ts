// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit A-01: a large tree in a bot's folder. Two ordinary JavaScript
// projects' node_modules pass 100,000 entries, and a backup refused them with
// "Raise the limit in Backups", a limit nobody could raise. Rebuildable
// folders are now left out and listed, so they never count. Real work can
// still be large: the file limit counts only what is backed up, and every
// item under it is restorable. (Before, every file was stored twice, so the
// real ceiling was about 50,000 files and the contents list outgrew its
// 32 MiB cap well before that.)
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
// 60 folders of 1,000 files; MURAGE_TEST_MANY_FILE_FOLDERS changes it for timing.
const folders = Number(process.env.MURAGE_TEST_MANY_FILE_FOLDERS ?? 60);
const count = (folder: string): number => readdirSync(folder, { withFileTypes: true }).reduce((total, entry) => total + (entry.isDirectory() ? count(join(folder, entry.name)) : 1), 0);

it.skipIf(!process.env.MURAGE_BACKUP_TEST_AGE_DIR)("backs up and restores 60,000 files of real work beside 100,000 rebuildable ones", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  const desk = join(f.data, "workspaces", "bot", "threads", "thread");
  // Two node_modules trees: left out, never counted.
  for (const project of ["site", "api"]) for (let d = 0; d < Math.min(50, folders); d++) {
    const dir = join(desk, project, "node_modules", `pkg-${d}`); mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 1000; i++) writeFileSync(join(dir, `f${i}.js`), "");
  }
  // Real work with long, nested names.
  for (let d = 0; d < folders; d++) {
    const dir = join(desk, "research-notes-archive", `quarter-${String(d).padStart(3, "0")}-interviews-and-transcripts`); mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 1000; i++) writeFileSync(join(dir, `customer-interview-${String(i).padStart(4, "0")}.md`), `note ${d}/${i}\n`);
  }
  try {
    const archive = join(f.parent, "b.age");
    const saved = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
    const skipped = (saved as { skipped?: { count: number; items: Array<{ path: string; reason: string }> } }).skipped;
    expect(skipped?.items.map(item => item.path).sort()).toEqual(["workspaces/bot/threads/thread/api/node_modules", "workspaces/bot/threads/thread/site/node_modules"]);
    const restored = join(f.parent, "restored");
    await restoreEncryptedInstallationNew(restored, archive, saved.sha256, keys);
    expect(count(join(restored, "workspaces", "bot", "threads", "thread", "research-notes-archive"))).toBe(folders * 1000);
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
}, 900_000);
