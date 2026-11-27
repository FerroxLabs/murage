// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a (designs/1021-m2-w0/DESIGN-r5.md F2 as moved by r5.1 G2): a hosted turn makes no
// attributed write through an internal call.
//
// Owners: both sides belong to the O1 m2 S1a builder lane (fix/1022-o1m2): the producer is the
// hosted forwarder (it adds a generation at sendTurn entry, before any frame for that handle,
// and removes it only after the generation's last token retired); the consumer is the claim
// capture in server/index.ts, which refuses on the same tick that the claim is resolved, before
// the binding lookup and before any await. The retire side is InternalCapabilities.revokeGeneration
// (every revoke path funnels through it) and revokeAll, only once no registry in the process still holds the generation. In a production boot the forwarder is never
// constructed, so the set stays empty and the check is one lookup.
import type { InternalCapability } from "../internal-capabilities.ts";

const hostedGenerations = new Set<string>();

/** Producer side: the forwarder only, at sendTurn entry. */
export function markHostedGeneration(generation: string): void {
  if (!generation) throw new Error("invalid hosted generation");
  hostedGenerations.add(generation);
}

/** Producer side: the capability retire path for that generation, after its last token retired. */
export function retireHostedGeneration(generation: string): void {
  hostedGenerations.delete(generation);
}

/** Consumer side: true when this live claim belongs to a hosted turn and must get the uniform consuming refusal. */
export function hostedClaimRefused(claim: Pick<InternalCapability, "generation"> | null): boolean {
  return claim !== null && hostedGenerations.has(claim.generation);
}

/** Retire side fast path: is this generation in the set (false for every generation in a production boot). */
export function isHostedGeneration(generation: string): boolean {
  return hostedGenerations.has(generation);
}

export function hostedGenerationCount(): number {
  return hostedGenerations.size;
}
