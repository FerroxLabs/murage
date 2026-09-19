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
 * recovery window's renderer, and the workspace's Backups page. */

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
  "BACKUP_LIMIT_EXCEEDED", "ARCHIVE_LIMIT_EXCEEDED", "INVALID_BACKUP_LIMITS", "INVALID_ARCHIVE_LIMITS", "SNAPSHOT_LIMIT_EXCEEDED",
  // encryption
  "SNAPSHOT_CANCELLED", "AGE_TOOL_TIMEOUT", "AGE_PROCESS_FAILED", "AGE_PROCESS_CLOSE_UNCONFIRMED", "AGE_TOOL_UNVERIFIED",
  "ENCRYPTED_BACKUP_FAILED",
  // what was captured
  "FIDELITY_READBACK_MISMATCH", "FIDELITY_RECOVERY_MISMATCH", "INVALID_FIDELITY_MANIFEST", "ARCHIVE_CHANGED", "UNSAFE_ARCHIVE_FILE",
  // the snapshot's own refusals (server/installation-fidelity-snapshot.ts).
  // These were missing, so the single most common real cause — a file in the
  // data folder that Murage does not recognise — reached the user as
  // "UNKNOWN_CAPTURE_FAILURE" and told them nothing.
  "BACKUP_UNCLASSIFIED_COMPONENT", "BACKUP_REQUIRED_COMPONENT_MISSING", "BACKUP_SELECTED_COMPONENT_UNAVAILABLE",
  "NONPORTABLE_SNAPSHOT_PATH", "SOURCE_CHANGED", "UNSAFE_ARCHIVE_PATH", "UNSAFE_SNAPSHOT_ENTRY", "VM_WORKSPACE_BACKUP_UNSUPPORTED",
  // the destination
  "INVALID_DESTINATION", "DESTINATION_EXISTS", "DESTINATION_INSIDE_INSTALLATION",
]);

const STAGES = new Set(BACKUP_CAPTURE_STAGES);
const CODES = new Set(BACKUP_CAPTURE_CODES);

const STAGE_WORDS = {
  precondition: "before it started",
  references: "while checking your backup folder and recovery key",
  claim: "while taking charge of the backup",
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
    "Part of your workspace couldn't be read. Close anything else that might be using Murage's data folder, then back up again.",
  SOURCE_CHANGED:
    "Your workspace changed while the backup was being taken, so the copy wouldn't have matched. Try again once nothing else is running.",
  NONPORTABLE_SNAPSHOT_PATH:
    "Something in Murage's data folder can't be copied safely, such as a shortcut pointing outside it. Move it out of that folder, then back up again.",
  UNSAFE_ARCHIVE_PATH:
    "Something in Murage's data folder can't be copied safely, such as a shortcut pointing outside it. Move it out of that folder, then back up again.",
  UNSAFE_SNAPSHOT_ENTRY:
    "Something in Murage's data folder can't be copied safely, such as a shortcut pointing outside it. Move it out of that folder, then back up again.",
  UNSAFE_ARCHIVE_FILE:
    "Something in Murage's data folder can't be copied safely, such as a shortcut pointing outside it. Move it out of that folder, then back up again.",
  VM_WORKSPACE_BACKUP_UNSUPPORTED:
    "A bot's virtual-machine workspace can't be included in this backup. Turn that computer off for the bot, then back up again.",
  BACKUP_LIMIT_EXCEEDED:
    "Your workspace is bigger than the size limit set for backups. Raise the limit in Backups, or clear out large files, then try again.",
  ARCHIVE_LIMIT_EXCEEDED:
    "Your workspace is bigger than the size limit set for backups. Raise the limit in Backups, or clear out large files, then try again.",
  SNAPSHOT_LIMIT_EXCEEDED:
    "Your workspace is bigger than the size limit set for backups. Raise the limit in Backups, or clear out large files, then try again.",
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
  ENCRYPTED_BACKUP_FAILED:
    "The backup couldn't be encrypted. Check that your recovery key file is still where you chose it, then try again.",
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

/** Normalize whatever the failure path produced into the two closed sets. */
export function normalizeCaptureFailure(input) {
  if (!input || typeof input !== "object") return null;
  const code = typeof input.code === "string" && (CODES.has(input.code) || input.code === "UNKNOWN_CAPTURE_FAILURE")
    ? input.code : "UNKNOWN_CAPTURE_FAILURE";
  const stage = typeof input.stage === "string" && STAGES.has(input.stage) ? input.stage : "unknown";
  return { stage, code };
}

/** One or two sentences naming the step and the reason. Never a path. */
export function captureFailureSentence(input) {
  const failure = normalizeCaptureFailure(input);
  if (!failure) return "";
  const where = STAGE_WORDS[failure.stage];
  return `The last backup stopped ${where ?? "before it could finish"}. ${REASONS[failure.code] ?? REASONS.UNKNOWN_CAPTURE_FAILURE}`;
}
