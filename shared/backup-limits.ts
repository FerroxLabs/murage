// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ONE set of size and count limits for backups, shared by the side that
// makes a backup and the side that restores it (0.1.60 audit A-05).
//
// Before this, setup allowed a 50 GB backup (checked at that limit when it was
// made) while inspect and restore fell back to their own 20 GiB default, and
// every owner file was stored twice. A backup of about 10 GB of files was made,
// "verified", and then refused by restore. Now:
//  - a backup may be made up to the size limit the owner set, at most
//    MAX_BACKUP_BYTES (the largest limit Backups accepts);
//  - inspect, restore and the restored-copy review accept anything up to
//    MAX_BACKUP_BYTES, so whatever a backup verified at its own limit is
//    restorable by size;
//  - a backup holds at most MAX_BACKUP_FILES restorable items (files, stored
//    shortcuts and extra hard-link names). Items over the limit in a folder of
//    owner work are left out and listed, never a failure.

/** Largest size limit Backups accepts, and what restore always accepts. */
export const MAX_BACKUP_BYTES = 1024 ** 4;
/** Largest number of restorable items one backup holds. */
export const MAX_BACKUP_FILES = 100_000;
/** Largest contents list inside one backup file. 100,000 items with long
 * nested paths need about 40 MiB. */
export const MAX_BACKUP_MANIFEST_BYTES = 128 * 1024 ** 2;
/** Files a restore adds beside the restored items (review marker, connection
 * profile, defaults for a missing config, quarantined records). */
export const RESTORE_ADDED_FILES = 1_000;

/** Why an item in a folder of owner work was left out of a backup. Listed to
 * the person after the backup; never a reason for the backup to fail. */
export const BACKUP_SKIP_REASONS = ["rebuildable", "file-limit", "unreadable", "special", "too-deep", "linked-folder", "path-too-long"] as const;
export type BackupSkipReason = typeof BACKUP_SKIP_REASONS[number];
/** At most this many skipped items are named one by one; the total is kept. */
export const MAX_LISTED_SKIPS = 1_000;

/** Longest path, in UTF-8 bytes, an item may have inside a backup (second
 * audit #2). A restore writes each item under its stored (percent-encoded)
 * spelling first, below a restore folder such as
 *   ~/Library/Application Support/Murage/recovered-installations/<uuid>/
 *     .murage-encrypted-inspection-XXXXXX/state/recovery/
 * macOS refuses any path over 1,024 bytes (PATH_MAX), the tightest of the
 * systems Murage runs on (Linux 4,096; Windows long paths via \\?\). 768
 * bytes leaves 256 for that restore folder, so every item of a backup can
 * be restored on any of them. Longer items are left out and listed, which in
 * practice means only machine-made trees nested hundreds of bytes deep. */
export const MAX_RESTORABLE_PATH_BYTES = 768;
