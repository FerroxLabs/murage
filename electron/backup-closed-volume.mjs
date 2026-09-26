// SPDX-License-Identifier: AGPL-3.0-or-later
import { statSync } from "node:fs";

/** Where a background (launchd) job can read Murage's files on macOS.
 *
 * Proved on macOS 26 (0.1.60 customer pass, 2026-09-26): a process that
 * launchd starts in the user's session can stat() a file on an external
 * volume, but its first readdir, read or ES-module import of that file blocks
 * for good. The same file on the internal system data volume reads at once,
 * and the same program started from a terminal reads both. It does not matter
 * where the executable itself lives, only which files are read. So a job that
 * reads the app's own files or the data folder from another volume never
 * finishes: the closed-app backup hung silently until its 32-minute timeout.
 *
 * The check compares device numbers, which a stat() gives without blocking on
 * such a volume. Only the internal system data volume counts ("/" presents
 * the same device through its firmlinks, as do /Applications and the home
 * folder); every other volume, internal or external, is refused, because the
 * behaviour above was only proved for the system data volume. */
export { CLOSED_VOLUME_SENTENCES } from "../shared/closed-volume-sentences.mjs";

/** "app", "data", "both" or null. Facts are injected for tests: `device(path)`
 * returns a stat device number or throws, and `platform` defaults to the
 * running one. Only macOS has this restriction. A path that cannot be
 * stat'ed is not counted here; the profile checks refuse it on their own. */
export function closedVolumeProblem({ appPaths = [], dataPaths = [], platform = process.platform, device = file => statSync(file).dev, internalRoot = "/System/Volumes/Data" }) {
  if (platform !== "darwin") return null;
  let internal;
  try { internal = device(internalRoot); } catch { try { internal = device("/"); } catch { return null; } }
  const outside = paths => paths.filter(value => typeof value === "string" && value).some(file => {
    try { return device(file) !== internal; } catch { return false; }
  });
  const app = outside(appPaths), data = outside(dataPaths);
  return app && data ? "both" : app ? "app" : data ? "data" : null;
}
