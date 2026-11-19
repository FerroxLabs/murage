// Execute the actual host worker with a disposable fixture/cache and a Docker
// command stand-in. Exercise resource cleanup without touching a real daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const host = fileURLToPath(new URL('./g8-host.sh', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'g8-host-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const label = 'v7-test', lane = join(root, `smooth-${label}`);
  const cache = join(root, 'gp18-nm', digest('lock\n').slice(0, 16));
  const cage = join(root, 'cage/linux-x64');
  for (const path of ['bin', 'smoothness', 'fixtures', 'seed/murage']) mkdirSync(join(root, path), { recursive: true });
  for (const path of [join(lane, 'out'), join(lane, 'src/scripts/smoothness'), join(cache, 'node_modules/.pnpm'), cage]) mkdirSync(path, { recursive: true });
  for (const path of [join(lane, 'src/pnpm-lock.yaml'), join(cache, 'pnpm-lock.yaml')]) writeFileSync(path, 'lock\n');
  writeFileSync(join(cache, 'ok'), '');
  for (const name of ['bwrap', 'murage-power.bpf']) writeFileSync(join(cage, name), 'test only\n');
  const sql = spawnSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.executescript("CREATE TABLE memory_revoke_jobs(state TEXT); CREATE TABLE memory_receipt_flips(id INTEGER);"); c.close()`, join(root, 'seed/murage/messages.db')]);
  assert.equal(sql.status, 0, sql.stderr.toString());
  const archive = join(root, 'fixtures/test.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', join(root, 'seed'), 'murage']).status, 0);
  writeFileSync(join(lane, 'src/scripts/smoothness/fixtures-v7.json'), JSON.stringify({ drained: { status: 'ready', archive, sha256: digest(readFileSync(archive)) } }));
  writeFileSync(join(root, 'bin/docker'), `#!/bin/bash
set -eu
echo "$*" >> "$G8_HOST_ROOT/docker-calls"
case "$1" in
  ps) ;;
  run) touch "$G8_HOST_ROOT/smooth-v7-test/out/prebuild.done"; echo test-container-id ;;
  inspect) echo true ;;
  wait) if [ "$TEST_WAIT" = hang ]; then sleep 30; else echo 23; fi ;;
  logs) echo 'test container diagnostic' ;;
  rm) ;;
  *) echo "unexpected Docker command: $*" >&2; exit 9 ;;
esac
`, { mode: 0o755 });
  return { root, label, lane, env: { ...process.env, G8_HOST_ROOT: root, PATH: `${join(root, 'bin')}:${process.env.PATH}` } };
}
test('host preserves diagnostics and propagates a failed container, then removes its mounts', { skip: process.getuid?.() !== 0 }, t => {
  const f = setup(t);
  const result = spawnSync('bash', [host, f.lane, f.label, 'a'.repeat(40), 'idle', '0'], { env: { ...f.env, TEST_WAIT: 'exit' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stderr, /test container diagnostic/);
  assert.equal(readFileSync(join(f.lane, 'done'), 'utf8').trim(), '23');
  assert.match(readFileSync(join(f.root, 'docker-calls'), 'utf8'), /rm -f mm-smooth-v7-test/);
  assert.equal(existsSync(join(f.lane, 'data')), false);
  assert.equal(existsSync(join(f.lane, 'src')), false);
});
test('remote timeout interrupts a blocked docker wait and still runs container cleanup', { skip: process.getuid?.() !== 0 }, t => {
  const f = setup(t);
  const result = spawnSync('timeout', ['--kill-after=3', '2', 'bash', host, f.lane, f.label, 'a'.repeat(40), 'idle', '0'], { env: { ...f.env, TEST_WAIT: 'hang' }, encoding: 'utf8', timeout: 8000 });
  assert.equal(result.status, 124, result.stderr);
  assert.equal(readFileSync(join(f.lane, 'done'), 'utf8').trim(), '143');
  assert.match(readFileSync(join(f.root, 'docker-calls'), 'utf8'), /rm -f mm-smooth-v7-test/);
  assert.equal(existsSync(join(f.lane, 'data')), false);
  assert.equal(existsSync(join(f.lane, 'src')), false);
});
test('pending fixture refuses before starting a container and removes its checkout', { skip: process.getuid?.() !== 0 }, t => {
  const f = setup(t);
  writeFileSync(join(f.lane, 'src/scripts/smoothness/fixtures-v7.json'), JSON.stringify({ drained: { status: 'pending' } }));
  const result = spawnSync('bash', [host, f.lane, f.label, 'a'.repeat(40), 'idle', '0'], { env: { ...f.env, TEST_WAIT: 'exit' }, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /drained fixture is not ready/);
  assert.doesNotMatch(readFileSync(join(f.root, 'docker-calls'), 'utf8'), /^run /m);
  assert.equal(existsSync(join(f.lane, 'src')), false);
});
test('a modified fixture archive refuses before starting a container', { skip: process.getuid?.() !== 0 }, t => {
  const f = setup(t);
  writeFileSync(join(f.root, 'fixtures/test.tar.gz'), 'changed bytes');
  const result = spawnSync('bash', [host, f.lane, f.label, 'a'.repeat(40), 'idle', '0'], { env: { ...f.env, TEST_WAIT: 'exit' }, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /computed checksum did NOT match/);
  assert.doesNotMatch(readFileSync(join(f.root, 'docker-calls'), 'utf8'), /^run /m);
});
