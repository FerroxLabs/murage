// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Run only inside the network-disabled test container: fixed tool/cache paths
// below belong to its disposable filesystem, never the host's shared tools.
const isolated = process.env.GATE_TEST_CONTAINER === '1' && existsSync('/.dockerenv');
const here = dirname(fileURLToPath(import.meta.url));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
  const deadline = Date.now() + 10_000;
  while (!fn()) { assert.ok(Date.now() < deadline, 'fixture reached its expected state'); await pause(20); }
}
function fixture({ holdFull = false, webCode = 1, browserBroken = false } = {}) {
  const root = mkdtempSync('/tmp/gate-controller-'), repo = join(root, 'repo'), bin = join(root, 'bin');
  const put = (path, body, mode) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body, { mode }); };
  mkdirSync(join(repo, 'scripts/release-gate'), { recursive: true }); mkdirSync(bin);
  for (const file of readdirSync(here).filter(f => f.endsWith('.mjs'))) copyFileSync(join(here, file), join(repo, 'scripts/release-gate', file));
  for (const file of ['server/testing/safe-wipe.mjs', 'electron/data-dir-lease.mjs', 'electron/windows-native.mjs']) {
    const target = join(repo, file); mkdirSync(dirname(target), { recursive: true });
    copyFileSync(new URL('../../' + file, import.meta.url), target);
  }
  const tools = join(root, 'tools');
  // Keep the controller's fixed tool layout inside this fixture, including its
  // exact-prefix owned-run parser. No host or container-global tool path is written.
  for (const name of ['gate-1019.mjs', 'owned-shards.mjs']) {
    const file = join(repo, 'scripts/release-gate', name);
    writeFileSync(file, readFileSync(file, 'utf8')
      .replaceAll('/root/fuigo-builds/tools', tools)
      .replaceAll(String.raw`\/root\/fuigo-builds\/tools`, tools.replaceAll('/', String.raw`\/`)));
  }
  // Host load is a fake scheduling input here. Keep regression timing independent
  // of unrelated host jobs; the production runner's load guard is unchanged.
  const controller = join(repo, 'scripts/release-gate/gate-1019.mjs');
  writeFileSync(controller, readFileSync(controller, 'utf8').replace("readFileSync('/proc/loadavg', 'utf8')", "'0 0 0'"));
  for (const file of ['pnpm-lock.yaml', 'scripts/build-murage-cage.mjs', 'scripts/prepare-source-cage.mjs',
    'scripts/web-read-replay/run.mjs', 'server/browser-turn-execution.test.ts', 'server/browser-owner-wait-api.test.ts']) put(join(repo, file), 'fixture\n');
  const git = args => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=ci', '-c', 'user.email=ci@example.test', 'commit', '-qm', 'Inert controller fixture']);
  const sha = git(['rev-parse', 'HEAD']);
  const lock = createHash('sha256').update('fixture\n').digest('hex').slice(0, 16);
  const cage = createHash('sha256').update('fixture\nfixture\n').digest('hex').slice(0, 16);
  mkdirSync(`${tools}/nm/${lock}/node_modules`, { recursive: true }); put(`${tools}/cage/${cage}/linux-x64/bwrap`, 'fixture');
  const ownedRun = `${tools}/runs/${sha.slice(0, 9)}-1111123456`, otherRun = `${tools}/runs/fffffffff-1111123456`;
  put(join(otherRun, 'src/other'), 'must survive');
  const state = join(root, 'containers.json'); put(state, JSON.stringify({ unrelated: join(otherRun, 'src') }));
  put(join(bin, 'docker'), `#!/usr/local/bin/node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), state = ${JSON.stringify(state)};
const read = () => JSON.parse(fs.readFileSync(state, 'utf8'));
fs.appendFileSync(${JSON.stringify(join(root, 'docker.jsonl'))}, JSON.stringify(args)+'\\n');
if (args[0] === 'image') process.exit(0);
if (args[0] === 'ps') { const volume = args.at(-1).replace('volume=', ''); console.log(Object.entries(read()).filter(([,v]) => v === volume).map(([k])=>k).join('\\n')); process.exit(0); }
if (args[0] === 'rm') { const s = read(); for(const id of args.slice(2)) delete s[id]; fs.writeFileSync(state, JSON.stringify(s)); process.exit(0); }
const mounts = args.flatMap((a,i) => a === '-v' ? [args[i+1]] : []);
const evidence = mounts.find(a=>a.endsWith(':/evidence'))?.slice(0,-10), command = args.at(-1);
if (evidence) {
 if(command.includes('web-read-replay')) {
  const sha = args.find(a=>a.startsWith('WEBREAD_REVISION=')).slice(17);
  fs.mkdirSync(path.join(evidence,'routes'), {recursive:true});
  fs.writeFileSync(path.join(evidence,'routes/verdict.json'), JSON.stringify({tree:sha,mode:'--fake',routeVerdict:'PASS',verdict:'UNVERIFIED'}));
  process.exit(${webCode});
 }
 const fail = ${browserBroken} && command.includes('browser-owner-wait-api.test.ts');
 fs.writeFileSync(path.join(evidence, 'tests.json'),JSON.stringify({numFailedTests:fail?1:0,testResults:[{assertionResults:[{fullName:'workflow fixture',status:fail?'failed':'passed'}]}]}));
 process.exit(fail?1:0);
}
process.exit(0);
`, 0o755);
  put(`${tools}/vt-shard.sh`, holdFull ? `#!/bin/bash
set -eu
RUN=${ownedRun}
mkdir -p "$RUN/src"
echo inert > "$RUN/src/marker"
node -e 'const fs=require("node:fs"); const p=${JSON.stringify(state)}; const s=JSON.parse(fs.readFileSync(p)); s.abc123=${JSON.stringify(join(ownedRun, 'src'))}; fs.writeFileSync(p,JSON.stringify(s));'
echo ready > ${join(root, 'ready')}
sleep 300
` : '#!/bin/bash\nexit 4\n', 0o755);
  const out = join(root, 'evidence');
  const child = spawn(process.execPath, [join(repo, 'scripts/release-gate/gate-1019.mjs'), sha, '--base', sha, '--out', out, '--dry-run'],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
  const done = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { root, child, done, state, ownedRun, otherRun, out, result: gate => JSON.parse(readFileSync(join(out, readdirSync(out)[0], gate + '.json'), 'utf8')) };
}

