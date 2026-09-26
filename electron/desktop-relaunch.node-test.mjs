// 0.1.60 Linux re-test 2 D9: the AppImage on Ubuntu 24.04 could never back up.
// Every backup restarts Murage, and app.relaunch() re-executes a binary inside
// the AppImage's temporary mount, which is gone once the old process exits.
// The restart now goes through the AppImage file itself.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { APPIMAGE_RELAUNCH_SCRIPT, appImageRelaunchEnv, relaunchBlockedCode, relaunchDesktop, runningAppImage } from "./desktop-relaunch.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
  // AppRun's fixed tail goes too: the session had no XDG_DATA_DIRS.
  assert.equal(env.XDG_DATA_DIRS, undefined);
  assert.equal(env.MURAGE_DATA_DIR, "/home/tester/rt2/ai/data");
  // A similarly named folder is not the mount.
  assert.equal(appImageRelaunchEnv({ PATH: `${MOUNT}x/bin:/usr/bin` }, MOUNT).PATH, `${MOUNT}x/bin:/usr/bin`);
});

// 0.1.60 audit L-F4: XDG_DATA_DIRS grew by AppRun's three-entry tail on
// every restart. The export below is the exact line the shipped AppRun runs.
test("XDG_DATA_DIRS does not grow with AppImage restarts", { skip: process.platform === "win32" || !existsSync(path.join(repo, "node_modules", ".pnpm")) }, () => {
  const pnpm = path.join(repo, "node_modules", ".pnpm");
  const require = createRequire(import.meta.url);
  const { generateAppRunScript } = require(path.join(pnpm, readdirSync(pnpm).find(n => n.startsWith("app-builder-lib@")), "node_modules", "app-builder-lib", "out", "targets", "appimage", "appImageUtil.js"));
  const line = generateAppRunScript({ ExecutableName: "murage", ProductName: "Murage", ProductFilename: "Murage" }).split("\n").find(l => l.startsWith("export XDG_DATA_DIRS="));
  const appRunXdg = (env, appDir) => spawnSync("/bin/bash", ["-c", `${line}; printf %s "$XDG_DATA_DIRS"`], { env: { APPDIR: appDir, ...(env.XDG_DATA_DIRS ? { XDG_DATA_DIRS: env.XDG_DATA_DIRS } : {}) }, encoding: "utf8" }).stdout;
  for (const session of ["/usr/share/ubuntu:/usr/local/share/:/usr/share/:/var/lib/snapd/desktop", undefined]) {
    let env = session ? { XDG_DATA_DIRS: session } : {};
    const seen = [];
    for (let restart = 0; restart < 10; restart++) {
      const appDir = `/tmp/.mount_Murage${restart}`;
      env = { XDG_DATA_DIRS: appRunXdg(env, appDir) };   // AppRun on this start
      env = appImageRelaunchEnv(env, appDir);             // desktop-relaunch.mjs on the next restart
      seen.push(env.XDG_DATA_DIRS);
    }
    // Every restart hands on exactly what the session started with.
    assert.deepEqual(new Set(seen), new Set([session]), `XDG_DATA_DIRS per restart: ${seen.join(" | ")}`);
  }
  // A value AppRun did not make is left alone, tail and all.
  assert.equal(appImageRelaunchEnv({ XDG_DATA_DIRS: "/opt/x:/usr/share/gnome:/usr/local/share/:/usr/share/" }, MOUNT).XDG_DATA_DIRS, "/opt/x:/usr/share/gnome:/usr/local/share/:/usr/share/");
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

// Seen on Ubuntu 24.04 with a real AppImage: Chromium's .pak and ICU files are
// open without close-on-exec, the restarted copy inherited them, and every
// restart left the old mount and its AppImage runtime behind.
test("the restart helper hands the AppImage no inherited descriptors (Linux)", { skip: process.platform !== "linux" }, async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "murage-appimage-fds-")));
  try {
    const out = path.join(root, "fds.txt"), held = path.join(root, "held.pak");
    writeFileSync(held, "x");
    const appImage = path.join(root, "Murage.AppImage");
    writeFileSync(appImage, `#!/bin/sh\nls /proc/$$/fd > "${out}.tmp"; readlink /proc/$$/fd/* >> "${out}.tmp"; mv "${out}.tmp" "${out}"\n`);
    chmodSync(appImage, 0o755);
    // Open two descriptors without close-on-exec, the way Chromium holds its
    // resource files, then become the helper exactly as relaunchDesktop runs it.
    const helper = spawn("bash", ["-c", `exec 15<"${held}" 200<"${held}"; exec bash -c "$0" murage-relaunch 999999999 "${appImage}"`, APPIMAGE_RELAUNCH_SCRIPT], { stdio: "ignore" });
    await new Promise(resolve => helper.once("exit", resolve));
    assert.equal(await waitFor(() => existsSync(out)), true, "the AppImage was never started");
    const listing = readFileSync(out, "utf8");
    assert.equal(listing.includes(held), false, `inherited descriptor reached the AppImage:\n${listing}`);
  } finally { safeWipeSync(root); }
});
