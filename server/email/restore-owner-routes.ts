// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner's restore routes (Cloud 1.0.19 restore park, J3): `/api/restore-job/*`.
//   GET  status   where a restore stands: the owner's status line and, for a failed one, the OK action
//   POST start    { archiveId }: arm -> capture -> close the data store -> swap -> prepare -> clear, then ask for a restart
//   POST dismiss  the owner presses OK on a failed restore: clears the aborted job so a new restore can start
// Who may call (same boundary as the email owner routes): a request with a bot or engine credential never gets in (403), nor does a caller that is not the owner's
// own surface. Owner surfaces may start, dismiss and read: the desktop app and, on a Cloud home, the owner's phone and acting owner browser (requestSurface maps
// them all to "desktop"; MurageMain ruled this intended). A local install's paired phone is read-only. Every answer carries a stable `code` beside the English
// line; the app shows its own locale text for the code and the English stays for any older caller.
import type { RestoreJobStore } from "./restore-job.ts";
import { RESTORE_ABORTED_LINE, RESTORE_FAILED_LINE, RESTORE_FINISHING_LINE, RESTORE_STUCK_LINE } from "./restore-job.ts";
import { ARCHIVE_ID_RE } from "./restore-job-effects.ts";

export const RESTORE_OWNER_PREFIX = "/api/restore-job/";
/** Shown with a failed or stuck restore while its alert to Murage is still waiting to be sent (the connection to Murage does not take it yet). */
export const RESTORE_ALERT_WAITING_LINE = "Murage has not been told about this yet. The message is kept here and goes out as soon as the connection takes it.";
export const RESTORE_OWNER_ONLY_LINE = "Only the owner can restore a backup, using Murage on their computer or, for a Cloud home, on their phone.";
const DISMISS_PATH = "/api/restore-job/dismiss";
// `code` is the stable name the card maps to its own locale text; `label` and every `line` stay as English for any older caller.
const OK_ACTION = { label: "OK", method: "POST", path: DISMISS_PATH, code: "dismiss" } as const;
/** The stable code the status answer carries for each job state (the card maps it to a locale string). */
const STATE_CODE = { running: "finishing", unreadable: "stuck_or_unreadable", aborted: "aborted" } as const;

export type RestoreRouteAnswer = { status: number; body: Record<string, unknown> };
export interface RestoreOwnerRequest { method: string; path: string; body: unknown; surface: "desktop" | "phone" | null; botCredential: boolean }
export interface RestoreOwnerDeps {
  jobs: RestoreJobStore;
  /** How many restore alerts are still waiting to be sent to Murage (server/home-events.ts heldHomeEvents). Absent on a desktop install. */
  heldAlerts?: () => number;
  /** Stops every writer and closes the data store. False = it would not close. */
  closeForSwap: () => Promise<boolean>;
  /** Asks the server to restart so it opens the restored home. Called after the store was closed, whatever the outcome. */
  restart: () => void;
}
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): RestoreRouteAnswer => ({ status, body: { error, ...extra } });

function status(jobs: RestoreJobStore, heldAlerts?: () => number): RestoreRouteAnswer {
  const state = jobs.state();
  const waiting = (state === "aborted" || state === "unreadable") && (heldAlerts?.() ?? 0) > 0;
  const base = state === "none" ? jobs.bootWaitLine() : state === "aborted" ? RESTORE_ABORTED_LINE : state === "unreadable" ? RESTORE_STUCK_LINE : RESTORE_FINISHING_LINE;
  const line = base !== null && waiting ? `${base} ${RESTORE_ALERT_WAITING_LINE}` : base;
  return { status: 200, body: { state, code: state === "none" ? null : STATE_CODE[state], ...(waiting ? { alertWaiting: true } : {}), line, action: state === "aborted" ? OK_ACTION : null } };
}

export async function restoreOwnerRoute(deps: RestoreOwnerDeps, request: RestoreOwnerRequest): Promise<RestoreRouteAnswer | null> {
  if (!request.path.startsWith(RESTORE_OWNER_PREFIX)) return null;
  if (request.botCredential || request.surface === null) return refuse(403, RESTORE_OWNER_ONLY_LINE, { code: "owner_only" });
  const { method, path } = request, jobs = deps.jobs;
  try {
    if (method === "GET" && path === "/api/restore-job/status") return status(jobs, deps.heldAlerts);
    if (method === "POST" && (path === "/api/restore-job/start" || path === DISMISS_PATH)) {
      if (request.surface !== "desktop") return refuse(403, RESTORE_OWNER_ONLY_LINE, { code: "owner_only" });
      if (path === DISMISS_PATH) {
        const r = jobs.dismiss();
        return r.ok ? status(jobs, deps.heldAlerts) : refuse(409, "There is no failed restore to clear.", { code: "not_dismissable" });
      }
      return await start(deps, request.body);
    }
    return refuse(404, "No such restore route.", { code: "not_found" });
  } catch { return refuse(500, RESTORE_FAILED_LINE, { code: "restore_failed" }); }
}

async function start(deps: RestoreOwnerDeps, body: unknown): Promise<RestoreRouteAnswer> {
  const jobs = deps.jobs;
  const archiveId = body && typeof body === "object" ? (body as Record<string, unknown>).archiveId : undefined;
  if (typeof archiveId !== "string" || !ARCHIVE_ID_RE.test(archiveId)) return refuse(400, "Choose a backup to restore.", { code: "bad_archive" });
  const armed = jobs.arm({ archiveId, source: "owner" });
  if (!armed.ok) {
    if (armed.code === "restore_aborted") return refuse(409, RESTORE_ABORTED_LINE, { code: "restore_aborted", action: OK_ACTION });
    if (armed.code === "archive_not_local") return refuse(404, "That backup is not on this computer.", { code: "archive_not_local" });
    return refuse(409, armed.line ?? RESTORE_FINISHING_LINE, { code: armed.code });
  }
  const failed = (restarting: boolean) => refuse(500, RESTORE_FAILED_LINE, { code: "restore_failed", restarting });
  const captured = jobs.capture();
  if (!captured.ok) { jobs.abort(); return failed(false); }
  // From here the data store is closed: whatever happens next, the server restarts so it comes back on a database that is open.
  let closed = false;
  try { closed = await deps.closeForSwap(); } catch { closed = false; }
  if (!closed) { jobs.abort(); deps.restart(); return failed(true); }
  const job = captured.job;
  let swapped = false;
  try { swapped = jobs.swap({ archiveId: job.archiveId, source: job.source }).ok; } catch { swapped = false; }
  if (!swapped) { jobs.abort(); deps.restart(); return failed(true); }
  // Swapped: the home has changed, so this is never aborted. A prepare that did not finish is finished by boot recovery after the restart.
  let done = false;
  try { done = jobs.prepare().ok && jobs.clear().ok; } catch { done = false; }
  deps.restart();
  return done ? { status: 200, body: { ok: true, restarting: true } } : failed(true);
}
