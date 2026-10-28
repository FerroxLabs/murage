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
//
// HEALTH (1.0.9 Sentinel). An owner's read may also carry its Health
// summary (`health`). When Sentinel's backup issue (S01, detector "backup")
// is open in it, the stopped-backup row is shown inside the Health card
// (`backupFailed.inHealth`), with the same sentence and the same action, and
// it is still counted once: the Health card itself never adds to `decisions`.
// Without an owner Health summary the separate card stays exactly as it was,
// and Health data is never attached to a read that did not prove the owner.
import type { BackupWaiting } from "../shared/backup-waiting.ts";
import type { HealthInbox } from "../shared/sentinel-view.ts";

export interface BackupNotices {
  backupWaiting?: BackupWaiting | null;
  backupFailed?: { sentence: string; at: number; inHealth?: true } | null;
  /** The owner's Health summary: pass it only for a read that proved the owner (owner-api.ts sentinelOwner). */
  health?: HealthInbox | null;
}

/** Whether Sentinel's backup issue is open in this Health summary. */
export function healthCoversBackup(health: HealthInbox | null | undefined): boolean {
  return Boolean(health && health.status === "ready" && health.rows.some(row => row.detectorId === "backup" && row.state !== "resolved"));
}

/** The Inbox read with the backup rows attached and the owed one counted.
 *  Returns the body unchanged when there is nothing to attach. */
export function withBackupNotices<T extends { decisions?: number }>(body: T, notices: BackupNotices): T & BackupNotices {
  const { backupWaiting, backupFailed, health } = notices;
  if (!backupWaiting && !backupFailed && !health) return body;
  const failed = backupFailed ? (healthCoversBackup(health) ? { ...backupFailed, inHealth: true as const } : backupFailed) : null;
  return {
    ...body,
    ...(backupWaiting ? { backupWaiting } : {}),
    ...(failed ? { backupFailed: failed, ...(typeof body.decisions === "number" ? { decisions: body.decisions + 1 } : {}) } : {}),
    ...(health ? { health } : {}),
  };
}
