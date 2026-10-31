import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { LINUX_FLOOR_IMAGE, floorDockerArgs, verifyGlibcFloor } from './linux-floor.mjs';
const exec = promisify(execFile);
export const PROBE_BUILD_SCRIPT = String.raw`set -euo pipefail
case "$MURAGE_BUILD_UID" in ''|*[!0-9]*) exit 2 ;; esac
case "$MURAGE_BUILD_GID" in ''|*[!0-9]*) exit 2 ;; esac
trap 'chown -R "$MURAGE_BUILD_UID:$MURAGE_BUILD_GID" /work' EXIT
dnf -y --setopt=install_weak_deps=False --enablerepo=powertools install gcc-8.5.0-29.el8_10.alma.1
# Kernel UAPI declarations do not raise the libc floor. AlmaLinux 8 predates
# Landlock and these syscall aliases; use the host's two UAPI headers only.
# All libc headers, startup objects and libraries still come from this image.
gcc -std=c11 -O2 -Wall -Wextra -I /uapi \
  -DSYS_landlock_create_ruleset=__NR_landlock_create_ruleset \
  -DSYS_landlock_add_rule=__NR_landlock_add_rule \
  -DSYS_landlock_restrict_self=__NR_landlock_restrict_self \
  -DSYS_io_uring_setup=__NR_io_uring_setup \
  -DSYS_io_uring_enter=__NR_io_uring_enter \
  -DSYS_io_uring_register=__NR_io_uring_register \
  -DSYS_pidfd_getfd=__NR_pidfd_getfd /source/input.c -o /work/output
`;
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
export async function buildFuigoProbe({ platform = process.platform, arch = process.arch,
  withCanary = false, outputRoot = resolve('dist-native/fuigo-probe'), exec: run = exec } = {}) {
if (!['linux', 'win32'].includes(platform) || arch !== 'x64') {
  if (platform !== 'darwin') throw new Error('Fuigo isolation helper target is unsupported');
} else {
  const target = `${platform}-${arch}`, root = resolve(outputRoot, target);
  await mkdir(root, { recursive: true });
  for (const name of withCanary ? ['launcher', 'canary'] : ['launcher']) {
    const file = join(root, `${name}${platform === 'win32' ? '.exe' : ''}`), source = resolve(`native/fuigo-probe/${name}.c`);
    let built;
    if (platform === 'linux') {
      // Each output gets a fixed mount target; neither name nor host path enters the recipe.
      const directory = await mkdtemp(join(root, `.build-${name}-`));
      try {
        built = await run('docker', floorDockerArgs({ arch, mounts: [
          { source, target: '/source/input.c', readOnly: true },
          { source: '/usr/include/linux/landlock.h', target: '/uapi/linux/landlock.h', readOnly: true },
          { source: '/usr/include/x86_64-linux-gnu/asm/unistd_64.h', target: '/uapi/asm/unistd_64.h', readOnly: true },
          { source: directory, target: '/work' },
        ], command: ['/bin/bash', '-c', PROBE_BUILD_SCRIPT] }), { timeout: 40 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
        verifyGlibcFloor((await run('objdump', ['-T', join(directory, 'output')], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 })).stdout);
        await rename(join(directory, 'output'), file);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    } else {
      built = await compile('cl.exe', ['/nologo', '/std:c11', '/O2', '/W4', '/DUNICODE', '/D_UNICODE', source, `/Fe:${file}`, `/Fo:${join(root, name + '.obj')}`, '/link', 'Userenv.lib', 'Advapi32.lib', 'Ws2_32.lib']);
    }
    if (built.stdout.trim()) console.log(built.stdout.trim()); if (built.stderr.trim()) console.error(built.stderr.trim());
    if (name === 'launcher') await writeFile(join(root, 'manifest.json'), JSON.stringify({ schema: 1, target, executable: platform === 'win32' ? 'launcher.exe' : 'launcher', binarySha256: createHash('sha256').update(await readFile(file)).digest('hex'), ...(platform === 'linux' ? { glibcFloor: '2.28', containerImage: LINUX_FLOOR_IMAGE } : {}) }, null, 2));
  }
  console.log(`Fuigo probe helper built: ${target}`);
}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildFuigoProbe({ withCanary: process.argv.includes('--with-canary') });
