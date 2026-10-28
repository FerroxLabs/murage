// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sean's first backup (2026-10-23 13:30Z) died on `config.json.bak-20260918-openaicompat`:
// BACKUP_UNCLASSIFIED_COMPONENT stopped it, so he had no backup at all. A stray name in the data
// folder must never fail a whole backup (rule: server/data-dir-inventory.ts, end of file).
//
// GrokBuild High, twice (1.0.4 backup-visible r1 and r2): keeping an unknown file raw stored copies of
// key-bearing files, and no name rule can catch a copy saved as `myconfig.json` or `backup.tar`. So a
// top-level name that is not an exact inventory row is never stored, under any name: left out, listed
// with a true reason, never written back by a restore. Exact rows behave as before.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { classifyDataDirEntry, classifyDataDirEntryForBackup, DATA_DIR_ENTRIES, DATA_DIR_PATTERNS } from "./data-dir-inventory.ts";
import { withOfflineInstallation } from "./installation-database-snapshot.ts";
import { stageInstallationStateWhileOwned } from "./installation-state-snapshot.ts";
import { inventoryFidelity } from "./installation-fidelity-snapshot.ts";
import { writeEncryptedInstallationBackup, restoreEncryptedInstallationNew } from "./installation-encrypted-backup.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { backupSkippedLines } from "../shared/backup-skipped.mjs";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
// Built at run time so no key-shaped literal sits in the source.
const SECRET = "stray-secret-fixture-value-9876";
const SK_LIVE = ["sk", "live", "fixture0123456789abcdef"].join("_");
const WHSEC = ["whsec", "fixture0123456789abcdef"].join("_");
const BODY = JSON.stringify({ composio: { apiKey: SECRET }, stripe: SK_LIVE, webhook: { secret: WHSEC }, salt: SECRET });

// Plain files under names no rule could tie to a key-bearing file, plus the copy forms the earlier
// rounds caught by name. Every one is left out the same way.
const STRAY_FILES = [
  "myconfig.json", "backup.tar", "config.json2", "credentials.bin2", "env2", "reconfig.json",
  "notes-2026.txt", // neutral name, key text inside
  "config.json.bak-20260918-openaicompat", "config.json.copy", "Copy of config.json", "env copy", "credentials.bin.copy",
  "webhooks.json - Copy", "about-me.md copy", "my-own-notes.txt", "bots.json~",
];
// A renamed providers folder, and another unknown folder.
const STRAY_FOLDERS: ReadonlyArray<[name: string, child: string]> = [["provider-keys", "credentials.json"], ["providers copy", "key.json"], ["client-work.old", "a.json"]];
const STRAY = [...STRAY_FILES, ...STRAY_FOLDERS.map(([name]) => name)];

function plant(data: string) {
  for (const name of STRAY_FILES) writeFileSync(join(data, name), name === "backup.tar" || name === "credentials.bin2" ? Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(BODY)]) : BODY);
  for (const [name, child] of STRAY_FOLDERS) { mkdirSync(join(data, name)); writeFileSync(join(data, name, child), BODY); }
}
const walk = (dir: string): string[] => readdirSync(dir).flatMap(entry => statSync(join(dir, entry)).isDirectory() ? walk(join(dir, entry)) : [join(dir, entry)]);
const holdsKey = (file: string) => { const bytes = readFileSync(file); return [SECRET, SK_LIVE, WHSEC].some(text => bytes.includes(text)); };

