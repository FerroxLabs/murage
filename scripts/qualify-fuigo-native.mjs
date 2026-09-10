import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stageNativeFuigo, managedFuigoReceipt, probeNativeFuigo, verifyManagedFuigo } from '../server/fuigo-native-update.ts';
import { FUIGO_ASSETS, FUIGO_VERSION } from './prepare-fuigo.mjs';

const target = `${process.platform}-${process.arch}`;
assert(['linux-x64', 'win32-x64'].includes(target));
assert.equal(FUIGO_VERSION, '1.0.10');
if (process.platform === 'linux') assert.notEqual(process.getuid(), 0);
const root = await mkdtemp(join(tmpdir(), 'murage-fuigo-native-platform-'));
const result = { source: process.env.GITHUB_SHA ?? 'local', target, node: process.version, root, startedAt: new Date().toISOString(), steps: [], downloads: [] };
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const fetcher = async (input, init) => {
  const url = String(input);
  assert([`https://registry.npmjs.org/${encodeURIComponent(`@fuigo/${target}`)}/1.0.10`, `https://registry.npmjs.org/@fuigo/${target}/-/${target}-1.0.10.tgz`].includes(url));
  result.downloads.push(url); return fetch(url, init);
};
try {
  const cli = await stageNativeFuigo({ root, id: 'native-proof', version: '1.0.10', target, fetcher,
    probe: async (candidate, version, scratch) => {
      assert.equal(await hash(candidate), FUIGO_ASSETS[target].binarySha256, 'Refuse any bytes outside the reviewed exact release pin before execution');
      const proof = await probeNativeFuigo(candidate, version, scratch);
      result.steps.push({ action: 'production-probe-with-prelaunch-pin-check', proof }); return proof;
    },
  });
  const receipt = await managedFuigoReceipt(root, 'native-proof', cli);
  assert.equal(receipt.version, '1.0.10'); assert.equal(receipt.binarySha256, FUIGO_ASSETS[target].binarySha256);
  assert.deepEqual(receipt.proof, { version: '1.0.10', protocolVersion: 1, loadSession: true, sessionCreated: true });
  await verifyManagedFuigo(root, 'native-proof', cli, target);
  result.steps.push({ action: 'default-production-rollback-reverification', passed: true });
  assert.deepEqual((await readdir(dirname(cli))).sort(), [process.platform === 'win32' ? 'fuigo.exe' : 'fuigo', 'manifest.json'].sort());
  assert.equal(await hash(cli), receipt.binarySha256);
  Object.assign(result, { status: 'passed', receipt, cleanup: 'Production probe confirmed child close and isolation-profile cleanup; no probe scratch remains', noPrompt: true, noOwnerCredentials: true, network: 'OS denies every network connection, including loopback; native primitive denial receipts retained separately' });
} catch (error) {
  Object.assign(result, { status: 'failed', error: error.message, code: error.code ?? null, probeMethod: error.probeMethod ?? null, rpcCode: error.rpcCode ?? null, probeDiagnostic: error.probeDiagnostic ?? null, profileName: error.profileName ?? null, profileSid: error.profileSid ?? null });
  process.exitCode = 1;
}
result.finishedAt = new Date().toISOString();
await mkdir('.planning/0150-platform-native', { recursive: true });
await writeFile(`.planning/0150-platform-native/${target}-fuigo.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
