// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How the shell knows an answer on the port came from the child it started. `launch` (the SHA-256 of the boot nonce) is public: it labels a server
// launch so screens can reset what they showed, and proves nothing, because anyone who has read one answer can copy it. The proof is an HMAC, keyed
// by a value derived from the nonce (which only the shell and its child hold), over a fresh random challenge the shell sends with each probe and over
// the status fields of the answer. A copied launch, a copied old answer, or the same fields under another challenge or status all fail.
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The header the shell sends the challenge in. */
export const PROOF_CHALLENGE_HEADER = "x-murage-challenge";
/** A challenge: 32 hex characters at least. */
export const CHALLENGE_PATTERN = /^[0-9a-f]{32,64}$/;
export const newChallenge = () => randomBytes(16).toString("hex");
/** The HMAC key: derived from the nonce, never the launch hash (which is public). */
export const proofKeyOf = (nonce) => createHash("sha256").update("murage-proof:" + String(nonce)).digest("hex");
/** The text the HMAC covers: the challenge and the answer's status fields, in a fixed order. Self-contained (its source is embedded in worker threads). */
export function proofData(challenge, fields) {
  return [challenge, fields.status, fields.pid, fields.launch, fields.isStatic ? 1 : 0, fields.upgrading ? 1 : 0].join("|");
}
export const computeProof = (key, challenge, fields) => createHmac("sha256", key).update(proofData(challenge, fields)).digest("hex");
/** The identity envelope the proof can speak for: our app, a hash label, an integer pid (or none), and exact booleans. Anything else is not an answer the proof may vouch for. */
export function identityEnvelopeValid(body) {
  if (body === null || typeof body !== "object") return false;
  if (body.app !== "murage") return false;
  if (typeof body.launch !== "string" || !/^[0-9a-f]{64}$/.test(body.launch)) return false;
  if (body.pid !== undefined && !Number.isSafeInteger(body.pid)) return false;
  if (typeof body.static !== "boolean") return false;
  if (body.upgrading !== undefined && typeof body.upgrading !== "boolean") return false;
  return true;
}
/** The shell's check of an answer. */
export function proofHolds(nonce, challenge, body, status) {
  if (!identityEnvelopeValid(body)) return false;
  if (typeof body.proof !== "string" || !/^[0-9a-f]{64}$/.test(body.proof)) return false;
  const want = Buffer.from(computeProof(proofKeyOf(nonce), challenge, { status, pid: body.pid, launch: body.launch, isStatic: body.static, upgrading: body.upgrading === true }), "hex");
  const got = Buffer.from(body.proof, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}
/** For worker threads made from source text: defines proofData; the worker adds its own createHmac call. */
export const PROOF_DATA_SOURCE = `const proofData = ${proofData.toString()};`;
