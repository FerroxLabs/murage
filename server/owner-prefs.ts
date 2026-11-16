// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { ownerAppSurface } from "./owner-app.ts";
import { FIRST_RUN_JOB_IDS, type FirstRunJobId } from "../src/lib/first-run-jobs.ts";

/** The owner's own choices that follow them across the desktop and the phone (APPROVE-ALL-1016 section 4). Kept on the
 *  server, never in a device's storage, so a choice made on one surface holds on the other. */
export interface OwnerPrefs {
  /** The owner ticked "Don't show this again" on the Approve all caution. Absent or false: the caution shows. */
  approveAllCautionDismissed: boolean;
  /** How much Today shows (Today design 2b). Only the exact string "detailed" reads as Detailed; anything else is Calm. */
  todayView: TodayView;
  /** The jobs ticked in the first run that are still to be set up, in order (FIRSTRUN-1019 1.12). Only known ids, no duplicates. */
  firstRunJobs: { pending: FirstRunJobId[] };
}
export type TodayView = "calm" | "detailed";

const FILE = "owner-prefs.json";
const DEFAULTS: OwnerPrefs = { approveAllCautionDismissed: false, todayView: "calm", firstRunJobs: { pending: [] } };

/** Lenient: anything malformed reads as an empty queue; unknown ids and repeats are dropped. */
export function readPendingJobs(value: unknown): FirstRunJobId[] {
  const list = value && typeof value === "object" ? (value as { pending?: unknown }).pending : undefined;
  if (!Array.isArray(list)) return [];
  const out: FirstRunJobId[] = [];
  for (const id of list) {
    if ((FIRST_RUN_JOB_IDS as readonly unknown[]).includes(id) && !out.includes(id as FirstRunJobId)) out.push(id as FirstRunJobId);
  }
  return out;
}

/** Read leniently: a missing, unreadable or malformed file reads as the defaults, so the caution shows. */
export function readOwnerPrefs(dataDir: string): OwnerPrefs {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULTS };
    const disk = raw as Record<string, unknown>;
    return {
      approveAllCautionDismissed: disk.approveAllCautionDismissed === true,
      todayView: disk.todayView === "detailed" ? "detailed" : "calm",
      firstRunJobs: { pending: readPendingJobs(disk.firstRunJobs) },
    };
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
  if (patch.firstRunJobs) disk.firstRunJobs = { pending: readPendingJobs(patch.firstRunJobs) };
  writeFileAtomic(path, `${JSON.stringify(disk, null, 2)}\n`, { mode: 0o600 });
  return readOwnerPrefs(dataDir);
}

/**
 * The first run's pending jobs over HTTP (FIRSTRUN-1019 D2). Owner surfaces only, like the Today view save: the desktop
 * app or a keyed paired phone app. POST `{ pending }` replaces the queue; ids must be known, at most five, no repeats.
 */
export function firstRunJobsRoute(
  dataDir: string,
  method: "GET" | "POST",
  owner: ReturnType<typeof ownerAppSurface>,
  body?: unknown,
): { status: 200 | 400 | 403; body: Record<string, unknown> } {
  if (!owner.ok) return { status: 403, body: { error: "Your list of jobs is kept from the computer or the phone app." } };
  if (method === "GET") return { status: 200, body: { pending: readOwnerPrefs(dataDir).firstRunJobs.pending } };
  const list = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).pending : undefined;
  const valid = Array.isArray(list)
    && list.length <= FIRST_RUN_JOB_IDS.length
    && list.every((id, at) => (FIRST_RUN_JOB_IDS as readonly unknown[]).includes(id) && list.indexOf(id) === at);
  if (!valid) return { status: 400, body: { error: "pending must be a list of known jobs, without repeats" } };
  return { status: 200, body: { pending: writeOwnerPrefs(dataDir, { firstRunJobs: { pending: list as FirstRunJobId[] } }).firstRunJobs.pending } };
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
