// 0.1.60 Linux re-test 2 D9: the AppImage on Ubuntu 24.04 could never back up.
// Every backup restarts Murage, and app.relaunch() re-executes a binary inside
// the AppImage's temporary mount, which is gone once the old process exits.
// The restart now goes through the AppImage file itself.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { appImageRelaunchEnv, relaunchBlockedCode, relaunchDesktop, runningAppImage } from "./desktop-relaunch.mjs";

const MOUNT = "/tmp/.mount_MuragemkCion";
const APPIMAGE = "/home/tester/Murage-0.1.60-x86_64.AppImage";
const appImageEnv = { APPIMAGE, APPDIR: MOUNT, ARGV0: "./Murage-0.1.60-x86_64.AppImage", OWD: "/home/tester",
  PATH: `${MOUNT}:${MOUNT}/usr/sbin:/usr/local/bin:/usr/bin`, LD_LIBRARY_PATH: `${MOUNT}/usr/lib`,
  XDG_DATA_DIRS: `${MOUNT}/usr/share/:/usr/share/gnome:/usr/local/share/:/usr/share/`, GSETTINGS_SCHEMA_DIR: `${MOUNT}/usr/share/glib-2.0/schemas`,
  MURAGE_DATA_DIR: "/home/tester/rt2/ai/data", HOME: "/home/tester" };

test("an AppImage is recognised only when the running binary is inside its own mount", () => {
  assert.equal(runningAppImage({ platform: "linux", env: appImageEnv, execPath: `${MOUNT}/murage` }), APPIMAGE);
  // APPIMAGE is inherited by anything an AppImage starts; a .deb Murage
  // launched from one is not an AppImage.
  assert.equal(runningAppImage({ platform: "linux", env: appImageEnv, execPath: "/opt/Murage/murage" }), null);
  assert.equal(runningAppImage({ platform: "linux", env: { APPIMAGE }, execPath: `${MOUNT}/murage` }), null);
  assert.equal(runningAppImage({ platform: "linux", env: { ...appImageEnv, APPIMAGE: "Murage.AppImage" }, execPath: `${MOUNT}/murage` }), null);
  assert.equal(runningAppImage({ platform: "linux", env: {}, execPath: "/opt/Murage/murage" }), null);
  for (const platform of ["darwin", "win32"]) assert.equal(runningAppImage({ platform, env: appImageEnv, execPath: `${MOUNT}/murage` }), null);
});

test("on Ubuntu 24.04 (user namespaces restricted, no AppArmor profile) an AppImage is not blocked; a moved AppImage is, in its own words", () => {
  const ubuntu2404 = file => ({ "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n", "/proc/self/attr/apparmor/current": "unconfined\n" })[file] ?? (() => { throw Error("absent"); })();
  const present = { stat: () => ({ isFile: () => true }), access: () => {} };
  const gone = { stat: () => { throw Object.assign(Error("ENOENT"), { code: "ENOENT" }); }, access: () => {} };
  const common = { platform: "linux", read: ubuntu2404 };
  // The same system that blocked it before this fix.
  assert.equal(relaunchBlockedCode({ ...common, env: {}, execPath: "/opt/Murage/murage" }), "BACKUP_RELAUNCH_BLOCKED");
  assert.equal(relaunchBlockedCode({ ...common, env: appImageEnv, execPath: `${MOUNT}/murage`, ...present }), null);
  assert.equal(relaunchBlockedCode({ ...common, env: appImageEnv, execPath: `${MOUNT}/murage`, ...gone }), "BACKUP_RELAUNCH_APPIMAGE_MISSING");
  assert.equal(relaunchBlockedCode({ ...common, env: appImageEnv, execPath: `${MOUNT}/murage`, stat: () => ({ isFile: () => true }), access: () => { throw Error("EACCES"); } }), "BACKUP_RELAUNCH_APPIMAGE_MISSING");
  // .deb under its own profile still restarts through Electron.
  assert.equal(relaunchBlockedCode({ platform: "linux", env: {}, execPath: "/opt/Murage/murage", read: file => file.endsWith("apparmor/current") ? "murage (unconfined)\n" : "1\n" }), null);
});

test("the restarted AppImage gets this environment minus what the old mount added", () => {
  const env = appImageRelaunchEnv(appImageEnv, MOUNT);
  for (const name of ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "LD_LIBRARY_PATH", "GSETTINGS_SCHEMA_DIR"]) assert.equal(env[name], undefined, name);
  assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(env.XDG_DATA_DIRS, "/usr/share/gnome:/usr/local/share/:/usr/share/");
  assert.equal(env.MURAGE_DATA_DIR, "/home/tester/rt2/ai/data");
  // A similarly named folder is not the mount.
  assert.equal(appImageRelaunchEnv({ PATH: `${MOUNT}x/bin:/usr/bin` }, MOUNT).PATH, `${MOUNT}x/bin:/usr/bin`);
});

test("outside an AppImage the restart is Electron's own", () => {
  const calls = [];
  const how = relaunchDesktop({ app: { relaunch: options => calls.push(options) }, args: ["--murage-backup-mode"], platform: "linux", env: {}, execPath: "/opt/Murage/murage", spawn: () => assert.fail("no spawn") });
  assert.equal(how, "electron");
  assert.deepEqual(calls, [{ args: ["--murage-backup-mode"] }]);
});

const waitFor = async (check, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 50)); }
  return false;
};

test("a real AppImage-style restart: the file itself runs only after the old process exits, with the same arguments, outside the mount", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "murage-appimage-relaunch-")));
  try {
    const mount = path.join(root, ".mount_Murage"), home = path.join(root, "home"), out = path.join(root, "relaunched.json");
    mkdirSync(mount); mkdirSync(home);
    // Stands in for the AppImage file: records how it was started.
    const appImage = path.join(root, "Murage.AppImage");
    writeFileSync(appImage, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$APPDIR" "$LD_LIBRARY_PATH" "$MURAGE_DATA_DIR" "$@" > "${out}.tmp" && mv "${out}.tmp" "${out}"\n`);
    chmodSync(appImage, 0o755);
    // Stands in for the old Murage: alive until told to exit.
    const old = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
    await new Promise(resolve => old.once("spawn", resolve));
    const env = { ...process.env, APPIMAGE: appImage, APPDIR: mount, OWD: home, LD_LIBRARY_PATH: `${mount}/usr/lib`, MURAGE_DATA_DIR: "/data/for/this/copy" };
    const how = relaunchDesktop({ app: { relaunch: () => assert.fail("not Electron's relaunch") }, args: ["--no-sandbox", "--murage-backup-mode", "two words"],
      platform: "linux", env, execPath: path.join(mount, "murage"), pid: old.pid, cwd: mount });
    assert.equal(how, "appimage");
    // Nothing starts while the old process is alive: two copies would fight
    // over the single-instance lock and the data folder.
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(existsSync(out), false, "started before the old process exited");
    old.kill("SIGTERM");
    assert.equal(await waitFor(() => existsSync(out)), true, "the AppImage was never started");
    const [cwd, appDir, libraryPath, dataDir, ...args] = readFileSync(out, "utf8").trimEnd().split("\n");
    assert.equal(cwd, home, "starts where the person started the first copy, never inside the old mount");
    assert.equal(appDir, "");
    assert.equal(libraryPath, "");
    assert.equal(dataDir, "/data/for/this/copy");
    assert.deepEqual(args, ["--no-sandbox", "--murage-backup-mode", "two words"]);
  } finally { safeWipeSync(root); }
});
