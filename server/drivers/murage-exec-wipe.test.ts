// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { wipeGuardEnvironment, wipeGuardShimDirectory } from '../env-path.ts';
import { installMurageExec, writeExecEnvFile } from './murage-exec.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
it.each(['linux', 'darwin', 'win32'] as const)('turn env contract on %s: guard first, no duplicates, no ambient turn', platform => {
  const win = platform === 'win32';
  const shim = win ? 'C:\\app files\\server\\wipe-guard\\shim' : '/app files/server/wipe-guard/shim';
  const path = win ? 'C:\\tools;D:\\bin' : '/tools:/bin';
  const input = { [win ? 'Path' : 'PATH']: path, MURAGE_WIPE_GUARD: 'stale', KEEP: 'unchanged' };
  const env = wipeGuardEnvironment(input, 'current-turn', platform, shim);
  expect(env.PATH).toBe(shim + (win ? ';' : ':') + path);
  expect(env.MURAGE_WIPE_GUARD).toBe('current-turn');
  expect(wipeGuardEnvironment(env, 'current-turn', platform, shim)).toEqual(env);
  expect(wipeGuardEnvironment(input, undefined, platform, shim)).toEqual({ [win ? 'Path' : 'PATH']: path, KEEP: 'unchanged' });
  expect(input.MURAGE_WIPE_GUARD).toBe('stale');
});
it('locates the shipped shim sibling', () => {
  expect(wipeGuardShimDirectory().replaceAll('\\', '/')).toMatch(/\/server\/wipe-guard\/shim$/);
});

for (const shell of ['/bin/bash', '/bin/zsh']) {
  it.runIf(process.platform !== 'win32' && existsSync(shell))(`Claude ${shell}: a prepending profile and startup env cannot outrank the shim`, () => {
    const root = mkdtempSync(join(tmpdir(), 'wipe-env-')); dirs.push(root);
    const home = join(root, 'home'); mkdirSync(home);
    const shim = join(root, 'shim'); mkdirSync(shim);
    const profile = 'export PATH="/profile-first:$PATH"\nexport PROFILE_RAN=yes\n';
    for (const name of ['.bash_profile', '.profile', '.bashrc', '.zshenv', '.zprofile']) writeFileSync(join(home, name), profile);
    const env = { HOME: home, ZDOTDIR: home, BASH_ENV: join(home, '.profile'), PATH: `${shim}:/usr/bin:/bin`, MURAGE_WIPE_GUARD: join(root, 'guard') };
    const file = writeExecEnvFile('guard-profile', env, root, shell);
    const result = spawnSync('/bin/bash', [installMurageExec(), 'printf "%s|%s|%s|%s" "$PATH" "$MURAGE_WIPE_GUARD" "$#" "$0"'], {
      env: { HOME: home, PATH: '/usr/bin:/bin', MURAGE_EXEC_ENV_FILE: file }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${env.PATH}|${env.MURAGE_WIPE_GUARD}|0|${shell}`);
    // Independent control proves the profile actually changes PATH when read.
    const control = spawnSync(shell, ['-c', '. "$HOME/.profile"; printf "%s" "$PATH"'], { env, encoding: 'utf8' });
    expect(control.status, control.stderr).toBe(0);
    expect(control.stdout).toContain('/profile-first:');
    expect(readFileSync(file, 'utf8')).toContain(`PATH=${env.PATH}\0`);
  });
}

it('Git Bash seam converts native PATH and guard-file spelling before the command shell', () => {
  // Linux contract probe of the MSYS branch; real Windows qualification stays separate.
  if (process.platform === 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'wipe-msys-')); dirs.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), '#!/bin/bash\n' + body, { mode: 0o755 }); };
  script('uname', 'printf "MSYS_NT-fixture\\n"\n');
  script('cygpath', `case "$*" in
    '-u C:\\fixture') printf '/tmp\\n' ;;
    '-u C:\\shell\\bash.exe') printf '/bin/bash\\n' ;;
    '-u -p C:\\app files\\shim;C:\\tools') printf '/c/app files/shim:/c/tools\\n' ;;
    '-u C:\\turn files\\guard.json') printf '/c/turn files/guard.json\\n' ;;
    '-u /'*) printf '%s\\n' "$2" ;;
    *) exit 2 ;;
  esac\n`);
  const file = writeExecEnvFile('msys-form', { PATH: 'C:\\app files\\shim;C:\\tools', MURAGE_WIPE_GUARD: 'C:\\turn files\\guard.json' }, 'C:\\fixture', 'C:\\shell\\bash.exe');
  // Use the reviewed MCP simulation's private copy to control its trusted tool directory.
  const installed = installMurageExec(), wrapper = join(dirname(installed), `msys-wipe-${process.pid}`);
  const source = readFileSync(installed, 'utf8');
  expect(source.split('\nPATH=/usr/bin:/bin\n').length - 1).toBe(1);
  writeFileSync(wrapper, source.replace('\nPATH=/usr/bin:/bin\n', `\nPATH=${bin}:/usr/bin:/bin\n`), { mode: 0o755 });
  writeFileSync(`${wrapper}.shapes`, readFileSync(`${installed}.shapes`, 'utf8'));
  const result = spawnSync('/bin/bash', [wrapper, 'printf "%s|%s" "$PATH" "$MURAGE_WIPE_GUARD"'], {
    env: { PATH: `${bin}:/usr/bin:/bin`, MURAGE_EXEC_ENV_FILE: file }, encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('/c/app files/shim:/c/tools|/c/turn files/guard.json');
});

it('installs discovered mkfs aliases in the private copy while leaving shipped resources unchanged', async () => {
  const { installWipeGuardShim } = await import('./murage-exec.ts');
  const root = mkdtempSync(join(tmpdir(), 'wipe-install-')); dirs.push(root);
  const source = join(root, 'shim'); mkdirSync(source);
  writeFileSync(join(source, 'guard.sh'), '#!/bin/sh\nprintf fixture\n');
  writeFileSync(join(source, 'guard-lib.sh'), '# fixture library\n');
  const installed = installWipeGuardShim({ 'mkfs.fixturefs': '/fixture/tools/mkfs.fixturefs' }, source);
  expect(installed).not.toBe(source);
  expect(readFileSync(join(installed, 'mkfs.fixturefs'), 'utf8')).toBe(readFileSync(join(source, 'guard.sh'), 'utf8'));
  expect(existsSync(join(source, 'mkfs.fixturefs'))).toBe(false);
});

it('uses a Git Bash readable guard-file path in the Windows process env', () => {
  const env = wipeGuardEnvironment({ Path: 'C:\\tools' }, 'C:\\turn files\\guard.json', 'win32', 'C:\\app files\\shim');
  expect(env.MURAGE_WIPE_GUARD).toBe('C:/turn files/guard.json');
  expect(env.PATH).toBe('C:\\app files\\shim;C:\\tools');
  expect(env).not.toHaveProperty('Path');
});
