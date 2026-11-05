// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

/** The owner's own choices that follow them across the desktop and the phone (APPROVE-ALL-1016 section 4). Kept on the
 *  server, never in a device's storage, so a choice made on one surface holds on the other. */
export interface OwnerPrefs {
  /** The owner ticked "Don't show this again" on the Approve all caution. Absent or false: the caution shows. */
  approveAllCautionDismissed: boolean;
}

const FILE = "owner-prefs.json";
const DEFAULTS: OwnerPrefs = { approveAllCautionDismissed: false };

/** Read leniently: a missing, unreadable or malformed file reads as the defaults, so the caution shows. */
export function readOwnerPrefs(dataDir: string): OwnerPrefs {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULTS };
    return { approveAllCautionDismissed: (raw as Record<string, unknown>).approveAllCautionDismissed === true };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Write one pref; every other key already on disk is kept as it is. */
export function writeOwnerPrefs(dataDir: string, patch: Partial<OwnerPrefs>): OwnerPrefs {
  const path = join(dataDir, FILE);
  let disk: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) disk = raw as Record<string, unknown>;
  } catch { /* first write */ }
  if (typeof patch.approveAllCautionDismissed === "boolean") disk.approveAllCautionDismissed = patch.approveAllCautionDismissed;
  writeFileAtomic(path, `${JSON.stringify(disk, null, 2)}\n`, { mode: 0o600 });
  return readOwnerPrefs(dataDir);
}
