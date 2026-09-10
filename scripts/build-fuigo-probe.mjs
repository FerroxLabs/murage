import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
if (!['linux', 'win32'].includes(process.platform) || process.arch !== 'x64') {
  if (process.platform !== 'darwin') throw new Error('Fuigo isolation helper target is unsupported');
} else {
  const target = `${process.platform}-${process.arch}`, root = resolve('dist-native/fuigo-probe', target);
  await mkdir(root, { recursive: true });
  for (const name of process.argv.includes('--with-canary') ? ['launcher', 'canary', ...(process.platform === 'win32' ? ['standard-user'] : [])] : ['launcher']) {
    const file = join(root, `${name}${process.platform === 'win32' ? '.exe' : ''}`), source = resolve(`native/fuigo-probe/${name}.c`);
    const compiler = process.platform === 'win32' ? 'cl.exe' : 'cc';
    const args = process.platform === 'win32'
      ? ['/nologo', '/std:c11', '/O2', '/W4', '/DUNICODE', '/D_UNICODE', source, `/Fe:${file}`, `/Fo:${join(root, name + '.obj')}`, '/link', 'Userenv.lib', 'Advapi32.lib', 'Ws2_32.lib']
      : ['-std=c11', '-O2', '-Wall', '-Wextra', source, '-o', file];
    const built = await exec(compiler, args, { timeout: 60000, maxBuffer: 1024 * 1024 });
    if (built.stdout.trim()) console.log(built.stdout.trim()); if (built.stderr.trim()) console.error(built.stderr.trim());
    if (name === 'launcher') await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 1, target, executable: process.platform === 'win32' ? 'launcher.exe' : 'launcher', binarySha256: createHash('sha256').update(await readFile(file)).digest('hex') }, null, 2));
  }
  console.log(`Fuigo probe helper built: ${target}`);
}
