// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { launchVerificationServer, runControlMurage, controlResultSucceeded } from './control-murage.ts';
import { HighLevelLeakGuardV2 } from '../server/testing/highlevel-leak-guard-v2.ts';
import { userCreateArtifactFiles } from '../server/testing/userscreate-output-capture.ts';
import { removeTempDir } from '../server/testing/cleanup.ts';
const evidence = process.env.USERSCREATE_EVIDENCE_DIR ?? '.test-tmp/afix-bld-hl-userscreate/flow';
mkdirSync(evidence, { recursive: true });
// Test observer only: generated needles cross an owned Unix pipe into parent
// memory. No needle enters env, argv, instrumentation source or an artifact.
const observerDir = mkdtempSync(join(tmpdir(), 'hl-observer-'));
const socketPath = join(observerDir, 'observer.sock'), secrets = [], scans = [];
const observer = createServer(socket => {
  let text = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    text += chunk;
    if (!text.endsWith('\n')) return;
    const input = JSON.parse(text); text = '';
    if (input.secret) { secrets.push(input.secret); socket.end('[]\n'); }
    else socket.end(JSON.stringify(secrets) + '\n');
  });
});
await new Promise((resolve, reject) => { observer.once('error', reject); observer.listen(socketPath, resolve); });
let fixture;
const logs = [];
try {
  fixture = await launchVerificationServer(process.env, undefined, { readyTimeoutMs: 60_000, instrumentationSource: `
    const { existsSync, writeFileSync } = await import('node:fs');
    const { connect } = await import('node:net');
    const { join } = await import('node:path');
    const exchange = input => new Promise((resolve, reject) => {
      const socket = connect(${JSON.stringify(socketPath)}); let text = '';
      socket.setEncoding('utf8'); socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify(input) + '\\n'));
      socket.on('data', chunk => { text += chunk; });
      socket.on('end', () => resolve(JSON.parse(text)));
    });
    const { runFixtureEvidence, runRestartEvidence } = await import(${JSON.stringify(new URL('./highlevel-userscreate-fixture-driver.ts', import.meta.url).href)});
    const restarted = existsSync(join(process.env.MURAGE_DATA_DIR, 'userscreate-result.json'));
    const result = restarted ? await runRestartEvidence(process.env.MURAGE_DATA_DIR, await exchange({ recall: true }))
      : await runFixtureEvidence(process.env.MURAGE_DATA_DIR, secret => exchange({ secret }));
    writeFileSync(join(process.env.MURAGE_DATA_DIR, restarted ? 'userscreate-restart.json' : 'userscreate-result.json'), JSON.stringify(result, null, 2));
  ` });
  logs.push(fixture.info.logPath);
  const guard = new HighLevelLeakGuardV2(secrets);
  const scan = async phase => {
    const live = phase === 'before-shutdown' || phase === 'after-restart';
    let resumePid;
    try {
      if (live && process.platform === 'linux') {
        // Snapshot the still-open data/home and SQLite sidecars together. The
        // startup builders may otherwise unlink a journal between inventory and
        // read. This PID belongs to the exact child launched above, never a
        // discovered app; all workflow mutations have already completed.
        assert.equal(fixture.child.pid, fixture.info.pid);
        assert.equal(fixture.child.exitCode, null);
        resumePid = fixture.child.pid;
        process.kill(resumePid, 'SIGSTOP');
        const until = Date.now() + 1000;
        for (;;) {
          let stopped = false;
          try {
            const threads = readdirSync(`/proc/${resumePid}/task`);
            stopped = threads.length > 0 && threads.every(id => /^State:\s+[Tt]/m.test(readFileSync(`/proc/${resumePid}/task/${id}/status`, 'utf8')));
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (stopped) break;
          assert.ok(Date.now() < until, 'Every owned server thread must stop before the complete snapshot');
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }
      const files = userCreateArtifactFiles([fixture.info.dataDir, evidence, ...logs]);
      const result = await guard.scanFiles(files);
      assert.equal(result.leaks, 0, 'No secret may reach process logs, transcripts or persisted artifacts');
      const grep = spawnSync('grep', ['-alF', '-f', '-', '--', ...files], { input: secrets.join('\n') + '\n' });
      if (grep.status === 2 || grep.error) writeFileSync(join(evidence, 'grep-error.json'), JSON.stringify({ code: grep.error?.code, stderr: grep.stderr?.toString(), files: files.length }));
      assert.equal(grep.status, 1, 'Generated-secret grep must find zero artifacts');
      scans.push({ phase, ...result, grepExit: grep.status, scope: ['entire isolated data/home including hidden artifacts and SQLite/WAL', 'all server process logs', 'exported evidence'] });
      writeFileSync(join(evidence, 'scans.json'), JSON.stringify(scans, null, 2));
    } finally {
      if (resumePid !== undefined) process.kill(resumePid, 'SIGCONT');
    }
    if (live) {
      const resumed = await runControlMurage(['doctor', '--url', fixture.info.url], { env: { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir } });
      assert.equal(controlResultSucceeded('doctor', resumed), true, 'The same fixture must respond after its live artifact snapshot');
      writeFileSync(join(evidence, `resumed-${phase}.json`), JSON.stringify(resumed, null, 2));
    }
  };
  // Positive control proves the very same scanner/grep sees a generated needle.
  const positive = join(evidence, 'positive-control.bin');
  writeFileSync(positive, secrets[0]);
  try {
    assert.equal((await guard.scanFiles([positive])).leaks, 1);
    assert.equal(spawnSync('grep', ['-alF', '-f', '-', '--', positive], { input: secrets[0] + '\n' }).status, 0);
  } finally { unlinkSync(positive); }
  const doctor = await runControlMurage(['doctor', '--url', fixture.info.url], { env: { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir } });
  if (!controlResultSucceeded('doctor', doctor)) throw new Error('Isolated Doctor failed');
  writeFileSync(join(evidence, 'fixture.json'), JSON.stringify(fixture.info, null, 2));
  writeFileSync(join(evidence, 'doctor.json'), JSON.stringify(doctor, null, 2));
  writeFileSync(join(evidence, 'flow.json'), readFileSync(join(fixture.info.dataDir, 'userscreate-result.json')));
  await scan('before-shutdown');
  await fixture.stop(); await scan('after-shutdown');
  await fixture.restart(); logs.push(fixture.info.logPath);
  writeFileSync(join(evidence, 'restart-fixture.json'), JSON.stringify(fixture.info, null, 2));
  writeFileSync(join(evidence, 'restart.json'), readFileSync(join(fixture.info.dataDir, 'userscreate-restart.json')));
  await scan('after-restart');
  await fixture.stop(); await scan('after-restart-shutdown');
  for (const file of userCreateArtifactFiles([fixture.info.dataDir])) {
    const destination = join(evidence, 'persisted', relative(fixture.info.dataDir, file));
    mkdirSync(dirname(destination), { recursive: true }); copyFileSync(file, destination);
  }
  for (const [index, log] of logs.entries()) copyFileSync(log, join(evidence, `server-${index}.log`));
  await scan('exported-before-cleanup');
  console.log('PASS isolated fake users.create: real output interception; full data/log grep and encoded scans before/after shutdown and restart; zero replacement creates');
} finally {
  await fixture?.close();
  await new Promise(resolve => observer.close(resolve));
  await removeTempDir(observerDir);
  secrets.fill('');
}
