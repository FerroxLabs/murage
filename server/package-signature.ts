// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Official" packages. A team or bot from Ferrox Labs carries an Ed25519
// signature over a canonical digest of the whole package, made with a key
// that is kept offline. The app ships only the matching public key(s).
// The mark is earned by that signature alone: an unsigned package, a bad
// signature or an unknown key gets no mark, and every package, signed or
// not, still goes through the full import guard.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

export interface OfficialPackageKey {
  /** First 16 hex characters of the SHA-256 of the public key's DER bytes. */
  id: string;
  /** Ed25519 public key, SPKI DER, base64. */
  publicKey: string;
}

/** Keys the app trusts for the Official mark. Empty until Ferrox Labs
 * generates the real signing key (kept offline) and adds its public half
 * here. See docs/official-package-signing.md. Never put a private key here. */
export const OFFICIAL_PACKAGE_KEYS: readonly OfficialPackageKey[] = [];

export interface PackageSignature { alg: "ed25519"; keyId: string; value: string }
export interface OfficialStatus { official: boolean; keyId?: string; reason?: "unsigned" | "unknown-key" | "bad-signature" | "malformed" }

const DOMAIN = "murage.package.signature.v1";

/** Stable JSON: sorted keys, undefined dropped, nothing but plain JSON. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Not a JSON value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("Not a JSON value");
}

/** The message that is signed: a label plus the hash of the package without
 * its signature, so the signature covers every other byte of meaning. */
export function packageDigest(document: unknown): string {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("A package is a JSON object");
  const { signature: _signature, ...rest } = document as Record<string, unknown>;
  return `${DOMAIN}\n${createHash("sha256").update(canonicalJson(rest)).digest("hex")}`;
}

export function publicKeyId(publicKeyBase64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex").slice(0, 16);
}

/** The public half of a PEM private key, in the form OFFICIAL_PACKAGE_KEYS holds. */
export function publicKeyOf(privateKeyPem: string): OfficialPackageKey {
  const der = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "der" }).toString("base64");
  return { id: publicKeyId(der), publicKey: der };
}

/** Add a signature. The key comes in as PEM text read by the caller; it is
 * used and never kept or printed. */
export function signPackage<T extends object>(document: T, privateKeyPem: string): T & { signature: PackageSignature } {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("The signing key must be an Ed25519 key");
  const { signature: _old, ...rest } = document as T & { signature?: unknown };
  const value = edSign(null, Buffer.from(packageDigest(rest)), privateKey).toString("base64");
  return { ...(rest as T), signature: { alg: "ed25519", keyId: publicKeyOf(privateKeyPem).id, value } };
}

export function verifyOfficialPackage(document: unknown, keys: readonly OfficialPackageKey[] = OFFICIAL_PACKAGE_KEYS): OfficialStatus {
  if (!document || typeof document !== "object" || Array.isArray(document)) return { official: false, reason: "malformed" };
  const signature = (document as { signature?: unknown }).signature;
  if (signature === undefined) return { official: false, reason: "unsigned" };
  if (!signature || typeof signature !== "object") return { official: false, reason: "malformed" };
  const { alg, keyId, value } = signature as Partial<PackageSignature>;
  if (alg !== "ed25519" || typeof keyId !== "string" || typeof value !== "string" || value.length > 200) return { official: false, reason: "malformed" };
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) return { official: false, reason: "unknown-key" };
  try {
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 64) return { official: false, reason: "bad-signature" };
    const good = edVerify(null, Buffer.from(packageDigest(document)), publicKey, bytes);
    return good ? { official: true, keyId } : { official: false, reason: "bad-signature" };
  } catch { return { official: false, reason: "bad-signature" }; }
}
