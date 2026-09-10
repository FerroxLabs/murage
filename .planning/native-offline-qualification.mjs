import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { probeNativeFuigo } from '../server/fuigo-native-update.ts';

const exec = promisify(execFile);
const binary = '/private/var/folders/8h/chxws5390hx17g49p75b2xn00000gn/T/murage-fuigo-synthetic-8IOqZC/fuigo/synthetic/1.0.10-6ad239cd-5c2f-4b76-808d-d191f1ce2b20/fuigo';
const expectedSha256 = '10ef84065521868e5ae6122941c3318394b9eae4bcc7450cc61ea8ccd36097cd';
const root = await mkdtemp(join(tmpdir(), 'murage-fuigo-offline-'));
const result = { source: '9a40c0d3 plus isolated offline probe change', target: `${process.platform}-${process.arch}`, node: process.version, binary, expectedSha256, root, startedAt: new Date().toISOString() };
const listener = createServer(socket => { result.canaryConnections = (result.canaryConnections ?? 0) + 1; socket.destroy(); });
try {
  assert.equal(process.platform, 'darwin');
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), expectedSha256);
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const policy = join(root, 'deny-all.sb');
  await writeFile(policy, '(version 1)\n(allow default)\n(deny network-outbound)\n', { flag: 'wx', mode: 0o600 });
  const canary = `const net=require('node:net');const socket=net.connect({host:'127.0.0.1',port:${listener.address().port}});socket.on('connect',()=>{socket.destroy();process.exitCode=9});socket.on('error',error=>{if(error.code!=='EPERM')process.exitCode=8;else process.stdout.write('DENIED_EPERM')});setTimeout(()=>socket.destroy(),1500).unref();`;
  const denied = await exec('/usr/bin/sandbox-exec', ['-f', policy, process.execPath, '-e', canary], { cwd: root, env: { HOME: root, PATH: '', TMPDIR: root }, timeout: 5000, maxBuffer: 65536 });
  assert.equal(denied.stdout, 'DENIED_EPERM'); assert.equal(result.canaryConnections ?? 0, 0);
  result.networkCanary = 'EPERM; zero accepted loopback connections; no outbound exception';
  const scratch = join(root, 'probe-scratch'); await mkdir(scratch, { mode: 0o700 });
  result.proof = await probeNativeFuigo(binary, '1.0.10', scratch);
  assert.deepEqual(result.proof, { version: '1.0.10', protocolVersion: 1, loadSession: true, sessionCreated: true });
  assert.deepEqual(await readdir(scratch), []);
  result.status = 'passed'; result.probeCleanup = true;
} catch (error) {
  result.status = 'failed'; result.error = error.message; result.code = error.code ?? null; result.probeMethod = error.probeMethod ?? null;
  process.exitCode = 1;
} finally {
  if (listener.listening) await new Promise(resolve => listener.close(resolve));
  result.listenerClosed = !listener.listening; result.finishedAt = new Date().toISOString();
  await writeFile(new URL('./0150-offline-r1.json', import.meta.url), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify(result));
