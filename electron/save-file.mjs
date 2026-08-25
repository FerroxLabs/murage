import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Paths reaching desktop:save-file come from model output rendered as markdown
// links, so they are untrusted. Everything is canonicalised with realpath before
// the containment check: resolving both sides means a symlink inside the bot
// home cannot point the copy at ~/.ssh, and a symlinked bot home still matches.
export async function resolveSavablePath(rawPath, { home, fsp = fs.promises } = {}) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("A file path is required");
  }
  let target = rawPath;
  if (target.startsWith("file://")) {
    try {
      target = fileURLToPath(target);
    } catch {
      throw new Error("That file path is invalid");
    }
  }
  if (!path.isAbsolute(target)) throw new Error("That file path is invalid");

  let root;
  try {
    root = await fsp.realpath(path.join(home, ".openmausbot"));
  } catch {
    throw new Error("Only files created by your bots can be saved");
  }

  let real;
  try {
    real = await fsp.realpath(target);
  } catch {
    throw new Error("That file no longer exists");
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error("Only files created by your bots can be saved");
  }

  const stats = await fsp.stat(real);
  if (!stats.isFile()) throw new Error("That path is not a file");
  return real;
}

// "report.docx" -> "report (2).docx" so saving twice never overwrites an
// existing download. Claiming the name and writing it is a single COPYFILE_EXCL
// call rather than an access() check followed by a copy: the gap between those
// two lets concurrent saves pick the same name, and copyFile overwrites by
// default, so the second click would silently replace the first file. Bounded
// so a directory full of collisions cannot spin forever.
export async function copyIntoDirectory(dir, sourcePath, { fsp = fs.promises } = {}) {
  const ext = path.extname(sourcePath);
  const stem = path.basename(sourcePath, ext);
  for (let n = 1; n < 1000; n += 1) {
    const dest = path.join(dir, n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`);
    try {
      await fsp.copyFile(sourcePath, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Too many copies of that file are already in your downloads");
}
