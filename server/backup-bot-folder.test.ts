// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit A-01: a bot's ordinary work in its own folder must never stop
// a backup. Bots run commands in DATA_DIR/workspaces/<bot>/threads/<thread>;
// `npm install`, `python3 -m venv`, `pnpm install`, `git clone --local` and
// timestamped file names are routine there. Each used to pause every backup
// (UNSAFE_SNAPSHOT_ENTRY, NONPORTABLE_SNAPSHOT_PATH,
// BACKUP_SELECTED_COMPONENT_UNAVAILABLE, SNAPSHOT_LIMIT_EXCEEDED).
//
// Policy, backup AND restore:
//  - shortcuts (symlinks) stored as shortcuts, never followed, restored as shortcuts;
//  - a file with several names (hard links) stored once, each extra name restored as a copy;
//  - names another system can't hold stored under a safe spelling, restored under the real name;
//  - rebuildable folders (node_modules, virtual environments, caches) left out and listed;
//  - items past the file limit, or unreadable, left out and listed; the backup completes.
import { denyFixtureRead } from "./testing/platform-fixtures.ts";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, toNamespacedPath } from "node:path";
import { expect, it } from "vitest";
import { withOfflineInstallation } from "./installation-database-snapshot.ts";
import { stageInstallationStateWhileOwned } from "./installation-state-snapshot.ts";
import { inventoryFidelity } from "./installation-fidelity-snapshot.ts";
import { writeEncryptedInstallationBackup, restoreEncryptedInstallationNew } from "./installation-encrypted-backup.ts";
import { reviewInstallation } from "./installation-activation.ts";
import { validateInstallationArchiveManifest } from "./installation-archive.ts";
import { backupFixture, testAgeKeys, optionalBackupAgeUnavailable } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const has = (tool: string, args: string[] = ["--version"]) => spawnSync(tool, args, { windowsHide: true, stdio: "ignore" }).status === 0;
const deskOf = (data: string) => join(data, "workspaces", "bot", "threads", "thread");

async function stageAndInventory(data: string, parent: string, options: { maxFiles?: number } = {}) {
  return withOfflineInstallation(data, async installation => {
    const stage = await stageInstallationStateWhileOwned(installation, parent, options);
    try {
      await inventoryFidelity(installation, stage, selection, options);
      // The same check every archive's contents list gets when it is written.
      validateInstallationArchiveManifest({ ...stage.manifest, format: "murage.installation" }, options);
      return stage.manifest;
    }
    finally { removeTempDirSync(stage.directory); }
  });
}

const artefacts: Record<string, (desk: string) => void> = {
  "npm install (node_modules/.bin link)": desk => {
    mkdirSync(join(desk, "site", "node_modules", "typescript", "bin"), { recursive: true });
    writeFileSync(join(desk, "site", "node_modules", "typescript", "bin", "tsc"), "#!/usr/bin/env node\n");
    mkdirSync(join(desk, "site", "node_modules", ".bin"), { recursive: true });
    symlinkSync("../typescript/bin/tsc", join(desk, "site", "node_modules", ".bin", "tsc"));
  },
  "python3 -m venv (bin/python link)": desk => {
    mkdirSync(join(desk, ".venv", "bin"), { recursive: true });
    symlinkSync("/usr/bin/python3", join(desk, ".venv", "bin", "python"));
  },
  "pnpm install / git clone --local (hard link)": desk => {
    writeFileSync(join(desk, "store-file.js"), "module.exports = 1;\n");
    linkSync(join(desk, "store-file.js"), join(desk, "linked-file.js"));
  },
  "report with a time in its name (colon)": desk => { writeFileSync(join(desk, "report 2026-09-26 10:30.md"), "# Report\n"); },
  "shortcut to a file outside the data folder": desk => { symlinkSync("/etc/hosts", join(desk, "hosts-link")); },
  "Windows device name and trailing dot": desk => { writeFileSync(toNamespacedPath(join(desk, "aux.txt")), "a"); writeFileSync(toNamespacedPath(join(desk, "notes.")), "n"); },
  "an empty folder with a colon in its name": desk => { mkdirSync(join(desk, "run 10:30")); mkdirSync(join(desk, "run 11:00", "empty"), { recursive: true }); },
  "a socket or pipe left by a tool": desk => { execFileSync("mkfifo", [join(desk, "tool.pipe")], { windowsHide: true }); },
};

