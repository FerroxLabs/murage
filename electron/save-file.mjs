import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
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

// Validating a path and then copying it by name leaves a gap: the save dialog
// can sit open for as long as the user likes, and a path checked before it
// opened says nothing about what that name points at afterwards. So the file is
// opened while it is still the validated one and the handle is what gets
// copied. The descriptor keeps referring to that inode even if the name is
// later swapped for a symlink out of the bot home. O_NOFOLLOW closes the same
// race at open time and is absent on Windows, where it degrades to 0 — there
// the containment check alone stands.
export async function openSavableFile(rawPath, { home, fsp = fs.promises } = {}) {
  const filePath = await resolveSavablePath(rawPath, { home, fsp });
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("That path is not a file");
    return { handle, filePath };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Streams from the already-open handle rather than re-reading the path.
export async function copyHandleTo(handle, destination) {
  await pipeline(handle.createReadStream({ autoClose: false, start: 0 }), fs.createWriteStream(destination));
  return destination;
}

// The name the save dialog opens on: "report.docx", or "report (2).docx" when
// that already exists, so accepting the default never quietly replaces an
// earlier download. Only a suggestion — the user can type over it, and the
// dialog's own overwrite confirmation covers the final choice. Bounded so a
// directory full of collisions cannot spin forever.
export async function defaultSaveName(dir, sourcePath, { fsp = fs.promises } = {}) {
  const ext = path.extname(sourcePath);
  const stem = path.basename(sourcePath, ext);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = path.join(dir, n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}${ext}`);
}
