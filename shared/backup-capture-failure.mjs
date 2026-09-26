/** Why a scheduled backup stopped, in words a person can act on.
 *
 * A backup runs with the workspace closed, so the only thing the app can
 * carry back out of it is a finite stage and a finite code. Everything here
 * is a lookup over those two closed sets: no message, path, filename or
 * secret from the failure ever reaches this module, and nothing it returns
 * can contain one.
 *
 * Shared because the same sentence has to appear in three places that cannot
 * import each other: the desktop main process (the Backup mode page), the
 * recovery window's renderer, and the workspace's Backups page.
 *
 * 0.1.60 (audit A-01): when a refusal is about one item in the data folder,
 * the sentence also names that item, as a path inside the data folder
 * (captureFailurePath). The person can't fix a file they can't find. Nothing
 * outside the data folder is ever named. */

/** The step the backup was on. Anything else reads as "unknown". */
export const BACKUP_CAPTURE_STAGES = Object.freeze([
  "precondition", "references", "claim", "capture", "artifact-readback", "receipt-commit", "return",
]);

/** Every refusal the backup path is allowed to name. A code outside this set
 * is reported as UNKNOWN_CAPTURE_FAILURE rather than passed through, because
 * an engine's own error text is not ours to publish. */
export const BACKUP_CAPTURE_CODES = Object.freeze([
  // handoff and references
  "BACKUP_HANDOFF_REJECTED", "BACKUP_UNAVAILABLE", "BACKUP_REFERENCE_CHANGED",
  "BACKUP_BINDINGS_INVALID", "BACKUP_BINDINGS_UNAVAILABLE", "BACKUP_RECEIPT_MISMATCH",
  // the recovery worker
  "RECOVERY_WORKER_TIMEOUT", "INVALID_RECOVERY_INPUT", "INVALID_RECOVERY_RESULT", "RECOVERY_INPUT_TIMEOUT",
  "RECOVERY_OPERATION_FAILED", "RECOVERY_OWNERSHIP_REQUIRED", "INVALID_BACKUP_BUDGET",
  // budgets
  "BACKUP_LIMIT_EXCEEDED", "ARCHIVE_LIMIT_EXCEEDED", "INVALID_BACKUP_LIMITS", "INVALID_ARCHIVE_LIMITS", "SNAPSHOT_LIMIT_EXCEEDED", "BACKUP_WINDOWS_SIZE_LIMIT",
  // encryption
  "SNAPSHOT_CANCELLED", "AGE_TOOL_TIMEOUT", "AGE_PROCESS_FAILED", "AGE_PROCESS_CLOSE_UNCONFIRMED", "AGE_TOOL_UNVERIFIED",
  "ENCRYPTED_BACKUP_FAILED", "BACKUP_DISK_FULL", "BACKUP_FOLDER_NOT_WRITABLE", "BACKUP_FILE_IN_USE", "BACKUP_FOLDER_UNUSABLE",
  // what was captured
  "FIDELITY_READBACK_MISMATCH", "FIDELITY_RECOVERY_MISMATCH", "INVALID_FIDELITY_MANIFEST", "ARCHIVE_CHANGED", "UNSAFE_ARCHIVE_FILE",
  // the snapshot's own refusals (server/installation-fidelity-snapshot.ts).
  // These were missing, so the single most common real cause — a file in the
  // data folder that Murage does not recognise — reached the user as
  // "UNKNOWN_CAPTURE_FAILURE" and told them nothing.
  "BACKUP_UNCLASSIFIED_COMPONENT", "BACKUP_REQUIRED_COMPONENT_MISSING", "BACKUP_SELECTED_COMPONENT_UNAVAILABLE",
  "NONPORTABLE_SNAPSHOT_PATH", "SOURCE_CHANGED", "UNSAFE_ARCHIVE_PATH", "UNSAFE_SNAPSHOT_ENTRY", "VM_WORKSPACE_BACKUP_UNSUPPORTED",
  // Murage's own records refused while they were copied (audit A-04: these
  // reached the page as "Murage couldn't say why").
  "INVALID_INSTALLATION_RECORDS", "INVALID_CONFIG_COMPONENT", "INVALID_JSON_COMPONENT", "INVALID_ROSTER_COMPONENT",
  "INVALID_WEBHOOK_COMPONENT", "JSON_COMPONENT_TOO_LARGE", "STATE_SNAPSHOT_FAILED", "INSTALLATION_MISSING", "INVALID_SNAPSHOT_LIMITS",
  // the conversation database's consistent copy
  "DATABASE_SNAPSHOT_FAILED", "DATABASE_INTEGRITY_FAILED", "DATABASE_SCHEMA_UNSUPPORTED", "DATABASE_UNREADABLE",
  "UNSAFE_DATABASE_FILE", "UNSUPPORTED_DATABASE_SIZE", "INVALID_MESSAGE_IDENTITY", "INVALID_MESSAGE_JSON", "INVALID_ACTIVE_BRANCH",
  // reading the finished file back
  "ARCHIVE_WRITE_FAILED", "INVALID_ARCHIVE_MANIFEST", "ARCHIVE_HASH_MISMATCH", "ARCHIVE_SIZE_MISMATCH", "ARCHIVE_ENTRY_COUNT_MISMATCH",
  "MISSING_ARCHIVE_ENTRY", "UNDECLARED_ARCHIVE_ENTRY", "UNSAFE_ARCHIVE_ENTRY", "MANIFEST_MUST_BE_FIRST", "ARCHIVE_INSPECTION_FAILED",
  "INVALID_DATABASE_MANIFEST", "SNAPSHOT_EPOCH_CLOSED",
  // the encryption tool on this computer
  "AGE_TOOL_PLATFORM_UNQUALIFIED", "INVALID_AGE_PROCESS_LIMITS", "AGE_NATIVE_IDENTITY_REQUIRED", "AGE_NATIVE_RECIPIENT_REQUIRED",
  // the destination
  "INVALID_DESTINATION", "DESTINATION_EXISTS", "DESTINATION_INSIDE_INSTALLATION",
]);