// A colon cannot be in a Windows file name: mkdir refuses it, and a file
// write makes an alternate data stream on "report 2026-09-26 10" instead.
// POSIX filesystem FIFOs have no Windows directory entry equivalent; Windows
// named pipes live in the pipe namespace. These exact POSIX filename/kernel
// rows stay on POSIX. Reserved names and trailing dots use native namespaced
// paths above and run on Windows too.
const posixEntries = new Set(["report with a time in its name (colon)", "an empty folder with a colon in its name", "a socket or pipe left by a tool"]);

for (const [name, make] of Object.entries(artefacts)) {
  it.skipIf(process.platform === "win32" && posixEntries.has(name))(`backs up a bot folder after: ${name}`, async () => {
    const f = backupFixture();
    const desk = deskOf(f.data);
    mkdirSync(desk, { recursive: true });
    make(desk);
    try { await stageAndInventory(f.data, f.parent); }
    finally { f.db.close(); removeTempDirSync(f.parent); }
  });
}

it.runIf(process.platform === "win32")("backs up native Windows names and empty folders without losing file bytes", async () => {
  const f = backupFixture(), desk = deskOf(f.data);
  mkdirSync(join(desk, "run 10-30", "empty"), { recursive: true });
  writeFileSync(join(desk, "report 2026-09-26 10-30.md"), "# Report\n");
  writeFileSync(join(desk, "aux-report.txt"), "native Windows fixture");
  try {
    const manifest = await stageAndInventory(f.data, f.parent);
    expect(manifest.files.map(file => file.path)).toEqual(expect.arrayContaining([
      "workspaces/bot/threads/thread/report 2026-09-26 10-30.md", "workspaces/bot/threads/thread/aux-report.txt",
    ]));
    expect(manifest.files.find(file => file.path.endsWith("/report 2026-09-26 10-30.md"))?.sha256).toBe(createHash("sha256").update("# Report\n").digest("hex"));
    expect(manifest.skipped ?? []).toEqual([]);
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it("leaves rebuildable folders out and lists them; keeps real work", async () => {
  const f = backupFixture();
  const desk = deskOf(f.data);
  for (const folder of ["site/node_modules/left-pad", ".venv/lib", "src/__pycache__", "app/.next/cache", "crate/target/debug"]) mkdirSync(join(desk, folder), { recursive: true });
  writeFileSync(join(desk, "site", "node_modules", "left-pad", "index.js"), "x");
  writeFileSync(join(desk, "crate", "target", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
  mkdirSync(join(desk, "env-by-another-name"), { recursive: true }); writeFileSync(join(desk, "env-by-another-name", "pyvenv.cfg"), "home = /usr/bin\n");
  writeFileSync(join(desk, "src", "main.py"), "print(1)\n");
  try {
    const manifest = await stageAndInventory(f.data, f.parent);
    const skipped = (manifest.skipped ?? []).filter(item => item.reason === "rebuildable").map(item => item.path.replace("workspaces/bot/threads/thread/", "")).sort();
    expect(skipped).toEqual([".venv", "app/.next", "crate/target", "env-by-another-name", "site/node_modules", "src/__pycache__"]);
    expect(manifest.files.map(file => file.path)).toContain("workspaces/bot/threads/thread/src/main.py");
    expect(manifest.files.some(file => file.path.includes("node_modules"))).toBe(false);
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it("past the file limit, items in owner folders are left out and listed; the backup completes", async () => {
  const f = backupFixture();
  const desk = join(deskOf(f.data), "photos");
  mkdirSync(desk, { recursive: true });
  for (let index = 0; index < 40; index++) writeFileSync(join(desk, `p${String(index).padStart(2, "0")}.jpg`), String(index));
  try {
    const manifest = await stageAndInventory(f.data, f.parent, { maxFiles: 25 });
    expect(manifest.files.length + (manifest.links?.length ?? 0) + (manifest.copies?.length ?? 0)).toBeLessThanOrEqual(25);
    expect(manifest.skippedCount).toBeGreaterThan(15);
    expect(manifest.skipped?.every(item => item.reason === "file-limit")).toBe(true);
    // Murage's own records are never the ones left out.
    for (const record of ["bots.json", "config.json", "groups.json", "messages.db"]) expect(manifest.files.map(file => file.path)).toContain(record);
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it.skipIf(process.getuid?.() === 0)("an unreadable file in a bot's folder is left out and listed, not a failure", async () => {
  const f = backupFixture();
  const desk = deskOf(f.data);
  mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, "locked.txt"), "secret"); const restoreRead = denyFixtureRead(join(desk, "locked.txt"));
  try {
    const manifest = await stageAndInventory(f.data, f.parent);
    expect(manifest.skipped).toContainEqual({ path: "workspaces/bot/threads/thread/locked.txt", reason: "unreadable" });
  } finally { restoreRead(); f.db.close(); removeTempDirSync(f.parent); }
});

// NTFS forbids control characters in filenames; the ordinary-name ACL row above covers Windows unreadability.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable file whose name holds a line break is listed printably", async () => {
  const f = backupFixture();
  const desk = deskOf(f.data);
  mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, "odd\nname.txt"), "x"); chmodSync(join(desk, "odd\nname.txt"), 0o000);
  try {
    const manifest = await stageAndInventory(f.data, f.parent);
    expect(manifest.skipped).toContainEqual({ path: "workspaces/bot/threads/thread/odd?name.txt", reason: "unreadable" });
  } finally { chmodSync(join(desk, "odd\nname.txt"), 0o600); f.db.close(); removeTempDirSync(f.parent); }
});

it("a refusal about Murage's own records names the file", async () => {
  const f = backupFixture();
  writeFileSync(join(f.data, "routines.json"), "{not json");
  try {
    const error = await stageAndInventory(f.data, f.parent).then(() => null, (caught: { code?: string; path?: string }) => caught);
    expect({ code: error?.code, path: error?.path }).toEqual({ code: "INVALID_JSON_COMPONENT", path: "routines.json" });
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

// The real thing: tools a bot runs, then Back up now, restore into a new
// folder, the restored copy passes review, and it backs up again.
it.skipIf(optionalBackupAgeUnavailable())("round trip: a used bot folder backs up, restores with links, copies and real names, and backs up again", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  const desk = deskOf(f.data);
  mkdirSync(join(desk, "site", "lib"), { recursive: true });
  writeFileSync(join(desk, "site", "lib", "index.js"), "module.exports = 42;\n");
  writeFileSync(join(desk, "site", "package.json"), JSON.stringify({ name: "site", version: "1.0.0" }));
  // A shortcut the bot made, relative and inside its folder.
  symlinkSync("lib/index.js", join(desk, "site", "main.js"));
  symlinkSync("lib", join(desk, "site", "lib-dir"));
  // A shortcut pointing outside the data folder is stored, not followed.
  symlinkSync("/etc/hosts", join(desk, "hosts-link"));
  // Two names, one file.
  mkdirSync(join(desk, "store"));
  writeFileSync(join(desk, "store", "a.js"), "shared contents\n");
  linkSync(join(desk, "store", "a.js"), join(desk, "store", "b.js"));
  // Names another system can't hold.
  writeFileSync(join(desk, "report 2026-09-26 10:30.md"), "# Report\n");
  mkdirSync(join(desk, "run 10:30"));
  writeFileSync(join(desk, "run 10:30", "out.txt"), "inside a renamed folder\n");
  writeFileSync(join(desk, "aux.txt"), "device name\n");
  // Rebuildable, left out.
  mkdirSync(join(desk, "site", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(desk, "site", "node_modules", "dep", "index.js"), "x");
  // Real tools where this computer has them.
  if (has("python3")) execFileSync("python3", ["-m", "venv", "--without-pip", join(desk, "pyenv")], { windowsHide: true, stdio: "ignore" });
  if (has("git")) {
    execFileSync("git", ["init", "-q", join(desk, "origin")], { windowsHide: true, stdio: "ignore" });
    writeFileSync(join(desk, "origin", "README.md"), "hello\n");
    execFileSync("git", ["-C", join(desk, "origin"), "add", "."], { windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["-C", join(desk, "origin"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], { windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["clone", "-q", "--local", join(desk, "origin"), join(desk, "clone")], { windowsHide: true, stdio: "ignore" });
  }
  try {
    const first = join(f.parent, "first.age");
    const saved = await writeEncryptedInstallationBackup(f.data, first, { ...keys, selection });
    const listed = (saved as { skipped?: { items: Array<{ path: string; reason: string }> } }).skipped?.items.map(item => item.path) ?? [];
    expect(listed).toContain("workspaces/bot/threads/thread/site/node_modules");
    if (has("python3")) expect(listed).toContain("workspaces/bot/threads/thread/pyenv");
    const restored = join(f.parent, "restored");
    await restoreEncryptedInstallationNew(restored, first, saved.sha256, keys);
    const back = deskOf(restored);
    expect(readlinkSync(join(back, "site", "main.js"))).toBe("lib/index.js");
    expect(readFileSync(join(back, "site", "main.js"), "utf8")).toBe("module.exports = 42;\n");
    expect(readlinkSync(join(back, "site", "lib-dir"))).toBe("lib");
    // A shortcut leading out of the data folder is not re-created (Kimi audit #2).
    expect(() => readlinkSync(join(back, "hosts-link"))).toThrow();
    expect(readFileSync(join(back, "store", "b.js"), "utf8")).toBe("shared contents\n");
    expect(lstatSync(join(back, "store", "b.js")).nlink).toBe(1);
    expect(readFileSync(join(back, "report 2026-09-26 10:30.md"), "utf8")).toBe("# Report\n");
    expect(readFileSync(join(back, "run 10:30", "out.txt"), "utf8")).toBe("inside a renamed folder\n");
    expect(readFileSync(join(back, "aux.txt"), "utf8")).toBe("device name\n");
    expect(existsSync(join(back, "site", "node_modules"))).toBe(false);
    if (has("git")) {
      expect(execFileSync("git", ["-C", join(back, "clone"), "log", "--format=%s"], { windowsHide: true, encoding: "utf8" }).trim()).toBe("one");
      expect(statSync(join(back, "clone", "README.md")).isFile()).toBe(true);
    }
    // The restored copy passes review, and backs up again.
    expect(reviewInstallation(restored).status).toBe("ready-for-review");
    await writeEncryptedInstallationBackup(restored, join(f.parent, "second.age"), { ...keys, selection });
    expect(readdirSync(f.parent)).toContain("second.age");
  } finally { f.db.close(); removeTempDirSync(f.parent); }
}, 120_000);

// 0.1.60 audit W-A2: the stage holds only Murage's projected records and the
// database; owner files are hashed and later streamed from where they are,
// so a backup folder on a USB stick needs room only for the encrypted file.
it("the stage copies no owner file, and refuses one that changed after it was hashed", async () => {
  const f = backupFixture();
  const desk = deskOf(f.data);
  mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, "notes.md"), "first\n");
  try {
    await withOfflineInstallation(f.data, async installation => {
      const stage = await stageInstallationStateWhileOwned(installation, f.parent);
      try {
        const staged = readdirSync(join(stage.directory, "state")).sort();
        expect(staged).toEqual(["bots.json", "config.json", "groups.json", "messages.db"]);
        const stored = "workspaces/bot/threads/thread/notes.md";
        stage.openFile(stored).destroy();
        writeFileSync(join(desk, "notes.md"), "changed after hashing\n");
        expect(() => stage.openFile(stored)).toThrow(expect.objectContaining({ code: "SOURCE_CHANGED", path: "workspaces/bot/threads/thread/notes.md" }));
      } finally { removeTempDirSync(stage.directory); }
    });
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});
