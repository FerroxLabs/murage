// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 S3R R6: whether the owner is somewhere an outside surface should stay quiet: a full-screen app, a
// screen share, Focus / Do Not Disturb, a locked screen. Decisions consume committed refresh() replies. Pure: the native addon, the process runner,
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
 * deps: { platform, resourcesPath, load, env, run, lock: {state(), refresh?()}, pollMs = 2000, setTimer, clearTimer, log,
 *         addon (tests may pass one), readers (tests may pass Linux readers) }
 */
export function createPresenceGuard(deps) {
  const { platform = process.platform, lock = null, pollMs = 2000, setTimer = setInterval, clearTimer = clearInterval, log = () => {} } = deps;
  let addon = deps.addon ?? null, addonTried = Boolean(deps.addon), reads = 0;
  let snap = Object.freeze({ ...NONE, locked: false });
  let rev = 0, recheck = false;
  let running = null, queued = null;
  let watching = 0, timer = null, disposed = false;
  const listeners = new Set();
  const cancellations = new Set();
  const readers = platform === "linux" ? (deps.readers ?? createLinuxReaders({ run: deps.run ?? (() => Promise.reject(new Error("no runner"))), env: deps.env ?? {} })) : null;

  function ensureAddon() {
    if (!addonTried) {
      addonTried = true;
      try { addon = loadPresenceAddon({ resourcesPath: deps.resourcesPath, load: deps.load ?? nodeRequire }); } catch (error) { addon = null; log(`presence: no addon (${error.message}); not detected`); }
    }
    return addon;
  }
  function addonRead() {
    const loaded = ensureAddon();
    return loaded ? Promise.resolve().then(() => loaded.read()).then(decode).catch(() => NONE) : Promise.resolve(NONE);
  }
  // S3B: while something watches, the addon's change callback (a share starting, a full-screen app, Focus) asks for a complete read at once
  // instead of waiting for the next poll tick. One subscription at a time (the addon replaces the old one); released when the last watch ends.
  let offChange = null;
  function subscribeAddon() {
    if (offChange || (platform !== "darwin" && platform !== "win32")) return;
    const loaded = ensureAddon();
    if (typeof loaded?.onChange !== "function") return;
    try {
      // New evidence: bump the revision (so a read already in flight cannot pass a presentation's revision test), then read again.
      const off = loaded.onChange(() => { if (!disposed) { rev += 1; void refresh().catch(() => {}); } });
      offChange = typeof off === "function" ? off : () => {};
    } catch { offChange = null; log("presence: addon change callback unavailable; polling only"); }
  }
  function unsubscribeAddon() {
    const off = offChange; offChange = null;
    if (off) { try { off(); } catch { /* the addon may already be gone */ } }
  }

  const lockedNow = () => { try { return lock?.state?.() === "locked"; } catch { return false; } };
  const quietKey = value => `${value.fullscreen}|${value.sharing}|${value.focus}|${value.locked}`;
  const committed = () => Object.freeze({ ...snap, rev });

  // Bound each external reader independently. A late result cannot publish or
  // delay the queue; disposal also settles these waits and removes their timers.
  function bounded(read, fallback) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cancellations.delete(cancel);
        resolve(value);
      };
      const cancel = () => finish(fallback);
      const timeout = setTimeout(cancel, READ_TIMEOUT_MS);
      cancellations.add(cancel);
      Promise.resolve().then(() => disposed ? fallback : read()).then(finish, cancel);
    });
  }

  async function readValues() {
    const lockRead = bounded(async () => { await lock?.refresh?.(); return true; }, false);
    let next = NONE;
    if (platform === "darwin" || platform === "win32") next = await bounded(addonRead, NONE);
    else if (readers) {
      const [fullscreen, focus] = await Promise.all([
        bounded(() => readers.fullscreen(), false),
        bounded(() => readers.focus(), false),
      ]);
      next = { fullscreen: bool(fullscreen), sharing: false, focus: bool(focus) };
    }
    const lockReadOk = await lockRead;
    return { ...next, locked: lockReadOk && lockedNow() };
  }

  function batch() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  }

  function start(read) {
    running = read;
    const startRev = rev;
    reads += 1;
    void readValues().then(next => {
      if (disposed) return; // dispose already answered both batches
      const changed = quietKey(next) !== quietKey(snap);
      if (changed) { snap = Object.freeze(next); rev += 1; }
      const snapshot = Object.freeze({ ...next, rev: startRev + (changed ? 1 : 0) });
      if (changed || recheck) {
        recheck = false;
        // Keep this read running during callbacks: their refresh calls must join
        // the next batch, never a read that began before the callback.
        for (const listener of [...listeners]) { try { listener(snapshot); } catch { /* a listener never breaks the guard */ } }
      }
      read.resolve(snapshot);
      running = null;
      const nextRead = queued;
      queued = null;
      if (nextRead && !disposed) start(nextRead);
    });
  }

  /** Join the first read that starts after this call, with at most one queued read. */
  function refresh() {
    if (disposed) return Promise.resolve(committed());
    if (running) {
      queued ??= batch();
      return queued.promise;
    }
    const read = batch();
    start(read);
    return read.promise;
  }

  function tick() { void refresh().catch(() => {}); }

  return {
    /** The committed values only. Decisions use their own refresh() reply. */
    quiet: () => snap,
    refresh,
    noteEvent() { if (!disposed) rev += 1; return refresh(); },
    markConservative() { if (!disposed) recheck = true; },
    get rev() { return rev; },
    get recheck() { return recheck; },
    /** A reason to poll: something is held or a floating surface is visible. Returns the stop function; the poll runs only while any watch is open. */
    watch() {
      if (disposed) return () => {};
      watching += 1;
      if (timer === null) { timer = setTimer(tick, pollMs); timer?.unref?.(); }
      subscribeAddon();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        if (disposed) return;
        watching -= 1;
        if (watching === 0) { if (timer !== null) { clearTimer(timer); timer = null; } unsubscribeAddon(); }
      };
    },
    onChange(listener) { if (!disposed) listeners.add(listener); return () => listeners.delete(listener); },
    get watching() { return watching; },
    get reads() { return reads; },
    get polling() { return timer !== null; },
    dispose() {
      disposed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      watching = 0;
      unsubscribeAddon();
      listeners.clear();
      recheck = false;
      const snapshot = committed();
      running?.resolve(snapshot);
      queued?.resolve(snapshot);
      running = null; queued = null;
      for (const cancel of [...cancellations]) cancel();
    },
  };
}
