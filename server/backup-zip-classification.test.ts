// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit K-02: Backup mode's "Save an older-style .zip recovery file"
// built its archive from the stage alone, which quietly left out any top-level
// name data-dir-inventory.ts did not know, and even names it refuses: owner
// files a new feature writes were silently missing, and with an interrupted
// bot import (.package-import-transaction) the .zip captured a bots.json the
// encrypted backup refuses as possibly mid-transaction. The classification
// gate now lives in the stage itself, so both kinds of backup refuse alike,
// and name the item.
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeInstallationArchive, writeInstallationStageArchive } from "./installation-archive.ts";
import { createHash } from "node:crypto";
import { withOfflineInstallation } from "./installation-database-snapshot.ts";
import { stageInstallationStateWhileOwned } from "./installation-state-snapshot.ts";
import { RESTORE_REVIEW_FILE } from "../electron/restore-review.mjs";
import { restoreInstallation } from "./installation-restore.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

it.each([
  ["an interrupted bot import", ".package-import-transaction", "BACKUP_UNCLASSIFIED_COMPONENT"],
  ["a local VM's workspace", "vm-home", "VM_WORKSPACE_BACKUP_UNSUPPORTED"],
])("the .zip recovery file refuses %s and names it", async (_label, name, code) => {
  const f = backupFixture();
  if (name === "vm-home") mkdirSync(join(f.data, name)); else writeFileSync(join(f.data, name), "{}");
  const out = join(f.parent, "out"); mkdirSync(out);
  try {
    const error = await writeInstallationArchive(f.data, join(out, "recovery.zip")).then(() => null, (caught: { code?: string; path?: string }) => caught);
    expect({ code: error?.code, path: error?.path }).toEqual({ code, path: name });
    expect(readdirSync(out)).toEqual([]);
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

// 1.0.4: a top-level name that is not an exact inventory row is left out of the .zip too
// (data-dir-inventory.ts, end of file), listed, and never comes back on restore.
it("the .zip recovery file leaves an unrecognised name out, lists it, and a restore never writes it", async () => {
  const f = backupFixture();
  writeFileSync(join(f.data, "a-new-feature.json"), "{}");
  mkdirSync(join(f.data, "a-new-feature")); writeFileSync(join(f.data, "a-new-feature", "a.json"), "{}");
  try {
    const saved = await writeInstallationArchive(f.data, join(f.parent, "recovery.zip"));
    expect(saved.manifest.files.some(file => file.path.split("/")[0].startsWith("a-new-feature"))).toBe(false);
    expect(saved.manifest.skipped).toEqual(expect.arrayContaining([{ path: "a-new-feature", reason: "unrecognised" }, { path: "a-new-feature.json", reason: "unrecognised" }]));
    const target = join(f.parent, "restored");
    await restoreInstallation(target, saved.path, saved.sha256, { requireNew: true });
    expect(existsSync(join(target, "a-new-feature.json"))).toBe(false);
    expect(existsSync(join(target, "a-new-feature"))).toBe(false);
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

// GrokBuild r3 High: an archive from an older or unshipped build may list a name that is not an
// exact inventory row (a key-bearing copy saved as myconfig.json). A restore never installs one.
// An unknown name, and rows a backup never holds (a kept login-shell env, provider keys, what a bot
// learned locally, a crash-left temp copy of config.json): none is installed.
const PLANTED = ["myconfig.json", "provider-keys/credentials.json", "env/owner-env.0123456789abcdef", "learning-local/b/l.json", "providers/k.json", "config.json.1.0f8e2b1a-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp"];
const TOP = [...new Set(PLANTED.map(path => path.split("/")[0]))];
it("a restore leaves out a stored name that is not an exact inventory row, lists it, and still completes", async () => {
  const f = backupFixture();
  const KEY = ["sk", "live", "crafted0123456789"].join("_");
  try {
    const archive = join(f.parent, "crafted.zip");
    const saved = await withOfflineInstallation(f.data, async installation => {
      const stage = await stageInstallationStateWhileOwned(installation, f.parent);
      const plant = (path: string) => {
        const body = Buffer.from(JSON.stringify({ composio: { apiKey: KEY } }));
        mkdirSync(join(stage.directory, "state", ...path.split("/").slice(0, -1)), { recursive: true });
        writeFileSync(join(stage.directory, "state", ...path.split("/")), body);
        stage.manifest.files.push({ path, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
      };
      for (const path of PLANTED) plant(path);
      return writeInstallationStageArchive(stage, archive);
    });
    expect(saved.manifest.files.map(file => file.path)).toEqual(expect.arrayContaining(PLANTED));
    const target = join(f.parent, "restored");
    await restoreInstallation(target, saved.path, saved.sha256, { requireNew: true });
    expect(existsSync(join(target, "bots.json"))).toBe(true);
    for (const name of TOP) expect(existsSync(join(target, name)), name).toBe(false);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
    for (const file of walk(target)) expect(readFileSync(file).includes(KEY), file).toBe(false);
    const review = JSON.parse(readFileSync(join(target, RESTORE_REVIEW_FILE), "utf8"));
    for (const name of TOP) expect(review.modifications, name).toContainEqual({ component: name, action: "Not something Murage restores, so the restore leaves it out" });
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it("the .zip recovery file keeps a bot's shortcuts and real names, and restores them", async () => {
  const f = backupFixture();
  const desk = join(f.data, "workspaces", "bot");
  mkdirSync(join(desk, "lib"), { recursive: true });
  writeFileSync(join(desk, "lib", "index.js"), "x\n");
  symlinkSync("lib/index.js", join(desk, "main.js"));
  // A colon cannot be in a Windows file name (a write there makes an alternate data stream).
  const colon = process.platform !== "win32";
  if (colon) writeFileSync(join(desk, "log 10:30.txt"), "timestamped\n");
  mkdirSync(join(desk, "node_modules", "dep"), { recursive: true }); writeFileSync(join(desk, "node_modules", "dep", "a.js"), "x");
  try {
    const saved = await writeInstallationArchive(f.data, join(f.parent, "recovery.zip"));
    expect(saved.manifest.skipped).toEqual([{ path: "workspaces/bot/node_modules", reason: "rebuildable" }]);
    const target = join(f.parent, "restored");
    await restoreInstallation(target, saved.path, saved.sha256, { requireNew: true });
    // Kept portable in the file ("/"), and native once restored (Windows reads it back with "\\").
    expect(saved.manifest.links).toContainEqual(expect.objectContaining({ path: "workspaces/bot/main.js", target: "lib/index.js" }));
    expect(readlinkSync(join(target, "workspaces", "bot", "main.js")).replaceAll("\\", "/")).toBe("lib/index.js");
    if (colon) expect(readFileSync(join(target, "workspaces", "bot", "log 10:30.txt"), "utf8")).toBe("timestamped\n");
    expect(existsSync(join(target, "workspaces", "bot", "node_modules"))).toBe(false);
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it("the .zip recovery file's list of left-out items names whose folder they were in", async () => {
  const { installationRecoveryCommand } = await import("./installation-recovery-command.ts");
  const f = backupFixture();
  mkdirSync(join(f.data, "workspaces", "bot", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(f.data, "workspaces", "bot", "node_modules", "dep", "a.js"), "x");
  try {
    const result = await installationRecoveryCommand(["backup", "--data-dir", f.data, "--output", join(f.parent, "recovery.zip")]);
    expect(result.skipped).toEqual({ count: 1, items: [{ path: "workspaces/bot/node_modules", reason: "rebuildable" }], bots: { bot: "Fixture" } });
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});
