// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';
const adapter = new URL('./test-docker.mjs', import.meta.url);
for (const [args, expected] of [
  [['run', '--network', 'none', '--cpus', '6', '-v', '/src:/work:ro', 'node:24-bookworm', 'bash', '-c', 'echo node:24-bookworm'],
   ['run', '--network', 'none', '--cpus', '6', '-v', '/src:/work:ro',
    '--mount', 'type=bind,source=/shared-fixture/leak-guard.sh,target=/opt/murage-test-shared/leak-guard.sh,readonly',
    '--mount', 'type=bind,source=/shared-fixture/public-leak-patterns.txt,target=/opt/murage-test-shared/public-leak-patterns.txt,readonly',
    '--env', 'PUBLIC_LEAK_GUARD_SHARED_DIR=/opt/murage-test-shared',
    '--env', 'FIELD_REPLAY_SHA=1234567890123456789012345678901234567890',
    'prepared:test', 'bash', '-c', 'echo node:24-bookworm']],
  [['run', '--rm', '--network=none', 'postgres:16-alpine', 'echo', 'node:24-bookworm'],
   ['run', '--rm', '--network=none', 'postgres:16-alpine', 'echo', 'node:24-bookworm']],
  [['image', 'inspect', 'node:24-bookworm'], ['image', 'inspect', 'node:24-bookworm']],
  [['rm', '-f', 'owned-fixture'], ['rm', '-f', 'owned-fixture']],
]) test(`test image adapter preserves Docker arguments: ${args[0]} ${args[1]}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'test-image-adapter-'));
  try {
    const docker = join(root, 'docker'), receipt = join(root, 'args.json');
    writeFileSync(docker, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify(process.argv.slice(2)));process.exit(17);\n`);
    chmodSync(docker, 0o755);
    const result = spawnSync(process.execPath, [adapter.pathname, ...args], { env: { ...process.env, MURAGE_REAL_DOCKER: docker, MURAGE_TEST_IMAGE: 'prepared:test', MURAGE_TEST_SHARED_GUARD_DIR: '/shared-fixture', MURAGE_TEST_REVISION: '1234567890123456789012345678901234567890' } });
    assert.equal(result.status, 17);
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), expected);
  } finally { safeWipeSync(root, { within: tmpdir() }); }
});

test('release image Electron runtime matches the lockfile pin', () => {
  const image = readFileSync(new URL('./test-image.Dockerfile', import.meta.url), 'utf8');
  const lock = readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');
  const pin = /electron@([0-9]+\.[0-9]+\.[0-9]+)/.exec(image)?.[1];
  assert.ok(pin);
  assert.match(lock, new RegExp(`^  electron@${pin.replaceAll('.', '\\.')}:$`, 'm'));
  assert.match(image, /node \/opt\/murage-test-electron\/node_modules\/electron\/install\.js/);
  assert.match(image, /test -x \/opt\/murage-test-electron\/node_modules\/electron\/dist\/electron/);
});
