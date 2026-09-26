// Closed-app backups from an AppImage (0.1.60 audit L-F1, L-F2).
//
// electron-builder's AppRun (the start script inside every AppImage) puts
// --no-sandbox FIRST on every launch where `unshare -Ur true` fails (Ubuntu
// 23.10+/24.04 default, apparmor_restrict_unprivileged_userns=1), unless an
// argument already is --no-sandbox. The closed-app job runs the AppImage file:
//   trigger:  ELECTRON_RUN_AS_NODE=1 <AppImage> <triggerEntry> --murage-backup-descriptor <file> --no-sandbox
//   capture:  <AppImage> --murage-backup-due --murage-backup-descriptor <file> --murage-data-dir … --murage-user-data …
// Electron-as-Node refuses an option before the script (exit 9, "bad option:
// --no-sandbox"), so the trigger carries it last; the capture accepts AppRun's
// leading one. These run the REAL AppRun text from app-builder-lib and the
// REAL Electron binary, with `unshare` answering as Ubuntu 24.04 does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { buildClosedBackupJob } from "./backup-closed-jobs.mjs";
import { CLOSED_DESCRIPTOR_FLAG, CLOSED_DUE_FLAG, closedInstallationIdentity, closedInvocation, parseClosedBackupArguments } from "./backup-closed-profile.mjs";

const require = createRequire(import.meta.url);
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pnpm = path.join(repo, "node_modules", ".pnpm");
const builderDir = existsSync(pnpm) ? readdirSync(pnpm).find(name => name.startsWith("app-builder-lib@")) : undefined;
const appRunScript = () => require(path.join(pnpm, builderDir, "node_modules", "app-builder-lib", "out", "targets", "appimage", "appImageUtil.js"))
  .generateAppRunScript({ ExecutableName: "murage", ProductName: "Murage", ProductFilename: "Murage" });
const electronBinary = process.platform === "darwin"
  ? path.join(repo, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
  : path.join(repo, "node_modules", "electron", "dist", "electron");
const REAL = process.platform === "win32" ? "POSIX AppRun" : !existsSync(electronBinary) ? "electron binary not present" : !builderDir ? "app-builder-lib not present" : false;

function appDirFixture(root, unshareExit) {
  // A stand-in AppDir: the real AppRun text, and BIN (`murage`) that records
  // what AppRun hands it and execs the real Electron binary with it.
  const appDir = path.join(root, ".mount_MurageTEST"), bin = path.join(root, "bin");
  mkdirSync(appDir); mkdirSync(bin);
  writeFileSync(path.join(appDir, "AppRun"), appRunScript(), { mode: 0o755 });
  writeFileSync(path.join(appDir, "murage"), `#!/bin/bash\nprintf '%s\\n' "$@" > "${root}/argv.txt"\nexec "${electronBinary}" "$@"\n`, { mode: 0o755 });
  // `unshare -Ur true` as Ubuntu 24.04 answers it (exit 1: uid_map write
  // refused), or as a system with unprivileged user namespaces does (exit 0).
  writeFileSync(path.join(bin, "unshare"), `#!/bin/sh\nexit ${unshareExit}\n`, { mode: 0o755 });
  return { appDir, PATH: `${bin}:/usr/bin:/bin` };
}

test("the closed-app trigger runs through the shipped AppRun whether or not unshare -Ur works", { skip: REAL }, t => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "closed-appimage-")));
  t.after(() => safeWipeSync(root));
  const descriptorPath = path.join(root, "descriptor.json");
  const triggerEntry = path.join(root, "trigger.mjs");
  // Stands in for the bundled trigger: prints what it was given.
  writeFileSync(triggerEntry, `process.stdout.write(JSON.stringify({type:"murage:closed-backup-trigger",argv:process.argv.slice(2)})+"\\n");\n`, { mode: 0o600 });
  const home = path.join(root, "home"); mkdirSync(home, { mode: 0o700 });
  const descriptor = { version: 1, platform: "linux", requestedRoot: path.join(home, ".murage"), userData: path.join(home, ".config", "Murage"), installation: path.join(home, ".murage"),
    installationIdentity: "a".repeat(64), owner: { uid: 1000 }, executable: path.join(home, "Murage-0.1.60-x86_64.AppImage"), triggerEntry, triggerSha256: "b".repeat(64) };
  // What the systemd unit really runs.
  const job = buildClosedBackupJob(descriptor, descriptorPath, { backupSupported: true });
  assert.match(job.files[0].text, /ExecStart=\S*Murage-0\.1\.60-x86_64\.AppImage \S+ --murage-backup-descriptor \S+ --no-sandbox\n/);
  assert.match(job.files[0].text, /Environment=ELECTRON_RUN_AS_NODE=1/);
  // The AppImage runtime's FUSE process is left to unmount and remove its
  // /tmp/.mount_* folder after the trigger exits (seen on the 24.04 VM).
  assert.match(job.files[0].text, /\nKillMode=process\n/);
  const trigger = closedInvocation(descriptor, descriptorPath, { mode: "trigger" });
  assert.deepEqual(trigger.args, [triggerEntry, CLOSED_DESCRIPTOR_FLAG, descriptorPath, "--no-sandbox"]);
  for (const [name, unshareExit] of [["userns allowed", 0], ["Ubuntu 24.04", 1]]) {
    const dir = path.join(root, `case-${unshareExit}`); mkdirSync(dir);
    const f = appDirFixture(dir, unshareExit);
    const r = spawnSync("/bin/bash", [path.join(f.appDir, "AppRun"), ...trigger.args], { env: { APPDIR: f.appDir, APPIMAGE: descriptor.executable, PATH: f.PATH, HOME: home, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
    // AppRun added nothing in front: the script is still the first argument.
    assert.equal(readFileSync(path.join(dir, "argv.txt"), "utf8").split("\n")[0], triggerEntry, name);
    assert.equal(r.status, 0, `${name}: trigger died: status ${r.status}, stderr ${r.stderr.trim()}`);
    const line = JSON.parse(r.stdout.trim().split("\n").at(-1));
    assert.deepEqual(line.argv, [CLOSED_DESCRIPTOR_FLAG, descriptorPath, "--no-sandbox"], name);
  }
});

test("the old trigger argv really dies under AppRun on Ubuntu 24.04 (why the flag goes last)", { skip: REAL }, t => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "closed-appimage-old-")));
  t.after(() => safeWipeSync(root));
  const triggerEntry = path.join(root, "trigger.mjs");
  writeFileSync(triggerEntry, `process.stdout.write("ran\\n");\n`, { mode: 0o600 });
  const f = appDirFixture(root, 1);
  const r = spawnSync("/bin/bash", [path.join(f.appDir, "AppRun"), triggerEntry, CLOSED_DESCRIPTOR_FLAG, "/x/descriptor.json"], { env: { APPDIR: f.appDir, APPIMAGE: "/x/Murage.AppImage", PATH: f.PATH, HOME: root, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
  assert.equal(readFileSync(path.join(root, "argv.txt"), "utf8").split("\n")[0], "--no-sandbox");
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /ran/);
});

