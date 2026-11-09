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
// HEALTH (Sean 11-01). An owner's read may also carry `health`: the quiet
// level, and the problems the owner must act on (`needs`). Each need is one
// ordinary Needs you item, so it counts once in `decisions`. Everything else
// lives on the Health screen and adds nothing here. A stopped backup and
// Sentinel's "no recent verified backup" are one thing owed, so while
// backupFailed is on the read that need is left out and the card stays.
// Health data is never attached to a read that did not prove the owner.
import type { BackupWaiting } from "../shared/backup-waiting.ts";
import type { HealthInbox } from "../shared/sentinel-view.ts";

export interface BackupNotices {
  backupWaiting?: BackupWaiting | null;
  backupFailed?: { sentence: string; at: number; code?: string } | null;
  /** The owner's Health summary: pass it only for a read that proved the owner (owner-api.ts sentinelOwner). */
  health?: HealthInbox | null;
}

/** The title a stopped backup already says: Sentinel's own row for the same condition. */
const SAME_AS_STOPPED_BACKUP = "health.backup.not-protected";

/** The Inbox read with the backup rows attached and the owed one counted.
 *  Returns the body unchanged when there is nothing to attach. */
export function withBackupNotices<T extends { decisions?: number }>(body: T, notices: BackupNotices): T & BackupNotices {
  const { backupWaiting, backupFailed, health } = notices;
  if (!backupWaiting && !backupFailed && !health) return body;
  const needs = (health?.needs ?? []).filter(need => !(backupFailed && need.titleKey === SAME_AS_STOPPED_BACKUP));
  const owed = (backupFailed ? 1 : 0) + needs.length;
  return {
    ...body,
    ...(backupWaiting ? { backupWaiting } : {}),
    ...(backupFailed ? { backupFailed } : {}),
    ...(owed > 0 && typeof body.decisions === "number" ? { decisions: body.decisions + owed } : {}),
    ...(health ? { health: { ...health, needs } } : {}),
  };
}
