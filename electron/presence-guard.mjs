// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 section 7 (S3B): whether the owner is somewhere an outside surface should stay quiet: a full-screen app, a
// screen share, Focus / Do Not Disturb, a locked screen. Produces `quiet()` for the router. Pure: the native addon, the process runner,
// the timers and the lock state are all injected.
//
// Sources, claimed only where they exist (design D7: copy states only what is proven per OS):
//   Mac / Windows: `presence-guard.node` in the app's resources folder, loaded only after the same file checks as the notification
//                  authorization addon (regular file, not a link, one hard link, not group or world writable, realpath is itself).
//                  Its `read()` returns {fullscreen, sharing, focus} booleans. No addon, or a read that fails: not detected.
//   Linux X11:     full screen from the active window's _NET_WM_STATE (xprop); Focus / Do Not Disturb from GNOME `show-banners` and the
//                  notification server's `Inhibited` property (KDE and others). Sharing: no reader (layer 1 content protection only).
//   Linux Wayland: nothing is detectable; no floating windows exist there.
// Locked comes from the lock state module: only an EXPLICIT locked counts here (an unknown lock holds Allow and Reply in the action
// path, it must not hold every notification forever on a desktop that never reports a lock).
//
// Reads happen (a) once at each decision, and (b) every `pollMs` ONLY while something is held or a floating surface is visible
// (`watch()`); nothing runs otherwise. Every external read is bounded; a failed signal reads as not detected.

import { createRequire } from "node:module";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const nodeRequire = createRequire(import.meta.url);

export const ADDON_FILE = "presence-guard.node";
const NONE = Object.freeze({ fullscreen: false, sharing: false, focus: false });
const READ_TIMEOUT_MS = 1500;

/** The addon, only when it is exactly where it should be and nothing else could have written it. Throws otherwise. */
export function loadPresenceAddon({ resourcesPath, load, lstat = lstatSync, realpath = realpathSync }) {
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)) throw new Error("PRESENCE_ADDON_UNAVAILABLE");
  const file = path.join(resourcesPath, ADDON_FILE);
  const stat = lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022) || realpath(file) !== file) throw new Error("PRESENCE_ADDON_UNAVAILABLE");
  const addon = load(file);
  if (typeof addon?.read !== "function") throw new Error("PRESENCE_ADDON_UNAVAILABLE");
  return addon;
}

const bool = value => value === true;
const decode = value => (value && typeof value === "object" ? { fullscreen: bool(value.fullscreen), sharing: bool(value.sharing), focus: bool(value.focus) } : NONE);

/** Linux readers over an injected `run(file, args) -> Promise<string>` (rejects on failure or timeout). */
export function createLinuxReaders({ run, env = {} }) {
  const x11 = env.XDG_SESSION_TYPE === "x11" || (!env.WAYLAND_DISPLAY && Boolean(env.DISPLAY) && env.XDG_SESSION_TYPE !== "wayland");
  const attempt = async fn => { try { return bool(await fn()); } catch { return false; } };
  return {
    x11,
    fullscreen: () => (!x11 ? Promise.resolve(false) : attempt(async () => {
      const root = await run("xprop", ["-root", "_NET_ACTIVE_WINDOW"]);
      const id = /window id # (0x[0-9a-f]+)/i.exec(root)?.[1];
      if (!id || /^0x0+$/i.test(id)) return false;
      const state = await run("xprop", ["-id", id, "_NET_WM_STATE"]);
      return /_NET_WM_STATE_FULLSCREEN\b/.test(state);
    })),
    focus: () => attempt(async () => {
      const banners = await run("gsettings", ["get", "org.gnome.desktop.notifications", "show-banners"]).catch(() => "");
      if (/^\s*false\s*$/.test(banners)) return true;
      const inhibited = await run("busctl", ["--user", "get-property", "org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "Inhibited"]).catch(() => "");
      return /^\s*b\s+true\s*$/.test(inhibited);
    }),
  };
}

/**
 * deps: { platform, resourcesPath, load, env, run, lock: {state()}, pollMs = 2000, setTimer, clearTimer, onChange(), log,
 *         addon (tests may pass one), readers (tests may pass Linux readers) }
 */
export function createPresenceGuard(deps) {
  const { platform = process.platform, lock = null, pollMs = 2000, setTimer = setInterval, clearTimer = clearInterval, log = () => {} } = deps;
  let addon = deps.addon ?? null, addonTried = Boolean(deps.addon), reads = 0;
  let cache = NONE;
  let seq = 0;
  let published = "false|false|false|false";
  let watching = 0, timer = null, disposed = false;
  const listeners = new Set();
  const readers = platform === "linux" ? (deps.readers ?? createLinuxReaders({ run: deps.run ?? (() => Promise.reject(new Error("no runner"))), env: deps.env ?? {} })) : null;

  function addonRead() {
    if (!addonTried) {
      addonTried = true;
      try { addon = loadPresenceAddon({ resourcesPath: deps.resourcesPath, load: deps.load ?? nodeRequire }); } catch (error) { addon = null; log(`presence: no addon (${error.message}); not detected`); }
    }
    return addon ? Promise.resolve().then(() => addon.read()).then(decode).catch(() => NONE) : Promise.resolve(NONE);
  }

  const lockedNow = () => { try { return lock?.state?.() === "locked"; } catch { return false; } };
  const quietKey = value => `${value.fullscreen}|${value.sharing}|${value.focus}|${value.locked}`;
  const current = () => ({ ...cache, locked: lockedNow() });

  /** Read the OS now. Resolves to the fresh quiet state; listeners hear about a change. */
  async function refresh() {
    if (disposed) return current();
    reads += 1;
    const mine = ++seq;
    // The lock is read together with the rest, so a lock that went from locked to unknown between polls is seen here too.
    const lockRead = typeof lock?.refresh === "function" ? Promise.resolve().then(() => lock.refresh()).catch(() => {}) : Promise.resolve();
    let next = NONE;
    if (platform === "darwin" || platform === "win32") next = await addonRead();
    else if (readers) {
      const [fullscreen, focus] = await Promise.all([readers.fullscreen(), readers.focus()]);
      next = { fullscreen, sharing: false, focus };
    }
    await lockRead;
    // A newer read started while this one was in flight: its answer is the one that applies, an older "not quiet" never overwrites it.
    if (mine !== seq || disposed) return current();
    cache = next;
    const after = current(), key = quietKey(after);
    // Compared with what listeners were last told, not with the state this call happened to start from.
    if (key !== published) {
      published = key;
      for (const listener of [...listeners]) { try { listener(after); } catch { /* a listener never breaks the guard */ } }
    }
    return after;
  }

  function tick() { void refresh().catch(() => {}); }

  return {
    /** The last read plus the live lock: what the router asks at decision time (call refresh() first for a fresh read). */
    quiet: current,
    refresh,
    /** A reason to poll: something is held or a floating surface is visible. Returns the stop function; the poll runs only while any watch is open. */
    watch() {
      if (disposed) return () => {};
      watching += 1;
      if (!timer) { timer = setTimer(tick, pollMs); timer?.unref?.(); }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        watching -= 1;
        if (watching <= 0 && timer) { clearTimer(timer); timer = null; watching = 0; }
      };
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get watching() { return watching; },
    get reads() { return reads; },
    get polling() { return timer !== null; },
    dispose() { disposed = true; if (timer) { clearTimer(timer); timer = null; } watching = 0; listeners.clear(); },
  };
}
