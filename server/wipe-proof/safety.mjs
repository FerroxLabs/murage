import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
export async function assertTempRoot(root) {
  const real = await fs.realpath(root), temp = await fs.realpath(os.tmpdir());
  if (real === temp || !within(temp, real) || !path.relative(temp, real).split(path.sep)[0].startsWith('wipe-proof-'))
    throw Error('unsafe-fixture-root');
  return real;
}
export async function assertTarget(root, target) {
  await assertTempRoot(root);
  const resolved = path.resolve(target);
  if (!within(root, resolved)) throw Error('outside-fixture');
  // Reject symlinks in every existing component, even when they point inward.
  let cursor = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw Error('fixture-symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return resolved;
}
export async function snapshot(root, exclude = []) {
  const result = {};
  async function walk(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name);
      if (exclude.includes(file)) continue;
      const stat = await fs.lstat(file), key = path.relative(root, file).split(path.sep).join('/');
      if (stat.isSymbolicLink()) result[key] = 'link:' + await fs.readlink(file);
      else if (stat.isDirectory()) { result[key] = 'directory'; await walk(file); }
      else result[key] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  await walk(root);
  return result;
}
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
