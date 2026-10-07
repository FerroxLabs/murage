// Decision 8 (SEC-006 P23): the relay vouches that an approval key was named
// in a genuine App Attest or Play Integrity attestation. The desktop checks the
// statement offline against a pinned Ed25519 key. Nothing here is stored.
import { base64url } from "./http";

export const APPROVAL_STATEMENT_TTL_MS = 600_000;
export const STATEMENT_TAG = "murage-approval-attestation/1";
const BINDING_TAG = "murage-approval-key/1";
const enc = new TextEncoder();
const sha = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export const approvalKeyHash = async (point: Uint8Array) => hex(await sha(point));
export async function approvalBindingNonce(challenge: string, installId: string, keyHash: string): Promise<string> {
  return base64url(await sha(enc.encode([BINDING_TAG, challenge, installId, keyHash].join("\n"))));
}
export interface StatementKey { kid: string; key: CryptoKey }
export async function signStatement(k: StatementKey, s: { platform: string; environment: string; installId: string; keyHash: string; issuedAt: number }): Promise<string> {
  const payload = enc.encode([STATEMENT_TAG, k.kid, s.platform, s.environment, s.installId, s.keyHash, String(s.issuedAt), String(s.issuedAt + APPROVAL_STATEMENT_TTL_MS)].join("\n"));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k.key, payload));
  return `${base64url(payload)}.${base64url(sig)}`;
}
/** The APPROVAL_STATEMENT_KEY secret, or null if it is absent or malformed (never thrown, never logged). */
export async function loadStatementKey(raw: string | undefined): Promise<StatementKey | null> {
  try {
    const parsed = raw ? (JSON.parse(raw) as { kid?: unknown; pkcs8?: unknown }) : null;
    if (!parsed || typeof parsed.kid !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(parsed.kid) || typeof parsed.pkcs8 !== "string") return null;
    const der = Uint8Array.from(atob(parsed.pkcs8), (c) => c.charCodeAt(0));
    return { kid: parsed.kid, key: await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]) };
  } catch {
    return null;
  }
}
