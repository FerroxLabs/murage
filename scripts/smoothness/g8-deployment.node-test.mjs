// SPDX-License-Identifier: AGPL-3.0-or-later
// Deployment configuration and captured private inventories stay outside Git.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';
const script = name => fileURLToPath(new URL(name, import.meta.url));

test('G8 ships no deployment address, account home, SSH key path or captured fixture inventory', () => {
  for (const name of ['g8-smooth.sh', 'g8-overlay.sh', 'g8-host.sh', 'G8-V7.md', 'G8-V7-VALIDATION.md', 'fixtures-v7.json']) {
    const source = readFileSync(script(name), 'utf8');
    assert.doesNotMatch(source, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, name);
    assert.doesNotMatch(source, /\/(?:root|home)\/[^\s'"`]+/, name);
    assert.doesNotMatch(source, /\.ssh\//, name);
  }
  const manifest = JSON.parse(readFileSync(script('fixtures-v7.json'), 'utf8'));
  assert.deepEqual(manifest, { drained: { status: 'pending', archive: '', sha256: '' } });
});

test('G8 requires an explicit worker before running any remote command', t => {
  const dir = mkdtempSync(join(tmpdir(), 'g8-config-'));
  t.after(() => safeWipeSync(dir));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const calls = join(dir, 'calls');
  for (const name of ['git', 'ssh']) writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> '${calls}'\necho fixture\n`, { mode: 0o700 });
  const result = spawnSync('bash', [script('g8-smooth.sh'), 'HEAD', 'idle'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, G8_SSH_HOST: '', G8_HOST_ROOT: '', G8_JOB: dir },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /G8_SSH_HOST/);
  assert.throws(() => readFileSync(calls));
});

test('G8 passes the configured destination, optional identity and worker root to its stand-in transport', t => {
  const dir = mkdtempSync(join(tmpdir(), 'g8-config-'));
  t.after(() => safeWipeSync(dir));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  copyFileSync(script('g8-smooth.sh'), join(dir, 'g8-smooth.sh'));
  writeFileSync(join(dir, 'g8-overlay.sh'), 'echo fixture-overlay\n');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho 0123456789012345678901234567890123456789\n', { mode: 0o700 });
  const calls = join(dir, 'ssh-calls');
  writeFileSync(join(bin, 'ssh'), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${calls}'\ncat > '${dir}/input'\n`, { mode: 0o700 });
  const identity = join(dir, 'fixture-identity');
  const result = spawnSync('bash', [join(dir, 'g8-smooth.sh'), 'HEAD', 'idle'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, G8_SSH_HOST: 'fixture.invalid', G8_SSH_IDENTITY: identity, G8_HOST_ROOT: '/srv/fixture', G8_STATE: join(dir, 'state'), G8_JOB: dir, G8_FIXTURE_MANIFEST: '/srv/fixture/manifest.json' },
  });
  assert.equal(result.status, 0, result.stderr);
  const recorded = readFileSync(calls, 'utf8');
  assert.ok(recorded.includes(`-i ${identity}`));
  assert.ok(recorded.includes('fixture.invalid'));
  assert.ok(recorded.includes("G8_HOST_ROOT='/srv/fixture'"));
  assert.ok(recorded.includes("G8_FIXTURE_MANIFEST='/srv/fixture/manifest.json'"));
});