test('BLOCK-1 SIGINT and SIGTERM remove FULL containers and source, preserve unrelated resources', { skip: !isolated }, async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const f = fixture({ holdFull: true });
    try {
      await until(() => existsSync(join(f.root, 'ready')));
      f.child.kill(signal);
      assert.equal((await f.done).code, 130);
      assert.equal(JSON.parse(readFileSync(f.state)).abc123, undefined, 'owned FULL container removed');
      assert.equal(existsSync(join(f.ownedRun, 'src')), false, 'owned FULL export removed');
      assert.ok(existsSync(join(f.otherRun, 'src/other')), 'unrelated export preserved');
      assert.ok(JSON.parse(readFileSync(f.state)).unrelated, 'unrelated container preserved');
    } finally { if (f.child.exitCode === null) { f.child.kill('SIGKILL'); await f.done; } }
  }
});

test('BLOCK-2 G-WEB rejects abnormal exits despite a matching PASS report; expected exit 1 stays valid', { skip: !isolated }, async () => {
  for (const code of [1, 124, 125, 137, 143, 2, 0]) {
    const f = fixture({ webCode: code }); await f.done;
    const expected = code === 1 ? 'PASS' : 'FAIL'; // verdict UNVERIFIED => harness exit 1
    assert.equal(f.result('G-WEB-fake-routes').result, expected, `harness exit ${code}`);
  }
});

test('BLOCK-3 browser workflow failure blocks the field row even when helper tests pass', { skip: !isolated }, async () => {
  const f = fixture({ browserBroken: true }); await f.done;
  assert.equal(f.result('G-MARC-browser').result, 'FAIL', 'server owner-wait workflow must run');
  const commands = readFileSync(join(f.root, 'docker.jsonl'), 'utf8');
  assert.ok(commands.includes('server/browser-turn-execution.test.ts'));
  assert.ok(commands.includes('server/browser-owner-wait-api.test.ts'));
});
