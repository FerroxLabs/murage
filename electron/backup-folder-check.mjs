// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Whether a folder chosen for backups can hold them, asked when it is chosen
// (0.1.60 audit W-A2). On Windows the backup helper works only on this
// computer's own NTFS drive (native/backup-age/transport.cpp); a USB stick
// (exFAT, FAT32) or a network folder used to be accepted at setup and then
// failed the first backup, after Murage had already restarted. It is now
// refused in the same step that chose it, with a sentence.
//
// macOS and Linux have no such limit: a drive without hard links (exFAT,
// FAT32) is published by rename (server/publish-file.ts), so every folder
// that exists and is not inside Murage's own data folder is accepted there.
import { windowsNative } from "./windows-native.mjs";
export { BACKUP_FOLDER_REFUSALS } from "../shared/backup-folder-refusals.mjs";

/** Drive type (.NET DriveInfo's names: Fixed, Removable, Network, ...) and format of the volume holding `folder` on Windows, from the
 * engine-exclusion addon (GetVolumePathNameW, GetDriveTypeW, GetVolumeInformationW). No PowerShell (murage-releases #1). Null when it
 * cannot be told, which refuses the folder as unchecked. */
function windowsDrive(folder, { native = windowsNative() } = {}) {
  if (typeof native?.driveInfo !== "function") return null;
  try {
    const info = native.driveInfo(folder);
    return info && typeof info.type === "string" && info.type ? { type: info.type, format: typeof info.format === "string" ? info.format : "" } : null;
  } catch { return null; }
}

/** Null when `folder` can hold backups, or the refusal code. `folder` is the
 * already-resolved directory the person chose. */
export function backupFolderRefusal(folder, { platform = process.platform, drive = windowsDrive } = {}) {
  if (platform !== "win32") return null;
  if (/^\\\\/.test(folder)) return "BACKUP_FOLDER_NETWORK";
  const info = drive(folder);
  if (!info) return "BACKUP_FOLDER_UNCHECKED";
  if (info.type === "Network") return "BACKUP_FOLDER_NETWORK";
  if (info.type !== "Fixed") return "BACKUP_FOLDER_REMOVABLE";
  if (info.format.toUpperCase() !== "NTFS") return "BACKUP_FOLDER_NOT_NTFS";
  return null;
}
