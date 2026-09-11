import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const OUTSIDE_ROOT = "Only files created by your bots can be saved";

function normalizeSourcePath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("A file path is required");
  }

  if (/^file:\/\//i.test(rawPath)) {
    try {
      return fileURLToPath(rawPath);
    } catch {
      throw new Error("That file path is invalid");
    }
  }

  if (!path.isAbsolute(rawPath)) throw new Error("That file path is invalid");
  return rawPath;
}

async function canonicalPath(target, fsp, message) {
  try {
    return await fsp.realpath(target);
  } catch {
    throw new Error(message);
  }
}

function assertInside(root, target) {
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(OUTSIDE_ROOT);
  }
}

function assertRegularFile(stats) {
  if (!stats.isFile()) throw new Error("That path is not a file");
}

function isSameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

// Paths come from model-rendered markdown, so they are untrusted. Resolve the
// root and target before checking containment, then retain the target identity
// for the open step below.
//
// `root` is the ACTIVE installation data root the caller owns (audit B3). It is
// required: a missing root is a refusal, never a fallback to the default
// ~/.murage, which may be a retained original installation this process does
// not own.
async function resolveSource(rawPath, { root, fsp, platform }) {
  const target = normalizeSourcePath(rawPath);
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error(OUTSIDE_ROOT);
  const canonicalRoot = await canonicalPath(root, fsp, OUTSIDE_ROOT);
  const filePath = await canonicalPath(target, fsp, "That file no longer exists");
  assertInside(canonicalRoot, filePath);

  const stats = await fsp.stat(filePath, { bigint: true });
  assertRegularFile(stats);
  if (platform === "win32") {
    const pathAfterStat = await canonicalPath(filePath, fsp, "That file no longer exists");
    assertInside(canonicalRoot, pathAfterStat);
  }
  return { filePath, stats };
}

// Kept as a narrow validation seam for callers and tests that only need the
// canonical path. The save flow uses withSavableFile so it cannot forget to
// close the stable source handle.
export async function resolveSavablePath(rawPath, { root, fsp = fs.promises, platform = process.platform } = {}) {
  return (await resolveSource(rawPath, { root, fsp, platform })).filePath;
}

async function openSavableFile(rawPath, { root, fsp, platform }) {
  const source = await resolveSource(rawPath, { root, fsp, platform });
  const noFollow = platform === "win32" ? 0 : fs.constants.O_NOFOLLOW ?? 0;
  const handle = await fsp.open(source.filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const openedStats = await handle.stat({ bigint: true });
    assertRegularFile(openedStats);
    if (platform === "win32" && !isSameFile(source.stats, openedStats)) {
      throw new Error("That file changed while it was being opened");
    }
    return { handle, filePath: source.filePath, stats: openedStats };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function statIfPresent(fsp, target) {
  try {
    return await fsp.stat(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

// Copy the retained source handle to `destination` without ever opening an
// existing destination for writing (audit B2).
//
// - A destination that already IS the source inode (the same path, a hard
//   link, or a symlink resolving to it) already holds exactly these bytes, so
//   the save is a truthful no-op. Writing it would truncate the source.
// - Otherwise the bytes go to an exclusively created sibling and are published
//   with one rename. Even if the destination became the source between the
//   check and the rename, a rename replaces the directory entry and never
//   truncates the source inode. A failed copy removes only the sibling, so an
//   existing destination is left exactly as it was.
async function copyHandleTo(handle, sourceStats, destination, { fsp, platform }) {
  if (typeof destination !== "string" || !path.isAbsolute(destination)) {
    throw new Error("Choose where to save the file");
  }
  const existing = await statIfPresent(fsp, destination);
  if (existing && isSameFile(existing, sourceStats)) return { written: false, reason: "same-file" };
  if (existing && !existing.isFile()) throw new Error("That destination is not a file");

  const staging = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.murage-save-${randomBytes(6).toString("hex")}.tmp`,
  );
  const output = await fsp.open(staging, "wx", 0o666);
  let published = false;
  try {
    if (existing && platform !== "win32") await output.chmod(Number(existing.mode & 0o777n));
    // The write stream owns the staging handle: it flushes the descriptor,
    // closes it, and the pipeline settles on that close. (A non-closing write
    // stream never settles a pipeline.)
    await pipeline(
      handle.createReadStream({ autoClose: false, start: 0 }),
      output.createWriteStream({ flush: true }),
    );
    await fsp.rename(staging, destination);
    published = true;
    return { written: true };
  } finally {
    await output.close().catch(() => {});
    if (!published) await fsp.rm(staging, { force: true }).catch(() => {});
  }
}

// The callback owns the save operation while this module owns the source
// handle. This keeps validation, stable copying, and cleanup at one seam.
export async function withSavableFile(
  rawPath,
  { root, fsp = fs.promises, platform = process.platform } = {},
  operation,
) {
  const { handle, filePath, stats } = await openSavableFile(rawPath, { root, fsp, platform });
  try {
    return await operation({
      filePath,
      defaultName: path.basename(filePath),
      copyTo: (destination) => copyHandleTo(handle, stats, destination, { fsp, platform }),
    });
  } finally {
    await handle.close();
  }
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
