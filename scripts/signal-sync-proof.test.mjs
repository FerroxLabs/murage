// Source evidence only: these tests never log in or capture Signal traffic.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { assertSyncEvidence } from '../server/channels/signal/evidence.mjs';
const proof = JSON.parse(readFileSync('docs/verification/evidence/signal-sync/sync-proof.json', 'utf8'));
test('T-SYNC-PROOF: corrected URL-bearing block passes and all committed copies agree', () => {
 const markdown = readFileSync('docs/verification/evidence/signal-sync/SYNC-CITATIONS.md', 'utf8');
 expect(JSON.parse(markdown.match(/```json\n([\s\S]*?)\n```/)[1])).toEqual(proof);
 expect(() => assertSyncEvidence({ signalNetwork: { syncProof: proof } })).not.toThrow();
 const pin = JSON.parse(readFileSync('server/channels/signal/runtime-pin.json', 'utf8'));
 expect(pin.signalNetwork.syncProof).toEqual(proof);
});
test.each(['authenticatedSenderDiscard', 'pniEndpointDiscard'])('T-SYNC-PROOF: rejects wrong :629 comparison in %s', field => {
 const wrong = { ...proof, [field]: proof[field].replace('SignalServiceContent.kt:623', 'SignalServiceContent.kt:629').replace('SignalServiceContent.kt:524-535,623', 'SignalServiceContent.kt:524-535,629') };
 expect(() => assertSyncEvidence({ signalNetwork: { syncProof: wrong } })).toThrow();
});
test('T-SYNC-PROOF: a standalone proof without pinned dependency URLs fails', () => {
 const wrong = { ...proof, authenticatedSenderDiscard: proof.authenticatedSenderDiscard.replace(/https:\/\/\S+/g, ''), pniEndpointDiscard: proof.pniEndpointDiscard.replace(/https:\/\/\S+/g, '') };
 expect(() => assertSyncEvidence({ signalNetwork: { syncProof: wrong } })).toThrow();
});
