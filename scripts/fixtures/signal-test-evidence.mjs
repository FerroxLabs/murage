// Synthetic verifier inputs for isolated temporary directories only; never live evidence.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { artifactBinding, REQUIRED_FIXTURES, SIGNAL_CLI_COMMIT } from '../../server/channels/signal/evidence.mjs';
import { syntheticSyncProof } from './signal-evidence.mjs';
export const evidenceHash = bytes => createHash('sha256').update(bytes).digest('hex');
export function makeSyntheticEvidence(dir, inputPin) {
  if (resolve(dir).includes('/server/channels/signal/fixtures/g0')) throw Error('Synthetic evidence must stay outside the capture tree');
  mkdirSync(dir, { recursive: true });
  const pin = inputPin ?? JSON.parse(readFileSync(new URL('../../server/channels/signal/runtime-pin.json', import.meta.url)));
  pin.signalNetwork.syncProof = structuredClone(syntheticSyncProof);
  const artifactSha256 = artifactBinding(pin);
  const ids = [...REQUIRED_FIXTURES, 'unlink-response', 'unlink-survivor'];
  const frames = Object.fromEntries(ids.map(id => [id, { synthetic: true, id }]));
  frames['own-note'] = { jsonrpc: '2.0', method: 'receive', params: { account: '+15550000001', envelope: { sourceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } } };
  frames['unlink-response'] = { jsonrpc: '2.0', id: 1, result: {} };
  frames['unlink-survivor'] = { jsonrpc: '2.0', method: 'receive', params: { account: '+15550000001', envelope: { sourceUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    timestamp: 1800000001000, dataMessage: { message: 'g0 still there' } } } };
  const manifest = { contract: 'murage-signal-g0/1.0', capture: 'live', signalCliVersion: pin.signalCliVersion,
    signalCliCommit: SIGNAL_CLI_COMMIT, artifactSha256, captureDevices: { M: 3, P: 4, Q: 5 },
    results: { 'S1-TS': true, 'S1-ECHO': true, 'S7-UNLINK': true },
    fixtures: ids.map((id, index) => ({ id, path: `${id}.json`, sha256: '',
      origin: ['other-sender-sync', 'pni-sync', 'malformed-identity'].includes(id) ? 'mutated' : 'live',
      ...(['other-sender-sync', 'pni-sync', 'malformed-identity'].includes(id) ? { from: 'own-note' } : {}),
      capturedOn: id === 'unlink-response' ? 'P' : id === 'unlink-survivor' ? 'Q' : 'M', captureSequence: index + 1 })),
    securityInvariants: Object.fromEntries(['authenticated-sender', 'pni-endpoint', 'own-echo', 'group', 'history', 'malformed-identity', 'long-text', 'immutable-expiry'].map(id => [id, { passed: true, fixtures: [...REQUIRED_FIXTURES] }])),
    unlinkProof: { method: 'unregister', params: {}, signalCliCommit: SIGNAL_CLI_COMMIT, role: 'linked-device',
      device: 'P', deviceId: 4, survivorDevice: 'Q', onlyLinkedDeviceRemoved: true, numberStillRegistered: true,
      phoneConfirmedPeerRemoved: true, fixtures: { response: 'unlink-response', survivor: 'unlink-survivor' },
      observedBy: 'synthetic operator confirmation only', citation: 'synthetic unit test only' },
  };
  const save = () => {
    for (const row of manifest.fixtures) { const bytes = JSON.stringify(frames[row.id]); row.sha256 = evidenceHash(bytes); writeFileSync(join(dir, row.path), bytes); }
    const bytes = JSON.stringify(manifest); writeFileSync(join(dir, 'manifest.json'), bytes);
    pin.g0 = { signalCliVersion: pin.signalCliVersion, signalCliCommit: SIGNAL_CLI_COMMIT, artifactSha256,
      manifestSha256: evidenceHash(bytes), citation: 'synthetic unit test only', reviewedBy: 'synthetic', review: 'synthetic' };
  };
  save(); return { pin, manifest, frames, save };
}
