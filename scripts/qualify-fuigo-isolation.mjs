import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile), target = `${process.platform}-${process.arch}`;
const bin = resolve('dist-native/fuigo-probe', target), suffix = process.platform === 'win32' ? '.exe' : '';
const helper = join(bin, 'launcher' + suffix), canary = join(bin, 'canary' + suffix);
const root = await mkdtemp(join(tmpdir(), 'murage fuigo isolation ')), home = join(root, 'probe'), outside = join(root, 'owner-canary.txt');
await mkdir(join(home, 'fuigo'), { recursive: true });
const inside = join(home, 'fuigo', 'config.toml');
await writeFile(inside, '[features]\nremote_fetch = false\n', { mode: 0o600 }); await writeFile(outside, 'SYNTHETIC_CREDENTIAL_CANARY', { mode: 0o600 });
const env = { PATH: '', HOME: home, USERPROFILE: home, FUIGO_HOME: join(home, 'fuigo'), APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home, TMPDIR: home, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}) };
let connections = 0, name, sid, held, result = { target, root, node: process.version, startedAt: new Date().toISOString() };
const listeners = [createServer(socket => { connections++; socket.destroy(); }), createServer(socket => { connections++; socket.destroy(); })];
const unixPath = join(root, 'outside.sock');
const unixListener = process.platform === 'linux' ? createServer(socket => { connections++; socket.destroy(); }) : null;
const run = async (command, args, options = {}) => exec(command, args, { cwd: home, env, timeout: 12000, maxBuffer: 65536, ...options });
try {
  await Promise.all(listeners.map((server, index) => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, index ? '::1' : '127.0.0.1', resolveListen); })));
  const ports = listeners.map(server => String(server.address().port));
  if (unixListener) await new Promise((resolveListen, reject) => { unixListener.once('error', reject); unixListener.listen(unixPath, resolveListen); });
  const inputs = [...ports, outside, inside, ...(unixListener ? [unixPath] : [])];
  result.control = JSON.parse((await run(canary, ['control', ...inputs])).stdout);
  assert.equal(result.control.network4, 1); assert.equal(result.control.network6, 1); assert.equal(result.control.outsideRead, 1); assert.equal(result.control.insideRead, 1);
  assert.equal(result.control.administrator, 0, 'Qualification must run without administrator/root authority');
  if (unixListener) { assert.equal(result.control.namedUnix, 1); assert.equal(result.control.privatePair, 1); }
  const prefix = process.platform === 'win32' ? null : ['run', canary, home];
  if (process.platform === 'win32') {
    name = `murage-fuigo-probe-${randomUUID()}`;
    sid = (await run(helper, ['setup', canary, home, name])).stdout.trim();
    assert.match(sid, /^S-1-15-2-(?:\d+-)*\d+$/); result.profile = { name, sid };
  }
  const isolated = prefix ?? ['run', name, sid, home];
  const before = connections;
  result.restricted = JSON.parse((await run(helper, [...isolated, 'restricted', ...inputs])).stdout);
  assert.deepEqual(result.restricted, { network4: 0, network6: 0, outsideRead: 0, insideRead: 1, isolated: 1, syscallsDenied: 1, administrator: 0, ...(unixListener ? { namedUnix: 0, privatePair: 1 } : {}) });
  assert.equal(connections, before); result.deniedConnections = 0;
  held = spawn(helper, [...isolated, 'hold'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const heldPid = await new Promise((resolvePid, reject) => { let value = ''; held.stdout.on('data', chunk => { value += chunk; if (value.includes('\n')) resolvePid(Number(value.trim())); }); held.once('error', reject); held.once('exit', () => reject(Error('Held canary exited early'))); setTimeout(() => reject(Error('Held canary did not start')), 5000).unref(); });
  assert(Number.isSafeInteger(heldPid) && heldPid > 0);
  const closed = new Promise(resolveClose => held.once('close', resolveClose)); held.kill('SIGTERM'); await closed;
  let alive = true;
  for (let i = 0; i < 30; i++) { try { process.kill(heldPid, 0); } catch { alive = false; break; } await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
  assert.equal(alive, false, 'Native contained child survived launcher termination'); result.terminatedChildPid = heldPid;
  result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (held && held.exitCode === null && held.signalCode === null) held.kill('SIGTERM');
  if (sid) { try { await run(helper, ['cleanup', name, sid]); result.profileDeleted = true; } catch (error) { result.profileDeleted = false; result.cleanupError = error.message; result.status = 'failed'; process.exitCode = 1; } }
  await Promise.all([...listeners, ...(unixListener ? [unixListener] : [])].map(server => server.listening ? new Promise(resolveClose => server.close(resolveClose)) : undefined));
  result.finishedAt = new Date().toISOString();
  await mkdir('.planning/0150-platform-native', { recursive: true });
  await writeFile(`.planning/0150-platform-native/${target}-isolation.json`, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
