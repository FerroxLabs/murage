import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
if (process.platform === 'linux') {
  if (process.arch !== 'x64') throw new Error('Fuigo isolation helper target is unsupported');
  const target = 'linux-x64', root = resolve('dist-native/fuigo-probe', target);
  await mkdir(root, { recursive: true });
  for (const name of process.argv.includes('--with-canary') ? ['launcher', 'canary'] : ['launcher']) {
    const file = join(root, name), source = resolve(`native/fuigo-probe/${name}.c`);
    const built = await exec('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', source, '-o', file], { timeout: 60000, maxBuffer: 1024 * 1024 });
    if (built.stdout.trim()) console.log(built.stdout.trim()); if (built.stderr.trim()) console.error(built.stderr.trim());
    if (name === 'launcher') await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 1, target, executable: 'launcher', binarySha256: createHash('sha256').update(await readFile(file)).digest('hex') }, null, 2));
  }
  console.log(`Fuigo probe helper built: ${target}`);
}
