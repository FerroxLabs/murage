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
import { spawnSync } from "node:child_process";
export { BACKUP_FOLDER_REFUSALS } from "../shared/backup-folder-refusals.mjs";

/** Drive type and format for `folder` on Windows, through .NET's DriveInfo,
 * run by absolute System32 path. The path goes in the environment, never in
 * the command text. */
function windowsDrive(folder, { spawn = spawnSync, env = process.env } = {}) {
  const root = env.SystemRoot;
  if (typeof root !== "string" || !/^[A-Za-z]:\\[^"\x00-\x1f]*$/.test(root)) return null;
  const powershell = `${root.replace(/\\+$/, "")}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const script = "$d=[System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($env:MURAGE_BACKUP_FOLDER));[Console]::Out.Write($d.DriveType.ToString()+'|'+$d.DriveFormat)";
  const result = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20000, env: { SystemRoot: root, MURAGE_BACKUP_FOLDER: folder } });
  if (result?.status !== 0) return null;
  const [type, format] = String(result.stdout).trim().split("|");
  return type ? { type, format: format ?? "" } : null;
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
