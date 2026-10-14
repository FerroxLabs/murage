// SPDX-License-Identifier: AGPL-3.0-or-later
export const PROOF_CHALLENGE_HEADER: string;
export const CHALLENGE_PATTERN: RegExp;
export function newChallenge(): string;
export function proofKeyOf(nonce: string): string;
export function proofData(challenge: string, fields: { status: number; pid: number; launch: string; isStatic: boolean; upgrading: boolean }): string;
export function computeProof(key: string, challenge: string, fields: { status: number; pid: number; launch: string; isStatic: boolean; upgrading: boolean }): string;
export function proofHolds(nonce: string, challenge: string, body: unknown, status: number): boolean;
export const PROOF_DATA_SOURCE: string;
export function identityEnvelopeValid(body: unknown): boolean;
