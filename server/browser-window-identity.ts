import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
export type TreeEntry = { path: string; type: 'file' | 'dir' | 'link'; identity: string; mode: number; target?: string };
export function inside(root: string, file: string): boolean { const rel = relative(root, file); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); }
export function identity(s: BigIntStats): string { return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.gid, s.nlink].join(':'); }
/** Includes directories and symlinks, not just executable bytes. No opaque or
 * external entries can be hidden behind an otherwise unchanged main image. */
export function treeManifest(root: string): TreeEntry[] {
  const base = resolve(root);
  if (realpathSync(base) !== base || !lstatSync(base).isDirectory()) throw new Error('Chrome root must be a real directory');
  const result: TreeEntry[] = [];
  const walk = (file: string, depth: number) => {
    if (depth > 64 || result.length >= 50_000) throw new Error('Chrome tree limit');
    const stat = lstatSync(file, { bigint: true });
    const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : null;
    if (!type) throw new Error('Chrome tree contains a special file');
    const entry: TreeEntry = { path: relative(base, file).split(sep).join('/'), type, identity: identity(stat), mode: Number(stat.mode) & 0o7777 };
    if (type === 'link') {
      entry.target = readlinkSync(file);
      if (!inside(base, realpathSync(file))) throw new Error('Chrome link leaves its tree');
    }
    result.push(entry);
    if (type === 'dir') for (const child of readdirSync(file).sort()) walk(join(file, child), depth + 1);
  };
  walk(base, 0); return result;
}
export function sameManifest(a: TreeEntry[], b: TreeEntry[]): boolean { return JSON.stringify(a) === JSON.stringify(b); }
/** Hash the opened inode and reject replacement or writes during the read. */
export function fileSha256(file: string): string {
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile()) throw new Error('Expected a regular Chrome file');
  const fd = openSync(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    if (identity(fstatSync(fd, { bigint: true })) !== identity(before)) throw new Error('Chrome file changed');
    const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
    for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; hash.update(buffer.subarray(0, size)); }
    if (identity(fstatSync(fd, { bigint: true })) !== identity(before) || identity(lstatSync(file, { bigint: true })) !== identity(before)) throw new Error('Chrome file changed');
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
export function privateDirectory(path: string): void {
  // Reject links before creating anything through an existing ancestor.
  for (let parent = resolve(path);; parent = dirname(parent)) {
    try { if (!lstatSync(parent).isDirectory()) throw new Error('Chrome evidence path is not a real directory'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (parent === dirname(parent)) break;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || realpathSync(path) !== resolve(path) || (process.platform !== 'win32' && ((s.mode & 0o077) !== 0 || s.uid !== process.getuid?.()))) throw new Error('Chrome evidence needs a private directory');
}