const STAGES = new Set(BACKUP_CAPTURE_STAGES);
const CODES = new Set(BACKUP_CAPTURE_CODES);

const STAGE_WORDS = {
  precondition: "before it started",
  references: "while checking your backup folder and recovery key",
  claim: "while starting the backup",
  capture: "while copying your workspace",
  "artifact-readback": "while checking the file it had just written",
  "receipt-commit": "while recording the finished backup",
  return: "while reopening Murage",
};

const REASONS = {
  BACKUP_UNCLASSIFIED_COMPONENT:
    "There is something in Murage's data folder that Murage doesn't recognise, so it couldn't promise the backup held everything. Move anything you put in that folder somewhere else, then back up again.",
  BACKUP_REQUIRED_COMPONENT_MISSING:
    "Part of your workspace was missing, so the backup would not have been complete. Open Murage normally once, then back up again.",
  BACKUP_SELECTED_COMPONENT_UNAVAILABLE:
    "Murage keeps its own files in part of its data folder, and there is a shortcut there instead of a file, so the backup couldn't copy it. Move the shortcut out of Murage's data folder, then back up again.",
  SOURCE_CHANGED:
    "Your workspace changed while the backup was being taken, so the copy wouldn't have matched. Try again once nothing else is running.",
  NONPORTABLE_SNAPSHOT_PATH:
    "One of Murage's own files has a name a backup can't hold. Move it out of Murage's data folder, then back up again.",
  UNSAFE_ARCHIVE_PATH:
    "One of Murage's own files has a name a backup can't hold. Move it out of Murage's data folder, then back up again.",
  UNSAFE_SNAPSHOT_ENTRY:
    "Something where Murage keeps its own files isn't a plain file, so the backup couldn't copy it. Move it out of Murage's data folder, then back up again.",
  UNSAFE_ARCHIVE_FILE:
    "Murage couldn't check the backup file it had just written, so it won't call it a backup. Check that nothing else writes to your backup folder, then try again.",
  VM_WORKSPACE_BACKUP_UNSUPPORTED:
    "A bot's virtual-machine workspace can't be included in this backup. Turn that computer off for the bot, then back up again.",
  // Only the size can pass its limit now: items past the file limit in a
  // folder of owner work are left out and listed, never a failure.
  BACKUP_LIMIT_EXCEEDED:
    "Your workspace is bigger than the size limit set for backups. Raise the size limit under Backups, Advanced, or clear out large files, then try again.",
  ARCHIVE_LIMIT_EXCEEDED:
    "Your workspace is bigger than the size limit set for backups. Raise the size limit under Backups, Advanced, or clear out large files, then try again.",
  SNAPSHOT_LIMIT_EXCEEDED:
    "Your workspace is bigger than the size limit set for backups. Raise the size limit under Backups, Advanced, or clear out large files, then try again.",
  BACKUP_WINDOWS_SIZE_LIMIT:
    "On Windows one backup can hold up to 20 GB, and your workspace is bigger than that. Move large files out of your bots' folders, then back up again.",
  INVALID_INSTALLATION_RECORDS:
    "One of Murage's own records couldn't be read the way a backup needs, so the backup wasn't made. Open Murage normally once so it tidies the record, then back up again. If it happens again, open the diagnostics folder from Backups.",
  INVALID_CONFIG_COMPONENT:
    "Murage's settings file couldn't be read the way a backup needs, so the backup wasn't made. Open Murage normally once, then back up again. If it happens again, open the diagnostics folder from Backups.",
  INVALID_JSON_COMPONENT:
    "One of Murage's own records is damaged, so the backup wasn't made. Open Murage normally once, then back up again. If it happens again, open the diagnostics folder from Backups.",
  INVALID_ROSTER_COMPONENT:
    "Murage's list of bots couldn't be read the way a backup needs, so the backup wasn't made. Open Murage normally once, then back up again. If it happens again, open the diagnostics folder from Backups.",
  INVALID_WEBHOOK_COMPONENT:
    "Murage's list of webhooks couldn't be read the way a backup needs, so the backup wasn't made. Open Murage normally once, then back up again. If it happens again, open the diagnostics folder from Backups.",
  JSON_COMPONENT_TOO_LARGE:
    "One of Murage's own records has grown too large to back up. Open the diagnostics folder from Backups and send the newest log to support.",
  STATE_SNAPSHOT_FAILED:
    "Murage couldn't copy part of your workspace. Close anything else that might be using Murage's data folder, then back up again.",
  INSTALLATION_MISSING:
    "Murage couldn't find its data folder when the backup started. Open Murage normally once, then back up again.",
  INVALID_SNAPSHOT_LIMITS:
    "The size or time limit set for backups isn't usable. Check both in Backups, then try again.",
  DATABASE_SNAPSHOT_FAILED:
    "Murage couldn't make a consistent copy of your conversations. Close anything else that might be using Murage's data folder, then back up again.",
  DATABASE_INTEGRITY_FAILED:
    "Murage's conversation database failed its own check, so it wasn't copied into a backup. Open the diagnostics folder from Backups and contact support; your data was not changed.",
  DATABASE_SCHEMA_UNSUPPORTED:
    "Murage's conversation database is from a different version of Murage. Open this version of Murage normally once, then back up again.",
  DATABASE_UNREADABLE:
    "Murage couldn't read its conversation database. Close anything else that might be using Murage's data folder, then back up again.",
  UNSAFE_DATABASE_FILE:
    "Murage's conversation database isn't a plain file, so it wasn't copied. Open the diagnostics folder from Backups and contact support.",
  UNSUPPORTED_DATABASE_SIZE:
    "Murage's conversation database is too large to back up. Open the diagnostics folder from Backups and contact support.",
  INVALID_MESSAGE_IDENTITY:
    "A conversation in Murage's database couldn't be read the way a backup needs, so the backup wasn't made. Open the diagnostics folder from Backups and contact support.",
  INVALID_MESSAGE_JSON:
    "A conversation in Murage's database couldn't be read the way a backup needs, so the backup wasn't made. Open the diagnostics folder from Backups and contact support.",
  INVALID_ACTIVE_BRANCH:
    "A conversation in Murage's database couldn't be read the way a backup needs, so the backup wasn't made. Open the diagnostics folder from Backups and contact support.",
  ARCHIVE_WRITE_FAILED:
    "Murage couldn't finish writing the backup file. Nothing in your workspace was changed. Back up again, and if it happens again, open the diagnostics folder from Backups.",
  INVALID_ARCHIVE_MANIFEST:
    "The backup's own contents list couldn't be read back, so the backup wasn't accepted. Try again.",
  ARCHIVE_HASH_MISMATCH:
    "Murage read the finished backup back and it didn't match what it had written. Check that nothing else writes to your backup folder, then try again.",
  ARCHIVE_SIZE_MISMATCH:
    "Murage read the finished backup back and it didn't match what it had written. Check that nothing else writes to your backup folder, then try again.",
  ARCHIVE_ENTRY_COUNT_MISMATCH:
    "Murage read the finished backup back and it didn't match what it had written. Check that nothing else writes to your backup folder, then try again.",
  MISSING_ARCHIVE_ENTRY:
    "Murage read the finished backup back and it didn't match what it had written. Check that nothing else writes to your backup folder, then try again.",
  UNDECLARED_ARCHIVE_ENTRY:
    "Murage read the finished backup back and it didn't match what it had written. Check that nothing else writes to your backup folder, then try again.",
  UNSAFE_ARCHIVE_ENTRY:
    "Murage read the finished backup back and it didn't match what it had written. Check that nothing else writes to your backup folder, then try again.",
  MANIFEST_MUST_BE_FIRST:
    "Murage read the finished backup back and it didn't match what it had written. Check that nothing else writes to your backup folder, then try again.",
  ARCHIVE_INSPECTION_FAILED:
    "Murage couldn't read the finished backup back to check it, so it won't call it a backup. Check that nothing else writes to your backup folder, then try again.",
  INVALID_DATABASE_MANIFEST:
    "Murage read the finished backup back and it didn't match what it had written. Check that nothing else writes to your backup folder, then try again.",
  SNAPSHOT_EPOCH_CLOSED:
    "Murage was still finishing something else when the backup started. Try again in a moment.",
  AGE_TOOL_PLATFORM_UNQUALIFIED:
    "Murage's backup encryption tool isn't available for this kind of computer. Reinstalling Murage usually fixes this.",
  INVALID_AGE_PROCESS_LIMITS:
    "The size or time limit set for backups isn't usable. Check both in Backups, then try again.",
  AGE_NATIVE_IDENTITY_REQUIRED:
    "That file isn't a Murage recovery key. Choose your backup folder and key again in Backups.",
  AGE_NATIVE_RECIPIENT_REQUIRED:
    "That file isn't a Murage recovery key. Choose your backup folder and key again in Backups.",
  SNAPSHOT_CANCELLED:
    "The backup ran out of the time it was given. Raise the time limit in Backups, or try again when the computer is less busy.",
  AGE_TOOL_TIMEOUT:
    "The tool that encrypts your backup didn't finish in time. Try again when the computer is less busy.",
  AGE_PROCESS_FAILED:
    "The tool that encrypts your backup couldn't finish. Check that your recovery key file is still where you chose it, then try again.",
  AGE_PROCESS_CLOSE_UNCONFIRMED:
    "The tool that encrypts your backup didn't confirm it had stopped. Nothing was changed; check the diagnostics folder before trying again.",
  AGE_TOOL_UNVERIFIED:
    "Murage couldn't verify its own backup encryption tool, so it refused to use it. Reinstalling Murage usually fixes this.",
  // The catch-all for a plain file error while writing the backup. It never
  // involves the recovery key, which is only read afterwards to check the file.
  ENCRYPTED_BACKUP_FAILED:
    "Murage couldn't finish writing the backup file. Nothing in your workspace was changed. Back up again, and if it happens again, open the diagnostics folder from Backups.",
  BACKUP_DISK_FULL:
    "The drive ran out of space while the backup was being written. Free up space on the drive that holds your backup folder, then back up again.",
  BACKUP_FOLDER_NOT_WRITABLE:
    "This computer didn't let Murage write a file the backup needed. Check that you can create files in your backup folder and in the folder that holds Murage's data, then back up again.",
  BACKUP_FOLDER_UNUSABLE:
    "Murage couldn't make its private working folder inside your backup folder. Choose a folder on this computer's own drive that you can create files in (not a network, removable or linked folder), then back up again.",
  BACKUP_FILE_IN_USE:
    "Another program was holding a file the backup needed, often antivirus or a sync app. Wait a few minutes, then back up again.",
  BACKUP_REFERENCE_CHANGED:
    "Your backup folder or your recovery key file has moved, changed or is no longer readable. Choose the folder and key again in Backups.",
  BACKUP_BINDINGS_INVALID:
    "Murage's record of your backup folder and key can no longer be read. Choose the folder and key again in Backups.",
  BACKUP_BINDINGS_UNAVAILABLE:
    "Murage couldn't open the private store holding your backup folder and key. Sign in to this computer normally, then try again.",
  BACKUP_RECEIPT_MISMATCH:
    "Murage couldn't confirm the backup file it had just written, so it won't call it a backup. Check that nothing else writes to your backup folder, then try again.",
  FIDELITY_READBACK_MISMATCH:
    "Murage read the finished backup back and it didn't match what it had written. Check that nothing else writes to your backup folder, then try again.",
  FIDELITY_RECOVERY_MISMATCH:
    "Murage read the finished backup back and it didn't match what it had written. Check that nothing else writes to your backup folder, then try again.",
  INVALID_FIDELITY_MANIFEST:
    "The backup's own contents list couldn't be read back, so the backup wasn't accepted. Try again.",
  ARCHIVE_CHANGED:
    "The backup file changed while Murage was checking it. Check that nothing else writes to your backup folder, then try again.",
  INVALID_DESTINATION:
    "Your backup folder can't be used. Choose a different folder in Backups.",
  DESTINATION_EXISTS:
    "A file of that name is already in your backup folder. Murage never overwrites a backup; try again.",
  DESTINATION_INSIDE_INSTALLATION:
    "Your backup folder is inside Murage's own data folder. Choose a folder somewhere else in Backups.",
  RECOVERY_WORKER_TIMEOUT:
    "The part of Murage that takes the backup didn't finish in time. Try again when the computer is less busy.",
  RECOVERY_INPUT_TIMEOUT:
    "The part of Murage that takes the backup didn't start in time. Try again when the computer is less busy.",
  RECOVERY_OPERATION_FAILED:
    "The part of Murage that takes the backup stopped without finishing. Your workspace was not changed; try again.",
  RECOVERY_OWNERSHIP_REQUIRED:
    "Another copy of Murage may still be using this workspace. Close it, then try again.",
  INVALID_RECOVERY_INPUT:
    "Murage couldn't hand the backup its settings. Choose your backup folder and key again in Backups.",
  INVALID_RECOVERY_RESULT:
    "The backup didn't report a result Murage could trust, so it wasn't accepted. Try again.",
  INVALID_BACKUP_BUDGET:
    "The size or time limit set for backups isn't usable. Check both in Backups, then try again.",
  INVALID_BACKUP_LIMITS:
    "The size or time limit set for backups isn't usable. Check both in Backups, then try again.",
  INVALID_ARCHIVE_LIMITS:
    "The size or time limit set for backups isn't usable. Check both in Backups, then try again.",
  BACKUP_HANDOFF_REJECTED:
    "The backup request had already expired or been replaced by the time Murage reopened for it. Start the backup again.",
  BACKUP_UNAVAILABLE:
    "Backups aren't available in this copy of Murage. Reinstalling Murage usually fixes this.",
  UNKNOWN_CAPTURE_FAILURE:
    "Murage couldn't say why. Nothing in your workspace was changed. Open the diagnostics folder from Backups if it happens again.",
};

