// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The launch nonce the desktop shell generated for this child (electron/main.mjs): a random value only the shell and this process know. The
// child never sends it anywhere: its health answers carry `launch`, the SHA-256 of the nonce, which the shell computes the same way and compares, and
// which the app can also read to know a new server launch began (so it resets what it showed). A process that does not know the nonce cannot make
// that value, and a process that merely knows the child's (public) pid cannot either. The nonce is taken from the environment once and removed
// from it, so no process this server starts inherits it. Without a shell (a dev server, a test) a random one is made. Never logged.
import { createHash, randomBytes } from "node:crypto";
import { CHALLENGE_PATTERN, computeProof, proofKeyOf } from "../../shared/boot-proof.mjs";
const nonce = process.env.MURAGE_BOOT_NONCE || randomBytes(24).toString("hex");
delete process.env.MURAGE_BOOT_NONCE;
const proofKey = proofKeyOf(nonce);
const launch = createHash("sha256").update(nonce).digest("hex");
/** The value health answers carry (a hash of the nonce, not the nonce). */
export function bootLaunchId(): string { return launch; }
/** The key the responder thread signs with (derived from the nonce; the nonce itself and `launch` are not it). Handed to the same process's worker only. */
export function bootProofKey(): string { return proofKey; }
/** The proof for one answer to a probe that sent `challenge`: undefined when the probe sent none (a browser, a tool), so only the shell's probe gets one. */
export function healthProof(challenge: unknown, fields: { status: number; pid: number; launch?: string; isStatic: boolean; upgrading: boolean }): string | undefined {
  return typeof challenge === "string" && CHALLENGE_PATTERN.test(challenge) ? computeProof(proofKey, challenge, { ...fields, launch: fields.launch ?? launch }) : undefined;
}
