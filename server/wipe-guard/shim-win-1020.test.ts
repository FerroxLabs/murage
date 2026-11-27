// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 shim-win: on Windows the writer spells every root C:/..., and the delete check's sh shim sent each such list through the
// full JSON grammar (which copies the rest of a 1 MiB list for every root) and then canonicalised every root with two full cd -P
// walks. Git Bash took 1.13 s per guarded command at 585 roots and 142 s at 8,192. A writer-format drive list now splits at its
// quotes, and roots under one folder resolve that folder once. The full parser still handles unusual spellings.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_GUARD_FILE_BYTES, writeGuardFile, type GuardFile } from './guard-file.ts';
import { wipeGuardRootPaths } from '../drivers/murage-exec-wipe.ts';

const windows = process.platform === 'win32';
const shellPath = (path: string) => windows ? path.replaceAll('\\', '/') : path;
const packagedShim = process.env.WIPE_GUARD_TEST_SHIM;
const SHIM = packagedShim ?? join(import.meta.dirname, 'shim');
const shell = process.env.WIPE_GUARD_TEST_SHELL ?? (windows ? 'sh.exe' : '/bin/sh');
const workPrefix = 'C:/Users/fixture/AppData/Roaming/app/work/';
const system = wipeGuardRootPaths({ project: 'C:/Users/fixture/project', cwd: 'C:/Users/fixture/project', home: 'C:/Users/fixture',
  dataDir: 'C:/Users/fixture/AppData/Roaming/app', env: {} }, [], 'win32');
