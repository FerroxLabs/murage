import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
async function compile(compiler, args) {
  if (process.platform !== 'win32' || process.env.VSCMD_ARG_TGT_ARCH === 'x64') return exec(compiler, args, { timeout: 60000, maxBuffer: 1024 * 1024 });
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(vswhere)) throw new Error('Existing Visual Studio C++ tools are required; no installation was attempted');
  const installation = (await exec(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'])).stdout.trim();
  const environment = join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
  const quoted = value => { if (!value || /[\r\n\x00"%!]/.test(value)) throw new Error('Unsafe compiler path or argument'); return `"${value}"`; };
  if (!installation || !existsSync(environment)) throw new Error('Existing Visual Studio developer environment is unavailable');
  const command = `call ${quoted(environment)} -arch=x64 -host_arch=x64 && cl.exe ${args.map(quoted).join(' ')}`;
  return exec(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', command], { timeout: 60000, maxBuffer: 1024 * 1024, windowsVerbatimArguments: true });
}
if (!['linux', 'win32'].includes(process.platform) || process.arch !== 'x64') {
  if (process.platform !== 'darwin') throw new Error('Fuigo isolation helper target is unsupported');
} else {
  const target = `${process.platform}-${process.arch}`, root = resolve('dist-native/fuigo-probe', target);
  await mkdir(root, { recursive: true });
  for (const name of process.argv.includes('--with-canary') ? ['launcher', 'canary'] : ['launcher']) {
    const file = join(root, `${name}${process.platform === 'win32' ? '.exe' : ''}`), source = resolve(`native/fuigo-probe/${name}.c`);
    const compiler = process.platform === 'win32' ? 'cl.exe' : 'cc';
    const args = process.platform === 'win32'
      ? ['/nologo', '/std:c11', '/O2', '/W4', '/DUNICODE', '/D_UNICODE', source, `/Fe:${file}`, `/Fo:${join(root, name + '.obj')}`, '/link', 'Userenv.lib', 'Advapi32.lib', 'Ws2_32.lib']
      : ['-std=c11', '-O2', '-Wall', '-Wextra', source, '-o', file];
    const built = await compile(compiler, args);
    if (built.stdout.trim()) console.log(built.stdout.trim()); if (built.stderr.trim()) console.error(built.stderr.trim());
    if (name === 'launcher') await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 1, target, executable: process.platform === 'win32' ? 'launcher.exe' : 'launcher', binarySha256: createHash('sha256').update(await readFile(file)).digest('hex') }, null, 2));
  }
  console.log(`Fuigo probe helper built: ${target}`);
}
