import { withHideInherit } from "../shared/win-hide-child-process.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { linuxRelaunchBlocked } from "./linux-relaunch.mjs";

/** Restarting Murage from an AppImage.
 *
 * An AppImage runs from a temporary mount (/tmp/.mount_XXXX) that exists only
 * while the first process lives. Electron's app.relaunch() re-executes
 * process.execPath, which is inside that mount, after the old process has
 * exited: by then the mount is gone and nothing comes back. On Ubuntu 24.04 it
 * is worse still: app.relaunch() starts the new process with no_new_privs, so
 * the AppImage's own FUSE mount helper (setuid fusermount3) cannot run either.
 *
 * So an AppImage restarts the way a person starts it: from the AppImage file
 * itself (process.env.APPIMAGE), through a small detached shell that drops the
 * descriptors it inherited, waits for this process to exit and then runs the
 * file. Node's spawn sets no
 * no_new_privs, the AppImage mounts itself afresh, and its AppRun decides the
 * Chromium sandbox again exactly as on a first launch (it adds --no-sandbox
 * where user namespaces are restricted, the Ubuntu 24.04 default). */

// How long the helper waits for this process to exit before giving up. A quit
// that never finishes means Murage is still open; starting a second copy then
// would only be refused by the single-instance lock.
const WAIT_TICKS = 3000; // 3000 × 0.2 s = 10 minutes
// First it closes every inherited descriptor but stdio. Chromium keeps its
// .pak and ICU files open without close-on-exec so its own children can
// share them, and Node's spawn passes them on: the new copy then held files
// in the old mount, so each restart left a mount and its AppImage runtime
// behind (seen on Ubuntu 24.04). bash, because `exec {n}>&-` closes any
// descriptor number and dash cannot; the AppImage's own AppRun needs bash, so
// it is there wherever an AppImage runs.
export const APPIMAGE_RELAUNCH_SCRIPT =
  `if [ -d /proc/$$/fd ]; then for fd in /proc/$$/fd/*; do n=\${fd##*/}; case "$n" in 0|1|2) ;; *) exec {n}>&- ;; esac; done; fi; ` +
  `i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ "$i" -gt ${WAIT_TICKS} ] && exit 0; sleep 0.2; done; shift; exec "$@"`;

/** The AppImage file this process was started from, or null when Murage is not
 * running as an AppImage. APPIMAGE alone is not trusted: it is inherited by
 * anything an AppImage starts, so the running executable must also sit inside
 * the AppImage's own mount (APPDIR). */
