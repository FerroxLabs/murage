// Synthetic evidence for isolated tests only. Never copied into the committed G0 directory.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIGNAL_CLI_COMMIT as CLI_COMMIT, SIGNAL_NETWORK_COMMIT as NETWORK_COMMIT, REQUIRED_FIXTURES as FIXTURE_IDS, invariantFixtures as INVARIANT_FIXTURES, artifactBinding } from '../../server/channels/signal/evidence.mjs';
export { CLI_COMMIT, NETWORK_COMMIT, FIXTURE_IDS };
export const INVARIANTS = Object.keys(INVARIANT_FIXTURES);
export const syntheticSyncProof = {
  authenticatedSenderDiscard: `https://github.com/Turasa/libsignal-service-java/blob/${NETWORK_COMMIT}/lib/libsignal-service/src/main/java/org/whispersystems/signalservice/synthetic/Sender.kt#L1`,
  pniEndpointDiscard: `https://github.com/Turasa/libsignal-service-java/blob/${NETWORK_COMMIT}/lib/libsignal-service/src/main/java/org/whispersystems/signalservice/synthetic/Endpoint.kt#L1`,
  sourceIdentityTrace: [`signal-cli ${CLI_COMMIT} MessageEnvelope.java:1033`, `signal-cli ${CLI_COMMIT} JsonMessageEnvelope.java:50-55`],
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function writeTestEvidence(pin, root, mutate = () => {}) {
  mkdirSync(root, { recursive: true });
  const artifactSha256 = artifactBinding(pin);
  const manifest = { contract: 'murage-signal-g0/1.0', capture: 'live', signalCliVersion: pin.signalCliVersion,
    signalCliCommit: CLI_COMMIT, artifactSha256,
    captureDevices: { M: 3, P: 4, Q: 5 }, results: { 'S1-TS': true, 'S1-ECHO': false, 'S7-UNLINK': false },
    securityInvariants: Object.fromEntries(INVARIANTS.map(id => [id, { passed: true, fixtures: INVARIANT_FIXTURES[id] }])),
    fixtures: FIXTURE_IDS.map((id, index) => {
      const path = `${id}.json`, bytes = JSON.stringify({ synthetic: true, id });
      writeFileSync(join(root, path), bytes);
      return { id, path, sha256: hash(bytes), capturedOn: 'M', captureSequence: index + 1,
        ...(['other-sender-sync', 'pni-sync', 'malformed-identity'].includes(id) ? { origin: 'mutated', from: 'own-note' } : { origin: 'live' }) };
    }),
  };
  mutate(manifest);
  const bytes = JSON.stringify(manifest);
  writeFileSync(join(root, 'manifest.json'), bytes);
  pin.g0 = { signalCliVersion: pin.signalCliVersion, citation: 'synthetic test evidence only', signalCliCommit: CLI_COMMIT,
    artifactSha256, manifestSha256: hash(bytes), reviewedBy: 'synthetic reviewer', review: 'synthetic review only' };
  return manifest;
}
