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
