// Byte-exact verification of a local semantic-memory model directory against
// shared/memory-model-manifest.json. One implementation shared by the release
// staging script, the after-pack gate and the server, so "verified" means the
// same thing at build time and at run time.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { lstatSync } from "node:fs";
import path from "node:path";

/** A manifest path must be a plain relative path of simple segments. */
export function manifestFileTarget(directory, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) return null;
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return path.join(directory, ...parts);
}

export async function sha256OfFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Cheap check: every manifest file exists as a regular file of the exact size. */
export async function modelSizesMatch(directory, manifest) {
  for (const file of manifest.files) {
    const target = manifestFileTarget(directory, file.path);
    if (!target) return false;
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes) return false;
    } catch { return false; }
  }
  return true;
}

/** The first component of `directory`, from the filesystem root down, that is a symbolic link; null if none (or if it cannot be read). */
export async function linkedPathComponent(directory) {
  const resolved = path.resolve(directory);
  // Walk below the root only: on Windows the root is a drive (C:\) or a UNC share, and splitting the whole path would make
  // the drive letter a component, so the first lstat (of C:\C:) fails and every link above the model would pass unseen.
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) return current; }
    catch { return null; }
  }
  return null;
}

/** Every directory from the model root down to a manifest file's parent, root first. */
function directoriesOf(directory, relativePath) {
  const parts = relativePath.split("/").slice(0, -1);
  const out = [directory];
  let current = directory;
  for (const part of parts) { current = path.join(current, part); out.push(current); }
  return out;
}

/** The first internal directory or file component below the model root (down to every manifest file) that is a symbolic link; null if none. */
export async function linkedInternalComponent(directory, manifest) {
  for (const file of manifest.files) {
    if (!manifestFileTarget(directory, file.path)) continue;
    const chain = [...directoriesOf(directory, file.path).slice(1), path.join(directory, ...file.path.split("/"))];
    for (const component of chain) {
      try { if ((await lstat(component)).isSymbolicLink()) return component; }
      catch { break; }
    }
  }
  return null;
}

/** Identity of the manifest files (inode, size, mtime, ctime). A replaced or rewritten file changes it; ctime cannot be set back by a non-root writer. null if any file is unreadable. */
export function modelSignature(directory, manifest) {
  const parts = [];
  const seen = new Set();
  for (const file of manifest.files) {
    const target = manifestFileTarget(directory, file.path);
    if (!target) return null;
    try {
      // Every directory on the path (root down) is part of the identity, so a swapped-then-restored directory is noticed.
      for (const dir of directoriesOf(directory, file.path)) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        const d = lstatSync(dir);
        if (!d.isDirectory() || d.isSymbolicLink()) return null;
        parts.push(`d:${dir}:${d.dev}:${d.ino}:${d.mtimeMs}:${d.ctimeMs}`);
      }
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      parts.push(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
    } catch { return null; }
  }
  return parts.join("|");
}

/** Full check: sizes and SHA-256 of every manifest file. Never throws.
 *  With `rejectLinks`, a symbolic link at the directory or any ancestor fails it. */
export async function verifyModelDirectory(directory, manifest, { rejectLinks = false } = {}) {
  if (rejectLinks) {
    const linked = await linkedPathComponent(directory);
    if (linked) return { ok: false, reason: `${linked} is a symbolic link` };
  }
  const internal = await linkedInternalComponent(directory, manifest);
  if (internal) return { ok: false, reason: `${internal} is a symbolic link` };
  for (const file of manifest.files) {
    const target = manifestFileTarget(directory, file.path);
    if (!target) return { ok: false, reason: `invalid manifest path ${String(file.path)}` };
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: `${file.path} is not a regular file` };
      if (stat.size !== file.bytes) return { ok: false, reason: `${file.path} has ${stat.size} bytes, expected ${file.bytes}` };
      const actual = await sha256OfFile(target);
      if (actual !== file.sha256) return { ok: false, reason: `${file.path} sha256 ${actual} does not match the manifest` };
    } catch (error) {
      return { ok: false, reason: `${file.path} unreadable: ${error?.code ?? "error"}` };
    }
  }
  return { ok: true };
}
