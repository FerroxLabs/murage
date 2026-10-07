// Decision 8 (SEC-006 P23): an approval key counts only if the push relay saw
// it named in a genuine App Attest or Play Integrity attestation and signed a
// statement saying so (cloudflare/push-relay/src/approval-statement.ts).
// Checked offline, once, at pairing, against pinned keys.
import { createHash, createPublicKey, verify } from "node:crypto";

/** kid -> raw Ed25519 public key (base64url, 32 bytes). From muragecloud; never fetched.
 *  More than one kid can be pinned at once, so a relay key rotation is a
 *  re-pin here with no downtime. These are public keys. */
export const RELAY_STATEMENT_KEYS: Readonly<Record<string, string>> = {
  "2026-10a": "9oNjXeUldmtxe2Crt_3NlzPxJo73LzjkChPx6caJltM",
};
export const STATEMENT_TAG = "murage-approval-attestation/1";
export const STATEMENT_TTL_MS = 600_000;
export const STATEMENT_SKEW_MS = 300_000;
export interface ApprovalAttestation { kid: string; platform: "ios" | "android"; environment: "development" | "production"; issuedAt: number }

/** MURAGE_RELAY_STATEMENT_KEYS adds trust anchors, so it is honoured only in a test run
 *  (NODE_ENV=test) or with the explicit MURAGE_ALLOW_TEST_RELAY_KEYS=1 flag. In production the pins above are all there is. */
export function pinnedStatementKeys(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env.NODE_ENV !== "test" && env.MURAGE_ALLOW_TEST_RELAY_KEYS !== "1") return { ...RELAY_STATEMENT_KEYS };
  let extra: Record<string, string> = {};
  try {
    const parsed = env.MURAGE_RELAY_STATEMENT_KEYS ? JSON.parse(env.MURAGE_RELAY_STATEMENT_KEYS) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extra = Object.fromEntries(Object.entries(parsed).filter(([k, v]) => /^[A-Za-z0-9._-]{1,32}$/.test(k) && typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v))) as Record<string, string>;
  } catch { /* ignored: the pins alone */ }
  return { ...extra, ...RELAY_STATEMENT_KEYS }; // a pinned kid is never overridden
}

export function verifyApprovalStatement(statement: unknown, expect: { installId: string; point: string }, o: { keys: Record<string, string>; now: number }): ApprovalAttestation | null {
  try {
    if (typeof statement !== "string" || !/^[A-Za-z0-9_-]{40,1200}\.[A-Za-z0-9_-]{86}$/.test(statement)) return null;
    const [encoded, sig] = statement.split(".");
    const payload = Buffer.from(encoded, "base64url");
    if (payload.toString("base64url") !== encoded) return null; // canonical only
    const lines = payload.toString("utf8").split("\n");
    if (lines.length !== 8) return null;
    const [tag, kid, platform, environment, installId, keyHash, issuedText, expiresText] = lines;
    if (tag !== STATEMENT_TAG || !Object.hasOwn(o.keys, kid)) return null;
    if ((platform !== "ios" && platform !== "android") || (environment !== "development" && environment !== "production")) return null;
    if (installId !== expect.installId) return null;
    if (keyHash !== createHash("sha256").update(Buffer.from(expect.point, "base64url")).digest("hex")) return null;
    if (!/^\d{1,16}$/.test(issuedText) || !/^\d{1,16}$/.test(expiresText)) return null;
    const issuedAt = Number(issuedText), expiresAt = Number(expiresText);
    if (expiresAt - issuedAt !== STATEMENT_TTL_MS) return null;
    if (issuedAt - STATEMENT_SKEW_MS > o.now || expiresAt + STATEMENT_SKEW_MS <= o.now) return null;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: o.keys[kid] }, format: "jwk" });
    if (!verify(null, payload, key, Buffer.from(sig, "base64url"))) return null;
    return { kid, platform, environment, issuedAt };
  } catch {
    return null;
  }
}
