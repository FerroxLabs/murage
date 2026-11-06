// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-WIPE-WORD (designs/NOLIMITS-MEANS-IT.md R11): the reader's delete, disk and mirror vocabulary, data only.

/** One source. The reader's recognisers and the reader-failure check both read these lists. A word added here reaches both.
 * Pinned by server/shell/wipe-words.test.ts: a recogniser with no entry fails CI. */
/** A name with one of these runs as the name without it (pwsh.ts programBase, mirrorTargets). */
export const PROGRAM_SUFFIX = /\.(?:exe|com|cmd|bat)$/;
/** Deletes and overwrites the reader treats as risky (always-ask RISKY). */
export const DELETE_VERBS = ["rm", "rmdir", "unlink", "dd", "shred", "robocopy", "rd", "del", "erase", "remove-item", "set-content", "clear-content"] as const;
/** The same class, but ordinary words on POSIX text (`sc`): read only with a sign of Windows, or their own suffix. */
export const WINDOWS_DELETE_ALIASES = ["ri", "sc", "clc"] as const;
/** Disk verbs the reader holds as disk writers (always-ask DISK_WRITERS) that are not ordinary words anywhere. */
export const DISK_VERBS = ["mke2fs", "newfs", "wipefs", "diskutil", "format-volume", "clear-disk", "initialize-disk", "mknod"] as const;
/** `format` means a disk only on Windows; `format.com` is its suffixed name. */
export const WINDOWS_DISK_VERBS = ["format"] as const;
/** diskHit's two verbs outside DISK_WRITERS. */
export const DISK_DROP_VERBS = ["remove-partition", "diskpart"] as const;
/** Any name starting this is a disk verb (`mkfs.ext4`). */
export const DISK_PREFIX = "mkfs";
/** mirrorTargets' tools that delete by verb or switch, and rimraf. */
export const MIRROR_WORDS = ["rimraf", "rclone", "unison", "gsutil"] as const;
/** rsync's delete family, as mirrorTargets reads it. */
export const RSYNC_DELETE = /^--del(e(t(e.*)?)?)?$/;
/** Delete switches named exactly: find's, rsync's long names, the cloud CLIs'. */
export const DELETE_FLAGS = ["-delete", "--del", "--dele", "--delet", "--delete", "--delete-before", "--delete-during", "--delete-delay", "--delete-after",
  "--delete-excluded", "--delete-missing-args", "--delete-destination", "--delete-unmatched-destination-objects", "--remove-source-files", "--remove-sent-files"] as const;
/** A switch that deletes only under one tool: [tool, switch]. */
export const TOOL_FLAGS: ReadonlyArray<readonly [string, RegExp]> = [["rsync", RSYNC_DELETE], ["mc", /^--remove$/]];
/** No recogniser, on the check's list by policy: secure delete and PowerShell's and cmd's clearing words. */
export const CHECK_ONLY = ["srm", "clear-item"] as const;
export const CHECK_ONLY_WINDOWS = ["cli", "cipher"] as const;
