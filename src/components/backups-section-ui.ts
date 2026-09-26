// Pure helpers for Settings → Backups. Everything here reads the status the
// existing bridges already return; nothing adds a call or relaxes a check.
import type { BackupRemoteStatus } from "../../server/backup-remote-host";
import { CLOSED_VOLUME_SENTENCES, closedVolumeSentence } from "../../shared/closed-volume-sentences.mjs";
import { DEFAULT_BACKUP_TIME, enabledSchedule, scheduleDraft, scheduleError, scheduleNeedsReview, schedulePhase } from "./backup-schedule-ui";
import { captureFailureSentence } from "../../shared/backup-capture-failure.mjs";
import { backupWaitingSentence, type BackupWaitingBot } from "../../shared/backup-waiting";

/** Display-only size: decimal units, one decimal below ten ("1.2 GB"). */
export function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1000) return `${Math.round(bytes)} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}

/** Every zone this runtime knows, with the system zone and UTC always present.
 * The schedule schema still validates whatever is typed. */
export function timeZoneChoices(): string[] {
  let zones: string[] = [];
  try { zones = Intl.supportedValuesOf("timeZone"); } catch { zones = []; }
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set([system, "UTC", ...zones].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

type ClosedState = BackupClosedStatus["state"];
type ClosedBridge = { stage(): Promise<BackupClosedStatus>; install(): Promise<BackupClosedStatus & { cancelled?: boolean }> };

/** Whether "Also back up when Murage is closed" can start the job setup. */
export function closedJobCanSetUp(state: ClosedState | undefined): boolean {
  return state === "unconfigured" || state === "staged" || state === "disabled" || state === "installed";
}

/** Runs the existing prepare → register calls in order, skipping a step the
 * job has already passed. Stops after a prepare that did not reach a
 * registrable state. Returns the last step taken, or null when none was due. */
export async function setUpClosedJob(
  bridge: ClosedBridge,
  state: ClosedState | undefined,
  apply: (next: BackupClosedStatus) => void,
): Promise<{ action: "stage" | "install"; next: BackupClosedStatus & { cancelled?: boolean } } | null> {
  let last: { action: "stage" | "install"; next: BackupClosedStatus & { cancelled?: boolean } } | null = null;
  let current = state;
  if (current === "unconfigured") {
    const next = await bridge.stage(); apply(next); last = { action: "stage", next }; current = next.state;
  }
  if (current === "staged" || current === "disabled") {
    const next = await bridge.install(); apply(next); last = { action: "install", next };
  }
  return last;
}

export const CLOSED_JOB_REFUSED_REASON = "Your system didn't let Murage register a background job, so backups run only while Murage is open.";
export const CLOSED_JOB_SHARED_FOLDER_REASON = "Other accounts on this computer can change Murage's data folder, so backups run only while Murage is open.";
export const CLOSED_JOB_WONT_RUN_REASON = "Murage set up its background job, but your system couldn't start it, so backups run only while Murage is open. Tick \"Also back up when Murage is closed\" again to retry.";
export const CLOSED_JOB_MOVED_REASON = "You opened Murage from a different app file, and its background job couldn't be moved to it, so backups run only while Murage is open. Tick \"Also back up when Murage is closed\" again to set it up for this copy.";
export const CLOSED_JOB_OUTDATED_REASON = "Murage's background job was set up by an earlier version and couldn't be updated, so backups run only while Murage is open. Tick \"Also back up when Murage is closed\" again to set it up for this version.";
/** A single-quoted shell word, so the command can be pasted as shown. */
const shellWord = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** The app file (an AppImage made executable under umask 002) can be changed
 * by other accounts, so the job would run a file someone else could rewrite.
 * Names the file and the one command that fixes it. */
export function closedAppFileSharedReason(file: string | undefined): string {
  const named = typeof file === "string" && file.startsWith("/") && !/[\x00-\x1f]/.test(file) ? file : null;
  return named
    ? `Other accounts on this computer can change the Murage app file ${named}, so backups run only while Murage is open. To fix it, run chmod 755 ${shellWord(named)} in a terminal, then come back here.`
    : "Other accounts on this computer can change the Murage app file, so backups run only while Murage is open. To fix it, run chmod 755 on the Murage app file in a terminal, then come back here.";
}

/** Why "Also back up when Murage is closed" can't be ticked, said next to the
 * box. Null when nothing went wrong or another line already explains it: no
 * bridge, an unsupported app, or a status that could not be refreshed. */
export function closedJobBlockedReason(input: { bridge: boolean; closed: BackupClosedStatus | null; stale: boolean; setupFailed: boolean }): string | null {
  const { bridge, closed, stale, setupFailed } = input;
  if (!bridge || stale || !closed?.supported) return null;
  if (closed.state === "installed" || closed.state === "disabled-removal-pending") return null;
  if (closed.blocked === "data-folder-shared") return CLOSED_JOB_SHARED_FOLDER_REASON;
  if (closed.blocked === "app-file-shared") return closedAppFileSharedReason(closed.appFile);
  if (closed.blocked === "job-wont-run") return CLOSED_JOB_WONT_RUN_REASON;
  if (closed.blocked === "app-moved") return CLOSED_JOB_MOVED_REASON;
  if (closed.blocked === "job-outdated") return CLOSED_JOB_OUTDATED_REASON;
  const volume = closedVolumeSentence(closed.blocked);
  if (volume) return volume;
  return closed.state === "unavailable" || setupFailed ? CLOSED_JOB_REFUSED_REASON : null;
}

/** The same notices the prepare/register/remove buttons have always shown. */
export function closedJobNotice(action: "stage" | "install" | "disable", next: BackupClosedStatus & { cancelled?: boolean }): string {
  if (action === "stage") return next.state === "installed" ? "Job registration confirmed. Scheduling settings are unchanged." : "Job prepared. It is not registered; scheduling settings are unchanged.";
  if (action === "install") return next.cancelled ? "Job registration cancelled. Scheduling settings are unchanged." : next.state === "installed" ? "Job registration confirmed. Scheduling settings are unchanged." : "Registration is not confirmed. Refresh status before enabling closed-app backups.";
  return next.state === "disabled-removal-pending" ? "All scheduled backups are disabled. Job removal is pending; any running backup is not cancelled." : "All scheduled backups are disabled. Any running backup is not cancelled.";
}

const offsiteLabels: Record<string, string> = {
  unconfigured: "Not set up",
  "password-required": "Saved; choose the off-site password file",
  disconnected: "Saved, not connected",
  connected: "Connected",
  blocked: "Off: data folder can be changed by other accounts",
  initializing: "Setup needs review",
  "needs-review": "Needs review",
  unavailable: "Not available in this app",
};

export interface BackupSummaryInput {
  scheduleBridge: boolean;
  schedule: BackupScheduleStatus | null;
  scheduleStale: boolean;
  scheduleFailure: string | null;
  closed: BackupClosedStatus | null;
  closedStale: boolean;
  remoteBridge: boolean;
  remote: BackupRemoteStatus | null;
  remoteStale: boolean;
  remoteFailure: string | null;
}
/** Murage attests its backup tool after it starts; on the first launch after
 * an install or update macOS can make that take a while. Not a failure. */
export const SCHEDULE_CHECKING = "Getting ready…";
export interface BackupSummary { last: string; schedule: string; offsite: string; attention: string[] }

/** One plain summary for the "Your backups" card. `formatTime` is injected so
 * the helper stays deterministic under test. */
export function backupSummary(input: BackupSummaryInput, formatTime: (ms: number) => string = (ms) => new Date(ms).toLocaleString()): BackupSummary {
  const { schedule: s, remote: r } = input;
  const last = s?.lastVerified
    ? `${formatTime(s.lastVerified.verifiedAt)} · ${formatBackupSize(s.lastVerified.bytes)}`
    : !input.scheduleBridge ? "Not available in this window" : s ? "No verified backup on this computer yet" : "Checking…";
  const schedule = !input.scheduleBridge ? "Not available in this window"
    : !s ? "Checking…"
    : !s.supported ? s.checking ? SCHEDULE_CHECKING : "Needs a supported desktop app"
    : s.enabled
      ? `On · daily at ${s.schedule.time ?? "?"} (${s.schedule.timezone ?? "?"})${s.schedule.closedApp === true ? ", also while Murage is closed" : ""}`
      : "Off";
  let offsite = !input.remoteBridge ? "Not available in this window" : !r ? "Checking…" : !r.supported ? r.checking ? SCHEDULE_CHECKING : "Not available in this app" : offsiteLabels[r.state] ?? "Needs review";
  if (r?.supported && r.configured) {
    if (r.lastUpload?.state === "verified") offsite += " · last copy verified";
    if (r.automaticUpload?.enabled && r.automaticUpload.state === "enabled") offsite += " · automatic uploads on";
  }
  const attention: string[] = [];
  if (input.scheduleStale) attention.push("Schedule status couldn't be refreshed.");
  if (input.scheduleFailure) attention.push(input.scheduleFailure);
  // A daily backup held up by a waiting card names who it waits for, and
  // after its catch-up time passes, why it was skipped (0.1.60 Linux D6).
  const held = s?.enabled && s.heldBy?.occasion === "daily" && s.heldBy.bots.length ? s.heldBy : null;
  if (held) attention.push(backupWaitingSentence(held.bots, s?.phase === "skipped" ? "skipped" : "daily"));
  else if (s?.error) attention.push(scheduleError(s.error));
  // Said before anything is set up: where Murage can't reopen itself, no
  // backup can ever run, so the page says so instead of offering setup.
  if (s?.relaunchBlocked && s.relaunchBlocked !== s.error) attention.push(scheduleError(s.relaunchBlocked));
  if (s?.pending) attention.push("A backup is running. Settings are locked until it finishes.");
  else if (s && scheduleNeedsReview(s.phase)) {
    attention.push(schedulePhase(s.phase));
    // Say WHY. Without this the page only ever said a backup had not
    // finished, which left the person with nothing to act on.
    if (s.captureFailure) attention.push(captureFailureSentence(s.captureFailure));
  }
  else if (s?.phase === "skipped" && !held) attention.push("Backup skipped. Murage was busy, so no backup was taken. Finish current work, then try again.");
  // The owner finished setup and the page still read "No verified backup on
  // this computer yet", with nothing saying what to do about it. A schedule
  // with no backup behind it is the state that makes someone think they are
  // protected when they are not, so it is named here as something to act on.
  if (s?.enabled && !s.lastVerified && !s.pending && !scheduleNeedsReview(s.phase)) attention.push("Daily backups are on, but no backup has been taken yet. Use Back up now to take the first one.");
  if (s?.schedule.preUpgrade && s.preUpgradeSupported !== true) attention.push("Pre-upgrade backups are unavailable in this app.");
  if (s?.lastClosedResult?.status === "needs-review") attention.push("The last backup taken while Murage was closed needs review.");
  // Linux runs the closed-app backup in your desktop session; with nobody
  // signed in there is no display for it, and it waits instead of crashing.
  else if (s?.lastClosedResult?.status === "unavailable" && s.lastClosedResult.reason === "capability-unavailable" && !(s.lastVerified && s.lastVerified.verifiedAt >= s.lastClosedResult.at)) attention.push("A backup was due while Murage was closed, but it couldn't start because you weren't signed in to your desktop. It runs the next time you are, or when you open Murage.");
  if (input.closedStale) attention.push("Background job status couldn't be refreshed.");
  if (input.closed?.state === "disabled-removal-pending") attention.push("Removing the background job still needs attention.");
  else if (s?.schedule.closedApp === true && closedVolumeSentence(input.closed?.blocked)) attention.push(closedVolumeSentence(input.closed?.blocked)!);
  else if (s?.lastClosedResult?.status === "unavailable" && s.lastClosedResult.reason === "volume-unreadable") attention.push(CLOSED_VOLUME_SENTENCES.app);
  else if (s?.schedule.closedApp === true && input.closed?.blocked === "app-file-shared") attention.push(closedAppFileSharedReason(input.closed.appFile));
  else if (s?.schedule.closedApp === true && input.closed?.blocked === "job-wont-run") attention.push(CLOSED_JOB_WONT_RUN_REASON);
  else if (s?.schedule.closedApp === true && input.closed?.blocked === "app-moved") attention.push(CLOSED_JOB_MOVED_REASON);
  else if (s?.schedule.closedApp === true && input.closed?.blocked === "job-outdated") attention.push(CLOSED_JOB_OUTDATED_REASON);
  else if (s?.schedule.closedApp === true && input.closed?.state !== "installed") attention.push("Backing up while Murage is closed isn't set up yet.");
  if (input.remoteStale) attention.push("Off-site status needs a refresh.");
  if (input.remoteFailure) attention.push(input.remoteFailure);
  if (r?.pending) attention.push("Off-site work is in progress.");
  if (r?.supported && (r.state === "needs-review" || r.state === "initializing")) attention.push("The off-site copy needs review.");
  if (r?.serverCheck === "host-key-changed") attention.push("The SFTP server's identity changed since you trusted it. Off-site copies are refused until you check it.");
  if (r?.serverCheck === "key-refused") attention.push("The SFTP server did not accept Murage's key. Add the key to the server again.");
  if (r?.lastUpload?.state === "needs-review") attention.push("The last off-site upload needs review.");
  if (r?.lastUpload?.lockRelease === "unconfirmed") attention.push("Your storage provider didn't confirm the off-site lock was released.");
  if (r?.automaticUpload?.state === "needs-review") attention.push("Automatic off-site uploads are paused for review.");
  if (r?.retention && r.retention.state !== "complete") attention.push("Cleaning up old off-site copies needs review.");
  return { last, schedule, offsite, attention: [...new Set(attention)] };
}

/** Optional bridge methods a newer desktop app may offer. Feature-detected:
 * an older app simply does not show the buttons. */
/** `refused` carries an expected refusal code (a name that already exists, a
 * folder that is not allowed) as a value, so the desktop app does not log it
 * as a crash. */
export type RecoveryKeyResult = { cancelled: true } | { saved: true; label: string; publicKey: string } | { refused: string };
export type BackupModeBridge = NonNullable<NonNullable<Window["muragebox"]>["backup"]> & { createRecoveryKey?(): Promise<RecoveryKeyResult>; saveRecoveryKeyCopy?(): Promise<RecoveryKeyResult> };
/** What one act of setup reports back: the usual status, plus the key it made
 * for the person so the page can offer to keep a copy of it. */
export type BackupSetupResult = (BackupScheduleStatus | { cancelled: true }) & { created?: { label: string; publicKey: string | null; folder: string }; refused?: string };
export type BackupScheduleBridge = NonNullable<NonNullable<Window["muragebox"]>["backupSchedule"]> & { runNow?(revision: number): Promise<BackupScheduleStatus>; clearReview?(revision: number): Promise<BackupScheduleStatus>; setUp?(options?: { existingKey?: boolean }): Promise<BackupSetupResult> };

/** Keeps only the label, the folder's own name and a well-formed public key
 * from a setup answer. A path or a secret is never carried into the page. */
export function createdKeyNote(value: unknown): { label: string; publicKey: string | null; folder: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  // eslint-disable-next-line no-control-regex -- a label with control characters is refused
  const text = (input: unknown) => typeof input === "string" && input.trim() && input.length <= 255 && !/[\x00-\x1f\x7f]/.test(input) ? input : null;
  const label = text(v.label), folder = text(v.folder);
  if (!label || !folder) return null;
  return { label, folder, publicKey: typeof v.publicKey === "string" && /^age1[02-9ac-hj-np-z]{50,100}$/.test(v.publicKey) ? v.publicKey : null };
}

/** Keeps only the display label and a well-formed age public key. Anything
 * else the host returns is dropped; a malformed answer is not a success. */
export function recoveryKeyResult(value: unknown): { cancelled: true } | { saved: true; label: string; publicKey: string | null } {
  if (!value || typeof value !== "object") throw Error("Invalid recovery key result");
  const v = value as Record<string, unknown>;
  if (v.cancelled === true) return { cancelled: true };
  if (v.refused !== undefined) {
    if (typeof v.refused !== "string" || !/^BACKUP_[A-Z_]{1,64}$/.test(v.refused)) throw Error("Invalid recovery key result");
    throw Error(v.refused);
  }
  // eslint-disable-next-line no-control-regex -- a label with control characters is refused
  if (v.saved !== true || typeof v.label !== "string" || !v.label.trim() || v.label.length > 255 || /[\x00-\x1f\x7f]/.test(v.label)) throw Error("Invalid recovery key result");
  const publicKey = typeof v.publicKey === "string" && /^age1[02-9ac-hj-np-z]{50,100}$/.test(v.publicKey) ? v.publicKey : null;
  return { saved: true, label: v.label, publicKey };
}

export const SETUP_FIRST_BACKUP_RUNNING = "Taking your first backup now. Murage closes and reopens its own window to do it, and comes back by itself.";
export const SETUP_NO_FIRST_BACKUP = "Daily backups are on, but this desktop app can't take the first one for you. Use Back up now so you actually have a backup, and keep a copy of your recovery key.";
/** A first backup that could not start. Never phrased so it reads as though a
 * backup exists: the whole point of taking one during setup is that "backups
 * are on" and "I have a backup" stop being different things. */
export function firstBackupError(cause: unknown, waiting?: readonly BackupWaitingBot[]): string {
  if (waiting?.length) return `Daily backups are on, but nothing has been backed up yet. ${backupWaitingSentence(waiting, "manual")}`;
  return `Daily backups are on, but the first backup couldn't start. ${runNowError(cause)} Nothing has been backed up yet. Use Back up now when you can.`;
}
const waitingOnYou = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause ?? "")).includes("BACKUP_WAITING_ON_YOU");

