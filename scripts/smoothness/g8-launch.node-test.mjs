import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const script = name => fileURLToPath(new URL(name, import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'g8-launch-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const run = (name, args) => spawnSync('bash', [script(name), ...args], { encoding: 'utf8', timeout: 5000 });

test('ACP patch is skipped on an already patched tree even with an unusable patch', t => {
  const dir = fixture(t), file = join(dir, 'fake.ts');
  const before = 'const target = process.env.FAKE_ACP_DELEGATE_TO;\n';
  writeFileSync(file, before);
  const result = run('g8-fake-patch.sh', [file, join(dir, 'missing.patch')]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /patch skipped/);
  assert.equal(readFileSync(file, 'utf8'), before);
});
test('ACP patch applies once and repeats without a reversed-patch prompt', t => {
  const dir = fixture(t), file = join(dir, 'fake.ts'), patch = join(dir, 'change.patch');
  writeFileSync(file, 'const target = "first";\n');
  writeFileSync(patch, '--- fake.ts\n+++ fake.ts\n@@ -1 +1 @@\n-const target = "first";\n+const target = process.env.FAKE_ACP_DELEGATE_TO;\n');
  for (let i = 0; i < 2; i++) {
    const result = run('g8-fake-patch.sh', [file, patch]);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.match(readFileSync(file, 'utf8'), /FAKE_ACP_DELEGATE_TO/);
});
test('ACP patch failure is diagnostic and nonzero', t => {
  const dir = fixture(t), file = join(dir, 'fake.ts');
  writeFileSync(file, 'unpatched\n');
  const result = run('g8-fake-patch.sh', [file, join(dir, 'missing.patch')]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /g8-fake-patch:.*failed/);
});
test('wait propagates the launcher failure status', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'done'), '19\n');
  assert.equal(run('g8-wait.sh', [dir, '1']).status, 19);
});
test('wait detects a dead launcher without waiting for its deadline', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'launcher'), '2147483647 1\n');
  const result = run('g8-wait.sh', [dir, '60']);
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /died without completion/);
});
test('wait rejects a reused PID with a different start time', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'launcher'), `${process.pid} 0\n`);
  const result = run('g8-wait.sh', [dir, '60']);
  assert.equal(result.status, 4, result.stderr);
});
test('wait has a hard timeout while the launcher is alive', async t => {
  const dir = fixture(t), child = spawn('sleep', ['20']);
  const stopped = once(child, 'exit');
  t.after(async () => { child.kill('SIGTERM'); await stopped; });
  const fields = readFileSync(`/proc/${child.pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ');
  writeFileSync(join(dir, 'launcher'), `${child.pid} ${fields[19]}\n`);
  const result = run('g8-wait.sh', [dir, '1']);
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /hard timeout/);
});
test('wait also times out if the launcher never publishes its PID', t => {
  const result = run('g8-wait.sh', [fixture(t), '1']);
  assert.equal(result.status, 124, result.stderr);
});
test('overlay failure cannot be hidden by command substitution', t => {
  const result = run('g8-overlay.sh', ['not-a-commit', 'HEAD', fixture(t)]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /g8-overlay:.*failed/);
});

for (const [worker, tee, expected] of [[0, 0, 0], [1, 0, 1], [124, 0, 124], [255, 0, 255], [0, 7, 4], [1, 7, 4]]) {
  test(`launcher distinguishes worker=${worker} from tee=${tee}`, t => {
    const dir = fixture(t), bin = join(dir, 'bin'), state = join(dir, 'state');
    mkdirSync(bin);
    copyFileSync(script('g8-smooth.sh'), join(dir, 'g8-smooth.sh'));
    writeFileSync(join(dir, 'g8-overlay.sh'), 'echo overlay\n');
    const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
    stub('git', 'echo 0123456789012345678901234567890123456789');
    stub('ssh', `if [[ "$*" == *g8-host.sh* ]]; then echo gate-output; exit ${worker}; fi\ncat > "${dir}/ssh-input"`);
    if (tee) stub('tee', `cat > "$1"; exit ${tee}`);
    const result = spawnSync('bash', [join(dir, 'g8-smooth.sh'), 'HEAD', 'idle'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, G8_STATE: state, G8_JOB: dir, G8_SSH_HOST: "fixture.invalid", G8_HOST_ROOT: "/srv/fixture" },
    });
    assert.equal(result.status, expected, result.stderr);
    assert.equal(readFileSync(join(state, 'done'), 'utf8'), `${expected}\n`);
    assert.equal(readFileSync(join(state, 'worker.exit'), 'utf8'), `${worker}\n`);
    assert.equal(readFileSync(join(state, 'tee.exit'), 'utf8'), `${tee}\n`);
    assert.match(readFileSync(join(state, 'launcher.log'), 'utf8'), /gate-output/);
    assert.doesNotMatch(result.stderr, /line .*failed.*tee/);
    if (tee) assert.match(result.stderr, /log write failed/);
    else assert.match(result.stdout, new RegExp(`worker exit=${worker}; log saved=`));
  });
}
