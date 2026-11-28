// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-only stand-in for ../bedrock-identity.ts as seen from ../bedrock-launch.ts in a spawned server child (bedrock-identity-offline-preload.mjs).
// Everything is the real module except the STS GetCallerIdentity call, which a --network none test cannot make: IDENTITY answers the fixture
// account. The launch gate, the cache, R2/R7, the fence, the turn and the limit path all stay real.
export * from "../bedrock-identity.ts";
export async function resolveBedrockAccount(): Promise<string> { return process.env.MURAGE_TEST_BEDROCK_ACCOUNT ?? "111111111111"; }
