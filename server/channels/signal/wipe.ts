// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { syncParentDirectory } from "../../atomic.ts";

export type WipeScope = "auth" | "all";

/** There is one linked Signal device per home. Its credential tree includes
 * ingress, tombstones, logs and tmp; receipts of other connections are retained.
 * The revocation marker lives outside both targets, in channels/signal/connection.json.
 */
export async function wipeSignalData(dataDir: string, connectionId: string, scope: WipeScope): Promise<void> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(connectionId)) throw new Error("Invalid Signal connection id");
  const root = realpathSync(dataDir);
  const targets = scope === "auth" ? [join(root, "signal/auth")]
    : [join(root, "signal"), join(root, "channels/signal", connectionId)];
  // Validate every ancestor before deleting anything; remove a leaf link itself.
  for (const target of targets) {
    for (let path = dirname(target); path !== root; path = dirname(path)) {
      if (!path.startsWith(root + sep)) throw new Error("Signal data path escapes the data folder");
      try { if (lstatSync(path).isSymbolicLink()) throw new Error("Signal data path crosses a symbolic link"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  for (const target of targets) {
    rmSync(target, { recursive: true, force: true });
    try { syncParentDirectory(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
