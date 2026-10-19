// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { HTTPError } from "./http";

const encoder = new TextEncoder();
export function encodePayload(value: unknown): string {
  return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(value))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_signature_encoding");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
}
export const recoveryProofSchema = z.object({
  type: z.literal("murage-recovery-v1"), homeId: z.string(), generation: z.number().int().positive(),
  holdId: z.string(), action: z.enum(["delete", "start_fresh", "restore", "cancel_renewal", "pair"]),
  holdStartedAt: z.number().int(), holdCompletedAt: z.number().int(),
  cancelState: z.literal("not_canceled"), issuedAt: z.number().int(), expiresAt: z.number().int(),
}).strict();
export type RecoveryProof = z.infer<typeof recoveryProofSchema>;
export const homeKeySchema = z.object({
  type: z.literal("murage-home-key-v1"), homeId: z.string(), generation: z.number().int().positive(),
  homeKey: z.string(), publicOrigin: z.string(), issuedAt: z.number().int(), expiresAt: z.number().int(),
}).strict();
export type SignedEnvelope = { payload: string; signature: string; algorithm: "ES256"; };

export async function signPayload(env: Env, payload: unknown): Promise<SignedEnvelope> {
  const jwk = JSON.parse(env.CLOUD_B3_SIGNING_JWK ?? "null") as JsonWebKey | null;
  if (!jwk?.d || jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error("b3_signer_unavailable");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const encoded = encodePayload(payload);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(encoded)));
  return { payload: encoded, signature: btoa(String.fromCharCode(...signature)).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/, ""), algorithm: "ES256" };
}
export async function verifyPayload(envelope: SignedEnvelope, publicJwk: JsonWebKey): Promise<unknown> {
  if (envelope.algorithm !== "ES256" || publicJwk.d || publicJwk.kty !== "EC" || publicJwk.crv !== "P-256") {
    throw new Error("invalid_signature");
  }
  const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(envelope.signature), encoder.encode(envelope.payload))) {
    throw new Error("invalid_signature");
  }
  return JSON.parse(new TextDecoder().decode(bytes(envelope.payload)));
}
export async function verifyRecoveryProof(envelope: SignedEnvelope, publicJwk: JsonWebKey,
  homeId: string, generation: number, now: number, expectedAction: RecoveryProof["action"] = "pair"): Promise<RecoveryProof> {
  const proof = recoveryProofSchema.parse(await verifyPayload(envelope, publicJwk));
  if (proof.homeId !== homeId || proof.generation !== generation || proof.action !== expectedAction || proof.expiresAt <= now
    || proof.issuedAt > now || proof.holdCompletedAt < proof.holdStartedAt + 72 * 3_600_000
    || proof.holdCompletedAt > proof.issuedAt || proof.expiresAt > proof.issuedAt + 300_000) throw new Error("invalid_recovery_proof");
  return proof;
}
export async function verifyHomeKey(envelope: SignedEnvelope, publicJwk: JsonWebKey,
  homeId: string, generation: number, publicOrigin: string, now: number) {
  const identity = homeKeySchema.parse(await verifyPayload(envelope, publicJwk));
  if (identity.homeId !== homeId || identity.generation !== generation || identity.publicOrigin !== publicOrigin
    || identity.issuedAt > now || identity.expiresAt <= now || identity.expiresAt > identity.issuedAt + 3_600_000) {
    throw new Error("invalid_home_identity");
  }
  return identity;
}

const devicePayload = z.object({
  type: z.literal("murage-device-stepup-v1"), deviceId: z.string(), homeId: z.string(),
  generation: z.number().int().positive(), action: z.string(), nonce: z.string().min(16).max(128),
  issuedAt: z.number().int(), expiresAt: z.number().int(),
}).strict();
export const envelopeSchema = z.object({ payload: z.string().max(4096), signature: z.string().max(128),
  algorithm: z.literal("ES256") }).strict();
export async function consumeDeviceProof(db: D1Database, envelope: SignedEnvelope,
  homeId: string, generation: number, action: string, now: number): Promise<string> {
  // Read only the untrusted selector, then verify all claims against the stored key.
  let selector: z.infer<typeof devicePayload>;
  try { selector = devicePayload.parse(JSON.parse(new TextDecoder().decode(bytes(envelope.payload)))); }
  catch { throw new HTTPError(403, "invalid_device_proof"); }
  const device = await db.prepare("SELECT public_jwk FROM cloud_devices WHERE id=? AND home_id=? AND revoked_at IS NULL")
    .bind(selector.deviceId, homeId).first<{ public_jwk: string }>();
  if (!device) throw new HTTPError(403, "invalid_device_proof");
  try {
    const proof = devicePayload.parse(await verifyPayload(envelope, JSON.parse(device.public_jwk) as JsonWebKey));
    if (proof.homeId !== homeId || proof.generation !== generation || proof.action !== action
      || proof.expiresAt <= now || proof.issuedAt > now || proof.issuedAt < now - 60_000
      || proof.expiresAt > proof.issuedAt + 60_000) throw new Error("stale_proof");
  } catch { throw new HTTPError(403, "invalid_device_proof"); }
  const result = await db.prepare("INSERT INTO cloud_device_proofs VALUES (?,?,?) ON CONFLICT DO NOTHING")
    .bind(selector.nonce, selector.deviceId, now).run();
  if (result.meta.changes !== 1) throw new HTTPError(409, "proof_replayed");
  return selector.deviceId;
}