/** A path INSIDE Murage's data folder a refusal is about, or undefined.
 * Relative, "/"-separated, no "..", no control characters, bounded. Anything
 * else (an absolute path, a drive letter, a home folder) is dropped. */
export function captureFailurePath(value) {
  if (typeof value !== "string") return undefined;
  const path = value.replaceAll("\\", "/");
  if (!path || path.length > 1024 || /[\x00-\x1f\x7f]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("~")) return undefined;
  if (path.split("/").some(part => !part || part === "." || part === "..")) return undefined;
  return path;
}

/** Normalize whatever the failure path produced into the two closed sets,
 * plus the item inside the data folder when the refusal names one. */
export function normalizeCaptureFailure(input) {
  if (!input || typeof input !== "object") return null;
  const code = typeof input.code === "string" && (CODES.has(input.code) || input.code === "UNKNOWN_CAPTURE_FAILURE")
    ? input.code : "UNKNOWN_CAPTURE_FAILURE";
  const stage = typeof input.stage === "string" && STAGES.has(input.stage) ? input.stage : "unknown";
  const path = captureFailurePath(input.path);
  return path ? { stage, code, path } : { stage, code };
}

/** One or two sentences naming the step and the reason, and the item in the
 * data folder when there is one. */
export function captureFailureSentence(input) {
  const failure = normalizeCaptureFailure(input);
  if (!failure) return "";
  const where = STAGE_WORDS[failure.stage];
  const item = failure.path ? ` The item is ${failure.path} in Murage's data folder.` : "";
  return `The last backup stopped ${where ?? "before it could finish"}. ${REASONS[failure.code] ?? REASONS.UNKNOWN_CAPTURE_FAILURE}${item}`;
}

