// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE BACKUP ROWS, AND WHICH OF THEM THE NEEDS YOU NUMBER COUNTS.
//
// Two backup rows ride on the desktop's Inbox read, beside the database's
// own items:
//
//   A BACKUP THAT WAITS ON A CARD (backupWaiting). Not counted, because the
//   card it waits on is already counted, and one thing owed is one.
//
//   A BACKUP THAT STOPPED (backupFailed). Backups stay paused until the owner
//   clears it, so it is owed, and nothing else counts it. The 0.1.60 Mac
//   re-test (rt4 L2) saw it listed under Needs you while the badge and the
//   tab both kept reading three. It goes into `decisions`, the umbrella the
//   badge and the Needs you tab read. It is not an approval, a question or a
//   connection, so no segment count changes.
import type { BackupWaiting } from "../shared/backup-waiting.ts";

export interface BackupNotices {
  backupWaiting?: BackupWaiting | null;
  backupFailed?: { sentence: string; at: number } | null;
}

/** The Inbox read with the backup rows attached and the owed one counted.
 *  Returns the body unchanged when there is neither. */
export function withBackupNotices<T extends { decisions?: number }>(body: T, notices: BackupNotices): T & BackupNotices {
  const { backupWaiting, backupFailed } = notices;
  if (!backupWaiting && !backupFailed) return body;
  return {
    ...body,
    ...(backupWaiting ? { backupWaiting } : {}),
    ...(backupFailed ? { backupFailed, ...(typeof body.decisions === "number" ? { decisions: body.decisions + 1 } : {}) } : {}),
  };
}
