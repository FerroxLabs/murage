// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the Backups page says when a folder chosen for backups can't hold them
// (electron/backup-folder-check.mjs). Shared by the desktop and the page.
export const BACKUP_FOLDER_REFUSALS = Object.freeze({
  BACKUP_FOLDER_NETWORK: "Backups on Windows need a folder on this computer's own drive, not a network folder. Choose a folder on this computer, such as one in Documents, then try again.",
  BACKUP_FOLDER_REMOVABLE: "Backups on Windows need a folder on this computer's own drive, not a USB stick or memory card. Choose a folder on this computer, such as one in Documents, then try again. You can copy backups to a USB stick afterwards.",
  BACKUP_FOLDER_NOT_NTFS: "Backups on Windows need a drive formatted as NTFS, and that drive uses another format (often exFAT or FAT32 on USB drives). Choose a folder on this computer's main drive, such as one in Documents, then try again.",
  BACKUP_FOLDER_UNCHECKED: "Murage couldn't check the drive that folder is on. Choose a folder on this computer's main drive, such as one in Documents, then try again.",
});