/** What one act of setup did, for the page to react to. */
export type BackupSetupOutcome =
  | { state: "cancelled" }
  | { state: "needs-schedule" }
  | { state: "capturing" }
  | { state: "no-first-backup" }
  | { state: "first-backup-failed"; message: string };

export interface BackupSetupSteps {
  applyStatus(next: BackupScheduleStatus): void;
  createdKey(note: { label: string; publicKey: string | null; folder: string }): void;
  notice(text: string): void;
}

/** Setting up backups, end to end: choose the folder (one dialog in the
 * desktop app), take the key Murage wrote, turn the schedule on, and then
 * TAKE THE FIRST BACKUP.
 *
 * The last step is the point. Before it, finishing setup left a schedule with
 * nothing behind it and a page that said "No verified backup on this computer
 * yet" — which reads as success and protects nobody. The confirmation the
 * person already answered in the desktop dialog is the consent for this: it is
 * exactly where they agree to Murage closing and reopening its own window to
 * take a backup, so no second question is asked here.
 *
 * Hard failures throw, so the page shows them where every other schedule
 * failure appears. */
export async function completeBackupSetup(bridge: BackupScheduleBridge, options: { existingKey?: boolean } | undefined, steps: BackupSetupSteps): Promise<BackupSetupOutcome> {
  if (!bridge.setUp) throw Error("BACKUP_UNAVAILABLE");
  const answer = await bridge.setUp(options);
  // The desktop app answers an expected refusal (a name already taken, a
  // folder that may not hold the key) as a value so it is not logged as a
  // crash. It is still a failure here.
  const refused = (answer as { refused?: unknown }).refused;
  if (refused !== undefined) {
    if (typeof refused !== "string" || !/^BACKUP_[A-Z_]{1,64}$/.test(refused)) throw Error("INVALID_BACKUP_SETUP_RESULT");
    throw Error(refused);
  }
  const note = createdKeyNote((answer as { created?: unknown }).created);
  if (note) steps.createdKey(note);
  if ("cancelled" in answer && answer.cancelled === true) {
    steps.notice(note ? `Setup was cancelled, so nothing was turned on. Your recovery key ${note.label} was made and left in ${note.folder}.` : "Setup cancelled. Nothing was changed.");
    return { state: "cancelled" };
  }
  const next = answer as BackupScheduleStatus;
  steps.applyStatus(next);
  const saved = scheduleDraft(next.schedule);
  const choice = enabledSchedule({ ...saved, time: saved.time.trim() || DEFAULT_BACKUP_TIME }, next, true);
  if (!choice) { steps.notice("Backup folder and recovery key saved. Choose a time below, then turn on daily backups."); return { state: "needs-schedule" }; }
  const enabled = await bridge.configure(next.revision, { ...choice, allowIdleRestart: true });
  steps.applyStatus(enabled);
  if (!enabled.enabled) { steps.notice("Settings saved; daily backups are still off."); return { state: "needs-schedule" }; }
  if (!bridge.runNow) { steps.notice(SETUP_NO_FIRST_BACKUP); return { state: "no-first-backup" }; }
  steps.notice(SETUP_FIRST_BACKUP_RUNNING);
  try { steps.applyStatus(await bridge.runNow(enabled.revision)); }
  // The schedule stays on — it is correctly configured — but nothing here may
  // claim a backup exists.
  catch (cause) {
    // Name who the first backup is waiting for; the status carries it.
    let waiting: readonly BackupWaitingBot[] | undefined;
    if (waitingOnYou(cause)) try { const now = await bridge.status(); steps.applyStatus(now); waiting = now.heldBy?.bots; } catch { /* the plain sentence below still says what to do */ }
    return { state: "first-backup-failed", message: firstBackupError(cause, waiting) };
  }
  return { state: "capturing" };
}