test("the closed-app capture argv AppRun produces (--no-sandbox first) is accepted", () => {
  const descriptorPath = "/home/tester/.murage-backup-control/x/closed-y/descriptor.json";
  const capture = [CLOSED_DUE_FLAG, CLOSED_DESCRIPTOR_FLAG, descriptorPath, "--murage-data-dir", "/home/tester/.murage", "--murage-user-data", "/home/tester/.config/Murage"];
  const expected = { descriptorPath, requestedRoot: "/home/tester/.murage", userData: "/home/tester/.config/Murage" };
  assert.deepEqual(parseClosedBackupArguments(capture), expected);
  // main.mjs parses process.argv.slice(1); on Ubuntu 24.04 AppRun made it:
  assert.deepEqual(parseClosedBackupArguments(["--no-sandbox", ...capture]), expected);
});

test("an AppImage made executable under umask 002 (0775) is refused, and the status names the file", { skip: process.platform === "win32" }, async t => {
  const { assertClosedProfileBinding, closedProfileAppFileShared, closedTriggerDigest } = await import("./backup-closed-profile.mjs");
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "closed-appimage-mode-")));
  t.after(() => safeWipeSync(root));
  const data = path.join(root, "data"), user = path.join(root, "user"), exe = path.join(root, "Murage-0.1.60-x86_64.AppImage"), trig = path.join(root, "trigger.mjs");
  mkdirSync(data, { mode: 0o700 }); mkdirSync(user, { mode: 0o700 });
  // Browser download (0664 under umask 002), then `chmod +x` / Files "Allow executing" -> 0775.
  writeFileSync(exe, "synthetic"); chmodSync(exe, 0o775);
  writeFileSync(trig, "// synthetic", { mode: 0o600 });
  const d = { version: 1, platform: process.platform, requestedRoot: data, userData: user, installation: data, installationIdentity: closedInstallationIdentity(data), owner: { uid: process.getuid() }, executable: exe, triggerEntry: trig, triggerSha256: closedTriggerDigest(trig) };
  const resolveSelection = () => ({ dataDirectory: data, selected: false });
  // Group-writable stays refused: the job would run that file as this person.
  assert.throws(() => assertClosedProfileBinding(d, { resolveSelection }), /requires review/);
  // …and the status can say exactly which file and what to change.
  assert.equal(closedProfileAppFileShared(d), exe);
  chmodSync(exe, 0o755);
  assert.doesNotThrow(() => assertClosedProfileBinding(d, { resolveSelection }), "after chmod 755 the binding passes");
  assert.equal(closedProfileAppFileShared(d), null);
  chmodSync(exe, 0o757);
  assert.equal(closedProfileAppFileShared(d), exe, "other-writable too");
});
