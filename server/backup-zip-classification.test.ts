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
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeInstallationArchive } from "./installation-archive.ts";
import { restoreInstallation } from "./installation-restore.ts";
import { backupFixture } from "./testing/backup-fixture.ts";

it.each([
  ["an unknown top-level name", "a-new-feature.json", "BACKUP_UNCLASSIFIED_COMPONENT"],
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
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
});

it("the .zip recovery file keeps a bot's shortcuts and real names, and restores them", async () => {
  const f = backupFixture();
  const desk = join(f.data, "workspaces", "bot");
  mkdirSync(join(desk, "lib"), { recursive: true });
  writeFileSync(join(desk, "lib", "index.js"), "x\n");
  symlinkSync("lib/index.js", join(desk, "main.js"));
  writeFileSync(join(desk, "log 10:30.txt"), "timestamped\n");
  mkdirSync(join(desk, "node_modules", "dep"), { recursive: true }); writeFileSync(join(desk, "node_modules", "dep", "a.js"), "x");
  try {
    const saved = await writeInstallationArchive(f.data, join(f.parent, "recovery.zip"));
    expect(saved.manifest.skipped).toEqual([{ path: "workspaces/bot/node_modules", reason: "rebuildable" }]);
    const target = join(f.parent, "restored");
    await restoreInstallation(target, saved.path, saved.sha256, { requireNew: true });
    expect(readlinkSync(join(target, "workspaces", "bot", "main.js"))).toBe("lib/index.js");
    expect(readFileSync(join(target, "workspaces", "bot", "log 10:30.txt"), "utf8")).toBe("timestamped\n");
    expect(existsSync(join(target, "workspaces", "bot", "node_modules"))).toBe(false);
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
});

it("the .zip recovery file's list of left-out items names whose folder they were in", async () => {
  const { installationRecoveryCommand } = await import("./installation-recovery-command.ts");
  const f = backupFixture();
  mkdirSync(join(f.data, "workspaces", "bot", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(f.data, "workspaces", "bot", "node_modules", "dep", "a.js"), "x");
  try {
    const result = await installationRecoveryCommand(["backup", "--data-dir", f.data, "--output", join(f.parent, "recovery.zip")]);
    expect(result.skipped).toEqual({ count: 1, items: [{ path: "workspaces/bot/node_modules", reason: "rebuildable" }], bots: { bot: "Fixture" } });
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
});
