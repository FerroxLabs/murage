import { createHash } from 'node:crypto';
import { chmod, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executableTarget } from './prepare-cloudflared.mjs';

export async function validateFuigoProbeResources(resources, platform, required = true) {
  if (platform === 'darwin') return null;
  const target = `${platform}-x64`, root = join(resources, 'fuigo-probe'), executable = platform === 'win32' ? 'launcher.exe' : 'launcher';
  if (!['linux-x64', 'win32-x64'].includes(target)) throw new Error('Unsupported Fuigo probe resource target');
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
  if (platform === 'linux') { await chmod(root, 0o755); await chmod(file, 0o755); }
  return { file, manifestPath, manifest };
}

/** Called only after validation and the existing Windows signing operation. */
export async function stampSignedFuigoProbe(resource) {
  const bytes = await readFile(resource.file);
  if (executableTarget(bytes) !== resource.manifest.target) throw new Error('Signed Fuigo probe target changed');
  await writeFile(resource.manifestPath, JSON.stringify({ ...resource.manifest, binarySha256: createHash('sha256').update(bytes).digest('hex') }, null, 2));
}