const base = mkdtempSync(join(realpathSync(tmpdir()), 'wg-win-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Real shim; the client always denies and the real rm only records its argv. The roots are the list the writer publishes on
 * Windows (A:/ to Z:/ and the system folders first), then C:/ work folders; the protected root is this machine's real folder, in
 * the middle. `items` maps each root's JSON text, e.g. to a backslash spelling. */
function fixture(name: string, rootCount: number, items?: (json: string, index: number) => string) {
  const dir = join(base, name), protectedRoot = shellPath(join(dir, 'protected'));
  mkdirSync(protectedRoot, { recursive: true }); writeFileSync(join(protectedRoot, 'keep'), 'x');
  const log = join(dir, 'calls.log');
  const real = shellPath(join(dir, 'real-rm')), client = shellPath(join(dir, 'client'));
  writeFileSync(real, `#!/bin/sh\nprintf 'real %s\\n' "$*" >> "$WIPE_GUARD_TEST_LOG"\nexit 0\n`, { mode: 0o755 });
  writeFileSync(client, `#!/bin/sh\nprintf 'client\\n' >> "$WIPE_GUARD_TEST_LOG"\nexit 10\n`, { mode: 0o755 });
  // An invalid guard file finds rm on PATH: this recorder, never a real rm.
  mkdirSync(join(dir, 'bin')); writeFileSync(join(dir, 'bin', 'rm'), `#!/bin/sh\nprintf 'path %s\\n' "$*" >> "$WIPE_GUARD_TEST_LOG"\nexit 0\n`, { mode: 0o755 });
  if (system[0] !== 'A:/' || !system.includes('C:/Windows')) throw Error('the Windows writer list changed: revisit this fixture');
  const pad = 'w'.repeat(74); // 122-byte work folders: about 1,020,000 bytes at 8,192
  const fillers = Math.max(0, rootCount - 1 - system.length);
  const work = Array.from({ length: fillers }, (_, i) => `${workPrefix}${pad}/${String(i).padStart(5, '0')}`);
  const roots = [...system, ...work.slice(0, fillers >> 1), protectedRoot, ...work.slice(fillers >> 1)];
  let list = roots.map(r => JSON.stringify(r));
  if (items) list = list.map(items);
  const text = JSON.stringify({ v: 1, socket: shellPath(join(dir, 's')), threadId: 't', token: 'k', roots: [], client: [client, 'x'], realTools: { rm: real }, off: false })
    .replace('"roots":[]', () => `"roots":[${list.join(',')}]`);
  const guard = join(dir, 'guard.json');
  writeFileSync(guard, text + '\n', { mode: 0o600 });
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`,
    MURAGE_WIPE_GUARD: shellPath(guard), MURAGE_WIPE_GUARD_OFF: '', WIPE_GUARD_TEST_LOG: shellPath(log), ...extra });
  const run = (command = [shell], extra: Record<string, string> = {}) => {
    const started = process.hrtime.bigint();
    const result = spawnSync(command[0], [...command.slice(1), shellPath(join(SHIM, 'rm')), '-rf', protectedRoot], {
      env: env(extra), encoding: 'utf8', timeout: 15_000 });
    return { ...result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  };
  return { dir, guard, env, run, protectedRoot, roots, calls: () => existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

const asks = (f: ReturnType<typeof fixture>, result: ReturnType<ReturnType<typeof fixture>['run']>) => {
  expect(result.error, 'the guarded command did not finish in 15 s').toBeUndefined();
  expect(result.status, result.stderr).toBe(10);
  const match = windows ? f.protectedRoot.replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`) : f.protectedRoot;
  expect(result.stderr).toBe(`wipe guard: refused "${match}"\n`);
  expect(f.calls()).toBe('client\n');
};

// Use realistic multi-component roots, with sufficiently long installation paths to hit the byte cap before the root cap.
function capFixture(name: string) {
  const f = fixture(name, 2300 + system.length + 1);
  const data: GuardFile = JSON.parse(readFileSync(f.guard, 'utf8'));
  const client = [data.client[0], data.client[0]] as const;
  const padBytes = MAX_GUARD_FILE_BYTES - Buffer.byteLength(JSON.stringify({ ...data, client }) + '\n');
  const workCount = data.roots.filter(root => root.startsWith(workPrefix)).length;
  expect(workCount).toBe(2300);
  const perRoot = Math.floor(padBytes / workCount);
  const spare = padBytes % workCount;
  let workIndex = 0;
  const roots = data.roots.map(root => {
    if (!root.startsWith(workPrefix)) return root;
    const extra = perRoot + (workIndex++ < spare ? 1 : 0);
    return root + '/' + 'w'.repeat(150) + '/' + 'w'.repeat(extra - 152);
  });
  const guard = { ...data, roots, client };
  expect(Buffer.byteLength(JSON.stringify(guard) + '\n')).toBe(MAX_GUARD_FILE_BYTES);
  return { ...f, data: guard };
}

describe.skipIf(windows && !packagedShim)('1.0.20 shim-win: Windows-spelled guard files stay fast and keep their decisions', () => {
  it.skipIf(windows || !existsSync('/bin/dash'))('reads the same text in dash with an inherited shell version variable', () => {
    const text = 'first line\nsecond line\n';
    const file = join(base, 'reader.txt');
    writeFileSync(file, text);
    const env = { ...process.env };
    delete env.BASH_VERSION;
    for (const version of [undefined, '5.2.0']) {
      const result = spawnSync('/bin/dash', ['-c', `
        . "$1"
        wg_nl='
'
        MURAGE_WIPE_GUARD=$2
        wg_read_guard && printf '%s' "$wg_guard_text"
      `, 'dash', join(SHIM, 'guard-lib.sh'), file], {
        env: version === undefined ? env : { ...env, BASH_VERSION: version }, encoding: 'utf8', timeout: 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(text);
    }
  });

  // Fable F1 at 030d30a89d: dash with BASH_VERSION in its environment took the bash-only `read -n`, read nothing, treated the
  // guard as absent and ran the rm found on PATH without asking. Same rm -rf, real shim, with and without the variable.
  it.skipIf(windows || !existsSync('/bin/dash'))('an inherited BASH_VERSION does not make dash skip the question', () => {
    const f = fixture('dash-version', 40);
    for (const version of ['', '5.2.21(1)-release']) {
      rmSync(join(f.dir, 'calls.log'), { force: true });
      asks(f, f.run(['/bin/dash'], version ? { BASH_VERSION: version } : {}));
      expect(readFileSync(join(f.protectedRoot, 'keep'), 'utf8')).toBe('x');
    }
  });

  // The same test picks bash for printf -v, the root fast path and the capped read. Bash 3.2 (macOS /bin/sh) reads one byte per
  // system call with -n (Fable F2: 8,192 roots 0.20 s -> 1.27 s), so only bash 4 or newer caps reads; 3.2 keeps plain reads.
  it.skipIf(windows || !existsSync('/bin/dash'))('only a real bash 4 or newer uses the capped read; bash 3.2 and an imitating sh do not', () => {
    const caps = (command: string, version?: string) => spawnSync(command, ['-c', `
      ${version === undefined ? '' : `BASH_VERSION='${version}'`}
      . "$1"; wg_shell_caps; printf '%s %s' "$wg_bash" "$wg_bash_read"
    `, 'sh', join(SHIM, 'guard-lib.sh')], { env: { ...process.env, BASH_VERSION: '5.2.21(1)-release' }, encoding: 'utf8' }).stdout;
    expect(caps('bash')).toBe('1 1');
    expect(caps('bash', '3.2.57(1)-release')).toBe('1 0');
    expect(caps('/bin/dash')).toBe('0 0');
  });

  // NATIVE Beast receipt at 030d30a89d: Git Bash runs the shim as D:/.../rm. The shim prefixed that native absolute folder with
  // the working folder, could not enter it, and fell through to the rm on PATH: exit 0, the client never asked (13 rows). Here a
  // `cd` with Git Bash's rules (X:/... is absolute; <cwd>/X:/... does not exist) runs the real library's wg_main. The emulation is
  // installed after the library is sourced: the tool entry now removes every function named like a builtin before it starts.
  // These two come from the tool entry, which the library-level runs below do not source.
  const entryHelpers = 'wg_restore_locale() { :; }; wg_exec() { exec "$wg_real" "$@"; }';
  it.skipIf(windows || spawnSync('bash', ['-c', ':']).status !== 0)('a shim started by a drive-spelled path (X:/.../rm) still asks', () => {
    const f = fixture('drive-dollar0', 40);
    const launch = join(f.dir, 'launch'), drive = join(f.dir, 'drive');
    mkdirSync(launch); mkdirSync(drive);
    symlinkSync(drive, join(launch, 'X:'), 'dir');
    symlinkSync(SHIM, join(drive, 'shim'), 'dir');
    const script = `
      . X:/shim/guard-lib.sh; ${entryHelpers}
      cd() {
        local last=\${!#}
        case "$last" in
          X:/*) builtin cd -P -- "$FIXTURE_DRIVE/\${last#X:/}" ;;
          */X:/*) return 1 ;;
          *) builtin cd "$@" ;;
        esac
      }
      wg_tool=rm; wg_dir=X:/shim
      wg_main "$@"
      printf 'path %s\\n' "$*" >> "$WIPE_GUARD_TEST_LOG"`;
    const result = spawnSync('bash', ['-c', script, 'X:/shim/rm', '-rf', f.protectedRoot],
      { cwd: launch, env: f.env({ FIXTURE_DRIVE: drive }), encoding: 'utf8', timeout: 15_000 });
    asks(f, { ...result, ms: 0 });
    expect(readFileSync(join(f.protectedRoot, 'keep'), 'utf8')).toBe('x');
  });

  // Astra H2 at fdec3a8c08: bash imports exported functions, so a function named like a builtin (printf, cd, read, [ ...) ran in
  // place of it inside the shim, cleared the guard and the real rm ran unasked (exit 0). The names come from this machine's bash,
  // not from the shim. Special builtins are looked up first in POSIX mode (bash refuses to import them there), so only the
  // non-POSIX run carries them; that run also needs the shim's own switch into POSIX mode for its `unset`.
  const bashOk = !windows && spawnSync('bash', ['-c', ':']).status === 0;
  it.skipIf(!bashOk)('an exported bash function named like a builtin cannot switch the guard off', () => {
    const special = new Set(['break', ':', '.', 'continue', 'eval', 'exec', 'exit', 'export', 'readonly', 'return', 'set', 'shift', 'source', 'times', 'trap', 'unset']);
    const names = spawnSync('bash', ['-c', 'compgen -b'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    expect(names).toEqual(expect.arrayContaining(['printf', 'cd', 'read', '[', 'test', 'unset', 'command', 'pwd']));
    const f = fixture('exported-functions', 40);
    const failures: string[] = [];
    for (const posix of [true, false]) {
      for (const name of names) {
        if (posix && special.has(name)) continue;
        rmSync(join(f.dir, 'calls.log'), { force: true });
        const hostile = `() { MURAGE_WIPE_GUARD=; MURAGE_WIPE_GUARD_OFF=1; builtin ${name} "$@"; }`;
        const result = f.run(posix ? ['bash', '--posix'] : ['bash'], { [`BASH_FUNC_${name}%%`]: hostile });
        if (result.status !== 10 || f.calls() !== 'client\n') failures.push(`${posix ? 'posix' : 'bash'} ${name}: exit ${result.status} ${JSON.stringify(f.calls())}`);
      }
    }
    expect(failures).toEqual([]);
    expect(readFileSync(join(f.protectedRoot, 'keep'), 'utf8')).toBe('x');
    // An unprotected plain rm still reaches the real tool with the same functions present.
    rmSync(join(f.dir, 'calls.log'), { force: true });
    const plain = spawnSync('bash', [join(SHIM, 'rm'), join(f.dir, 'other')], { env: f.env({ 'BASH_FUNC_printf%%': '() { builtin printf "$@"; }',
      'BASH_FUNC_cd%%': '() { builtin cd "$@"; }' }), encoding: 'utf8' });
    expect(plain.status, plain.stderr).toBe(0);
    expect(f.calls()).toBe(`real ${join(f.dir, 'other')}\n`);
  });

  // The switch into POSIX mode must not reach the real tool: an absent POSIXLY_CORRECT stays absent (GNU rm reads it) and a set
  // value arrives unchanged, also when allexport would export every assignment.
  it.skipIf(!bashOk || !existsSync('/bin/dash'))('the real tool sees the caller\'s POSIXLY_CORRECT exactly', () => {
    const f = fixture('posixly-correct', 40);
    const real = JSON.parse(readFileSync(f.guard, 'utf8')).realTools.rm as string;
    writeFileSync(real, `#!/bin/sh\nprintf 'real %s\\n' "\${POSIXLY_CORRECT-absent}" >> "$WIPE_GUARD_TEST_LOG"\nexit 0\n`, { mode: 0o755 });
    const other = join(f.dir, 'other'); mkdirSync(other);
    const seen = (command: string[], extra: Record<string, string>) => {
      rmSync(join(f.dir, 'calls.log'), { force: true });
      const env: NodeJS.ProcessEnv = f.env(extra); delete env.POSIXLY_CORRECT;
      const result = spawnSync(command[0], [...command.slice(1), join(SHIM, 'rm'), '-rf', other], { env: { ...env, ...extra }, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return f.calls();
    };
    for (const command of [['bash'], ['bash', '--posix'], ['/bin/dash']]) {
      expect(seen(command, { SHELLOPTS: 'allexport' }), command.join(' ')).toBe('real absent\n');
      expect(seen(command, { POSIXLY_CORRECT: 'kept 1' }), command.join(' ')).toBe('real kept 1\n');
    }
  });

  // Astra H2 (second half): a shell whose printf -v works but whose read lacks an option read nothing and treated the guard as
  // empty, so the real rm ran. A read error (status above 1) now refuses like any check that cannot finish. `read` is replaced
  // after the real library is sourced; wg_main is the code under test, and its fall-through is the entry's PATH search.
  it.skipIf(!bashOk)('a guard file that cannot be read refuses instead of reading as empty', () => {
    const f = fixture('read-error', 40);
    const script = `. "$SHIM_DIR/guard-lib.sh"; ${entryHelpers}; read() { return 2; }; wg_tool=rm; wg_dir=$SHIM_DIR; wg_main "$@"
      printf 'path %s\\n' "$*" >> "$WIPE_GUARD_TEST_LOG"`;
    for (const shellName of ['bash', ...existsSync('/bin/dash') ? ['/bin/dash'] : []]) {
      rmSync(join(f.dir, 'calls.log'), { force: true });
      const result = spawnSync(shellName, ['-c', script, 'rm', '-rf', f.protectedRoot], { env: f.env({ SHIM_DIR: SHIM }), encoding: 'utf8' });
      expect(result.status, shellName + result.stderr).toBe(126);
      expect(result.stderr).toBe('wipe guard: could not check; refused\n');
      expect(f.calls()).toBe('');
    }
  });

  // One terminal path: when the check cannot finish under an active guard, anything but a plain rm refuses. A shim folder whose
  // guard-request.sh is gone (a partial install or a quarantined file) is the real entry, unchanged; a folder that cannot be entered
  // is the native drive case's branch. A plain rm and an inactive guard keep running the tool.
  it('a shim that cannot finish its check refuses under an active guard and only then', () => {
    const f = fixture('unchecked', 40);
    const partial = join(f.dir, 'partial-shim'); mkdirSync(partial);
    for (const file of ['rm', 'guard-lib.sh']) writeFileSync(join(partial, file), readFileSync(join(SHIM, file)), { mode: 0o755 });
    const run = (args: string[], extra: Record<string, string> = {}) => {
      rmSync(join(f.dir, 'calls.log'), { force: true });
      return spawnSync(shell, [shellPath(join(partial, 'rm')), ...args], { env: f.env(extra), encoding: 'utf8', timeout: 15_000 });
    };
    const refused = run(['-rf', f.protectedRoot]);
    expect(refused.status, refused.stderr).toBe(126);
    expect(refused.stderr).toBe('wipe guard: could not check; refused\n');
    expect(f.calls()).toBe('');
    expect(readFileSync(join(f.protectedRoot, 'keep'), 'utf8')).toBe('x');
    const other = shellPath(join(f.dir, 'other'));
    const plain = run([other]);
    expect(plain.status, plain.stderr).toBe(0);
    expect(f.calls()).toMatch(new RegExp(`^(real|path) ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n$`));
    for (const extra of [{ MURAGE_WIPE_GUARD: '' }, { MURAGE_WIPE_GUARD_OFF: '1' }] as Record<string, string>[]) {
      const open = run(['-rf', join(f.dir, 'missing')], extra);
      expect(open.status, open.stderr).toBe(0);
      expect(f.calls()).not.toBe('');
    }
    if (!windows && existsSync('/bin/dash')) {
      const script = `. "$SHIM_DIR/guard-lib.sh"; ${entryHelpers}; wg_tool=rm; wg_dir=$SHIM_DIR/absent; wg_main "$@"
        printf 'path %s\\n' "$*" >> "$WIPE_GUARD_TEST_LOG"`;
      rmSync(join(f.dir, 'calls.log'), { force: true });
      const result = spawnSync('/bin/dash', ['-c', script, 'rm', '-rf', f.protectedRoot], { env: f.env({ SHIM_DIR: SHIM }), encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(126);
      expect(f.calls()).toBe('');
    }
  });

  // Astra design r1: a guard path that is readable but not a file (a folder) reads as end of file with no bytes; it must refuse
  // like any check that cannot finish, not read as an absent guard. The real entry, unchanged.
  it.skipIf(windows)('a guard path that is a folder refuses a guarded delete', () => {
    const f = fixture('guard-folder', 40);
    const folder = join(f.dir, 'guard-folder'); mkdirSync(folder);
    rmSync(join(f.dir, 'calls.log'), { force: true });
    const result = spawnSync(shell, [join(SHIM, 'rm'), '-rf', f.protectedRoot], { env: f.env({ MURAGE_WIPE_GUARD: folder }), encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(126);
    expect(result.stderr).toBe('wipe guard: could not check; refused\n');
    expect(f.calls()).toBe('');
  });

  // Astra design r1: the entry's own PATH search (used when guard-lib.sh is missing) must skip the shim's folder as PATH spells it.
  // Comparing PATH's "partial" with the ./partial operand would find the shim again and exec it forever.
  it.skipIf(windows)('a shim without its library, found through a relative PATH entry, runs the next rm once', () => {
    const f = fixture('relative-path-no-lib', 40);
    const partial = join(f.dir, 'partial'); mkdirSync(partial);
    writeFileSync(join(partial, 'rm'), readFileSync(join(SHIM, 'rm')), { mode: 0o755 });
    rmSync(join(f.dir, 'calls.log'), { force: true });
    const env = f.env(); env.PATH = `partial${delimiter}bin${delimiter}${process.env.PATH}`;
    const result = spawnSync(shell, ['-c', 'rm -rf "$1"', 'sh', 'missing'], { cwd: f.dir, env, encoding: 'utf8', timeout: 5_000 });
    expect(result.error, 'the shim kept executing itself').toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls()).toBe('path -rf missing\n');
  });

  // Astra design r2: with a relative guard path, a failure after the shim left the caller's folder (here the way back is gone,
  // as after a concurrent rename) must still see the guard as active. `cd` refuses only that return, after the real library.
  it.skipIf(!bashOk)('a relative guard path stays active when the way back to the caller\'s folder fails', () => {
    const f = fixture('relative-guard', 40);
    const script = `. "$SHIM_DIR/guard-lib.sh"; ${entryHelpers}
      cd() { if [ "$PWD" != "$FIXTURE_CWD" ] && [ "\${!#}" = "$FIXTURE_CWD" ]; then return 1; fi; builtin cd "$@"; }
      wg_tool=rm; wg_dir=$SHIM_DIR; wg_main "$@"
      printf 'path %s\\n' "$*" >> "$WIPE_GUARD_TEST_LOG"`;
    rmSync(join(f.dir, 'calls.log'), { force: true });
    const result = spawnSync('bash', ['-c', script, 'rm', '-rf', f.protectedRoot], { cwd: f.dir,
      env: f.env({ SHIM_DIR: SHIM, FIXTURE_CWD: realpathSync(f.dir), MURAGE_WIPE_GUARD: 'guard.json' }), encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(126);
    expect(result.stderr).toBe('wipe guard: could not check; refused\n');
    expect(f.calls()).toBe('');
  });

  // Astra H1: started as -/rm from its parent, "-" reached `.` and `cd` bare, where it is an option or OLDPWD. The entry now
  // spells a relative shim folder ./-, so the shim asks.
  it.skipIf(windows)('a shim in a folder named "-" still asks', () => {
    const f = fixture('dash-folder', 40);
    const parent = join(f.dir, 'parent'), folder = join(parent, '-'); mkdirSync(folder, { recursive: true });
    for (const file of ['rm', 'guard-lib.sh', 'guard-request.sh']) writeFileSync(join(folder, file), readFileSync(join(SHIM, file)), { mode: 0o755 });
    for (const shellName of [shell, ...bashOk ? ['bash'] : []]) {
      rmSync(join(f.dir, 'calls.log'), { force: true });
      const result = spawnSync(shellName, ['--', '-/rm', '-rf', f.protectedRoot], { cwd: parent, env: f.env({ OLDPWD: f.dir }), encoding: 'utf8', timeout: 15_000 });
      asks(f, { ...result, ms: 0 });
    }
  });

  it('asks for an rm -rf of a protected root in an 8,192-root Windows writer file well within 15 s', () => {
    const f = fixture('many', 8192);
    expect(JSON.parse(readFileSync(f.guard, 'utf8')).roots).toHaveLength(8192);
    expect(readFileSync(f.guard).length).toBeGreaterThan(0.95 * 1024 * 1024);
    expect(readFileSync(f.guard).length).toBeLessThanOrEqual(1024 * 1024);
    asks(f, f.run());
    expect(existsSync(join(f.protectedRoot, 'keep'))).toBe(true);
  });

  it('publishes exactly 1 MiB with 2,300 task folders and asks before a guarded removal', () => {
    const f = capFixture('cap');
    rmSync(f.guard);
    writeGuardFile(f.guard, f.data);
    expect(readFileSync(f.guard).byteLength).toBe(MAX_GUARD_FILE_BYTES);
    const result = f.run();
    console.info(`guard file: ${MAX_GUARD_FILE_BYTES} bytes, ${f.data.roots.length} roots, ${result.ms.toFixed(1)} ms`);
    asks(f, result);
    expect(existsSync(join(f.protectedRoot, 'keep'))).toBe(true);
  });

  it('rejects the first byte over 1 MiB at the writer and refuses it at the shim', () => {
    const f = capFixture('over');
    const data = { ...f.data, roots: [f.data.roots[0] + 'x', ...f.data.roots.slice(1)] };
    rmSync(f.guard);
    expect(() => writeGuardFile(f.guard, data)).toThrow('wipe-guard-file-too-large');
    expect(existsSync(f.guard)).toBe(false);
    const text = JSON.stringify(data) + '\n';
    expect(Buffer.byteLength(text)).toBe(MAX_GUARD_FILE_BYTES + 1);
    writeFileSync(f.guard, text, { mode: 0o600 });
    const result = f.run();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(126);
    expect(result.stderr).toBe('wipe guard: guard file too large; refused\n');
    expect(f.calls()).toBe('');
    expect(existsSync(join(f.protectedRoot, 'keep'))).toBe(true);
  });

  it('refuses an oversized guard file after a short first line', () => {
    const f = fixture('multiline', 40);
    const text = readFileSync(f.guard, 'utf8');
    writeFileSync(f.guard, text + 'x'.repeat(MAX_GUARD_FILE_BYTES - Buffer.byteLength(text)) + '\n');
    expect(readFileSync(f.guard).byteLength).toBe(MAX_GUARD_FILE_BYTES + 1);
    const result = f.run();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(126);
    expect(result.stderr).toBe('wipe guard: guard file too large; refused\n');
    expect(f.calls()).toBe('');
    expect(existsSync(join(f.protectedRoot, 'keep'))).toBe(true);
  });

  // The same 585 roots spelled C:/... and spelled as plain POSIX folders, under bash (Git Bash's sh). Before, the drive list took the
  // full grammar and two full cd -P walks per root: 27x the POSIX time on Bash 5.2, 72x on Bash 3.2. Each drive root still costs one
  // lstat and some shell work, so the bound leaves room for that. Medians of 5, measured side by side, so machine load affects both.
  it.skipIf(windows || spawnSync('bash', ['-c', ':']).status !== 0)('under bash a 585-root Windows list costs a small multiple of the same list spelled as POSIX folders', () => {
    const drive = fixture('ratio-drive', 585);
    // "C:/Windows" -> "/cx/Windows", "A:/" -> "/ax": no trailing slash or one-letter top folder, so the POSIX list keeps the fast matcher.
    const posix = fixture('ratio-posix', 585, json => json.replace(/^"([A-Z]):\/(.*)"$/, (_, d: string, rest: string) => JSON.stringify(`/${d.toLowerCase()}x${rest ? '/' + rest : ''}`)));
    expect(readFileSync(posix.guard, 'utf8')).not.toMatch(/"[A-Z]:/);
    const median = (f: ReturnType<typeof fixture>) => {
      const times = Array.from({ length: 5 }, () => { const r = f.run(['bash', '--posix']); expect(r.status, r.stderr).toBe(10); return r.ms; });
      return times.sort((a, b) => a - b)[2];
    };
    median(drive); median(posix); // warm-up
    const d = median(drive), p = median(posix);
    expect(d, `drive ${d.toFixed(1)} ms vs POSIX ${p.toFixed(1)} ms`).toBeLessThan(6 * p + 100);
  });

  it('a backslash-spelled Windows list (each root decoded on its own) still asks', () => {
    // Drive roots like "A:/" keep their slash: "A:\\" holds \" and sends the whole list to the grammar (the next tests).
    const f = fixture('backslash', 600, json => /^"[A-Z]:\/[^"]/.test(json) ? json.replace(/\//g, '\\\\') : json);
    expect(readFileSync(f.guard, 'utf8')).toContain('"C:\\\\Users\\\\fixture');
    expect(readFileSync(f.guard, 'utf8')).not.toContain('\\"');
    asks(f, f.run());
  });

  it('a Windows list with a JSON escape in one root (\\u0057, \\/) still asks', () => {
    const f = fixture('escape', 40, json => json === '"C:/Windows"' ? '"C:\\/\\u0057indows"' : json);
    expect(readFileSync(f.guard, 'utf8')).toContain('C:\\/\\u0057indows');
    asks(f, f.run());
  });

  it('a Windows list with an escaped quote in a root takes the full grammar and still asks', () => {
    const f = fixture('escaped-quote', 40, (json, i) => i === 31 ? '"C:/a\\"b"' : json);
    asks(f, f.run());
  });

  it('a drive root ending in a backslash (C:\\) takes the full grammar and still asks', () => {
    const f = fixture('drive-backslash', 40, json => json === '"C:/"' ? '"C:\\\\"' : json);
    expect(readFileSync(f.guard, 'utf8')).toContain('"C:\\\\"');
    asks(f, f.run());
  });

  // Each list names the protected root, but the full grammar rejects it: the guard is invalid and the command runs as it always
  // did with a malformed file (the specified fail-open direction, rm found on PATH). Splitting at the quotes would read a root
  // out of each, so the compact check (or the per-root decoder) must send it to the grammar.
  const malformed: Array<[string, (json: string, i: number) => string]> = [
    ['a quote then a letter inside a drive root', (json, i) => i === 30 ? '"C:/a"b"' : json],
    ['a quote then a drive root without its quote', (json, i) => i === 30 ? '"C:/a"C:/b"' : json],
    ['an invalid escape in a drive root', (json, i) => i === 30 ? '"C:/a\\qb"' : json],
    ['a short \\u escape in a drive root', (json, i) => i === 30 ? '"C:/a\\u12"' : json],
    ['an empty root', (json, i) => i === 30 ? '""' : json],
  ];
  for (const [name, items] of malformed) {
    it(`a malformed Windows list (${name}) keeps the full parser's decision`, () => {
      const f = fixture('mal-' + name.replace(/\W+/g, '-'), 40, items);
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      // An empty root is valid JSON: the guard is valid and fails open with the real tool, as the full parser always did.
      expect(f.calls()).toBe(name === 'an empty root' ? `real -rf ${f.protectedRoot}\n` : `path -rf ${f.protectedRoot}\n`);
    });
  }
});
