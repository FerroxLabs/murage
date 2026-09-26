// SPDX-License-Identifier: AGPL-3.0-or-later
// What the Backup mode / recovery page says when an operation is refused.
// Every code the recovery worker, the controller or the restore can answer
// maps to one plain sentence that says what happened and what to do next.
// Codes are never shown: they stay in the diagnostics log. A classic script
// (the page's CSP allows only its own files), read by renderer.js and by
// installation-recovery-messages.node-test.mjs.
(function (root) {
  // age reports a wrong key and a damaged file the same way, so this names both.
  const KEY_WRONG = "Murage couldn't open this backup with that recovery key, so nothing was restored. Either the key isn't the one made with this backup, or the backup file is damaged. Try your copy of the key, or choose another backup.";
  const KEY_NOT_A_KEY = "That file isn't a Murage recovery key. Choose murage-recovery-key.txt, or the copy of it you saved.";
  const KEY_INSIDE = "Keep the recovery key outside Murage's own data folder, then choose it from there.";
  const KEY_NEEDS_ORIGINAL = "To make a backup here, choose the original recovery key file Murage made, not a copy that was edited.";
  const DAMAGED = "This backup file is damaged or incomplete, so nothing was restored. Choose another backup, or download the off-site copy again.";
  const CHANGED = "The backup file changed while Murage was checking it. Choose it again, then try once more.";
  const REVIEW_CHANGED = "The restored copy changed after it was checked. Choose Review restored installation again.";
  const TOOL = "Murage couldn't check its own backup tool on this computer. Reinstall Murage, then try again.";
  const BUSY = "Murage is still finishing something else. Wait a moment, then try again.";
  const OWNER = "Another copy of Murage may still be open. Quit every other Murage window, then choose Return to workspace.";
  const SLOW = "That took too long, so Murage stopped it and nothing was changed. Try again; a large backup can take several minutes.";
  const TOO_BIG = "This backup is larger than Murage can restore in one go. Contact support with the diagnostics folder.";
  const PLACE = "That location can't be used. Choose a new file name in a folder outside Murage's data folder.";
  const PAUSED = "A restored copy is waiting for your review. Choose Review restored installation, then Approve and open.";
  const NOT_PAUSED = "Some work in the restored copy is still switched on, so it can't be opened yet. Open the diagnostics folder and contact support.";
  const NOTHING_TO_UNDO = "There is no restore on this computer to undo.";
  const UNDO_FIRST = "An earlier restore didn't finish. Choose Undo a restore first, then restore again.";
  const UNDO_FAILED = "The restore couldn't be undone, and your files were kept as they are. Open the diagnostics folder and contact support.";
  const VM = "Backups can't include a local VM's files yet, so the backup was not made. Open the diagnostics folder and contact support.";
  const PARTS = "Part of your workspace couldn't be read, so the backup was not made. Close anything else using Murage's data folder, then try again.";
  const UNKNOWN_PART = "There is a file in Murage's data folder that Murage doesn't recognise, so the backup was not made. Open the diagnostics folder and contact support.";
  const CANCELLED = "Stopped. Nothing was changed.";
  const EXPIRED = "Choose the backup again before restoring.";
  const CAPTURE_WINDOWS = "This way of recovering is only available on Windows. Restore from a backup file instead.";
  const LIMITS = "The size or time limit for backups can't be used. Check both under Backups, Advanced, then try again.";
  const DEFAULT = "That didn't work, and nothing was changed. Open the diagnostics folder and send the newest log to support.";
  // A plain file error while the backup file was written (W-D1): about the
  // backup folder or the drive, never the recovery key.
  const WRITE_FAILED = "Murage couldn't finish writing the backup file, and nothing in your workspace was changed. Try again; if it happens again, open the diagnostics folder and send the newest log to support.";
  const DISK_FULL = "The drive ran out of space while the backup was being written. Free up space on the drive that holds your backup folder, then try again.";
  const NOT_WRITABLE = "This computer didn't let Murage write a file the backup needed. Check that you can create files in your backup folder, then try again.";
  const IN_USE = "Another program was holding a file the backup needed, often antivirus or a sync app. Wait a few minutes, then try again.";
  const FOLDER_UNUSABLE = "Murage couldn't make its private working folder inside your backup folder. Choose a folder on this computer's own drive that you can create files in, then try again.";
  const groups = [
    [KEY_WRONG, ["AGE_PROCESS_FAILED"]],
    [KEY_NOT_A_KEY, ["BACKUP_IDENTITY_INVALID", "AGE_NATIVE_IDENTITY_REQUIRED", "AGE_NATIVE_RECIPIENT_REQUIRED", "INVALID_RECOVERY_INPUT"]],
    [KEY_INSIDE, ["BACKUP_IDENTITY_MUST_BE_INDEPENDENT"]],
    [KEY_NEEDS_ORIGINAL, ["BACKUP_IDENTITY_HEADER_REQUIRED"]],
    [DAMAGED, ["ARCHIVE_COMPRESSION_RATIO_EXCEEDED", "ARCHIVE_ENTRY_COUNT_MISMATCH", "ARCHIVE_HASH_MISMATCH", "ARCHIVE_HASH_REQUIRED", "ARCHIVE_INSPECTION_FAILED", "ARCHIVE_SIZE_MISMATCH",
      "INVALID_ARCHIVE_MANIFEST", "MANIFEST_MUST_BE_FIRST", "MISSING_ARCHIVE_ENTRY", "UNDECLARED_ARCHIVE_ENTRY", "UNSAFE_ARCHIVE_ENTRY", "UNSAFE_ARCHIVE_FILE", "UNSAFE_ARCHIVE_PATH",
      "FIDELITY_READBACK_MISMATCH", "FIDELITY_RECOVERY_MISMATCH", "INVALID_FIDELITY_MANIFEST", "INVALID_DATABASE_MANIFEST", "DATABASE_INTEGRITY_FAILED", "DATABASE_SCHEMA_UNSUPPORTED",
      "DATABASE_UNREADABLE", "UNSAFE_DATABASE_FILE", "UNSUPPORTED_DATABASE_SIZE", "UNSAFE_MEMORY_LEDGER", "MEMORY_DATABASE_MISSING", "CYCLIC_MESSAGE_BRANCH", "DUPLICATE_RESTORE_THREAD",
      "INVALID_ACTIVE_BRANCH", "INVALID_MESSAGE_IDENTITY", "INVALID_MESSAGE_JSON", "INVALID_MESSAGE_PARENT", "INVALID_RESTORE_CALENDAR", "INVALID_RESTORE_COMPONENT", "INVALID_RESTORE_CONFIG",
      "INVALID_RESTORE_MEMBERSHIP", "INVALID_RESTORE_MEMORY_REVIEW", "INVALID_RESTORE_MESSAGE", "INVALID_RESTORE_ROSTER", "INVALID_RESTORE_ROUTINES", "INVALID_RESTORE_SKILLS",
      "INVALID_RESTORE_WEBHOOKS", "INVALID_ROSTER_COMPONENT", "INVALID_WEBHOOK_COMPONENT", "INVALID_CONFIG_COMPONENT", "INVALID_JSON_COMPONENT", "JSON_COMPONENT_TOO_LARGE",
      "RESERVED_RESTORE_COMPONENT", "RESTORE_COMPONENT_TOO_LARGE", "RESTORE_TRANSCRIPT_LIMIT", "INVALID_INSTALLATION_RECORDS", "INVALID_RECOVERY_PREVIEW", "INVALID_REVIEW_FILE",
      "INVALID_REVIEW_MESSAGE", "INVALID_REVIEW_RECORDS", "NONPORTABLE_SNAPSHOT_PATH", "UNSAFE_SNAPSHOT_ENTRY"]],
    [CHANGED, ["ARCHIVE_CHANGED", "ARCHIVE_HASH_CHANGED", "SOURCE_CHANGED"]],
    [REVIEW_CHANGED, ["REVIEW_STATE_CHANGED", "RESTORE_CANDIDATE_IDENTITY_CHANGED", "RESTORE_ORIGINAL_IDENTITY_CHANGED"]],
    [TOOL, ["BACKUP_UNAVAILABLE", "AGE_TOOL_PLATFORM_UNQUALIFIED", "AGE_TOOL_UNVERIFIED", "AGE_PROCESS_CLOSE_UNCONFIRMED"]],
    [BUSY, ["RECOVERY_BUSY", "SNAPSHOT_EPOCH_CLOSED", "BACKUP_BUSY", "BACKUP_WORK_ACTIVE", "BACKUP_ACTIVITY_UNAVAILABLE", "BACKUP_RELEASE_UNCONFIRMED", "BACKUP_PREPARE_UNCONFIRMED"]],
    [OWNER, ["RECOVERY_OWNERSHIP_REQUIRED", "LEASE_FOREIGN_HOST", "UNTRUSTED_RECOVERY_SENDER", "RESTORE_ORIGINAL_UNAVAILABLE"]],
    [SLOW, ["AGE_TOOL_TIMEOUT", "RECOVERY_WORKER_TIMEOUT", "RECOVERY_INPUT_TIMEOUT", "RECOVERY_CAPTURE_TIMEOUT"]],
    [LIMITS, ["INVALID_ARCHIVE_LIMITS", "INVALID_AGE_PROCESS_LIMITS", "INVALID_SNAPSHOT_LIMITS", "INVALID_BACKUP_LIMITS", "INVALID_BACKUP_BUDGET"]],
    [DEFAULT, ["BACKUP_CREDENTIAL_POLICY_REQUIRED", "INVALID_RECOVERY_REQUEST", "INVALID_RECOVERY_RESULT", "RECOVERY_OPERATION_FAILED"]],
    [TOO_BIG, ["BACKUP_LIMIT_EXCEEDED", "SNAPSHOT_LIMIT_EXCEEDED", "ARCHIVE_LIMIT_EXCEEDED", "REVIEW_LIMIT_EXCEEDED"]],
    [PLACE, ["DESTINATION_EXISTS", "DESTINATION_INSIDE_INSTALLATION", "INVALID_DESTINATION", "RESTORE_PATH_ALREADY_EXISTS", "BROAD_RESTORE_TARGET_REFUSED", "RESTORE_SOURCE_TARGET_REFUSED",
      "UNSAFE_RESTORE_DIRECTORY", "UNSAFE_RESTORE_TARGET", "INVALID_PRIVATE_RESTORE_PARENT", "RESTORE_NEW_TARGET_REQUIRED", "INSTALLATION_SELECTION_INVALID"]],
    [PAUSED, ["RESTORE_REVIEW_REQUIRED", "RESTORE_ALREADY_REQUIRES_REVIEW"]],
    [NOT_PAUSED, ["RESTORE_WORK_NOT_PAUSED", "RESTORE_MEMORY_NOT_PAUSED", "INVALID_RESTORE_REVIEW", "REVIEW_HASH_REQUIRED"]],
    [NOTHING_TO_UNDO, ["NO_RESTORE_TO_ROLL_BACK"]],
    [UNDO_FIRST, ["INTERRUPTED_RESTORE_REQUIRES_ROLLBACK", "INVALID_RESTORE_JOURNAL"]],
    [UNDO_FAILED, ["RESTORE_ROLLBACK_FAILED", "RESTORE_PREPARATION_FAILED"]],
    [VM, ["VM_WORKSPACE_BACKUP_UNSUPPORTED"]],
    [PARTS, ["BACKUP_SELECTED_COMPONENT_UNAVAILABLE", "BACKUP_REQUIRED_COMPONENT_MISSING", "INSTALLATION_MISSING", "STATE_SNAPSHOT_FAILED"]],
    [UNKNOWN_PART, ["BACKUP_UNCLASSIFIED_COMPONENT"]],
    [WRITE_FAILED, ["ENCRYPTED_BACKUP_FAILED"]],
    [DISK_FULL, ["BACKUP_DISK_FULL"]],
    [NOT_WRITABLE, ["BACKUP_FOLDER_NOT_WRITABLE"]],
    [IN_USE, ["BACKUP_FILE_IN_USE"]],
    [FOLDER_UNUSABLE, ["BACKUP_FOLDER_UNUSABLE"]],
    [CANCELLED, ["RECOVERY_CAPTURE_CANCELLED", "SNAPSHOT_CANCELLED"]],
    [EXPIRED, ["RECOVERY_SELECTION_EXPIRED"]],
    [CAPTURE_WINDOWS, ["RECOVERY_CAPTURE_UNAVAILABLE", "RECOVERY_CAPTURE_FAILED", "INVALID_RECOVERY_CAPTURE", "INVALID_RECOVERY_CAPTURE_RESULT"]],
  ];
  const messages = {};
  for (const [sentence, codes] of groups) for (const code of codes) messages[code] = sentence;
  root.murageRecoveryMessages = { messages, fallback: DEFAULT, sentence: code => messages[code] || DEFAULT };
})(globalThis);
