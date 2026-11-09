// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { ownerAppSurface } from "./owner-app.ts";

/** The owner's own choices that follow them across the desktop and the phone (APPROVE-ALL-1016 section 4). Kept on the
 *  server, never in a device's storage, so a choice made on one surface holds on the other. */
export interface OwnerPrefs {
  /** The owner ticked "Don't show this again" on the Approve all caution. Absent or false: the caution shows. */
  approveAllCautionDismissed: boolean;
  /** How much Today shows (Today design 2b). Only the exact string "detailed" reads as Detailed; anything else is Calm. */
  todayView: TodayView;
}
export type TodayView = "calm" | "detailed";

const FILE = "owner-prefs.json";
const DEFAULTS: OwnerPrefs = { approveAllCautionDismissed: false, todayView: "calm" };

/** Read leniently: a missing, unreadable or malformed file reads as the defaults, so the caution shows. */
export function readOwnerPrefs(dataDir: string): OwnerPrefs {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULTS };
    const disk = raw as Record<string, unknown>;
    return { approveAllCautionDismissed: disk.approveAllCautionDismissed === true, todayView: disk.todayView === "detailed" ? "detailed" : "calm" };
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
  if (patch.todayView === "calm" || patch.todayView === "detailed") disk.todayView = patch.todayView;
  writeFileAtomic(path, `${JSON.stringify(disk, null, 2)}\n`, { mode: 0o600 });
  return readOwnerPrefs(dataDir);
}

/** Today's Calm | Detailed choice over HTTP (Today design 2b). The caller passes the one owner-app check's answer
 *  (`ownerAppSurface`, the same check the Approve all caution route uses); nothing here decides who the caller is.
 *  GET reads the saved view anywhere Today renders and says whether this surface may save it. POST `{view}` saves it
 *  only where the check admits (the desktop app, a keyed paired phone app); every other surface flips its own visit. */
export function todayViewRoute(
  dataDir: string,
  method: "GET" | "POST",
  owner: ReturnType<typeof ownerAppSurface>,
  body?: unknown,
): { status: 200 | 400 | 403; body: Record<string, unknown> } {
  if (method === "GET") return { status: 200, body: { view: readOwnerPrefs(dataDir).todayView, canSave: owner.ok } };
  if (!owner.ok) return { status: 403, body: { error: "This view choice is saved from the computer or the phone app.", code: "today_view_visit_only" } };
  const view = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).view : undefined;
  if (view !== "calm" && view !== "detailed") return { status: 400, body: { error: "view must be calm or detailed" } };
  return { status: 200, body: { view: writeOwnerPrefs(dataDir, { todayView: view }).todayView, canSave: true } };
}
