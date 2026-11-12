// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Main's owner of `notify-surfaces.json` (NOTIFY-EVERYWHERE-1019, sections 6.2 and 6.3). Decides the install's origin from
// disk BEFORE the server spawns (the server creates messages.db), writes the file at once so the answer never changes,
// and serves one-key-at-a-time updates. Effects (fs) are injected so tests use a fixture dir.
import nodeFs from "node:fs";
import path from "node:path";
import { MAX_FILE_BYTES, NOTIFY_SURFACES_VERSION, checkNotifySurfaceKey, normalizeNotifySurfaces, notifySurfaceDefaults } from "../shared/notify-surfaces.mjs";

export const NOTIFY_SURFACES_FILE = "notify-surfaces.json";
/** A3 (design section 13): the installation origin in its own marker, written once and never rewritten. */
export const NOTIFY_ORIGIN_FILE = "notify-origin.json";

/** {origin} when the marker is valid; {origin:null, reason:"missing"} when absent; {origin:null, reason:"unreadable"} for anything else. */
export function readOriginMarker(file, fs = nodeFs) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { return { origin: null, reason: error?.code === "ENOENT" ? "missing" : "unreadable" }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return { origin: null, reason: "unreadable" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && parsed.v === NOTIFY_SURFACES_VERSION && (parsed.origin === "new" || parsed.origin === "upgrade")) return { origin: parsed.origin };
  } catch { /* falls through */ }
  return { origin: null, reason: "unreadable" };
}
/** The server's store file and the existing device file: either one means this profile was used before 1.0.19. */
export const UPGRADE_MARKERS = Object.freeze(["messages.db", "startup-background.json"]);

/** Read the file. {state} when valid; {state:null, reason} otherwise. reason: missing | unsafe | corrupt | version. */
export function readNotifySurfacesFile(file, platform, fs = nodeFs) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return { state: null, reason: "missing" }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return { state: null, reason: "unsafe" };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { state: null, reason: "corrupt" }; }
  const state = normalizeNotifySurfaces(parsed, platform);
  return state ? { state } : { state: null, reason: "version" };
}

/** Origin from disk only. */
export function originFromDisk(profileDir, fs = nodeFs) {
  if (!profileDir) return "new";
  for (const name of UPGRADE_MARKERS) {
    try { fs.lstatSync(path.join(profileDir, name)); return "upgrade"; } catch { /* absent */ }
  }
  return "new";
}

function writeAtomic(file, state, fs) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * profileDir: the owned profile directory, or null (no owned dir: origin is "new" and held in memory for the launch).
 * Returns {state(), get(), set(key,value), reset(), persisted}.
 */
export function createNotifySurfaces({ profileDir, platform, fs = nodeFs, onError = () => {} }) {
  const file = profileDir ? path.join(profileDir, NOTIFY_SURFACES_FILE) : null;
  const markerPath = profileDir ? path.join(profileDir, NOTIFY_ORIGIN_FILE) : null;
  const marker = markerPath ? readOriginMarker(markerPath, fs) : { origin: null, reason: "missing" };
  let state, persisted = false;
  const loaded = file ? readNotifySurfacesFile(file, platform, fs) : { state: null, reason: "missing" };
  if (loaded.state) { state = loaded.state; persisted = true; }
  else {
    // The marker decides: a new install stays new after the server makes its store; an unreadable marker is the conservative upgrade.
    const origin = marker.origin ?? (marker.reason === "unreadable" ? "upgrade" : originFromDisk(profileDir, fs));
    state = notifySurfaceDefaults(origin, platform);
    // A missing or corrupt file is rewritten at once. A symlink, an oversize file or a newer version is left alone.
    if (file && (loaded.reason === "missing" || loaded.reason === "corrupt")) {
      try { writeAtomic(file, state, fs); persisted = true; } catch (error) { onError(error); }
    }
  }
  // Written once, only when absent (never through a symlink, never over an unreadable one).
  if (markerPath && marker.reason === "missing") {
    try { writeAtomic(markerPath, { v: NOTIFY_SURFACES_VERSION, origin: state.origin }, fs); } catch (error) { onError(error); }
  }
  const snapshot = () => structuredClone(state);
  const commit = next => {
    if (file && persisted) writeAtomic(file, next, fs);
    else if (file && !persisted) { writeAtomic(file, next, fs); persisted = true; }
    state = next;
  };
  return {
    get persisted() { return persisted; },
    get: snapshot,
    set(key, value) {
      const checked = checkNotifySurfaceKey(key, value);
      if (!checked.ok) throw new TypeError("That notification setting is not valid.");
      const next = snapshot();
      if (key.startsWith("surfaces.")) {
        if (key === "surfaces.pill" && checked.value && platform !== "darwin") throw new TypeError("That notification setting is not valid.");
        next.surfaces[key.slice(9)] = checked.value;
      } else if (key.startsWith("asks.")) next.asks[key.slice(5)] = checked.value;
      else next[key] = checked.value;
      commit(next);
      return snapshot();
    },
    /** Reset to defaults = the new-install defaults for this computer. The origin and the chooser state are kept. */
    reset() {
      const next = notifySurfaceDefaults("new", platform);
      next.origin = state.origin; next.chooser = state.chooser; next.asks = { ...state.asks };
      commit(next);
      return snapshot();
    },
  };
}
export { NOTIFY_SURFACES_VERSION };
