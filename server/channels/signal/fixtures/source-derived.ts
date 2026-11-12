// SPDX-License-Identifier: AGPL-3.0-or-later
// Synthetic examples transcribed from 48a0a5e. These are NEVER G0 evidence.
export const sourceAci = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const sourceNow = 1_800_000_000_000;
export function sourceDerivedReceive() {
  return { subscription: 0, result: { account: "+15550001234", envelope: {
    source: "+15550001234", sourceNumber: "+15550001234", sourceUuid: sourceAci, sourceName: "Fixture",
    sourceDevice: 3, timestamp: sourceNow, serverReceivedTimestamp: sourceNow, serverDeliveredTimestamp: sourceNow,
    syncMessage: { sentMessage: { destination: "+15550001234", destinationNumber: "+15550001234",
      destinationUuid: sourceAci, timestamp: sourceNow, message: "source-derived note", expiresInSeconds: 0 } },
  } } };
}
