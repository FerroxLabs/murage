import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = new URL('../../server/channels/signal/file-identity.ts', import.meta.url);
const original = readFileSync(file, 'utf8');
const exact = 'dev: decimal(stat.dev), ino: decimal(stat.ino)';
assert.ok(original.includes(exact));
let result;
try {
  // The journal still stores strings, but the IDs have already been rounded.
  writeFileSync(file, original.replace(exact, 'dev: String(Number(stat.dev)), ino: String(Number(stat.ino))'));
  result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'server/signal-park.test-config.ts',
    'server/channels/signal/park-identity.test.ts'], { encoding: 'utf8', timeout: 120_000 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
} finally {
  writeFileSync(file, original);
}
assert.equal(result.error, undefined);
assert.equal(result.status, 1);
assert.match(result.stdout, /64-bit root inode saves, reloads, and compares without rounding/);
console.log('KILLED: decimal strings made from rounded Number(dev/ino); original source restored.');