/** "Back up now" failures: the three named cases, then the existing schedule
 * messages, which stay generic for anything unrecognised. */
export function runNowError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  if (code.includes("BACKUP_WORK_ACTIVE")) return "Finish or stop current work first.";
  if (code.includes("BACKUP_WAITING_ON_YOU")) return "A bot is waiting for your answer. Answer it, or end that run, then back up again.";
  if (code.includes("BACKUP_BUSY")) return "A backup is already running.";
  // Never phrase this as something the person does. The old wording — "Turn on
  // daily backups once to allow Murage to close and reopen the window" — was
  // read as an instruction and Murage was quit during a live recovery.
  if (code.includes("BACKUP_SCHEDULE_CONSENT_REQUIRED")) return "Backups aren't switched on yet. Turn them on first: Murage takes a backup by closing and reopening its own window, and Murage does that itself, so you never need to quit it.";
  return scheduleError(cause);
}

/** Recovery-key failures (creating one, or saving a copy), named by the host's error code. Unknown
 * codes stay generic and never echo host text. */
export function recoveryKeyError(cause: unknown, fallback = "The recovery key could not be created. Nothing was changed. Try again."): string {
  const code = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const messages: [string, string][] = [
    ["BACKUP_RECOVERY_KEY_MUST_BE_INDEPENDENT", "Save the recovery key outside the Murage data folder. Nothing was saved."],
    ["BACKUP_RECOVERY_KEY_INSIDE_DESTINATION", "Save the recovery key outside your backup folder. Nothing was saved."],
    ["BACKUP_RECOVERY_KEY_EXISTS", "A file with that name already exists. Choose a new name; nothing was replaced."],
    ["BACKUP_RECOVERY_KEY_UNKNOWN", "Murage doesn't know where your recovery key is in this window. Open Backups again, then save the copy."],
    ["BACKUP_RECOVERY_KEY_LOCATION_INVALID", "That location can't be used. Choose another folder; nothing was saved."],
    ["BACKUP_RECOVERY_KEY_WRITE_FAILED", "The key could not be written or checked, so nothing was saved. Try again."],
    ["BACKUP_RECOVERY_KEY_UNVERIFIED", "The key could not be written or checked, so nothing was saved. Try again."],
    ["BACKUP_BINDINGS_UNAVAILABLE", "Backup settings can't be read right now. Refresh status, then try again."],
    ["BACKUP_BUSY", "A backup is running. Try again when it finishes."],
    ["BACKUP_UNAVAILABLE", "Recovery keys can't be created in this app. A supported desktop app is required."],
  ];
  for (const [key, message] of messages) if (code.includes(key)) return message;
  return fallback;
}
