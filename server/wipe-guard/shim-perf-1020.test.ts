// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 shim-perf: the delete check's sh shim re-parsed every root of the writer's guard file for each guarded command, so a
// guarded rm took 36 s under dash and 5 min under Bash 3.2 (macOS /bin/sh) with 8,192 roots. The compact path now validates the
// root list with whole-string patterns. A list it accepts is one the full parser accepts too; anything else still goes to the full
// parser, so each command keeps the decision it had: matched commands still ask, malformed lists still fail open as before.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { wipeGuardRootPaths } from '../drivers/murage-exec-wipe.ts';

const SHIM = join(import.meta.dirname, 'shim');
const base = mkdtempSync(join(tmpdir(), 'wg-perf-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Real shim; the client always denies and the real rm only records its argv. `items` replaces the roots between the brackets. */
function fixture(name: string, rootCount: number, items?: (protectedRoot: string) => string) {
  const dir = join(base, name), protectedRoot = join(dir, 'protected');
  mkdirSync(protectedRoot, { recursive: true }); writeFileSync(join(protectedRoot, 'keep'), 'x');
  const log = join(dir, 'calls.log');
  const real = join(dir, 'real-rm'), client = join(dir, 'client');
  writeFileSync(real, `#!/bin/sh\nprintf 'real %s\\n' "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  writeFileSync(client, `#!/bin/sh\nprintf 'client\\n' >> '${log}'\nexit 10\n`, { mode: 0o755 });
  // An invalid guard file finds rm on PATH: this recorder, never a real rm.
  mkdirSync(join(dir, 'bin')); writeFileSync(join(dir, 'bin', 'rm'), `#!/bin/sh\nprintf 'path %s\\n' "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  // Roots at the length real task work folders have (about 110 bytes), protected root last.
  const pad = 'w'.repeat(Math.max(1, 122 - join(dir, 'gone').length - 7)); // 122-byte roots: about 1,024,000 bytes at 8,192
  // Start from the list the writer really publishes (system roots first, including "/"), then task folders, protected root last.
  const system = wipeGuardRootPaths({ project: dir, cwd: dir, home: join(dir, 'home'), dataDir: join(dir, 'data') }, [], 'linux');
  if (system[0] !== '/') throw Error('the writer no longer lists "/" first: revisit this fixture');
  const fillers = Math.max(0, rootCount - 1 - system.length);
  const roots = [...system, ...Array.from({ length: fillers }, (_, i) => join(dir, 'gone', pad, String(i).padStart(5, '0'))), protectedRoot];
  let text = JSON.stringify({ v: 1, socket: join(dir, 's'), threadId: 't', token: 'k', roots, client: [client, 'x'], realTools: { rm: real }, off: false });
  if (items) text = text.replace(/"roots":\[[^\]]*\]/, () => '"roots":[' + items(protectedRoot) + ']');
  const guard = join(dir, 'guard.json');
  writeFileSync(guard, text + '\n', { mode: 0o600 });
  const run = () => spawnSync('/bin/sh', [join(SHIM, 'rm'), '-rf', protectedRoot], {
    env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, MURAGE_WIPE_GUARD: guard }, encoding: 'utf8', timeout: 15_000 });
  return { guard, run, protectedRoot, calls: () => existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

describe.skipIf(process.platform === 'win32')('1.0.20 shim-perf: the delete check stays fast and keeps its decisions', () => {
  it('asks for an rm -rf of a protected root in an 8,192-root writer-format guard file well within 15 s', () => {
    const f = fixture('many', 8192);
    expect(JSON.parse(readFileSync(f.guard, 'utf8')).roots).toHaveLength(8192);
    expect(readFileSync(f.guard).length).toBeGreaterThan(0.95 * 1024 * 1024);
    expect(readFileSync(f.guard).length).toBeLessThanOrEqual(1024 * 1024);
    const result = f.run();
    expect(result.error, 'the guarded command did not finish in 15 s').toBeUndefined();
    expect(result.status, result.stderr).toBe(10);
    expect(result.stderr).toBe(`wipe guard: refused "${f.protectedRoot}"\n`);
    expect(f.calls()).toBe('client\n');
    expect(existsSync(join(f.protectedRoot, 'keep'))).toBe(true);
  });

  it('a compact list with a quote-free root of ","-adjacent text still asks', () => {
    const f = fixture('comma-root', 3, p => ['"/a,"', JSON.stringify(p), '"/b"'].join(','));
    const result = f.run();
    expect(result.status, result.stderr).toBe(10);
    expect(f.calls()).toBe('client\n');
  });

  // The fast reader's text matcher cannot read these lists; a writer-format file holding them keeps the full parser, as before 1.0.20.
  it('a writer-format file with spaced roots still asks (the text matcher would miss the root)', () => {
    const f = fixture('spaced', 3, p => ['"/a"', JSON.stringify(p)].join(', '));
    const result = f.run();
    expect(result.status, result.stderr).toBe(10);
    expect(f.calls()).toBe('client\n');
  });

  it('a writer-format file with an empty root keeps the full parser\'s fail-open decision', () => {
    const f = fixture('empty-root', 3, p => ['""', JSON.stringify(p)].join(','));
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls()).toBe(`real -rf ${f.protectedRoot}\n`);
  });

  // A root the writer kept in lexical form is canonicalised before matching, as before 1.0.20; raw text would miss the target.
  for (const [name, spell] of [['a dot segment', (p: string) => p.replace(/\/protected$/, '/./protected')],
    ['a dot-dot segment', (p: string) => p.replace(/\/protected$/, '/gone/../protected')], ['a trailing slash', (p: string) => p + '/']] as const) {
    it(`a writer-format root spelled with ${name} still asks for its canonical target`, () => {
      const f = fixture('spelled-' + name.replace(/\W+/g, '-'), 3, p => ['"/a"', JSON.stringify(spell(p))].join(','));
      const result = f.run();
      expect(result.status, result.stderr).toBe(10);
      expect(f.calls()).toBe('client\n');
    });
  }

  // Each list names the protected root, so the compact matcher finds the target, but the full parser rejects the list: the guard
  // is invalid and the command runs as it always did with a malformed file (the specified fail-open direction, with rm found on
  // PATH because an invalid file names no real tool). Each one is caught
  // by exactly one compact pattern; dropping that pattern would send it to the callback instead (fuzzed mutants in DONE.md).
  const malformed: Array<[string, (p: string) => string]> = [
    ['quote followed by a quote', p => `${JSON.stringify(p)},"/x"""`],
    ['separator followed by junk', p => `${JSON.stringify(p)},,a"`],
    ['list ending in an open string', p => `${JSON.stringify(p)},"`],
    ['root followed by a slash', p => `${JSON.stringify(p)},"/a"/b"`],
    ['comma inside a broken root', p => `${JSON.stringify(p)},"/a,"/b"`],
  ];
  for (const [name, items] of malformed) {
    it(`a malformed list (${name}) keeps the full parser's fail-open decision`, () => {
      const f = fixture('mal-' + name.replace(/\W+/g, '-'), 3, items);
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(f.calls()).toBe(`path -rf ${f.protectedRoot}\n`);
    });
  }
});
