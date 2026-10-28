// The door's twin of the phone-jobs contract pieces it needs: the tag, the token
// pattern, the mint message builder and the key id. companion/src is its own build
// root and cannot import shared/ (TS6059 under build:companion; plan B8), so these
// are kept identical on purpose. companion/test/phone-jobs-shape.test.ts checks them
// byte for byte against apps/mobile/contract/phone-jobs.json and shared/phone-jobs-contract.ts.
import { createHash } from "node:crypto";

export const PHONE_JOBS_TAG = "murage-phone-jobs/1";
export const PHONE_TOKEN = /^murage_pj_[A-Za-z0-9_-]{43}$/;

const B64URL_POINT = /^[A-Za-z0-9_-]{87}$/;

/** keyId = base64url(SHA-256 of the 65 decoded point bytes), never of the string. Null for anything that is not an uncompressed P-256 point. */
export function approvalKeyId(point: string): string | null {
  if (typeof point !== "string" || !B64URL_POINT.test(point)) return null;
  const raw = Buffer.from(point, "base64url");
  if (raw.length !== 65 || raw[0] !== 4) return null;
  return createHash("sha256").update(raw).digest("base64url");
}

export interface PhoneJobsMessageFields {
  origin: string;
  keyId: string;
  nonce: string;
  expiresAt: number;
}

/** UTF-8 of tag, origin, keyId, nonce and decimal expiresAt joined by LF, no trailing newline. */
export function phoneJobsMessage(f: PhoneJobsMessageFields): string {
  return [PHONE_JOBS_TAG, f.origin, f.keyId, f.nonce, String(f.expiresAt)].join("\n");
}
