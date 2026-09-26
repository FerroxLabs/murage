import { backupScheduleSchema,backupClosedResultSchema, type BackupSchedule } from "../../shared/backup-schedule";

export interface ScheduleDraft { time: string; timezone: string; catchup: string; size: string; duration: string; preUpgrade:boolean; closedApp:boolean }
const fields = { catchup: ["catchupMs", 3600000], size: ["maxBytes", 1024 ** 3], duration: ["maxDurationMs", 60000] } as const;
/** First-setup limits, shown filled in so setup needs no guesswork: a Mac
 * asleep at the backup time still catches up within the day, the size cap
 * stays well under the 1,024 GB ceiling, and the run time is the longest
 * allowed. Nothing is saved until daily backups are turned on. */
export const FIRST_SETUP_LIMITS = { catchup: "12", size: "50", duration: "30" } as const;
/** Filled in so setting up backups never stalls on an empty time field. Early
 * enough to be a quiet hour, and the 12-hour catch-up above means a computer
 * that was asleep still takes the day's backup when it wakes. */
export const DEFAULT_BACKUP_TIME = "02:00";
export function scheduleDraft(schedule: BackupSchedule): ScheduleDraft {
  return { time: schedule.time ?? DEFAULT_BACKUP_TIME, timezone: schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,preUpgrade:schedule.preUpgrade,closedApp:schedule.closedApp===true,
    catchup: schedule.catchupMs === undefined ? FIRST_SETUP_LIMITS.catchup : String(schedule.catchupMs / 3600000),
    size: schedule.maxBytes === undefined ? FIRST_SETUP_LIMITS.size : String(schedule.maxBytes / 1024 ** 3),
    duration: schedule.maxDurationMs === undefined ? FIRST_SETUP_LIMITS.duration : String(schedule.maxDurationMs / 60000) };
}
export function enabledSchedule(draft: ScheduleDraft, status: BackupScheduleStatus, consent: boolean): BackupSchedule | null {
  if (!consent || !status.refs || !status.supported || status.pending || status.enabled || scheduleNeedsReview(status.phase) || ((draft.preUpgrade||status.schedule.preUpgrade)&&status.preUpgradeSupported!==true)) return null;
  if(draft.closedApp&&status.closedAppSupported!==true)return null;
  const values: Record<string, number> = {};
  const saved = scheduleDraft(status.schedule);
  for (const [field, [key, unit]] of Object.entries(fields) as [keyof typeof fields, readonly ["catchupMs" | "maxBytes" | "maxDurationMs", number]][]) {
    if (!draft[field].trim()) return null;
    // Preserve exact saved integers even when decimal display cannot round-trip.
    values[key] = draft[field] === saved[field] && status.schedule[key] !== undefined ? status.schedule[key]! : Number(draft[field]) * unit;
  }
  const parsed = backupScheduleSchema.safeParse({ enabled: true, preUpgrade:draft.preUpgrade,...(draft.closedApp||status.schedule.closedApp!==undefined?{closedApp:draft.closedApp}:{}),
    installationRef: status.refs.installationRef, destinationRef: status.refs.destinationRef, recoveryRef: status.refs.recoveryRef,
    time: draft.time, timezone: draft.timezone.trim(), ...values,
    selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } });
  return parsed.success ? parsed.data : null;
}
export function scheduleNeedsReview(phase: string) {
  return ["claiming", "capturing", "needs-review", "handoff-prepared", "handoff-armed", "offline-claimed", "return-pending","install-requested"].includes(phase)
    || !["idle", "due", "waiting-idle", "waiting-backup-mode", "local-verified", "skipped", "returned","upgrade-complete","upgrade-cancelled"].includes(phase);
}
export function schedulePhase(phase: string): string {
  const labels: Record<string, string> = { idle: "No backup in progress", due: "Backup due", "waiting-idle": "Waiting for the workspace to be idle",
    "waiting-backup-mode": "Waiting for Backup mode", "handoff-prepared": "Preparing the backup restart", "handoff-armed": "Preparing the backup restart",
    claiming: "Backup in progress", "offline-claimed": "Backup in progress", capturing: "Backup in progress", "return-pending": "Preparing to reopen Murage",
    returned: "The last backup finished and Murage reopened", "local-verified": "Local backup verified", skipped: "Backup skipped",
    "needs-review": "The last backup didn't finish; backups are paused until you clear it","install-requested":"Update installation requested","upgrade-complete":"Update completed after backup","upgrade-cancelled":"Update cancelled" };
  return labels[phase] ?? "Status needs review. Refresh to check the backup.";
}
export function scheduleError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const messages: Record<string, string> = {
    BACKUP_CLOSED_UNAVAILABLE:"Backups while Murage is closed need the background job first. Tick \"Also back up when Murage is closed\" again, then try once more.",
    BACKUP_CLOSED_CONSENT_REQUIRED:"Murage still needs your permission: to back up while it's closed, and to close and reopen its own window when it's idle. Murage does that itself, so you never need to quit it.",
    BACKUP_CLOSED_JOB_WONT_RUN:"Murage set up its background job, but your system couldn't start it, so backups run only while Murage is open. Tick \"Also back up when Murage is closed\" again to retry.",
    BACKUP_CLOSED_REVIEW_REQUIRED:"The closed-app job needs review. Refresh status before trying again; saved backup data is unchanged.",
    CLOSED_JOB_REVIEW_REQUIRED:"The closed-app job needs review. Refresh status before trying again; saved backup data is unchanged.",
    BACKUP_BUSY: "A backup is running. Wait for it to finish, then try again.",
    BACKUP_WORK_ACTIVE: "Work is still active. Scheduling will wait for an idle workspace.",
    BACKUP_SCHEDULE_CHANGED: "Settings changed. The latest saved state is shown after refresh; review your draft before trying again.",
    BACKUP_REFERENCE_CHANGED: "Your backup folder or recovery key has moved or changed. Turn off daily backups, then choose the backup folder and your recovery key again.",
    BACKUP_SCHEDULE_CONSENT_REQUIRED: "Murage still needs your permission to close and reopen its own window when it's idle, so it can take the backup. Murage does that itself, so you never need to quit it.",
    BACKUP_REVIEW_REQUIRED: "The last backup didn't finish, so daily backups are paused. Choose Clear and try again. Your existing backups are kept.",
    BACKUP_SCHEDULE_REVIEW_REQUIRED: "The last backup didn't finish, so daily backups are paused. Choose Clear and try again. Your existing backups are kept.",
    BACKUP_HANDOFF_DEFERRED: "The backup didn't start because Murage was busy. Finish what is running, then try again.",
    BACKUP_WAITING_ON_YOU: "The backup can't start because a bot is waiting for your answer. Answer it, or end that run, then back up again.",
    BACKUP_RELEASE_UNCONFIRMED: "Murage couldn't close everything it needed to for the backup. Your workspace is unchanged. Wait a moment, then try again.",
    BACKUP_RELAUNCH_BLOCKED: "Murage can't restart itself on this computer, so backups that reopen Murage can't run. Reinstalling Murage usually fixes this.",
    BACKUP_RELAUNCH_APPIMAGE_MISSING: "Murage can't reopen itself because its AppImage file was moved or deleted while Murage was open, so backups can't run. Close Murage, then open it again from the AppImage file.",
    BACKUP_ELEVATED: "Murage is running as administrator, and backups can't run that way. Close Murage, open it normally, then try again.",
    BACKUP_UNAVAILABLE: "Backups aren't available in this copy of Murage. Install Murage from its download page, then try again.",
    INVALID_BACKUP_SCHEDULE: "Check the time, time zone and the backup limits under Advanced, then try again.",
  };
  for (const [key, value] of Object.entries(messages)) if (code.includes(key)) return value;
  if (/BACKUP_(BINDINGS|DESTINATION|IDENTITY)/.test(code)) return "Turn off daily backups and wait for any upload to finish, then choose the backup folder and your recovery key again. No new key is made here.";
  return "Backup settings could not be updated. Your data is preserved. Refresh status before trying again.";
}
/** What the schedule card says on its own, over and above the page summary.
 *
 * The Backups page shows "Needs attention" above this card and the card's own
 * line inside it, and both were fed the same status error, so a refusal — an
 * elevated app on Windows, most visibly — was printed twice on one screen in
 * the same words. The summary is the page's one list of what needs doing, so
 * anything it already says is not repeated here; an error it does not carry,
 * such as one raised by another part of the page, still appears beside the
 * controls it applies to. */
export function scheduleCardNotice(areaError: string | null, statusError: string | null | undefined, attention: readonly string[] = []): string | null {
  const text = areaError ?? (statusError ? scheduleError(statusError) : null);
  if (!text) return null;
  return attention.includes(text) ? null : text;
}
export function closedJobLabel(state:BackupClosedStatus["state"]|undefined){
 const labels:Record<BackupClosedStatus["state"],string>={unconfigured:"No closed-app job prepared",staged:"Job prepared, not registered",installed:"Job registration confirmed",disabled:"Closed-app job removed","disabled-removal-pending":"Closed-app job removal pending",unavailable:"Closed-app scheduling unavailable"};
 return state?labels[state]??labels.unavailable:"Checking closed-app job status…";
}
export function closedResultLabel(value:unknown){
 const parsed=backupClosedResultSchema.safeParse(value);if(!parsed.success)return null;
 const labels={disabled:"Scheduling was disabled","not-due":"No backup was due",busy:"Workspace was busy",verified:"Backup verified","needs-review":"Backup needs review",unavailable:"Backup unavailable"};
 return{label:labels[parsed.data.status],at:parsed.data.at};
}
