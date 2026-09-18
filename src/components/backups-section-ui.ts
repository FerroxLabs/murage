// Pure helpers for Settings → Backups. Everything here reads the status the
// existing bridges already return; nothing adds a call or relaxes a check.
import type { BackupRemoteStatus } from "../../server/backup-remote-host";
import { scheduleError, scheduleNeedsReview, schedulePhase } from "./backup-schedule-ui";

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
    : !s.supported ? "Needs a supported desktop app"
    : s.enabled
      ? `On · daily at ${s.schedule.time ?? "?"} (${s.schedule.timezone ?? "?"})${s.schedule.closedApp === true ? ", also while Murage is closed" : ""}`
      : "Off";
  let offsite = !input.remoteBridge ? "Not available in this window" : !r ? "Checking…" : !r.supported ? "Not available in this app" : offsiteLabels[r.state] ?? "Needs review";
  if (r?.supported && r.configured) {
    if (r.lastUpload?.state === "verified") offsite += " · last copy verified";
    if (r.automaticUpload?.enabled && r.automaticUpload.state === "enabled") offsite += " · automatic uploads on";
  }
  const attention: string[] = [];
  if (input.scheduleStale) attention.push("Schedule status couldn't be refreshed.");
  if (input.scheduleFailure) attention.push(input.scheduleFailure);
  else if (s?.error) attention.push(scheduleError(s.error));
  if (s?.pending) attention.push("A backup is running. Settings are locked until it finishes.");
  else if (s && scheduleNeedsReview(s.phase)) attention.push(schedulePhase(s.phase));
  if (s?.schedule.preUpgrade && s.preUpgradeSupported !== true) attention.push("Pre-upgrade backups are unavailable in this app.");
  if (s?.lastClosedResult?.status === "needs-review") attention.push("The last backup taken while Murage was closed needs review.");
  if (input.closedStale) attention.push("Background job status couldn't be refreshed.");
  if (input.closed?.state === "disabled-removal-pending") attention.push("Removing the background job still needs attention.");
  else if (s?.schedule.closedApp === true && input.closed?.state !== "installed") attention.push("Backing up while Murage is closed isn't set up yet.");
  if (input.remoteStale) attention.push("Off-site status needs a refresh.");
  if (input.remoteFailure) attention.push(input.remoteFailure);
  if (r?.pending) attention.push("Off-site work is in progress.");
  if (r?.supported && (r.state === "needs-review" || r.state === "initializing")) attention.push("The off-site copy needs review.");
  if (r?.lastUpload?.state === "needs-review") attention.push("The last off-site upload needs review.");
  if (r?.lastUpload?.lockRelease === "unconfirmed") attention.push("Your storage provider didn't confirm the off-site lock was released.");
  if (r?.automaticUpload?.state === "needs-review") attention.push("Automatic off-site uploads are paused for review.");
  if (r?.retention && r.retention.state !== "complete") attention.push("Cleaning up old off-site copies needs review.");
  return { last, schedule, offsite, attention: [...new Set(attention)] };
}

/** Optional bridge methods a newer desktop app may offer. Feature-detected:
 * an older app simply does not show the buttons. */
export type RecoveryKeyResult = { cancelled: true } | { saved: true; label: string; publicKey: string };
export type BackupModeBridge = NonNullable<NonNullable<Window["muragebox"]>["backup"]> & { createRecoveryKey?(): Promise<RecoveryKeyResult> };
export type BackupScheduleBridge = NonNullable<NonNullable<Window["muragebox"]>["backupSchedule"]> & { runNow?(revision: number): Promise<BackupScheduleStatus> };

/** Keeps only the display label and a well-formed age public key. Anything
 * else the host returns is dropped; a malformed answer is not a success. */
export function recoveryKeyResult(value: unknown): { cancelled: true } | { saved: true; label: string; publicKey: string | null } {
  if (!value || typeof value !== "object") throw Error("Invalid recovery key result");
  const v = value as Record<string, unknown>;
  if (v.cancelled === true) return { cancelled: true };
  // eslint-disable-next-line no-control-regex -- a label with control characters is refused
  if (v.saved !== true || typeof v.label !== "string" || !v.label.trim() || v.label.length > 255 || /[\x00-\x1f\x7f]/.test(v.label)) throw Error("Invalid recovery key result");
  const publicKey = typeof v.publicKey === "string" && /^age1[02-9ac-hj-np-z]{50,100}$/.test(v.publicKey) ? v.publicKey : null;
  return { saved: true, label: v.label, publicKey };
}

/** "Back up now" failures: the three named cases, then the existing schedule
 * messages, which stay generic for anything unrecognised. */
export function runNowError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  if (code.includes("BACKUP_WORK_ACTIVE")) return "Finish or stop current work first.";
  if (code.includes("BACKUP_BUSY")) return "A backup is already running.";
  if (/REQUIRES?_ENABLED|ENABLED_REQUIRED|NOT_ENABLED|SCHEDULE_DISABLED|SCHEDULE_OFF/.test(code)) return "Turn on daily backups first.";
  return scheduleError(cause);
}
