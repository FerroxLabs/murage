import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
assert.equal(process.platform, 'win32'); assert.equal(process.versions.node.split('.')[0], '24');
const exec = promisify(execFile), bin = resolve('dist-native/fuigo-probe/win32-x64');
const root = await mkdtemp(join(tmpdir(), 'murage fuigo isolation ')), home = join(root, 'probe');
await mkdir(join(home, 'fuigo'), { recursive: true });
await writeFile(join(home, 'fuigo/config.toml'), '[features]\nremote_fetch=false\n');
const env = { PATH: '', HOME: home, USERPROFILE: home, FUIGO_HOME: join(home, 'fuigo'), APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };
const run = (name, args) => exec(join(bin, name + '.exe'), args, { cwd: home, env, timeout: 20000, maxBuffer: 65536 });
const receipt = { node: process.version, root, startedAt: new Date().toISOString(), qualification: false, diagnosticInvocation: 'C3' };
const name = `murage-fuigo-probe-${randomUUID()}`; let sid;
try {
  sid = (await run('launcher', ['setup', join(bin, 'canary.exe'), home, name])).stdout.trim();
  assert.match(sid, /^S-1-15-2-(?:\d+-)*\d+$/); receipt.profile = { name, sid };
  receipt.imageSha256 = createHash('sha256').update(await readFile(join(home, 'probe-fuigo.exe'))).digest('hex');
  receipt.diagnostic = await run('windows-launch-diagnostic', [name, sid, home]);
  receipt.status = 'diagnostic-collected';
} catch (error) { receipt.status = 'diagnostic-failed'; receipt.error = { message: error.message, stdout: error.stdout, stderr: error.stderr }; process.exitCode = 1; }
finally {
  if (sid) { try { await run('launcher', ['cleanup', name, sid]); receipt.profileDeleted = true; } catch (error) { receipt.profileDeleted = false; receipt.cleanupError = error.message; process.exitCode = 1; } }
  receipt.finishedAt = new Date().toISOString(); await mkdir('.planning/0150-windows-c3', { recursive: true });
  await writeFile('.planning/0150-windows-c3/launch.json', JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify(receipt));
