// SPDX-License-Identifier: AGPL-3.0-or-later
// A Cloud host restore (deploy/cloud-home/murage-commands, restore_into_place) writes this file into the restored data folder, whatever the
// snapshot held: a seeded Chief with no history, or a channel and nothing else, is still somebody's restored home and never gets the welcome.
import { lstatSync } from "node:fs";
import { join } from "node:path";

export const RESTORE_PROVENANCE_FILE = "restore-provenance.json";

/** True when the marker is there. A folder that cannot be read counts as restored: the welcome is never shown over history we could not see. */
export function hasRestoreProvenance(dataDir: string): boolean {
  try { lstatSync(join(dataDir, RESTORE_PROVENANCE_FILE)); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}
