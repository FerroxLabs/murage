// SPDX-License-Identifier: AGPL-3.0-or-later
// Linux container qualification only. Never run on the user's installation.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { HighLevelLeakGuardV2 } from '../server/testing/highlevel-leak-guard-v2.ts';
const dir = path.resolve('.test-tmp/bld-hlpw3/native'); mkdirSync(dir, { recursive: true });
assert.equal(process.platform, 'linux');
const addon = path.join(dir, 'engine-exclusion.node');
const compile = spawnSync('gcc', ['-std=c11', '-D_GNU_SOURCE', '-O2', '-Wall', '-Werror', '-fPIC', '-shared', '-DNAPI_VERSION=9', '-I', '/usr/local/include/node', 'native/engine-exclusion/exclusion.c', '-o', addon], { encoding: 'utf8' });
writeFileSync(path.join(dir, 'compile.log'), `${compile.stdout}${compile.stderr}`);
assert.equal(compile.status, 0, 'native compiler failed');
const sentinel = `Aa4!${randomBytes(24).toString('base64url')}`, guard = new HighLevelLeakGuardV2([sentinel]);
const input = Buffer.from(sentinel);
const protection = pathToFileURL(path.resolve('shared/password-process-protection.mjs')).href;
const script = `(async () => { const assert=require('node:assert/strict'); const fs=require('node:fs'); const addon=require(${JSON.stringify(addon)});
assert.equal(typeof addon.disableCoreDumps,'function'); assert.equal(addon.disableCoreDumps(),true);
const {protectPasswordProcess}=await import(${JSON.stringify(protection)}); assert.equal(protectPasswordProcess({native:addon}),true);
const bytes=fs.readFileSync(0); globalThis.fixtureSecret=bytes.toString('utf8'); bytes.fill(0); assert.equal(globalThis.fixtureSecret.length > 20,true);
assert.throws(()=>process.report.writeReport()); assert.throws(()=>require('node:v8').writeHeapSnapshot());
assert.match(fs.readFileSync('/proc/self/limits','utf8'),/Max core file size\\s+0\\s+0/);
process.stdout.write('protected\\n'); setTimeout(()=>process.abort(),1000); })();`;
const child = spawn(process.execPath, ['-e', script], { cwd: dir, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
const exited = once(child, 'exit');
let output = '', errors = '';
child.stdout.on('data', bytes => { output += bytes.toString(); });
child.stderr.on('data', bytes => { errors += bytes.toString(); });
child.stdin.on('error', () => {});
child.stdin.end(input, () => input.fill(0));
const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
try {
  while (!output.includes('protected\n') && child.exitCode === null && child.signalCode === null) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(output.includes('protected\n'), true, 'the child must establish native protection');
  let parentCouldReadMemory = false;
  try { const fd = openSync(`/proc/${child.pid}/mem`, 'r'); closeSync(fd); parentCouldReadMemory = true; } catch (error) { assert.ok(['EACCES', 'EPERM'].includes(error.code)); }
  assert.equal(parentCouldReadMemory, false, 'same user parent must not read protected process memory');
  const [, signal] = await exited;
  guard.wrapSink('logging', () => {})(output, errors);
  writeFileSync(path.join(dir, 'crash.log'), output + errors);
  assert.equal(signal, 'SIGABRT', 'the child must abort after the protection assertions');
  assert.equal(readdirSync(dir).some(name => /^(?:core(?:\.|$)|report\.|.*\.heapsnapshot$|.*\.dmp$)/u.test(name)), false);
  const scan = await guard.scanFiles([dir]); assert.equal(scan.leaks, 0);
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ platform: process.platform, abortSignal: signal, coreHardLimit: 0, parentCouldReadMemory, dumpFiles: 0, scan }));
  console.log('Linux native protection: parent memory read denied, forced SIGABRT, hard core limit zero, zero dump files and zero leak matches.');
} finally {
  clearTimeout(deadline); input.fill(0);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
}
