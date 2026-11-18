// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN ruling 1114-WG-SHIM-TIMING keeps the 10 ms fast-path limit. The common call (a plain `rm -f` of an ordinary
// path) must decide from argv alone: the path-resolution and argv-scanning library is parsed only when it is needed.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SHIM = new URL('./shim/', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'wg-lazy-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A shim copy whose request library only records that it was parsed, plus a real tool that records its argv. */
function fixture(name: string, opts: { rootName?: string; crlf?: boolean } = {}) {
  const dir = join(root, name), shim = join(dir, 'shim'), protectedRoot = join(dir, opts.rootName ?? 'protected');
  mkdirSync(shim, { recursive: true }); mkdirSync(protectedRoot); mkdirSync(join(dir, 'ordinary'));
  for (const file of ['guard.sh', 'guard-lib.sh']) copyFileSync(join(SHIM, file), join(shim, file));
  writeFileSync(join(shim, 'guard-request.sh'), `: > '${join(dir, 'request-loaded')}'\n` + readFileSync(join(SHIM, 'guard-request.sh'), 'utf8'));
  copyFileSync(join(SHIM, 'rm'), join(shim, 'rm')); chmodSync(join(shim, 'rm'), 0o755);
  const real = join(dir, 'real-rm');
  writeFileSync(real, `#!/bin/sh\nprintf 'real\\n' > '${join(dir, 'real-ran')}'\nexit 0\n`, { mode: 0o755 });
  const guard = join(dir, 'guard.json');
  const text = JSON.stringify({ v: 1, socket: 's', threadId: 't', token: 'k', roots: [protectedRoot], client: ['/bin/false', 'x'], realTools: { rm: real }, off: false });
  writeFileSync(guard, opts.crlf ? text.replace(/,/g, ',\r\n').replace('{', '{\r\n') : text);
  const run = (...args: string[]) => spawnSync('/bin/sh', [join(shim, 'rm'), ...args], { env: { PATH: process.env.PATH, MURAGE_WIPE_GUARD: guard }, encoding: 'utf8' });
  return { dir, protectedRoot, ordinary: join(dir, 'ordinary', 'missing'), run, loaded: () => existsSync(join(dir, 'request-loaded')), ran: () => existsSync(join(dir, 'real-ran')) };
}

describe.skipIf(process.platform === 'win32')('T-WG-FAST-PATH-LAZY: ordinary rm parses nothing beyond the lean library', () => {
  it.each([['-f'], ['--force'], ['-i', '--'], []])('non-recursive rm %j runs the real tool without loading the request library', (...flags) => {
    const f = fixture('plain-' + flags.join('').replace(/\W/g, '') + flags.length);
    const result = f.run(...flags, f.ordinary);
    expect(result.status, result.stderr).toBe(0);
    expect(f.ran()).toBe(true);
    expect(f.loaded()).toBe(false);
  });

  it('recursive rm still loads the scanner: the witness is live', () => {
    const f = fixture('recursive');
    const result = f.run('-rf', f.ordinary);
    expect(result.status, result.stderr).toBe(0);
    expect(f.ran()).toBe(true);
    expect(f.loaded()).toBe(true);
  });

  it('recursive rm of a protected root is still not run (refused: no app answers here)', () => {
    const f = fixture('protected');
    const result = f.run('-rf', f.protectedRoot);
    expect(f.loaded()).toBe(true);
    expect(f.ran()).toBe(false);
    expect(result.status).not.toBe(0);
  });

  it('a protected root whose name contains a carriage return is still matched (JSON \\r keeps byte 0x0d)', () => {
    const f = fixture('cr-root', { rootName: 'cr\rroot' });
    const result = f.run('-rf', f.protectedRoot);
    expect(f.loaded()).toBe(true);
    expect(f.ran()).toBe(false);
    expect(result.status).not.toBe(0);
  });

  it('a CRLF-formatted guard file still parses and protects its root (no fail-open)', () => {
    const f = fixture('crlf-guard', { crlf: true });
    const result = f.run('-rf', f.protectedRoot);
    expect(f.ran()).toBe(false);
    expect(result.status).not.toBe(0);
  });

  it('guard-lib.sh keeps the literal carriage return byte in its control-character alphabet', () => {
    const lib = readFileSync(join(SHIM, 'guard-lib.sh'), 'latin1');
    const a = lib.indexOf("wg_controls='"), b = lib.indexOf("'\n", a + 13);
    expect(lib.slice(a, b)).toContain('\x0c\x0d\x0e');
  });
});