export function runningAppImage({ platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (platform !== "linux") return null;
  const file = env.APPIMAGE, dir = env.APPDIR;
  if (typeof file !== "string" || !path.isAbsolute(file) || typeof dir !== "string" || !path.isAbsolute(dir)) return null;
  const relative = path.relative(dir, execPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return file;
}

/** Whether the AppImage file can still be started: still there, a regular
 * file, and executable by this user. It can be moved or deleted while Murage
 * is open, and then nothing can reopen Murage. */
export function appImageLaunchable(file, { access = fs.accessSync, stat = fs.statSync } = {}) {
  try { if (!stat(file).isFile()) return false; access(file, fs.constants.X_OK); return true; } catch { return false; }
}

/** Why a restart cannot work here, as a backup refusal code, or null.
 * - BACKUP_RELAUNCH_APPIMAGE_MISSING: the AppImage file was moved or deleted.
 * - BACKUP_RELAUNCH_BLOCKED: an installed (.deb) Murage whose restart would
 *   crash (see linux-relaunch.mjs). */
export function relaunchBlockedCode(options = {}) {
  const file = runningAppImage(options);
  if (file) return appImageLaunchable(file, options) ? null : "BACKUP_RELAUNCH_APPIMAGE_MISSING";
  return (options.linuxBlocked ?? linuxRelaunchBlocked)(options) ? "BACKUP_RELAUNCH_BLOCKED" : null;
}

const MOUNT_PATH_LISTS = ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"];
// electron-builder's AppRun sets XDG_DATA_DIRS to
//   ${APPDIR}/usr/share/:<what it was>:/usr/share/gnome:/usr/local/share/:/usr/share/
// on every start. Dropping the mount's entry alone left that fixed tail, so
// each restart (a daily backup restarts twice) added three more entries.
const APPRUN_XDG_TAIL = ["/usr/share/gnome", "/usr/local/share/", "/usr/share/"];
/** The environment for the restarted AppImage: this one, minus what the old
 * mount added. The AppImage runtime and AppRun set these again for the new
 * mount; a stale APPDIR would even be preferred by AppRun over the new one. */
export function appImageRelaunchEnv(env, appDir) {
  const next = { ...env };
  for (const name of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete next[name];
  const inMount = entry => entry === appDir || entry.startsWith(appDir + "/");
  for (const name of MOUNT_PATH_LISTS) {
    if (typeof next[name] !== "string") continue;
    const entries = next[name].split(":");
    let kept = entries.filter(entry => entry && !inMount(entry));
    // Undo AppRun's XDG_DATA_DIRS exactly: only when its mount entry leads
    // (so AppRun really made this value) and its fixed tail is there.
    if (name === "XDG_DATA_DIRS" && entries[0] && inMount(entries[0].replace(/\/$/, ""))
      && kept.slice(-APPRUN_XDG_TAIL.length).join(":") === APPRUN_XDG_TAIL.join(":")) kept = kept.slice(0, -APPRUN_XDG_TAIL.length);
    if (kept.length) next[name] = kept.join(":"); else delete next[name];
  }
  return next;
}

/** Restart Murage with `args`. Returns how: "appimage" or "electron".
 * The caller quits the app right after, as it did around app.relaunch(). */
export function relaunchDesktop({ app, args, platform = process.platform, env = process.env, execPath = process.execPath, pid = process.pid, spawn = nodeSpawn, cwd = process.cwd() }) {
  const file = runningAppImage({ platform, env, execPath });
  if (!file) { app.relaunch({ args }); return "electron"; }
  const appDir = env.APPDIR;
  // The helper must not keep the old mount busy, and the new copy should start
  // where the person started the first one.
  const start = relaunchDirectory(env, cwd, os.homedir);
  const child = spawn("bash", ["-c", APPIMAGE_RELAUNCH_SCRIPT, "murage-relaunch", String(pid), file, ...args], withHideInherit({
    detached: true, stdio: "ignore", cwd: start, env: appImageRelaunchEnv(env, appDir),
  }));
  // A failed spawn must still never crash the quitting app.
  child.on?.("error", () => {});
  child.unref?.();
  return "appimage";
}

function isDirectory(dir) { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }

function relaunchDirectory(env, cwd, homedir) {
  for (const candidate of [() => env.OWD, () => cwd, homedir]) {
    try {
      const dir = candidate();
      if (typeof dir === "string" && path.isAbsolute(dir) && dir !== env.APPDIR && !dir.startsWith(env.APPDIR + "/") && isDirectory(dir)) return dir;
    } catch { /* try the next usable directory */ }
  }
  return "/";
}

// Registration is synchronous, before any acknowledgment wait. Only observed
// exit (or an error before a pid was assigned) releases this ownership.
export function ownRelaunchHelper(child, { stopMs = 2500 } = {}) {
  let exited = false;
  const listeners = new Set();
  const confirm = () => { exited = true; for (const resolve of listeners) resolve(); listeners.clear(); };
  child.once("exit", confirm);
  child.on("error", () => { if (!child.pid) confirm(); });
  return {
    async stop() {
      if (exited) return;
      await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); listeners.delete(done); resolve(); };
        const timer = setTimeout(() => {
          listeners.delete(done);
          reject(Object.assign(new Error("Relaunch helper termination unconfirmed"), { code: "HANDOFF_HELPER_ALIVE" }));
        }, stopMs);
        listeners.add(done);
        try { child.kill("SIGKILL"); } catch { /* only exit confirms termination */ }
        if (exited) done();
      });
    },
  };
}

export async function acknowledgedRelaunchHandoff({ app, args, platform = process.platform, env = process.env,
  execPath = process.execPath, pid = process.pid, spawn = nodeSpawn, cwd = process.cwd(), homedir = os.homedir,
  register, ackMs = 2500, stopMs = 2500 }) {
  const file = runningAppImage({ platform, env, execPath });
  if (!file) { app.relaunch({ args }); return true; }
  const child = spawn("bash", ["-c", APPIMAGE_RELAUNCH_SCRIPT, "murage-relaunch", String(pid), file, ...args], withHideInherit({
    detached: true, stdio: "ignore", cwd: relaunchDirectory(env, cwd, homedir), env: appImageRelaunchEnv(env, env.APPDIR),
  }));
  const owned = ownRelaunchHelper(child, { stopMs });
  register(owned);
  const accepted = await new Promise(resolve => {
    const finish = result => { clearTimeout(timer); child.removeListener("spawn", yes); child.removeListener("error", no); resolve(result); };
    const yes = () => finish(true), no = () => finish(false);
    const timer = setTimeout(no, ackMs);
    child.once("spawn", yes); child.once("error", no);
  });
  if (!accepted) { await owned.stop(); return false; }
  child.unref?.();
  return true;
}