it("a name that is not an exact inventory row never reaches stored files, coverage or staged bytes; the backup completes and lists it truthfully", async () => {
  const f = backupFixture();
  try {
    plant(f.data);
    await withOfflineInstallation(f.data, async installation => {
      const stage = await stageInstallationStateWhileOwned(installation, f.parent);
      const inventory = await inventoryFidelity(installation, stage, selection);
      inventory.assertUnchanged();
      const stored = new Set([...stage.manifest.files.map(file => file.path.split("/")[0]), ...inventory.sources.map(file => file.path.split("/")[0])]);
      for (const name of STRAY) {
        expect(stored.has(name), name).toBe(false);
        const component = inventory.coverage.components.find(item => item.path === name);
        expect(component?.status, name).toBe("excluded");
        expect(component?.reason, name).toMatch(/^Not recognised by Murage, so the backup leaves it out/);
        expect(stage.manifest.skipped, name).toContainEqual({ path: name, reason: "unrecognised" });
      }
      expect(stage.manifest.skippedCount).toBe(STRAY.length);
      // no staged byte carries the key text, and nothing hashed for streaming points at a stray name
      for (const file of walk(stage.directory)) expect(holdsKey(file), file).toBe(false);
      for (const file of inventory.sources) expect(holdsKey(join(f.data, file.path)), file.path).toBe(false);
      // Murage's own records still back up
      expect(inventory.sources.find(file => file.path === "config.json")).toBeTruthy();
      expect(stage.manifest.files.map(file => file.path)).toContain("bots.json");
      // what the person reads: every item named, with the one true reason, and nothing more
      const lines = backupSkippedLines({ count: stage.manifest.skippedCount!, items: stage.manifest.skipped! });
      const text = lines.join(" ");
      for (const name of STRAY) expect(text, name).toContain(`${name} (not recognised by Murage, so the backup leaves it out; it stays where it is, so move it somewhere you keep your files if it matters)`);
      expect(lines[0]).toMatch(new RegExp(`^Skipped ${STRAY.length} items in Murage's data folder: `));
      expect(lines.at(-1)).toBe("Everything else was backed up.");
      expect(text).not.toMatch(/current file is backed up|[Kk]ept in the backup|—|\b(?:un)?safe(?:ty)?\b/);
    });
    for (const name of STRAY) expect(existsSync(join(f.data, name)), name).toBe(true); // never deleted or touched
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it.skipIf(!process.env.MURAGE_BACKUP_TEST_AGE_DIR)("an encrypted backup with stray names completes, and its restore never writes one back", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  try {
    plant(f.data);
    const archive = join(f.parent, "stray.age");
    const saved = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
    const listed = (saved as { skipped?: { items: Array<{ path: string; reason: string }> } }).skipped?.items ?? [];
    for (const name of STRAY) expect(listed, name).toContainEqual({ path: name, reason: "unrecognised" });
    const restored = join(f.parent, "restored");
    await restoreEncryptedInstallationNew(restored, archive, saved.sha256, keys);
    expect(existsSync(join(restored, "bots.json"))).toBe(true);
    for (const name of STRAY) expect(existsSync(join(restored, name)), name).toBe(false);
    for (const file of walk(restored)) expect(holdsKey(file), file).toBe(false);
  } finally { f.db.close(); removeTempDirSync(f.parent); }
}, 120_000);

it("classification: an unknown name of any shape is left out and listed; every exact row keeps its own handling", () => {
  for (const name of [...STRAY, "some-new-folder", "link-to-elsewhere"]) {
    expect(classifyDataDirEntry(name), name).toBeUndefined();
    expect(classifyDataDirEntryForBackup(name), name).toMatchObject({ backup: "excluded", skip: "unrecognised" });
    expect(classifyDataDirEntryForBackup(name).why, name).toMatch(/^Not recognised by Murage/);
  }
  for (const name of Object.keys(DATA_DIR_ENTRIES)) expect(classifyDataDirEntryForBackup(name), name).toBe(DATA_DIR_ENTRIES[name]);
  for (const item of DATA_DIR_PATTERNS) expect(classifyDataDirEntryForBackup(item.example), item.example).toBe(item.entry);
  // names Murage knows to refuse still stop the backup, as before
  expect(classifyDataDirEntryForBackup(".package-import-transaction")).toMatchObject({ backup: "refused" });
  expect(classifyDataDirEntryForBackup("env")).toMatchObject({ backup: "excluded" });
  expect(classifyDataDirEntryForBackup("config.json")).toMatchObject({ backup: "record" });
});

it("the skipped-item wording never says the current file is backed up and has one line per reason", () => {
  const text = backupSkippedLines({ count: 2, items: [{ path: "env copy", reason: "unrecognised" }, { path: "credentials.bin.copy", reason: "unrecognised" }] }).join(" ");
  expect(text).toMatch(/env copy \(not recognised by Murage, so the backup leaves it out/);
  expect(text).toMatch(/credentials\.bin\.copy \(not recognised by Murage, so the backup leaves it out/);
  expect(text).not.toMatch(/current file is backed up|older copy of a settings file/);
});

// 1.0.9 Sentinel: DATA_DIR/health holds rebuildable runtime metadata. A capture with it present completes, stores none of it,
// reports it as an intentional exclusion with its own reason, and never lists it among the unrecognised items.
it("a present health metadata root is left out intentionally: capture completes, nothing stored, not listed as unrecognised", async () => {
  const f = backupFixture();
  try {
    mkdirSync(join(f.data, "health"), { mode: 0o700 });
    for (const name of ["server.current.ndjson", "server.previous.ndjson", "desktop.current.ndjson", "backup-status.json", "db-stats-current.json", "db-stats-0001.sqlite", "backup-status.json.4242.tmp"]) writeFileSync(join(f.data, "health", name), "{}\n", { mode: 0o600 });
    await withOfflineInstallation(f.data, async installation => {
      const stage = await stageInstallationStateWhileOwned(installation, f.parent);
      const inventory = await inventoryFidelity(installation, stage, selection);
      inventory.assertUnchanged();
      const stored = [...stage.manifest.files.map(file => file.path), ...inventory.sources.map(file => file.path)];
      expect(stored.filter(path => path === "health" || path.startsWith("health/"))).toEqual([]);
      const component = inventory.coverage.components.find(item => item.path === "health");
      expect(component?.status).toBe("excluded");
      expect(component?.reason).toBe(DATA_DIR_ENTRIES.health!.why);
      expect((stage.manifest.skipped ?? []).map(item => item.path)).not.toContain("health");
      expect(inventory.sources.find(file => file.path === "config.json")).toBeTruthy();
    });
    expect(existsSync(join(f.data, "health", "backup-status.json"))).toBe(true); // never deleted or touched
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});
