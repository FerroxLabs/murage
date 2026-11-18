// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THRUST-BACKUP 1.0.19: the restore step for owner files a backup keeps as written but a restore must not trust as written
// (DESIGN: one classification table, server/data-dir-inventory.ts; one restore lifecycle, prepareRestoredRecords).
//
//   Box state (cloud-computer-archive.json, cloud-computer-calls.json; format of server/cloud-computer-archive.ts, version 1).
//     A restore is an older point in time, and a bot's cloud computer is not: it can have been made, or kept working, after the backup.
//     So only what fails closed comes back. `had` stays (that bot may still have a box). `never` is dropped: the bot reads as unknown,
//     because an old "no cloud computer" may be stale. Every call with no provider answer comes back `lost`: the uncertainty stays, and
//     nothing in the record is ever sent again. An unreadable or invalid record comes back empty and `incomplete`, never as "nothing".
//   Connected-apps rate-limit holds (composio-admission.json). A hold only delays a request, so restoring one grants nothing. It is
//     checked with the store's own validator; a copy the store would refuse to load is set aside in the quarantine, never installed.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createComposioAdmissionStore } from "../electron/composio-admission-store.mjs";

/** The box state file names, as server/cloud-computer-archive.ts names them (fprod3-b5-box2). */
export const BOX_STATE_ARCHIVE_FILE = "cloud-computer-archive.json";
export const BOX_STATE_CALLS_FILE = "cloud-computer-calls.json";
/** electron/composio-release-config.mjs COMPOSIO_ADMISSION_FILE (restore-owner-state.test.ts pins the two together). */
export const ADMISSION_HOLDS_FILE = "composio-admission.json";
const MAX_BOX_STATE_BYTES = 16 * 1024 ** 2;

export interface OwnerStateIo {
  state: string;
  files: Set<string>;
  write(path: string, value: unknown): void;
  quarantine(path: string): void;
}
export type OwnerStateNote = { component: string; action: string };

const isMap = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const validMap = (value: unknown, allowed: readonly string[]): value is Record<string, string> =>
  isMap(value) && Object.entries(value).every(([key, x]) => key.length > 0 && typeof x === "string" && allowed.includes(x));

function readBoxState(absolute: string): unknown {
  try {
    if (lstatSync(absolute).size > MAX_BOX_STATE_BYTES) return undefined;
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch { return undefined; }
}

/** The fail-closed form of one stored box state record. Pure, so the same stored bytes always prepare to the same record. */
export function restoredBoxState(path: typeof BOX_STATE_ARCHIVE_FILE | typeof BOX_STATE_CALLS_FILE, stored: unknown): Record<string, unknown> {
  const archive = path === BOX_STATE_ARCHIVE_FILE;
  const lost = (calls: Record<string, string>) => Object.fromEntries(Object.keys(calls).map(key => [key, "lost"]));
  const valid = isMap(stored) && stored.version === 1 && validMap(stored.calls, ["open", "lost"])
    && (stored.incomplete === undefined || stored.incomplete === true) && (!archive || validMap(stored.bots, ["had", "never"]));
  if (!valid) return { version: 1, ...(archive ? { bots: {} } : {}), calls: {}, incomplete: true };
  const record = stored as { bots?: Record<string, string>; calls: Record<string, string>; incomplete?: true };
  return {
    version: 1,
    ...(archive ? { bots: Object.fromEntries(Object.entries(record.bots!).filter(([, answer]) => answer === "had")) } : {}),
    calls: lost(record.calls),
    ...(record.incomplete ? { incomplete: true } : {}),
  };
}

export function prepareRestoredOwnerState(io: OwnerStateIo, modifications: OwnerStateNote[], quarantined: string[]): void {
  let box = false;
  for (const path of [BOX_STATE_ARCHIVE_FILE, BOX_STATE_CALLS_FILE] as const) {
    if (!io.files.has(path)) continue;
    io.write(path, restoredBoxState(path, readBoxState(join(io.state, path))));
    box = true;
  }
  if (box) modifications.push({ component: "cloud computers", action: "Kept: which bots have a cloud computer. Work a cloud computer had not answered stays unconfirmed until that computer is checked." });
  if (io.files.has(ADMISSION_HOLDS_FILE)) {
    let valid = false;
    // The store's load is synchronous: it throws on any copy it would refuse at startup.
    try { const holds = createComposioAdmissionStore(io.state).load(); valid = Array.isArray(holds); } catch { valid = false; }
    if (!valid) {
      io.quarantine(ADMISSION_HOLDS_FILE); quarantined.push(ADMISSION_HOLDS_FILE);
      modifications.push({ component: ADMISSION_HOLDS_FILE, action: "Set aside: an unreadable record of connected-app waits. Connected apps start without saved waits." });
    }
  }
}
