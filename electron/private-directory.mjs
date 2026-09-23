import fs from "node:fs";

/** Removes group and other write access (or, with `mask: 0o077`, all group
 * and other access) from a directory this user owns.
 *
 * Murage's data folder is created owner-only, but installs made before that
 * (or under a umask of 002, the default for Ubuntu users) left it writable by
 * the user's group. The closed-app backup profile correctly refuses such a
 * folder, so Murage tightens its own folder instead of weakening that check.
 * Anything that is not a real directory owned by `uid` is left untouched, and
 * Windows has no POSIX modes to tighten. Returns whether the mode changed.
 * The server passes 0o077 for its own data folder: bots.json and the other
 * records are owner only, and a 0755 folder still let other users list them
 * and read any file an older release left 0644 (upstream #1620). */
export function tightenOwnedDirectory(directory, { platform = process.platform, uid = process.getuid?.(), fileSystem = fs, mask = 0o022 } = {}) {
  if (platform === "win32" || typeof uid !== "number") return false;
  let fd;
  try { fd = fileSystem.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ELOOP" || error.code === "ENOTDIR") return false; throw error; }
  try {
    const stat = fileSystem.fstatSync(fd);
    if (!stat.isDirectory() || stat.uid !== uid || !(stat.mode & mask)) return false;
    fileSystem.fchmodSync(fd, stat.mode & 0o7777 & ~mask);
    return true;
  } finally { fileSystem.closeSync(fd); }
}