/** The reason alone, for a page that says the step itself (Backup mode). */
export function captureFailureReason(code, path) {
  const reason = REASONS[typeof code === "string" && CODES.has(code) ? code : "UNKNOWN_CAPTURE_FAILURE"] ?? REASONS.UNKNOWN_CAPTURE_FAILURE;
  const item = captureFailurePath(path);
  return item ? `${reason} The item is ${item} in Murage's data folder.` : reason;
}

/* ------------------------------------------------------------------------
 * The underlying cause, for the log only.
 *
 * The stage and code above are all the window ever shows. When a backup
 * fails for a reason the code alone can't name (a plain filesystem error,
 * the encryption tool exiting), the log also gets a small, redacted record
 * of what actually failed: the step inside the capture, the errno and
 * syscall, and for a tool its exit code and the start of its error output.
 * No path, file name, key or recipient survives the redaction, and the
 * record never reaches the window or the durable backup state.
 * --------------------------------------------------------------------- */

const CAUSE_STEPS = new Set([
  "tool", "private-stage", "offline-open", "stage", "inventory", "manifest", "encrypt",
  "readback", "flush", "publish", "worker",
]);
const CAUSE_TOOLS = new Set(["age", "murage-backup-age"]);

/** Strip anything that could name a place or carry a secret. */
export function redactCauseText(value, max = 200) {
  if (typeof value !== "string") return undefined;
  let text = value
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ")
    .replace(/AGE-SECRET-KEY-1[0-9A-Za-z]+/g, "<key>")
    .replace(/\bage1[0-9a-z]{8,}/g, "<recipient>")
    .replace(/(["'`])[^"'`\r\n]*[\\/][^"'`\r\n]*\1/g, "$1<path>$1")
    .replace(/\\\\[^"'<>|\r\n]*?(?=$|["'<>|\r\n]|:\s|,\s|\s\(|\)\s*$)/g, "<path>")
    .replace(/\b[A-Za-z]:[\\/][^"'<>|\r\n]*?(?=$|["'<>|\r\n]|:\s|,\s|\s\(|\)\s*$)/g, "<path>")
    .replace(/(^|[\s"'(=])\/[^\s"'<>|]+/g, "$1<path>")
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, "<redacted>")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > max) text = text.slice(0, max);
  return text || undefined;
}

/** A plain, bounded, allow-listed record, or null. Re-redacts every string. */
export function normalizeCaptureCause(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const cause = {};
  if (typeof input.step === "string" && CAUSE_STEPS.has(input.step)) cause.step = input.step;
  if (typeof input.errno === "string" && /^E[A-Z0-9_]{1,30}$/.test(input.errno)) cause.errno = input.errno;
  if (typeof input.syscall === "string" && /^[a-z_]{1,20}$/.test(input.syscall)) cause.syscall = input.syscall;
  if (typeof input.code === "string" && /^[A-Z][A-Z0-9_]{0,60}$/.test(input.code)) cause.code = input.code;
  if (typeof input.innerCode === "string" && /^[A-Z][A-Z0-9_]{0,60}$/.test(input.innerCode)) cause.innerCode = input.innerCode;
  if (typeof input.tool === "string" && CAUSE_TOOLS.has(input.tool)) cause.tool = input.tool;
  if (Number.isSafeInteger(input.exitCode) && input.exitCode >= -(2 ** 31) && input.exitCode < 2 ** 32) cause.exitCode = input.exitCode;
  if (typeof input.signal === "string" && /^SIG[A-Z0-9]{1,10}$/.test(input.signal)) cause.signal = input.signal;
  if (typeof input.toolStep === "string" && /^[a-z][a-z-]{0,30}$/.test(input.toolStep)) cause.toolStep = input.toolStep;
  const stderr = redactCauseText(input.stderr);
  if (stderr) cause.stderr = stderr;
  const message = redactCauseText(input.message, 160);
  if (message) cause.message = message;
  if (typeof input.name === "string" && /^[A-Za-z]{1,40}$/.test(input.name)) cause.name = input.name;
  return Object.keys(cause).length ? cause : null;
}

/** What an error thrown inside the capture says about itself, redacted. */
export function describeCaptureError(error, step) {
  if (!error || typeof error !== "object") return normalizeCaptureCause({ step });
  const tool = error.toolDiagnostic && typeof error.toolDiagnostic === "object" ? error.toolDiagnostic : {};
  const inner = error.cause && typeof error.cause === "object" ? error.cause : null;
  const raw = inner ?? error;
  const io = raw.ioCause && typeof raw.ioCause === "object" ? raw.ioCause : raw;
  const errnoOf = value => typeof value === "string" && /^E[A-Z0-9]+$/.test(value) && !/_/.test(value) ? value : undefined;
  const ownCode = value => typeof value === "string" && !errnoOf(value) ? value : undefined;
  // Some refusals carry their code only as the message (Error("BACKUP_...")).
  const codeOf = value => ownCode(value?.code) ?? (typeof value?.message === "string" && /^[A-Z][A-Z0-9_]{2,60}$/.test(value.message) ? value.message : undefined);
  // A coded error's message is only its code again; say it once.
  const coded = !inner && (typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code) || /^[A-Z][A-Z0-9_]{2,60}$/.test(String(error.message)));
  return normalizeCaptureCause({
    step: error.captureStep ?? step,
    errno: errnoOf(io.code) ?? errnoOf(io.errno),
    syscall: io.syscall,
    code: codeOf(error),
    innerCode: inner ? codeOf(inner) : undefined,
    name: raw.name,
    message: coded || raw.message === codeOf(raw) ? undefined : raw.message,
    ...tool,
  });
}
