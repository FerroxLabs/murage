// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sean's first backup (2026-10-23 13:30Z) died on `config.json.bak-20260918-openaicompat`:
// BACKUP_UNCLASSIFIED_COMPONENT stopped it, so he had no backup at all. A stray file in the data
// folder must never fail a whole backup (rule: server/data-dir-inventory.ts, end of file).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { classifyDataDirEntryForBackup } from "./data-dir-inventory.ts";
import { withOfflineInstallation } from "./installation-database-snapshot.ts";
import { stageInstallationStateWhileOwned } from "./installation-state-snapshot.ts";
import { inventoryFidelity } from "./installation-fidelity-snapshot.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { backupSkippedLines } from "../shared/backup-skipped.mjs";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const KEY = "stray-config-copy-fixture-value-0123";

it("enabling backups with a stray config.json.bak-* present completes, leaves the key copy out, and says so", async () => {
  const f = backupFixture();
  try {
    writeFileSync(join(f.data, "config.json.bak-20260918-openaicompat"), JSON.stringify({ composio: { apiKey: KEY } }));
    writeFileSync(join(f.data, ".DS_Store"), "x");
    writeFileSync(join(f.data, "notes.md~"), "x");
    writeFileSync(join(f.data, "my-own-notes.txt"), "work of mine");
    await withOfflineInstallation(f.data, async installation => {
      const stage = await stageInstallationStateWhileOwned(installation, f.parent);
      const inventory = await inventoryFidelity(installation, stage, selection);
      const status = (path: string) => inventory.coverage.components.find(item => item.path === path)?.status;
      // the current config.json is still backed up; the stray key copy is not, anywhere in the backup
      expect(inventory.sources.find(file => file.path === "config.json")).toBeTruthy();
      expect(status("config.json.bak-20260918-openaicompat")).toBe("excluded");
      expect(status(".DS_Store")).toBe("excluded");
      expect(status("notes.md~")).toBe("excluded");
      expect(stage.manifest.files.map(file => file.path)).not.toContain("config.json.bak-20260918-openaicompat");
      for (const file of stage.manifest.files) if (!file.path.includes("/")) expect(readFileSync(join(f.data, file.path), "utf8").includes(KEY) && file.path !== "config.json").toBe(false);
      // an unknown plain file may be the owner's work: kept, and named in the coverage as not recognised
      expect(stage.manifest.files.map(file => file.path)).toContain("my-own-notes.txt");
      expect(inventory.coverage.components.find(item => item.path === "my-own-notes.txt")?.reason).toMatch(/Not recognised by Murage; kept/);
      // both are listed to the person in plain words, in the same list as the coverage
      expect(stage.manifest.skipped).toEqual(expect.arrayContaining([{ path: "config.json.bak-20260918-openaicompat", reason: "old-copy" }, { path: "my-own-notes.txt", reason: "unrecognised" }]));
      expect(stage.manifest.skipped).toHaveLength(2);
      const lines = backupSkippedLines({ count: stage.manifest.skippedCount!, items: stage.manifest.skipped! }).join(" ");
      expect(lines).toMatch(/config\.json\.bak-20260918-openaicompat \(an older copy of a settings file, which can hold keys/);
      expect(lines).toMatch(/Kept in the backup, though Murage doesn't recognise this item in Murage's data folder: my-own-notes\.txt\./);
      inventory.assertUnchanged();
    });
    expect(existsSync(join(f.data, "config.json.bak-20260918-openaicompat"))).toBe(true); // never deleted or touched
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it("classification: old copies and junk are left out, an unknown file is kept, an unknown folder or a known refusal still stops", () => {
  for (const name of ["config.json.bak-20260918-openaicompat", "bots.json.bak", "groups.json.old", "routines.json.orig", "config.json.backup-2"]) expect(classifyDataDirEntryForBackup(name, "file")).toMatchObject({ backup: "excluded", skip: "old-copy" });
  for (const name of [".DS_Store", "Thumbs.db", "._bots.json", ".config.json.swp", "bots.json~", "#bots.json#", ".#bots.json", "download.crdownload"]) expect(classifyDataDirEntryForBackup(name, "file").backup).toBe("excluded");
  expect(classifyDataDirEntryForBackup("my-own-notes.txt", "file")).toMatchObject({ backup: "owner-file", unrecognised: true });
  expect(classifyDataDirEntryForBackup("link-to-elsewhere", "other")).toMatchObject({ backup: "excluded", skip: "special" });
  expect(classifyDataDirEntryForBackup("some-new-folder", "folder")).toMatchObject({ backup: "refused", code: "BACKUP_UNCLASSIFIED_COMPONENT" });
  expect(classifyDataDirEntryForBackup(".package-import-transaction", "folder")).toMatchObject({ backup: "refused" });
  // known names keep their own handling
  expect(classifyDataDirEntryForBackup("config.json", "file")).toMatchObject({ backup: "record" });
});
