// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MARKS FIX A (MARKS-DENY-VS-NOLIMITS-RULING, N2 and N5): the words that name a wipe. A value that is a whole delete or
// disk target, or inline code that holds one of these words, is a typed deny; every other uncertainty stays a doubt.

/** Programs that delete whatever their operands name. */
export const DELETE_VERBS: ReadonlySet<string> = new Set([
  "rm", "rmdir", "unlink", "shred", "srm", "trash", "rd", "del", "erase", "remove-item", "ri", "rimraf",
]);
/** A flag that makes another program delete (`find -delete`, `rsync --delete`). */
export const DELETE_FLAGS: ReadonlySet<string> = new Set(["-delete", "--delete", "--delete-before", "--delete-after", "--delete-during", "--delete-excluded", "--remove-source-files"]);
/** Programs that erase a disk or a volume whatever they are given. */
export const DISK_VERBS: ReadonlySet<string> = new Set([
  "mke2fs", "newfs", "wipefs", "diskutil", "format", "format.com", "format-volume", "clear-disk", "initialize-disk", "mknod", "diskpart", "remove-partition",
]);

/** Does this program, with these (literal or unknown) arguments, wipe its target? `mirror` is the caller's own test for a
 * deleting mirror (rsync --delete, rclone sync, unison). */
export function wipeVerb(name: string, args: ReadonlyArray<string | undefined>, mirror = false): boolean {
  const base = name.toLowerCase();
  if (DELETE_VERBS.has(base) || DISK_VERBS.has(base) || base === "mkfs" || base.startsWith("mkfs.")) return true;
  if (mirror) return true;
  if (base === "find") return args.some((arg) => arg === "-delete");
  if (base === "dd") return args.some((arg) => arg !== undefined && arg.startsWith("of="));
  return args.some((arg) => arg !== undefined && DELETE_FLAGS.has(arg) && base !== "find");
}

const WIPE_WORD = /\b(?:rm_rf|rm_r|rm_f|rmdir|rmtree|remove_tree|remove_dir|remove_entry(?:_secure)?|unlink(?:Sync)?|rmSync|rmdirSync|rimraf|removedirs|removeSync|emptyDir(?:Sync)?|shred|Remove-Item|wipefs|mke2fs|newfs|mkfs(?:\.\w+)?|diskutil|rm)\b|\bos\.remove\b/;
/** The first wipe word code names (a delete call, a disk-erase program), or undefined. */
export function wipeWordIn(code: string): string | undefined {
  return WIPE_WORD.exec(code)?.[0];
}
