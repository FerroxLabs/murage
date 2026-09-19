import { backupScheduleSchema,backupClosedResultSchema, type BackupSchedule } from "../../shared/backup-schedule";

export interface ScheduleDraft { time: string; timezone: string; catchup: string; size: string; duration: string; preUpgrade:boolean; closedApp:boolean }
const fields = { catchup: ["catchupMs", 3600000], size: ["maxBytes", 1024 ** 3], duration: ["maxDurationMs", 60000] } as const;
/** First-setup limits, shown filled in so setup needs no guesswork: a Mac
 * asleep at the backup time still catches up within the day, the size cap
 * stays well under the 1,024 GB ceiling, and the run time is the longest
 * allowed. Nothing is saved until daily backups are turned on. */
export const FIRST_SETUP_LIMITS = { catchup: "12", size: "50", duration: "30" } as const;
export function scheduleDraft(schedule: BackupSchedule): ScheduleDraft {
  return { time: schedule.time ?? "", timezone: schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,preUpgrade:schedule.preUpgrade,closedApp:schedule.closedApp===true,
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
    "needs-review": "Backup needs review; automatic retry is paused","install-requested":"Update installation requested","upgrade-complete":"Update completed after backup","upgrade-cancelled":"Update cancelled" };
  return labels[phase] ?? "Status needs review. Refresh to check the backup.";
}
export function scheduleError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const messages: Record<string, string> = {
    BACKUP_CLOSED_UNAVAILABLE:"Register the closed-app job in this supported desktop session before enabling closed-app backups.",
    BACKUP_CLOSED_CONSENT_REQUIRED:"Confirm closed-app permission and idle-restart consent before enabling.",
    BACKUP_CLOSED_REVIEW_REQUIRED:"The closed-app job needs review. Refresh status before trying again; saved backup data is unchanged.",
    CLOSED_JOB_REVIEW_REQUIRED:"The closed-app job needs review. Refresh status before trying again; saved backup data is unchanged.",
    BACKUP_BUSY: "Backup work is in progress. Wait, then refresh status.",
    BACKUP_WORK_ACTIVE: "Work is still active. Scheduling will wait for an idle workspace.",
    BACKUP_SCHEDULE_CHANGED: "Settings changed. The latest saved state is shown after refresh; review your draft before trying again.",
    BACKUP_REFERENCE_CHANGED: "A selected destination or recovery key changed. Disable the schedule, then choose references again when no transfer is active.",
    BACKUP_SCHEDULE_CONSENT_REQUIRED: "Confirm idle-restart consent before enabling the schedule.",
    BACKUP_REVIEW_REQUIRED: "Backup needs review. Automatic retry is paused; preserve the existing backup evidence.",
    BACKUP_SCHEDULE_REVIEW_REQUIRED: "Backup needs review. Automatic retry is paused; preserve the existing backup evidence.",
    BACKUP_HANDOFF_DEFERRED: "Backup restart was deferred. Finish active work and refresh status.",
    BACKUP_RELEASE_UNCONFIRMED: "Workspace shutdown could not be confirmed. Preserve the current workspace and refresh status.",
    BACKUP_RELAUNCH_BLOCKED: "Murage can't restart itself on this computer, so backups that reopen Murage can't run. Reinstalling Murage usually fixes this.",
    BACKUP_UNAVAILABLE: "Scheduled backup is unavailable in this app. A supported packaged app and verified backup tool are required.",
    INVALID_BACKUP_SCHEDULE: "Check the time, timezone and backup budgets before enabling.",
  };
  for (const [key, value] of Object.entries(messages)) if (code.includes(key)) return value;
  if (/BACKUP_(BINDINGS|DESTINATION|IDENTITY)/.test(code)) return "Choose the destination and an independently saved age recovery key again when the schedule is disabled and no transfer is active. No key is created here.";
  return "Backup settings could not be updated. Your data is preserved. Refresh status before trying again.";
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
