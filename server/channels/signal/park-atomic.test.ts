import { privateParkTemp, expectPrivateParkFile, parkFixtureWrite as writeFileSync, parkFixtureOpen } from '../../testing/signal-park-fixture.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { writeFileAtomic, type WriteFileAtomicOptions } from '../../atomic.ts';
import { removeTempDirSync } from '../../testing/cleanup.ts';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => removeTempDirSync(root)));
for (const name of ['park.json', 'control.json', 'set-aside.json']) {
  for (const phase of ['partial', 'fsync', 'rename'] as const) {
    for (const retained of [true, false, undefined]) {
      test(`RED38 ${name} ${phase} keepFailedTemp=${retained}`, () => {
        const root = privateParkTemp(join(tmpdir(), 'park-atomic-')); roots.push(root);
        const file = join(root, name), failure = new Error('injected');
        writeFileSync(file, 'old', { mode: 0o600 });
        const options = { ops: { open: parkFixtureOpen }, mode: 0o600, syncDir: true, keepFailedTemp: retained,
          ...(phase === 'partial' ? { ops: { open: parkFixtureOpen, write: (fd: number) => { writeFileSync(fd, 'par'); throw failure; } } } : {}),
          ...(phase === 'fsync' ? { ops: { open: parkFixtureOpen, fsync: () => { throw failure; } } } : {}),
          ...(phase === 'rename' ? { rename: () => { throw failure; } } : {}),
        } as WriteFileAtomicOptions;
        expect(() => writeFileAtomic(file, 'complete', options)).toThrow(failure);
        expect(readFileSync(file, 'utf8')).toBe('old');
        const temps = readdirSync(root).filter(n => n !== name);
        expect(temps.length).toBe(retained ? 1 : 0);
        if (retained) {
          expect(readFileSync(join(root, temps[0]!), 'utf8')).toBe(phase === 'partial' ? 'par' : 'complete');
          expectPrivateParkFile(join(root, temps[0]!));
        }
      });
    }
  }
}
