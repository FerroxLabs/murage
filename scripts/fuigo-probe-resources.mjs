import { createHash } from 'node:crypto';
import { chmod, lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { executableTarget } from './prepare-cloudflared.mjs';

export async function validateFuigoProbeResources(resources, platform, required = true) {
  if (platform !== 'linux') return null;
  const target = 'linux-x64', root = join(resources, 'fuigo-probe'), executable = 'launcher';
  try { await lstat(root); } catch (error) { if (!required && error.code === 'ENOENT') return null; throw error; }
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Fuigo probe resource must be a real directory');
  const manifestPath = join(root, 'manifest.json'), file = join(root, executable);
  for (const candidate of [manifestPath, file]) {
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (candidate === file ? 8 * 1024 * 1024 : 65536)) throw new Error('Invalid Fuigo probe resource file');
  }
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify([executable, 'manifest.json'].sort())) throw new Error('Unexpected Fuigo probe resource');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')), bytes = await readFile(file);
  if (manifest.schema !== 1 || manifest.target !== target || manifest.executable !== executable || executableTarget(bytes) !== target || createHash('sha256').update(bytes).digest('hex') !== manifest.binarySha256) throw new Error('Fuigo probe resource identity mismatch');
  await chmod(root, 0o755); await chmod(file, 0o755);
  return { file, manifestPath, manifest };
}
