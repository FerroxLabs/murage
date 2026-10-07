// SPDX-License-Identifier: AGPL-3.0-or-later
// V8 compile cache for the packaged server and companion children. Node reads
// NODE_COMPILE_CACHE at start-up and stores compiled code there, so the second
// launch skips compiling the 11 MB server bundle. The folder lives under the
// app's own userData and is scoped by app version, so an update never loads a
// cache built from older code. Every failure returns {} and the child runs
// without a cache.
import fs from "node:fs";
import path from "node:path";

export const COMPILE_CACHE_FOLDER = "node-compile-cache";

export function compileCacheDirectory({ userData, appVersion, electronVersion = process.versions.electron }) {
  if (typeof userData !== "string" || !path.isAbsolute(userData)) return null;
  const version = String(appVersion ?? "").replace(/[^0-9A-Za-z._-]/g, "_");
  if (!version) return null;
  const electron = String(electronVersion ?? "").replace(/[^0-9A-Za-z._-]/g, "_");
  return path.join(userData, COMPILE_CACHE_FOLDER, electron ? `${version}-electron-${electron}` : version);
}

/** Environment entries for a fork. An operator's own NODE_COMPILE_CACHE wins. */
export function compileCacheEnvironment({ userData, appVersion, electronVersion, env = process.env, fsImpl = fs } = {}) {
  try {
    if (typeof userData === "function") userData = userData();
    if (typeof appVersion === "function") appVersion = appVersion();
    if (env.NODE_DISABLE_COMPILE_CACHE) return {};
    if (env.NODE_COMPILE_CACHE) return {};
    const dir = compileCacheDirectory({ userData, appVersion, electronVersion });
    if (!dir) return {};
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    pruneStaleCaches(path.dirname(dir), path.basename(dir), fsImpl);
    return { NODE_COMPILE_CACHE: dir };
  } catch {
    return {};
  }
}

function pruneStaleCaches(root, keep, fsImpl) {
  try {
    for (const entry of fsImpl.readdirSync(root)) {
      if (entry === keep) continue;
      try { fsImpl.rmSync(path.join(root, entry), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}
